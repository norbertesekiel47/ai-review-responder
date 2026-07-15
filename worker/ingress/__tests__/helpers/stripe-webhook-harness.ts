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
  queueCheckoutActivate: (opts?: { accountId?: string; status?: string }) => void;
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

  // Queue helper: invoice.payment_failed tx flow (active → past_due)
  // After B1.3: the active→past_due status write is owned by the real applier
  // (checkout mode), so the SQL sequence is:
  //   1. Handler's SELECT … FOR UPDATE (resolves acctRow by (stripe_customer_id,
  //      stripe_subscription_id) — subscription-lineage scope, adversarial review)
  //   2. pg_advisory_xact_lock (always)
  //   3. Applier's resolveAccount SELECT (checkout mode, by accountId FOR UPDATE)
  //   4. Applier's writeStatusColumns: UPDATE accounts SET subscription_status='past_due', past_due_at=NOW()
  //   5. Applier's writeBusinessesMirror: UPDATE businesses SET subscription_status='past_due'
  //   6. writeAccountAuditLog — mocked, no SQL consumed
  //   7. enqueueLifecycleAnalytics — PAST_DUE from ACTIVE emits nothing (guard: fromStatus !== 'trialing')
  // The handler now REQUIRES the failed invoice's subscription id (scoped SELECT),
  // so the paired invoice fixture carries subscription: TEST_SUBSCRIPTION_ID and the
  // seeded account row's stripe_subscription_id matches it (faithful 1:1 state).
  // recordTrialConversionFailureIfRecent: failedSubscriptionId is now non-null, so for
  // an active→past_due transition the recent-convert EXISTS query runs — queued as
  // { ok: false } so no trial_payment_failed is emitted on a normal renewal.
  function queueInvoicePaymentFailed(opts: {
    status?: string;
  } = {}) {
    const status = opts.status ?? 'active';
    // 1. Handler's SELECT … FOR UPDATE (now scoped by customer + subscription)
    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status, stripe_subscription_id: TEST_SUBSCRIPTION_ID }]);
    // 2. Advisory lock
    sqlReturnQueue.push([]);
    if (status === 'active') {
      // 3. Applier's resolveAccount SELECT (checkout mode)
      sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: 'active', primary_business_id: null }]);
      // 4. Applier's writeStatusColumns: UPDATE accounts SET subscription_status='past_due'
      const r1: any = []; r1.count = 1;
      sqlReturnQueue.push(r1);
      // 5. Applier's writeBusinessesMirror: UPDATE businesses
      const r2: any = []; r2.count = 1;
      sqlReturnQueue.push(r2);
      // 6. recordTrialConversionFailureIfRecent EXISTS query (failedSubscriptionId now
      //    non-null) → no recent trial conversion, so no trial_payment_failed emit.
      sqlReturnQueue.push([{ ok: false }]);
    }
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
    // 1. Handler's SELECT … FOR UPDATE (stripe_customer_id lookup) — also reads
    //    stripe_subscription_id, which the recovery loop matches against the
    //    invoice's subscription id (lineage scope) before recovering.
    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status, stripe_subscription_id: TEST_SUBSCRIPTION_ID }]);
    if (status === 'past_due') {
      // 2. pg_advisory_xact_lock result
      sqlReturnQueue.push([]);
      // 3. Applier's resolveAccount SELECT (checkout mode, by accountId FOR UPDATE)
      //    Returns id + subscription_status + primary_business_id for the applier.
      sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: 'past_due', primary_business_id: null }]);
      // 4. Applier's writeStatusColumns: UPDATE accounts SET subscription_status='active' …
      const r1: any = []; r1.count = 1;
      sqlReturnQueue.push(r1);
      // 5. Applier's writeBusinessesMirror: UPDATE businesses …
      const r2: any = []; r2.count = 1;
      sqlReturnQueue.push(r2);
      // 6. Applier's enqueueStripeOverageRecompute: INSERT INTO job_outbox
      const outboxInsert: any = []; outboxInsert.count = 1;
      sqlReturnQueue.push(outboxInsert);
      // 7. Post-tx: primary business lookup for backfill resume
      sqlReturnQueue.push([{ id: '019dc366-29ce-7000-a000-000000000099' }]);
      // 8. maybeEnqueueBackfillResume zernio predicate (no match by default)
      sqlReturnQueue.push([]);
    }
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
    // 2. Advisory lock pg_advisory_xact_lock
    sqlReturnQueue.push([]);
    // 3. Applier's resolveAccount SELECT (subscription mode, inside applyStripeSubscriptionState)
    //    Only queued when the event subscription matches the account's current sub
    //    (i.e. NOT the stale/mismatch paths that early-return before reaching the applier).
    //    Stale-sub tests (stripeSubscriptionId !== TEST_SUBSCRIPTION_ID with event sub_old_*)
    //    call queueSubscriptionDeleted with a different stripeSubscriptionId and the
    //    event id won't match — those early-return before reaching the advisory lock,
    //    so nothing past item 1 is consumed. When subId matches the event sub, the applier runs.
    if (status !== 'cancelled') {
      sqlReturnQueue.push([{
        id: TEST_ACCOUNT_ID,
        subscription_status: status,
        primary_business_id: null,
      }]);
      const r1: any = []; r1.count = 1;
      sqlReturnQueue.push(r1); // UPDATE accounts (applier writeStatusColumns)
      const r2: any = []; r2.count = 1;
      sqlReturnQueue.push(r2); // UPDATE businesses (applier writeBusinessesMirror)
    } else {
      // already-cancelled: applier resolveAccount runs, but isAllowedTransition
      // returns false (CANCELLED→CANCELLED) so no UPDATEs fire.
      sqlReturnQueue.push([{
        id: TEST_ACCOUNT_ID,
        subscription_status: status,
        primary_business_id: null,
      }]);
    }
  }

  // Queue helper for the checkout paid-activation SQL sequence.
  // NOTE: businesses.stripe_customer_id / stripe_subscription_id are intentionally
  // NOT mirrored by the applier (deprecated columns, VAL-SCHEMA-037; the trial path
  // already never wrote them). The applier writes subscription_status + activated_at.
  // The handler takes entitlement -> billing -> activation, retrieves provider
  // current state, locks the canonical account, applies status without touching
  // businesses, writes the billing snapshot, commits, then projects the
  // deprecated mirror in business -> entitlement order.
  function queueCheckoutActivate(opts: { accountId?: string; status?: string } = {}) {
    const acctId = opts.accountId ?? TEST_ACCOUNT_ID;
    const status = opts.status ?? 'pending_payment';
    // 1. Pre-tx account lookup
    sqlReturnQueue.push([{ id: acctId }]);
    // 2-4. entitlement, billing, activation advisory locks
    sqlReturnQueue.push([], [], []);
    // 5. Checkout canonical account row (FOR UPDATE)
    sqlReturnQueue.push([{
      id: acctId,
      subscription_tier: 'copilot',
      price_variant: 'list',
      base_price_cents: 2900,
      locations_paid: 0,
      locations_overage_price_cents: 1500,
      locations_included: 1,
      stripe_subscription_id: null,
      stripe_customer_id: null,
    }]);
    // 6. Applier resolveAccount (checkout mode, FOR UPDATE)
    sqlReturnQueue.push([{ id: acctId, subscription_status: status, primary_business_id: null }]);
    if (status !== 'active') {
      // 7. Applier status write. Business mirror is explicitly deferred.
      const updateAcctR: any = []; updateAcctR.count = 1;
      sqlReturnQueue.push(updateAcctR);
      // 8. enqueueStripeOverageRecompute: INSERT INTO job_outbox
      const outboxR: any = []; outboxR.count = 1;
      sqlReturnQueue.push(outboxR);
    }
    // Canonical snapshot update (change-only; audit is mocked).
    sqlReturnQueue.push([{ id: acctId }]);
    // Post-commit tier projection: business lock, entitlement, canonical tier,
    // then conditional businesses update.
    sqlReturnQueue.push(
      [{ id: 'business-1' }],
      [],
      [{ subscription_tier: 'copilot' }],
      [],
    );
    // Independent status/activation projection in the same lock order.
    sqlReturnQueue.push(
      [{ id: 'business-1' }],
      [],
      [{
        subscription_status: 'active',
        subscription_activated_at: new Date('2026-07-15T00:00:00Z'),
      }],
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
