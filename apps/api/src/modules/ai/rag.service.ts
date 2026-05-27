import axios, { AxiosError } from "axios";

import { estimateTokens } from "./chunk.service.js";
import { searchRelevantChunks } from "./retrieval.service.js";

const DEFAULT_RAG_TOP_K = 5;
const MAX_RAG_TOP_K = 10;
const DEFAULT_MAX_CONTEXT_TOKENS = 2200;
const DEFAULT_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_MIN_SIMILARITY = 0.7;
const MIN_QUESTION_LENGTH = 3;
const MAX_QUESTION_LENGTH = 500;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_BASE_URL =
  process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com";

export type RAGSource = {
  documentId: string;
  chunkIndex: number;
  similarity: number;
};

export type RAGAnswerMetadata = {
  model: string;
  retrievedChunks: number;
  usedChunks: number;
  llmResponseTimeMs: number;
  executionTimeMs: number;
};

export type RAGAnswerResponse = {
  answer: string;
  sources: RAGSource[];
  metadata: RAGAnswerMetadata;
};

export type RAGRequest = {
  organizationId: string;
  query: string;
};

export type RAGResponse = RAGAnswerResponse;

type RetrievedChunk = {
  content: string;
  similarity: number;
  documentId: string;
  chunkIndex: number;
};

type PromptContextChunk = RetrievedChunk & {
  sourceNumber: number;
  promptContent: string;
};

type GeminiGenerateContentResponse = {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
      }[];
    };
    finishReason?: string;
  }[];
};

type GeminiErrorResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export class RAGValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RAGValidationError";
  }
}

export class RAGProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RAGProviderError";
  }
}

function getNumberEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid ${name}; using default`, {
      value: rawValue,
      defaultValue,
    });

    return defaultValue;
  }

  return parsed;
}

function getRAGTopK(): number {
  const configured = getNumberEnv("RAG_TOP_K", DEFAULT_RAG_TOP_K);
  return Math.min(Math.max(1, Math.floor(configured)), MAX_RAG_TOP_K);
}

function getSimilarityEnv(name: string): number | undefined {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(`Invalid ${name}; ignoring value`, { value: rawValue });
    return undefined;
  }

  return parsed;
}

function getRAGMinSimilarity(): number {
  return (
    getSimilarityEnv("RAG_MIN_SIMILARITY") ??
    getSimilarityEnv("AI_SEARCH_MIN_SIMILARITY") ??
    DEFAULT_MIN_SIMILARITY
  );
}

function getGeminiModel(): string {
  return (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new RAGProviderError("GEMINI_API_KEY is required for RAG answers");
  }

  return apiKey.trim();
}

export function validateRAGQuestion(question: unknown): string {
  if (typeof question !== "string") {
    throw new RAGValidationError("Question must be a string");
  }

  const trimmed = question.trim();
  if (trimmed.length < MIN_QUESTION_LENGTH) {
    throw new RAGValidationError(
      `Question must be at least ${MIN_QUESTION_LENGTH} characters long`
    );
  }

  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new RAGValidationError(
      `Question must be no more than ${MAX_QUESTION_LENGTH} characters long`
    );
  }

  return trimmed;
}

function validateOrganizationId(organizationId: unknown): string {
  if (typeof organizationId !== "string" || organizationId.trim().length === 0) {
    throw new RAGValidationError("Organization ID is required");
  }

  return organizationId.trim();
}

function toSource(chunk: RetrievedChunk): RAGSource {
  return {
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    similarity: chunk.similarity,
  };
}

function truncateToTokenBudget(content: string, maxTokens: number): string {
  if (maxTokens <= 0 || estimateTokens(content) <= maxTokens) {
    return content;
  }

  const words = content.split(/\s+/).filter((word) => word.length > 0);
  const maxWords = Math.max(1, Math.floor(maxTokens * 0.75));

  return `${words.slice(0, maxWords).join(" ")} ... [truncated]`;
}

function formatContextBlock(chunk: PromptContextChunk): string {
  return [
    `[Source ${chunk.sourceNumber}]`,
    `documentId: ${chunk.documentId}`,
    `chunkIndex: ${chunk.chunkIndex}`,
    `similarity: ${chunk.similarity.toFixed(3)}`,
    "content:",
    chunk.promptContent,
  ].join("\n");
}

function buildContextChunks(chunks: RetrievedChunk[]): PromptContextChunk[] {
  const maxContextTokens = Math.floor(
    getNumberEnv("RAG_MAX_CONTEXT_TOKENS", DEFAULT_MAX_CONTEXT_TOKENS)
  );
  const contextChunks: PromptContextChunk[] = [];
  let usedTokens = 0;

  for (const chunk of chunks) {
    const sourceNumber = contextChunks.length + 1;
    const fullCandidate: PromptContextChunk = {
      ...chunk,
      sourceNumber,
      promptContent: chunk.content,
    };
    const fullBlock = formatContextBlock(fullCandidate);
    const fullBlockTokens = estimateTokens(fullBlock);

    if (usedTokens + fullBlockTokens <= maxContextTokens) {
      contextChunks.push(fullCandidate);
      usedTokens += fullBlockTokens;
      continue;
    }

    const remainingTokens = maxContextTokens - usedTokens;
    const blockOverheadTokens =
      fullBlockTokens - estimateTokens(fullCandidate.promptContent);

    if (remainingTokens > blockOverheadTokens + 20) {
      const truncatedCandidate: PromptContextChunk = {
        ...fullCandidate,
        promptContent: truncateToTokenBudget(
          fullCandidate.promptContent,
          remainingTokens - blockOverheadTokens
        ),
      };

      contextChunks.push(truncatedCandidate);
    }

    break;
  }

  return contextChunks;
}

function buildGroundedPrompt(question: string, contextChunks: PromptContextChunk[]): string {
  const context = contextChunks.map(formatContextBlock).join("\n\n");

  return [
    "You are an AI Ops assistant for SaaS operations teams.",
    "",
    "Answer ONLY using the provided context.",
    "Do not use outside knowledge.",
    'If the answer cannot be found in the context, say exactly: "Insufficient information available."',
    "",
    "Keep the answer concise, operational, and factual.",
    "Do not invent causes, timestamps, services, users, incidents, or metrics.",
    "",
    "Context:",
    context,
    "",
    "Question:",
    question,
  ].join("\n");
}

function extractGeminiText(response: GeminiGenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => part.text)
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();

  if (!text) {
    throw new RAGProviderError("Gemini returned an empty answer");
  }

  return text;
}

async function generateAnswer(prompt: string): Promise<{
  answer: string;
  model: string;
  llmResponseTimeMs: number;
}> {
  const model = getGeminiModel();
  const apiKey = getGeminiApiKey();
  const maxOutputTokens = Math.floor(
    getNumberEnv("RAG_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS)
  );
  const startedAt = Date.now();

  try {
    const response = await axios.post<GeminiGenerateContentResponse>(
      `${GEMINI_API_BASE_URL}/v1beta/models/${model}:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          topP: 0.8,
          maxOutputTokens,
        },
      },
      {
        timeout: 60_000,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
      }
    );

    return {
      answer: extractGeminiText(response.data),
      model,
      llmResponseTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof RAGProviderError) throw error;

    if (error instanceof AxiosError) {
      const data = error.response?.data as GeminiErrorResponse | undefined;
      const message = data?.error?.message || error.message;
      const status = error.response?.status ?? "unknown";

      throw new RAGProviderError(
        `Gemini request failed (${status}): ${message}`
      );
    }

    throw error;
  }
}

