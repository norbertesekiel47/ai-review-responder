// Emitter contract for the sustained-truncation alert sink. Mirrors the
// drift-alert emitter tests: Sentry warning + feature tag when SENTRY_DSN is set,
// a warn-level structured log line otherwise. The structured logger is NOT mocked
// — the fallback contract is "one JSON line via console.warn", so the console spy
// asserts the real emitted line.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));

// Mock Sentry — the emitter checks getWorkerConfig().SENTRY_DSN to decide whether
// to call Sentry or fall back to a warn-level structured log.
vi.mock('../../../../worker/sentry', () => ({
  Sentry: {
    init: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureMessage: mockCaptureMessage,
    captureException: vi.fn(),
  },
}));

import { emitTruncationAlert } from '../billing-reconciliation/truncation-alert';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

const input = {
  pollerName: 'stripe_locations_reconcile',
  consecutive: 3,
  dispatched: 12,
  total: 100,
  cycleDeadlineMs: 240_000,
};

describe('emitTruncationAlert', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SENTRY_DSN;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetWorkerConfigForTests();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.SENTRY_DSN;
    resetWorkerConfigForTests();
  });

  it('emits a warning-level Sentry event tagged feature:stripe_reconciliation when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';
    resetWorkerConfigForTests();

    emitTruncationAlert(input);

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('Sustained reconcile truncation'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          feature: 'stripe_reconciliation',
          poller: 'stripe_locations_reconcile',
          alert: 'sustained_truncation',
        }),
        extra: expect.objectContaining({
          consecutiveTruncations: 3,
          dispatched: 12,
          total: 100,
          cycleDeadlineMs: 240_000,
        }),
      }),
    );
    // Sentry path must not also emit the fallback log line.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to a warn-level structured log line when SENTRY_DSN is unset', () => {
    emitTruncationAlert(input);

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const record = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(record.level).toBe('warn');
    expect(record.logger).toBe('StripeLocationsReconcilePoller');
    expect(record.message).toContain('Sustained reconcile truncation');
    expect(record.data.consecutive_truncations).toBe(3);
    expect(record.data.dispatched).toBe(12);
    expect(record.data.total).toBe(100);
    expect(record.data.cycle_deadline_ms).toBe(240_000);
  });
});
