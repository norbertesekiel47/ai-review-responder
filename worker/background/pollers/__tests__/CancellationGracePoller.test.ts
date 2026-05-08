// worker/background/pollers/__tests__/CancellationGracePoller.test.ts
//
// TDD assertions for CancellationGracePoller.
// Validation contract: VAL-BILLING-048, VAL-BILLING-049.

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

    // Inside tx: UPDATE businesses result
    sqlReturnQueue.push(undefined);

    // SELECT recently archived locations
    sqlReturnQueue.push([
      { id: 'loc-1', display_label: 'Downtown', name: 'Downtown Cafe' },
      { id: 'loc-2', display_label: 'Westside', name: 'Westside Bakery' },
    ]);

    // INSERT audit_log for loc-1
    sqlReturnQueue.push(undefined);
    // INSERT audit_log for loc-2
    sqlReturnQueue.push(undefined);

    await runOneCycle();

    // Verify the first SQL call is the expired accounts query
    const firstCall = mockSql.mock.calls[0];
    const template = (firstCall[0] as TemplateStringsArray).join('?');
    expect(template).toContain('30 days');
    expect(template).toContain('cancelled');
    expect(template).toContain('cancelled_at IS NOT NULL');
    expect(template).toContain('cancelled_at');
    expect(template).toContain('archived_at IS NULL');

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

    // Inside tx
    sqlReturnQueue.push(undefined); // UPDATE businesses
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
});
