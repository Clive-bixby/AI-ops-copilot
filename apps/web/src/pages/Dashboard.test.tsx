import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../lib/authProvider';
import type { OperationsOverview, Overview } from '../lib/types';
import { Dashboard } from './Dashboard';

/**
 * Regression for the AI-health blind spot the audit fixed earlier: the API
 * answers 503 with a full payload when generation cannot answer, and the cards
 * must render that payload (which model, and why) instead of an error sentence.
 *
 * A 503 is therefore asserted twice: the dashboard shows the degraded values,
 * and no card displays `Request failed (503)`.
 */

const OVERVIEW: Overview = {
  documents: {
    total: 4,
    processed: 3,
    processing: 1,
    pending: 0,
    failed: 0,
    chunks: 20,
    lastIngestedAt: '2026-11-26T10:00:00.000Z',
  },
  logs: {
    total: 10,
    errors: 1,
    warnings: 2,
    lastSeenAt: '2026-11-26T10:00:00.000Z',
    byLevel: { error: 1, info: 9 },
  },
  tickets: {
    total: 2,
    open: 1,
    urgentOpen: 0,
    lastCreatedAt: '2026-11-26T10:00:00.000Z',
    byStatus: { open: 1, closed: 1 },
    byPriority: { high: 1, low: 1 },
  },
};

const OPERATIONS: OperationsOverview = {
  dueSoonHours: 24,
  investigations: {
    total: 0,
    open: 0,
    investigating: 0,
    resolved: 0,
    closed: 0,
    assignedToMe: 0,
    unassigned: 0,
    byStatus: {},
    bySeverity: {},
    recentlyUpdated: [],
    recentlyResolved: [],
  },
  actionItems: {
    summary: {
      total: 0,
      open: 0,
      inProgress: 0,
      blocked: 0,
      completed: 0,
      overdue: 0,
      dueSoon: 0,
      assignedToMe: 0,
      unassigned: 0,
    },
    byStatus: {},
    byPriority: {},
    recentlyCompleted: [],
  },
};

const HEALTH_503 = {
  healthy: false,
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimensions: 768,
  endpoint: 'http://127.0.0.1:11434',
  message: 'The embedding model is not installed',
  generation: {
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    fallback: null,
    error:
      'The configured generation model "gemini-1.5-pro" was shut down by Google on 2025-09-29.',
  },
};

function routeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const route = routes[path];
    const status = route?.status ?? 404;

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body ?? { error: 'not found' },
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

describe('dashboard AI health cards', () => {
  it('renders the 503 payload as degraded status instead of an error', async () => {
    const fetchMock = routeFetch({
      '/insights/overview': { status: 200, body: OVERVIEW },
      '/insights/operations': { status: 200, body: OPERATIONS },
      '/logs': { status: 200, body: [] },
      '/tickets': { status: 200, body: [] },
      '/api/status': {
        status: 200,
        body: { service: 'api', version: '1.0.0', environment: 'test' },
      },
      '/ai/health': { status: 503, body: HEALTH_503 },
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <Dashboard />
        </AuthProvider>
      </MemoryRouter>
    );

    // Embedding half of the payload.
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('model missing')).toBeInTheDocument();

    // Generation half: the retired model and its reason reach the card.
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('analysis will fail')).toBeInTheDocument();
    expect(screen.getByText(/was shut down by Google/)).toBeInTheDocument();

    expect(screen.queryByText(/Request failed \(503\)/)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/ai/health'))
    ).toBe(true);
  });
});
