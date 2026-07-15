import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

import {
  createBusinessTx,
  DuplicateEmailError,
  PLACEHOLDER_BUSINESS_NAME,
  TierPriceConfigurationError,
  type AdminBusinessTxInput,
  type SelfServeBusinessTxInput,
} from '../create-business';
import { resetServerConfigForTests } from '@/lib/config/server';

const adminInput: AdminBusinessTxInput = {
  ownerEmail: 'a@b.com',
  ownerName: 'Jane',
  businessName: 'Acme',
  subscriptionTier: 'copilot',
  placeId: { placeIdVerified: true, placeId: 'ChIJtest' },
};

const selfServeInput: SelfServeBusinessTxInput = {
  ownerEmail: 'a@b.com',
  ownerName: 'Jane',
};

let harness: MockSqlHarness;
// createBusinessTx now takes `sql: Sql` as an explicit leading parameter —
// the fragment-aware harness stands in for it. Cast once here, same
// convention as src/lib/auth/__tests__/provision-auth-user.test.ts. Assertion
// sites below still reach into `harness.mockSql.mock.calls` for the raw
// TemplateStringsArray + bound-values introspection this suite relies on.
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  vi.useFakeTimers();
  vi.stubEnv('FOUNDING_DEADLINE', '2027-01-01T00:00:00Z');
  vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', 'price_copilot_list');
  vi.stubEnv('STRIPE_PRICE_COPILOT_FOUNDING', 'price_copilot_founding');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_LIST', 'price_autopilot_list');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_FOUNDING', 'price_autopilot_founding');
  vi.stubEnv('STRIPE_PRICE_COPILOT_OVERAGE', 'price_copilot_overage');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_OVERAGE', 'price_autopilot_overage');
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
  resetServerConfigForTests();
  // No more mockBuildPaymentLinkUrl — paymentUrl is always null now
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetServerConfigForTests();
});

describe('createBusinessTx — admin mode', () => {
  it('rejects missing base Price before opening a transaction or writing SQL', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', '');
    await expect(
      createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' }),
    ).rejects.toBeInstanceOf(TierPriceConfigurationError);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('rejects missing overage Price before opening a transaction or writing SQL', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_OVERAGE', '');
    await expect(
      createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' }),
    ).rejects.toBeInstanceOf(TierPriceConfigurationError);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('writes users.auth_id=NULL and does NOT create outbox entry for placeIdVerified=true', async () => {
    // With placeIdVerified=true, no outbox row is inserted — review ingestion
    // is webhook-driven via Zernio. Only businesses + users + channel_enrollments are written.
    const res = await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    expect(res.businessId).toBeTruthy();
    const calls = harness.mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // auth_id position in admin mode must be null (verified against args structure)
    expect(usersCallArgs).toContain(null);
  });

  it('does NOT enqueue sync_reviews when placeIdVerified=true (webhook-driven now)', async () => {
    await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const allArgs = harness.mockSql.mock.calls.flat();
    // sync_reviews must not appear anywhere in the call args or template text.
    expect(allArgs.some((v: unknown) => v === 'sync_reviews')).toBe(false);
    const calls = harness.mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    expect(calls.some((t: string) => t.includes('sync_reviews'))).toBe(false);
  });

  it('enqueues validate_place_id when placeIdVerified=false', async () => {
    const input: AdminBusinessTxInput = {
      ...adminInput,
      placeId: { placeIdVerified: false, googleMapsUrl: 'https://maps.google.com/?cid=1' },
    };
    await createBusinessTx(mockSql, input, { mode: 'admin', onboardedBy: 'admin-1' });
    const outboxCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'))!;
    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array.
    expect(outboxCall.slice(1)).toContain('validate_place_id');
  });

  it('writes onboarded_by value to businesses row', async () => {
    await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-xyz-123' });
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === 'admin-xyz-123')).toBe(true);
  });
});

describe('createBusinessTx — self_serve mode', () => {
  it('rejects missing base Price before opening a transaction or writing SQL', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', '');
    await expect(
      createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' }),
    ).rejects.toBeInstanceOf(TierPriceConfigurationError);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('rejects missing overage Price before opening a transaction or writing SQL', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_OVERAGE', '');
    await expect(
      createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' }),
    ).rejects.toBeInstanceOf(TierPriceConfigurationError);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('writes users.auth_id=authId, placeholder businesses row, and skips outbox insert', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const calls = harness.mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(usersCallArgs.some((a: unknown) => a === 'auth-xyz')).toBe(true);
  });

  it('writes businesses.name as PLACEHOLDER_BUSINESS_NAME', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === PLACEHOLDER_BUSINESS_NAME)).toBe(true);
  });

  it('writes NULL google_place_id and NULL google_maps_url on the placeholder row', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
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
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === false)).toBe(true);
  });

  it('does NOT enqueue outbox in self_serve mode', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const outboxCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'));
    expect(outboxCall).toBeUndefined();
  });

  it('starts self-serve accounts at the safe Copilot pending snapshot', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    expect(bizCall.some((a: unknown) => a === 'copilot')).toBe(true);
  });
});

