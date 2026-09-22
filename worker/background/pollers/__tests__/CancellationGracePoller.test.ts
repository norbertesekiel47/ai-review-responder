// worker/background/pollers/__tests__/CancellationGracePoller.test.ts
//
// TDD assertions for CancellationGracePoller.
// Validation contract: VAL-BILLING-048, VAL-BILLING-049.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CANCELLATION_GRACE_DAYS } from '../../../../src/lib/shared/cancellation-grace';

// ── Hoisted mock state ─────────────────────────────────────────────
//
// #1371: the expired-accounts query now embeds a NESTED tagged-template
// fragment — cancellationGraceExpiredSql(sql) — the same postgres.js
// composition idiom publisherSubscriptionEligibleSql already uses in
// production (judge-store.ts, judge-health.ts). Real postgres.js Query
// objects play two roles: a value spliced into an outer template's
// substitution position is inlined as a fragment (never independently
// executed), while the outermost expression is executed only when
// `await`-ed. This mock reproduces both roles: `then()` performs the
// "pop the next queued fixture row" side effect and fires only for a
// genuinely top-level `await sql\`...\`` — never for a fragment sitting
// inertly inside another template's `values` array, which is the failure
// mode a naive always-resolve mock hits (queue desync, call-order
// assumptions broken).
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query: any = { __isMockSqlFragment: true, strings, values };
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const result = sqlReturnQueue.shift() ?? [];
        return Promise.resolve(result).then(resolve, reject);
      };
      return query;
    },
  );
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

// Import AFTER mocks are wired
import { startCancellationGracePoller, stopCancellationGracePoller } from '../CancellationGracePoller';

// ── Helpers ────────────────────────────────────────────────────────

async function runOneCycle(): Promise<void> {
  startCancellationGracePoller();
  // Let the initial runCancellationGrace() Promise chain resolve.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
  stopCancellationGracePoller();
}

function queueLifecycleAndBusinessLocks(): void {
  sqlReturnQueue.push([]); // account-scoped location lifecycle advisory lock
  sqlReturnQueue.push([]); // deterministic active business-row FOR UPDATE lock
}

/**
 * Flattens one recorded call's strings/values into readable SQL text,
 * recursively inlining a nested fragment (a value produced by another call
 * to the same mock tag, e.g. cancellationGraceExpiredSql(sql)) instead of
 * rendering it as an opaque `?`.
 */
function joinDeep(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as { __isMockSqlFragment?: boolean; strings?: TemplateStringsArray; values?: unknown[] } | undefined;
    out += value && typeof value === 'object' && value.__isMockSqlFragment
      ? joinDeep(value.strings as TemplateStringsArray, value.values as unknown[])
      : '?';
    out += strings[i + 1] ?? '';
  }
  return out;
}

/** The first recorded mock call whose flattened text contains `marker`. */
function findCallContaining(marker: string): [TemplateStringsArray, ...unknown[]] | undefined {
  return (mockSql.mock.calls as [TemplateStringsArray, ...unknown[]][]).find(
    (call) => joinDeep(call[0], call.slice(1)).includes(marker),
  );
}

// ── Tests ──────────────────────────────────────────────────────────

