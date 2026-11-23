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
  /** NULL means unassigned. Never inferred from the creator. */
  ownerUserId: string | null;
  ownerEmail: string | null;
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
  | "comment"
  | "status_change"
  | "severity_change"
  | "owner_change"
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
  /**
   * Graded weak and not stored. Automatic collection only keeps evidence that
   * is direct, historical or related; an engineer can still link these.
   */
  withheld: number;
  warnings: string[];
};

export type InvestigationList = {
  investigations: Investigation[];
  total: number;
  limit: number;
  offset: number;
};

export type AnalysisStatus = "pending" | "succeeded" | "failed";

export type HypothesisStatus = "unverified" | "supported" | "rejected";

export type HypothesisStatusSource = "model" | "user";

export type AnalysisHypothesisEvidence = {
  evidenceId: string;
  relation: "supports" | "contradicts";
};

export type AnalysisHypothesis = {
  id: string;
  investigationId: string;
  statement: string;
  rationale: string;
  status: HypothesisStatus;
  statusSource: HypothesisStatusSource;
  missingInformation: string[];
  verificationSteps: string[];
  /** Evidence the model cited; the ids always resolve to this investigation. */
  evidence: AnalysisHypothesisEvidence[];
  analysisId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvestigationAnalysis = {
  id: string;
  investigationId: string;
  status: AnalysisStatus;
  failureReason: string | null;
  analysisVersion: number;
  provider: string;
  model: string;
  /** Exactly the evidence rows supplied to the model. */
  evidenceIds: string[];
  summary: string | null;
  keyObservations: string[];
  nextSteps: string[];
  insufficientEvidence: boolean;
  missingInformation: string[];
  generationMs: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type InvestigationAnalysisResult = {
  analysis: InvestigationAnalysis | null;
  hypotheses: AnalysisHypothesis[];
};

export type FollowUpConfidence = "high" | "medium" | "low";

export type FollowUpCitation = {
  evidenceId: string;
  sourceType: InvestigationSourceType;
  sourceTitle: string;
  relevance: EvidenceRelevance;
  sourceCreatedAt: string | null;
};

/** One question and the answer it received, stored as a `follow_up` activity row. */
export type FollowUpAnswer = {
  activityId: string;
  question: string;
  answer: string;
  confidence: FollowUpConfidence;
  insufficientContext: boolean;
  citations: FollowUpCitation[];
  analysisId: string | null;
  model: string;
  provider: string;
  generationMs: number;
  createdAt: string;
};

export type TimelineEventKind = InvestigationActivityType | "evidence_source";

/**
 * Deterministic labels that explain why an event sits where it does on the
 * timeline. They come from rules, never from a model.
 */
export type TimelineCorrelation =
  | "signature_match"
  | "same_service"
  | "in_window"
  | "before_window"
  | "after_window"
  | "time_cluster";

export type TimelineEvent = {
  id: string;
  kind: TimelineEventKind;
  at: string;
  /**
   * True when `at` is the source's own timestamp; false when the source has none
   * and the moment the evidence was recorded stands in for it.
   */
  atSourceTime: boolean;
  title: string;
  detail: string | null;
  activityId: string | null;
  evidenceId: string | null;
  sourceType: InvestigationSourceType | null;
  sourceId: string | null;
  relevance: EvidenceRelevance | null;
  actorEmail: string | null;
  correlations: TimelineCorrelation[];
};

export type InvestigationTimeline = {
  investigationId: string;
  windowStart: string | null;
  windowEnd: string | null;
  generatedAt: string;
  events: TimelineEvent[];
  summary: {
    total: number;
    /** True when older events were dropped to respect the event cap. */
    clipped: boolean;
    /** Evidence with no source timestamp, placed at its recorded time. */
    undated: number;
    evidence: number;
    activity: number;
    bySourceType: Record<InvestigationSourceType, number>;
    correlations: Record<TimelineCorrelation, number>;
  };
};
