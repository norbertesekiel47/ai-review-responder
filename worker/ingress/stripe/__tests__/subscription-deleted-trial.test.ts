import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * customer.subscription.deleted — ALL cancellations route through the applier.
 *
 * After B1.1, BOTH trial and non-trial cancellations go through
 * applyStripeSubscriptionState (subscription mode). The applier maps Stripe
 * `canceled` → CANCELLED, clears trial_ends_at/past_due_at, mirrors all
 * businesses (NOTE-A), writes the audit row, and emits trial_cancelled ONLY
 * when leaving a trialing state. No inline UPDATE accounts remains.
 */

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockApplyStripeSubscriptionState,
  mockCaptureMessage,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const mockSql: any = vi.fn((s: TemplateStringsArray, ...v: unknown[]) => {
    sqlCalls.push({ text: Array.from(s).join('?'), values: v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return Promise.resolve(Object.assign([], { count: 0 }));
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockApplyStripeSubscriptionState: vi.fn().mockResolvedValue({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    }),
    mockCaptureMessage: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionStateUnderEntitlementLock: mockApplyStripeSubscriptionState,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));
vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureException: vi.fn(),
}));

import { processSubscriptionDeleted } from '../subscription-deleted';
import {
  AccountNotProvisionedYetError,
  OUT_OF_ORDER_RETRY_WINDOW_SECONDS,
} from '../shared';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';

function deletedSub(): any {
  return { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled' };
}

function queueAccount(status: string) {
  sqlReturnQueue.push([{
    id: ACCOUNT_ID,
    subscription_status: status,
    stripe_subscription_id: SUB_ID,
    active_offboarding_subscription_id: null,
  }]);
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockApplyStripeSubscriptionState.mockClear();
  mockCaptureMessage.mockClear();
});

describe('subscription.deleted — cancel during trial', () => {
  it('trialing account → applier cancels (emits trial_cancelled)', async () => {
    queueAccount('trialing');
    await processSubscriptionDeleted(deletedSub());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, lockedAccountId, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(lockedAccountId).toBe(ACCOUNT_ID);
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'canceled' });
  });

  it('non-trial cancel (active → cancelled) routes through the applier, not inline SQL', async () => {
    sqlReturnQueue.push([{
      id: 'acct-1',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
      active_offboarding_subscription_id: null,
    }]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    });

    await processSubscriptionDeleted({ id: 'sub_1', customer: 'cus_1', status: 'canceled' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      { mode: 'subscription', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
      expect.objectContaining({ id: 'sub_1', status: 'canceled' }),
    );
    const inlineCancel = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
    expect(inlineCancel).toBeUndefined();
  });

  it('multi-account customer: cancels the account whose CURRENT subscription matches, not the first row', async () => {
    const A1 = '019dc366-29ce-7000-a000-00000000000a'; // first row — DIFFERENT subscription
    const A2 = '019dc366-29ce-7000-a000-00000000000b'; // the account ON the deleted subscription
    sqlReturnQueue.push([
      { id: A1, subscription_status: 'active', stripe_subscription_id: 'sub_other', active_offboarding_subscription_id: null },
      { id: A2, subscription_status: 'active', stripe_subscription_id: SUB_ID, active_offboarding_subscription_id: null },
    ]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    });

    await processSubscriptionDeleted(deletedSub());

    // The old `const [acctRow]` took A1 (mismatched) and skipped; the fix resolves A2.
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const lockCall = sqlCalls.find((c) => /pg_advisory_xact_lock/.test(c.text));
    expect(lockCall?.values).toContain(`${A2}:tier_entitlement`);
    expect(lockCall?.values).not.toContain(`${A1}:tier_entitlement`);
  });

  it('multi-account customer: no account on the deleted subscription → skip (no applier call)', async () => {
    sqlReturnQueue.push([
      { id: 'acct-x', subscription_status: 'active', stripe_subscription_id: 'sub_x', active_offboarding_subscription_id: null },
      { id: 'acct-y', subscription_status: 'active', stripe_subscription_id: 'sub_y', active_offboarding_subscription_id: null },
    ]);

    await processSubscriptionDeleted(deletedSub()); // deletes SUB_ID, owned by neither account

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });
});

// ── D4/D6/D7: the out-of-order retry bound, proven for THIS handler ─────
//
// Deliberately duplicated from the subscription-updated suite rather than
// shared. Plan round 1 finding 6: one shared boundary case could exercise a
// single handler while the other silently used the wrong comparison. The
// clock is frozen so the boundary under test is the stated one.
describe('processSubscriptionDeleted out-of-order retry bound', () => {
  const NOW_SECONDS = 1_800_000_000;

  function eventContext(ageSeconds: number) {
    return { id: 'evt_deleted_boundary', created: NOW_SECONDS - ageSeconds };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processSubscriptionDeleted throws AccountNotProvisionedYetError when the event is 60 seconds old and no account exists', async () => {
    sqlReturnQueue.push([]); // customer-scoped SELECT: no accounts

    await expect(
      processSubscriptionDeleted(deletedSub(), eventContext(60)),
    ).rejects.toBeInstanceOf(AccountNotProvisionedYetError);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('processSubscriptionDeleted logs and returns without throwing when the event is older than 15 minutes and no account exists', async () => {
    sqlReturnQueue.push([]);

    await expect(
      processSubscriptionDeleted(
        deletedSub(),
        eventContext(OUT_OF_ORDER_RETRY_WINDOW_SECONDS + 60),
      ),
    ).resolves.toBeUndefined();

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [, options] = mockCaptureMessage.mock.calls[0]!;
    expect(options).toMatchObject({ level: 'warning' });
  });

  it('processSubscriptionDeleted throws at an event age of exactly 900 seconds and acks at 901 under a frozen clock', async () => {
    expect(OUT_OF_ORDER_RETRY_WINDOW_SECONDS).toBe(900);

    sqlReturnQueue.push([]);
    await expect(
      processSubscriptionDeleted(deletedSub(), eventContext(900)),
    ).rejects.toBeInstanceOf(AccountNotProvisionedYetError);

    sqlReturnQueue.push([]);
    await expect(
      processSubscriptionDeleted(deletedSub(), eventContext(901)),
    ).resolves.toBeUndefined();
  });

  it('processSubscriptionDeleted throws rather than acking for a future event timestamp', async () => {
    sqlReturnQueue.push([]);

    await expect(
      processSubscriptionDeleted(deletedSub(), eventContext(-3600)),
    ).rejects.toBeInstanceOf(AccountNotProvisionedYetError);
  });
});
