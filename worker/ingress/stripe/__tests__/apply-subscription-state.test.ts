import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * applyStripeSubscriptionState — the single status applier + transition table.
 *
 * Stripe is the source of truth. This applier is the ONLY writer of
 * accounts.subscription_status for the trial lifecycle. The transition table is
 * monotonic; `cancelled` is terminal. Stale / out-of-order Stripe events are
 * no-ops (changed:false).
 *
 *   | Stripe status        | DB target | Allowed from                       | Ignored when                          |
 *   | trialing             | trialing  | pending_payment                    | already active/past_due/cancelled     |
 *   | active               | active    | pending_payment, trialing, past_due| cancelled                             |
 *   | past_due/unpaid/inc* | past_due  | active, trialing                   | cancelled                             |
 *   | canceled             | cancelled | any                                | (terminal)                            |
 */

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockWriteAccountAuditLog,
  mockEnqueueStripeOverageRecompute,
  mockEnqueueStripeSubscriptionMirrorSync,
  mockEnqueueTrialStarted,
  mockEnqueueTrialConverted,
  mockEnqueueTrialPaymentFailed,
  mockEnqueueTrialCancelled,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const mockSql: any = vi.fn((s: TemplateStringsArray, ...v: unknown[]) => {
    sqlCalls.push({ text: Array.from(s).join('?'), values: v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });
  mockSql.begin = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockSql));
  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockWriteAccountAuditLog: vi.fn().mockResolvedValue(undefined),
    mockEnqueueStripeOverageRecompute: vi.fn().mockResolvedValue(undefined),
    mockEnqueueStripeSubscriptionMirrorSync: vi.fn().mockResolvedValue('mirror-outbox-id'),
    mockEnqueueTrialStarted: vi.fn().mockResolvedValue(undefined),
    mockEnqueueTrialConverted: vi.fn().mockResolvedValue(undefined),
    mockEnqueueTrialPaymentFailed: vi.fn().mockResolvedValue(undefined),
    mockEnqueueTrialCancelled: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueStripeOverageRecompute: mockEnqueueStripeOverageRecompute,
  enqueueStripeSubscriptionMirrorSync: mockEnqueueStripeSubscriptionMirrorSync,
}));
vi.mock('../../../../src/lib/analytics/trial-events', () => ({
  enqueueTrialStarted: mockEnqueueTrialStarted,
  enqueueTrialConverted: mockEnqueueTrialConverted,
  enqueueTrialPaymentFailed: mockEnqueueTrialPaymentFailed,
  enqueueTrialCancelled: mockEnqueueTrialCancelled,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import {
  applyStripeSubscriptionState,
  lockAccountForStripeLineage,
  stripeStatusTarget,
  UNRESOLVED_TRANSITION,
} from '../apply-subscription-state';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const SIBLING_ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000002';
const PRIMARY_BIZ = '019dc366-29ce-7000-a000-0000000000bb';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';
const TRIAL_END_UNIX = Math.floor(new Date('2026-07-21T00:00:00.000Z').getTime() / 1000);

function trialingSub(overrides: Record<string, unknown> = {}): any {
  return { id: SUB_ID, customer: CUSTOMER_ID, status: 'trialing', trial_end: TRIAL_END_UNIX, ...overrides };
}
function activeSub(overrides: Record<string, unknown> = {}): any {
  return { id: SUB_ID, customer: CUSTOMER_ID, status: 'active', trial_end: null, ...overrides };
}

// Queue what the applier issues before any write: the customer binding lock
// (D8), then the account-row SELECT … FOR UPDATE with its primary business.
// The caller already holds the entitlement lock; the applier never takes it.
function queueAccountRow(currentStatus: string) {
  sqlReturnQueue.push([]); // acquireStripeCustomerBindingLock
  sqlReturnQueue.push([{
    id: ACCOUNT_ID,
    subscription_status: currentStatus,
    primary_business_id: PRIMARY_BIZ,
  }]);
}

/** Apply a Stripe subscription the way every caller does: normalize once, apply by account id. */
function apply(sub: { id: string; status: string; trial_end: number | null; customer?: unknown }) {
  return applyStripeSubscriptionState(mockSql, ACCOUNT_ID, stripeStatusTarget(sub as never, CUSTOMER_ID));
}

function findStatusUpdate(table: 'accounts' | 'businesses', status: string) {
  const updatePattern = new RegExp(`\\bUPDATE\\s+${table}\\b`);
  return sqlCalls.find(
    (call) => updatePattern.test(call.text) && call.values.includes(status),
  );
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockWriteAccountAuditLog.mockClear();
  mockEnqueueStripeOverageRecompute.mockClear();
  mockEnqueueStripeSubscriptionMirrorSync.mockClear();
  mockEnqueueTrialStarted.mockClear();
  mockEnqueueTrialConverted.mockClear();
  mockEnqueueTrialPaymentFailed.mockClear();
  mockEnqueueTrialCancelled.mockClear();
});

describe('transition: → trialing', () => {
  it('pending_payment → trialing sets status, trial_ends_at, subscription_activated_at, audit, overage, analytics', async () => {
    queueAccountRow('pending_payment');
    const r = await apply(trialingSub());

    expect(r).toMatchObject({
      fromStatus: 'pending_payment',
      toStatus: 'trialing',
      changed: true,
      activated: true,
      primaryBusinessId: PRIMARY_BIZ,
    });

    const updateAcct = findStatusUpdate('accounts', 'trialing');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/trial_ends_at\s*=/i);
    expect(updateAcct!.text).toMatch(/subscription_activated_at\s*=\s*COALESCE/i);

    expect(sqlCalls.some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        payload: { fromStatus: 'pending_payment', toStatus: 'trialing' },
      }),
    );
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
    expect(mockEnqueueTrialStarted).toHaveBeenCalledWith(mockSql, expect.objectContaining({ accountId: ACCOUNT_ID }));
    expect(mockEnqueueStripeSubscriptionMirrorSync).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });

  it('trial-start (checkout) persists stripe_customer_id + stripe_subscription_id so later webhooks/portal can resolve the account', async () => {
    // Regression: the trial-start path resolves the account by client_reference_id,
    // NOT by Stripe ids, so the applier must copy customer/subscription ids off the
    // retrieved subscription. Without this, subscription.updated/.deleted +
    // invoice.payment_failed (resolved by Stripe lineage) and the Billing Portal can never
    // find the trialing account.
    queueAccountRow('pending_payment');
    await apply(trialingSub());

    const updateAcct = findStatusUpdate('accounts', 'trialing');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/stripe_customer_id\s*=\s*COALESCE/i);
    expect(updateAcct!.text).toMatch(/stripe_subscription_id\s*=\s*COALESCE/i);
    // The customer id (from the subscription object) and subscription id are the
    // COALESCE fallback values, in declaration order.
    // (The target's customer id — checkout passes the retrieved subscription's.)
    expect(updateAcct!.values).toContain(CUSTOMER_ID);
    expect(updateAcct!.values).toContain(SUB_ID);
  });

  it('already active → trialing is a no-op (ignored)', async () => {
    queueAccountRow('active');
    const r = await apply(trialingSub());

    expect(r).toMatchObject({ fromStatus: 'active', toStatus: 'active', changed: false });
    expect(sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text))).toBe(false);
    expect(mockEnqueueTrialStarted).not.toHaveBeenCalled();
  });

  it('cancelled → trialing is a no-op (terminal)', async () => {
    queueAccountRow('cancelled');
    const r = await apply(trialingSub());
    expect(r).toMatchObject({ changed: false });
    expect(sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text))).toBe(false);
  });
});

