import type {
  ActionItemDetail,
  ActionItemList,
  AnalysisHypothesis,
  ApiHealth,
  AskResponse,
  CreateActionItemInput,
  CreateInvestigationInput,
  DecodedToken,
  DocumentDetail,
  DocumentSummary,
  FollowUpAnswer,
  IngestLogsResponse,
  IngestTicketsResponse,
  InvestigationAnalysisResult,
  InvestigationDetail,
  InvestigationList,
  InvestigationListParams,
  InvestigationMutationResponse,
  InvestigationTimeline,
  LogEntry,
  LoginResponse,
  MembersResponse,
  OperationsActionItemList,
  OperationsActionItemParams,
  OperationsOverview,
  Overview,
  RootStatus,
  SearchResponse,
  Session,
  SystemStatus,
  Ticket,
  UpdateActionItemInput,
  UpdateInvestigationInput,
} from './types';

export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  'http://localhost:3000';

const TOKEN_KEY = 'jwt';
const ORG_KEY = 'orgId';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) {
    return `Cannot reach the OpsPilot API at ${API_URL}. Is the server running?`;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getOrgId(): string | null {
  return localStorage.getItem(ORG_KEY);
}

export function storeSession(token: string, organizationId: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ORG_KEY, organizationId);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ORG_KEY);
}

