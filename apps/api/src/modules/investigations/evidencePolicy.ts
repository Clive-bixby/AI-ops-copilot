import {
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "./errors.js";
import type { InvestigationSourceType } from "./policy.js";
import type { EvidenceMatchType, EvidenceRelevance } from "./types.js";

/**
 * Evidence rules that do not touch the database.
 *
 * Everything here is deterministic so an investigation's evidence set can be
 * explained (and tested) without a model in the loop: which queries to run, how
 * a source is graded, which duplicate wins, and how many items fit the budget.
 */

export const EVIDENCE_LIMITS = {
  /** At or above this cosine similarity a chunk is graded direct evidence. */
  directSimilarity: 0.8,
  /** At or above this, but below direct, a chunk is related context. */
  relatedSimilarity: 0.7,
  maxItems: 12,
  maxPerSourceType: 4,
  excerptChars: 1200,
  maxQueries: 3,
  minQueryChars: 3,
  maxQueryChars: 500,
  minSignatureTokenChars: 4,
  maxSignatureTokens: 12,
  manualReasonMax: 300,
} as const;

export type EvidenceQueryLabel = "description" | "error_signature" | "service";

export type EvidenceQueryPlan = {
  query: string;
  label: EvidenceQueryLabel;
};

/**
 * Derive the searches for an investigation without asking a model.
 *
 * The description is always the primary query. A user-supplied error signature
 * is the highest-precision signal available, so it becomes its own query. The
 * service query exists because embeddings for "checkout" alone rarely match a
 * runbook; adding failure vocabulary gives the keyword arm something concrete.
 */
export function buildEvidenceQueries(input: {
  description: string;
  errorSignature: string | null;
  service: string | null;
}): EvidenceQueryPlan[] {
  const plans: EvidenceQueryPlan[] = [];

  const push = (raw: string, label: EvidenceQueryLabel): void => {
    const query = raw
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, EVIDENCE_LIMITS.maxQueryChars);

    if (query.length < EVIDENCE_LIMITS.minQueryChars) {
      return;
    }

    const key = query.toLowerCase();
    if (plans.some((plan) => plan.query.toLowerCase() === key)) {
      return;
    }

    if (plans.length >= EVIDENCE_LIMITS.maxQueries) {
      return;
    }

    plans.push({ query, label });
  };

  push(input.description, "description");

  if (input.errorSignature !== null && input.errorSignature.trim() !== "") {
    push(input.errorSignature, "error_signature");
  }

  if (input.service !== null && input.service.trim() !== "") {
    push(`${input.service.trim()} error failure timeout`, "service");
  }

  return plans;
}

export type EvidenceSearchOutcome<TChunk> = {
  plan: EvidenceQueryPlan;
  chunks: TChunk[];
};

export type EvidenceSearchFailure = {
  plan: EvidenceQueryPlan;
  error: unknown;
};

/**
 * Run the derived searches together and split the successes from the failures.
 *
 * The searches are independent, so they are started together rather than one
 * after another; `allSettled` (not `all`) means one failed query never discards
 * the evidence the other queries found. Outcomes are reported in plan order so
 * the candidate set and the warnings stay deterministic.
 *
 * When every search fails, retrieval itself is unavailable: the first failure
 * is thrown so the caller cannot report "no evidence" for an outage.
 */
export async function settleEvidenceSearches<TChunk>(
  plans: EvidenceQueryPlan[],
  search: (plan: EvidenceQueryPlan) => Promise<TChunk[]>
): Promise<{
  results: EvidenceSearchOutcome<TChunk>[];
  failures: EvidenceSearchFailure[];
}> {
  const settled = await Promise.allSettled(plans.map((plan) => search(plan)));

  const results: EvidenceSearchOutcome<TChunk>[] = [];
  const failures: EvidenceSearchFailure[] = [];

  settled.forEach((outcome, index) => {
    const plan = plans[index];
    if (!plan) {
      return;
    }

    if (outcome.status === "fulfilled") {
      results.push({ plan, chunks: outcome.value });
      return;
    }

    failures.push({ plan, error: outcome.reason });
  });

  if (plans.length > 0 && failures.length === plans.length) {
    throw failures[0]!.error;
  }

  return { results, failures };
}

