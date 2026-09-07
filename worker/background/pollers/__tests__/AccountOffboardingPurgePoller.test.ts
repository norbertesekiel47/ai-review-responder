import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sqlQueue,
  sqlCalls,
  beginCalls,
  testState,
  mockAccountOffboardingEnabled,
  mockWriteAccountAuditLog,
  mockEnqueueAccountOffboardingPurge,
  mockLoggerLog,
  mockLoggerWarn,
  mockLoggerError,
  mockSql,
  mockTx,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ scope: 'sql' | 'tx'; template: string; values: unknown[] }> = [];
  const beginCalls: Array<{ tx: unknown }> = [];
  const testState: {
    persistedOffboardingRow: PersistedOffboardingRow | null;
    revokedTokenCount: number;
    forceRaceLoss: boolean;
  } = {
    persistedOffboardingRow: null,
    revokedTokenCount: 0,
    forceRaceLoss: false,
  };

  const consume = (scope: 'sql' | 'tx') =>
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const template = strings.join('?');
      sqlCalls.push({ scope, template, values });

      if (scope === 'tx' && testState.persistedOffboardingRow) {
        if (template.includes('FROM account_offboardings') && template.includes('FOR UPDATE SKIP LOCKED')) {
          return Promise.resolve(
            rowMatchesPurgeClaimPredicate(testState.persistedOffboardingRow)
              ? [snapshotClaimableRow(testState.persistedOffboardingRow)]
              : [],
          );
        }

        if (template.includes('UPDATE account_offboardings') && template.includes('purge_started_at = NOW()')) {
          if (
            testState.forceRaceLoss ||
            !rowMatchesPurgeClaimPredicate(testState.persistedOffboardingRow)
          ) {
            return Promise.resolve([]);
          }

          testState.persistedOffboardingRow = {
            ...testState.persistedOffboardingRow,
            purge_started_at: new Date(),
            failed_step: null,
            last_error: null,
          };
          return Promise.resolve([snapshotClaimableRow(testState.persistedOffboardingRow)]);
        }

        if (template.includes('UPDATE account_offboarding_tokens') && template.includes('revoked_at = NOW()')) {
          testState.revokedTokenCount += 1;
          testState.persistedOffboardingRow = {
            ...testState.persistedOffboardingRow,
            activeTokenExpiresAt: null,
          };
          return Promise.resolve([]);
        }
      }

      const next = sqlQueue.shift();
      return Promise.resolve(next ?? []);
    });

  const mockSql = consume('sql') as ReturnType<typeof consume> & {
    begin: ReturnType<typeof vi.fn>;
  };
  const mockTx = consume('tx');
  mockSql.begin = vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
    beginCalls.push({ tx: mockTx });
    return fn(mockTx);
  });

  return {
    sqlQueue,
    sqlCalls,
    beginCalls,
    testState,
    mockAccountOffboardingEnabled: vi.fn(() => true),
    mockWriteAccountAuditLog: vi.fn(async () => undefined),
    mockEnqueueAccountOffboardingPurge: vi.fn(async () => 'outbox-1'),
    mockLoggerLog: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
    mockSql,
    mockTx,
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../../../src/lib/account-offboarding/flags', () => ({
  accountOffboardingEnabled: mockAccountOffboardingEnabled,
}));

