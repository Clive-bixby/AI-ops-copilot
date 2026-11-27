import fs from "node:fs";

import { pool } from "../core/db.js";
import { getEmbeddingProvider, resetEmbeddingProvider } from "../modules/ai/embedding/index.js";
import { retrieveRelevantChunks } from "../modules/ai/retrieval.service.js";
import type { RetrievalMode } from "../modules/ai/retrieval.service.js";
import { getEmbeddingConfig, hashContent, hashLogEvent } from "../modules/ingestion/embeddingConfig.js";
import { indexDocument } from "../modules/ingestion/documentIngest.service.js";
import { groupLogEvents, indexLogGroups } from "../modules/ingestion/logGroup.service.js";
import { indexTicket } from "../modules/ingestion/ticketIngest.service.js";
import {
  evaluationDocuments,
  evaluationLogs,
  evaluationNoiseDocuments,
  evaluationQueries,
  evaluationTickets,
  hardEvaluationQueries,
} from "../evaluation/retrievalDataset.js";
import type { EvaluationQuery } from "../evaluation/retrievalDataset.js";

/**
 * Retrieval evaluation.
 *
 * Seeds a labelled corpus into a temporary organization, indexes it through the
 * production ingestion path, then measures the vector-only arm and the hybrid
 * arm on the same queries. Relevance is labelled at source level.
 *
 * Run: npm run eval:retrieval
 * Keep the corpus for inspection: npm run eval:retrieval -- --keep
 * Small, noise-free corpus: npm run eval:retrieval -- --small
 * Candidate model: npm run eval:retrieval -- --provider gemini --model gemini-embedding-001
 * Held-out queries: npm run eval:retrieval -- --queries hard
 * Machine-readable: npm run eval:retrieval -- --json .eval/retrieval.json
 * Quality gate: hybrid recall@10 must reach 0.95 on the standard set; `--floor`
 * overrides it (0 disables, and the held-out set is ungated by default).
 *
 * `--provider` / `--model` seed and query one embedder into its own ephemeral
 * organization, named after that provider, so two runs cannot share vectors.
 * `--queries hard` swaps the 36-query set for the held-out one in §5.2; the
 * default set is unchanged, which is what keeps the §5.1 numbers reproducible.
 *
 * By default the corpus includes distractor documents that share vocabulary with
 * the labelled sources, which is where an OR keyword arm can add noise. The
 * `keyword-only` columns count top-10 results that were found only by the
 * keyword arm, and how many of those were not relevant.
 */

const TOP_K = 10;
const RANK_CUTOFFS = [5, 10] as const;

/**
 * Hybrid recall@10 on the standard set was 0.9907 when measured in Phase 5.5.
 * Losing every source of one query costs at most 0.028, so 0.95 catches a real
 * regression without failing on a re-recorded fixture or a fusion-order tie.
 */
const HYBRID_RECALL_10_FLOOR = 0.95;
const ORG_NAME = "Retrieval Evaluation (ephemeral)";

type ModeMetrics = {
  recall: Record<number, number>;
  precision: Record<number, number>;
  mrr: number;
  ndcg: number;
  latencyMs: number;
  keywordOnly: number;
  keywordOnlyIrrelevant: number;
};

type QueryReport = {
  query: string;
  relevant: string[];
  modes: Record<
    RetrievalMode,
    {
      rankedKeys: string[];
      firstRelevantRank: number | null;
      matchTypes: Record<string, number>;
      /** Cosine similarity of the top result; null when only keywords found it. */
      topSimilarity: number | null;
      metrics: ModeMetrics;
    }
  >;
};

type QuerySet = "standard" | "hard";

type Options = {
  keep: boolean;
  small: boolean;
  queries: QuerySet;
  provider: string | null;
  model: string | null;
  json: string | null;
};

/** The three families the corpus labels, by key prefix (d_/n_, t_, l_). */
const SOURCE_TYPES = ["documents", "tickets", "logs"] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

type SimilaritySummary = {
  p10: number | null;
  p50: number | null;
  p90: number | null;
  queriesWithVectorHit: number;
};

function emptyMetrics(): ModeMetrics {
  return {
    recall: Object.fromEntries(RANK_CUTOFFS.map((k) => [k, 0])),
    precision: Object.fromEntries(RANK_CUTOFFS.map((k) => [k, 0])),
    mrr: 0,
    ndcg: 0,
    latencyMs: 0,
    keywordOnly: 0,
    keywordOnlyIrrelevant: 0,
  };
}

