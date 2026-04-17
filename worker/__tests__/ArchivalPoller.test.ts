import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ─────────────────────────────────────────────

const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(result);
    },
  );
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql,
}));

// Import AFTER mocks are wired
import { startArchivalPoller, stopArchivalPoller } from '../jobs/ArchivalPoller';

// ── Helpers ────────────────────────────────────────────────────────

async function runOneCycle(): Promise<void> {
  startArchivalPoller();
  // Let the initial runArchival() Promise chain resolve.
  // Each SQL call is a microtask, so yield multiple times.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
  stopArchivalPoller();
}

function queueArchivalResults(counts: {
  outbox: number;
  events: number;
  demos: number;
  costs: number;
  notifications: number;
}): void {
  sqlReturnQueue.length = 0;
  sqlReturnQueue.push([{ count: String(counts.outbox) }]);
  sqlReturnQueue.push([{ count: String(counts.events) }]);
  sqlReturnQueue.push([{ count: String(counts.demos) }]);
  sqlReturnQueue.push([{ count: String(counts.costs) }]);
  sqlReturnQueue.push([{ count: String(counts.notifications) }]);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ArchivalPoller', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    stopArchivalPoller();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('issues 5 SQL queries in order (outbox, events, demos, api_costs, notifications)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('logs all 5 target counts when any archival happened', async () => {
    queueArchivalResults({ outbox: 10, events: 20, demos: 5, costs: 100, notifications: 50 });

    await runOneCycle();

    const archivedLog = logSpy.mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('Archived:'),
    );
    expect(archivedLog).toBeDefined();
    const msg = archivedLog![0] as string;
    expect(msg).toContain('10 outbox');
    expect(msg).toContain('20 events');
    expect(msg).toContain('5 demos');
    expect(msg).toContain('100 api_costs');
    expect(msg).toContain('50 notifications');
  });

  it('logs "Nothing to archive" when all 5 targets return 0', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const nothingLog = logSpy.mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('Nothing to archive'),
    );
    expect(nothingLog).toBeDefined();
  });

  it('warns with saturated target names when a batch hits the 5000 limit', async () => {
    queueArchivalResults({ outbox: 5000, events: 0, demos: 0, costs: 5000, notifications: 0 });

    await runOneCycle();

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('outbox');
    expect(warnMsg).toContain('api_costs');
    expect(warnMsg).not.toContain('events');
    expect(warnMsg).not.toContain('notifications');
  });

  it('does not warn when all counts are below 5000', async () => {
    queueArchivalResults({ outbox: 4999, events: 100, demos: 50, costs: 4999, notifications: 1000 });

    await runOneCycle();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('api_costs query uses additive ON CONFLICT DO UPDATE (query shape assertion)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    // The 4th sql() call (index 3) is the api_costs CTE.
    const apiCostsCall = mockSql.mock.calls[3];
    expect(apiCostsCall).toBeDefined();
    const templateStrings = apiCostsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date');
    expect(fullSql).toContain('api_costs_daily_rollups.total_cost_usd + EXCLUDED.total_cost_usd');
    expect(fullSql).toContain('api_costs_daily_rollups.call_count + EXCLUDED.call_count');
  });

  it('api_costs query filters rows older than 90 days', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const apiCostsCall = mockSql.mock.calls[3];
    const templateStrings = apiCostsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain("NOW() - INTERVAL '90 days'");
    expect(fullSql).toContain('LIMIT 5000');
  });

  // Regression: Finding 1 — concurrent workers must not double-count.
  // The fix is a DELETE-first claim pattern: candidates CTE uses
  // FOR UPDATE SKIP LOCKED and the aggregate reads from DELETE RETURNING,
  // so each source row is claimed and counted exactly once.
  it('api_costs query uses FOR UPDATE SKIP LOCKED and DELETE RETURNING claim pattern', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const apiCostsCall = mockSql.mock.calls[3];
    const templateStrings = apiCostsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    // Candidates use FOR UPDATE SKIP LOCKED to claim rows exclusively
    expect(fullSql).toContain('FOR UPDATE SKIP LOCKED');
    // DELETE ... RETURNING feeds the aggregate — not a separate SELECT
    expect(fullSql).toContain('DELETE FROM api_costs');
    expect(fullSql).toContain('FROM deleted');
    // Deterministic ordering for the claim
    expect(fullSql).toContain('ORDER BY created_at, id');
  });

  it('notification_deliveries query filters rows older than 90 days', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const ndCall = mockSql.mock.calls[4];
    const templateStrings = ndCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('notification_deliveries');
    expect(fullSql).toContain("NOW() - INTERVAL '90 days'");
    expect(fullSql).toContain('LIMIT 5000');
  });

  it('continues past SQL failures without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('DB unreachable')));

    await runOneCycle();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
