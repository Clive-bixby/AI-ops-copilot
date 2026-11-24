import {
  ANALYSIS_LIMITS,
  parseAnalysisResponse,
} from "../modules/investigations/analysisPolicy.js";
import {
  FOLLOW_UP_CONFIDENCE,
  FOLLOW_UP_LIMITS,
  parseFollowUpResponse,
} from "../modules/investigations/followUpPolicy.js";

/**
 * Deterministic scoring for generation quality.
 *
 * Nothing here calls a model or a database, and nothing here asks another model
 * for an opinion. The production parsers are reused so the measurement is of the
 * code that actually runs: a response the API would reject or clamp scores the
 * same way here.
 *
 * The point is to catch the failures a parser cannot: a perfectly valid JSON
 * object that names a service which was never in the evidence, cites a source it
 * invented, or produces a number nobody supplied.
 */

export type LlmCaseKind = "grounded_answer" | "analysis" | "follow_up";

export type ExpectedFact = {
  label: string;
  /** Accepted phrasings; matching any one counts the fact as present. */
  anyOf: string[];
};

export type ScoredCase = {
  id: string;
  scenario: string;
  kind: LlmCaseKind;
  /** The production parser accepted the response. */
  parsed: boolean;
  /** Shape is usable for its kind (required fields present). */
  schemaValid: boolean;
  /** Citations the parser threw away because they pointed at nothing. */
  droppedCitations: number;
  /** Share of cited labels that the case expected; 1 when nothing was required. */
  citationPrecision: number;
  factsFound: number;
  factsTotal: number;
  forbiddenHits: string[];
  inventedNumbers: string[];
  /** null when the case does not test refusing. */
  refusalCorrect: boolean | null;
  constraintViolations: string[];
  /** Any deterministic hallucination signal fired. */
  hallucinated: boolean;
};

export type CaseDefinition = {
  id: string;
  scenario: string;
  kind: LlmCaseKind;
  expectedFacts: ExpectedFact[];
  /** Absent from this case's evidence; naming one is invented evidence. */
  forbiddenEntities: string[];
  /** Numbers the evidence actually contains. */
  allowedNumbers: string[];
  /** Labels the answer must cite, e.g. "E1" or "Source 1". */
  requiredCitations?: string[];
  /** The only correct answer is a refusal. */
  mustBeInsufficient: boolean;
  /** Instructions the answer must not break, as literal phrases. */
  forbiddenPhrases?: string[];
};

export const NO_CONTEXT_ANSWER = "No reliable operational context found.";

/** Uppercase identifiers ("PGPOOL_MAX") plus capitalised names are the usual hallucinations. */
// A number may be followed by a unit ("500ms") but must not be part of an
// identifier ("p95", "v2.1"), where the digits are a name rather than a claim.
const NUMBER_PATTERN = /(?<![\w.])\d+(?:[.:]\d+)?/g;

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

// `E1` for investigations, `Source 1` for RAG answers.
const CITATION_LABEL_PATTERN = /\bE\d+\b|\bSource \d+\b/gi;

/** Labels the prompt asked for. */
export function extractCitationLabels(text: string): string[] {
  const matches = text.match(CITATION_LABEL_PATTERN) ?? [];

  return [...new Set(matches.map((label) => label.trim().replace(/\s+/g, " ")))];
}

function normaliseLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "");
}

function factPresent(text: string, fact: ExpectedFact): boolean {
  const haystack = normalise(text);

  return fact.anyOf.some((phrase) => haystack.includes(normalise(phrase)));
}

export function numbersInText(text: string): string[] {
  return [...new Set(text.match(NUMBER_PATTERN) ?? [])];
}

/**
 * Shape checks per kind. These deliberately mirror what the API stores, so a
 * response that would be silently clamped here is clamped the same way.
 */
function checkConstraints(
  testCase: CaseDefinition,
  raw: string,
  text: string
): string[] {
  const violations: string[] = [];
  const trimmed = raw.trim();

  if (trimmed.startsWith("```")) {
    violations.push("response was wrapped in a markdown code fence");
  }

  if (testCase.kind !== "grounded_answer") {
    if (!trimmed.startsWith("{")) {
      violations.push("structured response did not start with JSON");
    }

    const payload = safeParse(trimmed);

    if (testCase.kind === "analysis" && payload !== null) {
      const record = payload as Record<string, unknown>;
      const hypotheses = Array.isArray(record.hypotheses) ? record.hypotheses : [];

      if (hypotheses.length > ANALYSIS_LIMITS.hypotheses) {
        violations.push(
          `returned ${hypotheses.length} hypotheses, limit is ${ANALYSIS_LIMITS.hypotheses}`
        );
      }

      const observations = Array.isArray(record.key_observations)
        ? record.key_observations
        : [];
      if (observations.length > ANALYSIS_LIMITS.observations) {
        violations.push(
          `returned ${observations.length} observations, limit is ${ANALYSIS_LIMITS.observations}`
        );
      }
    }

    if (testCase.kind === "follow_up" && payload !== null) {
      const record = payload as Record<string, unknown>;
      const answer = typeof record.answer === "string" ? record.answer : "";

      if (answer.length > FOLLOW_UP_LIMITS.answerMax) {
        violations.push(`answer exceeded ${FOLLOW_UP_LIMITS.answerMax} characters`);
      }

      if (
        typeof record.confidence === "string" &&
        !(FOLLOW_UP_CONFIDENCE as readonly string[]).includes(record.confidence)
      ) {
        violations.push(`confidence "${record.confidence}" is not one of the allowed values`);
      }
    }
  }

  for (const phrase of testCase.forbiddenPhrases ?? []) {
    if (normalise(text).includes(normalise(phrase))) {
      violations.push(`ignored an instruction: contains "${phrase}"`);
    }
  }

  return violations;
}

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Score one response.
 *
 * `evidenceIds` are the ids the prompt supplied, in label order, so the
 * production parser resolves `E1` to `E1` and a dropped citation means exactly
 * "the model cited a label that was never offered".
 */
