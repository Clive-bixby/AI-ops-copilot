import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyStaleJob } from "./jobRecovery.js";
import type { RecoverableJob } from "./jobRecovery.js";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const STALE_AFTER_MS = 10 * 60_000;

function job(overrides: Partial<RecoverableJob> = {}): RecoverableJob {
  return {
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    updatedAt: new Date(NOW - STALE_AFTER_MS - 1_000),
    ...overrides,
  };
}

describe("classifyStaleJob", () => {
  it("requeues a job that died mid-run while attempts remain", () => {
    assert.equal(
      classifyStaleJob(job({ attempts: 1, maxAttempts: 3 }), NOW, STALE_AFTER_MS),
      "requeue"
    );
  });

  it("fails a job that died on its last allowed attempt", () => {
    assert.equal(
      classifyStaleJob(job({ attempts: 3, maxAttempts: 3 }), NOW, STALE_AFTER_MS),
      "fail"
    );
  });

  it("fails a job whose attempts are past the budget", () => {
    // The CHECK constraint stops this from being written today; a ledger from an
    // older version may still contain it, and resurrecting it is wrong.
    assert.equal(
      classifyStaleJob(job({ attempts: 5, maxAttempts: 3 }), NOW, STALE_AFTER_MS),
      "fail"
    );
  });

  it("leaves a job that is still running inside the window alone", () => {
    assert.equal(
      classifyStaleJob(
        job({ updatedAt: new Date(NOW - 60_000) }),
        NOW,
        STALE_AFTER_MS
      ),
      "ignore"
    );
  });

  it("treats the threshold itself as stale", () => {
    assert.equal(
      classifyStaleJob(
        job({ updatedAt: new Date(NOW - STALE_AFTER_MS) }),
        NOW,
        STALE_AFTER_MS
      ),
      "requeue"
    );
  });

  it("requeues a queued job that no worker ever picked up", () => {
    // The API records the intent before handing it to BullMQ; a crash in
    // between leaves a row nothing will ever run.
    assert.equal(
      classifyStaleJob(job({ status: "queued", attempts: 0 }), NOW, STALE_AFTER_MS),
      "requeue"
    );
  });

  it("never resurrects a failed job", () => {
    // A failed job is retried by reprocessing the source, which starts a new row
    // with its own attempt budget. Requeueing it in place would spend embedding
    // budget on every sweep.
    assert.equal(
      classifyStaleJob(job({ status: "failed", attempts: 3 }), NOW, STALE_AFTER_MS),
      "ignore"
    );
  });

  it("ignores finished jobs regardless of age", () => {
    for (const status of ["succeeded", "skipped"]) {
      assert.equal(
        classifyStaleJob(job({ status }), NOW, STALE_AFTER_MS),
        "ignore"
      );
    }
  });

  it("ignores a row with an unparseable timestamp", () => {
    assert.equal(
      classifyStaleJob(job({ updatedAt: new Date("not a date") }), NOW, STALE_AFTER_MS),
      "ignore"
    );
  });
});