describe('transition: → active (convert)', () => {
  it('trialing → active clears trial_ends_at, preserves subscription_activated_at via COALESCE, emits trial_converted + overage', async () => {
    queueAccountRow('trialing');
    const r = await apply(activeSub());

    expect(r).toMatchObject({ fromStatus: 'trialing', toStatus: 'active', changed: true, activated: true });
    const updateAcct = findStatusUpdate('accounts', 'active');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/trial_ends_at\s*=\s*NULL/i);
    expect(updateAcct!.text).toMatch(/subscription_activated_at\s*=\s*COALESCE/i);
    expect(mockEnqueueTrialConverted).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID }),
    );
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);

    expect(sqlCalls.some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockEnqueueStripeSubscriptionMirrorSync).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });

  it('pending_payment → active (pay-now, no trial) activates, no trial_converted event', async () => {
    queueAccountRow('pending_payment');
    const r = await apply(activeSub());
    expect(r).toMatchObject({ fromStatus: 'pending_payment', toStatus: 'active', changed: true, activated: true });
    expect(mockEnqueueTrialConverted).not.toHaveBeenCalled();
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });

  it('can defer the deprecated business mirror without weakening canonical status ownership', async () => {
    queueAccountRow('pending_payment');

    const result = await apply(activeSub());

    expect(result).toMatchObject({ changed: true, toStatus: 'active' });
    expect(sqlCalls.filter((call) => /UPDATE\s+accounts/.test(call.text))).toHaveLength(1);
    expect(sqlCalls.some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    // Binding lock, locked-row SELECT, status UPDATE. The lock is D8's writer
    // half and is always first inside the applier.
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[0]!.text).toMatch(/pg_advisory_xact_lock/);
    expect(sqlReturnQueue).toHaveLength(0);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledTimes(1);
    expect(mockEnqueueStripeSubscriptionMirrorSync).toHaveBeenCalledTimes(1);
  });

  it('already active → active is a no-op', async () => {
    queueAccountRow('active');
    const r = await apply(activeSub());
    expect(r).toMatchObject({ changed: false });
  });

  it('cancelled → active is a no-op (terminal)', async () => {
    queueAccountRow('cancelled');
    const r = await apply(activeSub());
    expect(r).toMatchObject({ changed: false });
  });

  it('active UPDATE clears past_due_at = NULL (PARITY-1: all exit columns cleared)', async () => {
    // past_due → active is the re-activation path; the past_due_at timestamp must
    // be cleared so the account is no longer in the grace window.
    queueAccountRow('past_due');
    await apply(activeSub());
    const updateAcct = findStatusUpdate('accounts', 'active');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
  });

  it('active UPDATE COALESCEs stripe_customer_id + stripe_subscription_id (PARITY-2)', async () => {
    // Even for a lineage-resolved caller the COALESCE is present so a row that somehow
    // lost the Stripe ids gets them re-anchored on the next transition.
    queueAccountRow('trialing');
    await apply(activeSub());
    const updateAcct = findStatusUpdate('accounts', 'active');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/stripe_customer_id\s*=\s*COALESCE/i);
    expect(updateAcct!.text).toMatch(/stripe_subscription_id\s*=\s*COALESCE/i);
  });
});

