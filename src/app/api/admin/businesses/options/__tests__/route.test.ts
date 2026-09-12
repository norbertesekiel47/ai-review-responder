import { adminBearerRequest } from '@/lib/auth/__tests__/helpers/admin-gate-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireRole, mockRequireCurrentAal2FromSupabase, mockLoadAppUser,
  mockResolveAdminApiIdentity, adminAuthModuleMock,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks, adminAuthModuleMock } =
    await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  return { ...makeAdminGateMocks(), adminAuthModuleMock };
});
vi.mock('@/lib/db/auth', () => adminAuthModuleMock(mockRequireRole, mockLoadAppUser));
vi.mock('@/lib/auth/verified-identity', () => ({ resolveAdminApiIdentity: mockResolveAdminApiIdentity }));
vi.mock('@/lib/auth/mfa', () => ({ requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase }));
vi.mock('@/lib/payments/flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/payments/flags')>();
  return { ...actual, betaCompCouponId: vi.fn(actual.betaCompCouponId) };
});

import { betaCompCouponId } from '@/lib/payments/flags';
import { resetServerConfigForTests } from '@/lib/config/server';
import { AuthError } from '@/lib/db/auth';
import { GET } from '../route';

function request(bearer = false) {
  return adminBearerRequest('http://localhost/api/admin/businesses/options', {
    headers: bearer ? { authorization: 'Bearer test-admin-access-token' } : {},
  });
}

describe('GET admin business options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BETA_COMP_COUPON_ID', 'test-only-coupon');
    resetServerConfigForTests();
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin', accountId: null, locationId: null });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfigForTests();
  });

  it('returns only betaCompActive true when the coupon is armed', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ betaCompActive: true });
    expect(betaCompCouponId).toHaveBeenCalledOnce();
  });

  it('returns only betaCompActive false when the coupon is unarmed', async () => {
    vi.stubEnv('BETA_COMP_COUPON_ID', '');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ betaCompActive: false });
  });

  it('serves options to a bearer-transport AAL2 admin', async () => {
    const response = await GET(request(true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ betaCompActive: true });
    expect(mockResolveAdminApiIdentity).toHaveBeenCalledOnce();
    expect((await mockResolveAdminApiIdentity.mock.results[0]!.value)?.transport).toBe('bearer');
  });

  it('refuses options to an AAL1 admin before reading the coupon', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(betaCompCouponId).not.toHaveBeenCalled();
  });

  it('refuses options to a non-admin before reading the coupon', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(betaCompCouponId).not.toHaveBeenCalled();
  });

  it('refuses options to an unauthenticated caller before reading the coupon', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(betaCompCouponId).not.toHaveBeenCalled();
  });
});
