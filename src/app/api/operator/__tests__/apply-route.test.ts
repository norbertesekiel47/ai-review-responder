// Orchestration seams for POST /api/operator/proposals/:id/apply.
//
// `applyProposal` is MOCKED: the module's own behaviour is T1's subject and is
// proven against a live database there. What is under test here is the gate
// ORDER (flag → same-origin → writable owner → impersonation → parse) and the
// result-kind → status-code map, which is the only thing the route owns.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSqlQuery, mockSqlBegin, mockWritable, mockApply } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockSqlBegin: vi.fn(),
  mockWritable: vi.fn(),
  mockApply: vi.fn(),
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
vi.mock('@/lib/db/server', () => {
  const sqlProxy = Object.assign((...a: unknown[]) => mockSqlQuery(...a), {
    begin: (...a: unknown[]) => mockSqlBegin(...a),
  });
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});
vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...a: unknown[]) => mockWritable(...a),
}));
vi.mock('@/lib/agents/operator/apply', () => ({
  applyProposal: (...a: unknown[]) => mockApply(...a),
}));

import { POST } from '../proposals/[id]/apply/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const PROPOSAL = '00000000-0000-7000-8000-000000000021';
const ORIGIN = 'https://app.repworth.test';

const TOKEN = { businessId: LOCATION, updatedAt: '2026-09-12 09:00:00.111111+00' };
const PROPOSAL_VIEW = { id: PROPOSAL, status: 'applied', receipt: { version: 1 } };

