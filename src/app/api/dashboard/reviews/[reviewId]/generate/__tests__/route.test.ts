// src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts
//
// T1 EVAL suite for #678 — the Generate door.
//
// **On-demand generation** (CONTEXT.md glossary, verbatim): owner-initiated LLM
// drafting from the **Reviews list** — `Generate` on a never-replied review,
// `Regenerate` on an already-replied one — governed by four already-existing
// layers: the per-owner-account rate limit (fails open), the per-review daily
// cap (`regen:{reviewId}:{date}`, 3/day — advisory peek at the route,
// authoritative Lua INCR in `generate-draft.ts:107`), and the per-business /
// global spend reservation. The first `Generate` on a review is free by
// construction (`generate-draft.ts` charges only `version > 1`).
//
// RED until Task 3 creates `../route.ts`: every title imports it dynamically, so
// each one fails on its own rather than the file failing to collect.
//
// Mocking shape mirrors src/app/api/dashboard/past-replies/__tests__/draft.test.ts
// — the named precedent for this route's in-transaction body.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { POST_AFTER_DELETE_FAILED_PREFIX } from '@/lib/publishing/orphan-markers';

// ── Hoisted shared state ─────────────────────────────────────────────────────

const {
  mockRequireRole,
  mockEnforceRegenLimit,
  mockEnforceRegenBudget,
  mockAssertWritable,
  mockAssertWritableTx,
  topQueue,
  topCalls,
  txQueue,
  txMock,
  beginMock,
  sqlProxy,
} = vi.hoisted(() => {
  const mockRequireRole = vi.fn();
  const mockEnforceRegenLimit = vi.fn();
  const mockEnforceRegenBudget = vi.fn();
  const mockAssertWritable = vi.fn();
  const mockAssertWritableTx = vi.fn();

  const topQueue: unknown[][] = [];
  const topCalls: { text: string; values: unknown[] }[] = [];
  const txQueue: unknown[][] = [];

  const txMock = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // statusArraySql(tx, …) composes a `${array}::text[]` FRAGMENT on the tx
      // instance (#729 — the extracted module receives only tx, so the fragment
      // is no longer built on the sql singleton). A fragment is embedded in its
      // parent query, never executed on its own — it must not consume a rowset.
      // Mock plumbing only (deviations D3); no behavioural assertion changes.
      if (strings.join('?') === '?::text[]') return { fragment: '?::text[]', values };
      return txQueue.shift() ?? [];
    },
  );
  // Postgres.js identity JSONB constructor — enqueueGenerateResponse binds the
  // payload through `tx.json(...)`, so mirror it as a pass-through and the
  // payload object lands in the captured template params.
  (txMock as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  const beginMock = vi.fn(async (cb: (tx: unknown) => Promise<Response>) => cb(txMock));

  const sqlTop = (strings: TemplateStringsArray, ...values: unknown[]) => {
    topCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(topQueue.shift() ?? []);
  };
  const sqlProxy = new Proxy(sqlTop, {
    get: (_target, prop) => (prop === 'begin' ? beginMock : undefined),
  });

  return {
    mockRequireRole,
    mockEnforceRegenLimit,
    mockEnforceRegenBudget,
    mockAssertWritable,
    mockAssertWritableTx,
    topQueue,
    topCalls,
    txQueue,
    txMock,
    beginMock,
    sqlProxy,
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

vi.mock('@/lib/db/server', () => ({ sql: sqlProxy, jsonb: (v: unknown) => v }));

vi.mock('@/lib/shared/dashboard-regen-rate-limit', () => ({
  enforceDashboardRegenRateLimit: (...args: unknown[]) => mockEnforceRegenLimit(...args),
  enforceRegenBudgetForReview: (...args: unknown[]) => mockEnforceRegenBudget(...args),
}));

vi.mock('@/lib/shared/writable-subscription', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shared/writable-subscription')>(
    '@/lib/shared/writable-subscription',
  );
  return {
    ...actual,
    assertWritableSubscriptionForAccount: (...args: unknown[]) => mockAssertWritable(...args),
    // The in-tx TOCTOU re-assert. Mocked so it issues no query of its own and
    // the txQueue seeding below stays a straight list of the route's guards.
    assertWritableSubscriptionForBusiness: (...args: unknown[]) => mockAssertWritableTx(...args),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
const APP_URL = 'http://localhost:3000';

function ownerUser() {
  return {
    id: 'user-1',
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
  };
}

function makeRequest(opts?: { origin?: string | null }): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const origin = opts && 'origin' in opts ? opts.origin : APP_URL;
  if (origin) headers['Origin'] = origin;
  return new NextRequest(
    `${APP_URL}/api/dashboard/reviews/${REVIEW_ID}/generate`,
    { method: 'POST', headers },
  );
}

const routeParams = { params: Promise.resolve({ reviewId: REVIEW_ID }) };

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<{ reviewId: string }> },
) => Promise<Response>;

