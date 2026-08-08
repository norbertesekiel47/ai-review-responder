// worker/jobs/zernio/__tests__/job-eligibility.test.ts
//
// T0 EVAL suite for #679 — the fail-closed Import consent gate (spec §5.3,
// plan §3 T3). Titles are the intake's `tests_to_add` VERBATIM (promised-tests
// gate), authored FAILING before any implementation.
//
// `job-eligibility.ts` has had no unit suite until now: it was covered only
// through the two worker suites. `guardImportConsent` gets one because three of
// its properties are invisible from a worker-level test — the derived-state
// SELECT is the SHARED fragment rather than a re-spelling, the SELECT is scoped
// to the INPUT business id, and `markOutboxCompleted` rides the SAME transaction
// as the consent read.
//
// That last one is the round-1 blocking defect, not tidiness. Without
// serialization a guard reads `pending` from an in-flight hand-inserted row, the
// owner accepts, the acceptance transaction's
// `NOT EXISTS (… status IN ('pending','dispatching','dispatched'))` sees that
// row still in flight and inserts no replacement, and the guard then completes
// the row as a skip — leaving accepted consent with NO runnable
// zernio_initial_backfill job and nothing to retry it. The unit half is pinned
// here (`inTransaction`); the real interleaving is pinned against Postgres in
// `job-eligibility.integration.test.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  resetMockSql,
  mkTaggedResult,
  mockMarkOutboxCompleted,
  completionCalls,
  mockLogger,
} = await vi.hoisted(async () => {
  const { createMockSql, mkTaggedResult, mockWorkerLogger } =
    await import('../../../__tests__/helpers/mock-sql');
  const harness = createMockSql();

  /**
   * Every `markOutboxCompleted` invocation WITH the transaction context it was
   * made in. `sqlCalls` carries `inTransaction` per query, but the completion
   * is a mocked collaborator and issues no query of its own — so the flag has
   * to be sampled at call time, which is exactly the mock-sql helper's
   * documented `isInTransaction()` use.
   *
   * The EXECUTOR the completion was handed is deliberately not recorded.
   * `mock-sql.ts:99-103` invokes the `sql.begin` callback with the same mock
   * object, so `exec === mockSql` holds whether the implementation passes `tx`
   * or the outer client — an assertion on it cannot fail for the property it
   * would name. `inTransaction` is the property with teeth here; that the
   * completion rides the guard's OWN transaction (and therefore its
   * `businesses` row lock) is proven against real Postgres in
   * `job-eligibility.integration.test.ts`.
   */
  const completionCalls: {
    outboxId: string;
    attempt: number | undefined;
    inTransaction: boolean;
  }[] = [];

  return {
    ...harness,
    mkTaggedResult,
    completionCalls,
    mockMarkOutboxCompleted: vi.fn(
      (_exec: unknown, outboxId: string, attempt: number | undefined) => {
        completionCalls.push({
          outboxId,
          attempt,
          inTransaction: harness.isInTransaction(),
        });
      },
    ),
    mockLogger: mockWorkerLogger(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import { guardImportConsent, type ImportConsentGate } from '../job-eligibility';
import { importConsentStateSql } from '../../../../src/lib/reviews/import-consent';

// A real named import, deliberately. Through the eval commit this was a widened
// namespace cast so the file could typecheck before `guardImportConsent` existed
// (deviations D11); the scaffold was removed once T3 landed. A permanent
// `as unknown as` would typecheck these tests against a LOCALLY DECLARED shape
// instead of the shipped signature, so a change to the guard's parameters would
// compile clean here and surface only at run time. Same failure class as D10's
// `consentGuardShipped`: an eval-time scaffold that silently decouples a test
// from the code it exists to pin.

// ── Fixtures ─────────────────────────────────────────────────────────────

const BUSINESS_ID = '3f8a1c62-6d51-4d9e-9a7b-2c4e8f0b1d33';
const OTHER_BUSINESS_ID = '9c2d4e71-8b30-4a15-bf62-71a0d5c9e488';
const OUTBOX_ID = 'outbox-consent-1';

const sqlArg = mockSql as unknown as Sql;

/** The derived state Postgres would return for the guard's SELECT. */
type QueuedConsentState = 'accepted' | 'declined' | 'pending' | 'expired';

/** Queue the guard's one consent read. `null` = no `businesses` row at all. */
function pushConsentState(state: QueuedConsentState | null): void {
  sqlReturnQueue.push(mkTaggedResult(state === null ? [] : [{ state }]));
}

function runGuard(
  opts: { attempt?: number; businessId?: string } = {},
): Promise<ImportConsentGate> {
  return guardImportConsent(sqlArg, {
    businessId: opts.businessId ?? BUSINESS_ID,
    outboxId: OUTBOX_ID,
    attempt: opts.attempt,
    logger: mockLogger,
  });
}

/** The shared fragment's own text, as the mock renders it. */
function sharedFragmentText(): string {
  return (importConsentStateSql(sqlArg) as unknown as { text: string }).text;
}

/**
 * The fragment's `WHEN … THEN 'expired'` arm ALONE.
 *
 * Bounded on purpose: the question a NULL deadline turns on is WHICH arm the
 * null-guard sits in, and a `toContain` over the whole fragment (or over the
 * guard's whole query, as this file previously did) passes with the conjunct
 * moved anywhere at all — including into a WHERE clause, where it would change
 * which rows the guard sees rather than which state they derive to.
 */
function expiredArmOf(fragmentText: string): string {
  const start = fragmentText.indexOf('WHEN');
  const end = fragmentText.indexOf("THEN 'expired'");
  expect(start, 'the shared fragment has no WHEN arm').toBeGreaterThan(-1);
  expect(end, "the shared fragment has no THEN 'expired' arm").toBeGreaterThan(start);
  return fragmentText.slice(start, end);
}

function consentRead() {
  const call = sqlCalls[0];
  expect(call, 'the guard issued no query').toBeDefined();
  return call!;
}

beforeEach(() => {
  // `vi.clearAllMocks()` clears recorded calls but KEEPS the implementation a
  // mock was constructed with, so the completion recorder above survives — if
  // it did not, the two transaction assertions would quietly go vacuous.
  vi.clearAllMocks();
  resetMockSql();
  completionCalls.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('guardImportConsent (#679 spec §5.3 fail-closed gate)', () => {
  it('guardImportConsent proceeds when import_decision is accepted', async () => {
    pushConsentState('accepted');

    expect(await runGuard()).toEqual({ kind: 'proceed' });

    // Proceeding is the ONLY path that must not touch the outbox row: the
    // worker completes it itself after the import.
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockLogger.log).not.toHaveBeenCalled();
  });

  it('guardImportConsent blocks a declined business and completes the outbox row', async () => {
    pushConsentState('declined');

    expect(await runGuard({ attempt: 3 })).toEqual({ kind: 'skipped' });

    // Skip-as-success (job-eligibility's existing convention): the row is
    // COMPLETED, never failed, thrown or retried — a declined import must not
    // churn the queue forever.
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
    expect(completionCalls[0]!.outboxId).toBe(OUTBOX_ID);
    expect(completionCalls[0]!.attempt).toBe(3);
  });

  it('guardImportConsent blocks a pending business whose offer has not expired', async () => {
    // A live offer is not consent. Under D9 an enqueue only exists after a Yes,
    // so a runnable job against a `pending` row is a hand-insert or a bug —
    // and either way it must import nothing.
    pushConsentState('pending');

    expect(await runGuard()).toEqual({ kind: 'skipped' });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('guardImportConsent blocks a pending business whose offer deadline has passed', async () => {
    // `expired` is DERIVED, never stored (#670): Postgres returns it from the
    // shared fragment's CASE for a pending row past its deadline. The guard
    // sees a fourth value it must refuse, not a fourth column to interpret.
    pushConsentState('expired');

    expect(await runGuard()).toEqual({ kind: 'skipped' });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('guardImportConsent blocks a pending business whose offer deadline is NULL', async () => {
    // Migration 100 DEFAULTs every business row to `pending` + NULL deadline,
    // so this is the population the fail-closed gate exists for.
    //
    // WHAT THIS SEAM CAN CONSTRUCT, AND WHERE THE CASE ACTUALLY LIVES (round-1
    // review). The guard consumes the DERIVED state and never sees the deadline
    // column, so `pushConsentState('pending')` on its own is byte-identical to
    // the "has not expired" test above — a queued literal cannot express a NULL
    // deadline, and a test that only queued one would advertise a case it never
    // built. The NULL is decided one layer down, in the shared fragment, so that
    // is where this pins it: the `'expired'` arm carries the
    // `import_offer_expires_at IS NOT NULL` conjunct, so a NULL deadline cannot
    // enter that arm and falls through to `ELSE b.import_decision` — which is
    // precisely why `pending` is the state this population arrives as.
    //
    // Assert the derivation FIRST, then that the guard's query is that
    // derivation, then the block. Reordered or dropped, the chain breaks: a
    // guard that read `import_offer_expires_at` into JS and branched there would
    // re-derive expiry (the second spelling spec §5.3 forbids) and would no
    // longer contain the fragment at all.
    const fragment = sharedFragmentText();
    expect(expiredArmOf(fragment)).toContain('b.import_offer_expires_at IS NOT NULL');
    expect(fragment).toContain('ELSE b.import_decision');

    pushConsentState('pending');

    expect(await runGuard()).toEqual({ kind: 'skipped' });
    expect(consentRead().text).toContain(fragment);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
  });

  it('guardImportConsent blocks a business row that does not exist', async () => {
    pushConsentState(null);

    expect(await runGuard()).toEqual({ kind: 'skipped' });
    expect(mockMarkOutboxCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'missing', business_id: BUSINESS_ID }),
    );
  });

  it('guardImportConsent derives expiry from Postgres now(), never a JS Date', async () => {
    pushConsentState('pending');

    await runGuard();

    const read = consentRead();
    // The CASE is the SHARED fragment verbatim — imported from
    // src/lib/reviews/import-consent.ts, never re-spelled here (spec §5.3's
    // single-owner rule). Comparing against the fragment's own rendered text is
    // the only assertion a re-typed copy cannot satisfy by accident.
    expect(read.text).toContain(sharedFragmentText());
    expect(read.text).toContain('now()');
    // postgres.js decodes timestamptz into a JS Date and silently truncates
    // MICROSECONDS to milliseconds (CLAUDE.md gotcha). A guard that bound a JS
    // clock into the deadline comparison could mis-order by <1ms against a
    // deadline written by Postgres. No Date may cross this boundary at all.
    for (const value of read.values) {
      expect(value).not.toBeInstanceOf(Date);
    }
  });

  it('guardImportConsent logs the blocked consent state as its skip reason', async () => {
    // The intake's `observability` item 1: this line is the WHOLE diagnostic
    // loop for "the import never ran". Shaped like the existing
    // SKIP_REASON_ARCHIVED_LOCATION line — reason + business_id, no review text
    // — and the value of the signal is telling the blocked states apart, so all
    // three are asserted rather than one.
    for (const state of ['declined', 'pending', 'expired'] as const) {
      vi.clearAllMocks();
      resetMockSql();
      completionCalls.length = 0;
      pushConsentState(state);

      expect(await runGuard()).toEqual({ kind: 'skipped' });

      expect(mockLogger.log, `no block line for ${state}`).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ reason: state, business_id: BUSINESS_ID }),
      );
    }
  });

  it('guardImportConsent proceeds for an accepted business whose offer deadline has passed', async () => {
    // An answered decision OUTRANKS its deadline — the fragment returns the
    // stored value unchanged for accepted/declined rows whatever the deadline.
    // If the guard re-checked expiry itself, a customer who said yes on day 1
    // would be refused on day 8.
    pushConsentState('accepted');

    expect(await runGuard()).toEqual({ kind: 'proceed' });

    // ONE query, and no second read of the deadline: the decision is the
    // derived state alone. A guard that also selected import_offer_expires_at
    // and compared it in JS would pass every state test above and fail here.
    expect(sqlCalls).toHaveLength(1);
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('guardImportConsent scopes the derived-state SELECT to b.id = businessId', async () => {
    // Both halves matter, and neither alone is enough: every state test above
    // passes against an UNSCOPED query that merely returns the queued row, and
    // a `b.id = …` predicate bound to the wrong variable reads identically in
    // the SQL text. Assert the predicate AND the bound value.
    pushConsentState('accepted');

    await runGuard({ businessId: OTHER_BUSINESS_ID });

    const read = consentRead();
    expect(read.text).toContain('FROM businesses b');
    expect(read.text).toMatch(/b\.id = \?/);
    expect(read.values).toContain(OTHER_BUSINESS_ID);
    expect(read.values).not.toContain(BUSINESS_ID);
  });

  it('guardImportConsent completes the outbox row inside the same transaction as its consent read', async () => {
    // THE ROUND-1 BLOCKING DEFECT, unit half. An unserialized guard loses an
    // accepted Review import permanently (see the file header). The fix is
    // serialization: one sql.begin holding the businesses row FOR UPDATE, with
    // markOutboxCompleted issued on the TRANSACTION handle. `SELECT … FOR
    // UPDATE` outside sql.begin() is a NO-OP under Supabase's transaction
    // pooling (CLAUDE.md gotcha), so both halves are load-bearing.
    pushConsentState('pending');

    expect(await runGuard()).toEqual({ kind: 'skipped' });

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    const read = consentRead();
    expect(read.inTransaction).toBe(true);
    expect(read.text).toContain('FOR UPDATE');
    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0]!.inTransaction).toBe(true);
    // No assertion on WHICH executor the completion was handed: the mock gives
    // the callback the same object either way, so `exec === mockSql` cannot
    // fail. See the `completionCalls` note above — executor identity is pinned
    // against real Postgres in the integration suite, by lock contention.
  });
});
