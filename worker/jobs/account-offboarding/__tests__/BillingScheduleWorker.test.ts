import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AccountOffboardingBillingSchedulePayload } from '../../../../src/lib/shared/worker-types';

const {
  sqlCalls,
  sqlReturnQueue,
  mockSql,
  mockStripeSubscriptionsUpdate,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockCaptureMessage,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(sqlReturnQueue.shift() ?? []);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  mockSql.json = vi.fn((value: unknown) => value);

  return {
    sqlCalls,
    sqlReturnQueue,
    mockSql,
    mockStripeSubscriptionsUpdate: vi.fn(),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockCaptureMessage: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
}));

vi.mock('../../../../src/lib/shared/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/shared/outbox')>();
  return {
    ...actual,
    markOutboxCompleted: mockMarkOutboxCompleted,
    markOutboxFailed: mockMarkOutboxFailed,
    extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
      outboxId: data.outbox_id ?? fallback,
      attempt: data.outbox_attempt,
    }),
  };
});

vi.mock('stripe', () => ({
  default: class FakeStripe {
    subscriptions = {
      update: mockStripeSubscriptionsUpdate,
    };
  },
}));

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
}));

import { handleAccountOffboardingBillingSchedule } from '../BillingScheduleWorker';
import { QUEUE_NAMES } from '../../../../src/lib/shared/queue-names';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';

function makeJob(
  overrides: Partial<AccountOffboardingBillingSchedulePayload> = {},
  jobOverrides: Partial<Job<AccountOffboardingBillingSchedulePayload>> = {},
): Job<AccountOffboardingBillingSchedulePayload> {
  return {
    id: 'outbox-billing-1',
    data: {
      account_id: ACCOUNT_ID,
      account_offboarding_id: OFFBOARDING_ID,
      idempotency_key_hash: 'idem-hash-1',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-billing-1',
      outbox_attempt: 2,
      ...overrides,
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...jobOverrides,
  } as Job<AccountOffboardingBillingSchedulePayload>;
}

function offboardingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    mode: 'cancel_only',
    status: 'pending',
    terminal_at: null,
    access_ends_at: null,
    stripe_subscription_id: 'sub_cancel_123',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  sqlReturnQueue.length = 0;
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
});

