import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ role: vi.fn(), writable: vi.fn(), restore: vi.fn() }));
vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error { constructor(message: string, public readonly statusCode: number) { super(message); } }
  return { requireRole: mocks.role, AuthError };
});
vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/shared/writable-subscription', () => ({ assertWritableSubscriptionForAccount: mocks.writable }));
vi.mock('@/lib/agents/operator/restore', () => ({ createRestoreProposal: mocks.restore }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

import { POST } from '../proposals/[id]/restore/route';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const PROPOSAL = '00000000-0000-4000-8000-000000000002';
const ORIGIN = 'https://app.repworth.test';
const params = (id = PROPOSAL) => ({ params: Promise.resolve({ id }) });
function request(body: unknown = {}, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/restore`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('OWNER_OPERATOR_ENABLED', 'true');
  mocks.role.mockResolvedValue({ id: 'owner-1', role: 'owner', accountId: ACCOUNT });
  mocks.writable.mockResolvedValue({ ok: true });
  mocks.restore.mockResolvedValue({ kind: 'prepared', proposal: { id: 'restore-1', status: 'pending' }, repeated: false });
});

describe('POST proposal Restore preparation', () => {
  it('prepares a pending card from the authenticated actor and source ID without applying anything', async () => {
    const response = await POST(request(), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ proposal: { id: 'restore-1', status: 'pending' }, repeated: false });
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      accountId: ACCOUNT, actorUserId: 'owner-1', sourceProposalId: PROPOSAL,
    });
  });

  it('Restore routes reject missing origin and forged restore state', async () => {
    expect((await POST(request({}, { origin: 'https://elsewhere.test' }), params())).status).toBe(403);
    const missingOrigin = request();
    missingOrigin.headers.delete('origin');
    expect((await POST(missingOrigin, params())).status).toBe(403);
    expect(mocks.role).not.toHaveBeenCalled();
    expect((await POST(request({ restore: { sourceProposalId: PROPOSAL }, state: { tone: 'forged' } }), params())).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
    mocks.role.mockClear();
    vi.stubEnv('OWNER_OPERATOR_ENABLED', 'false');
    expect((await POST(request(), params())).status).toBe(404);
    expect(mocks.role).not.toHaveBeenCalled();
    vi.stubEnv('OWNER_OPERATOR_ENABLED', 'true');
    expect((await POST(request({}, { cookie: 'rw_impersonation=session-1.deadbeef' }), params())).status).toBe(409);
    mocks.writable.mockResolvedValue({ ok: false, status: 402, error: 'subscription_not_writable' });
    expect((await POST(request(), params())).status).toBe(402);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each([null, [], { state: { tone: 'warm' } }, { sourceProposalId: PROPOSAL }, { confirmationLevel: 'standard' }])(
    'rejects every nonempty or nonobject body: %j', async (body) => {
      expect((await POST(request(body), params())).status).toBe(400);
      expect(mocks.restore).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed IDs and JSON without calling the domain', async () => {
    expect((await POST(request(), params('invalid'))).status).toBe(404);
    const invalidJson = new NextRequest(`${ORIGIN}/api/operator/proposals/${PROPOSAL}/restore`, {
      method: 'POST', headers: { origin: ORIGIN }, body: '{',
    });
    expect((await POST(invalidJson, params())).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404, 'proposal_not_found'], ['not_applied', 409, 'restore_not_applied'],
    ['invalid_source', 409, 'restore_invalid_source'], ['unauthorized', 403, 'unauthorized'],
    ['location_not_found', 404, 'location_not_found'], ['no_history', 409, 'restore_no_history'],
  ] as const)('maps %s to an owner-readable failure', async (kind, status, error) => {
    mocks.restore.mockResolvedValue({ kind });
    const response = await POST(request(), params());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it('returns retry-safe preparation identity and a sanitized unexpected failure', async () => {
    mocks.restore.mockResolvedValue({ kind: 'prepared', proposal: { id: 'restore-1', status: 'pending' }, repeated: true });
    expect(await (await POST(request(), params())).json()).toMatchObject({ repeated: true });
    mocks.restore.mockRejectedValue(new Error('private DB detail'));
    const response = await POST(request(), params());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'restore_failed' });
  });
});
