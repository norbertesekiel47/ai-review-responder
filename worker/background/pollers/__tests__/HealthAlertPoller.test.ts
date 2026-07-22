import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRunHealthChecks,
  mockEmitHealthFindings,
  mockRecordProbeCheckIn,
  mockNotePollerActivity,
  mockMaybeLogPollerHeartbeat,
  mockGetHealthSql,
  mockRecycleHealthSql,
} = vi.hoisted(() => ({
  mockRunHealthChecks: vi.fn(),
  mockEmitHealthFindings: vi.fn(),
  mockRecordProbeCheckIn: vi.fn(),
  mockNotePollerActivity: vi.fn(),
  mockMaybeLogPollerHeartbeat: vi.fn(),
  mockGetHealthSql: vi.fn(),
  mockRecycleHealthSql: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../health-alert/checks', () => ({ runHealthChecks: mockRunHealthChecks }));
vi.mock('../health-alert/health-db', () => ({
  getHealthSql: mockGetHealthSql,
  recycleHealthSql: mockRecycleHealthSql,
  closeHealthSql: vi.fn(),
}));
vi.mock('../health-alert/emit', () => ({
  emitHealthFindings: mockEmitHealthFindings,
  recordProbeCheckIn: mockRecordProbeCheckIn,
}));
vi.mock('../../poller-heartbeat', () => ({
  notePollerActivity: mockNotePollerActivity,
  maybeLogPollerHeartbeat: mockMaybeLogPollerHeartbeat,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logUnhandledPollError: () => vi.fn(),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// The dedicated bulkhead client stand-in the poller runs checks against. Distinct
// object identities per cycle let us prove the poller re-fetches (uses the fresh
// client) after a recycle. It NEVER touches the shared `sql` singleton — the
// poller no longer imports it, and getHealthSql is the only client source.
const CLIENT_A = { id: 'health-client-A' };
const CLIENT_B = { id: 'health-client-B' };

import { pollHealthAlerts } from '../HealthAlertPoller';

const FINDING = { key: 'zero_delivery_notifications', level: 'error' as const, title: 't', detail: {} };

describe('pollHealthAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHealthSql.mockReturnValue(CLIENT_A);
  });

  it('emits findings and records an ok check-in when problems are found', async () => {
    mockRunHealthChecks.mockResolvedValueOnce([FINDING]);
    await pollHealthAlerts();
    expect(mockEmitHealthFindings).toHaveBeenCalledWith([FINDING]);
    expect(mockRecordProbeCheckIn).toHaveBeenCalledWith('ok', expect.any(Number));
  });

  it('records an ok check-in and logs idle heartbeat when healthy (no emit)', async () => {
    mockRunHealthChecks.mockResolvedValueOnce([]);
    await pollHealthAlerts();
    expect(mockEmitHealthFindings).not.toHaveBeenCalled();
    expect(mockMaybeLogPollerHeartbeat).toHaveBeenCalled();
    expect(mockRecordProbeCheckIn).toHaveBeenCalledWith('ok', expect.any(Number));
  });

  it('records an error check-in and does not throw when a check fails', async () => {
    mockRunHealthChecks.mockRejectedValueOnce(new Error('db down'));
    await expect(pollHealthAlerts()).resolves.toBeUndefined();
    expect(mockRecordProbeCheckIn).toHaveBeenCalledWith('error', expect.any(Number));
  });

  // Isolation (#500 bulkhead): checks run on the dedicated health client obtained
  // from getHealthSql(), never on the shared `sql` singleton — a wedged health
  // connection must not starve the other loops.
  it('runs the checks on the dedicated health client, not the shared sql singleton', async () => {
    mockRunHealthChecks.mockResolvedValueOnce([]);
    await pollHealthAlerts();
    expect(mockGetHealthSql).toHaveBeenCalledTimes(1);
    expect(mockRunHealthChecks).toHaveBeenCalledWith(CLIENT_A);
  });

  // A non-timeout DB error must NOT recycle the client (the socket is not wedged),
  // but must still record the 'error' check-in.
  it('does not recycle the client on an ordinary (non-timeout) DB error', async () => {
    mockRunHealthChecks.mockRejectedValueOnce(new Error('db down'));
    await pollHealthAlerts();
    expect(mockRecycleHealthSql).not.toHaveBeenCalled();
    expect(mockRecordProbeCheckIn).toHaveBeenCalledWith('error', expect.any(Number));
  });

  // Regression: a hung runHealthChecks (stale pooled connection where server-side
  // statement_timeout never fires) used to wedge the single-flight poller forever
  // — no check-in ever sent. The withTimeout bound must trip and fall to the catch.
  it('bounds a hung runHealthChecks instead of wedging, and records an error check-in', async () => {
    vi.useFakeTimers();
    try {
      mockRunHealthChecks.mockReturnValueOnce(new Promise(() => {})); // never settles
      const cycle = pollHealthAlerts();
      await vi.advanceTimersByTimeAsync(30_000); // trip the withTimeout deadline
      await expect(cycle).resolves.toBeUndefined();
      expect(mockRecordProbeCheckIn).toHaveBeenCalledWith('error', expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  // Self-heal (#500): on the withTimeout expiry the dedicated client is recycled
  // (end+rebuild) and the NEXT cycle runs on the fresh client. Single-flight is
  // preserved and the catch still records an 'error' check-in.
  it('recycles the client on withTimeout expiry and the next cycle uses the fresh client', async () => {
    vi.useFakeTimers();
    try {
      // Cycle 1: hung → TimeoutError → recycle. Cycle 2: getHealthSql returns the
      // rebuilt client (CLIENT_B), proving the poller re-fetches after recycle.
      mockGetHealthSql.mockReturnValueOnce(CLIENT_A).mockReturnValue(CLIENT_B);
      mockRunHealthChecks.mockReturnValueOnce(new Promise(() => {})); // cycle 1 hangs
      const cycle1 = pollHealthAlerts();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(cycle1).resolves.toBeUndefined();

      expect(mockRunHealthChecks).toHaveBeenNthCalledWith(1, CLIENT_A);
      expect(mockRecycleHealthSql).toHaveBeenCalledTimes(1);
      expect(mockRecordProbeCheckIn).toHaveBeenLastCalledWith('error', expect.any(Number));

      mockRunHealthChecks.mockResolvedValueOnce([]);
      await pollHealthAlerts(); // cycle 2 — single-flight already released
      expect(mockRunHealthChecks).toHaveBeenNthCalledWith(2, CLIENT_B);
    } finally {
      vi.useRealTimers();
    }
  });
});
