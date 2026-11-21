import { createHash } from "node:crypto";

import type { InvestigationSourceType } from "./policy.js";

/**
 * Analysis rules that do not touch the database or the model client.
 *
 * The model is asked for strict JSON and is never trusted: every field is type
 * checked, every list is capped, and every citation must be an evidence id this
 * investigation actually supplied. A hallucinated id is dropped, not stored.
 */

export const ANALYSIS_VERSION = 1;

export const ANALYSIS_LIMITS = {
  /** Evidence rows sent to the model; the rest stay stored but unread. */
  maxEvidence: 12,
  summaryMax: 1500,
  observations: 6,
  observationMax: 400,
  nextSteps: 6,
  stepMax: 400,
  hypotheses: 4,
  statementMax: 300,
  rationaleMax: 800,
  missingInformation: 5,
  missingInformationMax: 300,
  verificationSteps: 5,
  verificationStepMax: 300,
  /** Citations kept per hypothesis, per relation. */
  citations: 6,
  /** A runaway response is rejected rather than parsed. */
  responseChars: 20_000,
  excerptChars: 1200,
} as const;

export class AnalysisFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisFormatError";
  }
}

export type AnalysisEvidence = {
  id: string;
  sourceType: InvestigationSourceType;
  sourceTitle: string;
  excerpt: string;
  relevance: string;
  sourceCreatedAt: string | null;
};

export type AnalysisInvestigation = {
  id: string;
  title: string;
  description: string;
  severity: string;
  service: string | null;
  errorSignature: string | null;
  windowStart: string | null;
  windowEnd: string | null;
};

export type ParsedHypothesis = {
  statement: string;
  rationale: string;
  supports: string[];
  contradicts: string[];
  missingInformation: string[];
  verificationSteps: string[];
};

export type ParsedAnalysis = {
  summary: string;
  keyObservations: string[];
  nextSteps: string[];
  insufficientEvidence: boolean;
  missingInformation: string[];
  hypotheses: ParsedHypothesis[];
};

export type ParsedAnalysisResult = {
  analysis: ParsedAnalysis;
  /** Citations the model invented and that were therefore dropped. */
  droppedCitations: number;
};

