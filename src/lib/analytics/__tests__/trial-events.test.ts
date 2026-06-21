// src/lib/analytics/__tests__/trial-events.test.ts
//
// Unit tests for the four durable, server-side trial lifecycle analytics
// helpers. They wrap enqueueAnalyticsEvent with deterministic, idempotent
// event keys so a replay (BullMQ retry / Stripe redelivery) is a no-op via
// ON CONFLICT (event_key) DO NOTHING.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnqueueAnalyticsEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: mockEnqueueAnalyticsEvent,
}));

import {
  enqueueTrialStarted,
  enqueueTrialConverted,
  enqueueTrialPaymentFailed,
  enqueueTrialCancelled,
} from '../trial-events';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const SUB_ID = 'sub_test_456';
const fakeDb = {} as never;

beforeEach(() => {
  mockEnqueueAnalyticsEvent.mockClear();
});

describe('enqueueTrialStarted', () => {
  it('enqueues trial_started keyed by accountId, passing the tx db', async () => {
    await enqueueTrialStarted(fakeDb, { accountId: ACCOUNT_ID });

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledTimes(1);
    const [input, db] = mockEnqueueAnalyticsEvent.mock.calls[0]!;
    expect(input).toMatchObject({
      eventName: 'trial_started',
      eventKey: 'trial_started:' + ACCOUNT_ID,
      distinctId: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
    });
    expect(db).toBe(fakeDb);
  });
});

describe('enqueueTrialConverted', () => {
  it('enqueues trial_converted keyed by accountId + subscriptionId', async () => {
    await enqueueTrialConverted(fakeDb, { accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID });

    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledTimes(1);
    const [input] = mockEnqueueAnalyticsEvent.mock.calls[0]!;
    expect(input).toMatchObject({
      eventName: 'trial_converted',
      eventKey: 'trial_converted:' + ACCOUNT_ID + ':' + SUB_ID,
      distinctId: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
    });
  });
});

describe('enqueueTrialPaymentFailed', () => {
  it('enqueues trial_payment_failed keyed by accountId + subscriptionId', async () => {
    await enqueueTrialPaymentFailed(fakeDb, { accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID });

    const [input] = mockEnqueueAnalyticsEvent.mock.calls[0]!;
    expect(input).toMatchObject({
      eventName: 'trial_payment_failed',
      eventKey: 'trial_payment_failed:' + ACCOUNT_ID + ':' + SUB_ID,
      accountId: ACCOUNT_ID,
    });
  });
});

describe('enqueueTrialCancelled', () => {
  it('enqueues trial_cancelled keyed by accountId + subscriptionId', async () => {
    await enqueueTrialCancelled(fakeDb, { accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID });

    const [input] = mockEnqueueAnalyticsEvent.mock.calls[0]!;
    expect(input).toMatchObject({
      eventName: 'trial_cancelled',
      eventKey: 'trial_cancelled:' + ACCOUNT_ID + ':' + SUB_ID,
      accountId: ACCOUNT_ID,
    });
  });
});
