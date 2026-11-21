import type { PoolClient } from "pg";

import { pool } from "../../core/db.js";
import { logger } from "../../core/logger.js";
import { retrieveRelevantChunks } from "../ai/retrieval.service.js";
import type { TimeRangeFilter } from "../ai/vector.service.js";
import { insertActivity } from "./activity.service.js";
import {
  InvestigationConflictError,
  InvestigationNotFoundError,
} from "./errors.js";
import {
  buildEvidenceQueries,
  buildExcerpt,
  dedupeCandidates,
  gradeEvidence,
  normalizeEvidenceId,
  selectEvidence,
  settleEvidenceSearches,
  validateManualEvidenceInput,
} from "./evidencePolicy.js";
import type {
  RetrievalEvidenceCandidate,
  SelectedEvidence,
} from "./evidencePolicy.js";
import { normalizeInvestigationId } from "./policy.js";
import type { InvestigationSourceType } from "./policy.js";
import {
  resolveEvidenceSource,
  resolveEvidenceSources,
} from "./sourceResolver.service.js";
import type {
  EvidenceCollectionSummary,
  EvidenceMatchType,
  EvidenceOrigin,
  EvidenceRelevance,
  InvestigationEvidenceItem,
} from "./types.js";

/**
 * Evidence collection reuses the Phase 2 retrieval pipeline. It adds only what
 * an investigation needs: deterministic query derivation, org-scoped source
 * resolution, relevance grading, one row per source, a bounded budget and an
 * idempotent write.
 */

type InvestigationScopeRow = {
  id: string;
  status: string;
  description: string;
  error_signature: string | null;
  service: string | null;
  source_types: string[] | null;
  window_start: Date | string | null;
  window_end: Date | string | null;
};

type EvidenceRow = {
  id: string;
  investigation_id: string;
  source_type: string;
  source_id: string;
  chunk_index: number;
  source_title: string;
  excerpt: string;
  source_created_at: Date | string | null;
  source_metadata: Record<string, unknown> | null;
  match_type: string;
  retrieval_score: string | number;
  similarity: string | number | null;
  relevance: string;
  inclusion_reason: string;
  retrieval_query: string;
  origin: string;
  added_by: string | null;
  created_at: Date | string;
};

/** One row to write, already resolved and graded. */
type EvidenceInsert = {
  sourceType: InvestigationSourceType;
  sourceId: string;
  chunkIndex: number;
  sourceTitle: string;
  excerpt: string;
  sourceCreatedAt: string | null;
  sourceMetadata: Record<string, unknown> | null;
  matchType: EvidenceMatchType;
  retrievalScore: number;
  similarity: number | null;
  relevance: EvidenceRelevance;
  inclusionReason: string;
  retrievalQuery: string;
  origin: EvidenceOrigin;
};

const COLLECTION_TOP_K = 8;

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEvidence(row: EvidenceRow): InvestigationEvidenceItem {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    sourceType: row.source_type as InvestigationSourceType,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    sourceTitle: row.source_title,
    excerpt: row.excerpt,
    sourceCreatedAt: toIso(row.source_created_at),
    sourceMetadata: row.source_metadata,
    matchType: row.match_type as EvidenceMatchType,
    retrievalScore: Number(row.retrieval_score),
    similarity: row.similarity === null ? null : Number(row.similarity),
    relevance: row.relevance as EvidenceRelevance,
    inclusionReason: row.inclusion_reason,
    retrievalQuery: row.retrieval_query,
    origin: row.origin as EvidenceOrigin,
    addedBy: row.added_by,
    createdAt: toIso(row.created_at) ?? "",
  };
}

