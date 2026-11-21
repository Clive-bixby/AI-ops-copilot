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

export interface ApiHealth {
  healthy: boolean;
  ollamaUrl: string;
  model: string;
  message: string;
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
