import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCaptureMessage, mockCaptureCheckIn } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
  mockCaptureCheckIn: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureCheckIn: mockCaptureCheckIn,
}));

import { emitHealthFindings, recordProbeCheckIn } from '../emit';
import type { HealthFinding } from '../checks';

const FINDING: HealthFinding = {
  key: 'zero_delivery_notifications',
  level: 'error',
  title: 'owners not told',
  detail: { count: 1 },
};

describe('emit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('captures one Sentry message per finding, tagged for routing', () => {
    emitHealthFindings([FINDING, { ...FINDING, key: 'flagged_open_backlog', level: 'warning' }]);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    const [title, opts] = mockCaptureMessage.mock.calls[0] as [string, any];
    expect(title).toBe('owners not told');
    expect(opts.level).toBe('error');
    expect(opts.tags).toMatchObject({ subsystem: 'health_alert', finding: 'zero_delivery_notifications' });
    expect(opts.extra).toEqual({ count: 1 });
  });

  it('does nothing when there are no findings', () => {
    emitHealthFindings([]);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('records a Sentry cron check-in with an upsert monitor config (dead-man heartbeat)', () => {
    recordProbeCheckIn('ok', 300_000);
    expect(mockCaptureCheckIn).toHaveBeenCalledTimes(1);
    const [arg, config] = mockCaptureCheckIn.mock.calls[0] as [
      { monitorSlug: string; status: string },
      { schedule?: { type: string; value: number; unit: string }; checkinMargin?: number },
    ];
    expect(arg.status).toBe('ok');
    expect(typeof arg.monitorSlug).toBe('string');
    expect(arg.monitorSlug.length).toBeGreaterThan(0);
    // Upsert config must be present, or Sentry drops the check-in for a non-existent monitor.
    expect(config?.schedule).toMatchObject({ type: 'interval', value: 5, unit: 'minute' });
  });

  it('forwards an error status check-in', () => {
    recordProbeCheckIn('error', 300_000);
    const arg = mockCaptureCheckIn.mock.calls[0]?.[0] as { status: string };
    expect(arg.status).toBe('error');
  });
});
