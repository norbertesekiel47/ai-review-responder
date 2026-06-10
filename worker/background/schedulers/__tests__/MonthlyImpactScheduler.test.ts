import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    if (Array.isArray(result) && !('count' in result)) {
      (result as any).count = result.length > 0 ? 1 : 0;
    }
    return Promise.resolve(result);
  });

  return { sqlReturnQueue, mockSql };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

/** Drains the candidate query then any follow-up microtasks. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MonthlyImpactScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    vi.resetModules();
    delete process.env.MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes archived locations from candidate selection', async () => {
    // 1st of the month at 09:30 UTC is inside the 9–10 AM scheduling window.
    vi.setSystemTime(new Date('2026-06-01T09:30:00Z'));
    sqlReturnQueue.push([]); // candidate query returns no businesses

    const mod = await import('../MonthlyImpactScheduler');
    mod.startMonthlyImpactScheduler();
    await flush();

    const candidateCall = mockSql.mock.calls.find((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('FROM businesses b') && text.includes('monthly_impact_emails');
    });
    expect(candidateCall).toBeDefined();
    const queryText = Array.from(candidateCall![0] as TemplateStringsArray).join('');
    expect(queryText).toContain('b.archived_at IS NULL');

    mod.stopMonthlyImpactScheduler();
  });
});
