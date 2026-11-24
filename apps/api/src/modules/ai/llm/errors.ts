/**
 * Generation failures, shaped so a call site can map them onto the errors it
 * already exposes (RAGProviderError / RAGProviderTimeoutError) without knowing
 * which provider produced them.
 *
 * Messages never include the API key or the prompt: a provider error is logged
 * on a public demo's console.
 */

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export class LlmProviderError extends Error {
  /** HTTP status when the provider answered; null for transport failures. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LlmProviderError";
    this.status = status;
  }
}

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}