export async function answerQuestion(
  question: string,
  organizationId: string
): Promise<RAGAnswerResponse> {
  const startedAt = Date.now();
  const trimmedQuestion = validateRAGQuestion(question);
  const orgId = validateOrganizationId(organizationId);
  const topK = getRAGTopK();
  const minSimilarity = getRAGMinSimilarity();
  const model = getGeminiModel();

  console.log("RAG question received", {
    organizationId: orgId,
    questionLength: trimmedQuestion.length,
    topK,
    minSimilarity,
  });

  const retrievedChunks = await searchRelevantChunks(trimmedQuestion, orgId, topK);
  const relevantChunks = retrievedChunks.filter(
    (chunk) => chunk.similarity >= minSimilarity
  );
  const contextChunks = buildContextChunks(relevantChunks);

  console.log("RAG chunks retrieved", {
    organizationId: orgId,
    retrievedCount: retrievedChunks.length,
    relevantCount: relevantChunks.length,
    usedCount: contextChunks.length,
  });

  if (contextChunks.length === 0) {
    const executionTimeMs = Date.now() - startedAt;

    console.log("RAG completed without context", {
      organizationId: orgId,
      executionTimeMs,
    });

    return {
      answer: "No relevant information found.",
      sources: [],
      metadata: {
        model,
        retrievedChunks: retrievedChunks.length,
        usedChunks: 0,
        llmResponseTimeMs: 0,
        executionTimeMs,
      },
    };
  }

  const prompt = buildGroundedPrompt(trimmedQuestion, contextChunks);
  const generated = await generateAnswer(prompt);

  console.log("RAG LLM completed", {
    organizationId: orgId,
    model: generated.model,
    llmResponseTimeMs: generated.llmResponseTimeMs,
  });

  const executionTimeMs = Date.now() - startedAt;

  console.log("RAG completed", {
    organizationId: orgId,
    executionTimeMs,
  });

  return {
    answer: generated.answer,
    sources: contextChunks.map(toSource),
    metadata: {
      model: generated.model,
      retrievedChunks: retrievedChunks.length,
      usedChunks: contextChunks.length,
      llmResponseTimeMs: generated.llmResponseTimeMs,
      executionTimeMs,
    },
  };
}

export async function runRAG(request: RAGRequest): Promise<RAGResponse> {
  return answerQuestion(request.query, request.organizationId);
}
