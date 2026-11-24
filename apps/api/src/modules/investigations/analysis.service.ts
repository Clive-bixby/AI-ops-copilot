import { pool } from "../../core/db.js";
import {
  RAGProviderConfigError,
  RAGProviderError,
  RAGProviderTimeoutError,
} from "../ai/rag.service.js";
import { insertActivity } from "./activity.service.js";
import {
  generateJsonResponse,
  getAnalysisGenerationIdentity,
} from "./analysis.provider.js";
import {
  ANALYSIS_LIMITS,
  ANALYSIS_VERSION,
  AnalysisFormatError,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  statementHash,
  validateHypothesisUpdate,
} from "./analysisPolicy.js";
import type { ParsedAnalysis } from "./analysisPolicy.js";
import {
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "./errors.js";
import { listEvidenceForInvestigation } from "./evidence.service.js";
import { normalizeInvestigationId } from "./policy.js";
import type { InvestigationSourceType } from "./policy.js";
import type {
  AnalysisHypothesis,
  AnalysisStatus,
  HypothesisStatus,
  HypothesisStatusSource,
  InvestigationAnalysis,
  InvestigationAnalysisResult,
} from "./types.js";

/**
 * A synchronous analysis run: the engineer waits for the result instead of
 * polling a job. The run is recorded before the model is called, so a crash or a
 * timeout leaves an honest failed row with a typed reason rather than a gap.
 */

const STALE_PENDING_MINUTES = 10;

export type InvestigationRow = {
  id: string;
  status: string;
  title: string;
  description: string;
  severity: string;
  service: string | null;
  error_signature: string | null;
  window_start: Date | string | null;
  window_end: Date | string | null;
};

type AnalysisRow = {
  id: string;
  investigation_id: string;
  status: string;
  failure_reason: string | null;
  analysis_version: number;
  provider: string;
  model: string;
  evidence_ids: string[];
  summary: string | null;
  key_observations: string[];
  next_steps: string[];
  insufficient_evidence: boolean;
  missing_information: string[];
  generation_ms: number | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type HypothesisRow = {
  id: string;
  investigation_id: string;
  statement: string;
  rationale: string;
  status: string;
  status_source: string;
  missing_information: string[];
  verification_steps: string[];
  analysis_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  links: Array<{ evidenceId: string; relation: string }>;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAnalysis(row: AnalysisRow): InvestigationAnalysis {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    status: row.status as AnalysisStatus,
    failureReason: row.failure_reason,
    analysisVersion: row.analysis_version,
    provider: row.provider,
    model: row.model,
    evidenceIds: row.evidence_ids,
    summary: row.summary,
    keyObservations: row.key_observations,
    nextSteps: row.next_steps,
    insufficientEvidence: row.insufficient_evidence,
    missingInformation: row.missing_information,
    generationMs: row.generation_ms,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function mapHypothesis(row: HypothesisRow): AnalysisHypothesis {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    statement: row.statement,
    rationale: row.rationale,
    status: row.status as HypothesisStatus,
    statusSource: row.status_source as HypothesisStatusSource,
    missingInformation: row.missing_information,
    verificationSteps: row.verification_steps,
    evidence: row.links.map((link) => ({
      evidenceId: link.evidenceId,
      relation: link.relation === "contradicts" ? "contradicts" : "supports",
    })),
    analysisId: row.analysis_id,
    createdAt: toIso(row.created_at) ?? "",
    updatedAt: toIso(row.updated_at) ?? "",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function loadInvestigation(
  organizationId: string,
  investigationId: string
): Promise<InvestigationRow> {
  const result = await pool.query<InvestigationRow>(
    `SELECT id, status, title, description, severity, service, error_signature,
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

function failureReason(error: unknown): string {
  if (error instanceof RAGProviderTimeoutError) {
    return "The analysis provider timed out. Try again.";
  }

  // A retry cannot fix a missing key or an unknown provider name, so "try
  // again" would send the engineer in a circle.
  if (error instanceof RAGProviderConfigError) {
    return error.message;
  }

  if (error instanceof RAGProviderError) {
    return "The analysis provider could not complete the run. Try again.";
  }

  return "The analysis run failed before it could produce a result.";
}

async function markAnalysisFailed(input: {
  organizationId: string;
  investigationId: string;
  analysisId: string;
  userId: string;
  reason: string;
}): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE investigation_analyses
       SET status = 'failed', failure_reason = $3, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [input.analysisId, input.organizationId, input.reason]
    );
    await insertActivity(client, {
      investigationId: input.investigationId,
      organizationId: input.organizationId,
      type: "analysis_failed",
      actorUserId: input.userId,
      body: "Analysis failed",
      metadata: { analysisId: input.analysisId, reason: input.reason },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadHypotheses(
  organizationId: string,
  investigationId: string
): Promise<AnalysisHypothesis[]> {
  const result = await pool.query<HypothesisRow>(
    `SELECT h.id, h.investigation_id, h.statement, h.rationale, h.status,
            h.status_source, h.missing_information, h.verification_steps,
            h.analysis_id, h.created_at, h.updated_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object('evidenceId', l.evidence_id, 'relation', l.relation)
              ) FILTER (WHERE l.evidence_id IS NOT NULL),
              '[]'::jsonb
            ) AS links
     FROM investigation_hypotheses h
     LEFT JOIN investigation_hypothesis_evidence l
       ON l.hypothesis_id = h.id
     WHERE h.investigation_id = $1 AND h.organization_id = $2
     GROUP BY h.id
     ORDER BY h.created_at ASC, h.id ASC`,
    [investigationId, organizationId]
  );

  return result.rows.map(mapHypothesis);
}

export async function getInvestigationAnalysis(
  organizationId: string,
  rawInvestigationId: string
): Promise<InvestigationAnalysisResult> {
  const investigationId = normalizeInvestigationId(rawInvestigationId);
  await loadInvestigation(organizationId, investigationId);

  const [analysis, hypotheses] = await Promise.all([
    pool.query<AnalysisRow>(
      `SELECT id, investigation_id, status, failure_reason, analysis_version,
              provider, model, evidence_ids, summary, key_observations,
              next_steps, insufficient_evidence, missing_information,
              generation_ms, created_by, created_at, updated_at
       FROM investigation_analyses
       WHERE investigation_id = $1 AND organization_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [investigationId, organizationId]
    ),
    loadHypotheses(organizationId, investigationId),
  ]);

  const row = analysis.rows[0];

  return {
    analysis: row ? mapAnalysis(row) : null,
    hypotheses,
  };
}

async function persistSuccess(input: {
  organizationId: string;
  investigationId: string;
  analysisId: string;
  userId: string;
  evidenceIds: string[];
  parsed: ParsedAnalysis;
  provider: string;
  model: string;
  generationMs: number;
  droppedCitations: number;
}): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE investigation_analyses
       SET status = 'succeeded',
           summary = $3,
           key_observations = $4::jsonb,
           next_steps = $5::jsonb,
           insufficient_evidence = $6,
           missing_information = $7::text[],
           evidence_ids = $8::uuid[],
           generation_ms = $9,
           provider = $10,
           model = $11,
           updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [
        input.analysisId,
        input.organizationId,
        input.parsed.summary,
        JSON.stringify(input.parsed.keyObservations),
        JSON.stringify(input.parsed.nextSteps),
        input.parsed.insufficientEvidence,
        input.parsed.missingInformation,
        input.evidenceIds,
        input.generationMs,
        input.provider,
        input.model,
      ]
    );

    for (const hypothesis of input.parsed.hypotheses) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO investigation_hypotheses (
           investigation_id, organization_id, statement, rationale, status,
           status_source, missing_information, verification_steps,
           statement_hash, analysis_id, created_by
         )
         VALUES ($1, $2, $3, $4, 'unverified', 'model', $5::text[], $6::text[], $7, $8, $9)
         ON CONFLICT (investigation_id, statement_hash) DO UPDATE SET
           rationale = EXCLUDED.rationale,
           missing_information = EXCLUDED.missing_information,
           verification_steps = EXCLUDED.verification_steps,
           analysis_id = EXCLUDED.analysis_id,
           updated_at = NOW()
         RETURNING id`,
        [
          input.investigationId,
          input.organizationId,
          hypothesis.statement,
          hypothesis.rationale,
          hypothesis.missingInformation,
          hypothesis.verificationSteps,
          statementHash(hypothesis.statement),
          input.analysisId,
          input.userId,
        ]
      );

      const hypothesisId = inserted.rows[0]?.id;
      if (!hypothesisId) {
        throw new Error("Failed to store an analysis hypothesis");
      }

      // Links are replaced on refresh so a hypothesis cannot accumulate stale
      // citations from an earlier run.
      await client.query(
        `DELETE FROM investigation_hypothesis_evidence
         WHERE hypothesis_id = $1 AND investigation_id = $2`,
        [hypothesisId, input.investigationId]
      );

      for (const [relation, ids] of [
        ["supports", hypothesis.supports],
        ["contradicts", hypothesis.contradicts],
      ] as const) {
        for (const evidenceId of ids) {
          await client.query(
            `INSERT INTO investigation_hypothesis_evidence (
               hypothesis_id, evidence_id, investigation_id, organization_id, relation
             )
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [
              hypothesisId,
              evidenceId,
              input.investigationId,
              input.organizationId,
              relation,
            ]
          );
        }
      }
    }

    await insertActivity(client, {
      investigationId: input.investigationId,
      organizationId: input.organizationId,
      type: "analysis_succeeded",
      actorUserId: input.userId,
      body: `Analysis produced ${input.parsed.hypotheses.length} hypothesis${
        input.parsed.hypotheses.length === 1 ? "" : "es"
      } from ${input.evidenceIds.length} evidence item${
        input.evidenceIds.length === 1 ? "" : "s"
      }`,
      metadata: {
        analysisId: input.analysisId,
        model: input.model,
        provider: input.provider,
        analysisVersion: ANALYSIS_VERSION,
        evidenceCount: input.evidenceIds.length,
        hypothesisCount: input.parsed.hypotheses.length,
        droppedCitations: input.droppedCitations,
        generationMs: input.generationMs,
      },
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function analyzeInvestigation(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
}): Promise<InvestigationAnalysisResult> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const investigation = await loadInvestigation(input.organizationId, investigationId);

  if (investigation.status === "closed") {
    throw new InvestigationConflictError(
      "A closed investigation can only be reopened"
    );
  }

  const evidence = await listEvidenceForInvestigation(
    input.organizationId,
    investigationId
  );

  if (evidence.length === 0) {
    throw new InvestigationValidationError(
      "Collect evidence before running an analysis"
    );
  }

  // A run that died without writing its result must not block this one forever.
  await pool.query(
    `UPDATE investigation_analyses
     SET status = 'failed',
         failure_reason = 'The previous analysis run was abandoned.',
         updated_at = NOW()
     WHERE investigation_id = $1 AND organization_id = $2 AND status = 'pending'
       AND created_at < NOW() - ($3::int * INTERVAL '1 minute')`,
    [investigationId, input.organizationId, STALE_PENDING_MINUTES]
  );

  // Recorded before the call so an abandoned run still names what it attempted;
  // updated with the answering provider once the result is persisted. Reading the
  // configuration is itself fallible -- an unknown provider name is reported as a
  // 502 here rather than escaping as an unhandled 500.
  const { provider, model } = getAnalysisGenerationIdentity();
  const prompt = buildAnalysisPrompt({
    investigation: {
      id: investigation.id,
      title: investigation.title,
      description: investigation.description,
      severity: investigation.severity,
      service: investigation.service,
      errorSignature: investigation.error_signature,
      windowStart: toIso(investigation.window_start),
      windowEnd: toIso(investigation.window_end),
    },
    evidence: evidence.map((item) => ({
      id: item.id,
      sourceType: item.sourceType as InvestigationSourceType,
      sourceTitle: item.sourceTitle,
      excerpt: item.excerpt,
      relevance: item.relevance,
      sourceCreatedAt: item.sourceCreatedAt,
    })),
  });

  const startClient = await pool.connect();
  let analysisId: string;

  try {
    await startClient.query("BEGIN");
    const inserted = await startClient.query<{ id: string }>(
      `INSERT INTO investigation_analyses (
         investigation_id, organization_id, status, analysis_version, provider,
         model, evidence_ids, search_params, created_by
       )
       VALUES ($1, $2, 'pending', $3, $4, $5, $6::uuid[], $7::jsonb, $8)
       RETURNING id`,
      [
        investigationId,
        input.organizationId,
        ANALYSIS_VERSION,
        provider,
        model,
        prompt.evidenceIds,
        JSON.stringify({
          analysisVersion: ANALYSIS_VERSION,
          evidenceCount: prompt.evidenceIds.length,
          maxEvidence: ANALYSIS_LIMITS.maxEvidence,
        }),
        input.userId,
      ]
    );
    analysisId = inserted.rows[0]!.id;

    await insertActivity(startClient, {
      investigationId,
      organizationId: input.organizationId,
      type: "analysis_started",
      actorUserId: input.userId,
      body: "Analysis started",
      metadata: { analysisId, model, evidenceCount: prompt.evidenceIds.length },
    });

    await startClient.query("COMMIT");
  } catch (error) {
    await startClient.query("ROLLBACK").catch(() => undefined);

    if (isUniqueViolation(error)) {
      throw new InvestigationConflictError(
        "An analysis is already running for this investigation"
      );
    }

    throw error;
  } finally {
    startClient.release();
  }

  let generated: {
    raw: string;
    provider: string;
    model: string;
    generationMs: number;
  };

  try {
    generated = await generateJsonResponse(prompt.prompt);
  } catch (error) {
    await markAnalysisFailed({
      organizationId: input.organizationId,
      investigationId,
      analysisId,
      userId: input.userId,
      reason: failureReason(error),
    });
    throw error;
  }

  let parsed: ReturnType<typeof parseAnalysisResponse>;

  try {
    parsed = parseAnalysisResponse(generated.raw, prompt.evidenceIds);
  } catch (error) {
    const reason =
      error instanceof AnalysisFormatError
        ? "The analysis response could not be validated."
        : "The analysis response could not be read.";

    await markAnalysisFailed({
      organizationId: input.organizationId,
      investigationId,
      analysisId,
      userId: input.userId,
      reason,
    });

    throw new RAGProviderError(reason);
  }

  try {
    await persistSuccess({
      organizationId: input.organizationId,
      investigationId,
      analysisId,
      userId: input.userId,
      evidenceIds: prompt.evidenceIds,
      parsed: parsed.analysis,
      provider: generated.provider,
      model: generated.model,
      generationMs: generated.generationMs,
      droppedCitations: parsed.droppedCitations,
    });
  } catch (error) {
    await markAnalysisFailed({
      organizationId: input.organizationId,
      investigationId,
      analysisId,
      userId: input.userId,
      reason: "The analysis result could not be saved.",
    });
    throw error;
  }

  return getInvestigationAnalysis(input.organizationId, investigationId);
}

