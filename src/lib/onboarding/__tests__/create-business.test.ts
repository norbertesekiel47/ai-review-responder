import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql } = vi.hoisted(() => {
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  return { mockSql };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

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
  // No more mockBuildPaymentLinkUrl — paymentUrl is always null now
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
  it('throws DuplicateEmailError on PG 23505 against the users.email constraint', async () => {
    mockSql.mockImplementation(() => {
      const err: any = new Error('duplicate key');
      err.code = '23505';
      err.constraint_name = 'users_email_key';
      throw err;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
    await expect(
      createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow(DuplicateEmailError);
  });

  // A 23505 on a DIFFERENT constraint (here migration 062's duplicate-place
  // index) must propagate unchanged — mapping it to DuplicateEmailError would
  // mislabel a duplicate-location conflict as a duplicate email and hide the
  // real cause from the caller.
  it('re-throws a 23505 on businesses_account_place_uniq unchanged (not DuplicateEmailError)', async () => {
    const placeErr: any = new Error(
      'duplicate key value violates unique constraint "businesses_account_place_uniq"',
    );
    placeErr.code = '23505';
    placeErr.constraint_name = 'businesses_account_place_uniq';
    mockSql.mockImplementation(() => {
      throw placeErr;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

    await expect(
      createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toBe(placeErr);
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
  it('returns businessId, userId, accountId, and paymentUrl=null (checkout session created by select-plan)', async () => {
    const res = await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'a' });
    expect(res.businessId).toBeTruthy();
    expect(res.userId).toBeTruthy();
    expect(res.accountId).toBeTruthy();
    // paymentUrl is always null now — the select-plan route creates
    // the Checkout Session instead of using Payment Links
    expect(res.paymentUrl).toBeNull();
  });

  it('returns paymentUrl=null for admin mode too', async () => {
    const res = await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    expect(res.paymentUrl).toBeNull();
  });
});

// VAL-BILLING-064: createBusinessTx creates accounts row with
// tier-selected fields (locations_included, locations_overage_price_cents)
describe('createBusinessTx — tier config fields in accounts row', () => {
  it('admin mode: sets locations_included=1 and locations_overage_price_cents=2500 for standard tier', async () => {
    await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    // Standard tier: included=1, overageCents=2500
    expect(accountsCall.some((a: unknown) => a === 1)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2500)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 7900)).toBe(true);
  });

  it('admin mode: sets locations_included=5 and locations_overage_price_cents=2000 for premium tier', async () => {
    const premiumInput = {
      ...adminInput,
      subscriptionTier: 'premium' as 'founders' | 'standard' | 'premium',
    };
    await createBusinessTx(premiumInput as AdminBusinessTxInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    // Premium tier: included=5, overageCents=2000
    expect(accountsCall.some((a: unknown) => a === 5)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2000)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 19900)).toBe(true);
  });

  it('admin mode: sets locations_included=1 and locations_overage_price_cents=0 for basic tier', async () => {
    const basicInput: AdminBusinessTxInput = {
      ...adminInput,
      subscriptionTier: 'basic' as any,
    };
    await createBusinessTx(basicInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    // Basic tier: included=1, overageCents=0
    expect(accountsCall.some((a: unknown) => a === 1)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 0)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2900)).toBe(true);
  });

  it('self_serve mode: sets locations_included=1 and locations_overage_price_cents=2500 for standard tier', async () => {
    await createBusinessTx(selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const accountsCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    // Self-serve defaults to standard: included=1, overageCents=2500
    expect(accountsCall.some((a: unknown) => a === 1)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2500)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 7900)).toBe(true);
  });

  it('accounts INSERT includes locations_included and locations_overage_price_cents columns', async () => {
    await createBusinessTx(adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    const template = (accountsCall[0] as TemplateStringsArray).join('?');
    expect(template).toContain('locations_included');
    expect(template).toContain('locations_overage_price_cents');
    expect(template).toContain('base_price_cents');
  });
});
