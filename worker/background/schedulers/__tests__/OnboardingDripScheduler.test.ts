import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionStatus } from '../../../../src/lib/shared/subscription-status';

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

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

vi.mock('../../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  toError: (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
  logUnhandledPollError: () => () => {},
  createWorkerLogger: () => mockLogger,
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

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    expect(mockLogger.log).toHaveBeenCalledWith('Mock mode — skipping');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('queues day_1 when 2 days have passed and no drip_log/outbox entry exists', async () => {
    // Activated 2 days ago
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // Single query returns due (business_id, drip_type) pairs
    sqlReturnQueue.push([{ business_id: 'biz-1', drip_type: 'day_1' }]);
    // INSERT into job_outbox — success
    sqlReturnQueue.push(Object.assign([], { count: 1 }));

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query + 1 INSERT = 2
    expect(mockSql).toHaveBeenCalledTimes(2);

    // Verify the INSERT call contains onboarding_drip. Topic is an
    // interpolated QUEUE_NAMES value, not a template literal — check the
    // bound values, not the raw strings array.
    const insertCall = mockSql.mock.calls[1];
    const insertText = Array.from(insertCall[0] as TemplateStringsArray).join('');
    expect(insertText).toContain('INSERT');
    expect(insertCall.slice(1)).toContain('onboarding_drip');

    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Queued 1 onboarding_drip outbox entries'));
  });

  it('FIX 1: selects trialing accounts whose businesses.subscription_activated_at is set (and gates on the anchor)', async () => {
    // The due-drips query is the gate: a trialing account with the businesses
    // anchor set must be eligible for drip scheduling. Pin the query shape — the
    // scheduler selects status IN (active, trialing) AND the businesses anchor is
    // non-null — so a trialing account with a set anchor is selected and a null
    // anchor is excluded.
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    // The mock returns whatever the query "found" — here, a due trialing biz.
    sqlReturnQueue.push([{ business_id: 'trial-biz-1', drip_type: 'day_1' }]);
    sqlReturnQueue.push(Object.assign([], { count: 1 }));

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    const dueQueryCall = mockSql.mock.calls[0]!;
    const dueQueryText = Array.from(dueQueryCall[0] as TemplateStringsArray).join('');
    // Trialing accounts are in scope alongside active (invariant #11). Since #719
    // these are BOUND from the SubscriptionStatus enum rather than spelled as SQL
    // literals, so the check reads the bound values: the template text alone now
    // renders as `IN (, )` and a text-only regex would either fail spuriously or,
    // if loosened to match the bare `IN (`, pass against an empty status set.
    expect(dueQueryText).toMatch(/subscription_status\s+IN\s*\(/i);
    expect(dueQueryCall.slice(1)).toEqual(
      expect.arrayContaining([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING]),
    );
    // The businesses-mirror anchor (FIX 1) is the gate — null anchor is excluded.
    expect(dueQueryText).toMatch(/b\.subscription_activated_at\s+IS\s+NOT\s+NULL/i);

    // A trialing account WITH a set anchor was selected → it gets queued.
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Queued 1 onboarding_drip outbox entries'),
    );
  });

  it('FIX 1: a trialing account with a NULL businesses anchor is NOT scheduled', async () => {
    // The query's `b.subscription_activated_at IS NOT NULL` predicate means a
    // trialing account whose anchor never got mirrored returns no rows → nothing
    // queued. Model the empty result the predicate produces.
    const now = new Date('2026-04-16T12:00:00Z');
    vi.setSystemTime(now);

    sqlReturnQueue.push([]); // anchor null → predicate excludes it

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // Only the due-drips query ran; no INSERTs because nothing was due.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockLogger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Queued'),
    );
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

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // 1 main query + 2 INSERTs = 3
    expect(mockSql).toHaveBeenCalledTimes(3);

    expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Queued 2 onboarding_drip outbox entries'));
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

    const mod = await import('../OnboardingDripScheduler');
    await mod.checkAndSchedule();

    // Should NOT have logged a fatal error
    const fatalErrors = mockLogger.error.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Scheduler cycle failed'),
    );
    expect(fatalErrors).toHaveLength(0);

    // Should also not have logged a per-business error (23505 is silently continued)
    const bizErrors = mockLogger.error.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Failed to queue'),
    );
    expect(bizErrors).toHaveLength(0);
  });

  describe('lifecycle', () => {
    it('uses default 3_600_000ms interval when env not set', async () => {
      const mod = await import('../OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('interval=3600000ms'));
      mod.stopOnboardingDripScheduler();
    });

    it('uses custom interval from env', async () => {
      process.env.ONBOARDING_DRIP_INTERVAL_MS = '120000';
      const mod = await import('../OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('interval=120000ms'));
      mod.stopOnboardingDripScheduler();
    });

    it('stopOnboardingDripScheduler clears the interval', async () => {
      const mod = await import('../OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      mod.stopOnboardingDripScheduler();
      expect(mockLogger.log).toHaveBeenCalledWith('Stopped');
    });

    it('double-start is prevented', async () => {
      const mod = await import('../OnboardingDripScheduler');
      mod.startOnboardingDripScheduler();
      mod.startOnboardingDripScheduler(); // second call
      // Only one "Starting" log
      const startLogs = mockLogger.log.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('Starting'),
      );
      expect(startLogs).toHaveLength(1);
      mod.stopOnboardingDripScheduler();
    });

    it('stopOnboardingDripScheduler is safe to call when not started', async () => {
      const mod = await import('../OnboardingDripScheduler');
      mod.stopOnboardingDripScheduler(); // should not throw
    });
  });
});
