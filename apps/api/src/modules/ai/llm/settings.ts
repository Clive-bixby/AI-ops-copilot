import type { LlmProviderName } from "./provider.js";

/**
 * Configuration for one generation backend.
 *
 * Settings are read on demand (like the embedding settings) so a missing key is
 * reported by the endpoint that needs it instead of preventing the API from
 * starting.
 */
export type LlmProviderSettings = {
  provider: LlmProviderName;
  model: string;
  /** Base URL without a trailing slash; null means the provider's default. */
  baseUrl: string | null;
  apiKey: string | null;
  /** Env var the key came from, named in configuration errors -- never the key. */
  apiKeyName: string;
  timeoutMs: number;
  /** Extra attempts after the first one. 0 disables retrying. */
  maxRetries: number;
  /** Base delay for exponential backoff; tests shrink it. */
  baseDelayMs: number;
};

export type LlmSettings = LlmProviderSettings & {
  /**
   * Automatic fallback. Null unless explicitly enabled: a second provider's
   * quality, structured-output behaviour, quota and privacy terms have to be
   * measured before it may answer a user's question.
   */
  fallback: LlmProviderSettings | null;
};
