import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlQueue: unknown[] = [];
/** Query text of every executed statement, in order, bound values inlined. */
const sqlTexts: string[] = [];
type Row = Record<string, unknown>;

const { mockSql } = vi.hoisted(() => {
  const mockSql = (async (...args: unknown[]) => {
    const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
    sqlTexts.push(
      strings.reduce(
        (text, part, i) => text + part + (i < values.length ? String(values[i]) : ''),
        '',
      ),
    );
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

import {
  claimInboundEvent,
  markInboundEventStaleIgnored,
  RECLAIMABLE_INBOUND_EVENT_STATUSES,
} from '../shared';

describe('claimInboundEvent', () => {
  beforeEach(() => {
    sqlQueue.length = 0;
    sqlTexts.length = 0;
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

  it('claimInboundEvent reclaims a stale_ignored row so a resent Stripe event reprocesses', async () => {
    // D9, the load-bearing detail. Acking an age-stale event with 'processed'
    // would make claimInboundEvent return 'duplicate' for an operator's manual
    // resend from the Stripe dashboard — strictly WORSE than today's three
    // days of retries. 'stale_ignored' keeps that replay path open.
    sqlQueue.push(0); // INSERT conflict — the row already exists
    sqlQueue.push([{ id: 'row-stale-ignored' }]); // reclaim UPDATE matches it

    const result = await claimInboundEvent(
      'stripe',
      'evt_resent_by_operator',
      'customer.subscription.updated',
      {},
    );

    expect(result).toBe('claimed');
    const reclaimSql = sqlTexts[1]!;
    expect(reclaimSql).toContain("'stale_ignored'");
    expect(reclaimSql).toContain("'failed'");
    expect(RECLAIMABLE_INBOUND_EVENT_STATUSES).toContain('stale_ignored');
    expect(RECLAIMABLE_INBOUND_EVENT_STATUSES).toContain('failed');
  });
});

describe('markInboundEventStaleIgnored', () => {
  beforeEach(() => {
    sqlQueue.length = 0;
    sqlTexts.length = 0;
  });

  it('a stale no-account subscription event is recorded with the stale_ignored status, not processed', async () => {
    // 'processed' is the one status that must NOT be written here: it is
    // excluded from claimInboundEvent's reclaim predicate, so it would silently
    // deduplicate an operator resend.
    sqlQueue.push(1);

    await markInboundEventStaleIgnored('evt_stale_no_account');

    expect(sqlTexts).toHaveLength(1);
    expect(sqlTexts[0]).toContain("status = 'stale_ignored'");
    expect(sqlTexts[0]).not.toContain("status = 'processed'");
    // processed_at is stamped, because ArchivalPoller sweeps on that column.
    expect(sqlTexts[0]).toContain('processed_at = NOW()');
    expect(sqlTexts[0]).toContain('evt_stale_no_account');
  });
});
