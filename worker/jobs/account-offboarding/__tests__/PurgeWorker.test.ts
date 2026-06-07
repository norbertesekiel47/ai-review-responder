import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { AccountOffboardingPurgePayload } from '../../../../src/lib/shared/worker-types';

interface QueryCall {
  text: string;
  values: unknown[];
  scope: 'sql' | 'tx';
}

interface MockOffboardingRow {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'purge_scheduled' | 'purged' | 'failed';
  terminal_at: Date | null;
  teardown_completed_at: Date | null;
  purge_started_at: Date | null;
  purge_cancelled_at: Date | null;
  auth_user_id: string | null;
  provider_dispositions: unknown[];
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
}

const ACCOUNT_ID = '00000000-0000-7000-8000-000000000001';
const OFFBOARDING_ID = '00000000-0000-7000-8000-000000000002';
const OUTBOX_ID = '00000000-0000-7000-8000-000000000003';
const AUTH_USER_ID = 'auth-user-1';

const {
  calls,
  mockState,
  mockSql,
  mockDeleteUser,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockVerifyAccountOffboardingPurge,
  mockCaptureMessage,
} = vi.hoisted(() => {
  const calls: QueryCall[] = [];
  const mockState = {
    offboarding: null as MockOffboardingRow | null,
    authRevalidationPasses: true,
    authAlreadyDetached: false,
  };

  const execute = async (
    scope: QueryCall['scope'],
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('?');
    calls.push({ text, values, scope });

    if (text.includes('FROM account_offboardings') && text.includes('WHERE id =')) {
      return mockState.offboarding ? [structuredClone(mockState.offboarding)] : [];
    }

    if (text.includes('FROM users u') && text.includes('u.auth_id =')) {
      return mockState.authRevalidationPasses
        ? [{ can_delete: true, already_detached: false }]
        : [{ can_delete: false, already_detached: mockState.authAlreadyDetached }];
    }

    if (text.includes('account_handles AS') && text.includes('sms_sender_opt_out_events')) {
      return [{ messaging_service_sid: 'MG123', handle: '+15555550123' }];
    }

    if (text.includes('SELECT id') && text.includes('FROM job_outbox') && text.includes('offboarding_scope AS')) {
      return [{ id: '00000000-0000-7000-8000-000000000004' }];
    }

    if (text.includes('UPDATE job_outbox') && text.includes("status IN ('pending', 'dispatching', 'dispatched')")) {
      return [{ id: '00000000-0000-7000-8000-000000000004' }];
    }

    if (text.includes('UPDATE account_offboardings') && text.includes('auth_user_id = NULL')) {
      if (mockState.offboarding) mockState.offboarding.auth_user_id = null;
      return [{ id: OFFBOARDING_ID }];
    }

    if (text.includes('FROM job_outbox') && text.includes('FOR UPDATE')) {
      return [{ id: OUTBOX_ID }];
    }

    if (text.includes('UPDATE job_outbox') && text.includes("status = 'completed'")) {
      return [{ id: OUTBOX_ID }];
    }

    if (text.includes("SET status = 'purged'")) {
      if (mockState.offboarding) {
        mockState.offboarding.status = 'purged';
        mockState.offboarding.terminal_at = new Date('2026-06-07T12:00:00.000Z');
      }
      return [{ id: OFFBOARDING_ID }];
    }

    if (text.includes("SET status = 'failed'") && text.includes("failed_step = 'purge'")) {
      if (mockState.offboarding) mockState.offboarding.status = 'failed';
      return [{ id: OFFBOARDING_ID }];
    }

    return [];
  };

  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    execute('sql', strings, ...values)
  );
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
    const tx: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      execute('tx', strings, ...values)
    );
    return cb(tx);
  });
  mockSql.json = vi.fn((value: unknown) => value);

  return {
    calls,
    mockState,
    mockSql,
    mockDeleteUser: vi.fn(async () => ({ data: {}, error: null })),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockVerifyAccountOffboardingPurge: vi.fn(async () => ({ ok: true, issues: [] })),
    mockCaptureMessage: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
  supabaseServer: {
    auth: {
      admin: {
        deleteUser: mockDeleteUser,
      },
    },
  },
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (data: { outbox_id?: string; outbox_attempt?: number }, fallback: string) => ({
    outboxId: data.outbox_id ?? fallback,
    attempt: data.outbox_attempt,
  }),
}));

