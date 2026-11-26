import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { fixtureKeyOf } from "../modules/ai/embedding/fixture.provider.js";

/**
 * Fixture mode is the $0 demo, and it answers only text that has a recorded
 * vector. `docs/deployment.md` promises six demo questions work, so a recorded
 * corpus edit that forgets one would make the promise false while every other
 * check still passes. This test reads the shipped file, not a copy of it.
 */

const FIXTURE_PATH = new URL("../evaluation/embeddingFixtures.json", import.meta.url);
const RECORDER_PATH = new URL("./recordDemoFixtures.ts", import.meta.url);

/**
 * Deliberately duplicated from the recorder: the recorder's list is not
 * exported, and this copy is the promise being checked. The drift check below
 * keeps the two in step.
 */
const DEMO_QUESTIONS = [
  "How do we recover from PostgreSQL connection pool exhaustion?",
  "Why are large uploads failing with 413?",
  "What is the rollback procedure for a failed deployment?",
  "Why did checkout start failing after release 1.42.0?",
  "How do I restore the production database from a backup?",
  "What causes Redis key evictions?",
];

type Fixture = {
  model: string;
  dimensions: number;
  vectors: Record<string, number[]>;
};

test("the fixture holds a vector for every demo question", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

  const missing = DEMO_QUESTIONS.filter(
    (question) => fixture.vectors[fixtureKeyOf(question)] === undefined
  );

  assert.deepEqual(
    missing,
    [],
    "These questions are offered by the demo but have no recorded vector; " +
      "re-run `npm run embed:demo-fixtures` against the seeded demo organization."
  );

  for (const question of DEMO_QUESTIONS) {
    const vector = fixture.vectors[fixtureKeyOf(question)]!;

    assert.equal(
      vector.length,
      fixture.dimensions,
      `The vector recorded for "${question}" is not ${fixture.dimensions}d`
    );
    assert.ok(
      vector.every((value) => Number.isFinite(value)),
      `The vector recorded for "${question}" contains a non-finite value`
    );
  }
});

test("the recorder still asks for exactly these questions", () => {
  const recorder = fs.readFileSync(RECORDER_PATH, "utf8");

  const unrecorded = DEMO_QUESTIONS.filter(
    (question) => !recorder.includes(question)
  );

  assert.deepEqual(
    unrecorded,
    [],
    "The recorder no longer includes these questions, so this test would keep " +
      "passing for a demo list that has moved on."
  );
});
