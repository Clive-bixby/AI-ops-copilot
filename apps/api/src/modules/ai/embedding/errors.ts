/**
 * Embedding errors live here so a provider module can raise them without
 * importing the service that selects providers -- that import would be circular.
 * `embedding.service.ts` re-exports all three, so existing importers (the error
 * middleware, the document controller, the tests) are unchanged.
 */

/**
 * The provider is misconfigured (unknown name, missing base URL). Distinct from
 * a broken service: nothing will fix this by retrying.
 */
export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

export class EmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingValidationError";
  }
}

export class EmbeddingConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConnectionError";
  }
}

export class EmbeddingModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingModelError";
  }
}
