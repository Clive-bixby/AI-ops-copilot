import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NO_CONTEXT_ANSWER,
  aggregateScores,
  extractCitationLabels,
  numbersInText,
  scoreCase,
  type CaseDefinition,
} from "./llmScoring.js";

/**
 * The scorer is the measuring instrument, so these tests check the instrument
 * rather than a model: the same input must score the same way every time, and
 * each hallucination signal must fire on its own evidence.
 */

function baseCase(overrides: Partial<CaseDefinition> = {}): CaseDefinition {
  return {
    id: "case",
    scenario: "test",
    kind: "analysis",
    expectedFacts: [],
    forbiddenEntities: [],
    allowedNumbers: [],
    mustBeInsufficient: false,
    ...overrides,
  };
}

function analysis(payload: Record<string, unknown>): string {
  return JSON.stringify({ summary: "The connection pool was exhausted.", ...payload });
}

/** The parser reads citations from `supports` and `contradicts`, not `citations`. */
function hypothesis(statement: string, supports: string[] = []): Record<string, unknown> {
  return { statement, rationale: "Because the evidence says so.", supports };
}

describe("llmScoring", () => {
  it("scores a grounded answer without firing a hallucination signal", () => {
    const score = scoreCase({
      testCase: baseCase({
        expectedFacts: [
          { label: "pool", anyOf: ["connection pool", "pool exhausted"] },
          { label: "mitigation", anyOf: ["terminate idle sessions"] },
        ],
        forbiddenEntities: ["Kafka"],
        allowedNumbers: ["20"],
      }),
      raw: analysis({
        key_observations: ["20 connections, all idle in transaction"],
        hypotheses: [hypothesis("The pool is exhausted", ["E1"])],
      }),
      evidenceIds: ["E1"],
    });

    assert.equal(score.parsed, true);
    assert.equal(score.factsFound, 1);
    assert.deepEqual(score.forbiddenHits, []);
    assert.deepEqual(score.inventedNumbers, []);
    assert.equal(score.droppedCitations, 0);
    assert.equal(score.hallucinated, false);
  });

  it("counts a number the evidence never contained", () => {
    const score = scoreCase({
      testCase: baseCase({ allowedNumbers: ["20"] }),
      raw: analysis({ key_observations: ["latency reached 500ms with 20 connections"] }),
      evidenceIds: ["E1"],
    });

    assert.deepEqual(score.inventedNumbers, ["500"]);
    assert.equal(score.hallucinated, true);
  });

  it("names a forbidden entity as invented evidence", () => {
    const score = scoreCase({
      testCase: baseCase({ forbiddenEntities: ["Kafka", "Redis"] }),
      raw: analysis({ summary: "Kafka consumer lag caused the outage." }),
      evidenceIds: ["E1"],
    });

    assert.deepEqual(score.forbiddenHits, ["Kafka"]);
    assert.equal(score.hallucinated, true);
  });

  it("counts a citation the parser had to drop", () => {
    const score = scoreCase({
      testCase: baseCase(),
      raw: analysis({ hypotheses: [hypothesis("The pool is exhausted", ["E9"])] }),
      evidenceIds: ["E1", "E2"],
    });

    assert.equal(score.droppedCitations, 1);
    assert.equal(score.hallucinated, true);
  });

  it("measures citation precision against the labels the case requires", () => {
    const complete = scoreCase({
      testCase: baseCase({ requiredCitations: ["E1", "E2"] }),
      raw: analysis({ hypotheses: [hypothesis("Both sources agree", ["E1", "E2"])] }),
      evidenceIds: ["E1", "E2"],
    });
    const partial = scoreCase({
      testCase: baseCase({ requiredCitations: ["E1", "E2"] }),
      raw: analysis({ hypotheses: [hypothesis("One source", ["E1"])] }),
      evidenceIds: ["E1", "E2"],
    });

    assert.equal(complete.citationPrecision, 1);
    assert.equal(partial.citationPrecision, 0.5);
  });

  it("accepts a refusal as correct only when the case has no evidence", () => {
    const refusal = scoreCase({
      testCase: baseCase({ mustBeInsufficient: true }),
      raw: analysis({ summary: "The evidence does not cover this.", insufficient_evidence: true }),
      evidenceIds: ["E1"],
    });
    const confident = scoreCase({
      testCase: baseCase({ mustBeInsufficient: true }),
      raw: analysis({ hypotheses: [hypothesis("The pool is exhausted", ["E1"])] }),
      evidenceIds: ["E1"],
    });

    assert.equal(refusal.refusalCorrect, true);
    assert.equal(refusal.hallucinated, false);
    assert.equal(confident.refusalCorrect, false);
    assert.equal(confident.hallucinated, true);
  });

  it("treats a refusal on a case with evidence as wrong", () => {
    const score = scoreCase({
      testCase: baseCase(),
      raw: analysis({ insufficient_evidence: true }),
      evidenceIds: ["E1"],
    });

    assert.equal(score.refusalCorrect, false);
    assert.equal(score.hallucinated, true);
  });

  it("recognises the exact no-context answer", () => {
    const refusal = scoreCase({
      testCase: baseCase({ kind: "grounded_answer", mustBeInsufficient: true }),
      raw: NO_CONTEXT_ANSWER,
      evidenceIds: [],
    });
    const answer = scoreCase({
      testCase: baseCase({ kind: "grounded_answer", mustBeInsufficient: true }),
      raw: "The runbook says to terminate idle sessions.",
      evidenceIds: [],
    });

    assert.equal(refusal.refusalCorrect, true);
    assert.equal(answer.refusalCorrect, false);
  });

  it("flags more hypotheses than the API will store", () => {
    const score = scoreCase({
      testCase: baseCase(),
      raw: analysis({
        hypotheses: [
          hypothesis("one", ["E1"]),
          hypothesis("two", ["E1"]),
          hypothesis("three", ["E1"]),
          hypothesis("four", ["E1"]),
          hypothesis("five", ["E1"]),
        ],
      }),
      evidenceIds: ["E1"],
    });

    assert.equal(score.hallucinated, false);
    assert.ok(
      score.constraintViolations.some((violation) => violation.includes("hypotheses")),
      `expected a hypothesis limit violation, got ${JSON.stringify(score.constraintViolations)}`
    );
  });

  it("flags a code fence and a broken instruction", () => {
    const score = scoreCase({
      testCase: baseCase({ forbiddenPhrases: ["restart the api"] }),
      raw: `\`\`\`json\n${analysis({ next_steps: ["Restart the API"] })}\n\`\`\``,
      evidenceIds: ["E1"],
    });

    assert.ok(score.parsed, "the parser strips the fence, so the response is usable");
    assert.ok(score.constraintViolations.some((violation) => violation.includes("code fence")));
    assert.ok(score.constraintViolations.some((violation) => violation.includes("instruction")));
  });

  it("records an unparseable response instead of throwing", () => {
    const score = scoreCase({
      testCase: baseCase(),
      raw: "I think the pool is exhausted.",
      evidenceIds: ["E1"],
    });

    assert.equal(score.parsed, false);
    assert.equal(score.schemaValid, false);
    assert.equal(score.hallucinated, true);
  });

  it("is deterministic", () => {
    const input = {
      testCase: baseCase({ requiredCitations: ["E1"], expectedFacts: [{ label: "x", anyOf: ["pool"] }] }),
      raw: analysis({ hypotheses: [hypothesis("The pool is exhausted", ["E1"])] }),
      evidenceIds: ["E1"],
    };

    assert.deepEqual(scoreCase(input), scoreCase(input));
  });

  it("aggregates each rate separately", () => {
    const clean = scoreCase({
      testCase: baseCase(),
      raw: analysis({ hypotheses: [hypothesis("The pool is exhausted", ["E1"])] }),
      evidenceIds: ["E1"],
    });
    const dirty = scoreCase({
      testCase: baseCase({ forbiddenEntities: ["Kafka"], mustBeInsufficient: true }),
      raw: analysis({ summary: "Kafka is down." }),
      evidenceIds: ["E1"],
    });

    const aggregate = aggregateScores([clean, dirty]);

    assert.equal(aggregate.cases, 2);
    assert.equal(aggregate.parsedRate, 1);
    assert.equal(aggregate.hallucinationRate, 0.5);
    assert.equal(aggregate.refusalAccuracy, 0);
    assert.equal(aggregate.totalForbiddenHits, 1);
  });

  it("does not read a citation label as a number", () => {
    const score = scoreCase({
      testCase: baseCase({ kind: "grounded_answer", requiredCitations: ["Source 1"] }),
      raw: "Terminate idle in transaction sessions (Source 1).",
      evidenceIds: [],
    });

    assert.deepEqual(score.inventedNumbers, []);
    assert.equal(score.citationPrecision, 1);
    assert.equal(score.hallucinated, false);
  });

  it("extracts source numbers and evidence labels from prose", () => {
    assert.deepEqual(extractCitationLabels("See Source 1 and E2, again Source 1."), [
      "Source 1",
      "E2",
    ]);
    // A unit suffix must not hide a number, and an identifier must not invent one.
    assert.deepEqual(numbersInText("20 connections, p95 500ms, v2.1"), ["20", "500"]);
  });
});
