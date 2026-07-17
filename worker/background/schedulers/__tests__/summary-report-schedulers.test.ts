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
  /**
   * The digest opt-in column this scheduler filters on. Since PR E the toggle
   * lives on `accounts` (migration 063); the candidate query must read it from
   * the joined `accounts a`, NOT the deprecated per-business column.
   */
  digestColumn: string;
  /** The payload date key this scheduler writes via jsonb_build_object. */
  payloadDateKey: string;
  /** Substring unique to this scheduler's "Queued N …" log message. */
  queuedLogNeedle: string;
  load: () => Promise<{ start: () => void; stop: () => void }>;
}

const schedulerCases: SchedulerCase[] = [
  {
    name: 'WeeklySummaryScheduler',
    envVar: 'WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS',
    // 2026-06-01 is a Monday; 08:30 UTC is inside the 8–9 AM scheduling window.
    systemTime: '2026-06-01T08:30:00Z',
    candidateMarker: 'weekly_summaries',
    digestColumn: 'weekly_summary_enabled',
    payloadDateKey: 'week_start_date',
    queuedLogNeedle: 'weekly_summary outbox entries',
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
    digestColumn: 'monthly_impact_enabled',
    payloadDateKey: 'month_start_date',
    queuedLogNeedle: 'send_monthly_impact outbox entries',
    load: async () => {
      const mod = await import('../MonthlyImpactScheduler');
      return { start: mod.startMonthlyImpactScheduler, stop: mod.stopMonthlyImpactScheduler };
    },
  },
];

describe.each(schedulerCases)('$name', ({ envVar, systemTime, candidateMarker, digestColumn, payloadDateKey, queuedLogNeedle, load }) => {
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

  it('reads the digest opt-in from accounts, not the deprecated per-business column', async () => {
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

    // PR E moved the digest toggle to account level (migration 063). The
    // candidate query must filter on the joined `accounts a` column so a write
    // to `accounts` is honored; the per-business column is deprecated and must
    // no longer gate candidate selection.
    expect(queryText).toContain(`a.${digestColumn}`);
    expect(queryText).not.toContain(`b.${digestColumn}`);

    // The accounts column is NOT NULL DEFAULT TRUE (migration 063) — the
    // predicate is a plain equality, with no dead IS-NULL arm.
    expect(queryText).toContain(`a.${digestColumn} = TRUE`);
    expect(queryText).not.toContain(`a.${digestColumn} IS NULL`);

    scheduler.stop();
  });

  it('issues exactly one set-based INSERT…SELECT per cycle', async () => {
    vi.setSystemTime(new Date(systemTime));
    sqlReturnQueue.push([]); // 0 rows inserted

    const scheduler = await load();
    scheduler.start();
    await flush();

    // The candidate scan and the enqueue are fused into a single statement.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const queryText = sqlCalls[0]!.text;

    expect(queryText).toContain('INSERT INTO job_outbox');
    expect(queryText).toContain('ON CONFLICT DO NOTHING');
    // Payload keys are literal SQL text inside jsonb_build_object.
    expect(queryText).toContain("'business_id'");
    expect(queryText).toContain(`'${payloadDateKey}'`);
    expect(queryText).toContain("'correlation_id'");
    // Two independent gen_random_uuid() calls: row id + correlation_id.
    expect(queryText.match(/gen_random_uuid\(\)/g)).toHaveLength(2);
    // In-flight dedup pre-filter against job_outbox survives the merge.
    expect(queryText).toContain('FROM job_outbox jo');
    expect(queryText).toContain("jo.status IN ('pending', 'dispatching', 'dispatched')");

    scheduler.stop();
  });

  it('logs queued count reflecting the INSERT row count', async () => {
    vi.setSystemTime(new Date(systemTime));
    sqlReturnQueue.push(Object.assign([], { count: 2 })); // 2 rows inserted

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const scheduler = await load();
    scheduler.start();
    await flush();

    const queuedLine = consoleSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes(queuedLogNeedle));
    expect(queuedLine).toBeDefined();
    expect(queuedLine).toContain('Queued 2');

    consoleSpy.mockRestore();
    scheduler.stop();
  });
});