export function scoreCase(input: {
  testCase: CaseDefinition;
  raw: string;
  evidenceIds: string[];
}): ScoredCase {
  const { testCase, raw, evidenceIds } = input;
  const text = raw.trim();
  const violations = checkConstraints(testCase, raw, text);

  let parsed = false;
  let schemaValid = false;
  let droppedCitations = 0;
  let refused = false;

  if (testCase.kind === "analysis") {
    try {
      const result = parseAnalysisResponse(raw, evidenceIds);
      parsed = true;
      schemaValid = result.analysis.summary.length > 0;
      droppedCitations = result.droppedCitations;
      refused = result.analysis.insufficientEvidence;
    } catch {
      parsed = false;
    }
  } else if (testCase.kind === "follow_up") {
    try {
      const result = parseFollowUpResponse(raw, evidenceIds);
      parsed = true;
      schemaValid = result.answer.length > 0;
      droppedCitations = result.droppedCitations;
      refused = result.insufficientContext;
    } catch {
      parsed = false;
    }
  } else {
    // A grounded answer is prose; the only structural failure is an empty one.
    parsed = text.length > 0;
    schemaValid = parsed;
    refused = text.includes(NO_CONTEXT_ANSWER);
  }

  const expectedLabels = (testCase.requiredCitations ?? []).map(normaliseLabel);
  const cited = extractCitationLabels(text);
  const citedExpected = cited.filter((label) =>
    expectedLabels.includes(normaliseLabel(label))
  );
  const citationPrecision =
    expectedLabels.length === 0
      ? 1
      : Math.min(1, citedExpected.length / expectedLabels.length);

  const forbiddenHits = testCase.forbiddenEntities.filter((entity) =>
    normalise(text).includes(normalise(entity))
  );

  const allowed = new Set(testCase.allowedNumbers);
  // A citation label is a pointer, not a claim: `Source 1` must not read as the
  // number one, or every correctly cited answer would look like it invented data.
  const prose = text.replace(CITATION_LABEL_PATTERN, " ");
  const inventedNumbers = numbersInText(prose).filter((value) => !allowed.has(value));

  const factsFound = testCase.expectedFacts.filter((fact) =>
    factPresent(text, fact)
  ).length;

  const refusalCorrect = testCase.mustBeInsufficient
    ? parsed && refused
    : // A case with evidence must not claim there is none.
      refused
      ? false
      : null;

  const hallucinated =
    !parsed ||
    forbiddenHits.length > 0 ||
    inventedNumbers.length > 0 ||
    droppedCitations > 0 ||
    refusalCorrect === false;

  return {
    id: testCase.id,
    scenario: testCase.scenario,
    kind: testCase.kind,
    parsed,
    schemaValid,
    droppedCitations,
    citationPrecision,
    factsFound,
    factsTotal: testCase.expectedFacts.length,
    forbiddenHits,
    inventedNumbers,
    refusalCorrect,
    constraintViolations: violations,
    hallucinated,
  };
}

export type AggregateScore = {
  cases: number;
  parsedRate: number;
  schemaRate: number;
  factCoverage: number;
  citationPrecision: number;
  hallucinationRate: number;
  refusalAccuracy: number | null;
  constraintRate: number;
  totalDroppedCitations: number;
  totalForbiddenHits: number;
  totalInventedNumbers: number;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Aggregate across cases. Every rate is reported separately, never blended. */
export function aggregateScores(scores: ScoredCase[]): AggregateScore {
  const refusalCases = scores.filter((score) => score.refusalCorrect !== null);

  return {
    cases: scores.length,
    parsedRate: mean(scores.map((score) => (score.parsed ? 1 : 0))),
    schemaRate: mean(scores.map((score) => (score.schemaValid ? 1 : 0))),
    factCoverage: mean(
      scores.map((score) =>
        score.factsTotal === 0 ? 1 : score.factsFound / score.factsTotal
      )
    ),
    citationPrecision: mean(scores.map((score) => score.citationPrecision)),
    hallucinationRate: mean(scores.map((score) => (score.hallucinated ? 1 : 0))),
    refusalAccuracy:
      refusalCases.length === 0
        ? null
        : mean(refusalCases.map((score) => (score.refusalCorrect ? 1 : 0))),
    constraintRate: mean(
      scores.map((score) => (score.constraintViolations.length === 0 ? 1 : 0))
    ),
    totalDroppedCitations: scores.reduce(
      (sum, score) => sum + score.droppedCitations,
      0
    ),
    totalForbiddenHits: scores.reduce(
      (sum, score) => sum + score.forbiddenHits.length,
      0
    ),
    totalInventedNumbers: scores.reduce(
      (sum, score) => sum + score.inventedNumbers.length,
      0
    ),
  };
}
