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
 * Any service that implements the OpenAI chat-completions API:
 *
 *   POST {LLM_BASE_URL}/chat/completions
 *   { "model": "...", "messages": [ ... ] }
 *   Authorization: Bearer {LLM_API_KEY}
 *
 * Groq, Cerebras, OpenRouter and a local llama.cpp server all speak this shape,
 * which is why the fallback provider needs no vendor SDK. It is not used unless
 * `LLM_PROVIDER` or `LLM_FALLBACK_ENABLED` selects it.
 *
 * `response_format: { type: "json_object" }` guarantees JSON syntax, not our
 * schema; the analysis and follow-up parsers validate and cap every field, so a
 * syntactically valid but wrong object is still rejected or clamped there.
 */

const MAX_ERROR_DETAIL_CHARS = 300;

type OpenAiChatResponse = {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

type OpenAiErrorResponse = { error?: { message?: string } };

function trimmedDetail(data: unknown): string | null {
  const message = (data as OpenAiErrorResponse | undefined)?.error?.message;

  if (typeof message !== "string" || message.trim() === "") {
    return null;
  }

  const text = message.replace(/\s+/g, " ").trim();

  return text.length <= MAX_ERROR_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}…`;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible" as const;
  readonly model: string;

  constructor(private readonly settings: LlmProviderSettings) {
    this.model = settings.model;
  }

  private requireBaseUrl(): string {
    if (!this.settings.baseUrl) {
      throw new LlmConfigError(
        "LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible " +
          "(for example https://api.groq.com/openai/v1)."
      );
    }

    return this.settings.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (this.settings.apiKey?.trim()) {
      headers.Authorization = `Bearer ${this.settings.apiKey.trim()}`;
    }

    return headers;
  }

  async generate(request: GenerateRequest): Promise<LlmResult> {
    const baseUrl = this.requireBaseUrl();
    const startedAt = nowMs();

    let outcome: { value: { text: string; usage: LlmUsage }; attempts: number };

    try {
      outcome = await runWithRetries({
        maxRetries: this.settings.maxRetries,
        baseDelayMs: this.settings.baseDelayMs,
        run: () => this.attempt(baseUrl, request),
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
    baseUrl: string,
    request: GenerateRequest
  ): Promise<{ text: string; usage: LlmUsage }> {
    const responseFormat = request.responseFormat ?? "text";

    let response: AxiosResponse<OpenAiChatResponse>;

    try {
      response = await axios.post<OpenAiChatResponse>(
        `${baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [{ role: "user", content: request.prompt }],
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.topP === undefined ? {} : { top_p: request.topP }),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { max_tokens: request.maxOutputTokens }),
          ...(responseFormat === "json"
            ? { response_format: { type: "json_object" } }
            : {}),
        },
        {
          timeout: request.timeoutMs ?? this.settings.timeoutMs,
          headers: this.headers(),
        }
      );
    } catch (error) {
      throw this.mapError(error, baseUrl);
    }

    const choice = response.data.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();

    if (text.length === 0) {
      throw new LlmProviderError(
        `The generation provider returned no content (finishReason: ${
          choice?.finish_reason ?? "unknown"
        })`
      );
    }

    return {
      text,
      usage: {
        inputTokens: response.data.usage?.prompt_tokens ?? null,
        outputTokens: response.data.usage?.completion_tokens ?? null,
      },
    };
  }

  private mapError(error: unknown, baseUrl: string): Error {
    if (error instanceof LlmProviderError || error instanceof LlmTimeoutError) {
      return error;
    }

    if (!(error instanceof AxiosError)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return new RetryableTimeout("The generation provider did not answer in time.");
    }

    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      return new RetryableFailure(
        `Cannot connect to the generation provider at ${baseUrl}.`
      );
    }

    const status = error.response?.status ?? null;
    const detail = trimmedDetail(error.response?.data);

    // The provider's own sentence distinguishes a per-minute throttle from an
    // exhausted daily quota, so it is part of the message.
    const explained = detail === null ? "" : ` ${detail}`;

    if (status === 429) {
      return new RetryableFailure(
        `The generation provider is rate limiting this deployment (429).${explained}`,
        429,
        parseRetryAfter(error.response?.headers?.["retry-after"])
      );
    }

    if (status !== null && status >= 500) {
      return new RetryableFailure(
        `The generation provider failed (${status}).${explained}`,
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
        `Model '${this.model}' is not available at ${baseUrl}.`,
        status
      );
    }

    return new LlmProviderError(
      `Generation request failed (${status ?? "no response"}): ${detail ?? error.message}`,
      status
    );
  }
}
