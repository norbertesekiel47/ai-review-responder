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

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

vi.mock('../../../src/lib/shared/mock-mode', () => ({
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
    const mod = await import('../OnboardingDripScheduler');
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

    // Single query returns due (business_id, drip_type) pairs
    sqlReturnQueue.push([{ business_id: 'biz-1', drip_type: 'day_1' }]);
    // INSERT into job_outbox — success
    sqlReturnQueue.push(Object.assign([], { count: 1 }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query + 1 INSERT = 2
    expect(mockSql).toHaveBeenCalledTimes(2);

    // Verify the INSERT call contains onboarding_drip
    const insertCall = mockSql.mock.calls[1];
    const insertText = Array.from(insertCall[0] as TemplateStringsArray).join('');
    expect(insertText).toContain('INSERT');
    expect(insertText).toContain('onboarding_drip');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Queued 1 onboarding_drip outbox entries'),
    );

    consoleSpy.mockRestore();
  });

  it('does NOT queue day_7 when only 3 days have passed', async () => {
    // Activated 3 days ago — day_1 already sent, day_7 and day_30 not due
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // Single query returns empty — day_1 has drip_log, day_7/day_30 not due
    sqlReturnQueue.push([]);

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query only, returns empty so no INSERTs
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('queues both day_1 and day_7 when 8 days have passed and neither sent', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // Single query returns both due drips
    sqlReturnQueue.push([
      { business_id: 'biz-1', drip_type: 'day_1' },
      { business_id: 'biz-1', drip_type: 'day_7' },
    ]);
    // day_1 INSERT
    sqlReturnQueue.push(Object.assign([], { count: 1 }));
    // day_7 INSERT
    sqlReturnQueue.push(Object.assign([], { count: 1 }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query + 2 INSERTs = 3
    expect(mockSql).toHaveBeenCalledTimes(3);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Queued 2 onboarding_drip outbox entries'),
    );

    consoleSpy.mockRestore();
  });

  it('skips when drip_log entry already exists', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // Single query excludes drips with existing drip_log via NOT EXISTS — returns empty
    sqlReturnQueue.push([]);

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query only, returns empty so no INSERTs
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('skips when outbox entry already pending', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // Single query excludes drips with pending outbox via NOT EXISTS — returns empty
    sqlReturnQueue.push([]);

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query only, returns empty so no INSERTs
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('handles 23505 unique constraint gracefully', async () => {
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // Single query returns one due drip
    sqlReturnQueue.push([{ business_id: 'biz-1', drip_type: 'day_1' }]);

    // Override mockSql for the INSERT to throw 23505
    // First call uses queue (main query), 2nd throws
    mockSql
      .mockImplementationOnce(() => Promise.resolve(sqlReturnQueue.shift()))
      .mockImplementationOnce(() => Promise.reject({ code: '23505' }));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../OnboardingDripScheduler');
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
      const mod = await import('../OnboardingDripScheduler');
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
      const mod = await import('../OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=120000ms'),
      );
      mod.stopOnboardingDripScheduler();
      consoleSpy.mockRestore();
    });

    it('stopOnboardingDripScheduler clears the interval', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      mod.stopOnboardingDripScheduler();
      expect(consoleSpy).toHaveBeenCalledWith('[OnboardingDripScheduler] Stopped');
      consoleSpy.mockRestore();
    });

    it('double-start is prevented', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../OnboardingDripScheduler');
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
      const mod = await import('../OnboardingDripScheduler');
      mod.stopOnboardingDripScheduler(); // should not throw
    });
  });
});
