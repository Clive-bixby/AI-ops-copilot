import {
  ANALYSIS_LIMITS,
  resolveEvidenceCitations,
} from "./analysisPolicy.js";
import type {
  AnalysisEvidence,
  AnalysisInvestigation,
} from "./analysisPolicy.js";

/**
 * Follow-up questions are answered from the investigation's own evidence and
 * analysis, never from general knowledge. The prompt numbers the evidence exactly
 * as the analysis does, so an answer can cite `E2` and the API can map that back
 * to a stored evidence id.
 */

export const FOLLOW_UP_LIMITS = {
  questionMin: 5,
  questionMax: 500,
  answerMax: 2000,
  citations: 8,
  responseChars: 20_000,
  evidence: ANALYSIS_LIMITS.maxEvidence,
  excerptChars: ANALYSIS_LIMITS.excerptChars,
} as const;

export const FOLLOW_UP_CONFIDENCE = ["high", "medium", "low"] as const;
export type FollowUpConfidence = (typeof FOLLOW_UP_CONFIDENCE)[number];

export class FollowUpFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowUpFormatError";
  }
}

export type FollowUpAnalysisContext = {
  summary: string | null;
  keyObservations: string[];
  nextSteps: string[];
  hypotheses: Array<{ statement: string; rationale: string; status: string }>;
};

export type ParsedFollowUp = {
  answer: string;
  confidence: FollowUpConfidence;
  insufficientContext: boolean;
  citations: string[];
  droppedCitations: number;
};

export function validateFollowUpQuestion(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new FollowUpFormatError("Request body must be an object");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.question !== "string") {
    throw new FollowUpFormatError("question must be a string");
  }

  const question = record.question.replace(/\s+/g, " ").trim();
  if (
    question.length < FOLLOW_UP_LIMITS.questionMin ||
    question.length > FOLLOW_UP_LIMITS.questionMax
  ) {
    throw new FollowUpFormatError(
      `question must be between ${FOLLOW_UP_LIMITS.questionMin} and ${FOLLOW_UP_LIMITS.questionMax} characters`
    );
  }

  return question;
}

function clampText(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function buildFollowUpPrompt(input: {
  investigation: AnalysisInvestigation;
  question: string;
  evidence: AnalysisEvidence[];
  analysis: FollowUpAnalysisContext | null;
}): { prompt: string; evidenceIds: string[] } {
  const evidence = input.evidence.slice(0, FOLLOW_UP_LIMITS.evidence);
  const evidenceIds = evidence.map((item) => item.id);

  const evidenceBlock = evidence
    .map((item, index) => {
      const created = item.sourceCreatedAt ?? "unknown";
      return [
        `[E${index + 1}] type=${item.sourceType} relevance=${item.relevance} time=${created}`,
        `title: ${clampText(item.sourceTitle, 300)}`,
        `excerpt: ${clampText(item.excerpt, FOLLOW_UP_LIMITS.excerptChars)}`,
      ].join("\n");
    })
    .join("\n\n");

  const analysisBlock =
    input.analysis === null
      ? "(no analysis has been run for this investigation)"
      : [
          `summary: ${input.analysis.summary ?? "none"}`,
          `key observations: ${input.analysis.keyObservations.join(" | ") || "none"}`,
          `next steps: ${input.analysis.nextSteps.join(" | ") || "none"}`,
          "hypotheses:",
          ...input.analysis.hypotheses.map(
            (item, index) =>
              `${index + 1}. [${item.status}] ${item.statement} — ${item.rationale}`
          ),
        ].join("\n");

  const prompt = [
    "You are answering a follow-up question about an incident investigation.",
    "Use only the investigation facts, evidence and analysis below. Never invent facts,",
    "sources, metrics or timestamps.",
    "",
    "Decide first whether that material can answer the question. Material answers it only when it contains the",
    "fact asked for, or a timestamp, system or error that settles it. If it does not, set insufficient_context",
    "to true and say plainly that the material does not cover the question. Do not substitute a plausible",
    "explanation from general knowledge, and do not answer as if the evidence had said more than it did.",
    "",
    "Investigation",
    `title: ${input.investigation.title}`,
    `description: ${input.investigation.description}`,
    `severity: ${input.investigation.severity}`,
    `service: ${input.investigation.service ?? "not specified"}`,
    `error signature: ${input.investigation.errorSignature ?? "not specified"}`,
    "",
    "Analysis",
    analysisBlock,
    "",
    "Evidence",
    evidenceBlock.length > 0 ? evidenceBlock : "(no evidence was collected)",
    "",
    "Question",
    input.question,
    "",
    "Rules",
    `- Cite evidence only by the bracket labels above (${evidence
      .map((_, index) => `E${index + 1}`)
      .join(", ") || "none available"}).`,
    "- An answer may cite no evidence when the question is about the investigation itself.",
    "- When insufficient_context is true, the answer must not offer a cause, a value or a sequence of events.",
    `- Keep the answer under ${FOLLOW_UP_LIMITS.answerMax} characters.`,
    "- Reply with JSON only, no prose and no markdown fences.",
    "",
    "JSON schema",
    JSON.stringify(
      {
        answer: "string",
        confidence: "high | medium | low",
        insufficient_context: false,
        citations: ["E1"],
      },
      null,
      2
    ),
  ].join("\n");

  return { prompt, evidenceIds };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

export function parseFollowUpResponse(
  raw: string,
  evidenceIds: string[]
): ParsedFollowUp {
  if (raw.length > FOLLOW_UP_LIMITS.responseChars) {
    throw new FollowUpFormatError("The answer was too long to accept");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new FollowUpFormatError("The answer was not valid JSON");
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new FollowUpFormatError("The answer was not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.answer !== "string" || record.answer.trim() === "") {
    throw new FollowUpFormatError("The answer did not include any text");
  }

  const confidence =
    typeof record.confidence === "string" &&
    (FOLLOW_UP_CONFIDENCE as readonly string[]).includes(record.confidence)
      ? (record.confidence as FollowUpConfidence)
      : "low";

  const citations = resolveEvidenceCitations(
    record.citations,
    evidenceIds,
    FOLLOW_UP_LIMITS.citations
  );

  return {
    answer: clampText(record.answer, FOLLOW_UP_LIMITS.answerMax),
    confidence,
    insufficientContext: record.insufficient_context === true,
    citations: citations.ids,
    droppedCitations: citations.dropped,
  };
}
