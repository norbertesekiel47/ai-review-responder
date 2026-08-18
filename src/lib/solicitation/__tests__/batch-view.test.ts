import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTRAINT_POLICY_VERSION, WITHHOLD_REASONS } from '../restraint-policy';
import {
  CONTACT_NAME_MAX,
  EVIDENCE_ROWS_PER_REASON,
  markBatchReviewed,
  readLatestBatch,
} from '../batch-view';
import { peekAskRegenBudgetBatch } from '@/lib/costs/tracker';

// The send lane merges an advisory Redis peek (#860). Mocked here exactly as
// reviews-list.test.ts mocks the review-keyed sibling: the DEFAULT resolves to
// an EMPTY map, which is also the real function's fail-open answer, so every
// pre-existing case in this file keeps reading a lane with no counters.
vi.mock('@/lib/costs/tracker', () => ({
  peekAskRegenBudgetBatch: vi.fn(async () => new Map()),
}));

const mockPeekAskRegenBudgetBatch = vi.mocked(peekAskRegenBudgetBatch);

beforeEach(() => {
  mockPeekAskRegenBudgetBatch.mockResolvedValue(new Map());
});

// Test doubles for the Postgres.js tagged-template client mirror the stub style
// of src/lib/solicitation/__tests__/uploads.test.ts. Results are returned in
// statement order, which readLatestBatch fixes deterministically:
// SET TRANSACTION -> Q1 latest batch -> Q2 contacts on file -> Q3 asks
// -> Q4 attempts -> Q5 send-lane lifecycle + independent scalar counts
// -> Q6 the in-flight regeneration row (#860).
//
// Q4-Q6 are ALL gated on `options.sendLane` (#629) and reached only for a built
// batch, so a `{ sendLane: false }` read stops after Q3 and its fixture array
// holds four entries, not seven. Every added statement shifts every later
// result: this comment, the fixtures, and the statementAt() indices below are
// one fact and move together.
//
// A fixture array shorter than the statement count is fine — the stub yields
// `[]` past its end — so a send-lane case that says nothing about Q6 reads a
// batch with no regeneration in flight.
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
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: '2026-07-20T10:00:00Z',
      decision: 'withhold',
      reason: overrides.reason,
    },
    reason: overrides.reason,
    groupTotal: overrides.groupTotal,
  };
}

/**
 * Q5's lifecycle row (#629). Every timestamp is present twice on purpose: the
 * raw `Date` columns feed deriveBatchState, the `*Text` columns are what the
 * view ships — postgres.js truncates microseconds decoding timestamptz, so
 * only the ::text form is trustworthy on the wire.
 *
 * The readiness counts ride this row as independent scalar aggregates. Neither
 * child table is joined to the lifecycle row or to the other aggregate, so a
 * moderation-withheld row cannot multiply the pending-render relation.
 */
function laneRow(
  overrides: {
    approved_at?: Date | null;
    veto_deadline_at?: Date | null;
    halted_at?: Date | null;
    haltReason?: string | null;
    pendingRenders?: number;
    moderationWithheld?: number;
  } = {},
) {
  return {
    built_at: new Date('2026-07-20T11:00:00Z'),
    approved_at: overrides.approved_at ?? null,
    veto_deadline_at: overrides.veto_deadline_at ?? null,
    sending_started_at: null,
    send_closed_at: null,
    halted_at: overrides.halted_at ?? null,
    approvedAtText: overrides.approved_at?.toISOString() ?? null,
    vetoDeadlineAtText: overrides.veto_deadline_at?.toISOString() ?? null,
    haltedAtText: overrides.halted_at?.toISOString() ?? null,
    haltReason: overrides.haltReason ?? null,
    pendingRenders: overrides.pendingRenders ?? 0,
    moderationWithheld: overrides.moderationWithheld ?? 0,
  };
}

