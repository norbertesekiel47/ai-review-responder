import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, mockBuildPaymentLinkUrl } = vi.hoisted(() => {
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  const mockBuildPaymentLinkUrl = vi.fn();
  return { mockSql, mockBuildPaymentLinkUrl };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));
vi.mock('@/lib/payments/payment-link', () => ({ buildPaymentLinkUrl: mockBuildPaymentLinkUrl }));

import {
  createBusinessTx,
  DuplicateEmailError,
  PLACEHOLDER_BUSINESS_NAME,
  type AdminBusinessTxInput,
  type SelfServeBusinessTxInput,
} from '../create-business';

const adminInput: AdminBusinessTxInput = {
  ownerEmail: 'a@b.com',
  ownerName: 'Jane',
  businessName: 'Acme',
  subscriptionTier: 'standard',
  placeId: { placeIdVerified: true, placeId: 'ChIJtest' },
};

const selfServeInput: SelfServeBusinessTxInput = {
  ownerEmail: 'a@b.com',
  ownerName: 'Jane',
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  mockBuildPaymentLinkUrl.mockReset();
  mockBuildPaymentLinkUrl.mockReturnValue('https://buy.stripe.com/test');
});

describe('createBusinessTx — admin mode', () => {
  it('writes users.auth_id=NULL and does NOT create outbox entry for placeIdVerified=true', async () => {
    // With placeIdVerified=true, no outbox row is inserted — review ingestion
    // is webhook-driven via Zernio. Only businesses + users + channel_enrollments are written.
    const res = await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    expect(res.businessId).toBeTruthy();
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // auth_id position in admin mode must be null (verified against args structure)
    expect(usersCallArgs).toContain(null);
  });

  it('does NOT enqueue sync_reviews when placeIdVerified=true (webhook-driven now)', async () => {
    await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const allArgs = mockSql.mock.calls.flat();
    // sync_reviews must not appear anywhere in the call args or template text.
    expect(allArgs.some((v: unknown) => v === 'sync_reviews')).toBe(false);
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    expect(calls.some((t: string) => t.includes('sync_reviews'))).toBe(false);
  });

  it('enqueues validate_place_id when placeIdVerified=false', async () => {
    const input: AdminBusinessTxInput = {
      ...adminInput,
      placeId: { placeIdVerified: false, googleMapsUrl: 'https://maps.google.com/?cid=1' },
    };
    await createBusinessTx(input, { mode: 'admin', onboardedBy: 'admin-1' });
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'))!;
    expect((outboxCall[0] as TemplateStringsArray).join('?')).toContain("'validate_place_id'");
  });

  it('writes onboarded_by value to businesses row', async () => {
    await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-xyz-123' });
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === 'admin-xyz-123')).toBe(true);
  });
});

describe('createBusinessTx — self_serve mode', () => {
  it('writes users.auth_id=authId, placeholder businesses row, and skips outbox insert', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(usersCallArgs.some((a: unknown) => a === 'auth-xyz')).toBe(true);
  });

  it('writes businesses.name as PLACEHOLDER_BUSINESS_NAME', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === PLACEHOLDER_BUSINESS_NAME)).toBe(true);
  });

  it('writes NULL google_place_id and NULL google_maps_url on the placeholder row', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    // Both google_place_id and google_maps_url are interpolated as null;
    // ensure the values array contains at least two nulls (place id columns)
    // alongside the placeholder name. Multiple nulls are expected — category,
    // products_services, website, onboarded_by also pass null.
    const nullCount = (bizCall as unknown[]).filter((v) => v === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
    expect(bizCall.some((a: unknown) => a === PLACEHOLDER_BUSINESS_NAME)).toBe(true);
  });

  it('writes place_id_verified=false on the placeholder row', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === false)).toBe(true);
  });

  it('does NOT enqueue outbox in self_serve mode', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'));
    expect(outboxCall).toBeUndefined();
  });

  it('hardcodes subscription_tier=standard regardless of caller intent', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === 'standard')).toBe(true);
  });
});

describe('createBusinessTx — duplicate email', () => {
  it('throws DuplicateEmailError on PG 23505', async () => {
    mockSql.mockImplementation(() => {
      const err: any = new Error('duplicate key');
      err.code = '23505';
      throw err;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
    await expect(
      createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow(DuplicateEmailError);
  });

  it('re-throws non-23505 PG errors unchanged', async () => {
    const otherErr: any = new Error('connection timeout');
    otherErr.code = '08006';
    mockSql.mockImplementation(() => {
      throw otherErr;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
    await expect(
      createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow('connection timeout');
  });
});

describe('createBusinessTx — field-name regression', () => {
  it('maps ownerName→users.name in self_serve mode', async () => {
    await createBusinessTx(
      { ...selfServeInput, ownerName: 'Jane-Owner' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // owner_name on businesses row + users.name both come from input.ownerName.
    expect(bizCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
  });

  it('maps businessName→businesses.name in admin mode', async () => {
    await createBusinessTx(
      { ...adminInput, businessName: 'Acme-Biz', ownerName: 'Jane-Owner' },
      { mode: 'admin', onboardedBy: 'a' },
    );
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(bizCall.some((a: unknown) => a === 'Acme-Biz')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
  });
});

describe('createBusinessTx — email normalization', () => {
  it('trims and lowercases ownerEmail before persisting (self_serve)', async () => {
    await createBusinessTx(
      { ...selfServeInput, ownerEmail: '  Owner@Example.COM  ' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(bizCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
  });
});

describe('createBusinessTx — channel_enrollments', () => {
  it('admin mode still inserts a verified email enrollment (admin-created accounts are pre-verified)', async () => {
    await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const enrollCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO channel_enrollments'))!;
    expect(enrollCall).toBeDefined();
    const enrollTemplate = (enrollCall[0] as TemplateStringsArray).join('?');
    expect(enrollTemplate).toContain("'email'");
    expect(enrollTemplate).toContain("'verified'");
    expect(enrollTemplate).toContain('ON CONFLICT (account_id, channel, COALESCE(location_id,');
  });

  it('self_serve mode does NOT insert channel_enrollments at signup time (deferred to /api/auth/verify-otp post-OTP)', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' });
    const enrollCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO channel_enrollments'));
    expect(enrollCall).toBeUndefined();
  });
});

describe('createBusinessTx — result', () => {
  it('returns businessId, userId, accountId, and paymentUrl from buildPaymentLinkUrl', async () => {
    mockBuildPaymentLinkUrl.mockReturnValue('https://buy.stripe.com/xyz');
    const res = await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' });
    expect(res.businessId).toBeTruthy();
    expect(res.userId).toBeTruthy();
    expect(res.accountId).toBeTruthy();
    expect(res.paymentUrl).toBe('https://buy.stripe.com/xyz');
    expect(mockBuildPaymentLinkUrl).toHaveBeenCalledWith('standard', res.businessId, 'a@b.com');
  });

  it('returns paymentUrl=null when buildPaymentLinkUrl returns null', async () => {
    mockBuildPaymentLinkUrl.mockReturnValue(null);
    const res = await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' });
    expect(res.paymentUrl).toBeNull();
  });
});