vi.mock('../../../../src/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

vi.mock('../../../../src/lib/account-offboarding/outbox', () => ({
  enqueueAccountOffboardingPurge: mockEnqueueAccountOffboardingPurge,
}));

vi.mock('../../../../src/lib/shared/logger', () => ({
  toError: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
  logUnhandledPollError: () => () => {},
  createWorkerLogger: () => ({
    log: mockLoggerLog,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));

import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';
import {
  getAccountOffboardingPurgeWindowOverrideMs,
  runAccountOffboardingPurgeOnce,
  startAccountOffboardingPurgePoller,
  stopAccountOffboardingPurgePoller,
} from '../AccountOffboardingPurgePoller';

type ClaimableRow = {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'purge_scheduled';
  purge_after: Date;
};

type PersistedOffboardingRow = ClaimableRow & {
  purge_cancelled_at: Date | null;
  purge_started_at: Date | null;
  terminal_at: Date | null;
  teardown_completed_at: Date | null;
  provider_dispositions: unknown[];
  failed_step: string | null;
  last_error: string | null;
  // expires_at of one unconsumed, unrevoked keep-my-data token, or null when
  // none exists. Models the #614 active-token NOT EXISTS in the claim predicate.
  activeTokenExpiresAt: Date | null;
};

function makeClaimableRow(overrides: Partial<ClaimableRow> = {}): ClaimableRow {
  return {
    id: overrides.id ?? 'offboarding-1',
    account_id: overrides.account_id ?? 'account-1',
    mode: 'delete_data',
    status: 'purge_scheduled',
    purge_after: overrides.purge_after ?? new Date('2026-06-06T12:00:00.000Z'),
  };
}

function makePersistedOffboardingRow(
  overrides: Partial<PersistedOffboardingRow> = {},
): PersistedOffboardingRow {
  return {
    ...makeClaimableRow(overrides),
    purge_cancelled_at: overrides.purge_cancelled_at ?? null,
    purge_started_at: overrides.purge_started_at ?? null,
    terminal_at: overrides.terminal_at ?? null,
    teardown_completed_at: Object.prototype.hasOwnProperty.call(overrides, 'teardown_completed_at')
      ? overrides.teardown_completed_at ?? null
      : new Date('2026-06-06T12:30:00.000Z'),
    provider_dispositions: overrides.provider_dispositions ?? [],
    failed_step: overrides.failed_step ?? 'purge',
    last_error: overrides.last_error ?? 'stale-error',
    activeTokenExpiresAt: overrides.activeTokenExpiresAt ?? null,
  };
}

// Mirrors the poller's claim predicate, INCLUDING the override arm (the window
// is widened by the effective override, never by writing purge_after) and the
// #614 active-token guard. A mock that ignored the override would let a
// future-dated fixture pass a "not claimed" assertion for the wrong reason.
function rowMatchesPurgeClaimPredicate(row: PersistedOffboardingRow): boolean {
  const windowMs = getAccountOffboardingPurgeWindowOverrideMs() ?? 0;
  return (
    row.mode === 'delete_data' &&
    row.status === 'purge_scheduled' &&
    row.purge_after.getTime() <= Date.now() + windowMs &&
    !(row.activeTokenExpiresAt !== null && row.activeTokenExpiresAt.getTime() > Date.now()) &&
    row.purge_cancelled_at === null &&
    row.purge_started_at === null &&
    row.terminal_at === null &&
    (row.teardown_completed_at !== null || hasAdminProviderDisposition(row.provider_dispositions))
  );
}

function hasAdminProviderDisposition(dispositions: unknown[]): boolean {
  return dispositions.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (
      record.type === 'admin_provider_disposition' &&
      typeof record.provider === 'string' &&
      typeof record.resource_type === 'string' &&
      record.resource_type.trim().length > 0 &&
      typeof record.scrubbed_resource_reference === 'string' &&
      record.scrubbed_resource_reference.trim().length > 0 &&
      typeof record.admin_actor_user_id === 'string' &&
      record.admin_actor_user_id.trim().length > 0 &&
      typeof record.reason === 'string' &&
      record.reason.trim().length > 0 &&
      typeof record.recorded_at === 'string' &&
      record.recorded_at.trim().length > 0
    );
  });
}

function snapshotClaimableRow(row: PersistedOffboardingRow): ClaimableRow {
  return {
    id: row.id,
    account_id: row.account_id,
    mode: row.mode,
    status: row.status,
    purge_after: row.purge_after,
  };
}

function combinedSql(): string {
  return sqlCalls.map((call) => call.template).join('\n');
}

function browserPurgeWindowOverrideEnvKey(): string {
  return [
    'NEXT',
    'PUBLIC',
    'ACCOUNT',
    'OFFBOARDING',
    'PURGE',
    'WINDOW',
    'OVERRIDE',
    'MS',
  ].join('_');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-06T13:00:00.000Z'));

  sqlQueue.length = 0;
  sqlCalls.length = 0;
  beginCalls.length = 0;
  testState.persistedOffboardingRow = null;
  testState.revokedTokenCount = 0;
  testState.forceRaceLoss = false;
  mockSql.mockClear();
  mockTx.mockClear();
  mockSql.begin.mockClear();
  mockAccountOffboardingEnabled.mockReset();
  mockAccountOffboardingEnabled.mockReturnValue(true);
  mockWriteAccountAuditLog.mockClear();
  mockEnqueueAccountOffboardingPurge.mockClear();
  mockLoggerLog.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
  delete process.env.ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS;
  delete process.env.ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE;
  delete process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS;
  delete process.env[browserPurgeWindowOverrideEnvKey()];
  delete process.env.VERCEL_ENV;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  vi.stubEnv('NODE_ENV', 'test');
  // The purge-window override now reads the memoized getWorkerConfig(); clear the
  // memo so each test's ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS value (set
  // after this beforeEach) is parsed fresh (#6). The lane guard reads
  // RAILWAY_ENVIRONMENT_NAME/NODE_ENV directly through deploymentLane() (#614)
  // and is unaffected by the memo.
  resetWorkerConfigForTests();
});

afterEach(() => {
  stopAccountOffboardingPurgePoller();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('AccountOffboardingPurgePoller', () => {
  it('no-ops when account offboarding is disabled and starts no timer', async () => {
    mockAccountOffboardingEnabled.mockReturnValue(false);

    await runAccountOffboardingPurgeOnce();
    startAccountOffboardingPurgePoller();
    await vi.runAllTimersAsync();

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claims eligible delete-data rows with SKIP LOCKED and enqueues purge in the same transaction', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow();

    await runAccountOffboardingPurgeOnce();

    const claimCall = sqlCalls.find((call) =>
      call.scope === 'tx' &&
      call.template.includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall!.template).toContain("mode = 'delete_data'");
    expect(claimCall!.template).toContain("status = 'purge_scheduled'");
    expect(claimCall!.template).toContain('purge_after IS NOT NULL');
    expect(claimCall!.template).toContain('purge_after <= NOW()');
    // #614: the active-token guard is unconditional — present on the claim
    // SELECT and the claim UPDATE, not only on the override arm.
    expect(claimCall!.template).toContain('NOT EXISTS');
    expect(claimCall!.template).toContain('FROM account_offboarding_tokens t');
    expect(claimCall!.template).toContain('t.expires_at > NOW()');
    expect(claimCall!.template).toContain('purge_cancelled_at IS NULL');
    expect(claimCall!.template).toContain('purge_started_at IS NULL');
    expect(claimCall!.template).toContain('terminal_at IS NULL');
    expect(claimCall!.template).toContain('teardown_completed_at IS NOT NULL');
    expect(claimCall!.template).toContain('jsonb_array_elements(provider_dispositions)');
    expect(claimCall!.template).toContain("'admin_provider_disposition'");
    expect(claimCall!.template).toContain('scrubbed_resource_reference');
    expect(claimCall!.template).toContain('admin_actor_user_id');
    expect(claimCall!.template).not.toContain("'provider_disposition'");
    expect(claimCall!.template).not.toContain("'sms_opt_out_scrub_scope'");

    const updateCall = sqlCalls.find((call) =>
      call.scope === 'tx' &&
      call.template.includes('UPDATE account_offboardings') &&
      call.template.includes('purge_started_at = NOW()'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.template).not.toContain("status = 'purging'");
    expect(updateCall!.template).not.toContain('status = ?');
    expect(updateCall!.template).toContain('failed_step = NULL');
    expect(updateCall!.template).toContain('last_error = NULL');
    expect(updateCall!.template).toContain('purge_cancelled_at IS NULL');
    expect(updateCall!.template).toContain('purge_started_at IS NULL');
    expect(updateCall!.template).toContain('NOT EXISTS');
    expect(updateCall!.template).toContain('FROM account_offboarding_tokens t');
    expect(updateCall!.template).toContain('t.expires_at > NOW()');

    const revokeCall = sqlCalls.find((call) =>
      call.scope === 'tx' &&
      call.template.includes('UPDATE account_offboarding_tokens'),
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall!.template).toContain('consumed_at IS NULL');
    expect(revokeCall!.template).toContain('revoked_at IS NULL');
    expect(testState.revokedTokenCount).toBe(1);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        accountId: 'account-1',
        eventType: 'account_offboarding_purge_started',
        entityType: 'account_offboarding',
        entityId: 'offboarding-1',
        payload: {
          mode: 'delete_data',
          status: 'purge_scheduled',
          purge_after: '2026-06-06T12:00:00.000Z',
        },
      }),
    );

    expect(mockEnqueueAccountOffboardingPurge).toHaveBeenCalledOnce();
    expect(mockEnqueueAccountOffboardingPurge).toHaveBeenCalledWith(
      mockTx,
      {
        accountOffboardingId: 'offboarding-1',
        accountId: 'account-1',
        correlationId: undefined,
      },
    );
    expect(beginCalls).toHaveLength(2);
  });

  it('does not audit, enqueue, or revoke tokens when revalidation loses the race', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow();
    testState.forceRaceLoss = true;

    await runAccountOffboardingPurgeOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(testState.revokedTokenCount).toBe(0);
    expect(mockLoggerLog).toHaveBeenCalledWith(
      'Skipped - state changed before purge claim',
      { offboarding_id: 'offboarding-1' },
    );
  });

  it('keeps cancelled and already-started rows out of the claim predicate', async () => {
    sqlQueue.push([]);

    await runAccountOffboardingPurgeOnce();

    const sqlText = combinedSql();
    expect(sqlText).toContain('purge_cancelled_at IS NULL');
    expect(sqlText).toContain('purge_started_at IS NULL');
  });

  it('uses concrete admin provider dispositions as an eligibility fallback', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
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
    });

    await runAccountOffboardingPurgeOnce();

    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    expect(combinedSql()).toContain('jsonb_array_elements(provider_dispositions)');
  });

  it('does not treat generic provider markers as provider-disposition purge eligibility', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
      teardown_completed_at: null,
      provider_dispositions: [{ provider: 'zernio', disposition: 'recorded' }],
    });

    await runAccountOffboardingPurgeOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(testState.revokedTokenCount).toBe(0);
  });

  it('does not treat SMS scrub-scope records as admin provider dispositions', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
      teardown_completed_at: null,
      provider_dispositions: [{
        type: 'sms_opt_out_scrub_scope',
        messaging_service_sid_hash: 'sid-hash',
        handle_hash: 'handle-hash',
        scrubbed_handle: 'sha256:handle-hash',
      }],
    });

    await runAccountOffboardingPurgeOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(testState.revokedTokenCount).toBe(0);
  });

  // #614: the override arm admits a future-dated row; a live keep-my-data token
  // must keep it out. Three assertions on the SAME row, in order, so the token is
  // proven to be the reason for the refusal — not the date.
  it('never claims a row inside the override window while a keep-my-data token is live, and claims it once the token is revoked', async () => {
    process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS = String(2 * 60 * 60 * 1000);
    resetWorkerConfigForTests();
    const purgeAfter = new Date('2026-06-06T14:00:00.000Z'); // NOW() + 1h
    const tokenExpiresAt = new Date('2026-06-06T13:30:00.000Z'); // NOW() + 30m, < purge_after

    // (a) No token: the override window is what admits the future-dated row.
    testState.persistedOffboardingRow = makePersistedOffboardingRow({ purge_after: purgeAfter });
    await runAccountOffboardingPurgeOnce();
    expect(mockEnqueueAccountOffboardingPurge).toHaveBeenCalledOnce();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();

    // (b) Same row, live token: refused. Nothing is revoked, audited, or enqueued.
    mockEnqueueAccountOffboardingPurge.mockClear();
    mockWriteAccountAuditLog.mockClear();
    testState.revokedTokenCount = 0;
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
      purge_after: purgeAfter,
      activeTokenExpiresAt: tokenExpiresAt,
    });
    await runAccountOffboardingPurgeOnce();
    expect(mockEnqueueAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(testState.revokedTokenCount).toBe(0);
    expect(testState.persistedOffboardingRow?.purge_started_at).toBeNull();

    // (c) Token revoked (keep-my-data window over): claimable again.
    testState.persistedOffboardingRow = {
      ...testState.persistedOffboardingRow!,
      activeTokenExpiresAt: null,
    };
    await runAccountOffboardingPurgeOnce();
    expect(mockEnqueueAccountOffboardingPurge).toHaveBeenCalledOnce();
    expect(testState.persistedOffboardingRow?.purge_started_at).not.toBeNull();
  });

  it('does not claim a future-dated row without the override, token or not', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
      purge_after: new Date('2026-06-06T14:00:00.000Z'),
    });

    await runAccountOffboardingPurgeOnce();

    expect(mockEnqueueAccountOffboardingPurge).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  // readWindowOverride() is migrated to the memoized getWorkerConfig(), so each
  // mid-test env mutation below is followed by resetWorkerConfigForTests() to
  // re-parse (production env is immutable, so this never happens in prod) (#6).
  // The lane guard itself is deploymentLane() === 'production' (#614, ADR 0013):
  // Railway's environment name wins over NODE_ENV, so the staging worker
  // (NODE_ENV=production + RAILWAY_ENVIRONMENT_NAME=staging) honours the override.
  it('refuses the purge-window override on the production lane only, and never via NEXT_PUBLIC env', () => {
    process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS = '86400000';
    process.env[browserPurgeWindowOverrideEnvKey()] = '123';
    vi.stubEnv('NODE_ENV', 'test');
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBe(86_400_000);

    delete process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS;
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBeNull();

    // Local NODE_ENV=production with no Railway variable: refused, as before.
    process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS = '86400000';
    vi.stubEnv('NODE_ENV', 'production');
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBeNull();

    // The staging Railway worker: honoured. This is the lane the override exists for.
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'staging');
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBe(86_400_000);

    // The production Railway worker (NODE_ENV unset there): refused.
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('NODE_ENV', '');
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBeNull();

    // VERCEL_ENV is no longer consulted (accepted widening — the worker never
    // runs on Vercel, and the active-token guard bounds what the override can do).
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    vi.stubEnv('NODE_ENV', 'test');
    process.env.VERCEL_ENV = 'production';
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBe(86_400_000);
  });

  it('clamps the override to a 3-day maximum and rejects non-positive or non-numeric values', () => {
    vi.stubEnv('NODE_ENV', 'test');
    delete process.env.VERCEL_ENV;
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // A value above the cap is clamped down to exactly 3 days — so a fat-fingered
    // staging override can never push the destructive purge window arbitrarily far out.
    process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS = String(7 * 24 * 60 * 60 * 1000);
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBe(threeDaysMs);

    // Exactly 3 days passes through unchanged.
    process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS = String(threeDaysMs);
    resetWorkerConfigForTests();
    expect(getAccountOffboardingPurgeWindowOverrideMs()).toBe(threeDaysMs);

    // Non-positive and non-numeric values are rejected (null), never coerced to 0/NaN.
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS = bad;
      resetWorkerConfigForTests();
      expect(getAccountOffboardingPurgeWindowOverrideMs()).toBeNull();
    }
  });
});