describe('createBusinessTx — duplicate email', () => {
  it('throws DuplicateEmailError on PG 23505 against the users.email constraint', async () => {
    const err: any = new Error('duplicate key');
    err.code = '23505';
    err.constraint_name = 'users_email_key';
    // Pre-handled rejection queued for the first awaited tx query — same
    // convention as src/lib/shared/__tests__/outbox.test.ts. Which specific
    // INSERT "fails" doesn't matter here; this pins createBusinessTx's
    // catch/rethrow policy, not statement ordering.
    const rejected = Promise.reject(err);
    rejected.catch(() => {});
    harness.sqlReturnQueue.push(rejected);

    await expect(
      createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'a' }),
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
    const rejected = Promise.reject(placeErr);
    rejected.catch(() => {});
    harness.sqlReturnQueue.push(rejected);

    await expect(
      createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toBe(placeErr);
  });

  it('re-throws non-23505 PG errors unchanged', async () => {
    const otherErr: any = new Error('connection timeout');
    otherErr.code = '08006';
    const rejected = Promise.reject(otherErr);
    rejected.catch(() => {});
    harness.sqlReturnQueue.push(rejected);
    await expect(
      createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow('connection timeout');
  });
});

describe('createBusinessTx — field-name regression', () => {
  it('maps ownerName→users.name in self_serve mode', async () => {
    await createBusinessTx(mockSql,
      { ...selfServeInput, ownerName: 'Jane-Owner' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // owner_name on businesses row + users.name both come from input.ownerName.
    expect(bizCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
  });

  it('maps businessName→businesses.name in admin mode', async () => {
    await createBusinessTx(mockSql,
      { ...adminInput, businessName: 'Acme-Biz', ownerName: 'Jane-Owner' },
      { mode: 'admin', onboardedBy: 'a' },
    );
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(bizCall.some((a: unknown) => a === 'Acme-Biz')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
  });
});

describe('createBusinessTx — email normalization', () => {
  it('trims and lowercases ownerEmail before persisting (self_serve)', async () => {
    await createBusinessTx(mockSql,
      { ...selfServeInput, ownerEmail: '  Owner@Example.COM  ' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(bizCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'owner@example.com')).toBe(true);
  });
});

describe('createBusinessTx — channel_enrollments', () => {
  it('admin mode still inserts a verified email enrollment (admin-created accounts are pre-verified)', async () => {
    await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const enrollCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO channel_enrollments'))!;
    expect(enrollCall).toBeDefined();
    const enrollTemplate = (enrollCall[0] as TemplateStringsArray).join('?');
    expect(enrollTemplate).toContain("'email'");
    expect(enrollTemplate).toContain("'verified'");
    expect(enrollTemplate).toContain('ON CONFLICT (account_id, channel, COALESCE(location_id,');
  });

  it('self_serve mode does NOT insert channel_enrollments at signup time (deferred to /api/auth/verify-otp post-OTP)', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'a' });
    const enrollCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO channel_enrollments'));
    expect(enrollCall).toBeUndefined();
  });
});

describe('createBusinessTx — result', () => {
  it('returns businessId, userId, accountId, and paymentUrl=null (checkout session created by select-plan)', async () => {
    const res = await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'a' });
    expect(res.businessId).toBeTruthy();
    expect(res.userId).toBeTruthy();
    expect(res.accountId).toBeTruthy();
    // paymentUrl is always null now — the select-plan route creates
    // the Checkout Session instead of using Payment Links
    expect(res.paymentUrl).toBeNull();
  });

  it('returns paymentUrl=null for admin mode too', async () => {
    const res = await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    expect(res.paymentUrl).toBeNull();
  });
});

// VAL-BILLING-064: createBusinessTx creates accounts row with
// tier-selected fields (locations_included, locations_overage_price_cents)
describe('createBusinessTx — complete immutable billing snapshot', () => {
  it('admin Copilot/list writes every snapshot field with no fallback cents', async () => {
    await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    const template = (accountsCall[0] as TemplateStringsArray).join('?');
    expect(template).toContain('price_variant');
    expect(template).toContain('locations_paid');
    expect(accountsCall.slice(1)).toContain('list');
    expect(accountsCall.slice(1)).toContain('copilot');
    expect(accountsCall.some((a: unknown) => a === 1)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 1500)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2900)).toBe(true);
    expect(accountsCall.slice(1)).toContain(0);
  });

  it('admin Autopilot/founding writes $49 complete snapshot', async () => {
    vi.setSystemTime(new Date('2026-12-31T23:59:59Z'));
    vi.stubEnv('AUTOPILOT_PURCHASABLE', 'true');
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    resetServerConfigForTests();
    const autopilotInput: AdminBusinessTxInput = {
      ...adminInput,
      subscriptionTier: 'autopilot',
    };
    await createBusinessTx(mockSql, autopilotInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    expect(accountsCall.slice(1)).toContain('founding');
    expect(accountsCall.slice(1)).toContain('autopilot');
    expect(accountsCall.some((a: unknown) => a === 4900)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2000)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 1)).toBe(true);
  });

  it('self-serve exact deadline is list Copilot with paid=0', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const accountsCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    expect(accountsCall.slice(1)).toContain('list');
    expect(accountsCall.slice(1)).toContain('copilot');
    expect(accountsCall.some((a: unknown) => a === 1)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 1500)).toBe(true);
    expect(accountsCall.some((a: unknown) => a === 2900)).toBe(true);
    expect(accountsCall.slice(1)).toContain(0);
  });

  it('self-serve one second before deadline is founding Copilot', async () => {
    vi.setSystemTime(new Date('2026-12-31T23:59:59Z'));
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const accountsCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    expect(accountsCall.slice(1)).toContain('founding');
    expect(accountsCall.slice(1)).toContain(1900);
  });

  it('accounts INSERT includes locations_included and locations_overage_price_cents columns', async () => {
    await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const accountsCall = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO accounts'))!;
    const template = (accountsCall[0] as TemplateStringsArray).join('?');
    expect(template).toContain('locations_included');
    expect(template).toContain('locations_overage_price_cents');
    expect(template).toContain('base_price_cents');
    expect(template).toContain('price_variant');
    expect(template).toContain('locations_paid');
  });

  it('closed Autopilot gate performs zero SQL writes', async () => {
    vi.stubEnv('AUTOPILOT_PURCHASABLE', 'false');
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    resetServerConfigForTests();
    await expect(
      createBusinessTx(
        mockSql,
        { ...adminInput, subscriptionTier: 'autopilot' },
        { mode: 'admin', onboardedBy: 'admin-1' },
      ),
    ).rejects.toThrow('Autopilot is not currently purchasable');
    expect(harness.sqlCalls).toHaveLength(0);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
  });
});