async function importPOST(): Promise<RouteHandler> {
  const mod = await import('../route');
  return mod.POST as unknown as RouteHandler;
}

function seedOwned(rows: unknown[] = [{ business_id: LOCATION_ID }]): void {
  topQueue.push(rows);
}

function seedTxRows(...rowsets: unknown[][]): void {
  txQueue.push(...rowsets);
}

/**
 * lock → posted → existing draft → orphan → in-flight outbox → MAX(version) →
 * enqueue. The in-tx writable/offboarding re-assert sits between the lock and
 * the posted check but is mocked, so it consumes no rowset.
 */
function seedHappyPath(nextVersion = 1): void {
  seedTxRows([{ id: REVIEW_ID }], [], [], [], [], [{ next_version: nextVersion }], []);
}

function txCallTexts(): string[] {
  return txMock.mock.calls.map((call) => call[0].join('?').replace(/\s+/g, ' '));
}

function outboxInsertCalls(): [TemplateStringsArray, ...unknown[]][] {
  return txMock.mock.calls.filter((call) => call[0].join('?').includes('INSERT INTO job_outbox'));
}

interface OutboxPayload {
  review_id: string;
  business_id: string;
  version: number;
  origin_lane: string;
  suppress_notification?: boolean;
}

function lastOutboxPayload(): OutboxPayload {
  const call = outboxInsertCalls().at(-1);
  expect(call).toBeDefined();
  const payload = call!.slice(1).find(
    (arg): arg is OutboxPayload =>
      !!arg && typeof arg === 'object' && !Array.isArray(arg) && 'origin_lane' in arg,
  );
  expect(payload).toBeDefined();
  return payload!;
}

