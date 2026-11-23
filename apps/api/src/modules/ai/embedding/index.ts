import { EmbeddingConfigError } from "./errors.js";
import { FixtureEmbeddingProvider } from "./fixture.provider.js";
import { OllamaEmbeddingProvider } from "./ollama.provider.js";
import { OpenAiCompatibleEmbeddingProvider } from "./openai.provider.js";
import type { EmbeddingProvider } from "./provider.js";
import { readEmbeddingSettings } from "./settings.js";
import type { EmbeddingSettings } from "./settings.js";

export { readEmbeddingSettings } from "./settings.js";
export type { EmbeddingSettings, ProviderName } from "./settings.js";
export type { EmbeddingProbe, EmbeddingProvider } from "./provider.js";
export { fixtureKeyOf } from "./fixture.provider.js";

/**
 * Build the provider named by the settings. Pure: no caching, no environment
 * access, so tests exercise the real selection logic with explicit settings.
 */
export function createEmbeddingProvider(
  settings: EmbeddingSettings = readEmbeddingSettings()
): EmbeddingProvider {
  switch (settings.provider) {
    case "ollama":
      return new OllamaEmbeddingProvider(settings);
    case "openai-compatible":
      return new OpenAiCompatibleEmbeddingProvider(settings);
    case "fixture":
      return new FixtureEmbeddingProvider(settings);
    default:
      throw new EmbeddingConfigError(
        `Unknown EMBEDDING_PROVIDER "${String(settings.provider)}".`
      );
  }
}

let cached: EmbeddingProvider | null = null;

/**
 * The provider for this process. Created on first use rather than at import
 * time so a misconfiguration is reported by `/ai/health` and by ingestion
 * instead of preventing the API from starting.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached === null) {
    cached = createEmbeddingProvider();
  }

  return cached;
}

/** Drop the cached provider so the next read re-evaluates the environment. */
export function resetEmbeddingProvider(): void {
  cached = null;
}
