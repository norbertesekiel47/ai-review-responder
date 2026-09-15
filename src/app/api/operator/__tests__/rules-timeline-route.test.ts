import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ role: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error { constructor(message: string, public readonly statusCode: number) { super(message); } }
  return { requireRole: mocks.role, AuthError };
});
vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/agents/operator/proposals', () => ({ listAppliedProposals: mocks.list }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));
import { GET } from '../rules-timeline/route';
import { AuthError } from '@/lib/db/auth';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const LOCATION = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000003';
const STAMP = '2026-09-14 20:00:00.123456+00';
function request(query = '') { return new NextRequest(`https://app.repworth.test/api/operator/rules-timeline${query}`); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OWNER_OPERATOR_ENABLED', 'true');
  mocks.role.mockResolvedValue({ id: 'owner-1', role: 'owner', accountId: ACCOUNT });
  mocks.list.mockResolvedValue({ proposals: [], pendingRestores: [], nextCursor: null });
});

describe('GET Rules timeline', () => {
  it('scopes every read to the authenticated account and preserves pending restores and raw cursor precision', async () => {
    const page = { proposals: [{ id: ID }], pendingRestores: [{ id: 'pending-restore' }], nextCursor: { appliedAt: STAMP, id: ID } };
    mocks.list.mockResolvedValue(page);
    const query = new URLSearchParams({ locationId: LOCATION, cursorAppliedAt: STAMP, cursorId: ID, limit: '20' });
    const response = await GET(request(`?${query}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      accountId: ACCOUNT, locationId: LOCATION, cursor: { appliedAt: STAMP, id: ID }, limit: 20,
    });
  });

  it('allows the account-wide history read without a writable subscription or Origin', async () => {
    expect((await GET(request())).status).toBe(200);
    expect(mocks.list.mock.calls[0]?.[1]).toEqual({ accountId: ACCOUNT });
  });

  it('rejects disabled and unauthenticated reads before the domain query', async () => {
    vi.stubEnv('OWNER_OPERATOR_ENABLED', 'false');
    expect((await GET(request())).status).toBe(404);
    expect(mocks.role).not.toHaveBeenCalled();
    vi.stubEnv('OWNER_OPERATOR_ENABLED', 'true');
    mocks.role.mockRejectedValue(new AuthError('Unauthorized', 401));
    expect((await GET(request())).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([
    '?locationId=bad', '?limit=0', '?limit=51', '?limit=1.5', '?cursorId=bad',
    `?cursorId=${ID}`, `?cursorAppliedAt=${encodeURIComponent(STAMP)}`,
    `?cursorId=${ID}&cursorAppliedAt=not-a-date`, '?accountId=foreign', '?limit=1&limit=2',
  ])('rejects malformed, unpaired or unbounded query inputs: %s', async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('sanitizes an unexpected read failure', async () => {
    mocks.list.mockRejectedValue(new Error('private DB detail'));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'rules_timeline_failed' });
  });
});
