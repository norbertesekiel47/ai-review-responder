import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/server', () => ({
  sql: { begin: vi.fn() },
  jsonb: (v: unknown) => v,  // pass-through so tests can inspect the payload object
}));

import { applyIngestionAuthErrorFallback } from '../auth-error-fallback';

describe('applyIngestionAuthErrorFallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('disconnects only the matching active connection (account+location pinned) and enqueues connection_lost notify', async () => {
    const { sql } = await import('@/lib/db/server');
    const txCalls: Array<{ args: unknown[]; returnValue: unknown }> = [];

    // Build a tagged-template `tx` mock. First call (UPDATE zernio_connections)
    // returns count=1 RETURNING. Second call (INSERT job_outbox) returns count=1.
    const mkTaggedResult = (count: number) => {
      const arr: unknown[] & { count: number } = [] as unknown as unknown[] & { count: number };
      arr.count = count;
      return arr;
    };

    const tx = vi.fn((_strings: TemplateStringsArray, ...args: unknown[]) => {
      txCalls.push({ args, returnValue: null });
      // Return updated.count=1 on the first UPDATE call; count=1 on insert.
      return Promise.resolve(mkTaggedResult(1));
    });
    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));

    await applyIngestionAuthErrorFallback('biz1', 'acctA', 'locL', '401 expired');

    // Assert the UPDATE call carried biz1, acctA, locL, and reason in its args.
    const updateCallArgs = txCalls[0]?.args ?? [];
    expect(updateCallArgs).toContain('biz1');
    expect(updateCallArgs).toContain('acctA');
    expect(updateCallArgs).toContain('locL');
    expect(updateCallArgs).toContain('401 expired');

    // Assert the INSERT call's payload arg has kind='connection_lost' and business_id=biz1.
    const insertCallArgs = txCalls[1]?.args ?? [];
    const payloadArg = insertCallArgs.find(
      (a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a)
        && 'kind' in (a as Record<string, unknown>),
    );
    expect(payloadArg).toEqual({ kind: 'connection_lost', business_id: 'biz1' });
  });

  it('no-ops when matching connection is already disconnected (UPDATE returns count=0)', async () => {
    const { sql } = await import('@/lib/db/server');
    const txCalls: Array<{ args: unknown[] }> = [];

    const mkTaggedResult = (count: number) => {
      const arr: unknown[] & { count: number } = [] as unknown as unknown[] & { count: number };
      arr.count = count;
      return arr;
    };

    const tx = vi.fn((_strings: TemplateStringsArray, ...args: unknown[]) => {
      txCalls.push({ args });
      return Promise.resolve(mkTaggedResult(0));
    });
    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));

    await applyIngestionAuthErrorFallback('biz1', 'acctA', 'locL', '401 expired');

    expect(txCalls.length).toBe(1);  // only the UPDATE; no INSERT
  });

  it('UPDATE filters by status=active', async () => {
    const { sql } = await import('@/lib/db/server');
    let updateSql = '';
    const mkTaggedResult = (count: number) => {
      const arr: unknown[] & { count: number } = [] as unknown as unknown[] & { count: number };
      arr.count = count;
      return arr;
    };
    const tx = vi.fn((strings: TemplateStringsArray) => {
      if (!updateSql) updateSql = strings.join('');
      return Promise.resolve(mkTaggedResult(0));
    });
    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));

    await applyIngestionAuthErrorFallback('biz1', 'acctA', 'locL', 'r');
    expect(updateSql).toMatch(/status\s*=\s*'active'/);
    expect(updateSql).toMatch(/disconnect_reason\s*=\s*'auth_error_on_ingest'/);
  });

  it('disconnect_reason is "auth_error_on_ingest" (not "auth_error_on_post")', async () => {
    const { sql } = await import('@/lib/db/server');
    let updateSql = '';
    const mkTaggedResult = (count: number) => {
      const arr: unknown[] & { count: number } = [] as unknown as unknown[] & { count: number };
      arr.count = count;
      return arr;
    };
    const tx = vi.fn((strings: TemplateStringsArray) => {
      if (!updateSql) updateSql = strings.join('');
      return Promise.resolve(mkTaggedResult(1));
    });
    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));

    await applyIngestionAuthErrorFallback('biz1', 'acctA', 'locL', 'r');
    expect(updateSql).toContain("'auth_error_on_ingest'");
    expect(updateSql).not.toContain("'auth_error_on_post'");
  });
});
