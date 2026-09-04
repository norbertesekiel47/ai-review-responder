import { beforeEach, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import {
  acquireBillingLock,
  acquireStripeCustomerBindingLock,
  acquireTierEntitlementLock,
  acquireTierAndBillingLocks,
  acquireTierBillingActivationLocks,
} from '../billing-locks';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BUSINESS_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const STRIPE_CUSTOMER_ID = 'cus_binding_lock_1';

let harness: MockSqlHarness;
let tx: TransactionSql;

beforeEach(() => {
  harness = createMockSql();
  tx = harness.mockSql as unknown as TransactionSql;
});

describe('billing advisory lock graph', () => {
  it('approval lanes can take entitlement without the billing lock', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    await acquireTierEntitlementLock(tx, ACCOUNT_ID);
    expect(harness.sqlCalls.map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
    ]);
  });

  it('tier writers acquire entitlement then billing', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{}]), mkTaggedResult([{}]));
    await acquireTierAndBillingLocks(tx, ACCOUNT_ID);
    expect(harness.sqlCalls.map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
    ]);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('overage-only writers acquire only billing', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    await acquireBillingLock(tx, ACCOUNT_ID);
    expect(harness.sqlCalls.map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:overage_sync`,
    ]);
  });

  it('activation is always third and preserves the caller-specific lock identity', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );
    await acquireTierBillingActivationLocks(tx, ACCOUNT_ID, BUSINESS_ID);
    expect(harness.sqlCalls.map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
      `${BUSINESS_ID}:activation`,
    ]);
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('acquireStripeCustomerBindingLock hashes the customer id with its own dedicated suffix', async () => {
    // D8. The lock is keyed on the STRIPE CUSTOMER, not the account, because
    // one customer id may map to several accounts. A suffix shared with any
    // account-keyed lock above would collide two different lock domains onto
    // one hashtext input.
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));

    await acquireStripeCustomerBindingLock(tx, STRIPE_CUSTOMER_ID);

    expect(harness.sqlCalls.map((call) => call.values[0])).toEqual([
      `${STRIPE_CUSTOMER_ID}:stripe_customer_binding`,
    ]);
    expect(harness.sqlCalls[0]!.text).toContain('pg_advisory_xact_lock');
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });
});