/**
 * A Q4 attempt row (#860's cases). Defaults to the plain `rendered` shape —
 * the only status that can be regenerated, so the only one that gets a budget
 * counter. Override `deliveryStatus`/`dispositionReason` for the rows that
 * must be EXCLUDED from the peek.
 */
function renderedAttemptRow(
  overrides: {
    outreachId?: string;
    askId?: string;
    deliveryStatus?: string;
    dispositionReason?: string | null;
  } = {},
) {
  return {
    outreachId: overrides.outreachId ?? 'o-1',
    askId: overrides.askId ?? 'ask-1',
    contactId: 'c-1',
    contactName: 'Dana Scully',
    attemptNo: 1,
    deliveryStatus: overrides.deliveryStatus ?? 'rendered',
    dispositionReason: overrides.dispositionReason ?? null,
    renderedAt: '2026-07-29 10:00:00+00',
    subject: 'Quick favour?',
    body: 'Would you mind leaving a review?',
    lintDetail: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    // `{}` not null: the column is JSONB NOT NULL and the empty object IS the
    // "no snapshot" state parseOutreachInterpolationInputs maps back to null.
    interpolationInputs: {},
  };
}

/** The Q3 aggregate for a batch with one send ask and nothing withheld. */
function emptyFunnelRow(queued = 1) {
  return {
    queued,
    held: 0,
    evaluated: queued,
    askId: null,
    contactId: null,
    contactName: null,
    decidedAt: null,
    evidence: null,
    reason: null,
    groupTotal: null,
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

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });

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

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });
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

  // Double-quoted deliberately: the promised-tests gate matches this title as a
  // literal substring, so a backslash-escaped apostrophe would never match.
  it("returns hasBatch false when the location's uploads completed before watch-mode was enabled", async () => {
    // The exact post-flip state: contacts exist from a completed upload, but
    // no batch was ever built because the flag was off when it finished.
    const { sql, tx } = createMockSql([[], [], [{ n: 1240 }]]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });

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

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });
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

    await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });

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

    await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });

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
      policy_version: RESTRAINT_POLICY_VERSION,
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

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });
    if (view.state !== 'built') throw new Error('expected a built batch');

    const group = view.groups.find((candidate) => candidate.reason === 'already_reviewed');
    expect(group?.sample[0]?.evidence).toEqual(evidence);
  });

  it('parses both widened no_consent evidence cases — (a) both fields null, (b) both populated (#620 §6.1)', async () => {
    const caseA = {
      contact_id: 'c-a',
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: '2026-07-30T10:00:00Z',
      decision: 'withhold',
      reason: 'no_consent',
      upload_id: null,
      attestation_version: null,
    };
    const caseB = {
      ...caseA,
      contact_id: 'c-b',
      upload_id: '01980000-0000-7000-8000-0000000000b1',
      attestation_version: 'consent_attestation_v1',
    };
    const { sql } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: '2026-07-30 11:00:00+00', created_at: '2026-07-30 10:00:00+00' }],
      [{ n: 2 }],
      [
        withholdRow({ askId: 'nc-a', reason: 'no_consent', groupTotal: 2, evidence: JSON.stringify(caseA) }),
        withholdRow({ askId: 'nc-b', reason: 'no_consent', groupTotal: 2, evidence: JSON.stringify(caseB) }),
      ],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });
    if (view.state !== 'built') throw new Error('expected a built batch');

    const group = view.groups.find((candidate) => candidate.reason === 'no_consent');
    expect(group?.sample.map((row) => row.evidence)).toEqual([caseA, caseB]);
  });

  it('returns the building state while built_at is null', async () => {
    const { sql, tx } = createMockSql([
      [],
      [{ id: BATCH_ID, built_at: null, created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 7 }],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });

    expect(view).toEqual({
      state: 'building',
      batchId: BATCH_ID,
      createdAt: '2026-07-20 10:00:00+00',
      contactsOnFile: 7,
    });
    expect(tx.mock.calls).toHaveLength(3);
  });

  it('omits every send-lane field from the batch view when send mode is off', async () => {
    // Both send-lane results are queued deliberately, with bytes in them: with
    // the flag off neither statement is issued, so neither result may reach
    // the view. This is the #628 narrowing — `attempts` used to be
    // unconditional, and a batch drafted while send mode was ON must stop
    // surfacing message bodies the moment the flag goes off.
    const { sql, tx } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 3 }],
      [emptyFunnelRow()],
      [
        {
          outreachId: 'o-1',
          askId: 'ask-1',
          contactId: 'c-1',
          contactName: 'Dana Scully',
          attemptNo: 1,
          deliveryStatus: 'rendered',
          dispositionReason: null,
          renderedAt: '2026-07-29 10:00:00+00',
          subject: 'FORBIDDEN-SUBJECT',
          body: 'FORBIDDEN-BODY',
          lintDetail: [],
          moderationStatus: 'clean',
          moderationDetail: {},
          interpolationInputs: null,
        },
      ],
      [laneRow({ pendingRenders: 4, moderationWithheld: 2 })],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: false });
    if (view.state !== 'built') throw new Error('expected a built batch');

    // `null` is the whole flag signal the browser gets (invariant #13) — there
    // is no NEXT_PUBLIC companion for it to read.
    expect(view.sendLane).toBeNull();
    expect(view.attempts).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('FORBIDDEN');

    // The funnel is untouched: only the send lane is gated.
    expect(view.queued).toBe(1);
    expect(view.contactsOnFile).toBe(3);

    // Gated at the QUERY, not at the mapper: the read stops after the asks
    // aggregate, so neither queued send-lane result is ever consumed.
    expect(tx.mock.calls).toHaveLength(4);
  });

  it('reports a moderation_high attempt without its subject or body', async () => {
    const { sql } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [emptyFunnelRow()],
      [
        {
          outreachId: 'o-1',
          askId: 'ask-1',
          contactId: 'c-1',
          contactName: 'Dana Scully',
          attemptNo: 1,
          deliveryStatus: 'withheld',
          dispositionReason: 'moderation_high',
          renderedAt: '2026-07-29 10:00:00+00',
          subject: 'FORBIDDEN-SUBJECT',
          body: 'FORBIDDEN-BODY',
          lintDetail: ['incentive_language'],
          moderationStatus: 'flagged',
          moderationDetail: { sexual: 0.99 },
          interpolationInputs: { visit_note: 'FORBIDDEN-NOTE' },
        },
      ],
      [laneRow({ moderationWithheld: 1 })],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    // Exact equality: the redacted arm carries the marker and NOTHING
    // content-shaped (SPEC §3.3).
    expect(view.attempts).toEqual([
      {
        outreachId: 'o-1',
        askId: 'ask-1',
        contactId: 'c-1',
        contactName: 'Dana Scully',
        attemptNo: 1,
        deliveryStatus: 'withheld',
        dispositionReason: 'moderation_high',
        renderedAt: '2026-07-29 10:00:00+00',
        redacted: true,
      },
    ]);

    // Absent KEYS, not undefined values — an `undefined`-valued key still
    // tells a reader of the payload that the field exists.
    const attempt = view.attempts[0];
    if (!attempt) throw new Error('expected one attempt');
    expect(Object.keys(attempt)).not.toContain('subject');
    expect(Object.keys(attempt)).not.toContain('body');
    expect(JSON.stringify(view)).not.toContain('FORBIDDEN');

    // A COUNT is the owner's ONLY signal that anything was held (D6a).
    expect(view.sendLane?.moderationWithheld).toBe(1);
  });

  it('aggregates send-lane counts in independent scalar subqueries without a child-table cross product', async () => {
    // The regression this pins: Q5 used to LEFT JOIN solicitation_asks, then
    // solicitation_outreach correlated to the ask, then solicitation_outreach
    // AGAIN correlated only to the batch. The third join multiplied every
    // (ask, outreach) pair by every moderation-withheld row, and only
    // COUNT(DISTINCT …) made the answers come out right — at full batch size
    // the intermediate reached tens of millions of rows on the one screen that
    // has to stay available. Independent scalar aggregates cannot create that
    // child-table cross product.
    const { sql, tx } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 9 }],
      [emptyFunnelRow(7)],
      [], // no attempts
      [laneRow({ pendingRenders: 7, moderationWithheld: 2 })],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.sendLane?.pendingRenders).toBe(7);
    expect(view.sendLane?.moderationWithheld).toBe(2);
    expect(view.sendLane?.ready).toBe(false);

    // Q5 reads the lifecycle row and both counts, but each child relation is
    // confined to its own scalar aggregate. Reintroducing the old cross
    // product means joining either child to `b` or using COUNT(DISTINCT), which
    // these assertions refuse.
    const laneQuery = sqlText(statementAt(tx, 5));
    expect(laneQuery).toContain('FROM solicitation_batches b');
    expect(laneQuery).toContain('SELECT COUNT(*)::int FROM solicitation_asks a');
    expect(laneQuery).toContain('AND NOT EXISTS ( SELECT 1 FROM solicitation_outreach o');
    expect(laneQuery).toContain('SELECT COUNT(*)::int FROM solicitation_outreach mo');
    expect(laneQuery).not.toContain('LEFT JOIN solicitation_asks');
    expect(laneQuery).not.toContain('LEFT JOIN solicitation_outreach');
    expect(laneQuery).not.toContain('COUNT(DISTINCT');
    expect(laneQuery).not.toContain('GROUP BY');
    expect(statementAt(tx, 5).slice(1)).toEqual([
      ACCOUNT_ID, BUSINESS_ID, 'moderation_high', BATCH_ID, ACCOUNT_ID, BUSINESS_ID,
    ]);

    // Six tenant-scoped statements plus Q6, the advisory in-flight read (#860).
    expect(tx.mock.calls).toHaveLength(7);
  });

  it('reports the halt latch reason verbatim from the closed five-reason set', async () => {
    // `haltReason` is typed `HaltReason | null`, not `string | null`: three of
    // the five reasons are NOT owner-caused, so a consumer that branches on it
    // must be able to tell `admin_halt` from `owner_halt` exhaustively.
    const haltedAt = new Date('2026-07-21T09:00:00Z');
    const { sql } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [emptyFunnelRow()],
      [],
      [laneRow({ halted_at: haltedAt, haltReason: 'admin_halt' })],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.sendLane?.batchState).toBe('halted');
    expect(view.sendLane?.haltReason).toBe('admin_halt');
    expect(view.sendLane?.haltedAt).toBe(haltedAt.toISOString());
  });

  it('reports the ask id of an in-flight per-ask regeneration on the send lane', async () => {
    const { sql, tx } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [emptyFunnelRow()],
      [renderedAttemptRow()],
      [laneRow()],
      // Q6 — a per-ask regeneration row: its payload carries `ask_id`.
      [{ askId: 'ask-1' }],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.sendLane?.regeneratingAskId).toBe('ask-1');

    // The read is the OUTBOX row itself, not a derived flag: same row the
    // enqueue's ON CONFLICT dedup refuses against, so the panel and the
    // `already_in_flight` refusal cannot disagree after a reload.
    const inFlightQuery = sqlText(statementAt(tx, 6));
    expect(inFlightQuery).toContain('FROM job_outbox');
    expect(inFlightQuery).toContain(`SELECT payload->>'ask_id'`);
    expect(inFlightQuery).toContain(`status IN ('pending', 'dispatching', 'dispatched')`);
    expect(statementAt(tx, 6).slice(1)).toEqual(['generate_solicitation_asks', BATCH_ID]);

    // D3: NO tenant predicate and no join to a tenant table, deliberately.
    // `job_outbox` is absent from scripts/ci/tenant-tables.ts, so this
    // statement is unaudited by design; the batch id was already proven by the
    // scoped lifecycle read. Joining solicitation_batches to "look scoped"
    // would make it auditable and demand keys its proof does not need.
    expect(inFlightQuery).not.toContain('solicitation_batches');
    expect(inFlightQuery).not.toContain('account_id');
    expect(inFlightQuery).not.toContain('business_id');
  });

  it('reports no in-flight regeneration for a whole-batch generation row', async () => {
    // A whole-batch generation row's payload has no `ask_id`, so
    // `payload->>'ask_id'` is SQL NULL even though the row IS in flight. The
    // panel reads null as "preparing" and must not spin any individual row.
    const { sql } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [emptyFunnelRow()],
      [renderedAttemptRow()],
      [laneRow()],
      [{ askId: null }],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.sendLane?.regeneratingAskId).toBeNull();
  });

  it('carries the per-ask regenerate budget on the send lane, omitting asks whose counter is unknown', async () => {
    const renderedAskId = 'ask-rendered';
    const unknownAskId = 'ask-withheld';
    mockPeekAskRegenBudgetBatch.mockResolvedValue(
      new Map([[renderedAskId, { used: 1, limit: 3, remaining: 2 }]]),
    );

    const { sql } = createMockSql([
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 2 }],
      [emptyFunnelRow(2)],
      [
        renderedAttemptRow({ outreachId: 'o-1', askId: renderedAskId }),
        renderedAttemptRow({
          outreachId: 'o-2',
          askId: unknownAskId,
          deliveryStatus: 'withheld',
          dispositionReason: 'lint_failed',
        }),
      ],
      [laneRow()],
      [],
    ]);

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.sendLane?.regenBudgets[renderedAskId]).toEqual({
      used: 1,
      limit: 3,
      remaining: 2,
    });

    // UNKNOWN is an ABSENT KEY, never `{ remaining: 0 }` — inverting that
    // would disable every control during an Upstash outage, and a total Redis
    // failure resolves the peek to an EMPTY map on purpose.
    expect(view.sendLane?.regenBudgets[unknownAskId]).toBeUndefined();
    expect(Object.keys(view.sendLane?.regenBudgets ?? {})).toEqual([renderedAskId]);

    // Only RENDERED attempts are peeked: a withheld row ends the attempt line
    // (rule 6), so it can never be regenerated and has no counter to read.
    expect(mockPeekAskRegenBudgetBatch).toHaveBeenCalledWith([renderedAskId]);
  });

  it('peeks the per-ask regenerate budget only after the read transaction has closed', async () => {
    // Round-1 R3. The peek is an Upstash MGET; awaiting it inside
    // `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` held an
    // admission-gated pooled Postgres connection across a cross-provider round
    // trip on every built-batch GET and every 2s poll.
    //
    // The oracle is the TRANSACTION'S LIFETIME, not statement ordering: an
    // ordering assertion ("the peek comes after the last statement") passes
    // just as happily when the peek is the final await INSIDE the block, which
    // is precisely the defect. So the stub records whether `sql.begin`'s
    // callback was still running when the peek fired.
    const queued: QueryResult[] = [
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 1 }],
      [emptyFunnelRow(1)],
      [renderedAttemptRow({ outreachId: 'o-1', askId: 'ask-1' })],
      [laneRow()],
      [], // Q6 — no regeneration in flight
    ];
    const tx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(queued.shift() ?? []),
    );

    let txOpen = false;
    const peekedWhileTxOpen: boolean[] = [];
    mockPeekAskRegenBudgetBatch.mockImplementation(async () => {
      peekedWhileTxOpen.push(txOpen);
      return new Map([['ask-1', { used: 1, limit: 3, remaining: 2 }]]);
    });

    const sql = {
      begin: async (callback: (handle: unknown) => Promise<unknown>) => {
        txOpen = true;
        try {
          return await callback(tx);
        } finally {
          txOpen = false;
        }
      },
    } as never;

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    // Peeked exactly once, and not while a pooled connection was held.
    expect(peekedWhileTxOpen).toEqual([false]);
    // And the counter still reaches the lane — the move must not silently drop
    // the fact it relocated.
    expect(view.sendLane?.regenBudgets['ask-1']).toEqual({ used: 1, limit: 3, remaining: 2 });
  });
});

