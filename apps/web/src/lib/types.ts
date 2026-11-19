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

export interface SearchResult {
  content: string;
  similarity: number;
  documentId: string;
  chunkIndex: number;
  preview: string;
}

export interface SearchResponse {
  query: string;
  totalResults: number;
  executionTimeMs: number;
  results: SearchResult[];
}

export interface RagSource {
  documentId: string;
  chunkIndex: number;
  similarity: number;
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