function normalizeHypothesisId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.trim()
    )
  ) {
    throw new InvestigationNotFoundError("Hypothesis not found");
  }

  return value.trim();
}

export async function updateHypothesisStatus(input: {
  organizationId: string;
  investigationId: string;
  hypothesisId: string;
  userId: string;
  payload: unknown;
}): Promise<AnalysisHypothesis> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const hypothesisId = normalizeHypothesisId(input.hypothesisId);
  const parsed = validateHypothesisUpdate(input.payload);

  const investigation = await loadInvestigation(input.organizationId, investigationId);
  if (investigation.status === "closed") {
    throw new InvestigationConflictError(
      "A closed investigation can only be reopened"
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const current = await client.query<{ status: string }>(
      `SELECT status FROM investigation_hypotheses
       WHERE id = $1 AND investigation_id = $2 AND organization_id = $3
       FOR UPDATE`,
      [hypothesisId, investigationId, input.organizationId]
    );

    const row = current.rows[0];
    if (!row) {
      throw new InvestigationNotFoundError("Hypothesis not found");
    }

    await client.query(
      `UPDATE investigation_hypotheses
       SET status = $3, status_source = 'user', updated_by = $4, updated_at = NOW()
       WHERE id = $1 AND investigation_id = $2`,
      [hypothesisId, investigationId, parsed.status, input.userId]
    );

    await insertActivity(client, {
      investigationId,
      organizationId: input.organizationId,
      type: "hypothesis_status",
      actorUserId: input.userId,
      body: `Hypothesis marked ${parsed.status}`,
      metadata: { hypothesisId, from: row.status, to: parsed.status },
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

  const hypotheses = await loadHypotheses(input.organizationId, investigationId);
  const updated = hypotheses.find((item) => item.id === hypothesisId);

  if (!updated) {
    throw new InvestigationNotFoundError("Hypothesis not found");
  }

  return updated;
}
