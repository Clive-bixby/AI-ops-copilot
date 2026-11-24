import "../../../config/env.js";

import { logAIMetrics, nowMs, elapsedMs } from "../aiMetrics.util.js";
import { LlmConfigError, LlmProviderError, LlmTimeoutError } from "./errors.js";
import { GeminiProvider } from "./gemini.provider.js";
import { OpenAiCompatibleProvider } from "./openai.provider.js";
import type {
  GenerateRequest,
  LlmProvider,
  LlmProviderName,
  LlmResult,
} from "./provider.js";
import type { LlmProviderSettings, LlmSettings } from "./settings.js";

export { LlmConfigError, LlmProviderError, LlmTimeoutError } from "./errors.js";
export type { GenerateRequest, LlmProvider, LlmResult, LlmUsage } from "./provider.js";
export type { LlmProviderSettings, LlmSettings } from "./settings.js";

/**
 * Which call site is asking. Only the model can differ between features; the
 * provider, key and base URL are shared, because a second set of credentials
 * would be a second provider and that is what the fallback block is for.
 */
export type LlmFeature = "rag" | "analysis";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MIN_TIMEOUT_MS = 1_000;

function trimmed(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function parseProvider(value: string | null, name: string): LlmProviderName {
  if (value === null) {
    return "gemini";
  }

  if (value === "gemini" || value === "openai-compatible") {
    return value;
  }

  throw new LlmConfigError(
    `Unknown ${name} "${value}". Use one of: gemini, openai-compatible.`
  );
}

function parsePositiveInt(
  name: string,
  fallback: number,
  minimum: number
): number {
  const raw = trimmed(process.env[name]);

  if (raw === null) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < minimum) {
    console.warn(`Invalid ${name}; using ${fallback}.`, { value: raw });

    return fallback;
  }

  return parsed;
}

function resolveModel(provider: LlmProviderName, feature?: LlmFeature): string {
  const featureOverride =
    feature === undefined
      ? null
      : trimmed(process.env[`${feature.toUpperCase()}_LLM_MODEL`]);
  const explicit = trimmed(process.env.LLM_MODEL);

  if (featureOverride !== null) {
    return featureOverride;
  }

  if (explicit !== null) {
    return explicit;
  }

  if (provider === "gemini") {
    // The pre-existing default. An unmodified .env keeps behaving exactly as it
    // did before this module existed.
    return trimmed(process.env.GEMINI_MODEL) ?? DEFAULT_GEMINI_MODEL;
  }

  return "";
}

function baseSettings(
  provider: LlmProviderName,
  model: string,
  overrides: {
    baseUrl: string | null;
    apiKey: string | null;
    apiKeyName: string;
  }
): LlmProviderSettings {
  return {
    provider,
    model,
    baseUrl: overrides.baseUrl,
    apiKey: overrides.apiKey,
    apiKeyName: overrides.apiKeyName,
    timeoutMs: parsePositiveInt("LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    maxRetries: parsePositiveInt("LLM_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0),
    baseDelayMs: parsePositiveInt("LLM_RETRY_BASE_DELAY_MS", DEFAULT_RETRY_BASE_DELAY_MS, 1),
  };
}

function readFallback(): LlmProviderSettings | null {
  // Off unless explicitly switched on. The secondary provider's quality,
  // structured-output behaviour, quota and privacy terms are unmeasured, so it
  // must not answer a user's question by accident.
  if ((trimmed(process.env.LLM_FALLBACK_ENABLED) ?? "false").toLowerCase() !== "true") {
    return null;
  }

  const provider = parseProvider(
    trimmed(process.env.LLM_FALLBACK_PROVIDER),
    "LLM_FALLBACK_PROVIDER"
  );
  const model = trimmed(process.env.LLM_FALLBACK_MODEL) ?? "";

  if (model === "") {
    return null;
  }

  const apiKey = trimmed(process.env.LLM_FALLBACK_API_KEY);

  return baseSettings(provider, model, {
    baseUrl: trimmed(process.env.LLM_FALLBACK_BASE_URL)?.replace(/\/+$/, "") ?? null,
    apiKey,
    apiKeyName: apiKey === null ? "GEMINI_API_KEY" : "LLM_FALLBACK_API_KEY",
  });
}

/**
 * Read the generation settings. Kept separate from the factory so tests can
 * exercise the real selection logic with explicit values, exactly like the
 * embedding settings do.
 *
 * Model precedence: `<FEATURE>_LLM_MODEL` > `LLM_MODEL` > `GEMINI_MODEL` >
 * `gemini-2.5-flash-lite`. With nothing set, this is the previous behaviour.
 */
