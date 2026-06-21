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
  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockWriteAccountAuditLog: vi.fn().mockResolvedValue(undefined),
    mockEnqueueStripeOverageRecompute: vi.fn().mockResolvedValue(undefined),
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
}));
vi.mock('../../../../src/lib/analytics/trial-events', () => ({
  enqueueTrialStarted: mockEnqueueTrialStarted,
  enqueueTrialConverted: mockEnqueueTrialConverted,
  enqueueTrialPaymentFailed: mockEnqueueTrialPaymentFailed,
  enqueueTrialCancelled: mockEnqueueTrialCancelled,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { applyStripeSubscriptionState } from '../apply-subscription-state';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
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

// Queue the account-row SELECT (FOR UPDATE) + primary business lookup the applier does.
function queueAccountRow(currentStatus: string) {
  sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: currentStatus, primary_business_id: PRIMARY_BIZ }]);
}

const checkoutRef = { mode: 'checkout', accountId: ACCOUNT_ID } as const;
const subRef = { mode: 'subscription', stripeCustomerId: CUSTOMER_ID, stripeSubscriptionId: SUB_ID } as const;

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockWriteAccountAuditLog.mockClear();
  mockEnqueueStripeOverageRecompute.mockClear();
  mockEnqueueTrialStarted.mockClear();
  mockEnqueueTrialConverted.mockClear();
  mockEnqueueTrialPaymentFailed.mockClear();
  mockEnqueueTrialCancelled.mockClear();
});

describe('transition: → trialing', () => {
  it('pending_payment → trialing sets status, trial_ends_at, subscription_activated_at, audit, overage, analytics', async () => {
    queueAccountRow('pending_payment');
    const r = await applyStripeSubscriptionState(mockSql, checkoutRef, trialingSub());

    expect(r).toMatchObject({
      fromStatus: 'pending_payment',
      toStatus: 'trialing',
      changed: true,
      activated: true,
      primaryBusinessId: PRIMARY_BIZ,
    });

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'trialing'"),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/trial_ends_at\s*=/i);
    expect(updateAcct!.text).toMatch(/subscription_activated_at\s*=\s*COALESCE/i);

    // businesses mirror writes trialing too
    const updateBiz = sqlCalls.find(
      (c) => /\bUPDATE\s+businesses\b/.test(c.text) && c.text.includes("'trialing'"),
    );
    expect(updateBiz).toBeDefined();

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        payload: { fromStatus: 'pending_payment', toStatus: 'trialing' },
      }),
      mockSql,
    );
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
    expect(mockEnqueueTrialStarted).toHaveBeenCalledWith(mockSql, expect.objectContaining({ accountId: ACCOUNT_ID }));
  });

  it('already active → trialing is a no-op (ignored)', async () => {
    queueAccountRow('active');
    const r = await applyStripeSubscriptionState(mockSql, subRef, trialingSub());

    expect(r).toMatchObject({ fromStatus: 'active', toStatus: 'active', changed: false });
    expect(sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text))).toBe(false);
    expect(mockEnqueueTrialStarted).not.toHaveBeenCalled();
  });

  it('cancelled → trialing is a no-op (terminal)', async () => {
    queueAccountRow('cancelled');
    const r = await applyStripeSubscriptionState(mockSql, subRef, trialingSub());
    expect(r).toMatchObject({ changed: false });
    expect(sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text))).toBe(false);
  });
});

describe('transition: → active (convert)', () => {
  it('trialing → active clears trial_ends_at, preserves subscription_activated_at via COALESCE, emits trial_converted + overage', async () => {
    queueAccountRow('trialing');
    const r = await applyStripeSubscriptionState(mockSql, subRef, activeSub());

    expect(r).toMatchObject({ fromStatus: 'trialing', toStatus: 'active', changed: true, activated: true });
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/trial_ends_at\s*=\s*NULL/i);
    expect(updateAcct!.text).toMatch(/subscription_activated_at\s*=\s*COALESCE/i);
    expect(mockEnqueueTrialConverted).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID }),
    );
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });

  it('pending_payment → active (pay-now, no trial) activates, no trial_converted event', async () => {
    queueAccountRow('pending_payment');
    const r = await applyStripeSubscriptionState(mockSql, checkoutRef, activeSub());
    expect(r).toMatchObject({ fromStatus: 'pending_payment', toStatus: 'active', changed: true, activated: true });
    expect(mockEnqueueTrialConverted).not.toHaveBeenCalled();
    expect(mockEnqueueStripeOverageRecompute).toHaveBeenCalledWith(mockSql, ACCOUNT_ID);
  });

  it('already active → active is a no-op', async () => {
    queueAccountRow('active');
    const r = await applyStripeSubscriptionState(mockSql, subRef, activeSub());
    expect(r).toMatchObject({ changed: false });
  });

  it('cancelled → active is a no-op (terminal)', async () => {
    queueAccountRow('cancelled');
    const r = await applyStripeSubscriptionState(mockSql, subRef, activeSub());
    expect(r).toMatchObject({ changed: false });
  });
});

describe('transition: → past_due', () => {
  it('trialing → past_due (card fail at trial end) sets past_due_at, clears trial_ends_at, emits trial_payment_failed', async () => {
    queueAccountRow('trialing');
    const r = await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'past_due', trial_end: null });

    expect(r).toMatchObject({ fromStatus: 'trialing', toStatus: 'past_due', changed: true });
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'past_due'"),
    );
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
    const r = await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'unpaid', trial_end: null });
    expect(r).toMatchObject({ toStatus: 'past_due', changed: true });
  });

  it('cancelled → past_due is a no-op (terminal)', async () => {
    queueAccountRow('cancelled');
    const r = await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'past_due', trial_end: null });
    expect(r).toMatchObject({ changed: false });
  });
});

describe('transition: → cancelled', () => {
  it('trialing → cancelled sets cancelled_at, clears trial_ends_at + past_due_at, emits trial_cancelled', async () => {
    queueAccountRow('trialing');
    const r = await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });

    expect(r).toMatchObject({ fromStatus: 'trialing', toStatus: 'cancelled', changed: true });
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
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
    const r = await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });
    expect(r).toMatchObject({ fromStatus: 'active', toStatus: 'cancelled', changed: true });
    expect(mockEnqueueTrialCancelled).not.toHaveBeenCalled();
  });

  it('already cancelled → cancelled is a no-op', async () => {
    queueAccountRow('cancelled');
    const r = await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled', trial_end: null });
    expect(r).toMatchObject({ changed: false });
  });
});

describe('ref resolution + missing account', () => {
  it('returns changed:false when no account resolves', async () => {
    sqlReturnQueue.push([]); // account lookup returns nothing
    const r = await applyStripeSubscriptionState(mockSql, subRef, activeSub());
    expect(r).toMatchObject({ changed: false, accountResolved: false });
  });
});
