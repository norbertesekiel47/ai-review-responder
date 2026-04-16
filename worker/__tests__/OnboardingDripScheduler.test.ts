import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const { sqlReturnQueue, mockSql, mockIsMockMode } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    if (Array.isArray(result) && !('count' in result)) {
      (result as any).count = result.length > 0 ? 1 : 0;
    }
    return Promise.resolve(result);
  });

  const mockIsMockMode = vi.fn(() => false);

  return { sqlReturnQueue, mockSql, mockIsMockMode };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

vi.mock('../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));

describe('OnboardingDripScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    vi.resetModules();
    mockIsMockMode.mockReturnValue(false);
    delete process.env.ONBOARDING_DRIP_INTERVAL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips in mock mode (sql not called)', async () => {
    mockIsMockMode.mockReturnValue(true);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[OnboardingDripScheduler] Mock mode — skipping',
    );
    expect(mockSql).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('queues day_1 when 2 days have passed and no drip_log/outbox entry exists', async () => {
    // Activated 2 days ago
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);
    const activatedAt = new Date('2026-04-14T12:00:00Z').toISOString();

    // Business query returns one business
    sqlReturnQueue.push([{ id: 'biz-1', subscription_activated_at: activatedAt }]);
    // day_1 drip_log check — not sent
    sqlReturnQueue.push([]);
    // day_1 outbox check — not queued
    sqlReturnQueue.push([]);
    // day_1 INSERT — success
    sqlReturnQueue.push(Object.assign([], { count: 1 }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 business query + (drip_log + outbox + INSERT) for day_1 = 4
    // day_7 not due (2 < 7), day_30 not due (2 < 30) — skipped before any SQL
    expect(mockSql).toHaveBeenCalledTimes(4);

    // Verify the INSERT call contains onboarding_drip
    const insertCall = mockSql.mock.calls[3];
    const insertText = Array.from(insertCall[0] as TemplateStringsArray).join('');
    expect(insertText).toContain('INSERT');
    expect(insertText).toContain('onboarding_drip');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Queued 1 onboarding_drip outbox entries'),
    );

    consoleSpy.mockRestore();
  });

  it('does NOT queue day_7 when only 3 days have passed', async () => {
    // Activated 3 days ago — day_1 is due, day_7 and day_30 are not
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);
    const activatedAt = new Date('2026-04-13T12:00:00Z').toISOString();

    // Business query
    sqlReturnQueue.push([{ id: 'biz-1', subscription_activated_at: activatedAt }]);
    // day_1 drip_log — already sent
    sqlReturnQueue.push([{ id: 'log-1' }]);
    // day_7 and day_30 are not due, so no further SQL calls

    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 business query + 1 drip_log check for day_1 = 2
    // day_7 (3 < 7) and day_30 (3 < 30) skipped by time check
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('queues both day_1 and day_7 when 8 days have passed and neither sent', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);
    const activatedAt = new Date('2026-04-08T12:00:00Z').toISOString();

    // Business query
    sqlReturnQueue.push([{ id: 'biz-1', subscription_activated_at: activatedAt }]);
    // day_1 drip_log — not sent
    sqlReturnQueue.push([]);
    // day_1 outbox — not queued
    sqlReturnQueue.push([]);
    // day_1 INSERT
    sqlReturnQueue.push(Object.assign([], { count: 1 }));
    // day_7 drip_log — not sent
    sqlReturnQueue.push([]);
    // day_7 outbox — not queued
    sqlReturnQueue.push([]);
    // day_7 INSERT
    sqlReturnQueue.push(Object.assign([], { count: 1 }));
    // day_30 not due (8 < 30) — skipped

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 business + 3 per drip * 2 drips = 7
    expect(mockSql).toHaveBeenCalledTimes(7);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Queued 2 onboarding_drip outbox entries'),
    );

    consoleSpy.mockRestore();
  });

  it('skips when drip_log entry already exists', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);
    const activatedAt = new Date('2026-04-14T12:00:00Z').toISOString();

    // Business query
    sqlReturnQueue.push([{ id: 'biz-1', subscription_activated_at: activatedAt }]);
    // day_1 drip_log — already sent (row exists)
    sqlReturnQueue.push([{ id: 'existing-log' }]);
    // day_7 and day_30 not due — no further calls

    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 business query + 1 drip_log check = 2 (no outbox check, no INSERT)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('skips when outbox entry already pending', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);
    const activatedAt = new Date('2026-04-14T12:00:00Z').toISOString();

    // Business query
    sqlReturnQueue.push([{ id: 'biz-1', subscription_activated_at: activatedAt }]);
    // day_1 drip_log — not sent
    sqlReturnQueue.push([]);
    // day_1 outbox — already queued (row exists)
    sqlReturnQueue.push([{ id: 'pending-outbox' }]);
    // day_7 and day_30 not due — no further calls

    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 business query + 1 drip_log + 1 outbox = 3 (no INSERT)
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('handles 23505 unique constraint gracefully', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);
    const activatedAt = new Date('2026-04-14T12:00:00Z').toISOString();

    // Business query
    sqlReturnQueue.push([{ id: 'biz-1', subscription_activated_at: activatedAt }]);
    // day_1 drip_log — not sent
    sqlReturnQueue.push([]);
    // day_1 outbox — not queued
    sqlReturnQueue.push([]);

    // Override mockSql for the INSERT to throw 23505
    // First 3 calls use queue, 4th throws
    mockSql
      .mockImplementationOnce(() => Promise.resolve(sqlReturnQueue.shift()))
      .mockImplementationOnce(() => Promise.resolve(sqlReturnQueue.shift()))
      .mockImplementationOnce(() => Promise.resolve(sqlReturnQueue.shift()))
      .mockImplementationOnce(() => Promise.reject({ code: '23505' }));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../jobs/OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // Should NOT have logged a fatal error
    const fatalErrors = consoleErrorSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Scheduler cycle failed'),
    );
    expect(fatalErrors).toHaveLength(0);

    // Should also not have logged a per-business error (23505 is silently continued)
    const bizErrors = consoleErrorSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Failed to queue'),
    );
    expect(bizErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  describe('lifecycle', () => {
    it('uses default 3_600_000ms interval when env not set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../jobs/OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=3600000ms'),
      );
      mod.stopOnboardingDripScheduler();
      consoleSpy.mockRestore();
    });

    it('uses custom interval from env', async () => {
      process.env.ONBOARDING_DRIP_INTERVAL_MS = '120000';
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../jobs/OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=120000ms'),
      );
      mod.stopOnboardingDripScheduler();
      consoleSpy.mockRestore();
    });

    it('stopOnboardingDripScheduler clears the interval', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../jobs/OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      mod.stopOnboardingDripScheduler();
      expect(consoleSpy).toHaveBeenCalledWith('[OnboardingDripScheduler] Stopped');
      consoleSpy.mockRestore();
    });

    it('double-start is prevented', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../jobs/OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      mod.startOnboardingDripScheduler(); // second call
      // Only one "Starting" log
      const startLogs = consoleSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('Starting'),
      );
      expect(startLogs).toHaveLength(1);
      mod.stopOnboardingDripScheduler();
      consoleSpy.mockRestore();
    });

    it('stopOnboardingDripScheduler is safe to call when not started', async () => {
      const mod = await import('../jobs/OnboardingDripScheduler');
      mod.stopOnboardingDripScheduler(); // should not throw
    });
  });
});
