import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANALYSIS_LIMITS,
  AnalysisFormatError,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  statementHash,
  validateHypothesisUpdate,
} from "./analysisPolicy.js";
import type { AnalysisEvidence } from "./analysisPolicy.js";

const INVESTIGATION = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "API intermittently returns HTTP 500",
  description: "Checkout requests return 500 when the connection pool is exhausted.",
  severity: "high",
  service: "api",
  errorSignature: "connection pool exhausted",
  windowStart: "2026-11-21T09:00:00.000Z",
  windowEnd: "2026-11-21T10:00:00.000Z",
};

function evidenceItem(index: number): AnalysisEvidence {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sourceType: "document",
    sourceTitle: `runbook-${index}.md`,
    excerpt: `excerpt ${index}`,
    relevance: "related",
    sourceCreatedAt: "2026-11-21T09:15:00.000Z",
  };
}

function response(hypotheses: unknown[] = []): string {
  return JSON.stringify({
    summary: "The pool is exhausted by long-lived transactions.",
    key_observations: ["Pool wait time rose before the 500s."],
    next_steps: ["Terminate idle in transaction sessions."],
    insufficient_evidence: false,
    missing_information: ["Connection count at failure time."],
    hypotheses,
  });
}

function hypothesis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    statement: "A long-running transaction is holding connections.",
    rationale: "The log template repeats until the pool is saturated.",
    supports: ["E1"],
    contradicts: [],
    missing_information: [],
    verification_steps: ["Check pg_stat_activity for idle in transaction sessions."],
    ...overrides,
  };
}

describe("buildAnalysisPrompt", () => {
  it("numbers the evidence it sends and returns exactly those ids", () => {
    const { prompt, evidenceIds } = buildAnalysisPrompt({
      investigation: INVESTIGATION,
      evidence: [evidenceItem(1), evidenceItem(2)],
    });

    assert.deepEqual(evidenceIds, [evidenceItem(1).id, evidenceItem(2).id]);
    assert.match(prompt, /\[E1\]/);
    assert.match(prompt, /\[E2\]/);
    assert.match(prompt, /runbook-1\.md/);
    assert.match(prompt, /window: 2026-11-21T09:00:00\.000Z to 2026-11-21T10:00:00\.000Z/);
    assert.match(prompt, /"responseMimeType"|JSON schema/);
  });

  it("caps the evidence and says so when there is none", () => {
    const many = Array.from({ length: ANALYSIS_LIMITS.maxEvidence + 3 }, (_, index) =>
      evidenceItem(index + 1)
    );

    const { prompt, evidenceIds } = buildAnalysisPrompt({
      investigation: INVESTIGATION,
      evidence: many,
    });

    assert.equal(evidenceIds.length, ANALYSIS_LIMITS.maxEvidence);
    assert.doesNotMatch(prompt, /\[E13\]/);

    const empty = buildAnalysisPrompt({
      investigation: INVESTIGATION,
      evidence: [],
    });
    assert.deepEqual(empty.evidenceIds, []);
    assert.match(empty.prompt, /no evidence was collected/);
  });
});

