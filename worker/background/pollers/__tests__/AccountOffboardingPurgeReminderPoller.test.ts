import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sqlQueue,
  sqlCalls,
  mockAccountOffboardingEnabled,
  mockWriteAccountAuditLog,
  mockEnqueueAccountOffboardingEmail,
  mockLoggerLog,
  mockLoggerError,
  mockSql,
  mockTx,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ scope: 'sql' | 'tx'; template: string; values: unknown[] }> = [];

  const consume = (scope: 'sql' | 'tx') =>
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ scope, template: strings.join('?'), values });
      return Promise.resolve(sqlQueue.shift() ?? []);
    });

  const mockSql = consume('sql') as ReturnType<typeof consume> & { begin: ReturnType<typeof vi.fn> };
  const mockTx = consume('tx');
  mockSql.begin = vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));

  return {
    sqlQueue,
    sqlCalls,
    mockAccountOffboardingEnabled: vi.fn(() => true),
    mockWriteAccountAuditLog: vi.fn(async () => undefined),
    mockEnqueueAccountOffboardingEmail: vi.fn(async () => 'outbox-reminder-1'),
    mockLoggerLog: vi.fn(),
    mockLoggerError: vi.fn(),
    mockSql,
    mockTx,
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/account-offboarding/flags', () => ({
  accountOffboardingEnabled: mockAccountOffboardingEnabled,
}));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueAccountOffboardingEmail: mockEnqueueAccountOffboardingEmail,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  toError: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
  logUnhandledPollError: () => () => {},
  createWorkerLogger: () => ({ log: mockLoggerLog, warn: vi.fn(), error: mockLoggerError }),
}));

import {
  runAccountOffboardingPurgeReminderOnce,
  startAccountOffboardingPurgeReminderPoller,
  stopAccountOffboardingPurgeReminderPoller,
} from '../AccountOffboardingPurgeReminderPoller';

const ROW = {
  id: 'offboarding-1',
  account_id: 'account-1',
  mode: 'delete_data' as const,
  status: 'purge_scheduled' as const,
  purge_after: new Date('2026-06-08T00:00:00.000Z'),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-06T13:00:00.000Z'));
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  mockSql.mockClear();
  mockTx.mockClear();
  mockSql.begin.mockClear();
  mockAccountOffboardingEnabled.mockReset();
  mockAccountOffboardingEnabled.mockReturnValue(true);
  mockWriteAccountAuditLog.mockClear();
  mockEnqueueAccountOffboardingEmail.mockClear();
  mockLoggerLog.mockClear();
  delete process.env.ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS;
  delete process.env.ACCOUNT_OFFBOARDING_PURGE_REMINDER_BATCH_SIZE;
});

afterEach(() => {
  stopAccountOffboardingPurgeReminderPoller();
  vi.useRealTimers();
});

describe('AccountOffboardingPurgeReminderPoller', () => {
  it('no-ops when account offboarding is disabled', async () => {
    mockAccountOffboardingEnabled.mockReturnValue(false);

    await runAccountOffboardingPurgeReminderOnce();
    startAccountOffboardingPurgeReminderPoller();
    await vi.runAllTimersAsync();

    expect(mockSql.begin).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingEmail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claims a due-soon delete_data row, stamps the reminder marker, and enqueues the reminder email in one tx', async () => {
    sqlQueue.push([ROW]);
    sqlQueue.push([ROW]);
    sqlQueue.push([]);

    await runAccountOffboardingPurgeReminderOnce();

    const claimCall = sqlCalls.find(
      (call) => call.scope === 'tx' && call.template.includes('FOR UPDATE SKIP LOCKED'),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall!.template).toContain("mode = 'delete_data'");
    expect(claimCall!.template).toContain("status = 'purge_scheduled'");
    expect(claimCall!.template).toContain('purge_after > NOW()');
    expect(claimCall!.template).toContain("INTERVAL '1 day'");
    expect(claimCall!.template).toContain('purge_reminder_sent_at IS NULL');
    expect(claimCall!.template).toContain('purge_started_at IS NULL');
    expect(claimCall!.template).toContain('purge_cancelled_at IS NULL');
    expect(claimCall!.template).toContain('terminal_at IS NULL');

    const updateCall = sqlCalls.find(
      (call) => call.scope === 'tx'
        && call.template.includes('UPDATE account_offboardings')
        && call.template.includes('purge_reminder_sent_at = NOW()'),
    );
    expect(updateCall).toBeDefined();

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ROW.account_id,
        eventType: 'account_offboarding_purge_reminder_sent',
        entityType: 'account_offboarding',
        entityId: ROW.id,
      }),
      mockTx,
    );

    expect(mockEnqueueAccountOffboardingEmail).toHaveBeenCalledWith(mockTx, {
      accountOffboardingId: ROW.id,
      accountId: ROW.account_id,
      emailType: 'delete_data_purge_reminder',
    });
  });

  it('skips without audit/enqueue when the claim loses the race', async () => {
    sqlQueue.push([ROW]); // candidate
    sqlQueue.push([]); // claim update returns nothing

    await runAccountOffboardingPurgeReminderOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueAccountOffboardingEmail).not.toHaveBeenCalled();
    expect(mockLoggerLog).toHaveBeenCalledWith('Skipped - state changed before reminder claim', {
      offboarding_id: ROW.id,
    });
  });

  it('starts only one timer and stop clears it', async () => {
    process.env.ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS = '250';
    sqlQueue.push([]);

    startAccountOffboardingPurgeReminderPoller();
    startAccountOffboardingPurgeReminderPoller();
    // Drain the initial cycle so its per-cycle withTimeout deadline timer (#414
    // guard) clears, leaving only the single interval timer under assertion.
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);

    stopAccountOffboardingPurgeReminderPoller();
    expect(vi.getTimerCount()).toBe(0);
  });
});