vi.mock('../../../../src/lib/account-offboarding/purge-verification', () => ({
  verifyAccountOffboardingPurge: mockVerifyAccountOffboardingPurge,
}));

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
}));

vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { handleAccountOffboardingPurge } from '../PurgeWorker';

describe('AccountOffboarding PurgeWorker', () => {
  beforeEach(() => {
    calls.length = 0;
    mockSql.mockClear();
    mockSql.begin.mockClear();
    mockDeleteUser.mockClear();
    mockMarkOutboxCompleted.mockClear();
    mockMarkOutboxFailed.mockClear();
    mockVerifyAccountOffboardingPurge.mockClear();
    mockVerifyAccountOffboardingPurge.mockResolvedValue({ ok: true, issues: [] });
    mockCaptureMessage.mockClear();
    mockState.authRevalidationPasses = true;
    mockState.authAlreadyDetached = false;
    mockState.offboarding = {
      id: OFFBOARDING_ID,
      account_id: ACCOUNT_ID,
      mode: 'delete_data',
      status: 'purge_scheduled',
      terminal_at: null,
      teardown_completed_at: new Date('2026-06-07T11:00:00.000Z'),
      purge_started_at: new Date('2026-06-07T11:30:00.000Z'),
      purge_cancelled_at: null,
      auth_user_id: AUTH_USER_ID,
      provider_dispositions: [],
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_123',
      zernio_account_ids: ['zernio-account-1'],
      zernio_profile_ids: ['zernio-profile-1'],
    };
  });

  it('revalidates the captured auth binding, deletes the auth user outside a transaction, then terminalizes after verification', async () => {
    await handleAccountOffboardingPurge(makeJob());

    const revalidateIdx = calls.findIndex((call) =>
      call.text.includes('FROM users u') && call.text.includes('u.auth_id =')
    );
    expect(revalidateIdx).toBeGreaterThanOrEqual(0);
    expect(calls[revalidateIdx]!.scope).toBe('tx');
    expect(calls[revalidateIdx]!.text).toContain('u.account_id =');
    expect(calls[revalidateIdx]!.text).toContain('future_binding.account_id <>');

    const deleteOrder = mockDeleteUser.mock.invocationCallOrder[0]!;
    const firstTxOrder = mockSql.begin.mock.invocationCallOrder[0]!;
    const secondTxOrder = mockSql.begin.mock.invocationCallOrder[1]!;
    expect(firstTxOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(secondTxOrder);
    expect(mockDeleteUser).toHaveBeenCalledWith(AUTH_USER_ID);

    expect(mockVerifyAccountOffboardingPurge).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      offboardingId: OFFBOARDING_ID,
      currentOutboxId: OUTBOX_ID,
      authUserId: AUTH_USER_ID,
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      zernioAccountIds: ['zernio-account-1'],
      zernioProfileIds: ['zernio-profile-1'],
    }, expect.any(Function));
    const terminalIdx = calls.findIndex((call) => call.text.includes("SET status = 'purged'"));
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    const sqlText = calls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('job_outbox.id <>');
    expect(sqlText).toContain('onboarding_demo_scope AS');
    expect(sqlText).toContain('length(btrim(s.identifier)) > 0');
    expect(sqlText).toContain("SET status = 'completed'");
    expect(sqlText).toContain('AND attempts = ?');
    expect(sqlText).toContain("status IN ('pending', 'dispatching', 'dispatched')");
    expect(sqlText).toContain('WHERE id = ?::uuid');
    expect(sqlText).toContain('payload = ?');
    expect(sqlText).toContain('approval_link_id = NULL');
    expect(sqlText).toContain('user_agent = NULL');
    expect(sqlText).toContain('provider_dispositions = provider_dispositions ||');
    expect(calls.some((call) =>
      call.values.some((value) =>
        Array.isArray(value) &&
        value.some((entry) =>
          entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'sms_opt_out_scrub_scope'
        )
      )
    )).toBe(true);
    expect(calls.some((call) =>
      call.values.some((value) =>
        Array.isArray(value) &&
        value.some((entry) =>
          entry &&
          typeof entry === 'object' &&
          'job_outbox_id' in entry &&
          entry.job_outbox_id === '00000000-0000-7000-8000-000000000004'
        )
      )
    )).toBe(true);
    expect(sqlText).not.toContain("status = 'purging'");
  });

  it('does not call deleteUser when immediate auth revalidation fails', async () => {
    mockState.authRevalidationPasses = false;

    await expect(handleAccountOffboardingPurge(makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_auth_revalidation_failed',
    );

    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('treats auth not-found as success only after revalidation has already passed', async () => {
    mockDeleteUser.mockResolvedValueOnce({
      data: {},
      error: { message: 'User not found', status: 404 },
    } as never);

    await handleAccountOffboardingPurge(makeJob());

    expect(mockDeleteUser).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(mockState.offboarding?.status).toBe('purged');
  });

  it('allows purge when admin provider disposition is recorded even if teardown completion is absent', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{
        type: 'admin_provider_disposition',
        provider: 'zernio',
        resource_type: 'account',
        scrubbed_resource_reference: 'sha256:provider-ref',
        admin_actor_user_id: 'admin-1',
        reason: 'Provider support confirmed teardown.',
        recorded_at: '2026-06-07T12:00:00.000Z',
        ticket: 'SUP-123',
      }],
    };

    await handleAccountOffboardingPurge(makeJob());

    expect(mockVerifyAccountOffboardingPurge).toHaveBeenCalledOnce();
    expect(mockState.offboarding?.status).toBe('purged');
  });

  it('does not treat generic provider markers as provider-disposition purge eligibility', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{ provider: 'zernio', disposition: 'admin_recorded' }],
    };

    await expect(handleAccountOffboardingPurge(makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('does not treat SMS scrub-scope records as provider-disposition purge eligibility', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{
        type: 'sms_opt_out_scrub_scope',
        messaging_service_sid_hash: 'sid-hash',
        handle_hash: 'handle-hash',
        scrubbed_handle: 'sha256:handle-hash',
      }],
    };

    await expect(handleAccountOffboardingPurge(makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('terminally fails and stores a scrubbed error when final verification finds remnants on the last attempt', async () => {
    mockVerifyAccountOffboardingPurge.mockResolvedValueOnce({
      ok: false,
      issues: [
        {
          table: 'responses',
          purgeVerification: 'must_be_absent',
          disposition: 'hard_delete',
          violationCount: 1,
          reason: 'content',
        },
      ],
    } as never);

    await handleAccountOffboardingPurge(makeJob({ attemptsMade: 2, attempts: 3 }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      OUTBOX_ID,
      'account_offboarding_purge_verification_failed:responses',
      2,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockState.offboarding?.status).toBe('failed');
  });
});

function makeJob(
  overrides: { attemptsMade?: number; attempts?: number } = {},
): Job<AccountOffboardingPurgePayload> {
  return {
    id: OUTBOX_ID,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
    data: {
      account_offboarding_id: OFFBOARDING_ID,
      account_id: ACCOUNT_ID,
      correlation_id: 'correlation-1',
      outbox_id: OUTBOX_ID,
      outbox_attempt: 2,
    },
  } as Job<AccountOffboardingPurgePayload>;
}
