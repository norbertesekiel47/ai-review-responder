// Shared fixtures for the Stripe webhook handler unit suites.
//
// The per-handler suites (stripe-subscription-updated, stripe-invoice-paid,
// stripe-subscription-deleted, …) all drive the same handler entry point
// (`handleStripeWebhook`) and shared the same hand-rolled mock graph + queue
// helpers when they lived in one file. This module is the single authoritative
// owner of that graph so the split files stay DRY.
//
// The Postgres.js mock itself is the repo-canonical one from
// `worker/__tests__/helpers/mock-sql` (issue #268: stop hand-rolling copies).
//
// NOT a test file: the vitest include glob only matches
// `**/__tests__/**/*.test.{ts,tsx}`, so this helper is invisible to the runner
// and only loaded by suites that import it.
//
// Usage (the canonical mock-sql async-hoisted pattern — `vi.hoisted` runs before
// static imports are initialized, so the harness is built via dynamic import):
//
//   const { mockSql, sqlReturnQueue, sqlCalls, mockClaimInboundEvent,
//           mockConstructEvent, mockWriteAccountAuditLog, resetStripeWebhookMocks,
//           queueSubscriptionUpdated } = await vi.hoisted(async () => {
//     const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
//     return createStripeWebhookHarness();
//   });
//   vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v) => v }));
//   vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
//   vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
//   vi.mock('stripe', () => ({ default: class { webhooks = { constructEvent: mockConstructEvent }; } }));

import { vi, type Mock } from 'vitest';
import type { SubscriptionTierValue } from '../../../../src/lib/accounts/tier-config';
import {
  createMockSql,
  type MockSql,
  type RecordedSqlCall,
} from '../../../__tests__/helpers/mock-sql';

export const TEST_ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
export const TEST_CUSTOMER_ID = 'cus_test_123';
export const TEST_SUBSCRIPTION_ID = 'sub_test_456';
export const TEST_CHECKOUT_EMAIL = 'owner@example.com';
export const TEST_CHECKOUT_SUCCESS_URL = 'https://repworth.example/onboarding?checkout=success';
export const TEST_CHECKOUT_CANCEL_URL = 'https://repworth.example/onboarding?checkout=cancelled';

// Price env vars for reverse-map tests. Module-private — consumed only by the
// harness helpers below, not by the per-handler test files.
const PRICE_ENV_VARS = {
  STRIPE_PRICE_COPILOT_LIST: 'price_copilot_list_test',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_copilot_founding_test',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_autopilot_list_test',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_autopilot_founding_test',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_copilot_overage_test',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_autopilot_overage_test',
} as const;

// ── Pure request/reply fixtures ──────────────────────────────────────

function mkRequest(rawBody = '{}', sig = 't=1,v1=fake'): any {
  return { headers: { 'stripe-signature': sig }, rawBody };
}

function mkReply() {
  const status = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  return { status, send };
}

export { mkRequest, mkReply };

// ── Env install/restore ──────────────────────────────────────────────

/**
 * Sets the Stripe secret/webhook + price env vars that the handlers read at call
 * time (the stripe SDK is mocked, and the reverse-map reads STRIPE_PRICE_* per
 * call), capturing prior values. Returns a restore fn for `afterAll`.
 */
