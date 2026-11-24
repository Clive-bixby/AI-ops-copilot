import axios, { AxiosError, type AxiosResponse } from "axios";

import { elapsedMs, nowMs } from "../aiMetrics.util.js";
import { LlmConfigError, LlmProviderError, LlmTimeoutError } from "./errors.js";
import type {
  GenerateRequest,
  LlmProvider,
  LlmResult,
  LlmUsage,
} from "./provider.js";
import {
  parseRetryAfter,
  RetryableFailure,
  RetryableTimeout,
  runWithRetries,
} from "./retry.js";
import type { LlmProviderSettings } from "./settings.js";

/**
 * Google Gemini `generateContent`.
 *
 * This is the same request the application sent before, moved behind the shared
 * interface: the prompt shape, temperature/topP defaults and error taxonomy are
 * unchanged. What is new is that the caller chooses the response format instead
 * of one call site hard-coding `responseMimeType: application/json` while the
 * other omitted it, and that a throttled request is retried rather than failing
 * the run.
 */

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const MAX_ERROR_DETAIL_CHARS = 300;

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
};

type GeminiErrorResponse = { error?: { message?: string } };

function trimmedDetail(data: unknown): string | null {
  const message = (data as GeminiErrorResponse | undefined)?.error?.message;

  if (typeof message !== "string" || message.trim() === "") {
    return null;
  }

  const text = message.replace(/\s+/g, " ").trim();

  return text.length <= MAX_ERROR_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}…`;
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly model: string;

  constructor(private readonly settings: LlmProviderSettings) {
    this.model = settings.model;
  }

  private baseUrl(): string {
    return (this.settings.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  }

  private requireApiKey(): string {
    const apiKey = this.settings.apiKey?.trim();

    if (!apiKey) {
      throw new LlmConfigError(
        `${this.settings.apiKeyName} is required to generate an answer`
      );
    }

    return apiKey;
  }

  async generate(request: GenerateRequest): Promise<LlmResult> {
    const apiKey = this.requireApiKey();
    const startedAt = nowMs();

    let outcome: { value: { text: string; usage: LlmUsage }; attempts: number };

    try {
      outcome = await runWithRetries({
        maxRetries: this.settings.maxRetries,
        baseDelayMs: this.settings.baseDelayMs,
        run: () => this.attempt(request, apiKey),
      });
    } catch (error) {
      if (error instanceof RetryableTimeout) {
        throw new LlmTimeoutError(error.message);
      }

      if (error instanceof RetryableFailure) {
        throw new LlmProviderError(error.message, error.status);
      }

      throw error;
    }

    return {
      text: outcome.value.text,
      provider: this.name,
      model: this.model,
      generationMs: elapsedMs(startedAt),
      attempts: outcome.attempts,
      usedFallback: false,
      usage: outcome.value.usage,
    };
  }

  private async attempt(
    request: GenerateRequest,
    apiKey: string
  ): Promise<{ text: string; usage: LlmUsage }> {
    const url = `${this.baseUrl()}/v1beta/models/${this.model}:generateContent`;
    const responseFormat = request.responseFormat ?? "text";

    const generationConfig: Record<string, unknown> = {
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { topP: request.topP }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
    };

    // Omitted for prose: asking for a JSON MIME type on a RAG answer would be a
    // behaviour change, and a plain-text answer is what that call site wants.
    if (responseFormat === "json") {
      generationConfig.responseMimeType = "application/json";

      if (request.jsonSchema !== undefined) {
        generationConfig.responseSchema = request.jsonSchema;
      }
    }

    let response: AxiosResponse<GeminiResponse>;

    try {
      response = await axios.post<GeminiResponse>(
        url,
        {
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig,
        },
        {
          timeout: request.timeoutMs ?? this.settings.timeoutMs,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
        }
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const text = (response.data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();

    if (text.length === 0) {
      throw new LlmProviderError(
        `The generation provider returned no content (finishReason: ${
          response.data.candidates?.[0]?.finishReason ?? "unknown"
        })`
      );
    }

    return {
      text,
      usage: {
        inputTokens: response.data.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response.data.usageMetadata?.candidatesTokenCount ?? null,
      },
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof LlmProviderError || error instanceof LlmTimeoutError) {
      return error;
    }

    if (!(error instanceof AxiosError)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      // A slow provider is worth one more try; if it stays slow the caller still
      // gets a timeout, which maps to 504 rather than a 502.
      return new RetryableTimeout("The generation provider did not answer in time.");
    }

    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      return new RetryableFailure(
        `Cannot connect to the generation provider at ${this.baseUrl()}.`
      );
    }

    const status = error.response?.status ?? null;
    const detail = trimmedDetail(error.response?.data);

    if (status === 429) {
      return new RetryableFailure(
        "The generation provider is rate limiting this deployment (429).",
        429,
        parseRetryAfter(error.response?.headers?.["retry-after"])
      );
    }

    if (status !== null && status >= 500) {
      return new RetryableFailure(
        `The generation provider failed (${status}).`,
        status,
        parseRetryAfter(error.response?.headers?.["retry-after"])
      );
    }

    if (status === 401 || status === 403) {
      return new LlmProviderError(
        `The generation provider rejected the credentials (${status}). Check ${this.settings.apiKeyName}.`,
        status
      );
    }

    if (status === 404) {
      return new LlmProviderError(
        `Model '${this.model}' is not available at ${this.baseUrl()}.`,
        status
      );
    }

    return new LlmProviderError(
      `Generation request failed (${status ?? "no response"}): ${detail ?? error.message}`,
      status
    );
  }
}
