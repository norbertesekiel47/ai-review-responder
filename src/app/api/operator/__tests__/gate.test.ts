// `requireOperatorWriter` — the one gate the three Operator mutation routes
// share — and `requireOperatorProposalWriter`, which adds the **Proposal** id
// resolution the two `proposals/:id/*` routes share. Only the ORDER is under
// test here: the route suites still assert the status codes end-to-end.
//
// `@/lib/db/server` is deliberately NOT mocked: the gate takes `sql` as a
// parameter (invariant #15), so a bare stub is enough and an accidental
// singleton import would fail this suite rather than pass it quietly.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Sql } from 'postgres';

const { mockRequireRole, mockWritable } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockWritable: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...a: unknown[]) => mockRequireRole(...a), AuthError };
});
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));

import { requireOperatorProposalWriter, requireOperatorWriter } from '../gate';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const ORIGIN = 'https://app.repworth.test';
const sqlStub = {} as Sql;

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}/api/operator/turns`, {
    method: 'POST',
    headers: { origin: ORIGIN, host: 'app.repworth.test', ...headers },
  });
}

describe('requireOperatorWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
  });

  it('returns 404 operator_disabled before auth when the flag is off', async () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';

    const result = await requireOperatorWriter(sqlStub, request());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'operator_disabled' });
    // The flag answers before the surface exists: no auth, no subscription read.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockWritable).not.toHaveBeenCalled();
  });

  it('returns 409 impersonation_not_allowed after auth when the session is impersonated', async () => {
    const result = await requireOperatorWriter(
      sqlStub,
      request({ cookie: 'rw_impersonation=session-1.deadbeef' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toEqual({ error: 'impersonation_not_allowed' });
    // PRESENCE refuses, and it refuses AFTER the owner is resolved — an
    // unauthenticated request still gets the 401, not this 409.
    expect(mockRequireRole).toHaveBeenCalledTimes(1);
  });

  it('returns the owner when the flag is on, the owner is writable and the session is not impersonated', async () => {
    const result = await requireOperatorWriter(sqlStub, request());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the owner');
    expect(result.owner.accountId).toBe(ACCOUNT);
    expect(result.owner.user.id).toBe('user-1');
    expect(mockWritable).toHaveBeenCalledWith(ACCOUNT, sqlStub);
  });
});

/**
 * THE ID IS RESOLVED LAST, which only a MALFORMED id can show: a well-formed
 * one answers the same way whatever the order. Both cases below pair a
 * malformed **Proposal** id with a gate that refuses, and both refusals must be
 * the gate's own — the shape of an id the caller may not even own is not
 * something the surface tells them about.
 */
describe('requireOperatorProposalWriter', () => {
  const MALFORMED = { params: Promise.resolve({ id: 'not-a-uuid' }) };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
  });

  it('returns 404 operator_disabled, not proposal_not_found, when the flag is off and the proposal id is malformed', async () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';

    const result = await requireOperatorProposalWriter(sqlStub, request(), MALFORMED);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    // BOTH refusals are 404, so the status alone proves nothing: the TOKEN is
    // what says the flag answered first, before anything about the id was read.
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'operator_disabled' });
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('returns 409 impersonation_not_allowed when the session is impersonated and the proposal id is malformed', async () => {
    const result = await requireOperatorProposalWriter(
      sqlStub,
      request({ cookie: 'rw_impersonation=session-1.deadbeef' }),
      MALFORMED,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toEqual({ error: 'impersonation_not_allowed' });
    expect(mockRequireRole).toHaveBeenCalledTimes(1);
  });
});
