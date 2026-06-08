import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AccountOffboardingTeardownPayload } from '../../../../src/lib/shared/worker-types';
import { ZernioPermanentError } from '../../../../src/lib/zernio/errors';

type OffboardingMode = 'cancel_only' | 'delete_data';
type OffboardingStatus =
  | 'pending'
  | 'scheduled'
  | 'tearing_down'
  | 'purge_scheduled'
  | 'churned'
  | 'failed';
type AccountSubscriptionStatus = 'pending_payment' | 'active' | 'past_due' | 'cancelled';
type StepOutcome = 'success' | 'failed' | 'not_applicable' | null;

interface QueryCall {
  text: string;
  values: unknown[];
}

interface MockOffboardingRow {
  id: string;
  account_id: string;
  mode: OffboardingMode;
  status: OffboardingStatus;
  terminal_at: Date | string | null;
  access_ends_at: Date | string | null;
  teardown_started_at: Date | string | null;
  teardown_completed_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: StepOutcome;
  zernio_accounts_step: StepOutcome;
  zernio_profiles_step: StepOutcome;
  location_archival_step: StepOutcome;
  job_terminalization_step: StepOutcome;
  failed_step: string | null;
  last_error: string | null;
}

interface MockAccountRow {
  id: string;
  subscription_status: AccountSubscriptionStatus;
  subscription_activated_at: Date | string | null;
  trial_ends_at: Date | string | null;
  past_due_at: Date | string | null;
}