describe('CancellationGracePoller', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stopCancellationGracePoller();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // VAL-BILLING-049: 30-day grace period before automatic soft-archive
  it('soft-archives locations for cancelled accounts past 30-day grace', async () => {
    // Queue: expired accounts query → returns 1 account with 2 locations
    sqlReturnQueue.push([
      { account_id: 'acct-1', cancelled_count: 2 },
    ]);

    queueLifecycleAndBusinessLocks();
    // Inside tx: UPDATE businesses RETURNING archived locations
    sqlReturnQueue.push([
      { id: 'loc-1', display_label: 'Downtown', name: 'Downtown Cafe' },
      { id: 'loc-2', display_label: 'Westside', name: 'Westside Bakery' },
    ]);

    // INSERT audit_log for loc-1
    sqlReturnQueue.push(undefined);
    // INSERT audit_log for loc-2
    sqlReturnQueue.push(undefined);

    await runOneCycle();

    // Verify the expired accounts query (identified by content, not call
    // position — cancellationGraceExpiredSql(sql) is evaluated as a nested
    // fragment BEFORE the outer tag runs, so it is recorded first).
    const expiredAccountsCall = findCallContaining('cancelled_count');
    expect(expiredAccountsCall).toBeDefined();
    const template = joinDeep(expiredAccountsCall![0], expiredAccountsCall!.slice(1));
    expect(template).toContain('cancelled');
    expect(template).toContain('cancelled_at IS NOT NULL');
    expect(template).toContain('cancelled_at');
    expect(template).toContain('archived_at IS NULL');
    // The grace window comes from the shared cancellationGraceExpiredSql
    // fragment (#1371), not a locally re-spelled INTERVAL literal.
    expect(template).toContain('make_interval(days => ?)');
    // Pin the bound day count to the SAME shared constant the dashboard
    // route's JS deadline (cancellationGraceDeadline) uses — the whole point
    // of #1371 is that these two can no longer independently drift.
    const graceFragment = expiredAccountsCall!.slice(1).find(
      (v): v is { __isMockSqlFragment: true; values: unknown[] } =>
        Boolean(v && typeof v === 'object' && (v as { __isMockSqlFragment?: boolean }).__isMockSqlFragment),
    );
    expect(graceFragment?.values).toContain(CANCELLATION_GRACE_DAYS);

    // Verify audit log entries were written
    const auditCalls = mockSql.mock.calls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('account_audit_log'),
    );
    expect(auditCalls.length).toBeGreaterThanOrEqual(2);

    // Verify audit log uses the correct event type
    const auditTemplate = (auditCalls[0]![0] as TemplateStringsArray).join('?');
    expect(auditTemplate).toContain('location_soft_archived_grace_expired');
  });

  it('does nothing when no expired cancelled accounts exist', async () => {
    // Queue: empty result for expired accounts query
    sqlReturnQueue.push([]);

    await runOneCycle();

    // Verify the first SQL call was made (the expired accounts query)
    expect(mockSql).toHaveBeenCalled();

    // Verify the log says nothing to archive
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No expired cancelled accounts'),
    );
  });

  // VAL-BILLING-048: Subscription cancellation sets all locations read-only
  // (workers skip via isAccountActive guard — this poller handles the
  // post-grace soft-archival)
  it('sets archived_at on all active locations for expired cancelled accounts', async () => {
    sqlReturnQueue.push([
      { account_id: 'acct-expired', cancelled_count: 3 },
    ]);

    queueLifecycleAndBusinessLocks();
    // Inside tx: UPDATE businesses RETURNING archived locations
    sqlReturnQueue.push([
      { id: 'loc-a', display_label: 'A', name: 'Location A' },
      { id: 'loc-b', display_label: 'B', name: 'Location B' },
      { id: 'loc-c', display_label: 'C', name: 'Location C' },
    ]);
    sqlReturnQueue.push(undefined);
    sqlReturnQueue.push(undefined);
    sqlReturnQueue.push(undefined);

    await runOneCycle();

    // Verify the UPDATE businesses call sets archived_at
    const updateCalls = mockSql.mock.calls.filter(
      (c: any[]) => {
        const t = (c[0] as TemplateStringsArray).join('?');
        return t.includes('UPDATE businesses') && t.includes('archived_at');
      },
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('uses UPDATE RETURNING rows for audit logs instead of a timestamp-window SELECT', async () => {
    sqlReturnQueue.push([
      { account_id: 'acct-returning', cancelled_count: 2 },
    ]);

    queueLifecycleAndBusinessLocks();
    sqlReturnQueue.push([
      { id: 'loc-returned-1', display_label: 'Returned A', name: 'Location A' },
      { id: 'loc-returned-2', display_label: 'Returned B', name: 'Location B' },
    ]);
    sqlReturnQueue.push(undefined);
    sqlReturnQueue.push(undefined);

    await runOneCycle();

    const templates: string[] = mockSql.mock.calls.map(
      (c: any[]) => (c[0] as TemplateStringsArray).join(' '),
    );
    const updateTemplate = templates.find((template: string) =>
      template.includes('UPDATE businesses') && template.includes('archived_at'),
    );
    expect(updateTemplate).toContain('RETURNING id, display_label, name');
    expect(templates.some((template: string) =>
      template.includes('SELECT id, display_label, name') &&
      template.includes("archived_at > NOW() - INTERVAL '1 minute'"),
    )).toBe(false);
  });

  it('re-checks account_offboardings inside the archival UPDATE transaction', async () => {
    sqlReturnQueue.push([
      { account_id: 'acct-race', cancelled_count: 2 },
    ]);

    // Simulates an offboarding row being created after discovery: the guarded
    // UPDATE should return no locations, so no audit rows are written.
    queueLifecycleAndBusinessLocks();
    sqlReturnQueue.push([]);

    await runOneCycle();

    const updateCall = mockSql.mock.calls.find((c: any[]) => {
      const template = (c[0] as TemplateStringsArray).join('?');
      return template.includes('UPDATE businesses') && template.includes('archived_at');
    });
    expect(updateCall).toBeDefined();

    const updateTemplate = (updateCall![0] as TemplateStringsArray).join('?');
    expect(updateTemplate).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+account_offboardings\s+ao/i);
    expect(updateTemplate).toContain('ao.account_id = ?::uuid');

    const auditCalls = mockSql.mock.calls.filter(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('account_audit_log'),
    );
    expect(auditCalls).toHaveLength(0);
  });

  it('excludes accounts with any offboarding row from grace archival', async () => {
    sqlReturnQueue.push([]);

    await runOneCycle();

    // Identify the expired-accounts query by content — cancellationGraceExpiredSql(sql)
    // is recorded as an earlier, nested mock call, so it is no longer calls[0].
    const expiredAccountsCall = findCallContaining('cancelled_count');
    expect(expiredAccountsCall).toBeDefined();
    const template = joinDeep(expiredAccountsCall![0], expiredAccountsCall!.slice(1));
    expect(template).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+account_offboardings\s+ao/i);
    expect(template).toContain('ao.account_id = a.id');
  });
});
