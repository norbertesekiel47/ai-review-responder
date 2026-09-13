// Orchestration seams for POST /api/operator/proposals/:id/decline. Same shim
// as the apply route's suite; `declineProposal` is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSqlQuery, mockSqlBegin, mockWritable, mockDecline } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlQuery: vi.fn(),
  mockSqlBegin: vi.fn(),
  mockWritable: vi.fn(),
  mockDecline: vi.fn(),
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
vi.mock('@/lib/agents/operator/proposals', () => ({
  declineProposal: (...a: unknown[]) => mockDecline(...a),
}));

import { POST } from '../proposals/[id]/decline/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const PROPOSAL = '00000000-0000-7000-8000-000000000021';
const ORIGIN = 'https://app.repworth.test';
const DECLINED = { id: PROPOSAL, status: 'rejected', failureReason: null };

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/decline`, {
    method: 'POST',
    headers: { origin: ORIGIN, host: 'app.repworth.test', ...headers },
  });
}

const params = () => ({ params: Promise.resolve({ id: PROPOSAL }) });

describe('POST /api/operator/proposals/[id]/decline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    mockWritable.mockResolvedValue({ ok: true });
    mockDecline.mockResolvedValue({ kind: 'rejected', proposal: DECLINED, repeated: false });
  });

  it('POST decline returns 404 operator_disabled before auth when the flag is off and rejects a mismatched Origin', async () => {
    process.env.OWNER_OPERATOR_ENABLED = 'false';
    const disabled = await POST(request(), params());
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: 'operator_disabled' });
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();

    process.env.OWNER_OPERATOR_ENABLED = 'true';
    const mismatched = await POST(request({ origin: 'https://evil.example' }), params());
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json()).toEqual({ error: 'forbidden' });
    // The wrapper runs outside the handler, so nothing downstream was reached.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();

    // Impersonation is refused here too: an admin may look, never act.
    const impersonated = await POST(
      request({ cookie: 'rw_impersonation=session-1.deadbeef' }),
      params(),
    );
    expect(impersonated.status).toBe(409);
    expect(await impersonated.json()).toEqual({ error: 'impersonation_not_allowed' });
  });

  it("POST decline returns 200 with the rejected proposal and 404 for another account's proposal", async () => {
    const ok = await POST(request(), params());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ proposal: DECLINED });
    expect(mockDecline).toHaveBeenCalledTimes(1);
    expect(mockDecline.mock.calls[0]![1]).toEqual({
      proposalId: PROPOSAL,
      accountId: ACCOUNT,
      actorUserId: 'user-1',
    });

    // A repeat decline is the same 200 with the same row (D5, idempotent).
    mockDecline.mockResolvedValue({ kind: 'rejected', proposal: DECLINED, repeated: true });
    const again = await POST(request(), params());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ proposal: DECLINED });

    // Another account's proposal: the module's account predicate matched
    // nothing, and the route answers exactly what an unknown id answers.
    mockDecline.mockResolvedValue({ kind: 'not_found' });
    const foreign = await POST(request(), params());
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'proposal_not_found' });

    // A malformed id is the same 404, decided before the module is called.
    mockDecline.mockClear();
    const malformed = await POST(request(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(malformed.status).toBe(404);
    expect(mockDecline).not.toHaveBeenCalled();

    mockDecline.mockResolvedValue({
      kind: 'not_pending',
      status: 'applied',
      proposal: { id: PROPOSAL, status: 'applied' },
    });
    const applied = await POST(request(), params());
    expect(applied.status).toBe(409);
    expect(await applied.json()).toEqual({
      error: 'proposal_not_pending',
      proposal: { id: PROPOSAL, status: 'applied' },
    });
  });
});
