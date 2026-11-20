import { pool } from "../core/db.js";
import { retrieveRelevantChunks } from "../modules/ai/retrieval.service.js";
import type { RetrievalMode } from "../modules/ai/retrieval.service.js";
import { hashContent, hashLogEvent } from "../modules/ingestion/embeddingConfig.js";
import { indexDocument } from "../modules/ingestion/documentIngest.service.js";
import { groupLogEvents, indexLogGroups } from "../modules/ingestion/logGroup.service.js";
import { indexTicket } from "../modules/ingestion/ticketIngest.service.js";
import {
  evaluationDocuments,
  evaluationLogs,
  evaluationQueries,
  evaluationTickets,
} from "../evaluation/retrievalDataset.js";

/**
 * Retrieval evaluation.
 *
 * Seeds a labelled corpus into a temporary organization, indexes it through the
 * production ingestion path, then measures the vector-only arm and the hybrid
 * arm on the same queries. Relevance is labelled at source level.
 *
 * Run: npm run eval:retrieval
 * Keep the corpus for inspection: npm run eval:retrieval -- --keep
 */

const TOP_K = 10;
const RANK_CUTOFFS = [5, 10] as const;
const ORG_NAME = "Retrieval Evaluation (ephemeral)";

type ModeMetrics = {
  recall: Record<number, number>;
  precision: Record<number, number>;
  mrr: number;
  ndcg: number;
  latencyMs: number;
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
      metrics: ModeMetrics;
    }
  >;
};

function emptyMetrics(): ModeMetrics {
  return {
    recall: Object.fromEntries(RANK_CUTOFFS.map((k) => [k, 0])),
    precision: Object.fromEntries(RANK_CUTOFFS.map((k) => [k, 0])),
    mrr: 0,
    ndcg: 0,
    latencyMs: 0,
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

async function ensureOrganization(): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM organizations WHERE name = $1 LIMIT 1`,
    [ORG_NAME]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [ORG_NAME]
  );

  return inserted.rows[0]!.id;
}

async function clearOrganization(organizationId: string): Promise<void> {
  await pool.query(`DELETE FROM documents WHERE organization_id = $1`, [organizationId]);
  await pool.query(`DELETE FROM tickets WHERE organization_id = $1`, [organizationId]);
  await pool.query(`DELETE FROM log_groups WHERE organization_id = $1`, [organizationId]);
  await pool.query(`DELETE FROM logs WHERE organization_id = $1`, [organizationId]);
}

async function seedCorpus(organizationId: string): Promise<{
  sourceKey: (sourceType: string, sourceId: string) => string | null;
}> {
  const documentIdByKey = new Map<string, string>();
  const ticketIdByKey = new Map<string, string>();
  const logIdByKey = new Map<string, string>();

  for (const document of evaluationDocuments) {
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
  sourceKey: (sourceType: string, sourceId: string) => string | null;
}): Promise<QueryReport[]> {
  const reports: QueryReport[] = [];

  for (const item of evaluationQueries) {
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

    for (const chunk of result.chunks) {
      matchTypes[chunk.matchType] = (matchTypes[chunk.matchType] ?? 0) + 1;
      const key = input.sourceKey(chunk.sourceType, chunk.sourceId);
      if (key && !rankedKeys.includes(key)) {
        rankedKeys.push(key);
      }
    }

    const metrics = evaluateRanking(rankedKeys, item.relevant);
    metrics.latencyMs = latencyMs;
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
  }

  for (const k of RANK_CUTOFFS) {
    aggregate.recall[k] = (aggregate.recall[k] ?? 0) / count;
    aggregate.precision[k] = (aggregate.precision[k] ?? 0) / count;
  }

  aggregate.mrr /= count;
  aggregate.ndcg /= count;
  aggregate.latencyMs /= count;

  return aggregate;
}

function format(value: number, digits = 4): string {
  return value.toFixed(digits);
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const organizationId = await ensureOrganization();

  try {
    await clearOrganization(organizationId);
    const map = await seedCorpus(organizationId);

    const vectorReports = await runMode({
      organizationId,
      mode: "vector",
      sourceKey: map.sourceKey,
    });
    const hybridReports = await runMode({
      organizationId,
      mode: "hybrid",
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
    console.log(`Corpus: ${evaluationDocuments.length} documents, ${evaluationTickets.length} tickets, ${evaluationLogs.length} log events (${evaluationQueries.length} queries)`);
    console.log("");
    console.log("| Mode | Recall@5 | Recall@10 | Precision@5 | Precision@10 | MRR@10 | nDCG@10 | Avg ms |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");

    for (const mode of modes) {
      const metrics = summary[mode];
      console.log(
        `| ${mode} | ${format(metrics.recall[5] ?? 0)} | ${format(metrics.recall[10] ?? 0)} | ` +
          `${format(metrics.precision[5] ?? 0)} | ${format(metrics.precision[10] ?? 0)} | ` +
          `${format(metrics.mrr)} | ${format(metrics.ndcg)} | ${Math.round(metrics.latencyMs)} |`
      );
    }

    console.log("");
    console.log("| Query | Relevant | Vector rank | Hybrid rank | Vector top source | Hybrid top source |");
    console.log("| --- | --- | --- | --- | --- | --- |");

    evaluationQueries.forEach((item, index) => {
      const vectorReport = vectorReports[index]!.modes.vector;
      const hybridReport = hybridReports[index]!.modes.hybrid;
      console.log(
        `| ${item.query} | ${item.relevant.join(", ")} | ` +
          `${vectorReport.firstRelevantRank ?? "-"} | ${hybridReport.firstRelevantRank ?? "-"} | ` +
          `${vectorReport.rankedKeys[0] ?? "-"} | ${hybridReport.rankedKeys[0] ?? "-"} |`
      );
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      corpus: {
        documents: evaluationDocuments.length,
        tickets: evaluationTickets.length,
        logEvents: evaluationLogs.length,
        queries: evaluationQueries.length,
      },
      summary,
      perQuery: evaluationQueries.map((item, index) => ({
        query: item.query,
        relevant: item.relevant,
        vector: vectorReports[index]!.modes.vector,
        hybrid: hybridReports[index]!.modes.hybrid,
      })),
    };

    console.log("");
    console.log(`EVAL_JSON=${JSON.stringify(payload)}`);
  } finally {
    if (!keep) {
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Retrieval evaluation failed", error);
  process.exitCode = 1;
});
