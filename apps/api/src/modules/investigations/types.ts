import type {
  InvestigationSeverity,
  InvestigationSourceType,
  InvestigationStatus,
} from "./policy.js";

export type Investigation = {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  status: InvestigationStatus;
  severity: InvestigationSeverity;
  /** Component/service the investigation is about, when the engineer supplied one. */
  service: string | null;
  errorSignature: string | null;
  /** Investigation scope, not necessarily the earliest evidence timestamp. */
  windowStart: string | null;
  windowEnd: string | null;
  /** NULL means every source type is searched. */
  sourceTypes: InvestigationSourceType[] | null;
  resolutionSummary: string | null;
  createdBy: string;
  createdByEmail: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvestigationActivityType =
  | "created"
  | "note"
  | "status_change"
  | "severity_change"
  | "evidence_added"
  | "evidence_removed"
  | "hypothesis_created"
  | "hypothesis_status"
  | "analysis_started"
  | "analysis_succeeded"
  | "analysis_failed"
  | "follow_up";

export type InvestigationActivity = {
  id: string;
  type: InvestigationActivityType;
  /** NULL for system events. */
  actorUserId: string | null;
  actorEmail: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * How a piece of evidence was found.
 *   vector/keyword/hybrid — a retrieval arm found it
 *   manual                — an engineer linked it by source id; no similarity
 */
export type EvidenceMatchType = "vector" | "keyword" | "hybrid" | "manual";

/**
 * Evidence quality, assigned by deterministic rules (not by the language
 * model): direct, historical, related context, or weak.
 */
export type EvidenceRelevance = "direct" | "historical" | "related" | "weak";

export type EvidenceOrigin = "retrieval" | "manual";

export type InvestigationEvidenceItem = {
  id: string;
  investigationId: string;
  sourceType: InvestigationSourceType;
  sourceId: string;
  chunkIndex: number;
  sourceTitle: string;
  excerpt: string;
  /** The source's own timestamp, or null when it genuinely has none. */
  sourceCreatedAt: string | null;
  sourceMetadata: Record<string, unknown> | null;
  matchType: EvidenceMatchType;
  /** RRF score for retrieved evidence; 0 for a manual link. */
  retrievalScore: number;
  /** Cosine similarity, or null for keyword-only and manual evidence. */
  similarity: number | null;
  relevance: EvidenceRelevance;
  inclusionReason: string;
  /** The query that surfaced the source (`manual link` for manual evidence). */
  retrievalQuery: string;
  origin: EvidenceOrigin;
  addedBy: string | null;
  createdAt: string;
};

export type InvestigationDetail = {
  investigation: Investigation;
  activity: InvestigationActivity[];
  evidence: InvestigationEvidenceItem[];
};

/**
 * Result of one evidence collection attempt. `failed` is explicit so a client
 * can tell "found nothing" apart from "could not search".
 */
export type EvidenceCollectionSummary = {
  failed: boolean;
  queries: string[];
  added: number;
  existing: number;
  /** Retrieved candidates dropped because the source no longer exists. */
  filteredOut: number;
  warnings: string[];
};

export type InvestigationList = {
  investigations: Investigation[];
  total: number;
  limit: number;
  offset: number;
};