describe("parseAnalysisResponse", () => {
  const ids = [evidenceItem(1).id, evidenceItem(2).id];

  it("accepts a fenced response and maps labels to evidence ids", () => {
    const raw = "```json\n" + response([hypothesis()]) + "\n```";
    const parsed = parseAnalysisResponse(raw, ids);

    assert.equal(parsed.analysis.summary, "The pool is exhausted by long-lived transactions.");
    assert.deepEqual(parsed.analysis.keyObservations, [
      "Pool wait time rose before the 500s.",
    ]);
    assert.equal(parsed.analysis.hypotheses.length, 1);
    assert.deepEqual(parsed.analysis.hypotheses[0]?.supports, [ids[0]]);
    assert.equal(parsed.droppedCitations, 0);
  });

  it("drops invented citations and counts them", () => {
    const parsed = parseAnalysisResponse(
      response([hypothesis({ supports: ["E1", "E99", "E1"], contradicts: ["nope"] })]),
      ids
    );

    assert.deepEqual(parsed.analysis.hypotheses[0]?.supports, [ids[0]]);
    assert.deepEqual(parsed.analysis.hypotheses[0]?.contradicts, []);
    assert.equal(parsed.droppedCitations, 3);
  });

  it("keeps a citation out of contradicts when it also supports", () => {
    const parsed = parseAnalysisResponse(
      response([hypothesis({ supports: ["E1"], contradicts: ["E1", "E2"] })]),
      ids
    );

    assert.deepEqual(parsed.analysis.hypotheses[0]?.supports, [ids[0]]);
    assert.deepEqual(parsed.analysis.hypotheses[0]?.contradicts, [ids[1]]);
  });

  it("rejects a non-JSON response, a missing summary and an oversized response", () => {
    assert.throws(() => parseAnalysisResponse("not json", ids), AnalysisFormatError);
    assert.throws(
      () => parseAnalysisResponse(JSON.stringify({ summary: "  " }), ids),
      AnalysisFormatError
    );
    assert.throws(
      () => parseAnalysisResponse("x".repeat(ANALYSIS_LIMITS.responseChars + 1), ids),
      AnalysisFormatError
    );
    assert.throws(() => parseAnalysisResponse("[]", ids), AnalysisFormatError);
  });

  it("drops duplicate hypotheses and caps how many are kept", () => {
    const duplicates = [
      hypothesis({ statement: "Pool exhausted." }),
      hypothesis({ statement: "pool exhausted" }),
      hypothesis({ statement: "Another cause." }),
      hypothesis({ statement: "Third cause." }),
      hypothesis({ statement: "Fourth cause." }),
      hypothesis({ statement: "Fifth cause." }),
    ];

    const parsed = parseAnalysisResponse(response(duplicates), ids);

    assert.equal(parsed.analysis.hypotheses.length, ANALYSIS_LIMITS.hypotheses);
    const statements = parsed.analysis.hypotheses.map((item) => item.statement);
    assert.equal(new Set(statements).size, statements.length);
    assert.equal(statements[0], "Pool exhausted.");
  });

  it("clamps long text and ignores non-array lists", () => {
    const parsed = parseAnalysisResponse(
      JSON.stringify({
        summary: "s".repeat(ANALYSIS_LIMITS.summaryMax + 50),
        key_observations: "not an array",
        next_steps: [42, "  "],
        insufficient_evidence: "yes",
        missing_information: null,
        hypotheses: [],
      }),
      ids
    );

    assert.ok((parsed.analysis.summary?.length ?? 0) <= ANALYSIS_LIMITS.summaryMax);
    assert.deepEqual(parsed.analysis.keyObservations, []);
    assert.deepEqual(parsed.analysis.nextSteps, []);
    assert.equal(parsed.analysis.insufficientEvidence, false);
  });
});

describe("statementHash", () => {
  it("ignores case, punctuation and spacing", () => {
    assert.equal(
      statementHash("Pool exhausted: too many clients!"),
      statementHash("  pool   exhausted too many clients ")
    );
    assert.notEqual(statementHash("Pool exhausted"), statementHash("Pool saturated"));
  });
});

describe("validateHypothesisUpdate", () => {
  it("accepts the three statuses and rejects anything else", () => {
    assert.deepEqual(validateHypothesisUpdate({ status: "supported" }), {
      status: "supported",
    });
    assert.deepEqual(validateHypothesisUpdate({ status: "unverified" }), {
      status: "unverified",
    });

    assert.throws(() => validateHypothesisUpdate({ status: "maybe" }), AnalysisFormatError);
    assert.throws(() => validateHypothesisUpdate({}), AnalysisFormatError);
    assert.throws(() => validateHypothesisUpdate(null), AnalysisFormatError);
  });
});
