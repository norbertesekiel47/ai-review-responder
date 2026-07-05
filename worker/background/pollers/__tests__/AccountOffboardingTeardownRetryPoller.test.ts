import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  mockWriteAccountAuditLog,
  mockEnqueueTeardown,
  mockAccountOffboardingEnabled,
  mockLoggerLog,
  mockLoggerError,
} = vi.hoisted(() => {
  const mockSql: any = vi.fn();
  mockSql.begin = vi.fn();
  return {
    mockSql,
    mockWriteAccountAuditLog: vi.fn(),
    mockEnqueueTeardown: vi.fn(),
    mockAccountOffboardingEnabled: vi.fn(() => true),
    mockLoggerLog: vi.fn(),
    mockLoggerError: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../../../../src/lib/account-offboarding/flags', () => ({
  accountOffboardingEnabled: mockAccountOffboardingEnabled,
}));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueAccountOffboardingTeardown: mockEnqueueTeardown,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  toError: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
  logUnhandledPollError: () => () => {},
  createWorkerLogger: () => ({ log: mockLoggerLog, error: mockLoggerError }),
}));

import { runAccountOffboardingTeardownRetryOnce } from '../AccountOffboardingTeardownRetryPoller';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OFFBOARDING_ID = '22222222-2222-4222-8222-222222222222';

interface TxCall { text: string; values: unknown[] }

function setup(options: { candidate?: Record<string, unknown> | null; claimWins?: boolean } = {}) {
  const candidate = options.candidate === undefined
    ? { id: OFFBOARDING_ID, account_id: ACCOUNT_ID, mode: 'cancel_only' }
    : options.candidate;
  const candidateQueue: Array<unknown[]> = candidate ? [[candidate]] : [[]];
  const txCalls: TxCall[] = [];

  mockSql.begin.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
    const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      txCalls.push({ text, values });
      if (text.includes('FOR UPDATE SKIP LOCKED')) {
        return Promise.resolve(candidateQueue.shift() ?? []);
      }
      if (text.includes("SET status = 'tearing_down'")) {
        return Promise.resolve(options.claimWins === false ? [] : [{ id: OFFBOARDING_ID }]);
      }
      return Promise.resolve([]);
    });
    return cb(tx);
  });

  return { txCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.begin.mockReset();
  mockAccountOffboardingEnabled.mockReturnValue(true);
  mockWriteAccountAuditLog.mockResolvedValue(undefined);
  mockEnqueueTeardown.mockResolvedValue(undefined);
});

describe('AccountOffboardingTeardownRetryPoller', () => {
  it('re-drives a failed teardown back to tearing_down, audits, and re-enqueues teardown', async () => {
    const { txCalls } = setup();

    await runAccountOffboardingTeardownRetryOnce();

    const candidateCall = txCalls.find((call) => call.text.includes('FOR UPDATE SKIP LOCKED'));
    expect(candidateCall!.text).toContain("status = 'failed'");
    expect(candidateCall!.text).toContain("failed_step = 'teardown'");
    expect(candidateCall!.text).toContain('terminal_at IS NULL');
    expect(candidateCall!.text).toContain('retry_count <');
    expect(candidateCall!.text).toContain('make_interval');

    const claimCall = txCalls.find((call) => call.text.includes("SET status = 'tearing_down'"));
    expect(claimCall!.text).toContain('failed_step = NULL');
    expect(claimCall!.text).toContain('retry_count <');

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        eventType: 'account_offboarding_teardown_retry_scheduled',
        entityId: OFFBOARDING_ID,
      }),
    );
    expect(mockEnqueueTeardown).toHaveBeenCalledWith(
      expect.anything(),
      { accountOffboardingId: OFFBOARDING_ID, accountId: ACCOUNT_ID },
    );
  });

  it('does not audit or enqueue when the claim loses the race', async () => {
    setup({ claimWins: false });

    await runAccountOffboardingTeardownRetryOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueTeardown).not.toHaveBeenCalled();
  });

  it('does nothing when no failed teardown is eligible', async () => {
    setup({ candidate: null });

    await runAccountOffboardingTeardownRetryOnce();

    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueTeardown).not.toHaveBeenCalled();
  });

  it('is a no-op when the feature flag is off', async () => {
    mockAccountOffboardingEnabled.mockReturnValue(false);
    setup();

    await runAccountOffboardingTeardownRetryOnce();

    expect(mockSql.begin).not.toHaveBeenCalled();
  });
});
