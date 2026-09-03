import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../__tests__/helpers/mock-sql';

const { mockRedactStripeCustomer } = vi.hoisted(() => ({
  mockRedactStripeCustomer: vi.fn(),
}));

vi.mock('../../../../src/lib/account-offboarding/stripe-customer-redaction', () => ({
  redactStripeCustomer: mockRedactStripeCustomer,
}));

import { runStripeCustomerRedactionPurgeStage } from '../purge-stages';
import { extractConcreteAdminProviderDispositions } from '../../../../src/lib/account-offboarding/provider-disposition';

const ACCOUNT_ID = '00000000-0000-7000-8000-000000000001';
const OFFBOARDING_ID = '00000000-0000-7000-8000-000000000002';
const CUSTOMER_ID = 'cus_purge_stage_1';

let harness: MockSqlHarness;
let sql: postgres.Sql;

function purgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    mode: 'delete_data',
    status: 'purge_scheduled',
    terminal_at: null,
    teardown_completed_at: new Date('2026-08-01T00:00:00.000Z'),
    purge_started_at: null,
    purge_cancelled_at: null,
    auth_user_id: null,
    recipient_email: null,
    provider_dispositions: [],
    stripe_customer_id: CUSTOMER_ID,
    stripe_subscription_id: null,
    zernio_account_ids: null,
    zernio_profile_ids: null,
    location_ids: null,
    stripe_step: null,
    zernio_accounts_step: null,
    zernio_profiles_step: null,
    location_archival_step: null,
    ...overrides,
  } as unknown as Parameters<typeof runStripeCustomerRedactionPurgeStage>[2];
}

/** The narrow client interface the stage forwards; never a real Stripe. */
function fakeStripe() {
  return {
    customers: { retrieve: vi.fn(), update: vi.fn(), del: vi.fn() },
    paymentMethods: {
      list: vi.fn(async () => ({ data: [], has_more: false })),
      detach: vi.fn(),
    },
  };
}

/** Query text of the provider_dispositions append, if one was issued. */
function dispositionAppend() {
  return harness.sqlCalls.find(
    (call) =>
      /\bUPDATE\s+account_offboardings\b/.test(call.text) &&
      /provider_dispositions/.test(call.text),
  );
}

function lockIndex(): number {
  return harness.sqlCalls.findIndex((call) =>
    /pg_advisory_xact_lock/.test(call.text),
  );
}

function sharingCountIndex(): number {
  return harness.sqlCalls.findIndex(
    (call) => /\bFROM\s+accounts\b/.test(call.text) && /COUNT/i.test(call.text),
  );
}

beforeEach(() => {
  harness = createMockSql();
  sql = harness.mockSql as unknown as postgres.Sql;
  mockRedactStripeCustomer.mockReset();
  mockRedactStripeCustomer.mockResolvedValue({ outcome: 'redacted' });
});

describe('runStripeCustomerRedactionPurgeStage', () => {
  it('runStripeCustomerRedactionPurgeStage is a no-op when the offboarding row carries no stripe_customer_id', async () => {
    // Nothing to redact and nothing to lock. Issuing a Stripe call here would
    // spend a network round trip on every cancel-only-turned-delete purge.
    await runStripeCustomerRedactionPurgeStage(
      sql,
      () => fakeStripe(),
      purgeRow({ stripe_customer_id: null }),
    );

    expect(mockRedactStripeCustomer).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('runStripeCustomerRedactionPurgeStage skips the Stripe call and records skipped_shared_customer when another non-purged account holds the same customer id', async () => {
    // D1. accounts.stripe_customer_id has no unique constraint, and
    // subscription-deleted.ts states the rule outright: one Stripe customer can
    // map to MULTIPLE accounts. Blind redaction would erase a LIVE co-tenant's
    // billing contact — the exact hazard this guard exists for.
    harness.sqlReturnQueue.push(mkTaggedResult([{}])); // binding lock
    harness.sqlReturnQueue.push(mkTaggedResult([{ count: 1 }])); // a sibling account
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: OFFBOARDING_ID }])); // append

    await runStripeCustomerRedactionPurgeStage(sql, () => fakeStripe(), purgeRow());

    expect(mockRedactStripeCustomer).not.toHaveBeenCalled();
    const append = dispositionAppend();
    expect(append).toBeDefined();
    expect(JSON.stringify(append!.values)).toContain('skipped_shared_customer');
  });

  it('runStripeCustomerRedactionPurgeStage takes the customer binding lock before counting sharing accounts', async () => {
    // D8, the half that lives on the reader side. A count in its own
    // transaction does not serialize against a writer binding the same customer
    // to another account a moment later; the lock must be held BEFORE the count
    // and for the whole transaction, including the Stripe call.
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ count: 0 }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: OFFBOARDING_ID }]));

    await runStripeCustomerRedactionPurgeStage(sql, () => fakeStripe(), purgeRow());

    expect(lockIndex()).toBe(0);
    expect(lockIndex()).toBeLessThan(sharingCountIndex());
    expect(harness.sqlCalls[0]!.values[0]).toBe(
      `${CUSTOMER_ID}:stripe_customer_binding`,
    );
    // Held for the whole transaction: every query, and the Stripe call, run
    // inside the one sql.begin.
    expect(harness.sqlCalls.every((call) => call.inTransaction)).toBe(true);
  });

  it('the redaction guard still skips when the writer wins the binding lock first', async () => {
    // The other lock-winner order. If the writer commits its binding first, the
    // guard's count sees the new sibling and must skip — the lock only makes
    // the two orders deterministic, it does not decide the outcome.
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ count: 1 }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: OFFBOARDING_ID }]));

    await runStripeCustomerRedactionPurgeStage(sql, () => fakeStripe(), purgeRow());

    expect(mockRedactStripeCustomer).not.toHaveBeenCalled();
    expect(JSON.stringify(dispositionAppend()!.values)).toContain(
      'skipped_shared_customer',
    );
  });

  it('runStripeCustomerRedactionPurgeStage appends a system provider-redaction record that extractConcreteAdminProviderDispositions ignores', async () => {
    // The record shares a column with the ADMIN provider disposition, whose
    // presence is a purge-eligibility gate. A new type discriminator keeps the
    // two apart by construction: isConcreteAdminProviderDisposition rejects any
    // value whose `type` does not match, so the teardown resolution gate cannot
    // be satisfied by a record the purge wrote for itself.
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ count: 0 }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: OFFBOARDING_ID }]));

    await runStripeCustomerRedactionPurgeStage(sql, () => fakeStripe(), purgeRow());

    const append = dispositionAppend();
    expect(append).toBeDefined();
    const appended = append!.values.find(
      (value) => Array.isArray(value) || (value && typeof value === 'object'),
    );
    const records = Array.isArray(appended) ? appended : [appended];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'stripe', outcome: 'redacted' });
    expect(extractConcreteAdminProviderDispositions(records)).toEqual([]);
  });

  it('runStripeCustomerRedactionPurgeStage never writes the raw stripe customer id into provider_dispositions', async () => {
    // Same rule scrubDispositionText applies to an admin-recorded resource
    // reference: the record is an audit trail, not a second copy of the
    // identifier the tombstone is about to destroy.
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ count: 0 }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: OFFBOARDING_ID }]));

    await runStripeCustomerRedactionPurgeStage(sql, () => fakeStripe(), purgeRow());

    const append = dispositionAppend();
    const serialized = JSON.stringify(append!.values);
    expect(serialized).not.toContain(CUSTOMER_ID);
    expect(serialized).toContain('sha256:');
  });
});
