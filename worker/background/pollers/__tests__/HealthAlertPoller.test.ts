import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRunHealthChecks,
  mockEmitHealthFindings,
  mockRecordProbeCheckIn,
  mockNotePollerActivity,
  mockMaybeLogPollerHeartbeat,
} = vi.hoisted(() => ({
  mockRunHealthChecks: vi.fn(),
  mockEmitHealthFindings: vi.fn(),
  mockRecordProbeCheckIn: vi.fn(),
  mockNotePollerActivity: vi.fn(),
  mockMaybeLogPollerHeartbeat: vi.fn(),
}));

vi.mock('../health-alert/checks', () => ({ runHealthChecks: mockRunHealthChecks }));
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

import { pollHealthAlerts } from '../HealthAlertPoller';

const FINDING = { key: 'zero_delivery_notifications', level: 'error' as const, title: 't', detail: {} };

describe('pollHealthAlerts', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
