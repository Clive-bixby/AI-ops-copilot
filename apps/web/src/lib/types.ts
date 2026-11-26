export type Role = 'owner' | 'admin' | 'member';

export type Confidence = 'high' | 'medium' | 'low';

export interface LoginResponse {
  token: string;
}

export interface Session {
  user: { id: string; email: string };
  organization: { id: string; name: string };
  role: Role | string;
}

export interface DecodedToken {
  userId?: string;
  organizationId?: string;
  role?: string;
  exp?: number;
}

export interface SystemStatus {
  service: string;
  version: string;
  environment: string;
}

export interface RootStatus {
  message: string;
  status: string;
  timestamp: string;
}

/**
 * Which model would answer an analysis, read from configuration. `error` means
 * it cannot answer at all -- unknown provider, no model, or a model the vendor
 * has retired -- and the endpoint answers 503 in that case.
 */
export interface GenerationStatus {
  provider: string;
  model: string;
  /** `provider/model`, or null when no fallback is enabled. */
  fallback: string | null;
  error?: string;
}

export interface ApiHealth {
  healthy: boolean;
  /** "ollama" | "openai-compatible" | "fixture" */
  provider: string;
  model: string;
  /** null when the provider configuration is too incomplete to report a width. */
  dimensions: number | null;
  /** Base URL of the embedding service, or the fixture file path. */
  endpoint: string;
  message: string;
  /** Absent on an API older than the generation block. */
  generation?: GenerationStatus;
}

export interface DocumentSummary {
  id: string;
  filename: string;
  processingStatus: 'pending' | 'processing' | 'processed' | 'failed' | string;
  processingError: string | null;
  processedAt: string | null;
  createdAt: string;
  chunkCount: number;
}

export interface DocumentChunk {
  id: string;
  chunkIndex: number;
  preview: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  chunks: DocumentChunk[];
}

export interface LogEntry {
  id: string;
  organization_id: string;
  level: string;
  message: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  organization_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  created_at: string;
}

export type SearchSourceType = 'document' | 'log' | 'ticket';

export type SearchMatchType = 'vector' | 'keyword' | 'hybrid';

export interface SearchResult {
  content: string;
  /** null when the chunk was found only by the keyword arm */
  similarity: number | null;
  /** Reciprocal-rank-fusion score; higher is better within one response */
  score: number;
  matchType: SearchMatchType;
  sourceType: SearchSourceType;
  sourceId: string;
  /** null for log groups and tickets, which are not documents */
  documentId: string | null;
  chunkIndex: number;
  preview: string;
}

export interface SearchResponse {
  query: string;
  totalResults: number;
  executionTimeMs: number;
  results: SearchResult[];
}

export type RagSourceType = 'document' | 'log' | 'ticket';
export type RagMatchType = 'vector' | 'keyword' | 'hybrid';

export interface RagSource {
  sourceType: RagSourceType;
  sourceId: string;
  /** null for logs and tickets, which are not documents */
  documentId: string | null;
  chunkIndex: number;
  /** null for keyword matches, which have no similarity score */
  similarity: number | null;
  matchType: RagMatchType;
  preview: string;
}

export interface RagMetrics {
  embeddingMs: number;
  retrievalMs: number;
  retrievedChunkCount: number;
  generationMs: number;
  totalMs: number;
}

export interface AskResponse {
  question: string;
  answer: string;
  confidence: Confidence;
  sources: RagSource[];
  sourceCount: number;
  metrics: RagMetrics;
}

export interface Overview {
  documents: {
    total: number;
    processed: number;
    processing: number;
    pending: number;
    failed: number;
    chunks: number;
    lastIngestedAt: string | null;
  };
  logs: {
    total: number;
    errors: number;
    warnings: number;
    lastSeenAt: string | null;
    byLevel: Record<string, number>;
  };
  tickets: {
    total: number;
    open: number;
    urgentOpen: number;
    lastCreatedAt: string | null;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
  };
}