function request(
  body: unknown = { expectedVersionToken: TOKEN },
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/apply`, {
    method: 'POST',
    headers: { origin: ORIGIN, host: 'app.repworth.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// A `params` Promise is consumed once, so every case builds its own.
const params = () => ({ params: Promise.resolve({ id: PROPOSAL }) });

describe('POST /api/operator/proposals/[id]/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // withSameOrigin() compares Origin against NEXT_PUBLIC_APP_URL, which
    // vitest.setup.ts defaults to http://localhost:3000 — without this every
    // request above would 403 on the app URL rather than on the case at hand.
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
    mockApply.mockResolvedValue({ kind: 'applied', proposal: PROPOSAL_VIEW, repeated: false });
  });

  it('POST apply returns 404 operator_disabled before auth when the flag is off', async () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';

    const response = await POST(request(), params());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'operator_disabled' });
    // BEFORE auth and before any read: off means the surface does not exist.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('POST apply rejects a missing or mismatched Origin before any read', async () => {
    const missing = new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/apply`, {
      method: 'POST',
      headers: { host: 'app.repworth.test', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersionToken: TOKEN }),
    });
    const missingResponse = await POST(missing, params());
    expect(missingResponse.status).toBe(403);
    expect(await missingResponse.json()).toEqual({ error: 'forbidden' });

    const mismatched = await POST(
      request(undefined, { origin: 'https://evil.example' }),
      params(),
    );
    expect(mismatched.status).toBe(403);

    // BEFORE ANY READ: the wrapper runs outside the handler, so neither the
    // flag read nor the auth gate nor the module was reached.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('POST apply rejects an impersonated session with 409 impersonation_not_allowed', async () => {
    const response = await POST(
      request(undefined, { cookie: 'rw_impersonation=session-1.deadbeef' }),
      params(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'impersonation_not_allowed' });
    // An admin impersonating an owner may LOOK, never act — the same rule and
    // the same token PATCH /api/settings/auto-approval enforces. It runs before
    // the body parse, so a malformed body from an impersonated session still
    // answers 409 and not 400.
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('POST apply maps applied to 200 with the receipt, stale to 409 proposal_stale, contract_changed to 409, not_found to 404 and not_pending to 409', async () => {
    const applied = await POST(request(), params());
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ proposal: PROPOSAL_VIEW });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0]![1]).toEqual({
      proposalId: PROPOSAL,
      accountId: ACCOUNT,
      actorUserId: 'user-1',
      expectedVersionToken: TOKEN,
    });

    mockApply.mockResolvedValue({ kind: 'stale', proposal: { id: PROPOSAL, status: 'stale' } });
    const stale = await POST(request(), params());
    expect(stale.status).toBe(409);
    // EVERY non-404 body carries the row, so the card re-renders from what the
    // server stored rather than from the browser's reading of a status code.
    expect(await stale.json()).toEqual({
      error: 'proposal_stale',
      proposal: { id: PROPOSAL, status: 'stale' },
    });

    mockApply.mockResolvedValue({
      kind: 'rejected',
      reason: 'contract_changed',
      proposal: { id: PROPOSAL, status: 'rejected' },
    });
    const rejected = await POST(request(), params());
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: 'contract_changed',
      proposal: { id: PROPOSAL, status: 'rejected' },
    });

    mockApply.mockResolvedValue({ kind: 'not_found' });
    const notFound = await POST(request(), params());
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'proposal_not_found' });

    mockApply.mockResolvedValue({
      kind: 'not_pending',
      status: 'superseded',
      proposal: { id: PROPOSAL, status: 'superseded' },
    });
    const notPending = await POST(request(), params());
    expect(notPending.status).toBe(409);
    expect(await notPending.json()).toEqual({
      error: 'proposal_not_pending',
      proposal: { id: PROPOSAL, status: 'superseded' },
    });

    mockApply.mockResolvedValue({ kind: 'failed', proposal: { id: PROPOSAL, status: 'failed' } });
    const failed = await POST(request(), params());
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: 'apply_failed',
      proposal: { id: PROPOSAL, status: 'failed' },
    });

    // A malformed id is a 404, not a 400: the same answer another account's
    // proposal gets, so the shape of the id tells the caller nothing.
    const malformed = await POST(request(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'proposal_not_found' });

    // A body with no token, an unknown key, a non-string or over-long typed
    // scope is 400 at the body parse.
    const noToken = await POST(request({}), params());
    expect(noToken.status).toBe(400);
    const unknownKey = await POST(request({ expectedVersionToken: TOKEN, confirmation: 'yes' }), params());
    expect(unknownKey.status).toBe(400);
    const notString = await POST(request({ expectedVersionToken: TOKEN, confirmationLevel: 4 }), params());
    expect(notString.status).toBe(400);
    const tooLong = await POST(request({ expectedVersionToken: TOKEN, confirmationLevel: 'x'.repeat(101) }), params());
    expect(tooLong.status).toBe(400);
  });

  it('POST apply passes a policy token and the typed scope through verbatim and maps confirmation_mismatch to 400 and expansion_blocked to 409', async () => {
    const policyToken = {
      locationRow: { id: 'absent' },
      accountDefaultRow: { id: '00000000-0000-7000-8000-0000000000aa', updatedAt: '2026-09-12 09:00:00.1+00' },
    };
    mockApply.mockResolvedValue({ kind: 'confirmation_mismatch', proposal: { id: PROPOSAL, status: 'pending' } });

    const mismatch = await POST(
      request({ expectedVersionToken: policyToken, confirmationLevel: ' 5 star only' }),
      params(),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: 'confirmation_mismatch',
      proposal: { id: PROPOSAL, status: 'pending' },
    });
    // VERBATIM: the leading space reaches Apply untrimmed.
    expect(mockApply.mock.calls[0]![1]).toEqual({
      proposalId: PROPOSAL,
      accountId: ACCOUNT,
      actorUserId: 'user-1',
      expectedVersionToken: policyToken,
      confirmationLevel: ' 5 star only',
    });

    mockApply.mockResolvedValue({
      kind: 'blocked',
      blockReasons: ['autopilot_unavailable'],
      proposal: { id: PROPOSAL, status: 'rejected' },
    });
    const blocked = await POST(request({ expectedVersionToken: policyToken, confirmationLevel: '5 star only' }), params());
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'expansion_blocked',
      blockReasons: ['autopilot_unavailable'],
      proposal: { id: PROPOSAL, status: 'rejected' },
    });
  });
});
