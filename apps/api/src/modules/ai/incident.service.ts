export type Incident = {
  type: string;
  severity: "low" | "medium" | "high";
  evidence: string[];
};

export function detectIncidents(logLines: string[]): Incident[] {
  const incidents: Incident[] = [];
  const errorCount = logLines.filter((l) => /error|exception|fail/i.test(l)).length;
  if (errorCount >= 5) {
    incidents.push({
      type: "error_spike",
      severity: errorCount >= 20 ? "high" : "medium",
      evidence: [`${errorCount} error-like log lines detected`],
    });
  }
  return incidents;
}
