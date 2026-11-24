import { pool } from "../../core/db.js";
import { RAGProviderError } from "../ai/rag.service.js";
import { insertActivity, listActivity } from "./activity.service.js";
import { generateJsonResponse } from "./analysis.provider.js";
import {
  getInvestigationAnalysis,
  loadInvestigation,
} from "./analysis.service.js";
import type { AnalysisEvidence } from "./analysisPolicy.js";
import { InvestigationConflictError, InvestigationValidationError } from "./errors.js";
import { listEvidenceForInvestigation } from "./evidence.service.js";
import {
  buildFollowUpPrompt,
  parseFollowUpResponse,
  FollowUpFormatError,
  validateFollowUpQuestion,
} from "./followUpPolicy.js";
import type { FollowUpAnalysisContext } from "./followUpPolicy.js";
import { normalizeInvestigationId } from "./policy.js";
import type { InvestigationSourceType } from "./policy.js";
import type {
  EvidenceRelevance,
  FollowUpAnswer,
  FollowUpCitation,
  InvestigationActivity,
} from "./types.js";

/**
 * A follow-up answer is stored as a `follow_up` activity row: the question in the
 * body, the answer and its citations in the metadata. That keeps the exchange in
 * the same ordered log as the rest of the investigation and on the timeline,
 * without a table for a single free-text field.
 */

function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function analysisContext(
  result: Awaited<ReturnType<typeof getInvestigationAnalysis>>
): FollowUpAnalysisContext | null {
  const analysis = result.analysis;
  if (!analysis || analysis.status !== "succeeded" || analysis.summary === null) {
    return null;
  }

  return {
    summary: analysis.summary,
    keyObservations: analysis.keyObservations,
    nextSteps: analysis.nextSteps,
    hypotheses: result.hypotheses.map((hypothesis) => ({
      statement: hypothesis.statement,
      rationale: hypothesis.rationale,
      status: hypothesis.status,
    })),
  };
}

function mapCitations(
  evidenceIds: string[],
  evidence: Array<{ id: string; sourceType: string; sourceTitle: string; relevance: string; sourceCreatedAt: string | null }>
): FollowUpCitation[] {
  const byId = new Map(evidence.map((item) => [item.id, item]));

  return evidenceIds.flatMap((id) => {
    const item = byId.get(id);
    if (!item) {
      return [];
    }

    return [
      {
        evidenceId: item.id,
        sourceType: item.sourceType as InvestigationSourceType,
        sourceTitle: item.sourceTitle,
        relevance: item.relevance as EvidenceRelevance,
        sourceCreatedAt: item.sourceCreatedAt,
      },
    ];
  });
}

export async function askInvestigationQuestion(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  payload: unknown;
}): Promise<FollowUpAnswer> {
  const investigationId = normalizeInvestigationId(input.investigationId);
  const question = validateFollowUpQuestion(input.payload);
  const investigation = await loadInvestigation(input.organizationId, investigationId);

  if (investigation.status === "closed") {
    throw new InvestigationConflictError(
      "A closed investigation can only be reopened"
    );
  }

  const [evidence, analysis] = await Promise.all([
    listEvidenceForInvestigation(input.organizationId, investigationId),
    getInvestigationAnalysis(input.organizationId, investigationId),
  ]);

  if (evidence.length === 0) {
    throw new InvestigationValidationError(
      "Collect evidence before asking a follow-up question"
    );
  }

  const followUp = buildFollowUpPrompt({
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
    question,
    evidence: evidence.map(
      (item): AnalysisEvidence => ({
        id: item.id,
        sourceType: item.sourceType as InvestigationSourceType,
        sourceTitle: item.sourceTitle,
        excerpt: item.excerpt,
        relevance: item.relevance,
        sourceCreatedAt: item.sourceCreatedAt,
      })
    ),
    analysis: analysisContext(analysis),
  });

  return answerQuestion({
    organizationId: input.organizationId,
    investigationId,
    userId: input.userId,
    question,
    prompt: followUp.prompt,
    analyses: analysis,
    evidence,
    evidenceIds: followUp.evidenceIds,
  });
}

