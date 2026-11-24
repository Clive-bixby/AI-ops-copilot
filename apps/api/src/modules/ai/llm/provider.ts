/**
 * What the rest of the application requires from a generation backend.
 *
 * There is one method, not `generateText()` plus `generateJson()`: the two
 * differ only in whether the provider constrains its output, which is a field on
 * the request. A RAG answer is prose and must not be routed through a method
 * named after JSON.
 *
 * `provider` and `model` on the result describe what actually answered -- not
 * what was configured. They are persisted with every analysis and follow-up, so
 * a fallback can never be recorded as the primary.
 */

export type LlmProviderName = "gemini" | "openai-compatible";

export type LlmResponseFormat = "text" | "json";

export type GenerateRequest = {
  prompt: string;
  /** Defaults to "text". "json" asks the provider to constrain its output. */
  responseFormat?: LlmResponseFormat;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  /** JSON Schema for providers that support constrained decoding. */
  jsonSchema?: unknown;
  /** Overrides the provider's configured timeout for this request. */
  timeoutMs?: number;
};

export type LlmUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type LlmResult = {
  text: string;
  provider: string;
  model: string;
  generationMs: number;
  /** 1 when the first attempt succeeded. */
  attempts: number;
  usedFallback: boolean;
  usage: LlmUsage;
};

export interface LlmProvider {
  /** Configured backend, e.g. "gemini". */
  readonly name: string;
  /** Configured model id; the result reports the model that answered. */
  readonly model: string;
  generate(request: GenerateRequest): Promise<LlmResult>;
}