// Regression test for A+ campaign 2a (src/app/api/auth/finish-signup/route.ts).
// finish-signup used to have a dead pre-migration-034 fallback branch for the
// case where the owner's account_id came back null from a post-createBusinessTx
// SELECT — its own comment admitted the fallback could only error. That branch
// was deleted; this test pins the precondition that made it unreachable:
// createBusinessTx ALWAYS writes a non-null account_id on the users row it
// creates (both modes), so a subsequent SELECT for that same user can never
// legitimately return a null account_id.
describe('createBusinessTx — account_id regression (users row always non-null)', () => {
  it('self_serve mode: users INSERT carries a non-null account_id', async () => {
    await createBusinessTx(mockSql, selfServeInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const usersCallArgs = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // Column order is (id, auth_id, name, email, phone, role, account_id) with
    // 'owner' written as a literal (not bound) — account_id is therefore the
    // LAST bound value in the INSERT.
    const accountIdArg = usersCallArgs.at(-1);
    expect(accountIdArg).not.toBeNull();
    expect(accountIdArg).not.toBeUndefined();
    expect(accountIdArg).toBe('test-uuid'); // uuid mock — proves a real generated id was bound, not null
  });

  it('admin mode: users INSERT carries a non-null account_id', async () => {
    await createBusinessTx(mockSql, adminInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const usersCallArgs = harness.mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    const accountIdArg = usersCallArgs.at(-1);
    expect(accountIdArg).not.toBeNull();
    expect(accountIdArg).not.toBeUndefined();
    expect(accountIdArg).toBe('test-uuid');
  });
});
