// Decision-table tests for applyTierSnapshot + resolveCheckoutContext
// (A+ campaign PR 2c extraction from the select-plan route). Each `it` pins
// one branch of the original route logic — see
// src/app/api/onboarding/select-plan/route.ts history / plan-activation.ts
// doc comments for the branch descriptions.
//
// Both functions are born-injected (sql is a parameter), so no @/lib/db/server
// module mocking is needed — the fragment-aware `createMockSql` harness
// (shared with worker suites) stands in for `sql` directly. trialEnabled is
// mocked in isolation since it reads process.env via a shared flag primitive
// unrelated to this module's own logic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import type { TierConfig } from '@/lib/accounts/tier-config';

const { mockTrialEnabled } = vi.hoisted(() => ({
  mockTrialEnabled: vi.fn(),
}));

vi.mock('../flags', () => ({
  trialEnabled: mockTrialEnabled,
}));

import { applyTierSnapshot, resolveCheckoutContext } from '../plan-activation';

const BUSINESS_ID = 'biz-1';
const STANDARD_CONFIG: TierConfig = {
  baseCents: 7900,
  included: 1,
  overageCents: 2500,
  multiLocAllowed: true,
};

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  // The fragment-aware harness mocks the tagged-template + `.begin` shape of
  // Postgres.js's `Sql` without implementing its full type surface — cast,
  // same convention as src/lib/auth/__tests__/provision-auth-user.test.ts.
  mockSql = harness.mockSql as unknown as Sql;
  mockTrialEnabled.mockReset();
  mockTrialEnabled.mockReturnValue(false);
});

describe('applyTierSnapshot', () => {
  it('ok: pending_payment account, UPDATE matches a row → kind ok, and every statement fires in order inside the tx', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{}])); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push(mkTaggedResult([{ subscription_status: 'pending_payment' }])); // FOR UPDATE OF a
    harness.sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE accounts (no RETURNING)
    harness.sqlReturnQueue.push(Object.assign([], { count: 1 })); // UPDATE businesses

    const result = await applyTierSnapshot(mockSql, {
      businessId: BUSINESS_ID,
      tier: 'standard',
      tierConfig: STANDARD_CONFIG,
    });

    expect(result).toEqual({ kind: 'ok' });
    expect(harness.sqlCalls).toHaveLength(4);

    const [lockCall, forUpdateCall, updateAccountsCall, updateBusinessesCall] = harness.sqlCalls;

    // Advisory lock: hashtext(businessId + ':activation'), taken BEFORE any read.
    expect(lockCall!.text).toContain('pg_advisory_xact_lock(hashtext(');
    expect(lockCall!.values).toContain(`${BUSINESS_ID}:activation`);

    // Row lock: FOR UPDATE OF a specifically (not the whole join).
    expect(forUpdateCall!.text).toMatch(/FOR UPDATE OF a/);
    expect(forUpdateCall!.text).toContain('accounts a');
    expect(forUpdateCall!.values).toContain(BUSINESS_ID);

    // Snapshot columns + bound tier-config values (VAL-BILLING-065).
    expect(updateAccountsCall!.text).toContain('UPDATE accounts');
    expect(updateAccountsCall!.text).toContain('subscription_tier');
    expect(updateAccountsCall!.text).toContain('locations_included');
    expect(updateAccountsCall!.text).toContain('locations_overage_price_cents');
    expect(updateAccountsCall!.text).toContain('base_price_cents');
    expect(updateAccountsCall!.text).toContain('updated_at');
    expect(updateAccountsCall!.values).toEqual(
      expect.arrayContaining(['standard', 1, 2500, 7900, BUSINESS_ID, 'pending_payment']),
    );

    // Deprecated column, retained (VAL-SCHEMA-037).
    expect(updateBusinessesCall!.text).toContain('UPDATE businesses');
    expect(updateBusinessesCall!.text).toContain('subscription_tier');
    expect(updateBusinessesCall!.values).toContain('standard');
  });

  it('not_found: FOR UPDATE query returns no row → kind not_found (row vanished between lookup and lock)', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push(mkTaggedResult([])); // FOR UPDATE OF a — no row

    const result = await applyTierSnapshot(mockSql, {
      businessId: BUSINESS_ID,
      tier: 'standard',
      tierConfig: STANDARD_CONFIG,
    });

    expect(result).toEqual({ kind: 'not_found' });
    // Never reaches the UPDATE statements.
    expect(harness.sqlCalls).toHaveLength(2);
  });

  it('wrong_status: subscription_status !== pending_payment → kind wrong_status carrying the actual status', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{}])); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push(mkTaggedResult([{ subscription_status: 'active' }])); // FOR UPDATE OF a

    const result = await applyTierSnapshot(mockSql, {
      businessId: BUSINESS_ID,
      tier: 'standard',
      tierConfig: STANDARD_CONFIG,
    });

    expect(result).toEqual({ kind: 'wrong_status', status: 'active' });
    expect(harness.sqlCalls).toHaveLength(2);
  });

  it('race_lost: pending_payment check passes but UPDATE accounts matches 0 rows → kind race_lost, businesses UPDATE never fires', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{}])); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push(mkTaggedResult([{ subscription_status: 'pending_payment' }])); // FOR UPDATE OF a
    harness.sqlReturnQueue.push(Object.assign([], { count: 0 })); // UPDATE accounts — 0 rows matched

    const result = await applyTierSnapshot(mockSql, {
      businessId: BUSINESS_ID,
      tier: 'standard',
      tierConfig: STANDARD_CONFIG,
    });

    expect(result).toEqual({ kind: 'race_lost' });
    // Only 3 calls — the businesses UPDATE is skipped after race_lost.
    expect(harness.sqlCalls).toHaveLength(3);
  });
});

describe('resolveCheckoutContext', () => {
  it('returns null when the business row is missing', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    const result = await resolveCheckoutContext(mockSql, BUSINESS_ID);

    expect(result).toBeNull();
  });

  it('trialEligible: true when TRIAL_ENABLED is on and onboarded_by is null (self-serve)', async () => {
    mockTrialEnabled.mockReturnValue(true);
    harness.sqlReturnQueue.push(mkTaggedResult([{ account_id: 'acct-1', onboarded_by: null }]));

    const result = await resolveCheckoutContext(mockSql, BUSINESS_ID);

    expect(result).toEqual({ accountId: 'acct-1', trialEligible: true });
  });

  it('trialEligible: false when onboarded_by is non-null (admin/partner-onboarded), even with TRIAL_ENABLED on', async () => {
    mockTrialEnabled.mockReturnValue(true);
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ account_id: 'acct-1', onboarded_by: 'admin-user-1' }]),
    );

    const result = await resolveCheckoutContext(mockSql, BUSINESS_ID);

    expect(result).toEqual({ accountId: 'acct-1', trialEligible: false });
  });

  it('trialEligible: false when TRIAL_ENABLED is off, even for a self-serve (onboarded_by null) account', async () => {
    mockTrialEnabled.mockReturnValue(false);
    harness.sqlReturnQueue.push(mkTaggedResult([{ account_id: 'acct-1', onboarded_by: null }]));

    const result = await resolveCheckoutContext(mockSql, BUSINESS_ID);

    expect(result).toEqual({ accountId: 'acct-1', trialEligible: false });
  });
});