export function installStripeWebhookEnv(): () => void {
  const origStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const origStripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';

  const origPriceEnvVars: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(PRICE_ENV_VARS)) {
    origPriceEnvVars[key] = process.env[key];
    process.env[key] = value;
  }

  return () => {
    if (origStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = origStripeSecretKey;
    if (origStripeWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = origStripeWebhookSecret;
    for (const [key, orig] of Object.entries(origPriceEnvVars)) {
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  };
}

// ── Mock graph + queue helpers ───────────────────────────────────────

export interface StripeWebhookHarness {
  mockSql: MockSql;
  sqlReturnQueue: unknown[];
  sqlCalls: RecordedSqlCall[];
  mockClaimInboundEvent: Mock;
  mockConstructEvent: Mock;
  mockWriteAccountAuditLog: Mock;
  /**
   * `beforeEach` reset: clears the queue + recorded calls, restores the default
   * mock implementations, and re-applies the price env vars (verbatim of the
   * original webhook-handlers `beforeEach`). `mockSql` is deliberately NOT
   * cleared/reset — that would wipe the queue-based implementation.
   */
  resetStripeWebhookMocks: () => void;
  queueSubscriptionUpdated: (opts?: {
    tier?: SubscriptionTierValue;
    status?: string;
    locationsPaid?: number;
    updateBiz?: boolean;
    stripeSubscriptionId?: string;
    activeOffboardingSubscriptionId?: string | null;
    overagePriceCents?: number;
  }) => void;
  queueInvoicePaymentFailed: (opts?: { status?: string }) => void;
  queueInvoicePaid: (opts?: { status?: string }) => void;
  queueSubscriptionDeleted: (opts?: {
    status?: string;
    stripeSubscriptionId?: string;
    activeOffboardingSubscriptionId?: string | null;
  }) => void;
  queueCheckoutActivate: (opts?: {
    accountId?: string;
    status?: string;
    sessionId?: string;
    customerId?: string;
    subscriptionId?: string;
  }) => void;
}

export function createStripeWebhookHarness(): StripeWebhookHarness {
  const { mockSql, sqlReturnQueue, sqlCalls } = createMockSql();
  const mockClaimInboundEvent = vi.fn();
  const mockConstructEvent = vi.fn();
  const mockWriteAccountAuditLog = vi.fn().mockResolvedValue(undefined);

  function resetStripeWebhookMocks() {
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    // Don't call mockClear/mockReset on mockSql — it would wipe the
    // queue-based implementation. Just clear our custom tracking arrays.
    mockClaimInboundEvent.mockClear();
    mockClaimInboundEvent.mockResolvedValue('claimed');
    mockConstructEvent.mockReset();
    mockWriteAccountAuditLog.mockClear();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);

    // Re-apply price env vars in case a test modified them
    for (const [key, value] of Object.entries(PRICE_ENV_VARS)) {
      process.env[key] = value;
    }
  }

  // Queue helper: canonical subscription.updated transaction flow.
  // NOTE: the audit write now goes through the mocked writeAccountAuditLog, so it
  // is NOT a tx SQL call and is asserted via mockWriteAccountAuditLog (not the queue).
  function queueSubscriptionUpdated(opts: {
    tier?: SubscriptionTierValue;
    status?: string;
    locationsPaid?: number;
    updateBiz?: boolean;
    stripeSubscriptionId?: string;
    activeOffboardingSubscriptionId?: string | null;
    overagePriceCents?: number;
  } = {}) {
    const tier = opts.tier ?? 'copilot';
    const status = opts.status ?? 'active';
    const locationsPaid = opts.locationsPaid ?? 0;
    // Inside sql.begin -> tx calls in order:
    // 1. SELECT id, subscription_tier, subscription_status, locations_paid ... FOR UPDATE
    sqlReturnQueue.push([{
      id: TEST_ACCOUNT_ID,
      subscription_tier: tier,
      subscription_status: status,
      locations_paid: locationsPaid,
      locations_overage_price_cents: opts.overagePriceCents ?? 1500,
      stripe_subscription_id: opts.stripeSubscriptionId ?? TEST_SUBSCRIPTION_ID,
      active_offboarding_subscription_id: opts.activeOffboardingSubscriptionId ?? null,
    }]);
    // 2. pg_advisory_xact_lock
    sqlReturnQueue.push([]);
    // 3. UPDATE accounts SET subscription_tier, locations_paid, updated_at WHERE id
    const updateAcctResult: any = []; updateAcctResult.count = 1;
    sqlReturnQueue.push(updateAcctResult);
    // 4. UPDATE businesses SET subscription_tier, updated_at WHERE account_id
    const updateBizResult: any = []; updateBizResult.count = opts.updateBiz !== false ? 1 : 0;
    sqlReturnQueue.push(updateBizResult);
  }

  // Queue helper: invoice.payment_failed provider-current status projection.
  // Identity is resolved without a row lock, then entitlement is acquired before
  // the applier locks the canonical account. The deprecated business status mirror
  // is no longer written synchronously; a durable mirror-sync outbox row owns it.
  function queueInvoicePaymentFailed(opts: {
    status?: string;
  } = {}) {
    const status = opts.status ?? 'active';
    // 1. Handler's unlocked lineage lookup.
    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID }]);
    // 2. Advisory lock
    sqlReturnQueue.push([]);
    // 3. Applier's canonical account row lock + lineage recheck.
    sqlReturnQueue.push([{
      id: TEST_ACCOUNT_ID,
      subscription_status: status,
      primary_business_id: null,
      stripe_customer_id: TEST_CUSTOMER_ID,
      stripe_subscription_id: TEST_SUBSCRIPTION_ID,
    }]);
    if (status === 'active') {
      // 4. Applier's writeStatusColumns: UPDATE accounts SET subscription_status='past_due'
      const r1: any = []; r1.count = 1;
      sqlReturnQueue.push(r1);
      // 5. Durable deprecated-status mirror projection.
      const mirrorOutbox: any = []; mirrorOutbox.count = 1;
      sqlReturnQueue.push(mirrorOutbox);
      // 6. recordTrialConversionFailureIfRecent EXISTS query (failedSubscriptionId now
      //    non-null) → no recent trial conversion, so no trial_payment_failed emit.
      sqlReturnQueue.push([{ ok: false }]);
    }
    // Ingress wrapper marks the claimed event processed.
    sqlReturnQueue.push([]);
  }

  // Queue helper: invoice.paid tx flow (past_due → active)
  // Subscription-lineage scope (adversarial review): the recovery loop now recovers
  // an account ONLY when its stripe_subscription_id equals the invoice's subscription
  // id. The seeded account row carries TEST_SUBSCRIPTION_ID, so the paired invoice
  // fixture MUST also carry subscription: TEST_SUBSCRIPTION_ID (faithful 1:1 state),
  // or the recovery is correctly skipped.
  function queueInvoicePaid(opts: {
    status?: string;
  } = {}) {
    const status = opts.status ?? 'past_due';
    // 1. Handler's unlocked, customer+subscription lineage lookup.
    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID }]);
    // 2. pg_advisory_xact_lock result. Provider state is fetched after this
    // queue item and before the applier's canonical row lock below.
    sqlReturnQueue.push([]);
    // 3. Applier's canonical account row lock + lineage recheck.
    sqlReturnQueue.push([{
      id: TEST_ACCOUNT_ID,
      subscription_status: status,
      primary_business_id: null,
      stripe_customer_id: TEST_CUSTOMER_ID,
      stripe_subscription_id: TEST_SUBSCRIPTION_ID,
    }]);
    if (status === 'past_due') {
      // 4. Applier's writeStatusColumns: UPDATE accounts SET subscription_status='active' …
      const r1: any = []; r1.count = 1;
      sqlReturnQueue.push(r1);
      // 5. Applier's enqueueStripeOverageRecompute: INSERT INTO job_outbox
      const outboxInsert: any = []; outboxInsert.count = 1;
      sqlReturnQueue.push(outboxInsert);
      // 6. Durable deprecated-status mirror projection.
      const mirrorOutbox: any = []; mirrorOutbox.count = 1;
      sqlReturnQueue.push(mirrorOutbox);
    }
    // Ingress wrapper marks the claimed event processed.
    sqlReturnQueue.push([]);
  }

  // Queue helper: customer.subscription.deleted tx flow
  function queueSubscriptionDeleted(opts: {
    status?: string;
    stripeSubscriptionId?: string;
    activeOffboardingSubscriptionId?: string | null;
  } = {}) {
    const status = opts.status ?? 'active';
    const subId = opts.stripeSubscriptionId ?? TEST_SUBSCRIPTION_ID;
    // 1. Handler's SELECT … FOR UPDATE (resolves acctRow)
    sqlReturnQueue.push([{
      id: TEST_ACCOUNT_ID,
      subscription_status: status,
      stripe_subscription_id: subId,
      active_offboarding_subscription_id: opts.activeOffboardingSubscriptionId ?? null,
    }]);
    // The named stale-subscription fixtures use a noncanonical current id; they
    // return before taking entitlement. Default TEST_SUBSCRIPTION_ID fixtures
    // exercise the matching path.
    if (subId === TEST_SUBSCRIPTION_ID) {
      // 2. Advisory lock pg_advisory_xact_lock
      sqlReturnQueue.push([]);
      // 3. Applier's canonical account row lock + lineage recheck.
      sqlReturnQueue.push([{
        id: TEST_ACCOUNT_ID,
        subscription_status: status,
        primary_business_id: null,
        stripe_customer_id: TEST_CUSTOMER_ID,
        stripe_subscription_id: TEST_SUBSCRIPTION_ID,
      }]);
      if (status !== 'cancelled') {
        const r1: any = []; r1.count = 1;
        sqlReturnQueue.push(r1); // UPDATE accounts (applier writeStatusColumns)
        const mirrorOutbox: any = []; mirrorOutbox.count = 1;
        sqlReturnQueue.push(mirrorOutbox); // durable business-status mirror sync
      }
    }
    // Ingress wrapper marks the claimed event processed.
    sqlReturnQueue.push([]);
  }

  // Queue helper for the checkout paid-activation SQL sequence.
  // NOTE: businesses.stripe_customer_id / stripe_subscription_id are intentionally
  // NOT mirrored by the applier (deprecated columns, VAL-SCHEMA-037; the trial path
  // already never wrote them). The applier writes subscription_status + activated_at.
  // The handler takes entitlement -> billing -> activation, retrieves provider
  // current state, locks the canonical account, applies status without touching
  // businesses, writes the billing snapshot, commits, then projects the
  // deprecated mirror in business -> entitlement order.
  function queueCheckoutActivate(opts: {
    accountId?: string;
    status?: string;
    sessionId?: string;
    customerId?: string;
    subscriptionId?: string;
  } = {}) {
    const acctId = opts.accountId ?? TEST_ACCOUNT_ID;
    const status = opts.status ?? 'pending_payment';
    const sessionId = opts.sessionId ?? 'cs_test';
    const customerId = opts.customerId ?? TEST_CUSTOMER_ID;
    const subscriptionId = opts.subscriptionId ?? TEST_SUBSCRIPTION_ID;
    const attemptId = '019dc366-29ce-7000-a000-0000000000cc';
    // 1. Pre-tx account lookup
    sqlReturnQueue.push([{ id: acctId }]);
    // 2-4. entitlement, billing, activation advisory locks
    sqlReturnQueue.push([], [], []);
    const checkoutAccount = {
      id: acctId,
      subscription_tier: 'copilot',
      subscription_status: status,
      price_variant: 'list',
      base_price_cents: 2900,
      locations_paid: 0,
      locations_overage_price_cents: 1500,
      locations_included: 1,
      stripe_subscription_id: status === 'active' ? subscriptionId : null,
      stripe_customer_id: status === 'active' ? customerId : null,
      checkout_attempt_id: attemptId,
      checkout_session_id: sessionId,
      checkout_attempt_state: status === 'active' ? 'completed' : 'open',
      checkout_attempt_tier: 'copilot',
      checkout_attempt_price_variant: 'list',
      checkout_attempt_base_price_id: 'price_copilot_list_test',
      checkout_attempt_overage_price_id: 'price_copilot_overage_test',
      checkout_attempt_base_price_cents: 2900,
      checkout_attempt_overage_price_cents: 1500,
      checkout_attempt_locations_included: 1,
      checkout_attempt_locations_paid: 0,
      checkout_attempt_overage_quantity: 0,
      checkout_attempt_trial_period_days: null,
      checkout_attempt_tax_enabled: false,
      checkout_attempt_customer_email: TEST_CHECKOUT_EMAIL,
      checkout_attempt_success_url: TEST_CHECKOUT_SUCCESS_URL,
      checkout_attempt_cancel_url: TEST_CHECKOUT_CANCEL_URL,
    };
    // 5. Provider-current observed account row.
    sqlReturnQueue.push([checkoutAccount]);
    if (status !== 'active') {
      // 6. Pin the account row before taking a fresh READ COMMITTED snapshot
      //    of its active offboarding lifecycle.
      sqlReturnQueue.push([{ id: acctId }]);
      // 7. Canonical lease + active-offboarding projection after the row lock.
      sqlReturnQueue.push([checkoutAccount]);
      // 8. Applier resolveAccount (checkout mode, FOR UPDATE)
      sqlReturnQueue.push([{ id: acctId, subscription_status: status, primary_business_id: null }]);
      // 9. Applier status write. Business mirror is explicitly deferred.
      const updateAcctR: any = []; updateAcctR.count = 1;
      sqlReturnQueue.push(updateAcctR);
      // 10. enqueueStripeOverageRecompute: INSERT INTO job_outbox
      const outboxR: any = []; outboxR.count = 1;
      sqlReturnQueue.push(outboxR);
      // 11. enqueueStripeSubscriptionMirrorSync: INSERT INTO job_outbox
      const mirrorOutboxR: any = []; mirrorOutboxR.count = 1;
      sqlReturnQueue.push(mirrorOutboxR);
      // 12. Canonical snapshot update (change-only; audit is mocked).
      sqlReturnQueue.push([{ id: acctId }]);
      // 13. Retain completed attempt identity.
      sqlReturnQueue.push([{ id: acctId }]);
    }
    // Post-commit tier projection: business lock, entitlement, canonical tier,
    // then conditional businesses update.
    sqlReturnQueue.push(
      [{ id: 'business-1' }],
      [],
      [{ subscription_tier: 'copilot' }],
      [],
    );
    // Ingress wrapper marks the claimed event processed after the handler.
    sqlReturnQueue.push([]);
  }

  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockClaimInboundEvent,
    mockConstructEvent,
    mockWriteAccountAuditLog,
    resetStripeWebhookMocks,
    queueSubscriptionUpdated,
    queueInvoicePaymentFailed,
    queueInvoicePaid,
    queueSubscriptionDeleted,
    queueCheckoutActivate,
  };
}