export function readLlmSettings(feature?: LlmFeature): LlmSettings {
  const provider = parseProvider(trimmed(process.env.LLM_PROVIDER), "LLM_PROVIDER");
  const model = resolveModel(provider, feature);
  const explicitKey = trimmed(process.env.LLM_API_KEY);

  const primary =
    provider === "gemini"
      ? baseSettings(provider, model, {
          baseUrl:
            trimmed(process.env.LLM_BASE_URL)?.replace(/\/+$/, "") ??
            trimmed(process.env.GEMINI_API_BASE_URL)?.replace(/\/+$/, "") ??
            null,
          apiKey: explicitKey ?? trimmed(process.env.GEMINI_API_KEY),
          apiKeyName: explicitKey === null ? "GEMINI_API_KEY" : "LLM_API_KEY",
        })
      : baseSettings(provider, model, {
          baseUrl: trimmed(process.env.LLM_BASE_URL)?.replace(/\/+$/, "") ?? null,
          apiKey: explicitKey,
          apiKeyName: "LLM_API_KEY",
        });

  return { ...primary, fallback: readFallback() };
}

function buildProvider(settings: LlmProviderSettings): LlmProvider {
  if (settings.model.trim() === "") {
    throw new LlmConfigError(
      `LLM_MODEL is required when LLM_PROVIDER=${settings.provider}.`
    );
  }

  switch (settings.provider) {
    case "gemini":
      return new GeminiProvider(settings);
    case "openai-compatible":
      return new OpenAiCompatibleProvider(settings);
    default:
      throw new LlmConfigError(
        `Unknown generation provider "${String(settings.provider)}".`
      );
  }
}

/**
 * Try the primary, then the fallback, but only for failures a different provider
 * can plausibly fix. The returned result always names the provider that actually
 * answered, so attribution cannot drift.
 */
class FallbackLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider
  ) {
    this.name = primary.name;
    this.model = primary.model;
  }

  async generate(request: GenerateRequest): Promise<LlmResult> {
    try {
      return await this.primary.generate(request);
    } catch (error) {
      if (
        !(error instanceof LlmTimeoutError) &&
        !(error instanceof LlmProviderError) &&
        !(error instanceof LlmConfigError)
      ) {
        throw error;
      }

      logAIMetrics("llm.fallback", {
        fromProvider: this.primary.name,
        fromModel: this.primary.model,
        toProvider: this.fallback.name,
        toModel: this.fallback.model,
        reason: error.name,
      });

      const result = await this.fallback.generate(request);

      return { ...result, usedFallback: true };
    }
  }
}

/**
 * One line per call, with counts and timings only.
 *
 * The prompt is deliberately absent: it contains retrieved evidence, and a
 * demo's console is not the place for a user's documents. The API key is never
 * logged either -- only the environment variable's name appears in configuration
 * errors.
 */
class LoggedLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly inner: LlmProvider) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async generate(request: GenerateRequest): Promise<LlmResult> {
    const startedAt = nowMs();

    try {
      const result = await this.inner.generate(request);

      logAIMetrics("llm.completed", {
        configuredProvider: this.name,
        configuredModel: this.model,
        provider: result.provider,
        model: result.model,
        responseFormat: request.responseFormat ?? "text",
        promptChars: request.prompt.length,
        attempts: result.attempts,
        usedFallback: result.usedFallback,
        generationMs: result.generationMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });

      return result;
    } catch (error) {
      logAIMetrics("llm.failed", {
        configuredProvider: this.name,
        configuredModel: this.model,
        responseFormat: request.responseFormat ?? "text",
        promptChars: request.prompt.length,
        totalMs: elapsedMs(startedAt),
        errorName: error instanceof Error ? error.name : "UnknownError",
        status: error instanceof LlmProviderError ? error.status : null,
      });

      throw error;
    }
  }
}

/** Build the configured provider chain. Pure: no caching, no hidden env reads. */
export function createLlmProvider(settings: LlmSettings): LlmProvider {
  const primary = buildProvider(settings);

  const chained =
    settings.fallback === null
      ? primary
      : new FallbackLlmProvider(primary, buildProvider(settings.fallback));

  return new LoggedLlmProvider(chained);
}

const cache = new Map<string, LlmProvider>();

/**
 * The provider for this process and feature. Created on first use so a
 * misconfiguration is reported by the endpoint that needs it rather than
 * preventing the API from starting.
 */
export function getLlmProvider(feature?: LlmFeature): LlmProvider {
  const key = feature ?? "default";
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const provider = createLlmProvider(readLlmSettings(feature));
  cache.set(key, provider);

  return provider;
}

/** Drop cached providers so the next read re-evaluates the environment. */
export function resetLlmProvider(): void {
  cache.clear();
}
