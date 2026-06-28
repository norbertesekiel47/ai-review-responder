import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sqlQueue,
  sqlCalls,
  beginCalls,
  testState,
  mockAccountOffboardingEnabled,
  mockWriteAccountAuditLog,
  mockEnqueueAccountOffboardingTeardown,
  mockLoggerLog,
  mockLoggerWarn,
  mockLoggerError,
  mockSql,
  mockTx,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ scope: 'sql' | 'tx'; template: string; values: unknown[] }> = [];
  const beginCalls: Array<{ tx: unknown }> = [];
  const testState: { persistedOffboardingRow: PersistedOffboardingRow | null } = {
    persistedOffboardingRow: null,
  };

  const consume = (scope: 'sql' | 'tx') =>
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const template = strings.join('?');
      sqlCalls.push({ scope, template, values });

      if (scope === 'tx' && testState.persistedOffboardingRow) {
        if (template.includes('FROM account_offboardings') && template.includes('FOR UPDATE SKIP LOCKED')) {
          return Promise.resolve(
            rowMatchesAccessEndClaimPredicate(testState.persistedOffboardingRow)
              ? [snapshotClaimableRow(testState.persistedOffboardingRow)]
              : [],
          );
        }

        if (template.includes('UPDATE account_offboardings') && template.includes("status = 'tearing_down'")) {
          if (!rowMatchesAccessEndClaimPredicate(testState.persistedOffboardingRow)) {
            return Promise.resolve([]);
          }

          testState.persistedOffboardingRow = {
            ...testState.persistedOffboardingRow,
            status: 'tearing_down',
            teardown_started_at: new Date(),
            failed_step: null,
            last_error: null,
          };
          return Promise.resolve([snapshotClaimableRow(testState.persistedOffboardingRow)]);
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
    mockEnqueueAccountOffboardingTeardown: vi.fn(async () => 'outbox-1'),
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

vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueAccountOffboardingTeardown: mockEnqueueAccountOffboardingTeardown,
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

import {
  runAccountOffboardingAccessEndOnce,
  startAccountOffboardingAccessEndPoller,
  stopAccountOffboardingAccessEndPoller,
} from '../AccountOffboardingAccessEndPoller';

type ClaimableRow = {
  id: string;
  account_id: string;
  mode: 'cancel_only';
  status: 'scheduled' | 'tearing_down';
  access_ends_at: Date;
};

type PersistedOffboardingRow = ClaimableRow & {
  reactivation_claimed_at: Date | null;
  teardown_started_at: Date | null;
  terminal_at: Date | null;
  failed_step: string | null;
  last_error: string | null;
};

function makeClaimableRow(overrides: Partial<ClaimableRow> = {}): ClaimableRow {
  return {
    id: overrides.id ?? 'offboarding-1',
    account_id: overrides.account_id ?? 'account-1',
    mode: 'cancel_only',
    status: 'scheduled',
    access_ends_at: overrides.access_ends_at ?? new Date('2026-06-06T12:00:00.000Z'),
  };
}

function makePersistedOffboardingRow(
  overrides: Partial<PersistedOffboardingRow> = {},
): PersistedOffboardingRow {
  return {
    ...makeClaimableRow(overrides),
    reactivation_claimed_at: overrides.reactivation_claimed_at ?? null,
    teardown_started_at: overrides.teardown_started_at ?? null,
    terminal_at: overrides.terminal_at ?? null,
    failed_step: overrides.failed_step ?? 'billing',
    last_error: overrides.last_error ?? 'stale-error',
  };
}

function rowMatchesAccessEndClaimPredicate(row: PersistedOffboardingRow): boolean {
  return (
    row.mode === 'cancel_only' &&
    row.status === 'scheduled' &&
    row.access_ends_at.getTime() <= Date.now() &&
    row.reactivation_claimed_at === null &&
    row.teardown_started_at === null &&
    row.terminal_at === null
  );
}

function snapshotClaimableRow(row: PersistedOffboardingRow): ClaimableRow {
  return {
    id: row.id,
    account_id: row.account_id,
    mode: row.mode,
    status: row.status,
    access_ends_at: row.access_ends_at,
  };
}

function matchesReactivationPredicate(row: PersistedOffboardingRow): boolean {
  return (
    row.mode === 'cancel_only' &&
    row.status === 'scheduled' &&
    row.teardown_started_at === null &&
    row.terminal_at === null
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-06T13:00:00.000Z'));

  sqlQueue.length = 0;
  sqlCalls.length = 0;
  beginCalls.length = 0;
  testState.persistedOffboardingRow = null;
  mockSql.mockClear();
  mockTx.mockClear();
  mockSql.begin.mockClear();
  mockAccountOffboardingEnabled.mockReset();
  mockAccountOffboardingEnabled.mockReturnValue(true);
  mockWriteAccountAuditLog.mockClear();
  mockEnqueueAccountOffboardingTeardown.mockClear();
  mockLoggerLog.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
  delete process.env.ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS;
  delete process.env.ACCOUNT_OFFBOARDING_ACCESS_END_BATCH_SIZE;
});

afterEach(() => {
  stopAccountOffboardingAccessEndPoller();
  vi.useRealTimers();
});

describe('AccountOffboardingAccessEndPoller', () => {
  it('no-ops when account offboarding is disabled', async () => {
    mockAccountOffboardingEnabled.mockReturnValue(false);

    await runAccountOffboardingAccessEndOnce();
    startAccountOffboardingAccessEndPoller();
    await vi.runAllTimersAsync();

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingTeardown).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claims due cancel_only rows with FOR UPDATE SKIP LOCKED and enqueues teardown in the same transaction', async () => {
    const row = makeClaimableRow();
    sqlQueue.push([row]);
    sqlQueue.push([row]);
    sqlQueue.push([]);

    await runAccountOffboardingAccessEndOnce();

    const claimCall = sqlCalls.find((call) =>
      call.scope === 'tx' &&
      call.template.includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall!.template).toContain("status = 'scheduled'");
    expect(claimCall!.template).toContain('access_ends_at <= NOW()');
    expect(claimCall!.template).toContain('reactivation_claimed_at IS NULL');
    expect(claimCall!.template).toContain('teardown_started_at IS NULL');
    expect(claimCall!.template).toContain('terminal_at IS NULL');

    const updateCall = sqlCalls.find((call) =>
      call.scope === 'tx' &&
      call.template.includes('UPDATE account_offboardings') &&
      call.template.includes("status = 'tearing_down'"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.template).toContain('teardown_started_at = NOW()');
    expect(updateCall!.template).toContain('reactivation_claimed_at IS NULL');

    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: row.account_id,
        eventType: 'account_offboarding_teardown_started',
        entityType: 'account_offboarding',
        entityId: row.id,
        payload: expect.objectContaining({
          mode: 'cancel_only',
          status: 'tearing_down',
        }),
      }),
      mockTx,
    );

    expect(mockEnqueueAccountOffboardingTeardown).toHaveBeenCalledOnce();
    expect(mockEnqueueAccountOffboardingTeardown).toHaveBeenCalledWith(
      mockTx,
      {
        accountOffboardingId: row.id,
        accountId: row.account_id,
        correlationId: undefined,
      },
    );
  });

  it('pins the claim predicate against reactivated rows', async () => {
    sqlQueue.push([]);

    await runAccountOffboardingAccessEndOnce();

    const claimCall = sqlCalls.find((call) =>
      call.scope === 'tx' &&
      call.template.includes('FROM account_offboardings'),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall!.template).toContain('reactivation_claimed_at IS NULL');
    expect(claimCall!.template).toContain('teardown_started_at IS NULL');
    expect(claimCall!.template).toContain('terminal_at IS NULL');
  });

  it('reactivation race: excludes a scheduled row already claimed by reactivation via reactivation_claimed_at', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
      status: 'scheduled',
      reactivation_claimed_at: new Date('2026-06-06T12:59:00.000Z'),
      teardown_started_at: null,
      terminal_at: null,
    });

    await runAccountOffboardingAccessEndOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingTeardown).not.toHaveBeenCalled();
    expect(
      sqlCalls.some((call) =>
        call.scope === 'tx' &&
        call.template.includes('UPDATE account_offboardings') &&
        call.template.includes("status = 'tearing_down'"),
      ),
    ).toBe(false);
    expect(testState.persistedOffboardingRow?.status).toBe('scheduled');
    expect(testState.persistedOffboardingRow?.reactivation_claimed_at).not.toBeNull();
  });

  it('does not update, audit, or enqueue when revalidation loses the race', async () => {
    const row = makeClaimableRow();
    sqlQueue.push([row]);
    sqlQueue.push([]);
    sqlQueue.push([]);

    await runAccountOffboardingAccessEndOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingTeardown).not.toHaveBeenCalled();
    expect(mockLoggerLog).toHaveBeenCalledWith(
      'Skipped - state changed before teardown claim',
      { offboarding_id: row.id },
    );
  });

  it('teardown claim win persists state that makes the reactivation predicate false', async () => {
    testState.persistedOffboardingRow = makePersistedOffboardingRow({
      status: 'scheduled',
      reactivation_claimed_at: null,
      teardown_started_at: null,
      terminal_at: null,
    });

    await runAccountOffboardingAccessEndOnce();

    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
    expect(mockEnqueueAccountOffboardingTeardown).toHaveBeenCalledOnce();
    expect(testState.persistedOffboardingRow?.status).toBe('tearing_down');
    expect(testState.persistedOffboardingRow?.teardown_started_at).toBeInstanceOf(Date);
    expect(matchesReactivationPredicate(testState.persistedOffboardingRow!)).toBe(false);
  });

  it('starts only one timer and stop clears it', async () => {
    process.env.ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS = '250';
    sqlQueue.push([]);

    startAccountOffboardingAccessEndPoller();
    startAccountOffboardingAccessEndPoller();
    // Drain the initial cycle so its per-cycle withTimeout deadline timer (#414
    // guard) clears, leaving only the single interval timer under assertion.
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);

    stopAccountOffboardingAccessEndPoller();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hung cycle with the #414 deadline and resets so the next tick runs', async () => {
    // A cycle hung on a stale connection must not pin single-flight forever:
    // the withTimeout deadline trips, the flag releases, and the next tick runs.
    mockSql.begin.mockImplementationOnce(() => new Promise<never>(() => {})); // never settles
    sqlQueue.push([]); // recovery cycle: candidate query returns none

    const hung = runAccountOffboardingAccessEndOnce();
    await vi.advanceTimersByTimeAsync(45_000); // trip the cycle deadline
    await expect(hung).resolves.toBeUndefined();
    expect(mockLoggerError).toHaveBeenCalledWith('Poll cycle failed', expect.any(Error));

    await runAccountOffboardingAccessEndOnce();
    expect(mockSql.begin).toHaveBeenCalledTimes(2);
  });
});