beforeEach(() => {
  vi.clearAllMocks();
  topQueue.length = 0;
  topCalls.length = 0;
  txQueue.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  mockRequireRole.mockResolvedValue(ownerUser());
  mockEnforceRegenLimit.mockResolvedValue(null);
  mockEnforceRegenBudget.mockResolvedValue(null);
  mockAssertWritable.mockResolvedValue({ ok: true });
  mockAssertWritableTx.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/dashboard/reviews/[reviewId]/generate', () => {
  it('POST generate enqueues a generate_response job on the on_demand_generate origin lane with suppress_notification true', async () => {
    seedOwned();
    seedHappyPath(1);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outbox_id).toMatch(/^[0-9a-f-]{36}$/);

    // The Origin lane value must EXIST — asserting only
    // `payload.origin_lane === GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE`
    // would pass vacuously (undefined === undefined) before Task 2 adds it.
    expect(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE).toBe('on_demand_generate');

    const payload = lastOutboxPayload();
    expect(payload.origin_lane).toBe(GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE);
    // Invariant #3: the on-demand lane and notification suppression are
    // independent exclusions in auto-approval.ts#isAutoApprovalCandidate.
    expect(payload.origin_lane).not.toBe(GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW);
    expect(payload.suppress_notification).toBe(true);
    expect(payload.review_id).toBe(REVIEW_ID);
    expect(payload.business_id).toBe(LOCATION_ID);

    const outboxCall = outboxInsertCalls().at(-1)!;
    expect(outboxCall.slice(1)).toContain(QUEUE_NAMES.GENERATE_RESPONSE);
    // Invariant #2: the enqueue is inside the route's own sql.begin.
    expect(beginMock).toHaveBeenCalledTimes(1);
  });

  it('POST generate computes the next version from MAX(version) so a discarded draft re-arms the regen budget', async () => {
    // D-B: hardcoding `1` would make every Generate free forever — discarding a
    // draft sets status='superseded' and RETAINS the row, so MAX(version) is
    // preserved and C1's per-review budget self-arms on the next attempt.
    seedOwned();
    seedHappyPath(4);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(200);
    expect(lastOutboxPayload().version).toBe(4);
    expect((await res.json()).version).toBe(4);
    expect(txCallTexts().some((text) => text.includes('COALESCE(MAX(version), 0) + 1'))).toBe(true);
  });

  it('POST generate returns 404 for a review owned by another account', async () => {
    seedOwned([]); // the tenant-scoped lookup finds nothing

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('review_not_found');
    // Never leak existence, and never open a transaction for a foreign review.
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('POST generate returns 404 for a review whose location is archived', async () => {
    seedOwned([]);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('review_not_found');
    // The archived filter is part of the ownership proof itself (invariant #8),
    // not a second query a refactor could drop.
    const lookup = topCalls[0];
    expect(lookup).toBeDefined();
    expect(lookup!.text).toMatch(/archived_at\s+IS\s+NULL/i);
    expect(lookup!.text).toMatch(/b\.account_id\s*=/i);
  });

  it('POST generate returns 409 already_answered when a posted response exists', async () => {
    seedOwned();
    // lock → posted sibling found
    seedTxRows([{ id: REVIEW_ID }], [{ id: 'resp-posted' }]);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_answered');
    // A posted sibling means the owner wants Regenerate (§6.4 replaces a LIVE
    // Google reply), not Generate.
    expect(outboxInsertCalls()).toHaveLength(0);
  });

  it('POST generate returns 409 draft_already_exists when a non-terminal response exists', async () => {
    seedOwned();
    seedTxRows(
      [{ id: REVIEW_ID }],
      [],
      [{ id: 'resp-draft', status: 'pending_approval' }],
    );

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('draft_already_exists');
    expect(body.existing).toEqual({ response_id: 'resp-draft', status: 'pending_approval' });
    expect(outboxInsertCalls()).toHaveLength(0);
  });

  it('POST generate returns 409 regenerate_in_progress when an in-flight outbox row exists', async () => {
    seedOwned();
    // lock → posted → existing draft → orphan → in-flight outbox found
    seedTxRows([{ id: REVIEW_ID }], [], [], [], [{ exists: 1 }]);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('regenerate_in_progress');
    expect(outboxInsertCalls()).toHaveLength(0);
    // Byte-for-byte in-flight contract (job-outbox-status.ts) — members AND order.
    expect(
      txCallTexts().some((text) => text.includes("'pending', 'dispatching', 'dispatched'")),
    ).toBe(true);
  });

  it('POST generate enforces the shared per-owner dashboard regen rate limit before enqueueing', async () => {
    // C3: the THIRD caller of the shared per-owner counter, and it fires BEFORE
    // any DB work — matching regenerate/route.ts.
    mockEnforceRegenLimit.mockResolvedValueOnce(
      NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
    );

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('rate_limited');
    expect(mockEnforceRegenLimit).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(topCalls).toHaveLength(0); // no DB work at all
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('POST generate returns 429 regen_limit_reached when the per-review daily budget peek is exhausted', async () => {
    seedOwned();
    mockEnforceRegenBudget.mockResolvedValueOnce(
      NextResponse.json(
        { error: 'regen_limit_reached', remaining: 0, limit: 3 },
        { status: 429 },
      ),
    );

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('regen_limit_reached');
    expect(body.remaining).toBe(0);
    expect(mockEnforceRegenBudget).toHaveBeenCalledWith(REVIEW_ID);
    // Read-only peek: refusing consumes no budget and opens no transaction.
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('POST generate rejects a cross-origin request', async () => {
    const POST = await importPOST();
    const res = await POST(makeRequest({ origin: 'https://evil.example.com' }), routeParams);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('POST generate returns 403 when the account is offboarding-blocked', async () => {
    seedOwned();
    // ONE guard, not two: assertWritableSubscriptionForAccount resolves the
    // offboarding state in the SAME query (LEFT JOIN account_offboardings).
    mockAssertWritable.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'account_offboarding_blocked',
    });

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('account_offboarding_blocked');
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('POST generate returns the writable-subscription error for a cancelled account', async () => {
    seedOwned();
    mockAssertWritable.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'subscription_inactive',
    });

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('subscription_inactive');
    expect(mockAssertWritable).toHaveBeenCalledWith(ACCOUNT_ID, expect.anything());
    expect(beginMock).not.toHaveBeenCalled();
  });

  it('POST generate re-asserts the writable-subscription gate inside the locked transaction', async () => {
    // TOCTOU: the pre-tx check can go stale if an offboarding is confirmed
    // between it and the commit, and what commits is a CHARGEABLE LLM enqueue.
    // Same shape as the approve/edit actions in approval/http-routes.ts.
    seedOwned();
    seedHappyPath(1);
    mockAssertWritableTx.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'account_offboarding_blocked',
    });

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('account_offboarding_blocked');
    // The pre-tx gate said OK, so only the in-tx re-assert can have refused it.
    expect(mockAssertWritable).toHaveReturned();
    expect(mockAssertWritableTx).toHaveBeenCalledWith(LOCATION_ID, expect.anything());
    expect(beginMock).toHaveBeenCalledTimes(1);
    expect(outboxInsertCalls()).toHaveLength(0);
  });

  it('POST generate returns 409 orphan_recovery_pending for an orphan review', async () => {
    // An orphan (post_after_delete_failed_* sibling, no posted sibling) is the
    // Reviews list `recover` row state. The list never offers Generate on it,
    // but a hand-crafted same-origin POST reaches here — and the draft it would
    // create makes past-replies/[responseId]/retry 409 `newer_draft_exists`,
    // blocking the owner's /retry + /restore-original recovery path.
    seedOwned();
    // lock → posted → existing draft → orphan sibling found
    seedTxRows([{ id: REVIEW_ID }], [], [], [{ id: 'fail-orphan' }]);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('orphan_recovery_pending');
    expect(outboxInsertCalls()).toHaveLength(0);
    // The marker prefix comes from orphan-markers.ts, never a re-typed literal.
    expect(
      txCallTexts().some((text) => text.includes('posting_error LIKE')),
    ).toBe(true);
    const orphanCall = txMock.mock.calls.find((call) =>
      call[0].join('?').includes('posting_error LIKE'),
    );
    expect(orphanCall!.slice(1)).toContain(`${POST_AFTER_DELETE_FAILED_PREFIX}%`);
  });

  it('POST generate serializes two simultaneous clicks for one review and commits exactly one generate_response job', async () => {
    // The reviews-row FOR UPDATE is what serializes them: the second click
    // blocks until the first commits, then sees its in-flight outbox row.
    seedOwned();
    seedHappyPath(1);
    const POST = await importPOST();
    const first = await POST(makeRequest(), routeParams);
    expect(first.status).toBe(200);

    // The lock must be the FIRST statement of the transaction — anything before
    // it reads state the other click can still change.
    const firstTxStatement = txCallTexts()[0];
    expect(firstTxStatement).toMatch(/SELECT id FROM reviews/i);
    expect(firstTxStatement).toMatch(/FOR UPDATE/i);

    // Second click, post-commit: the in-flight guard refuses it.
    seedOwned();
    seedTxRows([{ id: REVIEW_ID }], [], [], [], [{ exists: 1 }]);
    const second = await POST(makeRequest(), routeParams);

    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('regenerate_in_progress');
    expect(outboxInsertCalls()).toHaveLength(1);
  });

  it('Generate racing live-ingest regeneration for the same unanswered review leaves exactly one in-flight generate_response version', async () => {
    // D2 — pinned here, FIXED in #680. `process-review.ts` re-derives the
    // version on a content change and never checks job_outbox, so the race can
    // still cost a wasted LLM call in the other direction. The direction this
    // door owns is closed: a Generate arriving while a live-ingest
    // generate_response row is in flight adds no second version.
    seedOwned();
    seedTxRows([{ id: REVIEW_ID }], [], [], [], [{ exists: 1 }]);

    const POST = await importPOST();
    const res = await POST(makeRequest(), routeParams);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('regenerate_in_progress');
    expect(outboxInsertCalls()).toHaveLength(0);
  });
});
