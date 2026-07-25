import { describe, expect, it, vi } from 'vitest';

import { WITHHOLD_REASONS } from '../restraint-policy';
import {
  CONTACT_NAME_MAX,
  EVIDENCE_ROWS_PER_REASON,
  markBatchReviewed,
  readLatestBatch,
} from '../batch-view';

// Test doubles for the Postgres.js tagged-template client mirror the stub style
// of src/lib/solicitation/__tests__/uploads.test.ts. Results are returned in
// statement order, which readLatestBatch fixes deterministically:
// SET TRANSACTION -> Q1 latest batch -> Q2 contacts on file -> Q3 asks.
type QueryResult = unknown[];

interface MockTx {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult>;
  mock: { calls: unknown[][] };
}

function createMockSql(results: QueryResult[]) {
  const queued = [...results];
  const tx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(queued.shift() ?? []),
  );
  const sql = {
    begin: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
  return { sql: sql as never, tx: tx as unknown as MockTx };
}

/** A directly-callable tagged-template client (no transaction) for the writes. */
function createMockWriteSql(results: QueryResult[]) {
  const queued = [...results];
  const sql = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(queued.shift() ?? []),
  );
  return { sql: sql as never, calls: sql };
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

/** The nth statement issued on a mock client; fails loudly when absent. */
function statementAt(client: { mock: { calls: unknown[][] } }, index: number): unknown[] {
  const call = client.mock.calls[index];
  if (!call) throw new Error(`expected a statement at index ${index}`);
  return call;
}

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const BUSINESS_ID = 'b0000000-0000-0000-0000-000000000001';
const BATCH_ID = '01900000-0000-7000-8000-000000000001';

function withholdRow(overrides: {
  askId: string;
  reason: string;
  groupTotal: number;
  decidedAt?: string;
  evidence?: unknown;
}) {
  return {
    queued: 3,
    held: 42,
    evaluated: 45,
    askId: overrides.askId,
    contactId: `c-${overrides.askId}`,
    contactName: 'Ada Lovelace',
    decidedAt: overrides.decidedAt ?? '2026-07-20 10:00:00+00',
    evidence: overrides.evidence ?? {
      contact_id: `c-${overrides.askId}`,
      policy_version: 'restraint_v_watch_2026-07-23.1',
      decided_at: '2026-07-20T10:00:00Z',
      decision: 'withhold',
      reason: overrides.reason,
    },
    reason: overrides.reason,
    groupTotal: overrides.groupTotal,
  };
}

