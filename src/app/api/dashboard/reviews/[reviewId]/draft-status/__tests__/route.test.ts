// src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts
//
// T1 EVAL suite for #678 — the reviewId-keyed poller for **On-demand
// generation**.
//
// D-C: deliberately NOT the existing `past-replies/draft-status`. That one
// returns 503 `feature_disabled` when EDIT_REPLIES_ENABLED is off (Generate must
// not depend on that flag — it never touches a live Google reply) and is keyed
// on `outbox_id`, which is client state a refresh loses. Keying on `reviewId` is
// what makes `Generating…` survive a page refresh.
//
// RED until Task 3 creates `../route.ts`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

// ── Hoisted shared state ─────────────────────────────────────────────────────

const {
  mockRequireRole,
  mockGetRequestScope,
  ownerQueue,
  ownerCalls,
  readQueue,
  readCalls,
  sqlProxy,
  sqlReadProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockGetRequestScope = vi.fn();

  const ownerQueue: unknown[][] = [];
  const ownerCalls: { text: string; values: unknown[] }[] = [];
  const readQueue: unknown[][] = [];
  const readCalls: { text: string; values: unknown[] }[] = [];

  // sql (write pool): only the `statusArraySql` fragment binding survives here.
  // This handler writes nothing and is polled every ~1.5s, so every QUERY —
  // including the tenant-ownership proof — runs on the read bulkhead below.
  const sqlMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    ownerCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(ownerQueue.shift() ?? []);
  });
  const sqlProxy = new Proxy(sqlMock, {
    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
  });

  // sqlRead (read bulkhead): the tenant proof, the draft lookup, the outbox lookup.
  const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    readCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(readQueue.shift() ?? []);
  });
  const sqlReadProxy = new Proxy(sqlReadMock, {
    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
  });

  return {
    mockRequireRole,
    mockGetRequestScope,
    ownerQueue,
    ownerCalls,
    readQueue,
    readCalls,
    sqlProxy,
    sqlReadProxy,
  };
});

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
});

vi.mock('@/lib/db/server', () => ({
  sql: sqlProxy,
  sqlRead: sqlReadProxy,
  jsonb: (v: unknown) => v,
}));

// Mocked purely so the "must never be consulted" assertion below has something
// to observe: this poller is ACCOUNT-scoped, not current-location-scoped.
vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const APP_URL = 'http://localhost:3000';

function makeRequest(locationScopeCookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (locationScopeCookie) headers['Cookie'] = `rw_location_scope=${locationScopeCookie}`;
  return new NextRequest(
    `${APP_URL}/api/dashboard/reviews/${REVIEW_ID}/draft-status`,
    { method: 'GET', headers },
  );
}

const routeParams = { params: Promise.resolve({ reviewId: REVIEW_ID }) };

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<{ reviewId: string }> },
) => Promise<Response>;

async function importGET(): Promise<RouteHandler> {
  const mod = await import('../route');
  return mod.GET as unknown as RouteHandler;
}

/** The tenant-ownership proof is the FIRST read-bulkhead query of the handler. */
function seedOwned(rows: unknown[] = [{ business_id: LOCATION_ID }]): void {
  readQueue.push(rows);
}

function seedRead(...rowsets: unknown[][]): void {
  readQueue.push(...rowsets);
}

