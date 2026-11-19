import type {
  ApiHealth,
  AskResponse,
  DecodedToken,
  DocumentDetail,
  DocumentSummary,
  IngestLogsResponse,
  IngestTicketsResponse,
  LogEntry,
  LoginResponse,
  MembersResponse,
  Overview,
  RootStatus,
  SearchResponse,
  Session,
  SystemStatus,
  Ticket,
} from './types';

export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  'http://localhost:5000';

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
};
