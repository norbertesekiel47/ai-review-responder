// Route-level tests for the three owner verbs of the send lane (#629
// approve/halt, #860 regenerate).
//
// `@/lib/auth/route-helpers` is deliberately NOT mocked: `withSameOrigin` is the
// CSRF guard two of these tests assert, and `requireWritableOwner`'s
// subscription decision is what two others assert. Both run for real, mocked one
// level lower instead — `requireRole` (identity) and the `sql` tagged template
// (the `accounts` row the writable gate reads). Mocking `requireWritableOwner`
// itself would leave the trialing test asserting nothing about `trialing`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockAccountRows,
  mockGetLocationById,
  mockMultiLocationEnabled,
  mockApproveBatch,
  mockHaltBatch,
  mockRequestAskRegeneration,
  mockWithdrawAsk,
  mockPeekAskRegenBudget,
  mockEnforceRegenLimit,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockAccountRows: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockMultiLocationEnabled: vi.fn(() => false),
  mockApproveBatch: vi.fn(),
  mockHaltBatch: vi.fn(),
  mockRequestAskRegeneration: vi.fn(),
  mockWithdrawAsk: vi.fn(),
  mockPeekAskRegenBudget: vi.fn(),
  mockEnforceRegenLimit: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    AuthError,
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
  };
});

// Tagged-template stub. The only consumer inside these routes' import graph is
// the real writable-subscription gate's `accounts` read — every other DB caller
// (the location repo, approveBatch/haltBatch) is mocked below.
vi.mock('@/lib/db/server', () => ({
  sql: (..._args: unknown[]) => Promise.resolve(mockAccountRows()),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: (...args: unknown[]) => mockGetLocationById(...args),
}));

vi.mock('@/lib/locations/flags', () => ({
  multiLocationEnabled: () => mockMultiLocationEnabled(),
}));

vi.mock('@/lib/solicitation/approval', () => ({
  approveBatch: (...args: unknown[]) => mockApproveBatch(...args),
  haltBatch: (...args: unknown[]) => mockHaltBatch(...args),
  requestAskRegeneration: (...args: unknown[]) => mockRequestAskRegeneration(...args),
  withdrawAsk: (...args: unknown[]) => mockWithdrawAsk(...args),
}));

// Only the per-ASK peek is stubbed; the review-lane sibling is re-exported so
// the real `dashboard-regen-rate-limit` module below still resolves its import.
vi.mock('@/lib/costs/tracker', () => ({
  peekAskRegenBudgetBatch: (...args: unknown[]) => mockPeekAskRegenBudget(...args),
  peekRegenBudgetBatch: () => Promise.resolve(new Map()),
}));

// PARTIAL mock: only the per-owner limiter is stubbed, because it would
// otherwise reach a real Redis via REDIS_CACHE_URL and make these tests depend
// on the developer's machine. `askRegenLimitResponse` stays REAL — the 429 test
// asserts its body verbatim, so stubbing it would assert nothing.
vi.mock('@/lib/shared/dashboard-regen-rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shared/dashboard-regen-rate-limit')>(
    '@/lib/shared/dashboard-regen-rate-limit',
  );
  return {
    ...actual,
    enforceDashboardRegenRateLimit: (...args: unknown[]) => mockEnforceRegenLimit(...args),
  };
});

import { SOLICITATION_SCOPE_PARAM } from '@/app/api/dashboard/solicitation/scope-param';
import { POST as APPROVE } from '../approve/route';
import { POST as HALT } from '../halt/route';
import { POST as REGENERATE } from '../regenerate/route';
import { POST as WITHDRAW } from '../withdraw/route';

const APP_URL = 'http://localhost:3000';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = '01900000-0000-7000-8000-0000000000a1';
const DEFAULT_LOCATION_ID = '01900000-0000-7000-8000-0000000000d1';
const BATCH_ID = '01900000-0000-7000-8000-000000000001';
const ASK_ID = '01900000-0000-7000-8000-0000000000f1';

function owner() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: DEFAULT_LOCATION_ID,
  };
}

/** One `accounts` row as the writable-subscription gate projects it: no active
 *  offboarding, so only `subscription_status` decides. */
function accountRow(subscriptionStatus: string) {
  return [
    {
      subscription_status: subscriptionStatus,
      past_due_at: null,
      flags: {},
      offboarding_id: null,
      offboarding_account_id: null,
      offboarding_mode: null,
      offboarding_status: null,
      offboarding_failed_step: null,
      offboarding_access_ends_at: null,
      offboarding_teardown_started_at: null,
      offboarding_purge_after: null,
      offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    },
  ];
}

