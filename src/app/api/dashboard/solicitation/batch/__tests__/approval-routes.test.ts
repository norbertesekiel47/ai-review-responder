// Route-level tests for the two owner verbs of the send lane (#629).
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
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockAccountRows: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockMultiLocationEnabled: vi.fn(() => false),
  mockApproveBatch: vi.fn(),
  mockHaltBatch: vi.fn(),
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
}));

import { SOLICITATION_SCOPE_PARAM } from '@/app/api/dashboard/solicitation/scope-param';
import { POST as APPROVE } from '../approve/route';
import { POST as HALT } from '../halt/route';

const APP_URL = 'http://localhost:3000';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = '01900000-0000-7000-8000-0000000000a1';
const DEFAULT_LOCATION_ID = '01900000-0000-7000-8000-0000000000d1';
const BATCH_ID = '01900000-0000-7000-8000-000000000001';

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
  path: 'approve' | 'halt',
  options: { query?: string; body?: unknown; origin?: string } = {},
): NextRequest {
  return new NextRequest(
    `${APP_URL}/api/dashboard/solicitation/batch/${path}${options.query ?? ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: options.origin ?? APP_URL,
      },
      body: JSON.stringify(options.body ?? { batchId: BATCH_ID }),
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
