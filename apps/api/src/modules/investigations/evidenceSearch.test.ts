import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { settleEvidenceSearches } from "./evidencePolicy.js";
import type { EvidenceQueryPlan } from "./evidencePolicy.js";

/**
 * The derived searches of a collection run concurrently. These tests pin the two
 * rules that make that safe: one failed search must not cost the evidence the
 * other searches found, and a total retrieval failure must surface the error
 * instead of looking like an empty evidence set.
 */

const PLANS: EvidenceQueryPlan[] = [
  { query: "checkout requests return HTTP 500", label: "description" },
  { query: "connection pool exhausted: too many clients already", label: "error_signature" },
  { query: "api error failure timeout", label: "service" },
];

type FakeChunk = { sourceId: string; content: string };

function chunk(sourceId: string): FakeChunk {
  return { sourceId, content: `content for ${sourceId}` };
}

describe("settleEvidenceSearches", () => {
  it("keeps the evidence from the searches that succeeded when one fails", async () => {
    const failure = new Error("embedding service unavailable");

    const { results, failures } = await settleEvidenceSearches(
      PLANS,
      async (plan) => {
        if (plan.label === "error_signature") {
          throw failure;
        }

        return [chunk(plan.label)];
      }
    );

    assert.deepEqual(
      results.map((result) => result.plan.label),
      ["description", "service"],
      "fulfilled searches are reported in plan order"
    );
    assert.deepEqual(
      results.flatMap((result) => result.chunks.map((item) => item.sourceId)),
      ["description", "service"],
      "every chunk from the surviving searches is kept"
    );

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.plan.label, "error_signature");
    assert.equal(failures[0]?.error, failure, "the rejection reason is preserved");
  });

  it("surfaces the retrieval error when every search fails", async () => {
    const firstFailure = new Error("description search failed");
    const failureByLabel = new Map<string, Error>([
      ["description", firstFailure],
      ["error_signature", new Error("signature search failed")],
      ["service", new Error("service search failed")],
    ]);

    await assert.rejects(
      () =>
        settleEvidenceSearches(PLANS, async (plan) => {
          throw failureByLabel.get(plan.label);
        }),
      (error: unknown) => error === firstFailure
    );
  });

  it("starts every derived search before awaiting any of them", async () => {
    const events: string[] = [];

    const { results } = await settleEvidenceSearches(PLANS, async (plan) => {
      events.push(`start:${plan.label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${plan.label}`);
      return [chunk(plan.label)];
    });

    assert.deepEqual(
      events.slice(0, PLANS.length),
      PLANS.map((plan) => `start:${plan.label}`),
      "all searches are in flight before the first one finishes"
    );
    assert.equal(results.length, PLANS.length);
  });

  it("does nothing when there are no queries to run", async () => {
    const { results, failures } = await settleEvidenceSearches<string>(
      [],
      async () => {
        throw new Error("should not be called");
      }
    );

    assert.deepEqual(results, []);
    assert.deepEqual(failures, []);
  });
});
