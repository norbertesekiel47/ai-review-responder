import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── /api/admin/jobs route — queue-health now fetched from the Railway worker ──
//
// The route no longer touches BullMQ/Redis (invariant #1). It fetches the worker's
// authed /internal/queue-health endpoint server-side and degrades to
// queueHealth:{unavailable:true} on any failure. Outbox + failed-job parts still
// come from Postgres (mocked sql here).

const { mockSql, sqlReturnQueue, mockGetServerConfig, configState, mockFetch } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const configState: { WORKER_INTERNAL_SECRET?: string; WORKER_PUBLIC_URL?: string } = {};
  return {
    sqlReturnQueue,
    configState,
    mockSql: vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
      const r = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(Array.isArray(r) ? r : [r]);
    }),
    mockGetServerConfig: vi.fn(() => configState),
    mockFetch: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('@/lib/config/server', () => ({ getServerConfig: mockGetServerConfig }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));
vi.mock('@/lib/auth/route-helpers', () => ({
  requireRoleOr401: vi.fn().mockResolvedValue({ ok: true, user: { id: 'admin' } }),
}));

import { GET } from '@/app/api/admin/jobs/route';

const SECRET = 'a'.repeat(64);
const WORKER_URL = 'https://worker.example.com';

function seedOutboxRows(): void {
  sqlReturnQueue.push(
    [{ pending: 1, dispatching: 0, dispatched: 2, failed: 3, completed_today: 4 }],
    [],
    [{ total: 3 }],
  );
}

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/jobs');
}

describe('GET /api/admin/jobs queueHealth sourcing', () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    configState.WORKER_INTERNAL_SECRET = SECRET;
    configState.WORKER_PUBLIC_URL = WORKER_URL;
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('surfaces per-queue depths from the worker on success and preserves outbox shape', async () => {
    const queues = {
      generate_response: { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 9, paused: 0 },
      publish_response: { waiting: 0, active: 0, delayed: 0, failed: 1, completed: 4, paused: 0 },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ queues }) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queueHealth).toEqual(queues);
    expect(body.outbox).toEqual({ pending: 1, dispatching: 0, dispatched: 2, failed: 3, completedToday: 4 });
    expect(body.failedTotal).toBe(3);

    // Bearer secret + correct worker path + short timeout.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe(`${WORKER_URL}/internal/queue-health`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('degrades to {unavailable:true} when WORKER_INTERNAL_SECRET is unset (no fetch)', async () => {
    configState.WORKER_INTERNAL_SECRET = undefined;
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('degrades to {unavailable:true} when WORKER_PUBLIC_URL is unset (no fetch)', async () => {
    configState.WORKER_PUBLIC_URL = undefined;
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('degrades to {unavailable:true} on a non-200 worker response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });

  it('degrades to {unavailable:true} on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });

  it('degrades to {unavailable:true} on a fetch timeout (AbortError)', async () => {
    const abort = new DOMException('The operation timed out', 'TimeoutError');
    mockFetch.mockRejectedValue(abort);
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });

  it('degrades to {unavailable:true} when the worker response omits queues', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });
});