describe('readLatestBatch attempts join (#628)', () => {
  const INTERPOLATION_INPUTS = {
    contact_first_name: 'Dana',
    business_name: 'Ridgeline Plumbing',
    days_since_visit_bucket: 'last week',
    vertical: 'home_services',
    visit_note: null,
    note_disposition: 'absent',
  };

  function attemptDbRow(overrides: {
    outreachId?: string;
    askId?: string;
    attemptNo?: number;
    deliveryStatus?: string;
    dispositionReason?: string | null;
    subject?: string | null;
    body?: string | null;
    lintDetail?: unknown;
    moderationStatus?: string;
    moderationDetail?: unknown;
    interpolationInputs?: unknown;
  }) {
    return {
      outreachId: overrides.outreachId ?? 'o-1',
      askId: overrides.askId ?? 'ask-1',
      contactId: 'c-1',
      contactName: 'Dana Scully',
      attemptNo: overrides.attemptNo ?? 1,
      deliveryStatus: overrides.deliveryStatus ?? 'rendered',
      dispositionReason: overrides.dispositionReason ?? null,
      renderedAt: '2026-07-29 10:00:00+00',
      subject: overrides.subject ?? null,
      body: overrides.body ?? null,
      lintDetail: overrides.lintDetail ?? [],
      moderationStatus: overrides.moderationStatus ?? 'clean',
      moderationDetail: overrides.moderationDetail ?? {},
      interpolationInputs: overrides.interpolationInputs ?? INTERPOLATION_INPUTS,
    };
  }

  // Six entries because this block reads with `{ sendLane: true }`: the
  // attempts join is Q4 and the lifecycle row plus its two independent scalar
  // counts is Q5 (#629/#859). Dropping the trailing laneRow() would leave Q5
  // unfed and the read would throw.
  function builtBatchResults(attemptRows: unknown[]): QueryResult[] {
    return [
      [], // SET TRANSACTION
      [{ id: BATCH_ID, built_at: '2026-07-20 11:00:00+00', created_at: '2026-07-20 10:00:00+00' }],
      [{ n: 3 }],
      [emptyFunnelRow()],
      attemptRows,
      [laneRow()],
    ];
  }

  it('exposes a drafted attempt with its subject and body bytes and attempt number', async () => {
    const { sql, tx } = createMockSql(builtBatchResults([
      attemptDbRow({
        attemptNo: 2,
        deliveryStatus: 'rendered',
        subject: 'Thanks for having us out',
        body: 'Hi Dana — thanks for choosing Ridgeline Plumbing.',
      }),
    ]));

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    expect(view.attempts).toEqual([
      {
        outreachId: 'o-1',
        askId: 'ask-1',
        contactId: 'c-1',
        contactName: 'Dana Scully',
        attemptNo: 2,
        deliveryStatus: 'rendered',
        dispositionReason: null,
        renderedAt: '2026-07-29 10:00:00+00',
        redacted: false,
        subject: 'Thanks for having us out',
        body: 'Hi Dana — thanks for choosing Ridgeline Plumbing.',
        lintClasses: [],
        moderationStatus: 'clean',
        moderationDetail: {},
        interpolationInputs: INTERPOLATION_INPUTS,
      },
    ]);

    // The current attempt is `delivery_status != 'cancelled'` — NOT the
    // live-only set: withheld rows are terminal yet owner-visible.
    const attemptsQuery = sqlText(statementAt(tx, 4));
    expect(attemptsQuery).toContain('FROM solicitation_outreach');
    expect(attemptsQuery).toContain("o.delivery_status <> 'cancelled'");
    // Tenant scope rides the query itself (invariant #8).
    expect(statementAt(tx, 4).slice(1)).toEqual(
      expect.arrayContaining([ACCOUNT_ID, BUSINESS_ID, BATCH_ID]),
    );
  });

  it('redacts a moderation_high attempt to a marker even when bytes reach the mapper', async () => {
    // Feed bytes deliberately: even if the SQL-level CASE redaction were
    // dropped, the mapper must still never let moderation_high bytes into the
    // view (SPEC §3.3 — the owner sees count + reason only).
    const { sql, tx } = createMockSql(builtBatchResults([
      attemptDbRow({
        deliveryStatus: 'withheld',
        dispositionReason: 'moderation_high',
        subject: 'FORBIDDEN-SUBJECT',
        body: 'FORBIDDEN-BODY',
        moderationStatus: 'flagged',
        moderationDetail: { sexual: 0.99 },
        interpolationInputs: { ...INTERPOLATION_INPUTS, visit_note: 'FORBIDDEN-NOTE' },
      }),
    ]));

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    // Exact equality: the redacted arm carries the marker and NOTHING content-shaped.
    expect(view.attempts).toEqual([
      {
        outreachId: 'o-1',
        askId: 'ask-1',
        contactId: 'c-1',
        contactName: 'Dana Scully',
        attemptNo: 1,
        deliveryStatus: 'withheld',
        dispositionReason: 'moderation_high',
        renderedAt: '2026-07-29 10:00:00+00',
        redacted: true,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain('FORBIDDEN');

    // First layer: the bytes are dropped in SQL — the CASE keeps them from
    // ever leaving the database for a moderation_high row.
    const attemptsQuery = sqlText(statementAt(tx, 4));
    expect(attemptsQuery).toContain('CASE WHEN o.disposition_reason = ? THEN NULL ELSE o.rendered_subject END');
    expect(attemptsQuery).toContain('CASE WHEN o.disposition_reason = ? THEN NULL ELSE o.rendered_body END');
    expect(statementAt(tx, 4).slice(1)).toContain('moderation_high');
  });

  it('exposes withheld lint_failed text and matched classes so the block teaches the owner', async () => {
    const { sql } = createMockSql(builtBatchResults([
      attemptDbRow({
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
        subject: 'A special thank-you',
        body: 'Mention us in your review for 10% off.',
        // PgBouncer can hand JSONB back as strings — the Task 7 parsers own
        // that carve-out; this exercises them through the read model.
        lintDetail: JSON.stringify(['incentive_language', 'review_steering']),
        moderationDetail: JSON.stringify({}),
        interpolationInputs: JSON.stringify(INTERPOLATION_INPUTS),
      }),
    ]));

    const view = await readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true });
    if (view.state !== 'built') throw new Error('expected a built batch');

    const attempt = view.attempts[0];
    if (!attempt || attempt.redacted) throw new Error('expected an unredacted attempt');
    expect(attempt.subject).toBe('A special thank-you');
    expect(attempt.body).toBe('Mention us in your review for 10% off.');
    expect(attempt.lintClasses).toEqual(['incentive_language', 'review_steering']);
    expect(attempt.dispositionReason).toBe('lint_failed');
    expect(attempt.interpolationInputs).toEqual(INTERPOLATION_INPUTS);
  });

  it('throws when an ask carries two non-cancelled attempts', async () => {
    // The non-cancelled predicate leans on two domain invariants (withheld
    // ends the attempt line; supersede swaps atomically), so a second row is
    // corruption and must fail loudly, not render twice.
    const { sql } = createMockSql(builtBatchResults([
      attemptDbRow({ outreachId: 'o-1', askId: 'ask-1', attemptNo: 1 }),
      attemptDbRow({ outreachId: 'o-2', askId: 'ask-1', attemptNo: 2 }),
    ]));

    await expect(readLatestBatch(sql, ACCOUNT_ID, BUSINESS_ID, { sendLane: true })).rejects.toThrow(
      /more than one non-cancelled outreach attempt/,
    );
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
