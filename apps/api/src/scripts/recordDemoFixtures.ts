import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pool } from "../core/db.js";
import { getEmbeddingProvider } from "../modules/ai/embedding/index.js";
import { fixtureKeyOf } from "../modules/ai/embedding/fixture.provider.js";

/**
 * Record the demo vectors the checked-in embedding fixture needs.
 *
 * `embeddingFixtures.json` is two things: the texts CI's investigation
 * evaluation replays, and the texts a $0 fixture-mode demo can answer. The
 * first set is recorded by `embeddingFixtureServer.ts`; the second is this
 * script, because it needs the demo corpus *as ingested* (chunk texts, not
 * source files) plus the questions the demo offers.
 *
 * The corpus comes from the seeded demo organization, so this must run after
 * `node scripts/seed-demo.mjs` against the same database, with a real embedder
 * configured -- never `fixture`, which would replay the file it is writing.
 *
 * Run: npm run embed:demo-fixtures [-- --org <uuid>] [-- --dry-run]
 *
 * Existing vectors are kept: keys are content hashes, so re-running after a
 * corpus edit adds the new chunks and leaves everything else (including CI's
 * texts) untouched. Nothing is deleted, so a deduplicated text keeps its
 * recorded vector.
 */

const ORG_NAME = "Northwind Ops (Demo)";
const BATCH_SIZE = 16;

/** The questions `docs/deployment.md` tells demo visitors to ask. */
const DEMO_QUESTIONS = [
  "How do we recover from PostgreSQL connection pool exhaustion?",
  "Why are large uploads failing with 413?",
  "What is the rollback procedure for a failed deployment?",
  "Why did checkout start failing after release 1.42.0?",
  "How do I restore the production database from a backup?",
  "What causes Redis key evictions?",
] as const;

type Fixture = {
  model: string;
  dimensions: number;
  vectors: Record<string, number[]>;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { org: string | null; dryRun: boolean } {
  let org: string | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--org":
        org = argv[index + 1] ?? fail("--org needs an organization id");
        index += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        fail(`Unknown argument "${argv[index]}". Use --org <uuid> or --dry-run.`);
    }
  }

  return { org, dryRun };
}

async function resolveOrganization(orgArg: string | null): Promise<string> {
  if (orgArg !== null) {
    return orgArg;
  }

  const found = await pool.query<{ id: string }>(
    `SELECT id FROM organizations WHERE name = $1 LIMIT 1`,
    [ORG_NAME]
  );

  if (!found.rows[0]) {
    fail(
      `No organization named "${ORG_NAME}". Seed the demo first ` +
        "(`node scripts/seed-demo.mjs`) or pass --org <uuid>."
    );
  }

  return found.rows[0]!.id;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = getEmbeddingProvider();

  if (provider.name === "fixture") {
    fail(
      "EMBEDDING_PROVIDER=fixture would replay the file this script writes. " +
        "Point it at a real embedder (ollama, or a hosted openai-compatible API)."
    );
  }

  const fixturePath =
    process.env.EMBEDDING_FIXTURE_PATH?.trim() ||
    fileURLToPath(new URL("../evaluation/embeddingFixtures.json", import.meta.url));

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;

  if (fixture.model !== provider.model) {
    fail(
      `The fixture holds ${fixture.model} vectors but the configured provider is ` +
        `"${provider.model}". Recording one model into the other's file would mix ` +
        "vector spaces; set EMBEDDING_MODEL to match or re-record the whole fixture."
    );
  }

  const organizationId = await resolveOrganization(options.org);
  const chunks = await pool.query<{ content: string }>(
    `SELECT content FROM source_chunks WHERE organization_id = $1 ORDER BY content`,
    [organizationId]
  );

  if (chunks.rows.length === 0) {
    fail(
      `Organization ${organizationId} has no indexed chunks. Seed the demo ` +
        "(`node scripts/seed-demo.mjs`) and wait for the worker before recording."
    );
  }

  // Questions are queries, but the recorded provider ignores the role and the
  // fixture stores one vector per text; search embeds the question verbatim.
  const texts = [
    ...new Set([...chunks.rows.map((row) => row.content), ...DEMO_QUESTIONS]),
  ].filter((text) => fixture.vectors[fixtureKeyOf(text)] === undefined);

  console.log(
    `${chunks.rows.length} demo chunks + ${DEMO_QUESTIONS.length} questions · ` +
      `${texts.length} new text(s) to embed with ${provider.name}/${provider.model}`
  );

  if (options.dryRun) {
    console.log("Dry run: nothing written.");
    await pool.end();
    return;
  }

  for (let index = 0; index < texts.length; index += BATCH_SIZE) {
    const batchTexts = texts.slice(index, index + BATCH_SIZE);
    const batch = await provider.embed(batchTexts);

    // A provider that returns a short batch would leave a question without a
    // vector while the run still reports success, so the demo would fail on a
    // question the docs promise works. Fail loudly instead.
    if (batch.embeddings.length !== batchTexts.length) {
      throw new Error(
        `${provider.name}/${provider.model} returned ${batch.embeddings.length} ` +
          `vectors for ${batchTexts.length} texts; refusing to write a partial fixture.`
      );
    }

    batchTexts.forEach((text, offset) => {
      const vector = batch.embeddings[offset]!;
      fixture.vectors[fixtureKeyOf(text)] = vector;
    });
  }

  fs.writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");

  console.log(
    `Wrote ${fixturePath}: ${Object.keys(fixture.vectors).length} vectors ` +
      `(${texts.length} added).`
  );

  await pool.end();
}

/**
 * Run only when invoked as a script (`npm run embed:demo-fixtures`). Importing
 * this module must not start a recording: a test or a future script may want
 * to read it, and a side effect on import would hit the database and an
 * embedding provider for no reason.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    console.error("Recording demo fixtures failed", error);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
}