function evaluateRanking(rankedKeys: string[], relevant: string[]): ModeMetrics {
  const relevantSet = new Set(relevant);
  const cut = rankedKeys.slice(0, TOP_K);
  const metrics = emptyMetrics();

  for (const k of RANK_CUTOFFS) {
    const hits = cut.slice(0, k).filter((key) => relevantSet.has(key)).length;
    metrics.recall[k] = relevant.length === 0 ? 0 : hits / relevant.length;
    metrics.precision[k] = hits / k;
  }

  const firstIndex = cut.findIndex((key) => relevantSet.has(key));
  metrics.mrr = firstIndex === -1 ? 0 : 1 / (firstIndex + 1);

  let dcg = 0;
  cut.forEach((key, index) => {
    if (relevantSet.has(key)) {
      dcg += 1 / Math.log2(index + 2);
    }
  });

  const idealHits = Math.min(relevant.length, TOP_K);
  let idcg = 0;
  for (let index = 0; index < idealHits; index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }
  metrics.ndcg = idcg === 0 ? 0 : dcg / idcg;

  return metrics;
}

async function ensureOrganization(name: string): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM organizations WHERE name = $1 LIMIT 1`,
    [name]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [name]
  );

  return inserted.rows[0]!.id;
}

async function clearOrganization(organizationId: string): Promise<void> {
  await pool.query(`DELETE FROM documents WHERE organization_id = $1`, [organizationId]);
  await pool.query(`DELETE FROM tickets WHERE organization_id = $1`, [organizationId]);
  await pool.query(`DELETE FROM log_groups WHERE organization_id = $1`, [organizationId]);
  await pool.query(`DELETE FROM logs WHERE organization_id = $1`, [organizationId]);
}

async function seedCorpus(
  organizationId: string,
  documents: typeof evaluationDocuments
): Promise<{
  sourceKey: (sourceType: string, sourceId: string) => string | null;
}> {
  const documentIdByKey = new Map<string, string>();
  const ticketIdByKey = new Map<string, string>();
  const logIdByKey = new Map<string, string>();

  for (const document of documents) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO documents (organization_id, filename, content, content_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        organizationId,
        document.filename,
        document.content,
        hashContent(document.content),
      ]
    );
    const documentId = inserted.rows[0]!.id;
    documentIdByKey.set(document.key, documentId);
    await indexDocument({ organizationId, documentId });
  }

  for (const ticket of evaluationTickets) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO tickets (organization_id, title, description, status, priority)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        organizationId,
        ticket.title,
        ticket.description,
        ticket.status,
        ticket.priority,
      ]
    );
    const ticketId = inserted.rows[0]!.id;
    ticketIdByKey.set(ticket.key, ticketId);
    await indexTicket({ organizationId, ticketId });
  }

  const logIds: string[] = [];
  for (const [index, log] of evaluationLogs.entries()) {
    const timestamp = new Date(
      Date.UTC(2026, 10, 1, 10, 0, index)
    ).toISOString();

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO logs (organization_id, level, message, metadata, timestamp, content_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamp, $6) RETURNING id`,
      [
        organizationId,
        log.level,
        log.message,
        JSON.stringify({ service: log.service }),
        timestamp,
        hashLogEvent({
          level: log.level,
          message: log.message,
          timestamp,
          metadata: { service: log.service },
        }),
      ]
    );

    const logId = inserted.rows[0]!.id;
    logIds.push(logId);
    logIdByKey.set(log.key, logId);
  }

  const grouped = await groupLogEvents({ organizationId, logIds });
  await indexLogGroups({ organizationId, groupIds: grouped.groupIds });

  // Map indexed log-group chunks back to the corpus log they represent. A group
  // stores up to five sample ids; the eval corpus writes one topic per group.
  const groupIdByLogKey = new Map<string, string>();
  const groups = await pool.query<{ id: string; sample_log_ids: string[] }>(
    `SELECT id, sample_log_ids FROM log_groups WHERE organization_id = $1`,
    [organizationId]
  );

  for (const group of groups.rows) {
    for (const sampleId of group.sample_log_ids) {
      for (const [logKey, logId] of logIdByKey.entries()) {
        if (logId === sampleId) {
          groupIdByLogKey.set(logKey, group.id);
        }
      }
    }
  }

  const keyBySourceId = new Map<string, string>();
  for (const [key, id] of documentIdByKey.entries()) {
    keyBySourceId.set(`document:${id}`, key);
  }
  for (const [key, id] of ticketIdByKey.entries()) {
    keyBySourceId.set(`ticket:${id}`, key);
  }
  for (const [key, id] of groupIdByLogKey.entries()) {
    keyBySourceId.set(`log:${id}`, key);
  }

  return {
    sourceKey: (sourceType, sourceId) =>
      keyBySourceId.get(`${sourceType}:${sourceId}`) ?? null,
  };
}