export function decodeToken(token: string): DecodedToken | null {
  try {
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join('')
    );
    return JSON.parse(jsonPayload) as DecodedToken;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const orgId = getOrgId();
  const headers = new Headers(options.headers ?? {});

  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (orgId) headers.set('x-organization-id', orgId);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The API request timed out.', 0);
    }
    throw new ApiError(
      `Cannot reach the OpsPilot API at ${API_URL}. Is the server running?`,
      0
    );
  }

  if (response.status === 401) {
    window.dispatchEvent(new Event('opspilot:unauthorized'));
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    register: (email: string, password: string, organizationName: string) =>
      request<LoginResponse>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, organizationName }),
      }),
    me: () => request<Session>('/auth/me'),
  },

  status: () => request<SystemStatus>('/api/status'),
  root: () => request<RootStatus>('/'),

  insights: {
    overview: () => request<Overview>('/insights/overview'),
    operations: () => request<OperationsOverview>('/insights/operations'),
    actionItems: (params: OperationsActionItemParams = {}) => {
      const search = new URLSearchParams();
      if (params.status) search.set('status', params.status);
      if (params.priority) search.set('priority', params.priority);
      if (params.assignee) search.set('assignee', params.assignee);
      if (params.due) search.set('due', params.due);
      if (params.investigationId) search.set('investigationId', params.investigationId);
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.offset !== undefined) search.set('offset', String(params.offset));
      const query = search.toString();
      return request<OperationsActionItemList>(
        `/insights/action-items${query ? `?${query}` : ''}`
      );
    },
  },

  documents: {
    list: () => request<DocumentSummary[]>('/documents'),
    get: (id: string) =>
      request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`),
    upload: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return request<{ id: string; filename: string; createdAt: string }>(
        '/documents/upload',
        { method: 'POST', body: formData }
      );
    },
  },

  logs: {
    list: () => request<LogEntry[]>('/logs'),
    ingest: (payload: unknown) =>
      request<IngestLogsResponse>('/logs/ingest', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  tickets: {
    list: () => request<Ticket[]>('/tickets'),
    ingest: (payload: unknown) =>
      request<IngestTicketsResponse>('/tickets/ingest', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  ai: {
    health: () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8000);
      return request<ApiHealth>('/ai/health', { signal: controller.signal }).finally(() =>
        window.clearTimeout(timer)
      );
    },
    search: (query: string, limit: number) =>
      request<SearchResponse>('/ai/search', {
        method: 'POST',
        body: JSON.stringify({ query, limit }),
      }),
    ask: (question: string) =>
      request<AskResponse>('/ai/ask', {
        method: 'POST',
        body: JSON.stringify({ question }),
      }),
  },

  admin: {
    members: () => request<MembersResponse>('/admin/members'),
  },

  organization: {
    members: () => request<MembersResponse>('/organization/members'),
  },

  investigations: {
    list: (params: InvestigationListParams = {}) => {
      const search = new URLSearchParams();
      if (params.status) search.set('status', params.status);
      if (params.severity) search.set('severity', params.severity);
      if (params.service) search.set('service', params.service);
      if (params.q) search.set('q', params.q);
      if (params.owner) search.set('owner', params.owner);
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.offset !== undefined) search.set('offset', String(params.offset));
      const query = search.toString();
      return request<InvestigationList>(`/investigations${query ? `?${query}` : ''}`);
    },
    get: (id: string) =>
      request<InvestigationDetail>(`/investigations/${encodeURIComponent(id)}`),
    create: (payload: CreateInvestigationInput) =>
      request<InvestigationMutationResponse>('/investigations', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (id: string, payload: UpdateInvestigationInput) =>
      request<InvestigationDetail>(`/investigations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    timeline: (id: string) =>
      request<InvestigationTimeline>(
        `/investigations/${encodeURIComponent(id)}/timeline`
      ),
    analysis: (id: string) =>
      request<InvestigationAnalysisResult>(
        `/investigations/${encodeURIComponent(id)}/analysis`
      ),
    analyze: (id: string) =>
      request<InvestigationAnalysisResult>(
        `/investigations/${encodeURIComponent(id)}/analyze`,
        { method: 'POST' }
      ),
    updateHypothesis: (id: string, hypothesisId: string, status: AnalysisHypothesis['status']) =>
      request<{ hypothesis: AnalysisHypothesis }>(
        `/investigations/${encodeURIComponent(id)}/hypotheses/${encodeURIComponent(hypothesisId)}`,
        { method: 'PATCH', body: JSON.stringify({ status }) }
      ),
    collectEvidence: (id: string) =>
      request<InvestigationMutationResponse>(
        `/investigations/${encodeURIComponent(id)}/evidence/collect`,
        { method: 'POST' }
      ),
    linkEvidence: (
      id: string,
      payload: { sourceType: 'document' | 'log' | 'ticket'; sourceId: string; reason?: string | null }
    ) =>
      request<InvestigationMutationResponse>(
        `/investigations/${encodeURIComponent(id)}/evidence`,
        { method: 'POST', body: JSON.stringify(payload) }
      ),
    unlinkEvidence: (id: string, evidenceId: string) =>
      request<void>(
        `/investigations/${encodeURIComponent(id)}/evidence/${encodeURIComponent(evidenceId)}`,
        { method: 'DELETE' }
      ),
    createNote: (id: string, body: string) =>
      request<{ activity: InvestigationDetail['activity'][number] }>(
        `/investigations/${encodeURIComponent(id)}/notes`,
        { method: 'POST', body: JSON.stringify({ body }) }
      ),
    createComment: (id: string, body: string) =>
      request<{ activity: InvestigationDetail['activity'][number] }>(
        `/investigations/${encodeURIComponent(id)}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) }
      ),
    listQuestions: (id: string) =>
      request<{ questions: FollowUpAnswer[] }>(
        `/investigations/${encodeURIComponent(id)}/questions`
      ),
    askQuestion: (id: string, question: string) =>
      request<FollowUpAnswer>(
        `/investigations/${encodeURIComponent(id)}/questions`,
        { method: 'POST', body: JSON.stringify({ question }) }
      ),
  },

  actionItems: {
    list: (
      investigationId: string,
      params: {
        status?: string;
        priority?: string;
        assignee?: string;
        limit?: number;
        offset?: number;
      } = {}
    ) => {
      const search = new URLSearchParams();
      if (params.status) search.set('status', params.status);
      if (params.priority) search.set('priority', params.priority);
      if (params.assignee) search.set('assignee', params.assignee);
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.offset !== undefined) search.set('offset', String(params.offset));
      const query = search.toString();
      return request<ActionItemList>(
        `/investigations/${encodeURIComponent(investigationId)}/action-items${
          query ? `?${query}` : ''
        }`
      );
    },
    get: (investigationId: string, actionItemId: string) =>
      request<ActionItemDetail>(
        `/investigations/${encodeURIComponent(
          investigationId
        )}/action-items/${encodeURIComponent(actionItemId)}`
      ),
    create: (investigationId: string, payload: CreateActionItemInput) =>
      request<ActionItemDetail>(
        `/investigations/${encodeURIComponent(investigationId)}/action-items`,
        { method: 'POST', body: JSON.stringify(payload) }
      ),
    update: (
      investigationId: string,
      actionItemId: string,
      payload: UpdateActionItemInput
    ) =>
      request<ActionItemDetail>(
        `/investigations/${encodeURIComponent(
          investigationId
        )}/action-items/${encodeURIComponent(actionItemId)}`,
        { method: 'PATCH', body: JSON.stringify(payload) }
      ),
  },
};
