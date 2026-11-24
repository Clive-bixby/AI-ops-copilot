import "../../config/env.js";

import { elapsedMs, nowMs } from "../ai/aiMetrics.util.js";
import { LlmConfigError, LlmProviderError, LlmTimeoutError } from "../ai/llm/errors.js";
import { getLlmProvider, readLlmSettings } from "../ai/llm/index.js";
import {
  RAGProviderError,
  RAGProviderTimeoutError,
} from "../ai/rag.service.js";

/**
 * Investigation analysis and follow-up answers both ask the generation provider
 * for JSON directly. Prompt text is never stored; only the validated result and
 * the provider/model metadata are persisted.
 *
 * The provider and model reported here are the ones that actually answered --
 * when a fallback is eventually enabled, a run recorded as `gemini` must never
 * have been written by `groq`.
 */

const DEFAULT_MAX_OUTPUT_TOKENS = 1600;

/**
 * Configured identity, recorded on the run before the provider is called.
 *
 * Reading the settings can itself fail -- an unknown `LLM_PROVIDER`, or an unknown
 * `LLM_FALLBACK_PROVIDER` when fallback is enabled. That happens before the
 * generation call, so it would escape the mapper in `generateJsonResponse` and
 * surface as an unhandled 500. A bad provider name is the same class of failure
 * as a rejected key: the provider cannot answer, so the endpoint answers 502
 * with the sentence that fixes it.
 */
export function getAnalysisGenerationIdentity(): {
  provider: string;
  model: string;
} {
  try {
    const settings = readLlmSettings("analysis");

    return { provider: settings.provider, model: settings.model };
  } catch (error) {
    if (error instanceof LlmConfigError) {
      throw new RAGProviderError(error.message);
    }

    throw error;
  }
}

export async function generateJsonResponse(prompt: string): Promise<{
  raw: string;
  provider: string;
  model: string;
  generationMs: number;
}> {
  const maxOutputTokensRaw = Number(
    process.env.ANALYSIS_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS
  );
  const maxOutputTokens = Number.isFinite(maxOutputTokensRaw)
    ? Math.floor(maxOutputTokensRaw)
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const startedAt = nowMs();

  try {
    const result = await getLlmProvider("analysis").generate({
      prompt,
      responseFormat: "json",
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens,
    });

    return {
      raw: result.text,
      provider: result.provider,
      model: result.model,
      generationMs: elapsedMs(startedAt),
    };
  } catch (error) {
    if (error instanceof LlmTimeoutError) {
      throw new RAGProviderTimeoutError("The analysis provider timed out");
    }

    if (error instanceof LlmConfigError) {
      throw new RAGProviderError(error.message);
    }

    if (error instanceof LlmProviderError) {
      throw new RAGProviderError(
        `Analysis provider request failed (${error.status ?? "unknown"}): ${error.message}`
      );
    }

    throw error;
  }
}
