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
  recipient_email: string | null;
  provider_dispositions: unknown[];
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  zernio_account_ids: string[] | null;
  zernio_profile_ids: string[] | null;
  location_ids: string[] | null;
  stripe_step: string | null;
  zernio_accounts_step: string | null;
  zernio_profiles_step: string | null;
  location_archival_step: string | null;
}

const ACCOUNT_ID = '00000000-0000-7000-8000-000000000001';
const OFFBOARDING_ID = '00000000-0000-7000-8000-000000000002';
const OUTBOX_ID = '00000000-0000-7000-8000-000000000003';
const AUTH_USER_ID = 'auth-user-1';

const {
  calls,
  mockState,
  mockSql,
  mockSupabaseServer,
  mockDeleteUser,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockVerifyAccountOffboardingPurge,
  mockCaptureMessage,
  mockEnqueueOffboardingPurged,
  mockSendInternalEmail,
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

  // A single-string call is Postgres.js identifier interpolation (sql('table')); model it
  // as an opaque fragment rather than a tagged-template query so dynamic-table SQL works.
  const identifierFragment = (strings: unknown) =>
    !Array.isArray(strings) ? { __id: String(strings) } : null;
  const mockSql: any = vi.fn((strings: any, ...values: unknown[]) =>
    identifierFragment(strings) ?? execute('sql', strings, ...values)
  );
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
    const tx: any = vi.fn((strings: any, ...values: unknown[]) =>
      identifierFragment(strings) ?? execute('tx', strings, ...values)
    );
    tx.json = mockSql.json;
    return cb(tx);
  });
  mockSql.json = vi.fn((value: unknown) => value);

  const mockDeleteUser = vi.fn(async () => ({ data: {}, error: null }));
  const mockSupabaseServer: any = {
    auth: {
      admin: {
        deleteUser: mockDeleteUser,
      },
    },
  };

  return {
    calls,
    mockState,
    mockSql,
    mockSupabaseServer,
    mockDeleteUser,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockVerifyAccountOffboardingPurge: vi.fn(async () => ({ ok: true, issues: [] })),
    mockCaptureMessage: vi.fn(),
    mockEnqueueOffboardingPurged: vi.fn(),
    mockSendInternalEmail: vi.fn(),
  };
});

// Transitive-import shield: the SUT (PurgeWorker + purge-stages) no longer
// imports the db/server singletons — they are injected below via mockSql +
// mockSupabaseServer. This mock only stops any transitive importer from
// constructing a real Postgres/Supabase client at module load.
vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => value,
  supabaseServer: mockSupabaseServer,
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

vi.mock('../../../../src/lib/account-offboarding/purge-verification', () => ({
  verifyAccountOffboardingPurge: mockVerifyAccountOffboardingPurge,
}));

vi.mock('../../../../src/lib/account-offboarding/analytics', () => ({
  enqueueOffboardingPurged: mockEnqueueOffboardingPurged,
}));

