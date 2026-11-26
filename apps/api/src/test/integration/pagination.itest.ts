import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  addMembership,
  apiRequest,
  createOrganization,
  createUser,
  getPool,
  hasPool,
  resetDatabase,
  setupTestDatabase,
  startServer,
  tokenFor,
} from "./harness.js";
import type { TestServer } from "./harness.js";

/**
 * Bounded pagination on the three plain list endpoints.
 *
 * The numbers are literals on purpose: 200 is the documented default page and
 * 500 the documented maximum, so changing either without changing the contract
 * fails here. The response stays a bare array, which is what keeps existing
 * clients (the SPA sends no parameters) working unchanged.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

type DocumentRow = { id: string };
type LogRow = { id: string };
type TicketRow = { id: string };

let server: TestServer;
let orgA: string;
let orgB: string;
let ownerA: string;

function auth(organizationId = orgA) {
  return { token: tokenFor(ownerA), organizationId };
}

async function list(path: string, query = "") {
  return apiRequest<Array<DocumentRow | LogRow | TicketRow>>(
    server.url,
    "GET",
    `${path}${query}`,
    auth()
  );
}

async function seedDocuments(count: number): Promise<void> {
  await getPool().query(
    `INSERT INTO documents (organization_id, filename, content, file_hash)
     SELECT $1, 'runbook-' || i || '.md', 'content ' || i, md5('file-' || i)
     FROM generate_series(1, $2) AS i`,
    [orgA, count]
  );
}

async function seedTickets(count: number): Promise<void> {
  await getPool().query(
    `INSERT INTO tickets (organization_id, title, description, status, priority)
     SELECT $1, 'Ticket ' || i, 'seeded', 'open', 'medium'
     FROM generate_series(1, $2) AS i`,
    [orgA, count]
  );
}

async function seedLogs(count: number): Promise<void> {
  await getPool().query(
    `INSERT INTO logs (organization_id, level, message, metadata, timestamp)
     SELECT $1, 'error', 'seeded event ' || i, '{}'::jsonb,
            NOW() - (i || ' seconds')::interval
     FROM generate_series(1, $2) AS i`,
    [orgA, count]
  );
}

before(async () => {
  await setupTestDatabase();
  server = await startServer();
});

after(async () => {
  await server?.close();
  if (hasPool()) {
    await getPool().end();
  }
});

beforeEach(async () => {
  await resetDatabase();

  orgA = await createOrganization("Org A");
  orgB = await createOrganization("Org B");
  ownerA = await createUser("owner@a.example.test");

  await addMembership(ownerA, orgA, "owner");
});

describe("defaults and maximums", () => {
  it("returns the whole list when it fits under the default page", async () => {
    await seedDocuments(3);
    await seedTickets(3);
    await seedLogs(3);

    for (const path of ["/documents", "/tickets", "/logs"]) {
      const response = await list(path);

      assert.equal(response.status, 200);
      assert.equal(response.body.length, 3, `${path} lost rows under the default`);
    }
  });

  it("caps /documents at the default page and honours the maximum", async () => {
    await seedDocuments(DEFAULT_LIMIT + 5);

    const byDefault = await list("/documents");
    const byMaximum = await list("/documents", `?limit=${MAX_LIMIT}`);

    assert.equal(byDefault.status, 200);
    assert.equal(byDefault.body.length, DEFAULT_LIMIT);
    assert.equal(byMaximum.status, 200);
    assert.equal(byMaximum.body.length, DEFAULT_LIMIT + 5);
  });
});

describe("offset paging", () => {
  it("returns disjoint, non-repeating pages in a stable order", async () => {
    await seedDocuments(DEFAULT_LIMIT + 5);

    const first = await list("/documents", "?limit=100&offset=0");
    const second = await list("/documents", "?limit=100&offset=100");
    const last = await list("/documents", "?limit=100&offset=200");

    assert.equal(first.body.length, 100);
    assert.equal(second.body.length, 100);
    assert.equal(last.body.length, 5);

    const ids = [...first.body, ...second.body, ...last.body].map((row) => row.id);
    assert.equal(new Set(ids).size, DEFAULT_LIMIT + 5, "pages must not overlap");
  });

  it("pages logs and tickets without dropping or repeating a row", async () => {
    await seedLogs(3);
    await seedTickets(3);

    for (const path of ["/logs", "/tickets"]) {
      const page1 = await list(path, "?limit=2&offset=0");
      const page2 = await list(path, "?limit=2&offset=2");

      assert.equal(page1.body.length, 2, `${path} page 1`);
      assert.equal(page2.body.length, 1, `${path} page 2`);

      const ids = [...page1.body, ...page2.body].map((row) => row.id);
      assert.equal(new Set(ids).size, 3, `${path} must not repeat rows across pages`);
    }
  });

  it("keeps paging inside the caller's organization", async () => {
    await seedDocuments(3);
    await getPool().query(
      `INSERT INTO documents (organization_id, filename, content, file_hash)
       VALUES ($1, 'other.md', 'other tenant', md5('other'))`,
      [orgB]
    );

    const page = await list("/documents", "?limit=500");

    assert.equal(page.body.length, 3);
  });
});

describe("invalid pagination parameters", () => {
  const invalid = [
    "?limit=0",
    "?limit=501",
    "?limit=abc",
    "?limit=1.5",
    "?offset=-1",
    "?offset=abc",
    `?offset=${100001}`,
  ];

  it("rejects every invalid limit or offset on all three endpoints", async () => {
    const failures: string[] = [];

    for (const path of ["/documents", "/logs", "/tickets"]) {
      for (const query of invalid) {
        const response = await list(path, query);

        if (response.status !== 400) {
          failures.push(`${path}${query} -> ${response.status}`);
        }
      }
    }

    assert.deepEqual(failures, []);
  });

  it("names the parameter it rejected", async () => {
    const response = await list("/documents", "?limit=501");

    assert.equal(response.status, 400);
    assert.match(
      (response.body as unknown as { error: string }).error,
      /limit must be an integer between 1 and 500/
    );
  });
});