async function loadInvestigationScope(
  organizationId: string,
  investigationId: string
): Promise<InvestigationScopeRow> {
  const result = await pool.query<InvestigationScopeRow>(
    `SELECT id, status, description, error_signature, service, source_types,
            window_start, window_end
     FROM investigations
     WHERE id = $1 AND organization_id = $2`,
    [investigationId, organizationId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new InvestigationNotFoundError();
  }

  return row;
}

function buildTimeRange(
  start: Date | string | null,
  end: Date | string | null
): TimeRangeFilter | undefined {
  const startIso = toIso(start);
  const endIso = toIso(end);

  if (startIso === null && endIso === null) {
    return undefined;
  }

  const range: TimeRangeFilter = {};
  if (startIso !== null) {
    range.start = startIso;
  }
  if (endIso !== null) {
    range.end = endIso;
  }

  return range;
}

function buildInsertPlaceholders(
  records: EvidenceInsert[],
  organizationId: string,
  investigationId: string,
  userId: string
): { placeholders: string[]; values: unknown[] } {
  const values: unknown[] = [];
  const placeholders: string[] = [];

  records.forEach((record, index) => {
    const base = index * 17;
    values.push(
      investigationId,
      organizationId,
      record.sourceType,
      record.sourceId,
      record.chunkIndex,
      record.sourceTitle,
      record.excerpt,
      record.sourceCreatedAt,
      record.sourceMetadata === null ? null : JSON.stringify(record.sourceMetadata),
      record.matchType,
      record.retrievalScore,
      record.similarity,
      record.relevance,
      record.inclusionReason,
      record.retrievalQuery,
      record.origin,
      userId
    );

    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10}, ` +
        `$${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, ` +
        `$${base + 16}, $${base + 17})`
    );
  });

  return { placeholders, values };
}

/**
 * Insert evidence rows. The unique key is (investigation, source type, source
 * id), so a refresh never rewrites an existing row and never duplicates a
 * source. Returns how many rows were actually new.
 */
async function insertEvidenceRows(
  client: PoolClient,
  organizationId: string,
  investigationId: string,
  userId: string,
  records: EvidenceInsert[]
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  const { placeholders, values } = buildInsertPlaceholders(
    records,
    organizationId,
    investigationId,
    userId
  );

  const result = await client.query(
    `INSERT INTO investigation_evidence (
       investigation_id, organization_id, source_type, source_id, chunk_index,
       source_title, excerpt, source_created_at, source_metadata, match_type,
       retrieval_score, similarity, relevance, inclusion_reason,
       retrieval_query, origin, added_by
     )
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (investigation_id, source_type, source_id) DO NOTHING
     RETURNING id`,
    values
  );

  return result.rowCount ?? 0;
}

function fromSelection(item: SelectedEvidence): EvidenceInsert {
  return {
    sourceType: item.candidate.sourceType,
    sourceId: item.candidate.sourceId,
    chunkIndex: item.candidate.chunkIndex,
    sourceTitle: item.source.sourceTitle,
    excerpt: buildExcerpt(item.candidate.content || item.source.excerpt),
    sourceCreatedAt: item.source.sourceCreatedAt,
    sourceMetadata: item.source.metadata,
    matchType: item.candidate.matchType,
    retrievalScore: item.candidate.score,
    similarity: item.candidate.similarity,
    relevance: item.relevance,
    inclusionReason: item.inclusionReason,
    retrievalQuery: item.candidate.retrievalQuery,
    origin: "retrieval",
  };
}

export async function collectInvestigationEvidence(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
}): Promise<{ investigationId: string; summary: EvidenceCollectionSummary }> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const scope = await loadInvestigationScope(
    input.organizationId,
    investigationId
  );

  if (scope.status === "closed") {
    throw new InvestigationConflictError(
      "A closed investigation can only be reopened"
    );
  }

  const plans = buildEvidenceQueries({
    description: scope.description,
    errorSignature: scope.error_signature,
    service: scope.service,
  });

  const sourceTypes =
    scope.source_types && scope.source_types.length > 0
      ? (scope.source_types as InvestigationSourceType[])
      : undefined;
  const timeRange = buildTimeRange(scope.window_start, scope.window_end);
  const warnings: string[] = [];
  const candidates: RetrievalEvidenceCandidate[] = [];

  // The derived searches are independent, so they run together: a collection
  // costs about one search of wall-clock time instead of three. A single failed
  // query keeps the evidence the other queries found and is reported as a
  // warning; only a total failure surfaces the retrieval error.
  const { results, failures } = await settleEvidenceSearches(plans, (plan) =>
    retrieveRelevantChunks({
      organizationId: input.organizationId,
      query: plan.query,
      topK: COLLECTION_TOP_K,
      mode: "hybrid",
      ...(sourceTypes ? { sourceTypes } : {}),
      ...(timeRange ? { timeRange } : {}),
    }).then((result) => result.chunks)
  );

  for (const failure of failures) {
    warnings.push(
      `Search for the ${failure.plan.label.replace("_", " ")} query failed.`
    );
    logger.warn("investigation.evidence_retrieval_failed", {
      organizationId: input.organizationId,
      investigationId,
      label: failure.plan.label,
      error: failure.error,
    });
  }

  for (const { plan, chunks } of results) {
    for (const chunk of chunks) {
      candidates.push({
        sourceType: chunk.sourceType,
        sourceId: chunk.sourceId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        sourceCreatedAt: chunk.sourceCreatedAt,
        matchType: chunk.matchType,
        score: chunk.score,
        similarity: chunk.similarity,
        retrievalQuery: plan.query,
      });
    }
  }

  const deduped = dedupeCandidates(candidates);
  const sources = await resolveEvidenceSources(
    input.organizationId,
    deduped.map((candidate) => ({
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
    }))
  );

  const { selected, unresolved } = selectEvidence({
    candidates: deduped,
    sources,
    investigation: {
      service: scope.service,
      errorSignature: scope.error_signature,
    },
  });

  if (unresolved > 0) {
    warnings.push(
      `${unresolved} retrieved source(s) no longer exist and were skipped.`
    );
  }

  if (deduped.length === 0) {
    warnings.push(
      "No indexed source matched the investigation's search terms."
    );
  }

  const records = selected.map(fromSelection);
  const { added, existing } = await persistCollectedEvidence({
    organizationId: input.organizationId,
    investigationId,
    userId: input.userId,
    records,
    queries: plans.map((plan) => plan.query),
    warnings,
    unresolved,
  });

  logger.info("investigation.evidence_collected", {
    organizationId: input.organizationId,
    investigationId,
    queries: plans.length,
    candidates: candidates.length,
    deduped: deduped.length,
    selected: selected.length,
    added,
    existing,
    unresolved,
    warnings: warnings.length,
  });

  return {
    investigationId,
    summary: {
      failed: false,
      queries: plans.map((plan) => plan.query),
      added,
      existing,
      filteredOut: unresolved,
      warnings,
    },
  };
}

async function persistCollectedEvidence(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  records: EvidenceInsert[];
  queries: string[];
  warnings: string[];
  unresolved: number;
}): Promise<{ added: number; existing: number }> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Re-check under a lock: collection does slow retrieval work first, and the
    // investigation may have been closed in the meantime.
    const state = await client.query<{ status: string }>(
      `SELECT status FROM investigations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [input.investigationId, input.organizationId]
    );

    const row = state.rows[0];
    if (!row) {
      throw new InvestigationNotFoundError();
    }
    if (row.status === "closed") {
      throw new InvestigationConflictError(
        "A closed investigation can only be reopened"
      );
    }

    const added = await insertEvidenceRows(
      client,
      input.organizationId,
      input.investigationId,
      input.userId,
      input.records
    );
    const existing = input.records.length - added;

    if (added > 0) {
      await insertActivity(client, {
        investigationId: input.investigationId,
        organizationId: input.organizationId,
        type: "evidence_added",
        actorUserId: input.userId,
        body: `Collected ${added} evidence item${added === 1 ? "" : "s"} from ${
          input.queries.length
        } search ${input.queries.length === 1 ? "query" : "queries"}`,
        metadata: {
          added,
          existing,
          filteredOut: input.unresolved,
          queries: input.queries,
          warnings: input.warnings,
        },
      });
    }

    // The first successful collection moves an open investigation into
    // 'investigating'. It never resolves anything on the engineer's behalf.
    const autoStarted =
      added > 0
        ? await client.query(
            `UPDATE investigations
             SET status = 'investigating', updated_at = NOW()
             WHERE id = $1 AND organization_id = $2 AND status = 'open'
             RETURNING id`,
            [input.investigationId, input.organizationId]
          )
        : { rowCount: 0 };

    if (autoStarted.rowCount && autoStarted.rowCount > 0) {
      await insertActivity(client, {
        investigationId: input.investigationId,
        organizationId: input.organizationId,
        type: "status_change",
        actorUserId: input.userId,
        body: "Status changed from open to investigating",
        metadata: { from: "open", to: "investigating", automatic: true },
      });
    } else {
      await client.query(
        `UPDATE investigations SET updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [input.investigationId, input.organizationId]
      );
    }

    await client.query("COMMIT");

    return { added, existing };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function linkInvestigationEvidence(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  payload: unknown;
}): Promise<{ investigationId: string; added: boolean }> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const parsed = validateManualEvidenceInput(input.payload);
  const scope = await loadInvestigationScope(
    input.organizationId,
    investigationId
  );

  if (scope.status === "closed") {
    throw new InvestigationConflictError(
      "A closed investigation can only be reopened"
    );
  }

  // The source must exist in this organization before it can be cited.
  const source = await resolveEvidenceSource(input.organizationId, {
    sourceType: parsed.sourceType,
    sourceId: parsed.sourceId,
  });

  if (!source) {
    throw new InvestigationNotFoundError("Source not found");
  }

  const candidate: RetrievalEvidenceCandidate = {
    sourceType: parsed.sourceType,
    sourceId: parsed.sourceId,
    chunkIndex: 0,
    content: source.excerpt,
    sourceCreatedAt: source.sourceCreatedAt,
    matchType: "manual",
    score: 0,
    similarity: null,
    retrievalQuery: "manual link",
  };

  const grading = gradeEvidence({
    candidate,
    source,
    investigation: {
      service: scope.service,
      errorSignature: scope.error_signature,
    },
  });

  const record: EvidenceInsert = {
    sourceType: parsed.sourceType,
    sourceId: parsed.sourceId,
    chunkIndex: 0,
    sourceTitle: source.sourceTitle,
    excerpt: buildExcerpt(source.excerpt),
    sourceCreatedAt: source.sourceCreatedAt,
    sourceMetadata: source.metadata,
    matchType: "manual",
    retrievalScore: 0,
    similarity: null,
    relevance: grading.relevance,
    inclusionReason:
      parsed.reason === null
        ? "Linked manually by the engineer."
        : `Linked manually: ${parsed.reason}`,
    retrievalQuery: "manual link",
    origin: "manual",
  };

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const state = await client.query<{ status: string }>(
      `SELECT status FROM investigations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [investigationId, input.organizationId]
    );

    const row = state.rows[0];
    if (!row) {
      throw new InvestigationNotFoundError();
    }
    if (row.status === "closed") {
      throw new InvestigationConflictError(
        "A closed investigation can only be reopened"
      );
    }

    const added = await insertEvidenceRows(
      client,
      input.organizationId,
      investigationId,
      input.userId,
      [record]
    );

    if (added > 0) {
      await insertActivity(client, {
        investigationId,
        organizationId: input.organizationId,
        type: "evidence_added",
        actorUserId: input.userId,
        body: `Linked a ${parsed.sourceType} as evidence manually`,
        metadata: {
          sourceType: parsed.sourceType,
          sourceId: parsed.sourceId,
          reason: parsed.reason,
        },
      });
    }

    await client.query(
      `UPDATE investigations SET updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [investigationId, input.organizationId]
    );

    await client.query("COMMIT");

    return { investigationId, added: added > 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function unlinkInvestigationEvidence(input: {
  organizationId: string;
  investigationId: string;
  evidenceId: string;
  userId: string;
}): Promise<void> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const evidenceId = normalizeEvidenceId(input.evidenceId);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const state = await client.query<{ status: string }>(
      `SELECT status FROM investigations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [investigationId, input.organizationId]
    );

    const row = state.rows[0];
    if (!row) {
      throw new InvestigationNotFoundError();
    }
    if (row.status === "closed") {
      throw new InvestigationConflictError(
        "A closed investigation can only be reopened"
      );
    }

    const deleted = await client.query<{
      source_type: string;
      source_id: string;
    }>(
      `DELETE FROM investigation_evidence
       WHERE id = $1 AND investigation_id = $2 AND organization_id = $3
       RETURNING source_type, source_id`,
      [evidenceId, investigationId, input.organizationId]
    );

    const removed = deleted.rows[0];
    if (!removed) {
      throw new InvestigationNotFoundError("Evidence not found");
    }

    await insertActivity(client, {
      investigationId,
      organizationId: input.organizationId,
      type: "evidence_removed",
      actorUserId: input.userId,
      body: `Unlinked a ${removed.source_type} from the evidence set`,
      metadata: {
        sourceType: removed.source_type,
        sourceId: removed.source_id,
      },
    });

    await client.query(
      `UPDATE investigations SET updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [investigationId, input.organizationId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listEvidenceForInvestigation(
  organizationId: string,
  investigationId: string
): Promise<InvestigationEvidenceItem[]> {
  const result = await pool.query<EvidenceRow>(
    `SELECT
       id, investigation_id, source_type, source_id, chunk_index, source_title,
       excerpt, source_created_at, source_metadata, match_type, retrieval_score,
       similarity, relevance, inclusion_reason, retrieval_query, origin,
       added_by, created_at
     FROM investigation_evidence
     WHERE investigation_id = $1 AND organization_id = $2
     ORDER BY
       CASE relevance
         WHEN 'direct' THEN 0
         WHEN 'historical' THEN 1
         WHEN 'related' THEN 2
         ELSE 3
       END,
       source_created_at DESC NULLS LAST,
       created_at DESC`,
    [investigationId, organizationId]
  );

  return result.rows.map(mapEvidence);
}