vi.mock('../../../../src/lib/notifications/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/notifications/email')>();
  return {
    ...actual,
    sendInternalEmail: mockSendInternalEmail,
  };
});

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
    mockEnqueueOffboardingPurged.mockClear();
    mockEnqueueOffboardingPurged.mockResolvedValue(undefined);
    mockSendInternalEmail.mockClear();
    mockSendInternalEmail.mockResolvedValue({ messageId: 'email-purge-receipt-1' });
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
      recipient_email: 'owner@example.com',
      provider_dispositions: [],
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_123',
      zernio_account_ids: ['zernio-account-1'],
      zernio_profile_ids: ['zernio-profile-1'],
      location_ids: ['00000000-0000-7000-8000-0000000000a1'],
      stripe_step: 'success',
      zernio_accounts_step: 'success',
      zernio_profiles_step: 'success',
      location_archival_step: 'success',
    };
  });

  it('revalidates the captured auth binding, deletes the auth user outside a transaction, then terminalizes after verification', async () => {
    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

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
    expect(mockEnqueueOffboardingPurged).toHaveBeenCalledWith(expect.any(Function), {
      offboardingId: OFFBOARDING_ID,
    });
    expect(mockVerifyAccountOffboardingPurge.mock.invocationCallOrder[0]!).toBeLessThan(
      mockEnqueueOffboardingPurged.mock.invocationCallOrder[0]!,
    );
    // M2: the purge receipt is enqueued durably inside the finalize tx (carrying
    // the recipient in the payload because the row is scrubbed), not sent
    // best-effort post-commit.
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    const receiptEnqueue = calls.find(
      (call) => call.text.includes('INSERT INTO job_outbox')
        && call.values.includes('account_offboarding_email'),
    );
    expect(receiptEnqueue).toBeDefined();
    expect(receiptEnqueue!.scope).toBe('tx');
    const receiptPayload = receiptEnqueue!.values.find(
      (value) => value !== null && typeof value === 'object'
        && (value as { email_type?: string }).email_type === 'purge_receipt',
    ) as { email_type: string; recipient_email?: string } | undefined;
    expect(receiptPayload?.recipient_email).toBe('owner@example.com');
    const sqlText = calls.map((call) => call.text).join('\n');
    expect(sqlText).toContain('job_outbox.id <>');
    expect(sqlText).toContain('onboarding_demo_scope AS');
    expect(sqlText).toContain('length(btrim(s.identifier)) > 0');
    expect(sqlText).toContain("SET status = 'completed'");
    expect(sqlText).toContain('AND attempts = ?');
    expect(sqlText).toContain("status IN ('pending', 'dispatching', 'dispatched')");
    expect(sqlText).toContain('WHERE id = ?::uuid');
    expect(sqlText).toContain('payload = ?');
    // D3 regression: scrub the REAL approval_audit_log PII columns; never the
    // phantom columns approval_link_id / user_agent (which don't exist in the
    // schema and made every purge throw). Scoped to the approval_audit_log
    // statement so a real user_agent column on another table can't mask this.
    const approvalScrub = calls.find((call) => call.text.includes('UPDATE approval_audit_log'));
    expect(approvalScrub?.text).toContain('response_text_at_approval = NULL');
    expect(approvalScrub?.text).toContain('token_hash = NULL');
    expect(approvalScrub?.text).not.toContain('approval_link_id');
    expect(approvalScrub?.text).not.toContain('user_agent');
    expect(sqlText).toContain('provider_dispositions = provider_dispositions ||');
    const notificationDelete = calls.find((call) => call.text.includes('DELETE FROM notification_deliveries'));
    expect(notificationDelete?.text).toContain('nd.account_id =');
    expect(notificationDelete?.text).toContain('nd.business_id IN');
    expect(notificationDelete?.text).toContain('SELECT id FROM businesses WHERE account_id =');
    // channel_enrollments is hard_delete/must_be_absent — the purge fails its own
    // verification gate if no stage deletes these rows (DELETE moved here from the
    // removed SMS opt-out stage in migration-061 cleanup).
    const enrollmentDelete = calls.find((call) => call.text.includes('DELETE FROM channel_enrollments'));
    expect(enrollmentDelete?.text).toContain('account_id =');
    expect(enrollmentDelete?.scope).toBe('tx');
    // Agent run spine tables are hard_delete/must_be_absent (accounts rows are
    // retained de-identified, so their ON DELETE CASCADE never fires) — the
    // purge must delete outcomes then runs explicitly; agent_run_steps cascades
    // via its agent_runs FK, so no explicit steps DELETE may appear.
    const agentOutcomesDelete = calls.find((call) => call.text.includes('DELETE FROM agent_outcomes'));
    expect(agentOutcomesDelete?.text).toContain('account_id =');
    expect(agentOutcomesDelete?.scope).toBe('tx');
    const agentRunsDelete = calls.find((call) => call.text.includes('DELETE FROM agent_runs'));
    expect(agentRunsDelete?.text).toContain('account_id =');
    expect(agentRunsDelete?.scope).toBe('tx');
    expect(calls.findIndex((call) => call.text.includes('DELETE FROM agent_outcomes')))
      .toBeLessThan(calls.findIndex((call) => call.text.includes('DELETE FROM agent_runs')));
    expect(sqlText).not.toContain('DELETE FROM agent_run_steps');
    // Guardian escalations (migration 073) are hard_delete/must_be_absent and
    // review_id has NO cascade — the escalations DELETE must run before the
    // reviews DELETE or the purge dies on an FK violation. The reviews delete
    // goes through deleteByBusiness, so its table name arrives as an identifier
    // fragment value (see identifierFragment above), not in the query text.
    const escalationsDelete = calls.find((call) => call.text.includes('DELETE FROM review_escalations'));
    expect(escalationsDelete?.text).toContain('account_id =');
    expect(escalationsDelete?.scope).toBe('tx');
    const isReviewsByBusinessDelete = (call: QueryCall) =>
      call.text.includes('DELETE FROM ?')
      && call.values.some((value) => (value as { __id?: string } | null)?.__id === 'reviews');
    expect(calls.findIndex(isReviewsByBusinessDelete)).toBeGreaterThan(-1);
    expect(calls.findIndex((call) => call.text.includes('DELETE FROM review_escalations')))
      .toBeLessThan(calls.findIndex(isReviewsByBusinessDelete));
    expect(sqlText).toContain('recipient_email = NULL');
    expect(sqlText).toContain('stripe_customer_id = NULL');
    expect(sqlText).toContain('stripe_subscription_id = NULL');
    expect(sqlText).toContain('zernio_account_ids = NULL');
    expect(sqlText).toContain('zernio_profile_ids = NULL');
    expect(sqlText).toContain('auth_user_id = NULL');
    expect(sqlText).toContain('last_error = NULL');
    // One scrub over a single account-scope predicate (write-side twin of the purge
    // verification): FK by account/business/user OR a raw account id left in distinct_id.
    const analyticsUpdates = calls.filter((call) => call.text.includes('UPDATE analytics_events'));
    expect(analyticsUpdates).toHaveLength(1);
    const analyticsUpdate = analyticsUpdates[0]!;
    expect(analyticsUpdate.text).toContain("event_key = 'scrubbed:' ||");
    expect(analyticsUpdate.text).toContain("distinct_id = 'scrubbed:' ||");
    expect(analyticsUpdate.text).toContain('anonymous_id = NULL');
    expect(analyticsUpdate.text).toContain('account_id = NULL');
    expect(analyticsUpdate.text).toContain('user_id = NULL');
    expect(analyticsUpdate.text).toContain('business_id = NULL');
    expect(analyticsUpdate.text).toContain("properties = '{}'::jsonb");
    expect(analyticsUpdate.text).toContain('last_error = NULL');
    expect(analyticsUpdate.text).toContain('WHERE account_id =');
    expect(analyticsUpdate.text).toContain('business_id IN (SELECT id FROM businesses');
    expect(analyticsUpdate.text).toContain('user_id IN (SELECT id FROM users');
    // M1: FK-independent branch catches a raw account identifier left in distinct_id.
    expect(analyticsUpdate.text).toContain('distinct_id IN');
    expect(sqlText).not.toContain('account_offboarding_purge_receipt');
    expect(sqlText).not.toContain('INSERT INTO notification_deliveries');
    expect(sqlText).not.toContain('owner@example.com');
    expect(sqlText).not.toContain('email-purge-receipt-1');
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

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_auth_revalidation_failed',
    );

    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('treats auth not-found as success only after revalidation has already passed', async () => {
    mockDeleteUser.mockResolvedValueOnce({
      data: {},
      error: { message: 'User not found', status: 404 },
    } as never);

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

    expect(mockDeleteUser).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(mockState.offboarding?.status).toBe('purged');
  });

  it('allows purge when admin provider disposition covers every applicable failed provider step', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      // The Zernio account teardown failed; the concrete Zernio disposition covers it.
      // Every other applicable provider step succeeded, so the purge is safe.
      zernio_accounts_step: 'failed',
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

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob());

    expect(mockVerifyAccountOffboardingPurge).toHaveBeenCalledOnce();
    expect(mockState.offboarding?.status).toBe('purged');
  });

  it('refuses to purge when a concrete disposition leaves another applicable provider step unresolved (H2 defense-in-depth)', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      // Stripe teardown failed and the Zernio account step never ran (default
      // 'not_applicable') even though a Zernio account exists. Only Zernio is
      // dispositioned, so the live Stripe subscription is still unresolved.
      stripe_step: 'failed',
      zernio_accounts_step: 'not_applicable',
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

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
  });

  it('does not treat generic provider markers as provider-disposition purge eligibility', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{ provider: 'zernio', disposition: 'admin_recorded' }],
    };

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('does not treat non-admin scrub-scope records as provider-disposition purge eligibility', async () => {
    mockState.offboarding = {
      ...mockState.offboarding!,
      teardown_completed_at: null,
      provider_dispositions: [{
        type: 'job_outbox_scrub_scope',
        job_outbox_id: 'some-outbox-id',
        job_outbox_id_hash: 'some-hash',
      }],
    };

    await expect(handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 0 }))).rejects.toThrow(
      'account_offboarding_teardown_incomplete',
    );

    expect(mockVerifyAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
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

    await handleAccountOffboardingPurge(mockSql, mockSupabaseServer, makeJob({ attemptsMade: 2, attempts: 3 }));

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      OUTBOX_ID,
      'account_offboarding_purge_verification_failed:responses',
      2,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockState.offboarding?.status).toBe('failed');
    expect(mockEnqueueOffboardingPurged).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
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