const {
  sqlCalls,
  mockState,
  mockSql,
  mockStripeSubscriptionsCancel,
  mockStripeSubscriptionsRetrieve,
  mockCleanupSubscriptionInvoices,
  mockDeleteAccount,
  mockDeleteProfile,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockCaptureMessage,
  mockEnqueueOffboardingTeardownCompleted,
} = vi.hoisted(() => {
  const sqlCalls: QueryCall[] = [];
  const mockState = {
    offboarding: null as MockOffboardingRow | null,
    account: null as MockAccountRow | null,
    archivedLocations: new Set<string>(),
  };

  const cloneRow = () => (mockState.offboarding ? structuredClone(mockState.offboarding) : null);

  const updateCompletion = () => {
    const row = mockState.offboarding;
    if (!row) return [];
    const ready = (
      (row.stripe_subscription_id ? row.stripe_step === 'success' : row.stripe_step === 'success' || row.stripe_step === 'not_applicable')
      && ((row.zernio_account_ids?.length ?? 0) > 0 ? row.zernio_accounts_step === 'success' : row.zernio_accounts_step === 'success' || row.zernio_accounts_step === 'not_applicable')
      && ((row.zernio_profile_ids?.length ?? 0) > 0 ? row.zernio_profiles_step === 'success' : row.zernio_profiles_step === 'success' || row.zernio_profiles_step === 'not_applicable')
      && ((row.location_ids?.length ?? 0) > 0 ? row.location_archival_step === 'success' : row.location_archival_step === 'success' || row.location_archival_step === 'not_applicable')
      && row.job_terminalization_step === 'success'
    );
    if (!ready) return [];

    row.teardown_completed_at ??= new Date('2026-06-06T12:00:00.000Z');
    if (row.mode === 'delete_data') {
      if (row.purge_cancelled_at) {
        row.status = 'churned';
        row.terminal_at ??= new Date('2026-06-06T12:00:00.000Z');
      } else {
        row.status = 'purge_scheduled';
      }
    } else {
      row.status = 'churned';
      row.terminal_at ??= new Date('2026-06-06T12:00:00.000Z');
    }
    row.failed_step = null;
    row.last_error = null;
    return [{ id: row.id, status: row.status }];
  };

  // Model Postgres.js faithfully: a single-string call is identifier interpolation
  // (sql('col')) and is inlined into the query text; tagged-template values become '?'.
  const renderSqlText = (strings: readonly string[], values: unknown[]): string =>
    strings.reduce((acc, segment, i) => {
      if (i === 0) return segment;
      const value = values[i - 1] as { __id?: unknown } | undefined;
      const rendered = value && typeof value === 'object' && '__id' in value
        ? String(value.__id)
        : '?';
      return acc + rendered + segment;
    }, '');
  const runSqlQuery = async (strings: readonly string[], ...values: unknown[]) => {
    const text = renderSqlText(strings, values);
    sqlCalls.push({ text, values });

    if (text.includes('FROM account_offboardings') && text.includes('WHERE id =') && !text.includes('UPDATE')) {
      return cloneRow() ? [cloneRow()] : [];
    }

    if (text.includes("SET status = 'tearing_down'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.status = 'tearing_down';
      mockState.offboarding.teardown_started_at ??= new Date('2026-06-06T11:00:00.000Z');
      mockState.offboarding.failed_step = null;
      mockState.offboarding.last_error = null;
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET stripe_step = 'success'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.stripe_step = 'success';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET stripe_step = 'not_applicable'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.stripe_step = 'not_applicable';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET zernio_accounts_step = 'success'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.zernio_accounts_step = 'success';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET zernio_accounts_step = 'not_applicable'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.zernio_accounts_step = 'not_applicable';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET zernio_profiles_step = 'success'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.zernio_profiles_step = 'success';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET zernio_profiles_step = 'not_applicable'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.zernio_profiles_step = 'not_applicable';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes('FROM accounts') && text.includes('FOR UPDATE')) {
      return [mockState.account ?? accountRow()];
    }

    if (text.includes('SELECT COUNT(*) AS count') && text.includes('FROM businesses')) {
      return [{ count: mockState.archivedLocations.size > 0 ? 1 : 2 }];
    }

    if (text.includes('FROM businesses') && text.includes('FOR UPDATE')) {
      const locationId = values[0] as string;
      const archived = mockState.archivedLocations.has(locationId);
      return [{ archived_at: archived ? new Date('2026-06-01T00:00:00.000Z') : null }];
    }

    if (text.includes('UPDATE businesses') && text.includes('SET archived_at = NOW()')) {
      mockState.archivedLocations.add(values[0] as string);
      return [{ id: values[0] }];
    }

    if (text.includes('INSERT INTO account_audit_log')) {
      return [];
    }

    if (text.includes('INSERT INTO job_outbox') && text.includes('update_stripe_overage_quantity')) {
      return [];
    }

    if (text.includes("SET location_archival_step = 'success'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.location_archival_step = 'success';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET location_archival_step = 'not_applicable'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.location_archival_step = 'not_applicable';
      return [{ id: mockState.offboarding.id }];
    }

    if (
      text.includes('UPDATE job_outbox')
      && text.includes("status = 'completed'")
      && text.includes("topic IN ('generate_response', 'send_notification', 'publish_response')")
      && text.includes("'account_offboarding_billing_schedule'")
      && text.includes("'account_offboarding_reactivation'")
      && text.includes("'account_offboarding_teardown'")
    ) {
      if (!mockState.offboarding) return { count: 0 };
      mockState.offboarding.job_terminalization_step = 'success';
      return { count: 4 };
    }

    if (text.includes("SET job_terminalization_step = 'success'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.job_terminalization_step = 'success';
      return [{ id: mockState.offboarding.id }];
    }

    if (text.includes("SET teardown_completed_at = NOW()")) {
      return updateCompletion();
    }

    if (text.includes("SET status = 'failed'") && text.includes("failed_step = 'teardown'")) {
      if (!mockState.offboarding) return [];
      mockState.offboarding.status = 'failed';
      mockState.offboarding.failed_step = 'teardown';
      mockState.offboarding.last_error = String(values[0] ?? '');
      if (text.includes("stripe_step = 'failed'")) mockState.offboarding.stripe_step = 'failed';
      if (text.includes("zernio_accounts_step = 'failed'")) mockState.offboarding.zernio_accounts_step = 'failed';
      if (text.includes("zernio_profiles_step = 'failed'")) mockState.offboarding.zernio_profiles_step = 'failed';
      if (text.includes("location_archival_step = 'failed'")) mockState.offboarding.location_archival_step = 'failed';
      if (text.includes("job_terminalization_step = 'failed'")) mockState.offboarding.job_terminalization_step = 'failed';
      return [{ id: mockState.offboarding.id }];
    }

    return [];
  };
  const mockSql: any = vi.fn((strings: any, ...values: unknown[]) =>
    Array.isArray(strings) ? runSqlQuery(strings, ...values) : { __id: String(strings) },
  );

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

  return {
    sqlCalls,
    mockState,
    mockSql,
    mockStripeSubscriptionsCancel: vi.fn(),
    mockStripeSubscriptionsRetrieve: vi.fn(),
    mockCleanupSubscriptionInvoices: vi.fn(),
    mockDeleteAccount: vi.fn(),
    mockDeleteProfile: vi.fn(),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockEnqueueOffboardingTeardownCompleted: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
    outboxId: data.outbox_id ?? fallback,
    attempt: data.outbox_attempt,
  }),
}));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    subscriptions = {
      cancel: mockStripeSubscriptionsCancel,
      retrieve: mockStripeSubscriptionsRetrieve,
    };
  },
}));