export interface OrganizationMember {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

export interface MembersResponse {
  organizationId: string;
  total: number;
  members: OrganizationMember[];
}

export interface IngestLogsResponse {
  count: number;
  logs: LogEntry[];
}

export interface IngestTicketsResponse {
  count: number;
  tickets: Ticket[];
}

/* ------------------------------------------------------------------ */
/* Investigations                                                      */
/* ------------------------------------------------------------------ */

export type InvestigationStatus = 'open' | 'investigating' | 'resolved' | 'closed';
export type InvestigationSeverity = 'low' | 'medium' | 'high' | 'critical';
export type InvestigationSourceType = 'document' | 'log' | 'ticket';
export type EvidenceRelevance = 'direct' | 'historical' | 'related' | 'weak';
export type EvidenceMatchType = 'vector' | 'keyword' | 'hybrid' | 'manual';
export type EvidenceOrigin = 'retrieval' | 'manual';
export type HypothesisStatus = 'unverified' | 'supported' | 'rejected';
export type TimelineCorrelation =
  | 'signature_match'
  | 'same_service'
  | 'in_window'
  | 'before_window'
  | 'after_window'
  | 'time_cluster';

export interface Investigation {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  status: InvestigationStatus;
  severity: InvestigationSeverity;
  service: string | null;
  errorSignature: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  sourceTypes: InvestigationSourceType[] | null;
  resolutionSummary: string | null;
  /** null means unassigned; never inferred from the creator. */
  ownerUserId: string | null;
  ownerEmail: string | null;
  createdBy: string;
  createdByEmail: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationEvidenceItem {
  id: string;
  investigationId: string;
  sourceType: InvestigationSourceType;
  sourceId: string;
  chunkIndex: number;
  sourceTitle: string;
  excerpt: string;
  /** null when the source genuinely has no timestamp of its own. */
  sourceCreatedAt: string | null;
  sourceMetadata: Record<string, unknown> | null;
  matchType: EvidenceMatchType;
  retrievalScore: number;
  similarity: number | null;
  relevance: EvidenceRelevance;
  inclusionReason: string;
  retrievalQuery: string;
  origin: EvidenceOrigin;
  addedBy: string | null;
  createdAt: string;
}

export interface InvestigationDetail {
  investigation: Investigation;
  activity: Array<{
    id: string;
    type: string;
    actorUserId: string | null;
    actorEmail: string | null;
    body: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  evidence: InvestigationEvidenceItem[];
}

export interface InvestigationList {
  investigations: Investigation[];
  total: number;
  limit: number;
  offset: number;
}

export interface TimelineEvent {
  id: string;
  kind: string;
  at: string;
  atSourceTime: boolean;
  title: string;
  detail: string | null;
  evidenceId: string | null;
  sourceType: InvestigationSourceType | null;
  relevance: EvidenceRelevance | null;
  correlations: TimelineCorrelation[];
}

export interface InvestigationTimeline {
  investigationId: string;
  windowStart: string | null;
  windowEnd: string | null;
  generatedAt: string;
  events: TimelineEvent[];
  summary: {
    total: number;
    clipped: boolean;
    undated: number;
    evidence: number;
    activity: number;
    bySourceType: Record<string, number>;
    correlations: Record<string, number>;
  };
}

export interface InvestigationAnalysis {
  id: string;
  investigationId: string;
  status: 'pending' | 'succeeded' | 'failed';
  failureReason: string | null;
  analysisVersion: number;
  provider: string;
  model: string;
  summary: string | null;
  keyObservations: string[];
  nextSteps: string[];
  insufficientEvidence: boolean;
  missingInformation: string[];
  generationMs: number | null;
  createdAt: string;
}

export interface AnalysisHypothesis {
  id: string;
  statement: string;
  rationale: string;
  status: HypothesisStatus;
  statusSource: 'model' | 'user';
  missingInformation: string[];
  verificationSteps: string[];
  analysisId: string | null;
}

export interface InvestigationAnalysisResult {
  analysis: InvestigationAnalysis | null;
  hypotheses: AnalysisHypothesis[];
}

export interface EvidenceCollectionSummary {
  failed: boolean;
  queries: string[];
  added: number;
  existing: number;
  filteredOut: number;
  withheld: number;
  warnings: string[];
}

/** Detail plus the summary of the collection that ran with the request. */
export interface InvestigationMutationResponse extends InvestigationDetail {
  collection?: EvidenceCollectionSummary | null;
  added?: boolean;
}

export interface CreateInvestigationInput {
  title: string;
  description: string;
  severity?: InvestigationSeverity;
  service?: string | null;
  errorSignature?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  sourceTypes?: InvestigationSourceType[] | null;
  ownerUserId?: string | null;
  collectEvidence?: boolean;
}

export interface UpdateInvestigationInput {
  title?: string;
  description?: string;
  severity?: InvestigationSeverity;
  service?: string | null;
  errorSignature?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  sourceTypes?: InvestigationSourceType[] | null;
  ownerUserId?: string | null;
  status?: InvestigationStatus;
  resolutionSummary?: string | null;
  expectedUpdatedAt?: string;
}

export type InvestigationOwnerFilter = 'me' | 'unassigned' | string;

export interface InvestigationListParams {
  status?: InvestigationStatus;
  severity?: InvestigationSeverity;
  service?: string;
  q?: string;
  owner?: InvestigationOwnerFilter;
  limit?: number;
  offset?: number;
}

export interface FollowUpCitation {
  evidenceId: string;
  sourceType: InvestigationSourceType;
  sourceTitle: string;
  relevance: EvidenceRelevance;
  sourceCreatedAt: string | null;
}

export interface FollowUpAnswer {
  activityId: string;
  question: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  insufficientContext: boolean;
  citations: FollowUpCitation[];
  analysisId: string | null;
  model: string;
  provider: string;
  generationMs: number;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Action items                                                        */
/* ------------------------------------------------------------------ */

export type ActionItemStatus = 'open' | 'in_progress' | 'blocked' | 'completed';
export type ActionItemPriority = 'low' | 'medium' | 'high' | 'critical';
export type ActionItemCreatedFrom = 'manual' | 'analysis';

/**
 * Follow-up work attached to one investigation. `createdFrom` distinguishes a
 * person's own item from one accepted from an analysis suggestion; it never means
 * the model created, executed or completed the work.
 */
export interface ActionItem {
  id: string;
  organizationId: string;
  investigationId: string;
  title: string;
  description: string | null;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  /** null means unassigned; never inferred from the creator. */
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  dueAt: string | null;
  blockedReason: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByEmail: string | null;
  createdFrom: ActionItemCreatedFrom;
  sourceAnalysisId: string | null;
  sourceHypothesisId: string | null;
  /** Immutable snapshot of the suggestion the item came from. */
  sourceLabel: string | null;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ActionItemEventType =
  | 'created'
  | 'status_change'
  | 'assignee_change'
  | 'priority_change'
  | 'due_change'
  | 'details_change';

export interface ActionItemEvent {
  id: string;
  type: ActionItemEventType;
  actorUserId: string | null;
  actorEmail: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActionItemDetail {
  item: ActionItem;
  events: ActionItemEvent[];
}

export interface ActionItemSummary {
  total: number;
  open: number;
  inProgress: number;
  blocked: number;
  completed: number;
  overdue: number;
}

export interface ActionItemList {
  items: ActionItem[];
  summary: ActionItemSummary;
  limit: number;
  offset: number;
}

export interface CreateActionItemInput {
  title: string;
  description?: string | null;
  priority?: ActionItemPriority;
  assigneeUserId?: string | null;
  dueAt?: string | null;
  createdFrom?: ActionItemCreatedFrom;
  sourceAnalysisId?: string | null;
  sourceHypothesisId?: string | null;
  sourceLabel?: string | null;
}

export interface UpdateActionItemInput {
  title?: string;
  description?: string | null;
  priority?: ActionItemPriority;
  assigneeUserId?: string | null;
  dueAt?: string | null;
  status?: ActionItemStatus;
  blockedReason?: string | null;
  expectedUpdatedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Operational overview                                                */
/* ------------------------------------------------------------------ */

export interface OperationsInvestigationRef {
  id: string;
  title: string;
  status: InvestigationStatus;
  severity: InvestigationSeverity;
  ownerUserId: string | null;
  ownerEmail: string | null;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface OperationsActionItemRef {
  id: string;
  title: string;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  dueAt: string | null;
  investigationId: string;
  investigationTitle: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface OperationsActionItemSummary extends ActionItemSummary {
  /** Unfinished and due within `dueSoonHours`. */
  dueSoon: number;
  assignedToMe: number;
  unassigned: number;
}

export interface OperationsOverview {
  dueSoonHours: number;
  investigations: {
    total: number;
    open: number;
    investigating: number;
    resolved: number;
    closed: number;
    assignedToMe: number;
    unassigned: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    recentlyUpdated: OperationsInvestigationRef[];
    recentlyResolved: OperationsInvestigationRef[];
  };
  actionItems: {
    summary: OperationsActionItemSummary;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    recentlyCompleted: OperationsActionItemRef[];
  };
}

/** An action item from the organization-wide queue, with its investigation. */
export interface OperationsActionItem extends ActionItem {
  investigationTitle: string;
}

export interface OperationsActionItemList {
  items: OperationsActionItem[];
  /** Organization-wide totals, independent of the active filters. */
  summary: OperationsActionItemSummary;
  total: number;
  limit: number;
  offset: number;
}

export interface OperationsActionItemParams {
  status?: ActionItemStatus;
  priority?: ActionItemPriority;
  assignee?: 'me' | 'unassigned' | string;
  due?: 'overdue' | 'due_soon';
  investigationId?: string;
  limit?: number;
  offset?: number;
}

/** A suggestion a person can accept; it does not become an item until submitted. */
export interface ActionItemSuggestion {
  title: string;
  sourceAnalysisId: string | null;
  sourceHypothesisId: string | null;
  sourceLabel: string;
}