describe('transition: → past_due', () => {
  it('trialing → past_due (card fail at trial end) sets past_due_at, clears trial_ends_at, emits trial_payment_failed', async () => {
    queueAccountRow('trialing');
    const r = await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'past_due', trial_end: null });

    expect(r).toMatchObject({ fromStatus: 'trialing', toStatus: 'past_due', changed: true });
    const updateAcct = findStatusUpdate('accounts', 'past_due');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NOW\(\)/i);
    expect(updateAcct!.text).toMatch(/trial_ends_at\s*=\s*NULL/i);
    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID }),
    );
  });

  it('maps incomplete/unpaid Stripe statuses to past_due', async () => {
    queueAccountRow('trialing');
    const r = await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'unpaid', trial_end: null });
    expect(r).toMatchObject({ toStatus: 'past_due', changed: true });
  });

  it('past_due enqueues the deferred mirror without a synchronous business write', async () => {
    queueAccountRow('trialing');
    await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'past_due', trial_end: null });
    expect(sqlCalls.some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockEnqueueStripeSubscriptionMirrorSync).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });

  it('cancelled → past_due is a no-op (terminal)', async () => {
    queueAccountRow('cancelled');
    const r = await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'past_due', trial_end: null });
    expect(r).toMatchObject({ changed: false });
  });
});