async function answerQuestion(input: {
  organizationId: string;
  investigationId: string;
  userId: string;
  question: string;
  prompt: string;
  analyses: Awaited<ReturnType<typeof getInvestigationAnalysis>>;
  evidence: Array<{
    id: string;
    sourceType: string;
    sourceTitle: string;
    relevance: string;
    sourceCreatedAt: string | null;
  }>;
  evidenceIds: string[];
}): Promise<FollowUpAnswer> {
  const generated = await generateJsonResponse(input.prompt);

  let parsed: ReturnType<typeof parseFollowUpResponse>;
  try {
    parsed = parseFollowUpResponse(generated.raw, input.evidenceIds);
  } catch (error) {
    const reason =
      error instanceof FollowUpFormatError
        ? "The follow-up answer could not be validated."
        : "The follow-up answer could not be read.";

    throw new RAGProviderError(reason);
  }

  const citations = mapCitations(parsed.citations, input.evidence);
  const analysisId = input.analyses.analysis?.id ?? null;

  const client = await pool.connect();
  let activity: InvestigationActivity;

  try {
    activity = await insertActivity(client, {
      investigationId: input.investigationId,
      organizationId: input.organizationId,
      type: "follow_up",
      actorUserId: input.userId,
      body: input.question,
      metadata: {
        answer: parsed.answer,
        confidence: parsed.confidence,
        insufficientContext: parsed.insufficientContext,
        citations,
        analysisId,
        model: generated.model,
        provider: generated.provider,
        generationMs: generated.generationMs,
        droppedCitations: parsed.droppedCitations,
      },
    });
  } finally {
    client.release();
  }

  return {
    activityId: activity.id,
    question: input.question,
    answer: parsed.answer,
    confidence: parsed.confidence,
    insufficientContext: parsed.insufficientContext,
    citations,
    analysisId,
    model: generated.model,
    provider: generated.provider,
    generationMs: generated.generationMs,
    createdAt: activity.createdAt,
  };
}

function readMetadata(entry: InvestigationActivity): Record<string, unknown> {
  return entry.metadata ?? {};
}

function readConfidence(value: unknown): FollowUpAnswer["confidence"] {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "low";
}

function readCitations(value: unknown): FollowUpCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (
      typeof record.evidenceId !== "string" ||
      typeof record.sourceType !== "string" ||
      typeof record.sourceTitle !== "string"
    ) {
      return [];
    }

    return [
      {
        evidenceId: record.evidenceId,
        sourceType: record.sourceType as InvestigationSourceType,
        sourceTitle: record.sourceTitle,
        relevance: (typeof record.relevance === "string"
          ? record.relevance
          : "weak") as EvidenceRelevance,
        sourceCreatedAt:
          typeof record.sourceCreatedAt === "string"
            ? record.sourceCreatedAt
            : null,
      },
    ];
  });
}

function mapFollowUp(entry: InvestigationActivity): FollowUpAnswer | null {
  if (entry.type !== "follow_up" || entry.body === null) {
    return null;
  }

  const metadata = readMetadata(entry);
  if (typeof metadata.answer !== "string" || metadata.answer.trim() === "") {
    return null;
  }

  return {
    activityId: entry.id,
    question: entry.body,
    answer: metadata.answer,
    confidence: readConfidence(metadata.confidence),
    insufficientContext: metadata.insufficientContext === true,
    citations: readCitations(metadata.citations),
    analysisId:
      typeof metadata.analysisId === "string" ? metadata.analysisId : null,
    model: typeof metadata.model === "string" ? metadata.model : "unknown",
    provider:
      typeof metadata.provider === "string" ? metadata.provider : "unknown",
    generationMs:
      typeof metadata.generationMs === "number" ? metadata.generationMs : 0,
    createdAt: entry.createdAt,
  };
}

/** Oldest first, so the exchange reads like a conversation. */
export async function listInvestigationQuestions(
  organizationId: string,
  rawInvestigationId: string
): Promise<FollowUpAnswer[]> {
  const investigationId = normalizeInvestigationId(rawInvestigationId);
  await loadInvestigation(organizationId, investigationId);

  const activity = await listActivity(organizationId, investigationId, 200);

  return activity
    .map(mapFollowUp)
    .filter((entry): entry is FollowUpAnswer => entry !== null)
    .reverse();
}
