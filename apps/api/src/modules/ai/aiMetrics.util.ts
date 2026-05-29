export type AIMetricsPayload = Record<string, unknown>;

export function nowMs(): number {
  return Date.now();
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

export function logAIMetrics(
  event: string,
  payload: AIMetricsPayload = {}
): void {
  console.log("ai.metrics", {
    event,
    ...payload,
  });
}