describe('transition: → cancelled', () => {
  it('trialing → cancelled sets cancelled_at, clears trial_ends_at + past_due_at, emits trial_cancelled', async () => {
    queueAccountRow('trialing');
    const r = await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });

    expect(r).toMatchObject({ fromStatus: 'trialing', toStatus: 'cancelled', changed: true });
    const updateAcct = findStatusUpdate('accounts', 'cancelled');
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/cancelled_at\s*=\s*NOW\(\)/i);
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
    expect(updateAcct!.text).toMatch(/trial_ends_at\s*=\s*NULL/i);
    expect(mockEnqueueTrialCancelled).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID }),
    );
  });

  it('active → cancelled does NOT emit trial_cancelled (was not a trial)', async () => {
    queueAccountRow('active');
    const r = await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });
    expect(r).toMatchObject({ fromStatus: 'active', toStatus: 'cancelled', changed: true });
    expect(mockEnqueueTrialCancelled).not.toHaveBeenCalled();
  });

  it('already cancelled → cancelled is a no-op', async () => {
    queueAccountRow('cancelled');
    const r = await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });
    expect(r).toMatchObject({ changed: false });
  });

  it('cancelled enqueues the deferred mirror without a synchronous business write', async () => {
    queueAccountRow('active');
    await apply({ id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });
    expect(sqlCalls.some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockEnqueueStripeSubscriptionMirrorSync).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });
});

describe('normalized target', () => {
  it('maps the Stripe status once and carries the caller-chosen customer id, not the subscription object\'s', () => {
    expect(stripeStatusTarget(
      { id: SUB_ID, status: 'incomplete_expired', trial_end: null } as never,
      CUSTOMER_ID,
    )).toEqual({ status: 'past_due', customerId: CUSTOMER_ID, subscriptionId: SUB_ID, trialEnd: null });
    expect(stripeStatusTarget(
      { id: SUB_ID, status: 'trialing', trial_end: TRIAL_END_UNIX, customer: 'cus_other' } as never,
      null,
    )).toEqual({ status: 'trialing', customerId: null, subscriptionId: SUB_ID, trialEnd: TRIAL_END_UNIX });
  });

  it('an unmapped Stripe status is a no-op on a resolved account', async () => {
    queueAccountRow('active');
    const r = await apply({ id: SUB_ID, status: 'paused', trial_end: null });
    expect(r).toMatchObject({ accountResolved: true, changed: false, fromStatus: 'active', toStatus: 'active' });
    expect(sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text))).toBe(false);
  });

  it('a missing trial_end persists trial_ends_at = NULL', async () => {
    queueAccountRow('pending_payment');
    await apply({ id: SUB_ID, status: 'trialing', trial_end: null });
    const updateAcct = findStatusUpdate('accounts', 'trialing');
    expect(updateAcct!.values).toContain(null);
  });
});

describe('missing account', () => {
  it('returns the unresolved result and writes nothing when the account row is gone', async () => {
    sqlReturnQueue.push([]); // binding lock
    sqlReturnQueue.push([]); // account row lock finds nothing
    const r = await apply(activeSub());
    expect(r).toEqual(UNRESOLVED_TRANSITION);
    expect(sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text))).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});

