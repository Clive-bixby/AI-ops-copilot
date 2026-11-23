import "../../config/env.js";

import axios, { AxiosError } from "axios";

import { elapsedMs, nowMs } from "../ai/aiMetrics.util.js";
import {
  RAGProviderError,
  RAGProviderTimeoutError,
} from "../ai/rag.service.js";

/**
 * Analysis and follow-up answers both ask Gemini for JSON directly. Prompt text
 * is never stored; only the validated result and the model metadata are persisted.
 */

const GEMINI_API_BASE_URL =
  process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_MAX_OUTPUT_TOKENS = 1600;

export const ANALYSIS_PROVIDER = "gemini";

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
  }[];
};

type GeminiErrorResponse = { error?: { message?: string } };

export function getAnalysisModel(): string {
  return (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

function getApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new RAGProviderError(
      "GEMINI_API_KEY is required to run an investigation analysis"
    );
  }

  return apiKey.trim();
}

export async function generateJsonResponse(prompt: string): Promise<{
  raw: string;
  model: string;
  generationMs: number;
}> {
  const model = getAnalysisModel();
  const apiKey = getApiKey();
  const maxOutputTokens = Number(
    process.env.ANALYSIS_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS
  );
  const startedAt = nowMs();

  try {
    const response = await axios.post<GeminiResponse>(
      `${GEMINI_API_BASE_URL}/v1beta/models/${model}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: Number.isFinite(maxOutputTokens)
            ? maxOutputTokens
            : DEFAULT_MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
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

    const text = (response.data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();

    if (text.length === 0) {
      throw new RAGProviderError("The analysis provider returned no content");
    }

    return { raw: text, model, generationMs: elapsedMs(startedAt) };
  } catch (error) {
    if (error instanceof RAGProviderError) {
      throw error;
    }

    if (error instanceof AxiosError) {
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        throw new RAGProviderTimeoutError("The analysis provider timed out");
      }

      const data = error.response?.data as GeminiErrorResponse | undefined;
      const message = data?.error?.message || error.message;
      const status = error.response?.status ?? "unknown";

      throw new RAGProviderError(
        `Analysis provider request failed (${status}): ${message}`
      );
    }

    throw error;
  }
}
