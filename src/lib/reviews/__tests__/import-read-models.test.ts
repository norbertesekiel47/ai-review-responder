import type { Sql, TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { recordImportDecisionAndEnqueue } from '../import-consent';
import { readImportOfferView } from '../import-offer-view';

type ConsentRow = {
  state: 'pending' | 'accepted' | 'declined' | 'expired';
  decided_at: Date | null;
  expires_at: Date | null;
};

type ViewRow = {
  consent_state: ConsentRow['state'];
  expires_at: Date | null;
  run_completed_at: Date | null;
  imported_count: number | null;
};

function queryText(strings: TemplateStringsArray): string {
  return strings.join(' ').replace(/\s+/g, ' ').trim();
}

function viewSql(row: ViewRow | null, outboxStatus?: string): Sql {
  const tag = vi.fn((strings: TemplateStringsArray) => {
    const query = queryText(strings);
    if (query.includes('SELECT jo.status')) {
      return Promise.resolve(outboxStatus ? [{ status: outboxStatus }] : []);
    }
    if (query.includes('FROM businesses b')) return Promise.resolve(row ? [row] : []);
    return { fragment: query };
  });
  return tag as unknown as Sql;
}

function decisionSql(current: ConsentRow | null): Sql {
  const txTag = vi.fn((strings: TemplateStringsArray) => {
    const query = queryText(strings);
    if (query.includes('SELECT id FROM businesses')) return Promise.resolve([{ id: 'business-1' }]);
    if (query.includes('UPDATE businesses')) return Promise.resolve([]);
    if (query.includes('AS state')) return Promise.resolve(current ? [current] : []);
    return { fragment: query };
  });
  const transaction = txTag as unknown as TransactionSql;
  const db = Object.assign(vi.fn(), {
    begin: vi.fn((run: (tx: TransactionSql) => Promise<unknown>) => run(transaction)),
  });
  return db as unknown as Sql;
}

describe('readImportOfferView', () => {
  const accepted: ViewRow = {
    consent_state: 'accepted',
    expires_at: null,
    run_completed_at: null,
    imported_count: null,
  };

  it.each([
    ['missing business', null, undefined, { state: 'none' }],
    ['pending without an offer', { ...accepted, consent_state: 'pending' }, undefined, { state: 'none' }],
    ['declined offer', { ...accepted, consent_state: 'declined' }, undefined, { state: 'none' }],
    ['active import', accepted, 'dispatching', { state: 'importing' }],
    ['completed outbox before run finalization', accepted, 'completed', { state: 'importing' }],
    ['failed import', accepted, 'failed', { state: 'failed' }],
    ['accepted before enqueue', accepted, undefined, { state: 'importing' }],
  ] as const)('%s', async (_name, row, status, expected) => {
    await expect(readImportOfferView(viewSql(row, status), 'business-1', 'account-1'))
      .resolves.toEqual(expected);
  });

  it('returns a live offer deadline', async () => {
    const expiresAt = new Date('2026-08-20T12:00:00.000Z');
    const db = viewSql({ ...accepted, consent_state: 'pending', expires_at: expiresAt });
    await expect(readImportOfferView(db, 'business-1', 'account-1')).resolves.toEqual({
      state: 'offer',
      expiresAt: expiresAt.toISOString(),
    });
  });

  it.each([
    [0, { state: 'empty' }],
    [7, { state: 'imported', count: 7 }],
  ] as const)('maps a completed run with count %i', async (count, expected) => {
    const db = viewSql({
      ...accepted,
      run_completed_at: new Date('2026-08-13T12:00:00.000Z'),
      imported_count: count,
    });
    await expect(readImportOfferView(db, 'business-1', 'account-1')).resolves.toEqual(expected);
  });
});

describe('recordImportDecisionAndEnqueue rejection classification', () => {
  it.each([
    ['missing row', null, 'no_offer'],
    ['pending without a deadline', { state: 'pending', decided_at: null, expires_at: null }, 'no_offer'],
    ['expired offer', { state: 'expired', decided_at: null, expires_at: new Date(0) }, 'expired'],
    ['prior decision', { state: 'accepted', decided_at: new Date(0), expires_at: new Date(1) }, 'already_answered'],
  ] as const)('%s', async (_name, current, expected) => {
    await expect(
      recordImportDecisionAndEnqueue(decisionSql(current), 'business-1', 'account-1', 'accepted'),
    ).resolves.toBe(expected);
  });
});