// A lineage-scoped caller (invoice-paid, invoice-payment-failed,
// subscription-deleted, the reconcile poller) resolves the account WITHOUT a
// lock, then takes its entitlement lock. The lineage can move in between, so
// the caller rechecks it on the locked row before it may call the applier.
describe('lockAccountForStripeLineage', () => {
  const lineage = { customerId: CUSTOMER_ID, subscriptionId: SUB_ID };

  it('confirms a row still bound to the lineage', async () => {
    sqlReturnQueue.push([]); // binding lock
    sqlReturnQueue.push([{ stripe_customer_id: CUSTOMER_ID, stripe_subscription_id: SUB_ID }]);
    await expect(lockAccountForStripeLineage(mockSql, ACCOUNT_ID, lineage)).resolves.toBe(true);
  });

  it('rejects a missing row', async () => {
    sqlReturnQueue.push([]); // binding lock
    sqlReturnQueue.push([]);
    await expect(lockAccountForStripeLineage(mockSql, ACCOUNT_ID, lineage)).resolves.toBe(false);
  });

  it('never follows lineage from locked account A to account B after the unlocked lookup', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const raceSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Array.from(strings).join('?');
      calls.push({ text, values });
      if (/WHERE stripe_customer_id/i.test(text)) {
        // This is what an unsafe post-lock re-resolution would now find.
        return Promise.resolve([{ id: SIBLING_ACCOUNT_ID }]);
      }
      if (/FROM accounts/i.test(text) && /FOR UPDATE/i.test(text)) {
        // A owned the lineage at the unlocked lookup, but lost it before its
        // entitlement lock and row lock were acquired.
        return Promise.resolve([{
          stripe_customer_id: 'cus_reassigned',
          stripe_subscription_id: 'sub_reassigned',
        }]);
      }
      return Promise.resolve([]);
    });

    await expect(lockAccountForStripeLineage(raceSql, ACCOUNT_ID, lineage)).resolves.toBe(false);
    // The binding lock precedes the locked-row SELECT by id; nothing
    // re-resolves by lineage and nothing writes.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toMatch(/pg_advisory_xact_lock/);
    expect(calls[1]!.text).toMatch(/FROM accounts[\s\S]*WHERE id = [\s\S]*FOR UPDATE/i);
    expect(calls[1]!.values).toContain(ACCOUNT_ID);
    expect(calls[1]!.text).not.toMatch(/WHERE stripe_customer_id/i);
    expect(calls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(false);
  });

  it('rejects a row bound to the same customer but a different subscription', async () => {
    sqlReturnQueue.push([]); // binding lock
    sqlReturnQueue.push([{ stripe_customer_id: CUSTOMER_ID, stripe_subscription_id: 'sub_newer' }]);
    await expect(lockAccountForStripeLineage(mockSql, ACCOUNT_ID, lineage)).resolves.toBe(false);
  });
});

// ── D8: the customer-keyed binding lock ────────────────────────────────
//
// The writer half lives in applyStripeSubscriptionState itself — the one
// function every status writer calls — so no binding write can sit outside it.
// lockAccountForStripeLineage takes it too, before the row lock, so a
// lineage-scoped caller acquires entitlement → binding → account row.
//
// Lock ORDER is fixed and must not be inverted: account-scoped tier
// entitlement first (the caller's), customer-keyed binding second. The
// redaction stage takes ONLY the binding lock and requests no other, so it
// cannot join a cycle.
describe('stripe customer binding lock (D8)', () => {
  function lockKeys(): unknown[] {
    return sqlCalls
      .filter((call) => /pg_advisory_xact_lock/.test(call.text))
      .map((call) => call.values[0]);
  }

  function indexOfLock(suffix: string): number {
    return sqlCalls.findIndex(
      (call) =>
        /pg_advisory_xact_lock/.test(call.text) &&
        call.values.some((value) => typeof value === 'string' && value.endsWith(suffix)),
    );
  }

  it('the applier takes the customer binding lock before writing stripe_customer_id', async () => {
    queueAccountRow('pending_payment');

    await apply(activeSub());

    const lockIndex = indexOfLock(':stripe_customer_binding');
    const writeIndex = sqlCalls.findIndex(
      (call) =>
        /\bUPDATE\s+accounts\b/.test(call.text) &&
        /stripe_customer_id\s*=\s*COALESCE/.test(call.text),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(writeIndex);
    // The entitlement lock is the caller's precondition, never re-taken here.
    expect(lockKeys()).toEqual([`${CUSTOMER_ID}:stripe_customer_binding`]);
  });

  it('the applier takes no binding lock when the target carries no customer id', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active', primary_business_id: null }]);

    await applyStripeSubscriptionState(
      mockSql,
      ACCOUNT_ID,
      stripeStatusTarget({ id: SUB_ID, status: 'canceled', trial_end: null } as never, null),
    );

    expect(lockKeys()).toEqual([]);
  });

  it('lockAccountForStripeLineage takes the binding lock before the account row lock', async () => {
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ stripe_customer_id: CUSTOMER_ID, stripe_subscription_id: SUB_ID }]);

    await lockAccountForStripeLineage(mockSql, ACCOUNT_ID, { customerId: CUSTOMER_ID, subscriptionId: SUB_ID });

    expect(lockKeys()).toEqual([`${CUSTOMER_ID}:stripe_customer_binding`]);
    expect(indexOfLock(':stripe_customer_binding')).toBe(0);
    expect(sqlCalls[1]!.text).toMatch(/FOR UPDATE/);
  });
});