beforeEach(() => {
  vi.clearAllMocks();
  ownerQueue.length = 0;
  ownerCalls.length = 0;
  readQueue.length = 0;
  readCalls.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mockRequireRole.mockResolvedValue({
    id: 'user-1',
    name: 'Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
  });
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.EDIT_REPLIES_ENABLED;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/dashboard/reviews/[reviewId]/draft-status', () => {
  it('GET draft-status returns 404 without querying draft text for a review owned by another account', async () => {
    seedOwned([]);

    const GET = await importGET();
    const res = await GET(makeRequest(), routeParams);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('review_not_found');
    // Tenant proof runs FIRST: a caller can never observe another account's
    // generation status or draft text, not even as a timing difference. It is
    // the ONLY query issued — nothing reached `responses` or `job_outbox`.
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]!.text).toMatch(/b\.account_id\s*=/i);
    expect(readCalls[0]!.text).toMatch(/archived_at\s+IS\s+NULL/i);
    expect(readCalls.some((call) => /FROM\s+responses/i.test(call.text))).toBe(false);
    expect(readCalls.some((call) => /job_outbox/i.test(call.text))).toBe(false);
  });

  it('GET draft-status returns generating, ready, failed, and idle from the authoritative review state', async () => {
    const GET = await importGET();

    // ready — a live non-terminal response, not held.
    seedOwned();
    seedRead([{ id: 'resp-1', status: 'pending_approval', response_text: 'Draft text', held: false }]);
    const ready = await GET(makeRequest(), routeParams);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ready',
      response_id: 'resp-1',
      response_text: 'Draft text',
    });

    // generating — no draft yet, outbox row in flight.
    seedOwned();
    seedRead([], [{ status: 'pending', last_error: null }]);
    const generating = await GET(makeRequest(), routeParams);
    expect((await generating.json()).status).toBe('generating');
    expect(readCalls.some((call) => call.values.includes(QUEUE_NAMES.GENERATE_RESPONSE))).toBe(true);

    // failed — terminal-but-not-completed outbox row surfaces last_error.
    seedOwned();
    seedRead([], [{ status: 'failed', last_error: 'llm_terminal' }]);
    const failed = await GET(makeRequest(), routeParams);
    expect(await failed.json()).toEqual({ status: 'failed', error: 'llm_terminal' });

    // idle — nothing in flight and no draft. The poller must stop.
    seedOwned();
    seedRead([], []);
    const idle = await GET(makeRequest(), routeParams);
    expect((await idle.json()).status).toBe('idle');
  });

  it('GET draft-status resumes a draft in another active location owned by the same account regardless of current-location cookie', async () => {
    // The INTENDED authorization model (F4): same-account sibling-location
    // access is correct, not a leak — only cross-account is a leak. The Reviews
    // list row carries the reviewId, so a refresh resumes the poll even when the
    // rw_location_scope cookie points at a different location.
    seedOwned([{ business_id: ALT_LOCATION_ID }]);
    seedRead([{ id: 'resp-alt', status: 'pending_approval', response_text: 'Alt draft', held: false }]);

    const GET = await importGET();
    const res = await GET(makeRequest(LOCATION_ID), routeParams);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.response_id).toBe('resp-alt');
    // Account-scoped, never cookie-scoped.
    expect(mockGetRequestScope).not.toHaveBeenCalled();
    expect(readCalls.some((call) => call.values.includes(ALT_LOCATION_ID))).toBe(true);
  });

  it('GET draft-status never returns response_text or ready for a moderation-held response', async () => {
    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
    // pending_approval with an OPEN flagged_responses row. Returning it as
    // `ready` would hand the owner held text plus an `Approve & post` button —
    // the exact release path src/lib/moderation/held-draft.ts exists to block.
    // The `held` flag is SELECTed, not filtered (D6/D9): filtering would make
    // this route report `idle` for "no draft" and "held draft" alike.
    seedOwned();
    seedRead([{ id: 'resp-held', status: 'pending_approval', response_text: 'Held text', held: true }]);

    const GET = await importGET();
    const res = await GET(makeRequest(), routeParams);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('idle');
    expect(body.status).not.toBe('ready');
    expect(body).not.toHaveProperty('response_text');
    expect(JSON.stringify(body)).not.toContain('Held text');
    // The hold must be read from flagged_responses, not inferred. Read call 0
    // is the tenant proof; call 1 is the draft lookup that carries the predicate.
    expect(readCalls[1]!.text).toContain('flagged_responses');
  });
});
