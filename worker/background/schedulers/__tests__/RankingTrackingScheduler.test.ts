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

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

vi.mock('../../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));

describe('RankingTrackingScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    vi.resetModules();
    mockIsMockMode.mockReturnValue(false);
    delete process.env.RANKING_TRACKING_ENABLED;
    delete process.env.RANKING_TRACKING_INTERVAL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips silently when RANKING_TRACKING_ENABLED is not "true"', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'false';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    // No SQL calls, no log output (silent)
    expect(mockSql).not.toHaveBeenCalled();
    const rankingLogs = consoleSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('RankingTrackingScheduler'),
    );
    expect(rankingLogs).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  it('skips silently when RANKING_TRACKING_ENABLED env var is missing', async () => {
    // env var already deleted in beforeEach
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    expect(mockSql).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('skips in mock mode', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';
    mockIsMockMode.mockReturnValue(true);

    // Set time to an even-week Sunday at 22 UTC so we pass the time gate
    vi.setSystemTime(new Date('2026-01-04T22:30:00Z')); // Sunday, week 1 — but mock mode takes priority

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    // Structured logger emits one JSON line per call via console.log.
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"message":"Mock mode — skipping"'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"logger":"RankingTrackingScheduler"'),
    );
    expect(mockSql).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('skips when day is not Sunday (e.g., Monday)', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';

    // 2026-01-05 is a Monday
    vi.setSystemTime(new Date('2026-01-05T22:00:00Z'));

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips when hour is not 22 UTC', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';

    // Even-week Sunday but at hour 15
    vi.setSystemTime(new Date('2026-04-26T15:00:00Z')); // Sunday, week 17 (odd) — also wrong week
    // Use a known even-week Sunday at wrong hour
    vi.setSystemTime(new Date('2026-01-04T15:00:00Z')); // Sunday week 1 — odd

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips when week number is odd', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';

    // 2026-01-04 is Sunday of ISO week 1 (odd)
    vi.setSystemTime(new Date('2026-01-04T22:00:00Z'));

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('issues one set-based INSERT on even-week Sunday at 22 UTC', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';

    // 2026-01-11 is Sunday of ISO week 2 (even)
    vi.setSystemTime(new Date('2026-01-11T22:05:00Z'));

    // Merged INSERT…SELECT inserts 0 rows
    sqlReturnQueue.push(Object.assign([], { count: 0 }));

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    // Exactly one merged statement per cycle (candidate scan + enqueue fused)
    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = mockSql.mock.calls[0];
    const queryText = Array.from(call[0] as TemplateStringsArray).join('');
    expect(queryText).toContain('INSERT INTO job_outbox');
    expect(queryText).toContain('subscription_status');
    expect(queryText).toContain('tracked_keywords');
    expect(queryText).toContain('ON CONFLICT DO NOTHING');
    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array.
    expect(call.slice(1)).toContain('track_ranking');
  });

  it('creates outbox entries for eligible businesses', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';

    // 2026-01-11 is Sunday of ISO week 2 (even)
    vi.setSystemTime(new Date('2026-01-11T22:15:00Z'));

    // Merged INSERT…SELECT reports 2 rows inserted (count = queued)
    sqlReturnQueue.push(Object.assign([], { count: 2 }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    // One merged INSERT…SELECT, not 1 SELECT + N inserts.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = mockSql.mock.calls[0];
    const queryText = Array.from(call[0] as TemplateStringsArray).join('');
    expect(queryText).toContain('INSERT INTO job_outbox');
    // Payload keys are literal SQL text inside jsonb_build_object.
    expect(queryText).toContain("'business_id'");
    expect(queryText).toContain("'google_place_id'");
    expect(queryText).toContain("'run_date'");
    expect(queryText).toContain("'correlation_id'");
    // Two independent gen_random_uuid() calls: row id + correlation_id.
    expect(queryText.match(/gen_random_uuid\(\)/g)).toHaveLength(2);
    expect(call.slice(1)).toContain('track_ranking');

    const queuedLine = consoleSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('"message":"Queued track_ranking outbox entries"'));
    expect(queuedLine).toBeDefined();
    expect(queuedLine).toContain('"queued":2');
    // The standalone candidate count is gone with the merge — only queued logs.
    expect(queuedLine).not.toContain('candidates_checked');

    consoleSpy.mockRestore();
  });

  it('relies on ON CONFLICT DO NOTHING for dedup (no JS-side 23505 catch)', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';

    vi.setSystemTime(new Date('2026-01-11T22:00:00Z'));

    sqlReturnQueue.push(Object.assign([], { count: 0 }));

    const mod = await import('../RankingTrackingScheduler');
    await mod.runRankingCheck();

    expect(mockSql).toHaveBeenCalledTimes(1);
    const queryText = Array.from(
      mockSql.mock.calls[0][0] as TemplateStringsArray,
    ).join('');
    // Concurrency dedup is now owned by the DB, not a per-row 23505 catch.
    expect(queryText).toContain('ON CONFLICT DO NOTHING');
    expect(queryText).toContain("'google_place_id'");
    expect(queryText).toContain("'run_date'");
  });

  describe('getIsoWeekNumber', () => {
    it('returns week 1 for 2026-01-01 (Thursday)', async () => {
      const mod = await import('../RankingTrackingScheduler');
      expect(mod.getIsoWeekNumber(new Date('2026-01-01T00:00:00Z'))).toBe(1);
    });

    it('returns week 1 for 2025-12-29 (Monday of ISO week 1 of 2026)', async () => {
      const mod = await import('../RankingTrackingScheduler');
      // 2025-12-29 is a Monday; ISO week 1 of 2026 starts on this Monday
      expect(mod.getIsoWeekNumber(new Date('2025-12-29T00:00:00Z'))).toBe(1);
    });

    it('returns week 2 for 2026-01-05 (Monday of week 2)', async () => {
      const mod = await import('../RankingTrackingScheduler');
      expect(mod.getIsoWeekNumber(new Date('2026-01-05T00:00:00Z'))).toBe(2);
    });

    it('returns week 52 for 2026-12-27 (Sunday)', async () => {
      const mod = await import('../RankingTrackingScheduler');
      // 2026-12-27 is a Sunday in ISO week 52
      expect(mod.getIsoWeekNumber(new Date('2026-12-27T00:00:00Z'))).toBe(52);
    });

    it('returns even week for 2026-01-11 (Sunday of week 2)', async () => {
      const mod = await import('../RankingTrackingScheduler');
      const weekNum = mod.getIsoWeekNumber(new Date('2026-01-11T22:00:00Z'));
      expect(weekNum).toBe(2);
      expect(weekNum % 2).toBe(0);
    });

    it('returns odd week for 2026-01-04 (Sunday of week 1)', async () => {
      const mod = await import('../RankingTrackingScheduler');
      const weekNum = mod.getIsoWeekNumber(new Date('2026-01-04T22:00:00Z'));
      expect(weekNum).toBe(1);
      expect(weekNum % 2).toBe(1);
    });
  });

  describe('lifecycle', () => {
    it('uses default 3_600_000ms interval when env not set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../RankingTrackingScheduler');
      mod.startRankingTrackingScheduler();
      const startLine = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('"message":"Starting"'));
      expect(startLine).toBeDefined();
      expect(startLine).toContain('"interval_ms":3600000');
      mod.stopRankingTrackingScheduler();
      consoleSpy.mockRestore();
    });

    it('uses custom interval from env', async () => {
      process.env.RANKING_TRACKING_INTERVAL_MS = '120000';
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../RankingTrackingScheduler');
      mod.startRankingTrackingScheduler();
      const startLine = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('"message":"Starting"'));
      expect(startLine).toBeDefined();
      expect(startLine).toContain('"interval_ms":120000');
      mod.stopRankingTrackingScheduler();
      consoleSpy.mockRestore();
    });

    it('stopRankingTrackingScheduler clears the interval', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mod = await import('../RankingTrackingScheduler');
      mod.startRankingTrackingScheduler();
      mod.stopRankingTrackingScheduler();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"message":"Stopped"'),
      );
      consoleSpy.mockRestore();
    });

    it('stopRankingTrackingScheduler is safe to call when not started', async () => {
      const mod = await import('../RankingTrackingScheduler');
      mod.stopRankingTrackingScheduler();
    });
  });
});