export function normalizeSignatureText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function signatureTokens(signature: string): string[] {
  return normalizeSignatureText(signature)
    .split(" ")
    .filter((token) => token.length >= EVIDENCE_LIMITS.minSignatureTokenChars)
    .slice(0, EVIDENCE_LIMITS.maxSignatureTokens);
}

/**
 * Does this text carry the investigation's error signature?
 *
 * Two deterministic paths: either every meaningful token of the signature appears
 * (tolerating the ids and timestamps that vary between occurrences), or the whole
 * normalized signature appears verbatim. An empty or very short signature never
 * matches, so a two-letter "db" does not make every log line direct evidence.
 */
export function textMatchesSignature(
  text: string,
  signature: string | null
): boolean {
  if (signature === null) {
    return false;
  }

  const haystack = normalizeSignatureText(text);
  if (haystack.length === 0) {
    return false;
  }

  const tokens = signatureTokens(signature);
  if (tokens.length > 0 && tokens.every((token) => haystack.includes(token))) {
    return true;
  }

  const normalized = normalizeSignatureText(signature);
  return normalized.length >= 3 && haystack.includes(normalized);
}

export type RetrievalEvidenceCandidate = {
  sourceType: InvestigationSourceType;
  sourceId: string;
  chunkIndex: number;
  content: string;
  sourceCreatedAt: string | null;
  matchType: EvidenceMatchType;
  score: number;
  similarity: number | null;
  /** The query that surfaced this source. */
  retrievalQuery: string;
};

export type ResolvedEvidenceSource = {
  sourceType: InvestigationSourceType;
  sourceId: string;
  sourceTitle: string;
  /** Rendered source content, used for manual links and empty chunks. */
  excerpt: string;
  sourceCreatedAt: string | null;
  service: string | null;
  /** Ticket status; null for documents and log groups. */
  status: string | null;
  metadata: Record<string, unknown> | null;
};

export function sourceKey(
  sourceType: InvestigationSourceType,
  sourceId: string
): string {
  return `${sourceType}:${sourceId}`;
}

function isBetterCandidate(
  candidate: RetrievalEvidenceCandidate,
  existing: RetrievalEvidenceCandidate
): boolean {
  if (candidate.score !== existing.score) {
    return candidate.score > existing.score;
  }

  return (candidate.similarity ?? -1) > (existing.similarity ?? -1);
}

/**
 * One candidate per source. An investigation lists sources, not chunk spam, and
 * the strongest chunk stands in for that source.
 */
