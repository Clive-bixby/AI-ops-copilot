import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FOLLOW_UP_LIMITS,
  FollowUpFormatError,
  buildFollowUpPrompt,
  parseFollowUpResponse,
  validateFollowUpQuestion,
} from "./followUpPolicy.js";
import type { AnalysisEvidence } from "./analysisPolicy.js";

const INVESTIGATION = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "API intermittently returns HTTP 500",
  description: "Checkout requests return 500 when the connection pool is exhausted.",
  severity: "high",
  service: "api",
  errorSignature: "connection pool exhausted",
  windowStart: null,
  windowEnd: null,
};

function evidenceItem(index: number): AnalysisEvidence {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sourceType: "log",
    sourceTitle: `log-group-${index}`,
    excerpt: `excerpt ${index}`,
    relevance: "direct",
    sourceCreatedAt: "2026-11-21T09:15:00.000Z",
  };
}

const ANALYSIS = {
  summary: "The pool is exhausted by long-lived transactions.",
  keyObservations: ["Pool wait time rose before the 500s."],
  nextSteps: ["Terminate idle in transaction sessions."],
  hypotheses: [
    {
      statement: "Idle transactions hold connections.",
      rationale: "The log template repeats until saturation.",
      status: "unverified",
    },
  ],
};

describe("validateFollowUpQuestion", () => {
  it("trims and collapses whitespace", () => {
    assert.equal(
      validateFollowUpQuestion({ question: "  Why   did the pool  saturate? " }),
      "Why did the pool saturate?"
    );
  });

  it("rejects short, long and non-string questions", () => {
    assert.throws(
      () => validateFollowUpQuestion({ question: "why" }),
      FollowUpFormatError
    );
    assert.throws(
      () =>
        validateFollowUpQuestion({
          question: "x".repeat(FOLLOW_UP_LIMITS.questionMax + 1),
        }),
      FollowUpFormatError
    );
    assert.throws(() => validateFollowUpQuestion({ question: 42 }), FollowUpFormatError);
    assert.throws(() => validateFollowUpQuestion(null), FollowUpFormatError);
  });
});

describe("buildFollowUpPrompt", () => {
  it("carries the question, numbered evidence and the analysis", () => {
    const { prompt, evidenceIds } = buildFollowUpPrompt({
      investigation: INVESTIGATION,
      question: "Which transaction held the connection?",
      evidence: [evidenceItem(1), evidenceItem(2)],
      analysis: ANALYSIS,
    });

    assert.deepEqual(evidenceIds, [evidenceItem(1).id, evidenceItem(2).id]);
    assert.match(prompt, /Which transaction held the connection\?/);
    assert.match(prompt, /\[E1\]/);
    assert.match(prompt, /The pool is exhausted by long-lived transactions\./);
    assert.match(prompt, /Idle transactions hold connections\./);
    assert.match(prompt, /"confidence": "high \| medium \| low"/);
  });

  it("caps the evidence and says when no analysis exists", () => {
    const many = Array.from(
      { length: FOLLOW_UP_LIMITS.evidence + 2 },
      (_, index) => evidenceItem(index + 1)
    );

    const { prompt, evidenceIds } = buildFollowUpPrompt({
      investigation: INVESTIGATION,
      question: "What should we check first?",
      evidence: many,
      analysis: null,
    });

    assert.equal(evidenceIds.length, FOLLOW_UP_LIMITS.evidence);
    assert.doesNotMatch(prompt, /\[E13\]/);
    assert.match(prompt, /no analysis has been run/);
  });
});

describe("parseFollowUpResponse", () => {
  const ids = [evidenceItem(1).id, evidenceItem(2).id];

  it("accepts a fenced answer and maps citations to evidence ids", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        answer: "Idle transactions held the connections.",
        confidence: "high",
        insufficient_context: false,
        citations: ["E2"],
      }) +
      "\n```";

    const parsed = parseFollowUpResponse(raw, ids);

    assert.equal(parsed.answer, "Idle transactions held the connections.");
    assert.equal(parsed.confidence, "high");
    assert.equal(parsed.insufficientContext, false);
    assert.deepEqual(parsed.citations, [ids[1]]);
    assert.equal(parsed.droppedCitations, 0);
  });

  it("defaults an unknown confidence to low and drops invented citations", () => {
    const parsed = parseFollowUpResponse(
      JSON.stringify({
        answer: "No evidence covers that.",
        confidence: "certain",
        insufficient_context: true,
        citations: ["E1", "E9", "E1", "not-a-label"],
      }),
      ids
    );

    assert.equal(parsed.confidence, "low");
    assert.equal(parsed.insufficientContext, true);
    assert.deepEqual(parsed.citations, [ids[0]]);
    assert.equal(parsed.droppedCitations, 3);
  });

  it("rejects a response without an answer, non-JSON and an oversized payload", () => {
    assert.throws(
      () => parseFollowUpResponse(JSON.stringify({ answer: "   " }), ids),
      FollowUpFormatError
    );
    assert.throws(() => parseFollowUpResponse("not json", ids), FollowUpFormatError);
    assert.throws(
      () =>
        parseFollowUpResponse(
          "x".repeat(FOLLOW_UP_LIMITS.responseChars + 1),
          ids
        ),
      FollowUpFormatError
    );
  });
});
