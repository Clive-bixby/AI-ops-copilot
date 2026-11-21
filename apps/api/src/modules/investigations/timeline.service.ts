import {
  getInvestigationDetail,
} from "./investigation.service.js";
import { buildTimeline, TIMELINE_LIMITS } from "./timelinePolicy.js";
import type { InvestigationTimeline } from "./types.js";

/**
 * The timeline is derived on read: activity rows and evidence rows are the
 * stored facts, and merging them is a pure function of those facts. That keeps
 * the stored data small and means a timeline can never drift from its evidence.
 */
export async function getInvestigationTimeline(
  organizationId: string,
  investigationId: string,
  now: Date = new Date()
): Promise<InvestigationTimeline> {
  // Same org-scoped lookup as the detail endpoint: a foreign or malformed id is
  // a 404 there, and the timeline must not answer differently.
  const detail = await getInvestigationDetail(
    organizationId,
    investigationId,
    TIMELINE_LIMITS.activityFetchLimit
  );

  return buildTimeline({
    investigation: detail.investigation,
    activity: detail.activity,
    evidence: detail.evidence,
    now: now.toISOString(),
  });
}