export function dedupeCandidates(
  candidates: RetrievalEvidenceCandidate[]
): RetrievalEvidenceCandidate[] {
  const byKey = new Map<string, RetrievalEvidenceCandidate>();

  for (const candidate of candidates) {
    const key = sourceKey(candidate.sourceType, candidate.sourceId);
    const existing = byKey.get(key);

    if (!existing || isBetterCandidate(candidate, existing)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

export type EvidenceGrading = {
  relevance: EvidenceRelevance;
  inclusionReason: string;
};

/**
 * A ticket that is already resolved or closed is a record of what happened
 * before, so it can only be graded historical when something connects it to the
 * investigation being worked on: the text carries the error signature, or the
 * retrieval produced a similarity score at least as strong as related context.
 *
 * Resolution status on its own is not a relevance signal. A closed ticket about
 * invoices says nothing about a checkout outage, so it must fall through to the
 * ordinary rules and be graded related (same service, no textual link) or weak.
 */
function gradeResolvedTicket(input: {
  candidate: { matchType: EvidenceMatchType; similarity: number | null };
  source: { status: string | null };
  signatureMatch: boolean;
}): EvidenceGrading | null {
  const { candidate, source, signatureMatch } = input;
  const status = source.status ?? "resolved";

  if (signatureMatch) {
    return {
      relevance: "historical",
      inclusionReason: `Ticket is already '${status}', and its text matches the investigation's error signature, so it is a historical record of this failure.`,
    };
  }

  if (
    candidate.similarity !== null &&
    candidate.similarity >= EVIDENCE_LIMITS.relatedSimilarity
  ) {
    return {
      relevance: "historical",
      inclusionReason: `Ticket is already '${status}', and it was retrieved with cosine similarity ${candidate.similarity.toFixed(
        2
      )}, close enough to be a historical record of this failure.`,
    };
  }

  return null;
}

/**
 * Grade from an actual link to the investigation: signature match, similarity,
 * service membership, then the retrieval arm as a last resort.
 */
function gradeSignals(input: {
  candidate: {
    matchType: EvidenceMatchType;
    similarity: number | null;
  };
  source: { service: string | null };
  signatureMatch: boolean;
  investigation: { service: string | null };
}): EvidenceGrading {
  const { candidate, source, signatureMatch, investigation } = input;

  if (signatureMatch) {
    return {
      relevance: "direct",
      inclusionReason: "Excerpt matches the investigation's error signature.",
    };
  }

  if (
    candidate.similarity !== null &&
    candidate.similarity >= EVIDENCE_LIMITS.directSimilarity
  ) {
    return {
      relevance: "direct",
      inclusionReason: `Retrieved with cosine similarity ${candidate.similarity.toFixed(
        2
      )}, at or above the direct-evidence threshold (${EVIDENCE_LIMITS.directSimilarity.toFixed(
        2
      )}).`,
    };
  }

  if (
    candidate.similarity !== null &&
    candidate.similarity >= EVIDENCE_LIMITS.relatedSimilarity
  ) {
    return {
      relevance: "related",
      inclusionReason: `Retrieved with cosine similarity ${candidate.similarity.toFixed(
        2
      )}, above the related-context threshold (${EVIDENCE_LIMITS.relatedSimilarity.toFixed(
        2
      )}) but below direct evidence.`,
    };
  }

  if (
    investigation.service !== null &&
    source.service !== null &&
    investigation.service.trim() !== "" &&
    source.service.trim().toLowerCase() ===
      investigation.service.trim().toLowerCase()
  ) {
    return {
      relevance: "related",
      inclusionReason: `Belongs to service '${source.service}', the component under investigation.`,
    };
  }

  if (candidate.matchType === "keyword") {
    return {
      relevance: "weak",
      inclusionReason:
        "Matched on keywords only; there is no similarity score, so it is weak evidence.",
    };
  }

  if (candidate.matchType === "manual") {
    return {
      relevance: "weak",
      inclusionReason:
        "Linked manually without a retrieval signal; treated as weak context.",
    };
  }

  return {
    relevance: "weak",
    inclusionReason:
      "Retrieved below the direct and related thresholds; kept as weak context only.",
  };
}

export function gradeEvidence(input: {
  candidate: {
    content: string;
    matchType: EvidenceMatchType;
    similarity: number | null;
  };
  source: {
    sourceType: InvestigationSourceType;
    sourceTitle: string;
    status: string | null;
    service: string | null;
  };
  investigation: {
    service: string | null;
    errorSignature: string | null;
  };
}): EvidenceGrading {
  const { candidate, source, investigation } = input;

  const haystack = `${source.sourceTitle}\n${candidate.content}`;
  const signatureMatch = textMatchesSignature(
    haystack,
    investigation.errorSignature
  );

  const isHistoricalTicket =
    source.sourceType === "ticket" &&
    (source.status === "resolved" || source.status === "closed");

  if (isHistoricalTicket) {
    const historical = gradeResolvedTicket({
      candidate,
      source,
      signatureMatch,
    });

    if (historical) {
      return historical;
    }
  }

  const grading = gradeSignals({
    candidate,
    source,
    signatureMatch,
    investigation,
  });

  if (!isHistoricalTicket) {
    return grading;
  }

  // Say explicitly why an already-resolved ticket was not treated as history, so
  // a reader does not assume the status alone was ignored by mistake.
  return {
    relevance: grading.relevance,
    inclusionReason: `${grading.inclusionReason} The ticket is already '${source.status}', but resolution status alone does not make it historical.`,
  };
}

export type SelectedEvidence = {
  candidate: RetrievalEvidenceCandidate;
  source: ResolvedEvidenceSource;
  relevance: EvidenceRelevance;
  inclusionReason: string;
};

const RELEVANCE_RANK: Record<EvidenceRelevance, number> = {
  direct: 0,
  historical: 1,
  related: 2,
  weak: 3,
};

/**
 * Grade, order and cap the evidence set.
 *
 * Ordering is relevance class first, then retrieval score. The per-source-type
 * cap keeps one noisy source type (usually logs) from filling the whole budget,
 * while still letting other types use the slots it does not claim.
 */
export function selectEvidence(input: {
  candidates: RetrievalEvidenceCandidate[];
  sources: Map<string, ResolvedEvidenceSource>;
  investigation: {
    service: string | null;
    errorSignature: string | null;
  };
  maxItems?: number;
  maxPerSourceType?: number;
  /**
   * Automatic collection sets this to false: evidence with no signal beyond a
   * keyword hit is withheld rather than presented as findings. Manual links do
   * not go through this function, so an engineer can still cite weak context
   * deliberately.
   */
  includeWeak?: boolean;
}): { selected: SelectedEvidence[]; unresolved: number; withheld: number } {
  const maxItems = input.maxItems ?? EVIDENCE_LIMITS.maxItems;
  const maxPerSourceType =
    input.maxPerSourceType ?? EVIDENCE_LIMITS.maxPerSourceType;
  const includeWeak = input.includeWeak ?? true;

  const graded: SelectedEvidence[] = [];
  let unresolved = 0;
  let withheld = 0;

  for (const candidate of dedupeCandidates(input.candidates)) {
    const source = input.sources.get(
      sourceKey(candidate.sourceType, candidate.sourceId)
    );

    if (!source) {
      unresolved += 1;
      continue;
    }

    const grading = gradeEvidence({
      candidate,
      source,
      investigation: input.investigation,
    });

    if (!includeWeak && grading.relevance === "weak") {
      withheld += 1;
      continue;
    }

    graded.push({ candidate, source, ...grading });
  }

  graded.sort((a, b) => {
    const rank = RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance];
    if (rank !== 0) {
      return rank;
    }

    if (b.candidate.score !== a.candidate.score) {
      return b.candidate.score - a.candidate.score;
    }

    const similarity =
      (b.candidate.similarity ?? -1) - (a.candidate.similarity ?? -1);
    if (similarity !== 0) {
      return similarity;
    }

    return sourceKey(a.candidate.sourceType, a.candidate.sourceId).localeCompare(
      sourceKey(b.candidate.sourceType, b.candidate.sourceId)
    );
  });

  const perType = new Map<InvestigationSourceType, number>();
  const selected: SelectedEvidence[] = [];

  for (const item of graded) {
    if (selected.length >= maxItems) {
      break;
    }

    const used = perType.get(item.candidate.sourceType) ?? 0;
    if (used >= maxPerSourceType) {
      continue;
    }

    perType.set(item.candidate.sourceType, used + 1);
    selected.push(item);
  }

  return { selected, unresolved, withheld };
}

/**
 * The excerpt stored with the evidence. Line breaks are kept (log templates and
 * ticket bodies are easier to read), whitespace inside a line is tidied, and the
 * result is capped so a long runbook cannot dominate the prompt budget.
 */
export function buildExcerpt(content: string): string {
  const cleaned = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  if (cleaned.length === 0) {
    return "(no content)";
  }

  if (cleaned.length <= EVIDENCE_LIMITS.excerptChars) {
    return cleaned;
  }

  return `${cleaned.slice(0, EVIDENCE_LIMITS.excerptChars - 1).trimEnd()}…`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ManualEvidenceInput = {
  sourceType: InvestigationSourceType;
  sourceId: string;
  reason: string | null;
};

export function validateManualEvidenceInput(
  payload: unknown
): ManualEvidenceInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InvestigationValidationError("Request body must be an object");
  }

  const record = payload as Record<string, unknown>;

  if (
    record.sourceType !== "document" &&
    record.sourceType !== "log" &&
    record.sourceType !== "ticket"
  ) {
    throw new InvestigationValidationError(
      "sourceType must be one of: document, log, ticket"
    );
  }

  if (typeof record.sourceId !== "string" || !UUID_PATTERN.test(record.sourceId.trim())) {
    throw new InvestigationValidationError("sourceId must be a UUID");
  }

  let reason: string | null = null;
  if (record.reason !== undefined && record.reason !== null) {
    if (typeof record.reason !== "string") {
      throw new InvestigationValidationError("reason must be a string");
    }

    const trimmed = record.reason.trim();
    if (trimmed.length > EVIDENCE_LIMITS.manualReasonMax) {
      throw new InvestigationValidationError(
        `reason must be no more than ${EVIDENCE_LIMITS.manualReasonMax} characters`
      );
    }

    reason = trimmed === "" ? null : trimmed;
  }

  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId.trim(),
    reason,
  };
}

export function normalizeEvidenceId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new InvestigationNotFoundError("Evidence not found");
  }

  return value.trim();
}