vi.mock('../../../../src/lib/account-offboarding/stripe-invoices', () => ({
  cleanupSubscriptionInvoices: mockCleanupSubscriptionInvoices,
  StripeInvoiceCleanupError: class StripeInvoiceCleanupError extends Error {
    retryable: boolean;
    operation: string;
    code: string;
    constructor(input: { message: string; retryable: boolean; operation: string; code: string }) {
      super(input.message);
      this.name = 'StripeInvoiceCleanupError';
      this.retryable = input.retryable;
      this.operation = input.operation;
      this.code = input.code;
    }
  },
}));

vi.mock('../../../../src/lib/account-offboarding/analytics', () => ({
  enqueueOffboardingTeardownCompleted: mockEnqueueOffboardingTeardownCompleted,
}));

vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: {
    deleteAccount: mockDeleteAccount,
    deleteProfile: mockDeleteProfile,
  },
}));

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
}));

import { handleAccountOffboardingTeardown } from '../TeardownWorker';
import { runOutboxTerminalization } from '../teardown-outbox';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_LOCATION_ID = '44444444-4444-4444-8444-444444444444';

function makeJob(
  overrides: Partial<AccountOffboardingTeardownPayload> = {},
  jobOverrides: Partial<Job<AccountOffboardingTeardownPayload>> = {},
): Job<AccountOffboardingTeardownPayload> {
  return {
    id: 'outbox-teardown-1',
    data: {
      account_id: ACCOUNT_ID,
      account_offboarding_id: OFFBOARDING_ID,
      correlation_id: 'corr-teardown-1',
      outbox_id: 'outbox-teardown-1',
      outbox_attempt: 4,
      ...overrides,
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...jobOverrides,
  } as Job<AccountOffboardingTeardownPayload>;
}

function offboardingRow(overrides: Partial<MockOffboardingRow> = {}): MockOffboardingRow {
  return {
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    mode: 'delete_data',
    status: 'pending',
    terminal_at: null,
    access_ends_at: null,
    teardown_started_at: null,
    teardown_completed_at: null,
    purge_cancelled_at: null,
    stripe_subscription_id: 'sub_live_123',
    zernio_account_ids: ['zacct-1'],
    zernio_profile_ids: ['zprof-1'],
    location_ids: [LOCATION_ID, SECOND_LOCATION_ID],
    stripe_step: 'not_applicable',
    zernio_accounts_step: 'not_applicable',
    zernio_profiles_step: 'not_applicable',
    location_archival_step: 'not_applicable',
    job_terminalization_step: 'not_applicable',
    failed_step: null,
    last_error: null,
    ...overrides,
  };
}

function accountRow(overrides: Partial<MockAccountRow> = {}): MockAccountRow {
  return {
    id: ACCOUNT_ID,
    subscription_status: 'active',
    subscription_activated_at: new Date('2026-05-01T00:00:00.000Z'),
    trial_ends_at: null,
    past_due_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  mockState.archivedLocations.clear();
  mockState.offboarding = offboardingRow();
  mockState.account = accountRow();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  mockStripeSubscriptionsRetrieve.mockResolvedValue({ status: 'canceled' });
  mockEnqueueOffboardingTeardownCompleted.mockResolvedValue(undefined);
});

describe('AccountOffboarding TeardownWorker', () => {
  it('runs teardown work from a fresh default-step row when the snapshot still requires Stripe, Zernio, locations, and job terminalization', async () => {
    mockStripeSubscriptionsCancel.mockResolvedValueOnce({ id: 'sub_live_123' });
    mockCleanupSubscriptionInvoices.mockResolvedValueOnce({
      subscriptionId: 'sub_live_123',
      actions: [],
      summary: { inspected: 0, finalized: 0, voided: 0, retained: 0, skipped: 0 },
    });

    await handleAccountOffboardingTeardown(makeJob());

    expect(mockStripeSubscriptionsCancel).toHaveBeenCalledWith(
      'sub_live_123',
      { invoice_now: false, prorate: false },
      {
        idempotencyKey:
          'account-offboarding-teardown:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111:stripe',
      },
    );
    expect(mockCleanupSubscriptionInvoices).toHaveBeenCalledWith({
      stripe: expect.any(Object),
      subscriptionId: 'sub_live_123',
      operationScope: OFFBOARDING_ID,
    });
    expect(mockDeleteAccount).toHaveBeenCalledWith('zacct-1');
    expect(mockDeleteProfile).toHaveBeenCalledWith('zprof-1');

    const combinedSql = sqlCalls.map((call) => call.text).join('\n');
    expect(combinedSql).toContain("SET status = 'tearing_down'");
    expect(combinedSql).toContain("SET stripe_step = 'success'");
    expect(combinedSql).toContain("SET zernio_accounts_step = 'success'");
    expect(combinedSql).toContain("SET zernio_profiles_step = 'success'");
    expect(combinedSql).toContain("SET location_archival_step = 'success'");
    expect(combinedSql).toContain("SET job_terminalization_step = 'success'");
    expect(combinedSql).toContain("SET teardown_completed_at = NOW()");
    expect(combinedSql).toContain("stripe_subscription_id IS NOT NULL AND stripe_step = 'success'");
    expect(combinedSql).toContain("COALESCE(array_length(zernio_account_ids, 1), 0) > 0 AND zernio_accounts_step = 'success'");
    expect(combinedSql).toContain("COALESCE(array_length(zernio_profile_ids, 1), 0) > 0 AND zernio_profiles_step = 'success'");
    expect(combinedSql).toContain("COALESCE(array_length(location_ids, 1), 0) > 0 AND location_archival_step = 'success'");
    expect(combinedSql).toContain("job_terminalization_step = 'success'");
    expect(combinedSql).toContain("topic IN ('generate_response', 'send_notification', 'publish_response')");
    expect(combinedSql).toContain("'account_offboarding_billing_schedule'");
    expect(combinedSql).toContain("'account_offboarding_reactivation'");
    expect(combinedSql).toContain("'account_offboarding_teardown'");
    expect(combinedSql).not.toContain('stripe_checkout_session_reconcile');

    expect(mockState.archivedLocations.has(LOCATION_ID)).toBe(true);
    expect(mockState.archivedLocations.has(SECOND_LOCATION_ID)).toBe(true);
    expect(mockState.offboarding?.status).toBe('purge_scheduled');
    expect(mockState.offboarding?.teardown_completed_at).not.toBeNull();
    expect(mockEnqueueOffboardingTeardownCompleted).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'delete_data',
      status: 'purge_scheduled',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-teardown-1', 4);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('treats missing Stripe/Zernio/location snapshots as not_applicable and lands churned when keep-my-data already cancelled purge', async () => {
    mockState.offboarding = offboardingRow({
      stripe_subscription_id: null,
      zernio_account_ids: [],
      zernio_profile_ids: [],
      location_ids: [],
      purge_cancelled_at: new Date('2026-06-05T00:00:00.000Z'),
    });

    await handleAccountOffboardingTeardown(makeJob());

    expect(mockStripeSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockCleanupSubscriptionInvoices).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockDeleteProfile).not.toHaveBeenCalled();

    const combinedSql = sqlCalls.map((call) => call.text).join('\n');
    expect(combinedSql).not.toContain("SET stripe_step = 'success'");
    expect(combinedSql).not.toContain("SET zernio_accounts_step = 'success'");
    expect(combinedSql).not.toContain("SET zernio_profiles_step = 'success'");
    expect(combinedSql).not.toContain("SET location_archival_step = 'success'");
    expect(mockState.offboarding?.status).toBe('churned');
    expect(mockState.offboarding?.terminal_at).not.toBeNull();
    expect(mockEnqueueOffboardingTeardownCompleted).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'delete_data',
      status: 'churned',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-teardown-1', 4);
  });

  it('lands churned, not purge_scheduled, when keep-my-data cancels purge mid-teardown', async () => {
    // Snapshot is loaded with purge_cancelled_at = null (owner has not kept data yet).
    mockState.offboarding = offboardingRow({ purge_cancelled_at: null });
    mockStripeSubscriptionsCancel.mockResolvedValueOnce({ id: 'sub_live_123' });
    // A concurrent keep-my-data transaction commits purge_cancelled_at while teardown
    // is mid-flight — after the worker loaded the row, before it finalizes.
    mockCleanupSubscriptionInvoices.mockImplementationOnce(async () => {
      mockState.offboarding!.purge_cancelled_at = new Date('2026-06-06T11:30:00.000Z');
      return {
        subscriptionId: 'sub_live_123',
        actions: [],
        summary: { inspected: 0, finalized: 0, voided: 0, retained: 0, skipped: 0 },
      };
    });

    await handleAccountOffboardingTeardown(makeJob());

    // Completion must reflect the live cancellation: terminal churned, not purge_scheduled.
    // Otherwise the row strands non-terminal and the account can never offboard again.
    expect(mockEnqueueOffboardingTeardownCompleted).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'delete_data',
      status: 'churned',
    });
    expect(mockState.offboarding?.status).toBe('churned');
    expect(mockState.offboarding?.terminal_at).not.toBeNull();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-teardown-1', 4);
  });

  it.each([
    [
      'pending_payment',
      accountRow({
        subscription_status: 'pending_payment',
        subscription_activated_at: null,
      }),
    ],
    [
      'never-activated',
      accountRow({
        subscription_status: 'active',
        subscription_activated_at: null,
      }),
    ],
    [
      'trial',
      accountRow({
        subscription_status: 'active',
        trial_ends_at: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ],
    [
      'past_due',
      accountRow({
        subscription_status: 'past_due',
        past_due_at: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ],
  ])('completes %s delete-data teardown when billing/provider steps are absent', async (_label, account) => {
    mockState.account = account;
    mockState.offboarding = offboardingRow({
      mode: 'delete_data',
      status: 'pending',
      stripe_subscription_id: null,
      zernio_account_ids: [],
      zernio_profile_ids: [],
      location_ids: [LOCATION_ID],
      purge_cancelled_at: null,
    });

    await handleAccountOffboardingTeardown(makeJob());

    const accountLockCall = sqlCalls.find((call) => call.text.includes('FROM accounts') && call.text.includes('FOR UPDATE'));
    expect(accountLockCall).toBeDefined();
    expect(mockState.account).toEqual(account);
    expect(mockStripeSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockCleanupSubscriptionInvoices).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(mockState.offboarding?.stripe_step).toBe('not_applicable');
    expect(mockState.offboarding?.zernio_accounts_step).toBe('not_applicable');
    expect(mockState.offboarding?.zernio_profiles_step).toBe('not_applicable');
    expect(mockState.offboarding?.location_archival_step).toBe('success');
    expect(mockState.offboarding?.status).toBe('purge_scheduled');
    expect(mockState.offboarding?.teardown_completed_at).not.toBeNull();
    expect(mockEnqueueOffboardingTeardownCompleted).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'delete_data',
      status: 'purge_scheduled',
    });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-teardown-1', 4);
  });

  it('treats Zernio 404 and 410 deletes as idempotent success', async () => {
    mockState.offboarding = offboardingRow({
      stripe_subscription_id: null,
      location_ids: [],
      zernio_account_ids: ['zacct-404', 'zacct-410'],
      zernio_profile_ids: ['zprof-404', 'zprof-410'],
    });
    mockDeleteAccount
      .mockRejectedValueOnce(new ZernioPermanentError('http_404', {}))
      .mockRejectedValueOnce(new ZernioPermanentError('http_410', {}));
    mockDeleteProfile
      .mockRejectedValueOnce(new ZernioPermanentError('http_404', {}))
      .mockRejectedValueOnce(new ZernioPermanentError('http_410', {}));

    await handleAccountOffboardingTeardown(makeJob());

    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
    expect(mockDeleteProfile).toHaveBeenCalledTimes(2);
    expect(mockState.offboarding?.zernio_accounts_step).toBe('success');
    expect(mockState.offboarding?.zernio_profiles_step).toBe('success');
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-teardown-1', 4);
  });

  it('fails retryably instead of tearing down a cancel-only row before access end', async () => {
    mockState.offboarding = offboardingRow({
      mode: 'cancel_only',
      status: 'scheduled',
      access_ends_at: new Date('2026-07-01T00:00:00.000Z'),
      purge_cancelled_at: null,
    });

    await expect(handleAccountOffboardingTeardown(makeJob())).rejects.toThrow(
      'account_offboarding_access_end_not_reached',
    );

    expect(mockStripeSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockState.offboarding?.status).toBe('scheduled');
    expect(mockState.offboarding?.teardown_started_at).toBeNull();
    expect(mockState.offboarding?.teardown_completed_at).toBeNull();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingTeardownCompleted).not.toHaveBeenCalled();
    expect(sqlCalls.some((call) => call.text.includes("SET status = 'tearing_down'"))).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'account_offboarding_teardown_failed',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          terminal: 'false',
        }),
      }),
    );
  });

  it('retries cancel-only teardown until Stripe shows natural cancellation, without starting teardown early', async () => {
    mockState.offboarding = offboardingRow({
      mode: 'cancel_only',
      status: 'scheduled',
      access_ends_at: new Date('2026-06-01T00:00:00.000Z'),
    });
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({ status: 'active' });

    await expect(handleAccountOffboardingTeardown(makeJob())).rejects.toThrow(
      'account_offboarding_natural_cancellation_not_observed',
    );

    expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledWith('sub_live_123');
    expect(mockStripeSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockCleanupSubscriptionInvoices).not.toHaveBeenCalled();
    expect(mockState.offboarding?.status).toBe('scheduled');
    expect(mockState.offboarding?.teardown_started_at).toBeNull();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingTeardownCompleted).not.toHaveBeenCalled();
    expect(sqlCalls.some((call) => call.text.includes("SET status = 'tearing_down'"))).toBe(false);
  });

  it('verifies natural cancellation for cancel-only access-end teardown before invoice cleanup', async () => {
    mockState.offboarding = offboardingRow({
      mode: 'cancel_only',
      status: 'scheduled',
      access_ends_at: new Date('2026-06-01T00:00:00.000Z'),
    });
    mockCleanupSubscriptionInvoices.mockResolvedValueOnce({
      subscriptionId: 'sub_live_123',
      actions: [],
      summary: { inspected: 0, finalized: 0, voided: 0, retained: 0, skipped: 0 },
    });

    await handleAccountOffboardingTeardown(makeJob());

    expect(mockStripeSubscriptionsRetrieve).toHaveBeenCalledWith('sub_live_123');
    expect(mockStripeSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockCleanupSubscriptionInvoices).toHaveBeenCalledWith({
      stripe: expect.any(Object),
      subscriptionId: 'sub_live_123',
      operationScope: OFFBOARDING_ID,
    });
    expect(mockState.offboarding?.status).toBe('churned');
    expect(mockState.offboarding?.terminal_at).not.toBeNull();
    expect(mockEnqueueOffboardingTeardownCompleted).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'cancel_only',
      status: 'churned',
    });

    // H1a: cancel_only landing churned enqueues the access-end email in the
    // same finalize transaction.
    const emailEnqueue = sqlCalls.find(
      (call) => call.text.includes('INSERT INTO job_outbox')
        && call.values.includes('account_offboarding_email'),
    );
    expect(emailEnqueue).toBeDefined();
    expect(
      emailEnqueue!.values.some(
        (v) => v !== null && typeof v === 'object'
          && (v as { email_type?: string }).email_type === 'cancel_only_access_end',
      ),
    ).toBe(true);
  });

  it('does not downgrade a finalized delete-data teardown when markOutboxCompleted fails afterward', async () => {
    mockStripeSubscriptionsCancel.mockResolvedValueOnce({ id: 'sub_live_123' });
    mockCleanupSubscriptionInvoices.mockResolvedValueOnce({
      subscriptionId: 'sub_live_123',
      actions: [],
      summary: { inspected: 0, finalized: 0, voided: 0, retained: 0, skipped: 0 },
    });
    mockMarkOutboxCompleted.mockRejectedValueOnce(new Error('outbox completion lost connection'));

    await expect(
      handleAccountOffboardingTeardown(
        makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } } as Partial<Job<AccountOffboardingTeardownPayload>>),
      ),
    ).rejects.toThrow('outbox completion lost connection');

    expect(mockState.offboarding?.status).toBe('purge_scheduled');
    expect(mockState.offboarding?.failed_step).toBeNull();
    expect(mockState.offboarding?.teardown_completed_at).not.toBeNull();
    expect(mockEnqueueOffboardingTeardownCompleted).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      mode: 'delete_data',
      status: 'purge_scheduled',
    });
    expect(sqlCalls.some((call) => call.text.includes("failed_step = 'teardown'"))).toBe(false);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('rethrows a scrubbed error for non-terminal provider failures', async () => {
    mockStripeSubscriptionsCancel.mockRejectedValueOnce(
      new Error('access_token=tok1 refresh_token=tok2 client_secret=sec3 token=tok4 password=hunter2'),
    );

    await expect(handleAccountOffboardingTeardown(makeJob())).rejects.toThrow(
      'access_token=[REDACTED] refresh_token=[REDACTED] client_secret=[REDACTED] token=[REDACTED] password=[REDACTED]',
    );

    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingTeardownCompleted).not.toHaveBeenCalled();
    expect(sqlCalls.some((call) => call.text.includes("failed_step = 'teardown'"))).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'account_offboarding_teardown_failed',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({
          error: 'access_token=[REDACTED] refresh_token=[REDACTED] client_secret=[REDACTED] token=[REDACTED] password=[REDACTED]',
        }),
      }),
    );
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain('tok1');
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain('tok2');
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain('sec3');
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain('hunter2');
  });

  it('terminalizes only offboarding-sensitive pending outbox rows for snapshot locations and same offboarding id', async () => {
    const row = offboardingRow({
      location_ids: [LOCATION_ID, SECOND_LOCATION_ID],
      job_terminalization_step: 'not_applicable',
    });

    await runOutboxTerminalization(row, 'outbox-teardown-1');

    const updateCall = sqlCalls.find((call) => call.text.includes('UPDATE job_outbox'));
    expect(updateCall?.text).toContain("topic IN ('generate_response', 'send_notification', 'publish_response')");
    expect(updateCall?.text).toContain("payload->>'business_id' = ANY(?::text[])");
    expect(updateCall?.text).toContain("'account_offboarding_billing_schedule'");
    expect(updateCall?.text).toContain("'account_offboarding_reactivation'");
    expect(updateCall?.text).toContain("'account_offboarding_teardown'");
    expect(updateCall?.text).toContain("aggregate_id = ?");
    expect(updateCall?.text).toContain("id <> ?");
    expect(updateCall?.text).not.toContain('stripe_checkout_session_reconcile');
    expect(updateCall?.values).toContainEqual([LOCATION_ID, SECOND_LOCATION_ID]);
    expect(updateCall?.values).toContain(OFFBOARDING_ID);
    expect(updateCall?.values).toContain('outbox-teardown-1');
  });

  it('completes the originating outbox immediately for already-completed terminal rows', async () => {
    mockState.offboarding = offboardingRow({
      status: 'churned',
      terminal_at: new Date('2026-06-06T12:00:00.000Z'),
      teardown_completed_at: new Date('2026-06-06T11:59:00.000Z'),
      stripe_step: 'success',
      zernio_accounts_step: 'success',
      zernio_profiles_step: 'success',
      location_archival_step: 'success',
      job_terminalization_step: 'success',
    });

    await handleAccountOffboardingTeardown(makeJob());

    expect(mockStripeSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-teardown-1', 4);
    expect(mockEnqueueOffboardingTeardownCompleted).not.toHaveBeenCalled();
    expect(sqlCalls.some((call) => call.text.includes("SET status = 'tearing_down'"))).toBe(false);
  });

  it('marks the offboarding failed with a scrubbed error on exhausted teardown failure', async () => {
    mockStripeSubscriptionsCancel.mockRejectedValueOnce(
      new Error('Stripe auth failed token=sk_live_secret password=hunter2'),
    );

    await handleAccountOffboardingTeardown(
      makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } } as Partial<Job<AccountOffboardingTeardownPayload>>),
    );

    const failureCall = sqlCalls.find((call) => call.text.includes("failed_step = 'teardown'"));
    expect(failureCall?.text).toContain("status = 'failed'");
    expect(failureCall?.text).toContain("stripe_step = 'failed'");
    expect(failureCall?.values.join(' ')).toContain('token=[REDACTED]');
    expect(failureCall?.values.join(' ')).toContain('password=[REDACTED]');
    expect(failureCall?.values.join(' ')).not.toContain('sk_live_secret');
    expect(failureCall?.values.join(' ')).not.toContain('hunter2');
    expect(mockState.offboarding?.status).toBe('failed');
    expect(mockEnqueueOffboardingTeardownCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-teardown-1',
      expect.stringContaining('token=[REDACTED]'),
      4,
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'account_offboarding_teardown_failed',
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          terminal: 'true',
        }),
      }),
    );
  });
});