async function runMode(input: {
  organizationId: string;
  mode: RetrievalMode;
  queries: EvaluationQuery[];
  sourceKey: (sourceType: string, sourceId: string) => string | null;
}): Promise<QueryReport[]> {
  const reports: QueryReport[] = [];

  for (const item of input.queries) {
    const startedAt = Date.now();
    const result = await retrieveRelevantChunks({
      organizationId: input.organizationId,
      query: item.query,
      topK: TOP_K,
      mode: input.mode,
    });
    const latencyMs = Date.now() - startedAt;

    const rankedKeys: string[] = [];
    const matchTypes: Record<string, number> = {};
    const matchTypeByKey = new Map<string, string>();

    for (const chunk of result.chunks) {
      matchTypes[chunk.matchType] = (matchTypes[chunk.matchType] ?? 0) + 1;
      const key = input.sourceKey(chunk.sourceType, chunk.sourceId);
      if (key && !rankedKeys.includes(key)) {
        rankedKeys.push(key);
        matchTypeByKey.set(key, chunk.matchType);
      }
    }

    const metrics = evaluateRanking(rankedKeys, item.relevant);
    metrics.latencyMs = latencyMs;

    for (const key of rankedKeys.slice(0, TOP_K)) {
      if (matchTypeByKey.get(key) !== "keyword") {
        continue;
      }
      metrics.keywordOnly += 1;
      if (!item.relevant.includes(key)) {
        metrics.keywordOnlyIrrelevant += 1;
      }
    }
    const firstRelevantRank = rankedKeys.findIndex((key) =>
      item.relevant.includes(key)
    );

    reports.push({
      query: item.query,
      relevant: item.relevant,
      modes: {
        [input.mode]: {
          rankedKeys,
          firstRelevantRank: firstRelevantRank === -1 ? null : firstRelevantRank + 1,
          matchTypes,
          topSimilarity: result.chunks[0]?.similarity ?? null,
          metrics,
        },
      },
    } as QueryReport);
  }

  return reports;
}

function average(reports: QueryReport[], mode: RetrievalMode): ModeMetrics {
  const aggregate = emptyMetrics();
  const count = Math.max(reports.length, 1);

  for (const report of reports) {
    const metrics = report.modes[mode].metrics;
    for (const k of RANK_CUTOFFS) {
      aggregate.recall[k] = (aggregate.recall[k] ?? 0) + (metrics.recall[k] ?? 0);
      aggregate.precision[k] =
        (aggregate.precision[k] ?? 0) + (metrics.precision[k] ?? 0);
    }
    aggregate.mrr += metrics.mrr;
    aggregate.ndcg += metrics.ndcg;
    aggregate.latencyMs += metrics.latencyMs;
    aggregate.keywordOnly += metrics.keywordOnly;
    aggregate.keywordOnlyIrrelevant += metrics.keywordOnlyIrrelevant;
  }

  for (const k of RANK_CUTOFFS) {
    aggregate.recall[k] = (aggregate.recall[k] ?? 0) / count;
    aggregate.precision[k] = (aggregate.precision[k] ?? 0) / count;
  }

  aggregate.mrr /= count;
  aggregate.ndcg /= count;
  aggregate.latencyMs /= count;
  aggregate.keywordOnly /= count;
  aggregate.keywordOnlyIrrelevant /= count;

  return aggregate;
}

function format(value: number, digits = 4): string {
  return value.toFixed(digits);
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : format(value);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): Options & { floor: number } {
  const options: Options = {
    keep: false,
    small: false,
    queries: "standard",
    provider: null,
    model: null,
    json: null,
  };
  let floorOverride: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    // `fail` never returns, so the value is always a string.
    const value = (): string => argv[index + 1] ?? fail(`${flag} needs a value`);

    switch (flag) {
      case "--keep":
        options.keep = true;
        break;
      case "--small":
        options.small = true;
        break;
      case "--queries": {
        const raw = value();
        index += 1;
        if (raw !== "standard" && raw !== "hard") {
          fail(`--queries must be "standard" or "hard" (received "${raw}").`);
        }
        options.queries = raw;
        break;
      }
      case "--provider":
        options.provider = value();
        index += 1;
        break;
      case "--model":
        options.model = value();
        index += 1;
        break;
      case "--json":
        options.json = value();
        index += 1;
        break;
      case "--floor": {
        const raw = value();
        index += 1;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          fail(`--floor must be a number between 0 and 1 (received "${raw}").`);
        }
        floorOverride = parsed;
        break;
      }
      default:
        fail(
          `Unknown flag "${flag}". Use --keep, --small, --queries standard|hard, --provider, --model, --json, --floor.`
        );
    }
  }

  // The measured floor belongs to the standard set. The held-out set sits at
  // 0.90 by design, so gating it at the standard floor would fail every run;
  // a comparative hard-set run opts in with an explicit --floor.
  const floor =
    floorOverride ?? (options.queries === "standard" ? HYBRID_RECALL_10_FLOOR : 0);

  return { ...options, floor };
}

