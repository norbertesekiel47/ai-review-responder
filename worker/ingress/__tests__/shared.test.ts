import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
type Row = Record<string, unknown>;

const { mockSql } = vi.hoisted(() => {
  const mockSql = (async (...args: unknown[]) => {
    void args;
    const next = sqlQueue.shift();
    if (Array.isArray(next)) return next as Row[];
    const arr: Row[] & { count?: number } = [];
    arr.count = typeof next === 'number' ? next : 0;
    return arr;
  }) as unknown as {
    (...args: unknown[]): Promise<unknown>;
  };
  return { mockSql };
});

vi.mock('../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

import { claimInboundEvent } from '../shared';

describe('claimInboundEvent', () => {
  beforeEach(() => {
    sqlQueue.length = 0;
  });

  it('returns "claimed" when INSERT lands (count > 0)', async () => {
    sqlQueue.push(1); // INSERT count
    const result = await claimInboundEvent('telegram', 'tg:123', 'callback_query', { a: 1 });
    expect(result).toBe('claimed');
  });

  it('returns "claimed" when reclaim UPDATE matches a stale row', async () => {
    sqlQueue.push(0); // INSERT conflict
    sqlQueue.push([{ id: 'row-1' }]); // reclaim UPDATE returns row
    const result = await claimInboundEvent('telegram', 'tg:456', 'callback_query', {});
    expect(result).toBe('claimed');
  });

  it('returns "duplicate" when both INSERT and reclaim miss', async () => {
    sqlQueue.push(0); // INSERT conflict
    sqlQueue.push([]); // reclaim UPDATE matches nothing
    const result = await claimInboundEvent('telegram', 'tg:789', 'callback_query', {});
    expect(result).toBe('duplicate');
  });
});