function clampText(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function readStringList(
  value: unknown,
  maxItems: number,
  maxChars: number
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const text = clampText(entry, maxChars);
    if (text.length > 0) {
      items.push(text);
    }

    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

/**
 * Prompt assembly. Evidence is numbered so the model can cite `E1`, `E2`, … and
 * the parser can map those labels back to real evidence ids; the prompt never
 * asks for ids the model cannot see.
 */
export function buildAnalysisPrompt(input: {
  investigation: AnalysisInvestigation;
  evidence: AnalysisEvidence[];
}): { prompt: string; evidenceIds: string[] } {
  const evidence = input.evidence.slice(0, ANALYSIS_LIMITS.maxEvidence);
  const evidenceIds = evidence.map((item) => item.id);

  const evidenceBlock = evidence
    .map((item, index) => {
      const label = `E${index + 1}`;
      const created = item.sourceCreatedAt ?? "unknown";
      return [
        `[${label}] type=${item.sourceType} relevance=${item.relevance} time=${created}`,
        `title: ${clampText(item.sourceTitle, 300)}`,
        `excerpt: ${clampText(item.excerpt, ANALYSIS_LIMITS.excerptChars)}`,
      ].join("\n");
    })
    .join("\n\n");

  const window =
    input.investigation.windowStart === null &&
    input.investigation.windowEnd === null
      ? "not specified"
      : `${input.investigation.windowStart ?? "open"} to ${
          input.investigation.windowEnd ?? "open"
        }`;

  const prompt = [
    "You are the incident analysis step of an operations copilot.",
    "Explain the most likely cause of the described problem using only the evidence provided.",
    "Never invent facts, sources, metrics or timestamps. If the evidence cannot support a cause,",
    "say so plainly and set insufficient_evidence to true.",
    "",
    "Investigation",
    `title: ${input.investigation.title}`,
    `description: ${input.investigation.description}`,
    `severity: ${input.investigation.severity}`,
    `service: ${input.investigation.service ?? "not specified"}`,
    `error signature: ${input.investigation.errorSignature ?? "not specified"}`,
    `window: ${window}`,
    "",
    "Evidence",
    evidenceBlock.length > 0 ? evidenceBlock : "(no evidence was collected)",
    "",
    "Rules",
    `- Cite evidence only by the bracket labels above (${evidence
      .map((_, index) => `E${index + 1}`)
      .join(", ") || "none available"}).`,
    "- Put the same label in supports only if the evidence supports the hypothesis,",
    "  and in contradicts only if it argues against it.",
    "- A hypothesis without supporting evidence is allowed; leave supports empty.",
    `- At most ${ANALYSIS_LIMITS.hypotheses} hypotheses, ${ANALYSIS_LIMITS.observations} observations and ${ANALYSIS_LIMITS.nextSteps} next steps.`,
    "- Reply with JSON only, no prose and no markdown fences.",
    "",
    "JSON schema",
    JSON.stringify(
      {
        summary: "string",
        key_observations: ["string"],
        next_steps: ["string"],
        insufficient_evidence: false,
        missing_information: ["string"],
        hypotheses: [
          {
            statement: "string",
            rationale: "string",
            supports: ["E1"],
            contradicts: [],
            missing_information: ["string"],
            verification_steps: ["string"],
          },
        ],
      },
      null,
      2
    ),
  ].join("\n");

  return { prompt, evidenceIds };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** Map `E1`-style labels back to evidence ids, dropping anything invented. */
function resolveCitations(
  value: unknown,
  evidenceIds: string[]
): { ids: string[]; dropped: number } {
  if (!Array.isArray(value)) {
    return { ids: [], dropped: 0 };
  }

  const ids: string[] = [];
  let dropped = 0;

  for (const entry of value) {
    if (typeof entry !== "string") {
      dropped += 1;
      continue;
    }

    const match = /^E(\d+)$/i.exec(entry.trim());
    const index = match?.[1] === undefined ? Number.NaN : Number(match[1]) - 1;
    const resolved = Number.isInteger(index) ? evidenceIds[index] : undefined;

    if (resolved === undefined || ids.includes(resolved)) {
      dropped += 1;
      continue;
    }

    ids.push(resolved);
    if (ids.length >= ANALYSIS_LIMITS.citations) {
      break;
    }
  }

  return { ids, dropped };
}

/**
 * Validate one model response. Anything malformed lowers the result to something
 * safe to store; only a missing summary is a hard failure, because an analysis
 * with no summary is not an analysis.
 */
export function parseAnalysisResponse(
  raw: string,
  evidenceIds: string[]
): ParsedAnalysisResult {
  if (raw.length > ANALYSIS_LIMITS.responseChars) {
    throw new AnalysisFormatError("The analysis response was too long to accept");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new AnalysisFormatError("The analysis response was not valid JSON");
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AnalysisFormatError("The analysis response was not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    throw new AnalysisFormatError("The analysis response did not include a summary");
  }

  let droppedCitations = 0;
  const seenStatements = new Set<string>();
  const hypotheses: ParsedHypothesis[] = [];

  const rawHypotheses = Array.isArray(record.hypotheses)
    ? record.hypotheses
    : [];

  for (const entry of rawHypotheses) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const hypothesis = entry as Record<string, unknown>;
    if (
      typeof hypothesis.statement !== "string" ||
      typeof hypothesis.rationale !== "string"
    ) {
      continue;
    }

    const statement = clampText(
      hypothesis.statement,
      ANALYSIS_LIMITS.statementMax
    );
    const rationale = clampText(
      hypothesis.rationale,
      ANALYSIS_LIMITS.rationaleMax
    );

    if (statement.length === 0 || rationale.length === 0) {
      continue;
    }

    const hash = statementHash(statement);
    if (seenStatements.has(hash)) {
      continue;
    }
    seenStatements.add(hash);

    const supports = resolveCitations(hypothesis.supports, evidenceIds);
    const contradicts = resolveCitations(hypothesis.contradicts, evidenceIds);
    droppedCitations += supports.dropped + contradicts.dropped;

    hypotheses.push({
      statement,
      rationale,
      supports: supports.ids,
      contradicts: contradicts.ids.filter((id) => !supports.ids.includes(id)),
      missingInformation: readStringList(
        hypothesis.missing_information,
        ANALYSIS_LIMITS.missingInformation,
        ANALYSIS_LIMITS.missingInformationMax
      ),
      verificationSteps: readStringList(
        hypothesis.verification_steps,
        ANALYSIS_LIMITS.verificationSteps,
        ANALYSIS_LIMITS.verificationStepMax
      ),
    });

    if (hypotheses.length >= ANALYSIS_LIMITS.hypotheses) {
      break;
    }
  }

  return {
    droppedCitations,
    analysis: {
      summary: clampText(record.summary, ANALYSIS_LIMITS.summaryMax),
      keyObservations: readStringList(
        record.key_observations,
        ANALYSIS_LIMITS.observations,
        ANALYSIS_LIMITS.observationMax
      ),
      nextSteps: readStringList(
        record.next_steps,
        ANALYSIS_LIMITS.nextSteps,
        ANALYSIS_LIMITS.stepMax
      ),
      insufficientEvidence: record.insufficient_evidence === true,
      missingInformation: readStringList(
        record.missing_information,
        ANALYSIS_LIMITS.missingInformation,
        ANALYSIS_LIMITS.missingInformationMax
      ),
      hypotheses,
    },
  };
}

/**
 * Stable identity for a hypothesis across repeated analyses: casing, punctuation
 * and spacing must not create a duplicate row for the same statement.
 */
export function statementHash(statement: string): string {
  const normalized = statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return createHash("sha256").update(normalized).digest("hex");
}

export const HYPOTHESIS_STATUSES = [
  "unverified",
  "supported",
  "rejected",
] as const;

export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export function validateHypothesisUpdate(
  payload: unknown
): { status: HypothesisStatus } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AnalysisFormatError("Request body must be an object");
  }

  const record = payload as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    !(HYPOTHESIS_STATUSES as readonly string[]).includes(record.status)
  ) {
    throw new AnalysisFormatError(
      `status must be one of: ${HYPOTHESIS_STATUSES.join(", ")}`
    );
  }

  return { status: record.status as HypothesisStatus };
}
