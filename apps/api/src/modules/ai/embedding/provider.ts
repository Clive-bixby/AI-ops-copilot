import type { ProviderName } from "./settings.js";

/**
 * What the rest of the application requires from an embedding backend.
 *
 * Providers differ in protocol, not in role: each turns text into vectors and
 * reports which model produced them. Ingestion, retrieval and the health
 * endpoint therefore never branch on the provider name.
 */

export type EmbeddingProbe = {
  ok: boolean;
  message: string;
};

export type EmbeddingBatch = {
  embeddings: number[][];
  /** The model the service reports; snapped into `embedding_model` per chunk. */
  model: string;
};

export interface EmbeddingProvider {
  readonly name: ProviderName;
  /**
   * Model identity recorded with every chunk. Retrieval rejects chunks whose
   * recorded model or width differs from the current configuration, so this
   * must describe what actually produced the vectors -- not what was requested.
   */
  readonly model: string;
  readonly dimensions: number;
  /** Where embeddings come from: a URL, or the fixture file path. */
  readonly endpoint: string;
  embed(texts: string[]): Promise<EmbeddingBatch>;
  probe(): Promise<EmbeddingProbe>;
}