describe('readLatestBatch', () => {
  it('returns the most recent batch when a location has several', async () => {
    const { sql, tx } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 12 }],
      [{ queued: 2, held: 0, evaluated: 2, askId: null, contactId: null, contactName: null, decidedAt: null, evidence: null, reason: null, groupTotal: null }],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);

    // The "most recent" rule lives in SQL: newest created_at, UUIDv7 id as the
    // tie-break (created_at is not unique — migration 088).
    const latestBatchQuery = sqlText(statementAt(tx, 1));
    expect(latestBatchQuery).toContain('FROM solicitation_batches');
    expect(latestBatchQuery).toContain('ORDER BY created_at DESC, id DESC');
    expect(latestBatchQuery).toContain('LIMIT 1');
    expect(statementAt(tx, 1).slice(1)).toEqual([ACCOUNT_ID, BUSINESS_ID]);

    expect(view.state).toBe('built');
    if (view.state !== 'built') throw new Error('expected a built batch');
    expect(view.batchId).toBe(BATCH_ID);
    expect(view.builtAt).toBe('2026-07-20 11:00:00+00');
    expect(view.queued).toBe(2);
  });

  it('returns exact withheld counts per reason and at most 10 evidence rows per group', async () => {
    const staleRows = Array.from({ length: EVIDENCE_ROWS_PER_REASON }, (_, index) =>
      withholdRow({ askId: `stale-${index}`, reason: 'stale_visit', groupTotal: 40 }),
    );
    const bankedRows = [
      withholdRow({ askId: 'banked-0', reason: 'velocity_banked', groupTotal: 2 }),
      withholdRow({ askId: 'banked-1', reason: 'velocity_banked', groupTotal: 2 }),
    ];

    const { sql, tx } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1240 }],
      [...staleRows, ...bankedRows],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);
    if (view.state !== 'built') throw new Error('expected a built batch');

    const stale = view.groups.find((group) => group.reason === 'stale_visit');
    const banked = view.groups.find((group) => group.reason === 'velocity_banked');
    expect(stale).toEqual(expect.objectContaining({ total: 40 }));
    expect(stale?.sample).toHaveLength(EVIDENCE_ROWS_PER_REASON);
    expect(banked).toEqual(expect.objectContaining({ total: 2 }));
    expect(banked?.sample).toHaveLength(2);

    // Bounded by construction: the row cap and the name cap are bound
    // parameters, not post-filters.
    const asksQuery = statementAt(tx, 3);
    expect(asksQuery.slice(1)).toContain(EVIDENCE_ROWS_PER_REASON);
    expect(asksQuery.slice(1)).toContain(CONTACT_NAME_MAX);
    expect(view.held).toBe(42);
    expect(view.contactsOnFile).toBe(1240);
  });

  it('returns hasBatch false when the location\'s uploads completed before watch-mode was enabled', async () => {
    // The exact post-flip state: contacts exist from a completed upload, but
    // no batch was ever built because the flag was off when it finished.
    const { sql, tx } = createMockSql([[], [], [{ n: 1240 }]]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);

    expect(view).toEqual({ state: 'no_batch', contactsOnFile: 1240 });
    // Short-circuit: no ask query is issued when there is no batch.
    expect(tx.mock.calls).toHaveLength(3);
  });

  it('renders suppressed as an explicit zero-count group', async () => {
    const { sql } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 5 }],
      [withholdRow({ askId: 'stale-0', reason: 'stale_visit', groupTotal: 1 })],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.groups.map((group) => group.reason)).toEqual([...WITHHOLD_REASONS]);
    expect(view.groups.find((group) => group.reason === 'suppressed')).toEqual({
      reason: 'suppressed',
      total: 0,
      sample: [],
    });
  });

  it('reads every ask-derived number inside one read-only repeatable-read snapshot', async () => {
    const { sql, tx } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [{ queued: 0, held: 0, evaluated: 0, askId: null, contactId: null, contactName: null, decidedAt: null, evidence: null, reason: null, groupTotal: null }],
    ]);

    await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);

    expect(sqlText(statementAt(tx, 0))).toContain(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );
    // Funnel totals, per-reason totals and the sample all come from ONE
    // statement — splitting them lets a cascading contact DELETE tear the
    // hero away from the ledger.
    const asksQuery = sqlText(statementAt(tx, 3));
    expect(asksQuery).toContain('COUNT(*) FILTER (WHERE status = \'send\')::int');
    expect(asksQuery).toContain('ROW_NUMBER() OVER');
    expect(asksQuery).toContain('(COUNT(*) OVER (PARTITION BY withheld_reason))::int');
  });

  it('scopes contacts on file by account through the businesses join', async () => {
    const { sql, tx } = createMockSql([[], [], [{ n: 0 }]]);

    await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);

    // solicitation_contacts carries no account_id (migration 086) — the join
    // IS the account-scope check (invariant #8).
    const contactsQuery = sqlText(statementAt(tx, 2));
    expect(contactsQuery).toContain('JOIN businesses b ON b.id = c.business_id');
    expect(contactsQuery).toContain('b.account_id =');
    expect(statementAt(tx, 2).slice(1)).toEqual([BUSINESS_ID, ACCOUNT_ID]);
  });

  it('parses evidence that PgBouncer returned as a JSON string', async () => {
    const evidence = {
      contact_id: 'c-1',
      policy_version: 'restraint_v_watch_2026-07-23.1',
      decided_at: '2026-07-20T10:00:00Z',
      decision: 'withhold',
      reason: 'already_reviewed',
      review_id: 'r-1',
      review_date: '2026-05-02',
    };
    const { sql } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [
        withholdRow({
          askId: 'ar-0',
          reason: 'already_reviewed',
          groupTotal: 1,
          evidence: JSON.stringify(evidence),
        }),
      ],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);
    if (view.state !== 'built') throw new Error('expected a built batch');

    const group = view.groups.find((candidate) => candidate.reason === 'already_reviewed');
    expect(group?.sample[0]?.evidence).toEqual(evidence);
  });

  it('returns the building state while built_at is null', async () => {
    const { sql, tx } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: null, created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 7 }],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID);

    expect(view).toEqual({
      state: 'building',
      batchId: BATCH_ID,
      createdAt: '2026-07-20 10:00:00+00',
      contactsOnFile: 7,
    });
    expect(tx.mock.calls).toHaveLength(3);
  });
});

describe('markBatchReviewed', () => {
  it('records reviewed_at once and does not overwrite it on a second view', async () => {
    const { sql, calls } = createMockWriteSql([[{ id: BATCH_ID }], []]);

    const first = await markBatchReviewed(sql, ACCOUNT_ID, BUSINESS_ID, BATCH_ID);
    const second = await markBatchReviewed(sql, ACCOUNT_ID, BUSINESS_ID, BATCH_ID);

    expect(first).toBe(1);
    expect(second).toBe(0);

    const statement = sqlText(statementAt(calls, 0));
    expect(statement).toContain('UPDATE solicitation_batches');
    // First-write-wins, and both CHECK-constraint guards
    // (solicitation_batches_reviewed_after_built).
    expect(statement).toContain('reviewed_at IS NULL');
    expect(statement).toContain('built_at IS NOT NULL');
    expect(statement).toContain('GREATEST(NOW(), built_at)');
    expect(statementAt(calls, 0).slice(1)).toEqual([BATCH_ID, ACCOUNT_ID, BUSINESS_ID]);
  });
});