/**
 * Nearest-rank percentile. Null for an empty sample, so a run whose top hits
 * were all keyword-only reports n/a rather than a made-up 0.
 */
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round(fraction * (sorted.length - 1));

  return sorted[index]!;
}

function summariseSimilarity(values: number[]): SimilaritySummary {
  return {
    p10: percentile(values, 0.1),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    queriesWithVectorHit: values.length,
  };
}

function topSimilarities(reports: QueryReport[], mode: RetrievalMode): number[] {
  return reports
    .map((report) => report.modes[mode].topSimilarity)
    .filter((value): value is number => value !== null);
}

function sourceTypeOf(key: string): SourceType {
  if (key.startsWith("t_")) {
    return "tickets";
  }
  if (key.startsWith("l_")) {
    return "logs";
  }
  return "documents";
}

/**
 * Recall@10 split by source type, averaged over the queries that have a
 * relevant source of that type. A cloud model can behave very differently on
 * prose runbooks, terse tickets and log lines, and one pooled recall number
 * hides exactly that.
 */
function recallBySourceType(
  reports: QueryReport[],
  mode: RetrievalMode
): Record<SourceType, number | null> {
  const totals = Object.fromEntries(
    SOURCE_TYPES.map((type) => [type, { found: 0, total: 0 }])
  ) as Record<SourceType, { found: number; total: number }>;

  for (const report of reports) {
    const ranked = new Set(report.modes[mode].rankedKeys.slice(0, TOP_K));

    for (const key of report.relevant) {
      const type = sourceTypeOf(key);
      totals[type].total += 1;
      if (ranked.has(key)) {
        totals[type].found += 1;
      }
    }
  }

  return Object.fromEntries(
    SOURCE_TYPES.map((type) => [
      type,
      totals[type].total === 0 ? null : totals[type].found / totals[type].total,
    ])
  ) as Record<SourceType, number | null>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Environment before the provider is first built: the selection is cached for
  // the process, so an override applied later would silently be ignored.
  if (options.provider !== null) {
    process.env.EMBEDDING_PROVIDER = options.provider;
  }
  if (options.model !== null) {
    process.env.EMBEDDING_MODEL = options.model;
  }
  if (options.provider !== null || options.model !== null) {
    resetEmbeddingProvider();
  }

  const embedding = getEmbeddingConfig();
  const providerName = getEmbeddingProvider().name;
  const queries =
    options.queries === "hard" ? hardEvaluationQueries : evaluationQueries;
  const documents = options.small
    ? evaluationDocuments
    : [...evaluationDocuments, ...evaluationNoiseDocuments];
  // One organization per embedder: a run can never read another model's rows
  // even if the SQL model filter were ever relaxed.
  const organizationId = await ensureOrganization(
    `${ORG_NAME} ${providerName}/${embedding.model}`
  );

  try {
    await clearOrganization(organizationId);
    const map = await seedCorpus(organizationId, documents);

    const vectorReports = await runMode({
      organizationId,
      mode: "vector",
      queries,
      sourceKey: map.sourceKey,
    });
    const hybridReports = await runMode({
      organizationId,
      mode: "hybrid",
      queries,
      sourceKey: map.sourceKey,
    });

    const modes: RetrievalMode[] = ["vector", "hybrid"];
    const summary = Object.fromEntries(
      modes.map((mode) => [
        mode,
        average(mode === "vector" ? vectorReports : hybridReports, mode),
      ])
    ) as Record<RetrievalMode, ModeMetrics>;

    console.log("");
    console.log("Retrieval evaluation — vector-only baseline vs hybrid (RRF)");
    console.log(
      `Embedding: ${providerName}/${embedding.model} (${embedding.dimensions} d)` +
        ` · query set ${options.queries} (${queries.length})`
    );
    console.log(`Corpus: ${documents.length} documents (${options.small ? 0 : evaluationNoiseDocuments.length} distractors), ${evaluationTickets.length} tickets, ${evaluationLogs.length} log events`);
    console.log("");
    console.log("| Mode | Recall@5 | Recall@10 | Precision@5 | Precision@10 | MRR@10 | nDCG@10 | KW-only@10 | KW-only wrong@10 | Avg ms |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

    for (const mode of modes) {
      const metrics = summary[mode];
      console.log(
        `| ${mode} | ${format(metrics.recall[5] ?? 0)} | ${format(metrics.recall[10] ?? 0)} | ` +
          `${format(metrics.precision[5] ?? 0)} | ${format(metrics.precision[10] ?? 0)} | ` +
          `${format(metrics.mrr)} | ${format(metrics.ndcg)} | ` +
          `${format(metrics.keywordOnly, 2)} | ${format(metrics.keywordOnlyIrrelevant, 2)} | ` +
          `${Math.round(metrics.latencyMs)} |`
      );
    }

    console.log("");
    console.log(
      "| Mode | Top-hit similarity p10 / p50 / p90 | Recall@10 documents | Recall@10 tickets | Recall@10 logs |"
    );
    console.log("| --- | --- | --- | --- | --- |");

    for (const mode of modes) {
      const reports = mode === "vector" ? vectorReports : hybridReports;
      const similarity = summariseSimilarity(topSimilarities(reports, mode));
      const byType = recallBySourceType(reports, mode);

      console.log(
        `| ${mode} | ${formatNullable(similarity.p10)} / ${formatNullable(
          similarity.p50
        )} / ${formatNullable(similarity.p90)} | ${formatNullable(
          byType.documents
        )} | ${formatNullable(byType.tickets)} | ${formatNullable(byType.logs)} |`
      );
    }

    console.log("");
    console.log("| Query | Relevant | Vector rank | Hybrid rank | Vector top source | Hybrid top source |");
    console.log("| --- | --- | --- | --- | --- | --- |");

    queries.forEach((item, index) => {
      const vectorReport = vectorReports[index]!.modes.vector;
      const hybridReport = hybridReports[index]!.modes.hybrid;
      console.log(
        `| ${item.query} | ${item.relevant.join(", ")} | ` +
          `${vectorReport.firstRelevantRank ?? "-"} | ${hybridReport.firstRelevantRank ?? "-"} | ` +
          `${vectorReport.rankedKeys[0] ?? "-"} | ${hybridReport.rankedKeys[0] ?? "-"} |`
      );
    });

    const hybridRecall10 = summary.hybrid.recall[10] ?? 0;

    console.log("");
    if (options.floor === 0) {
      console.log("Quality gate: disabled.");
    } else if (hybridRecall10 >= options.floor) {
      console.log(
        `Quality gate: hybrid recall@10 ${format(hybridRecall10)} meets the ${format(options.floor)} floor.`
      );
    } else {
      process.exitCode = 1;
      console.error(
        `Quality gate failed: hybrid recall@10 ${format(hybridRecall10)} is below the ${format(options.floor)} floor.`
      );
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      embedding: {
        provider: providerName,
        model: embedding.model,
        dimensions: embedding.dimensions,
        configHash: embedding.hash,
      },
      querySet: { name: options.queries, count: queries.length },
      corpus: {
        documents: documents.length,
        noiseDocuments: options.small ? 0 : evaluationNoiseDocuments.length,
        tickets: evaluationTickets.length,
        logEvents: evaluationLogs.length,
      },
      summary,
      similarity: Object.fromEntries(
        modes.map((mode) => [
          mode,
          summariseSimilarity(
            topSimilarities(mode === "vector" ? vectorReports : hybridReports, mode)
          ),
        ])
      ),
      recallBySourceType: Object.fromEntries(
        modes.map((mode) => [
          mode,
          recallBySourceType(mode === "vector" ? vectorReports : hybridReports, mode),
        ])
      ),
      perQuery: queries.map((item, index) => ({
        query: item.query,
        relevant: item.relevant,
        vector: vectorReports[index]!.modes.vector,
        hybrid: hybridReports[index]!.modes.hybrid,
      })),
    };

    if (options.json !== null) {
      await fs.promises.writeFile(
        options.json,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8"
      );
      console.log("");
      console.log(`JSON written to ${options.json}`);
    }

    console.log("");
    console.log(`EVAL_JSON=${JSON.stringify(payload)}`);
  } finally {
    if (!options.keep) {
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Retrieval evaluation failed", error);
  process.exitCode = 1;
});
