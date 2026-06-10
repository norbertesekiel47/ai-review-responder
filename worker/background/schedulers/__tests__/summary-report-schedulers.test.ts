import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// One parametrized harness for the two summary-report schedulers
// (WeeklySummaryScheduler / MonthlyImpactScheduler) — they share the same
// candidate-selection shape and previously lived in byte-near-identical files.

// ── Hoisted shared sql mock (worker/__tests__/helpers/mock-sql) ──────
const { sqlReturnQueue, mockSql, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

/**
 * Drains the candidate query then any follow-up microtasks. The shared mock's
 * lazy thenable resolves one microtask later than a bare Promise.resolve,
 * hence the third await.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface SchedulerCase {
  name: string;
  envVar: string;
  /** A moment inside this scheduler's UTC dispatch window. */
  systemTime: string;
  /** Table name unique to this scheduler's candidate query. */
  candidateMarker: string;
  load: () => Promise<{ start: () => void; stop: () => void }>;
}

const schedulerCases: SchedulerCase[] = [
  {
    name: 'WeeklySummaryScheduler',
    envVar: 'WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS',
    // 2026-06-01 is a Monday; 08:30 UTC is inside the 8–9 AM scheduling window.
    systemTime: '2026-06-01T08:30:00Z',
    candidateMarker: 'weekly_summaries',
    load: async () => {
      const mod = await import('../WeeklySummaryScheduler');
      return { start: mod.startWeeklySummaryScheduler, stop: mod.stopWeeklySummaryScheduler };
    },
  },
  {
    name: 'MonthlyImpactScheduler',
    envVar: 'MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS',
    // 1st of the month at 09:30 UTC is inside the 9–10 AM scheduling window.
    systemTime: '2026-06-01T09:30:00Z',
    candidateMarker: 'monthly_impact_emails',
    load: async () => {
      const mod = await import('../MonthlyImpactScheduler');
      return { start: mod.startMonthlyImpactScheduler, stop: mod.stopMonthlyImpactScheduler };
    },
  },
];

describe.each(schedulerCases)('$name', ({ envVar, systemTime, candidateMarker, load }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetMockSql();
    vi.resetModules();
    delete process.env[envVar];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes archived locations from candidate selection', async () => {
    vi.setSystemTime(new Date(systemTime));
    sqlReturnQueue.push([]); // candidate query returns no businesses

    const scheduler = await load();
    scheduler.start();
    await flush();

    const candidateCall = sqlCalls.find(
      (call) => call.text.includes('FROM businesses b') && call.text.includes(candidateMarker),
    );
    expect(candidateCall).toBeDefined();
    const queryText = candidateCall!.text;

    // Best-effort textual pin — currently the ONLY coverage of the
    // scheduler's archived exclusion (the sole live-DB test exercises the
    // webhook fan-out, not these candidate queries; a DB-level test of the
    // scheduler semantics is a known follow-up). The archived exclusion must
    // be a direct predicate in the candidate query's WHERE/AND chain — not
    // reintroduced via an outer join on businesses that could let archived
    // rows through.
    expect(queryText).toMatch(/WHERE[\s\S]*?\bAND\s+b\.archived_at\s+IS\s+NULL/i);
    expect(queryText).not.toMatch(/LEFT(\s+OUTER)?\s+JOIN\s+businesses/i);
    // The predicate filters candidates directly, ahead of the NOT EXISTS dedup subquery.
    expect(queryText.indexOf('b.archived_at IS NULL')).toBeLessThan(
      queryText.indexOf('NOT EXISTS'),
    );

    scheduler.stop();
  });
});
