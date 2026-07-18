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

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

// Import AFTER mocks are wired
import {
  startArchivalPoller,
  stopArchivalPoller,
  AGENT_SPINE_RETENTION_DAYS,
} from '../ArchivalPoller';
import { DASHBOARD_WINDOWS, dashboardWindowParams } from '@/lib/kpi/types';
import { GOVERNOR_WINDOW_DAYS } from '@/lib/auto-approval/governor';

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
  analytics?: number;
  agentOutcomes?: number;
  agentRuns?: number;
}): void {
  sqlReturnQueue.length = 0;
  sqlReturnQueue.push([{ count: String(counts.outbox) }]);
  sqlReturnQueue.push([{ count: String(counts.events) }]);
  sqlReturnQueue.push([{ count: String(counts.demos) }]);
  sqlReturnQueue.push([{ count: String(counts.costs) }]);
  sqlReturnQueue.push([{ count: String(counts.notifications) }]);
  sqlReturnQueue.push([{ count: String(counts.analytics ?? 0) }]);
  sqlReturnQueue.push([{ count: String(counts.agentOutcomes ?? 0) }]);
  sqlReturnQueue.push([{ count: String(counts.agentRuns ?? 0) }]);
}

// ── Tests ──────────────────────────────────────────────────────────

// ── Invariants ─────────────────────────────────────────────────────
//
// The spine retention window is the OUTER bound: it must strictly exceed
// EVERY window a live consumer reads back over the run spine. If a consumer
// window is ever raised past retention, retention would silently prune rows
// those consumers still expect — under-serving getAgentTeamSummary (dashboard
// windows) and the auto-approval governor (its suspension lookback). This
// guard fails the build the moment that invariant is violated, forcing the
// retention constant to be raised in lockstep rather than drifting silently.

describe('ArchivalPoller retention-window invariants', () => {
  const maxDashboardWindowDays = Math.max(
    ...DASHBOARD_WINDOWS.map((w) => dashboardWindowParams(w).windowDays),
  );

  it('keeps the 180-day spine retention window above every consumer window', () => {
    expect(AGENT_SPINE_RETENTION_DAYS).toBeGreaterThan(maxDashboardWindowDays);
    expect(AGENT_SPINE_RETENTION_DAYS).toBeGreaterThan(GOVERNOR_WINDOW_DAYS);
  });
});

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

  it('issues 8 SQL queries in order (outbox, events, demos, api_costs, notifications, analytics_events, agent_outcomes, agent_runs)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    expect(mockSql).toHaveBeenCalledTimes(8);
  });

  it('logs all 8 target counts when any archival happened', async () => {
    queueArchivalResults({ outbox: 10, events: 20, demos: 5, costs: 100, notifications: 50, analytics: 7, agentOutcomes: 3, agentRuns: 9 });

    await runOneCycle();

    const archivedLog = logSpy.mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('"message":"Archived"'),
    );
    expect(archivedLog).toBeDefined();
    const msg = archivedLog![0] as string;
    expect(msg).toContain('"outbox":10');
    expect(msg).toContain('"events":20');
    expect(msg).toContain('"demos":5');
    expect(msg).toContain('"api_costs":100');
    expect(msg).toContain('"notifications":50');
    expect(msg).toContain('"analytics_events":7');
    expect(msg).toContain('"agent_outcomes":3');
    expect(msg).toContain('"agent_runs":9');
  });

  it('logs "Nothing to archive" when all 8 targets return 0', async () => {
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

  it('includes analytics_events in the saturation warning when it hits the limit', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0, analytics: 5000 });

    await runOneCycle();

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('analytics_events');
  });

  it('analytics_events query deletes completed at 30 days and failed at 90 days (query shape assertion)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    // The 6th sql() call (index 5) is the analytics_events block.
    const analyticsCall = mockSql.mock.calls[5];
    expect(analyticsCall).toBeDefined();
    const templateStrings = analyticsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('analytics_events');
    expect(fullSql).toContain("status = 'completed' AND occurred_at < NOW() - INTERVAL '30 days'");
    expect(fullSql).toContain("status = 'failed' AND occurred_at < NOW() - INTERVAL '90 days'");
    expect(fullSql).toContain('LIMIT 5000');
    expect(fullSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('agent_outcomes query enforces the 180-day spine retention window (query shape assertion)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    // The 7th sql() call (index 6) is the agent_outcomes spine-retention block.
    const agentOutcomesCall = mockSql.mock.calls[6];
    expect(agentOutcomesCall).toBeDefined();
    const templateStrings = agentOutcomesCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('agent_outcomes');
    expect(fullSql).toContain('occurred_at < NOW() - make_interval(days =>');
    expect(fullSql).toContain('LIMIT 5000');
    expect(fullSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('logs the agent_outcomes count in the Archived log', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0, agentOutcomes: 42 });

    await runOneCycle();

    const archivedLog = logSpy.mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('"message":"Archived"'),
    );
    expect(archivedLog).toBeDefined();
    expect(archivedLog![0] as string).toContain('"agent_outcomes":42');
  });

  it('includes agent_outcomes in the saturation warning when it hits the limit', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0, agentOutcomes: 5000 });

    await runOneCycle();

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('agent_outcomes');
  });

  it('agent_runs query enforces the 180-day spine retention window and prunes steps via cascade (query shape assertion)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    // The 8th sql() call (index 7) is the agent_runs spine-retention block.
    const agentRunsCall = mockSql.mock.calls[7];
    expect(agentRunsCall).toBeDefined();
    const templateStrings = agentRunsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('agent_runs');
    expect(fullSql).toContain('ended_at < NOW() - make_interval(days =>');
    expect(fullSql).toContain('LIMIT 5000');
    expect(fullSql).toContain('FOR UPDATE SKIP LOCKED');
    // Steps prune via ON DELETE CASCADE — the poller must NOT delete them directly.
    expect(fullSql).not.toContain('DELETE FROM agent_run_steps');
  });

  it('logs the agent_runs count in the Archived log', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0, agentRuns: 42 });

    await runOneCycle();

    const archivedLog = logSpy.mock.calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('"message":"Archived"'),
    );
    expect(archivedLog).toBeDefined();
    expect(archivedLog![0] as string).toContain('"agent_runs":42');
  });

  it('includes agent_runs in the saturation warning when it hits the limit', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0, agentRuns: 5000 });

    await runOneCycle();

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('agent_runs');
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