describe('AccountOffboarding BillingScheduleWorker', () => {
  it('schedules Stripe cancellation with a deterministic idempotency key and persists Stripe period end', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: OFFBOARDING_ID }]);
    mockStripeSubscriptionsUpdate.mockResolvedValueOnce({ current_period_end: 1_798_761_600 });

    await handleAccountOffboardingBillingSchedule(mockSql, makeJob());

    expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith(
      'sub_cancel_123',
      { cancel_at_period_end: true },
      {
        idempotencyKey:
          'account-offboarding-billing-schedule:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111:idem-hash-1',
      },
    );

    const updateCall = sqlCalls.find((call) => call.text.includes('billing_cancel_confirmed_at'));
    expect(updateCall?.text).toContain("status = 'scheduled'");
    expect(updateCall?.text).toContain("stripe_step = 'success'");
    expect(updateCall?.values).toContainEqual(new Date('2027-01-01T00:00:00.000Z'));

    const emailOutboxCall = sqlCalls.find((call) => call.text.includes('INSERT INTO job_outbox'));
    expect(emailOutboxCall?.values).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL);
    expect(emailOutboxCall?.values).toContain(OFFBOARDING_ID);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-billing-1', 2);
  });

  it('reads current_period_end from the subscription item (Stripe Basil/Dahlia API shape)', async () => {
    // The pinned Stripe SDK apiVersion (2026-05-27.dahlia) returns
    // current_period_end ONLY on the subscription item — top-level is undefined.
    // Regression for staging dry-run defect D1: the worker read the absent
    // top-level field and threw, stranding cancel_only at failed/billing.
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: OFFBOARDING_ID }]);
    mockStripeSubscriptionsUpdate.mockResolvedValueOnce({
      items: { data: [{ current_period_end: 1_798_761_600 }] },
    });

    await handleAccountOffboardingBillingSchedule(mockSql, makeJob());

    const updateCall = sqlCalls.find((call) => call.text.includes('billing_cancel_confirmed_at'));
    expect(updateCall?.text).toContain("status = 'scheduled'");
    expect(updateCall?.values).toContainEqual(new Date('2027-01-01T00:00:00.000Z'));
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-billing-1', 2);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('retries without guessing when Stripe omits current_period_end', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    mockStripeSubscriptionsUpdate.mockResolvedValueOnce({});

    await expect(handleAccountOffboardingBillingSchedule(mockSql, makeJob())).rejects.toThrow(
      'Stripe subscription update did not return a valid current_period_end',
    );

    expect(sqlCalls.some((call) => call.text.includes("status = 'scheduled'"))).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'account_offboarding_billing_schedule_failed',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          subsystem: 'account_offboarding',
          step: 'billing',
          terminal: 'false',
        }),
      }),
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('marks the offboarding failed only on exhausted billing failure with a scrubbed last_error', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    sqlReturnQueue.push([{ id: OFFBOARDING_ID }]);
    mockStripeSubscriptionsUpdate.mockRejectedValueOnce(
      new Error('Stripe auth failed token=sk_live_secret password=hunter2'),
    );

    await handleAccountOffboardingBillingSchedule(mockSql,
      makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } } as Partial<Job<AccountOffboardingBillingSchedulePayload>>),
    );

    const failedUpdate = sqlCalls.find((call) => call.text.includes("failed_step = 'billing'"));
    expect(failedUpdate?.text).toContain("status = 'failed'");
    expect(failedUpdate?.text).toContain("stripe_step = 'failed'");
    expect(failedUpdate?.values.join(' ')).toContain('token=[REDACTED]');
    expect(failedUpdate?.values.join(' ')).toContain('password=[REDACTED]');
    expect(failedUpdate?.values.join(' ')).not.toContain('sk_live_secret');
    expect(failedUpdate?.values.join(' ')).not.toContain('hunter2');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-billing-1',
      expect.stringContaining('token=[REDACTED]'),
      2,
    );
  });

  it('keeps the offboarding pending while non-terminal Stripe failures retry', async () => {
    sqlReturnQueue.push([offboardingRow()]);
    mockStripeSubscriptionsUpdate.mockRejectedValueOnce(new Error('Stripe temporarily unavailable'));

    await expect(
      handleAccountOffboardingBillingSchedule(mockSql,
        makeJob({}, { attemptsMade: 1, opts: { attempts: 3 } } as Partial<Job<AccountOffboardingBillingSchedulePayload>>),
      ),
    ).rejects.toThrow('Stripe temporarily unavailable');

    expect(sqlCalls.some((call) => call.text.includes("failed_step = 'billing'"))).toBe(false);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('keeps the offboarding pending while non-terminal billing validation errors retry', async () => {
    sqlReturnQueue.push([offboardingRow({ stripe_subscription_id: null })]);

    await expect(handleAccountOffboardingBillingSchedule(mockSql, makeJob())).rejects.toThrow(
      'account_offboarding_missing_stripe_subscription_id',
    );

    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(sqlCalls.some((call) => call.text.includes("failed_step = 'billing'"))).toBe(false);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'account_offboarding_billing_schedule_failed',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          terminal: 'false',
        }),
      }),
    );
  });

  it('marks the offboarding failed on exhausted billing validation errors', async () => {
    sqlReturnQueue.push([offboardingRow({ stripe_subscription_id: null })]);

    await handleAccountOffboardingBillingSchedule(mockSql,
      makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } } as Partial<Job<AccountOffboardingBillingSchedulePayload>>),
    );

    expect(mockStripeSubscriptionsUpdate).not.toHaveBeenCalled();
    const failedUpdate = sqlCalls.find((call) => call.text.includes("failed_step = 'billing'"));
    expect(failedUpdate?.text).toContain("status = 'failed'");
    expect(failedUpdate?.text).toContain("stripe_step = 'failed'");
    expect(failedUpdate?.values).toContain('account_offboarding_missing_stripe_subscription_id');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-billing-1',
      'account_offboarding_missing_stripe_subscription_id',
      2,
    );
  });
});