function post(
  path: 'approve' | 'halt' | 'regenerate' | 'withdraw',
  options: { query?: string; body?: unknown; origin?: string } = {},
): NextRequest {
  // `regenerate` and `withdraw` are the two bodies that are more than a batch
  // id — their ask id is required, so the default has to carry one or every
  // case would 404 at the parse boundary instead of reaching the behaviour it
  // is about.
  const defaultBody =
    path === 'regenerate' || path === 'withdraw'
      ? { batchId: BATCH_ID, askId: ASK_ID }
      : { batchId: BATCH_ID };
  return new NextRequest(
    `${APP_URL}/api/dashboard/solicitation/batch/${path}${options.query ?? ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: options.origin ?? APP_URL,
      },
      body: JSON.stringify(options.body ?? defaultBody),
    },
  );
}

beforeEach(() => {
  vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'true');
  vi.stubEnv('SOLICITATION_SEND_ENABLED', 'true');
  mockRequireRole.mockResolvedValue(owner());
  mockAccountRows.mockReturnValue(accountRow('active'));
  mockMultiLocationEnabled.mockReturnValue(false);
  mockGetLocationById.mockImplementation((_sql: unknown, locationId: string) =>
    Promise.resolve({ id: locationId, account_id: ACCOUNT_ID, archived_at: null }),
  );
  mockApproveBatch.mockResolvedValue({
    status: 'approved',
    approvedCount: 2,
    excludedCount: 0,
    vetoDeadlineAt: '2026-08-16 12:15:00+00',
    close: null,
  });
  mockHaltBatch.mockResolvedValue({
    status: 'halted',
    reason: 'owner_veto',
    cancelledCount: 2,
    close: { status: 'not_settled' },
  });
  mockRequestAskRegeneration.mockResolvedValue({ status: 'accepted' });
  mockWithdrawAsk.mockResolvedValue({
    status: 'withdrawn',
    remainingLive: 2,
    close: { status: 'not_settled', liveCount: 2 },
  });
  // An EMPTY map is the fail-open default: the peek could not answer, so every
  // case that is not about the budget travels with `budgetRemaining: null`.
  mockPeekAskRegenBudget.mockResolvedValue(new Map());
  mockEnforceRegenLimit.mockResolvedValue(null);
});

/**
 * A `close` that actually SETTLED. The default stubs above use `close: null` /
 * `not_settled`, which is why the original suite could not see that both routes
 * were serialising the whole domain union — the leaking fields only exist on
 * this arm. A halt normally settles the batch, so this is the ordinary path,
 * not an edge case.
 */
const SETTLED_CLOSE = {
  status: 'closed' as const,
  parentRunId: '9f8e7d6c-0000-7000-8000-00000000000a',
  disposition: 'exhausted' as const,
  parentStatus: 'completed' as const,
  counts: { rendered: 0, queued: 0, sending: 0, sent: 3, cancelled: 2 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/dashboard/solicitation/batch/approve', () => {
  it('returns 404 from the approve route when send mode is off', async () => {
    // BOTH flag directions. The send surface lives INSIDE the watch surface, so
    // a gate that read only one flag would wrongly serve one of these two — the
    // second case (watch off, send on) is the one a watch-only gate passes.
    vi.stubEnv('SOLICITATION_SEND_ENABLED', undefined);
    const sendOff = await APPROVE(post('approve'));

    vi.stubEnv('SOLICITATION_WATCH_ENABLED', undefined);
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'true');
    const watchOff = await APPROVE(post('approve'));

    expect(sendOff.status).toBe(404);
    expect(watchOff.status).toBe(404);
    await expect(sendOff.json()).resolves.toEqual({ error: 'Not found' });
    await expect(watchOff.json()).resolves.toEqual({ error: 'Not found' });
    // A 404 status alone does not prove gate order — the surface must not
    // exist, so no auth work may have happened (invariant #13).
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockApproveBatch).not.toHaveBeenCalled();
  });

  it('rejects an approval when the subscription does not grant full access', async () => {
    mockAccountRows.mockReturnValue(accountRow('cancelled'));

    const response = await APPROVE(post('approve'));

    // requireWritableOwner's own refusal, verbatim — the route neither rewrites
    // the status nor substitutes its own error copy.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'subscription_inactive' });
    expect(mockApproveBatch).not.toHaveBeenCalled();
  });

  it('treats a trialing subscription as full access at approval', async () => {
    // Invariant #11: `trialing` is full access everywhere except recurring paid
    // ranking tracking. Asserted through the REAL gate, not a stubbed `ok`.
    mockAccountRows.mockReturnValue(accountRow('trialing'));

    const response = await APPROVE(
      post('approve', { body: { batchId: BATCH_ID, excludedOutreachIds: [] } }),
    );

    expect(response.status).toBe(200);
    // Both tenant keys come from the server (invariant #8): the account from the
    // owner, the business from the resolved location scope — never the body.
    expect(mockApproveBatch).toHaveBeenCalledWith(expect.anything(), {
      batchId: BATCH_ID,
      accountId: ACCOUNT_ID,
      businessId: DEFAULT_LOCATION_ID,
      approvedByUserId: USER_ID,
      excludedOutreachIds: [],
    });
  });

  it('rejects an approval that carries no location scope', async () => {
    // Aggregate ("all locations") has no meaning for a batch approval: the
    // three-key write has no proven business_id without exactly one location.
    mockMultiLocationEnabled.mockReturnValue(true);

    const response = await APPROVE(post('approve', { query: `?${SOLICITATION_SCOPE_PARAM}=all` }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'A location scope is required' });
    expect(mockApproveBatch).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin approval post', async () => {
    const response = await APPROVE(post('approve', { origin: 'https://evil.example.com' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
    // withSameOrigin is the OUTERMOST wrapper: nothing behind it may run.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockApproveBatch).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/solicitation/batch/halt', () => {
  it('returns 404 from the halt route when send mode is off', async () => {
    // Same both-flag-directions assertion as the approve route.
    vi.stubEnv('SOLICITATION_SEND_ENABLED', undefined);
    const sendOff = await HALT(post('halt'));

    vi.stubEnv('SOLICITATION_WATCH_ENABLED', undefined);
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'true');
    const watchOff = await HALT(post('halt'));

    expect(sendOff.status).toBe(404);
    expect(watchOff.status).toBe(404);
    await expect(sendOff.json()).resolves.toEqual({ error: 'Not found' });
    await expect(watchOff.json()).resolves.toEqual({ error: 'Not found' });
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockHaltBatch).not.toHaveBeenCalled();

    // Halt is as destructive as approval, so its CSRF guard is pinned here too
    // rather than left the one unasserted verb. Both flags back ON, so the only
    // remaining reason to refuse is the foreign Origin.
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'true');
    const crossOrigin = await HALT(post('halt', { origin: 'https://evil.example.com' }));

    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toEqual({ error: 'forbidden' });
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockHaltBatch).not.toHaveBeenCalled();
  });

  // The four below are not plan titles. `ci:fallow:coverage` reported
  // haltHandler at 21% tested and readBatchId at 0% while approve carried five
  // cases — halt had only the refusal paths above, so its entire success path
  // and result mapping were unasserted. Halt is the destructive verb; it should
  // not be the less-tested one.

  it('halts a batch and passes no client-supplied reason to the writer', async () => {
    const response = await HALT(post('halt'));

    expect(response.status).toBe(200);
    expect(mockHaltBatch).toHaveBeenCalledTimes(1);
    const [, input] = mockHaltBatch.mock.calls[0] as [unknown, Record<string, unknown>];
    // The route may pass ONLY these four. A `reason`/`haltReason` key here would
    // mean the client can dictate what the audit trail says about whether email
    // had already left — the exact thing ownerHaltReason exists to prevent.
    expect(Object.keys(input).sort()).toEqual([
      'accountId',
      'batchId',
      'businessId',
      'haltedByUserId',
    ]);
    expect(input.batchId).toBe(BATCH_ID);
  });

  it('reports an already-halted batch as success rather than an error', async () => {
    mockHaltBatch.mockResolvedValue({ status: 'already_halted' });

    const response = await HALT(post('halt'));

    // The latch is monotone, so a second stop is a no-op and NOT a failure —
    // an owner clicking twice must not be told something went wrong.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'already_halted' });
  });

  it('maps an unhaltable batch to 409 and an unknown one to 404', async () => {
    mockHaltBatch.mockResolvedValue({ status: 'not_haltable', state: 'closed' });
    const closed = await HALT(post('halt'));

    mockHaltBatch.mockResolvedValue({ status: 'not_found' });
    const unknown = await HALT(post('halt'));

    expect(closed.status).toBe(409);
    await expect(closed.json()).resolves.toEqual({ status: 'not_haltable', state: 'closed' });
    // Uniform 404 — a foreign batch id and an unknown one are indistinguishable.
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ error: 'Not found' });
  });

  // Round-2 standards finding F10: both routes serialised the domain union, so
  // `close.parentRunId` — an internal agent_runs UUID — reached the browser
  // against ADR 0012's no-internal-id posture on this surface. The routes now
  // project to an explicit wire shape. Asserted on the SETTLED arm, because
  // that is the only arm the leaking fields exist on.
  it('never ships the internal run id or spine vocabulary to the browser', async () => {
    mockHaltBatch.mockResolvedValue({
      status: 'halted',
      reason: 'owner_veto',
      cancelledCount: 2,
      close: SETTLED_CLOSE,
    });
    mockApproveBatch.mockResolvedValue({
      status: 'approved',
      approvedCount: 0,
      excludedCount: 3,
      vetoDeadlineAt: '2026-08-16 12:15:00+00',
      close: SETTLED_CLOSE,
    });

    const halted = await HALT(post('halt'));
    const approved = await APPROVE(post('approve'));

    for (const response of [halted, approved]) {
      const raw = JSON.stringify(await response.json());
      // Substring, not key-walking: a nested or renamed field still fails.
      expect(raw).not.toContain(SETTLED_CLOSE.parentRunId);
      expect(raw).not.toContain('parentRunId');
      expect(raw).not.toContain('parentStatus');
      expect(raw).not.toContain('disposition');
      expect(raw).not.toContain('counts');
    }

    // The one bit the panel could act on survives the projection.
    await expect(HALT(post('halt')).then((r) => r.json())).resolves.toMatchObject({
      status: 'halted',
      reason: 'owner_veto',
      closed: true,
    });
  });

  it('refuses a halt whose body carries no valid batch id', async () => {
    const missing = await HALT(post('halt', { body: {} }));
    const notAUuid = await HALT(post('halt', { body: { batchId: 'not-a-uuid' } }));
    const wrongType = await HALT(post('halt', { body: { batchId: 42 } }));

    for (const response of [missing, notAUuid, wrongType]) {
      expect(response.status).toBe(404);
    }
    // Refused at the parse boundary — no transaction is opened for a body the
    // route cannot trust.
    expect(mockHaltBatch).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/solicitation/batch/regenerate', () => {
  const SCOPED = `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}`;

  it('POST regenerate enqueues for a built batch and answers 202', async () => {
    mockRequestAskRegeneration.mockResolvedValue({ status: 'accepted' });

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    // 202, not 200: accepted, not done.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
    expect(mockRequestAskRegeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        batchId: BATCH_ID,
        askId: ASK_ID,
        businessId: DEFAULT_LOCATION_ID,
        requestedByUserId: USER_ID,
      }),
    );
  });

  it('POST regenerate answers 409 when the batch is already approved', async () => {
    mockRequestAskRegeneration.mockResolvedValue({ status: 'not_regenerable', state: 'approved' });

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      status: 'not_regenerable',
      state: 'approved',
    });
  });

  it('POST regenerate answers 429 when the ask has spent its daily regenerate budget', async () => {
    mockPeekAskRegenBudget.mockResolvedValue(new Map([[ASK_ID, { used: 3, limit: 3, remaining: 0 }]]));
    // REQUIRED: the domain decides exhaustion now, so the 429 exists only if it
    // says so. Without this the `beforeEach` default returns `accepted` and the
    // route answers 202.
    mockRequestAskRegeneration.mockResolvedValue({ status: 'budget_exhausted' });

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: 'regen_limit_reached',
      remaining: 0,
      limit: 3,
    });
    // The domain IS called — that is the whole point of round 1's finding 4.
    // The route peeks and PASSES the count; the decision happens inside, after
    // the ask has been proven to belong to this tenant.
    expect(mockRequestAskRegeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ askId: ASK_ID, budgetRemaining: 0 }),
    );
  });

  it('POST regenerate answers 404 for an over-budget ask belonging to another tenant', async () => {
    // An exhausted counter for an ask this owner does NOT own. The counter is
    // keyed on the bare ask id, so a route refusing on the peek alone would
    // answer 429 and confirm the ask exists somewhere. It must be
    // indistinguishable from an unknown id.
    mockPeekAskRegenBudget.mockResolvedValue(new Map([[ASK_ID, { used: 3, limit: 3, remaining: 0 }]]));
    mockRequestAskRegeneration.mockResolvedValue({ status: 'not_found' });

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.not.toMatchObject({ error: 'regen_limit_reached' });
  });

  it('POST regenerate enqueues when the ask budget map has no entry', async () => {
    // An ABSENT MAP ENTRY is UNKNOWN (the MGET failed) and must fail OPEN. An
    // absent Redis KEY is a different fact and arrives as `remaining: 3`.
    mockPeekAskRegenBudget.mockResolvedValue(new Map());
    mockRequestAskRegeneration.mockResolvedValue({ status: 'accepted' });

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    expect(response.status).toBe(202);
    expect(mockRequestAskRegeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ budgetRemaining: null }),
    );
  });

  it('POST regenerate answers 409 when a regeneration is already in flight for the batch', async () => {
    mockRequestAskRegeneration.mockResolvedValue({ status: 'already_in_flight' });

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ status: 'already_in_flight' });
  });

  it('POST regenerate answers 404 when the body carries no valid ask id', async () => {
    const response = await REGENERATE(
      post('regenerate', {
        query: SCOPED,
        body: { batchId: BATCH_ID, askId: 'not-a-uuid' },
      }),
    );

    // The uniform 404: a malformed body reveals nothing an unknown batch would
    // not, and never reaches the domain.
    expect(response.status).toBe(404);
    expect(mockRequestAskRegeneration).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin regenerate post', async () => {
    // The third owner verb, and the last one left without a CSRF assertion.
    // Regenerate is a spending verb — it enqueues an LLM call on the owner's
    // budget — so a forged cross-site POST is worth the same pin approve and
    // halt already carry.
    const response = await REGENERATE(
      post('regenerate', { query: SCOPED, origin: 'https://evil.example.com' }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
    // withSameOrigin is the OUTERMOST wrapper: nothing behind it may run — no
    // identity lookup, no Redis peek, no transaction.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockPeekAskRegenBudget).not.toHaveBeenCalled();
    expect(mockRequestAskRegeneration).not.toHaveBeenCalled();
  });

  it('POST regenerate is refused when SOLICITATION_SEND_ENABLED is off', async () => {
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'false');

    const response = await REGENERATE(post('regenerate', { query: SCOPED }));

    expect(response.status).toBe(404);
    expect(mockRequestAskRegeneration).not.toHaveBeenCalled();
    // Invariant #13: the surface must not exist, so no auth work may have run
    // and no budget key may have been read for an ask this request never got to.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockPeekAskRegenBudget).not.toHaveBeenCalled();
  });
});

describe('POST /api/dashboard/solicitation/batch/withdraw', () => {
  // `SCOPED` above is block-scoped to the regenerate describe; this describe
  // keeps its own copy rather than hoisting that one.
  const WITHDRAW_SCOPED = `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}`;

  it('withdraw route maps withdrawn and already_withdrawn to 200, not_withdrawable and not_live to 409, not_found to 404', async () => {
    const withdrawn = await WITHDRAW(post('withdraw'));
    expect(withdrawn.status).toBe(200);
    await expect(withdrawn.json()).resolves.toEqual({
      status: 'withdrawn',
      remainingLive: 2,
      closed: false,
    });
    // The route passes EXACTLY these five keys — no reason, no status, nothing
    // the client could use to dictate what the audit row says.
    const [, input] = mockWithdrawAsk.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(Object.keys(input).sort()).toEqual([
      'accountId',
      'askId',
      'batchId',
      'businessId',
      'withdrawnByUserId',
    ]);
    expect(input).toMatchObject({ batchId: BATCH_ID, askId: ASK_ID, withdrawnByUserId: USER_ID });

    mockWithdrawAsk.mockResolvedValue({ status: 'already_withdrawn' });
    const repeat = await WITHDRAW(post('withdraw'));
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toEqual({ status: 'already_withdrawn' });

    mockWithdrawAsk.mockResolvedValue({ status: 'not_withdrawable', state: 'halted' });
    const halted = await WITHDRAW(post('withdraw'));
    expect(halted.status).toBe(409);
    await expect(halted.json()).resolves.toEqual({ status: 'not_withdrawable', state: 'halted' });

    mockWithdrawAsk.mockResolvedValue({ status: 'not_live', deliveryStatus: 'sent' });
    const notLive = await WITHDRAW(post('withdraw'));
    expect(notLive.status).toBe(409);
    // The row's status stays server-side; the panel has one sentence for it.
    await expect(notLive.json()).resolves.toEqual({ status: 'not_live' });

    mockWithdrawAsk.mockResolvedValue({ status: 'not_found' });
    const unknown = await WITHDRAW(post('withdraw'));
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('withdraw route answers 404 to a body without a valid batchId and askId', async () => {
    const missingAsk = await WITHDRAW(post('withdraw', { body: { batchId: BATCH_ID } }));
    const missingBatch = await WITHDRAW(post('withdraw', { body: { askId: ASK_ID } }));
    const notUuid = await WITHDRAW(post('withdraw', { body: { batchId: BATCH_ID, askId: 'nope' } }));
    const wrongType = await WITHDRAW(post('withdraw', { body: { batchId: 42, askId: ASK_ID } }));

    for (const response of [missingAsk, missingBatch, notUuid, wrongType]) {
      expect(response.status).toBe(404);
    }
    // Refused at the parse boundary — no transaction is opened for a body the
    // route cannot trust.
    expect(mockWithdrawAsk).not.toHaveBeenCalled();
  });

  it('withdraw wire never carries the send parent run id', async () => {
    mockWithdrawAsk.mockResolvedValue({
      status: 'withdrawn',
      remainingLive: 0,
      close: SETTLED_CLOSE,
    });

    const response = await WITHDRAW(post('withdraw'));
    const raw = JSON.stringify(await response.json());

    // Substring, not key-walking: a nested or renamed field still fails.
    expect(raw).not.toContain(SETTLED_CLOSE.parentRunId);
    expect(raw).not.toContain('parentRunId');
    expect(raw).not.toContain('parentStatus');
    expect(raw).not.toContain('disposition');
    expect(raw).not.toContain('counts');
    // The one bit the panel could act on survives the projection.
    await expect(WITHDRAW(post('withdraw')).then((r) => r.json())).resolves.toMatchObject({
      status: 'withdrawn',
      closed: true,
    });
  });

  it('withdraw route is unavailable when either the watch or the send flag is off', async () => {
    // BOTH halves of the dual gate, independently — the send lane's verbs bind
    // `requireSolicitationSendWriteAccess`, which requires both flags.
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'false');
    const sendOff = await WITHDRAW(post('withdraw'));
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'true');
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'false');
    const watchOff = await WITHDRAW(post('withdraw'));

    expect(sendOff.status).toBe(404);
    expect(watchOff.status).toBe(404);
    expect(mockWithdrawAsk).not.toHaveBeenCalled();
  });

  it('withdraw route passes the scoped session tenant ids and ignores client reason status and outreach fields', async () => {
    const response = await WITHDRAW(
      post('withdraw', {
        query: WITHDRAW_SCOPED,
        body: {
          batchId: BATCH_ID,
          askId: ASK_ID,
          // Everything below must be ignored — the reason is fixed server-side
          // and the row is resolved under the lock.
          outreachId: '01900000-0000-7000-8000-0000000000aa',
          reason: 'owner_veto',
          disposition_reason: 'owner_excluded',
          status: 'sent',
          accountId: '01900000-0000-7000-8000-0000000000bb',
          businessId: '01900000-0000-7000-8000-0000000000cc',
        },
      }),
    );

    expect(response.status).toBe(200);
    const [, input] = mockWithdrawAsk.mock.calls[0] as [unknown, Record<string, unknown>];
    // The VALUES, not just the key names: tenant ids come from the session and
    // the resolved location scope, never from the body.
    expect(input).toEqual({
      batchId: BATCH_ID,
      askId: ASK_ID,
      accountId: ACCOUNT_ID,
      businessId: DEFAULT_LOCATION_ID,
      withdrawnByUserId: USER_ID,
    });
  });

  it('rejects a cross-origin withdraw post', async () => {
    // Withdrawal is a destructive verb (cancelled is terminal), so it carries
    // the same CSRF pin approve, halt and regenerate already carry.
    const response = await WITHDRAW(
      post('withdraw', { query: WITHDRAW_SCOPED, origin: 'https://evil.example.com' }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
    // withSameOrigin is the OUTERMOST wrapper: nothing behind it may run.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockWithdrawAsk).not.toHaveBeenCalled();
  });
});
