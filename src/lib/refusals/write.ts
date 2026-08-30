/**
 * The Refusal ledger's ONE writer — every `refusal_events` row in the codebase
 * is this statement (map #994, schema locked in #1001, table shipped by #1008 as
 * `supabase/migrations/116_refusal_events.sql`). Plan:
 * `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md` §1–§3.
 * Terms: `CONTEXT.md` → **Refusal**, **Refusal source**, **Refusal category**
 * (LOCKED).
 *
 * MODELLED ON `src/lib/audit/log.ts`, and for the same reason: one helper, one
 * INSERT, the DB client as an explicit parameter (invariant #15), the id minted
 * by the writer. `writeAccountAuditLog` is the single audit writer for the whole
 * codebase and it is a bare exported function — so is this.
 *
 * NO SEAM, DELIBERATELY. There is no `RefusalLedger` interface, no
 * `getRefusalLedger()` factory and no injected writer. `ReviewPublisher` earned
 * its factory because a second adapter (direct Google Business Profile) is
 * planned; nothing varies here. Eleven call sites land across #1009–#1013 and
 * every one of them writes the same table the same way.
 *
 * WHAT A CALLER MUST KNOW, beyond the type signature:
 *
 *   1. It runs INSIDE the caller's deciding transaction and opens none of its
 *      own. That is what makes `'transaction_time'` mean what it says.
 *   2. It NEVER raises on a duplicate subject — `ON CONFLICT … DO NOTHING`.
 *   3. It MAY return without writing — the kill switch. The caller cannot
 *      detect this and must not try to.
 *   4. It DOES raise on a CHECK violation, which is a writer bug. Not caught.
 *
 * WHAT IT DOES NOT DO, and why each omission is a decision:
 *
 *   * It does not CATCH the insert error. Migration 116's five CHECKs each name
 *     a bug rather than a preference, and a violation aborts the deciding
 *     transaction. BE EXACT ABOUT WHAT A CATCH WOULD BUY, because an earlier
 *     wording of this bullet overclaimed it: a catch would NOT save the
 *     transaction. postgres.js records an `uncaughtError` per query inside
 *     `scope()`'s `handler` (`postgres/src/index.js:291-296`) and rethrows it
 *     after the callback returns (`:265-266`), so the deciding transaction
 *     fails either way. What a catch WOULD hide is the error from THIS HELPER'S
 *     OWN CALLER — the decision dies regardless, but the writer bug that killed
 *     it stops being the thing the caller sees and raises, and the ledger is
 *     precisely the place that cannot report it instead. The lever against a
 *     writer bug is the kill switch — the ticket says so in those words. The
 *     `.claude/CLAUDE.md` rule about best-effort work needing its own
 *     `try/catch` is about work AFTER a primary side effect; this write is
 *     INSIDE the decision, not beside it.
 *   * It does not REVALIDATE its input at run time. `WriteRefusalEventInput`
 *     projects C1–C5 into the type system and migration 116 still enforces them
 *     in storage; a THIRD, run-time copy would be the second authority that
 *     drifts — the precise defect #1001 cites when it declines to CHECK the 22
 *     `AutoApprovalBlockReason` members.
 *   * It does not READ. The read path is #1014.
 *
 * THE `try/catch` DECISIONS BELOW LOOK CONTRADICTORY AND ARE NOT. The ledger
 * INSERT is not caught because it CARRIES the fact. Both transports of the
 * disabled-ledger warning are caught because they merely OBSERVE it. Facts
 * propagate; observations swallow.
 */

import * as Sentry from '@sentry/node';
import type { PendingQuery, Row, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { readFlagEnabledByDefault } from '@/lib/config/flags';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  REFUSAL_VOCABULARY_VERSION,
  type RefusalCategory,
  type RefusalSource,
  type RefusalSubjectType,
} from './vocabulary';

const logger = createWorkerLogger('[refusals:write]');

/** The default-ON kill switch. Only the literal string 'false' disables it. */
const REFUSAL_LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED';

/**
 * How long a SYNCHRONOUSLY-THROWN capture suppresses the next warning attempt.
 *
 * Exported because the eval pins the recovery case on it: a cooldown counted in
 * TIME is the whole point (see `warnLedgerDisabled` below), and a test that
 * hard-coded five minutes would pass while measuring nothing.
 */
export const WARN_RETRY_COOLDOWN_MS = 300_000;

/**
 * The decision time.
 *
 * `'transaction_time'` is a SENTINEL, not a default — a lane must say it. See
 * `RefusalEventBase.occurredAt`.
 */
export type RefusalOccurredAt = Date | 'transaction_time';

// ---------------------------------------------------------------------------
// The input — ONE ARM PER LANE.
// ---------------------------------------------------------------------------

/**
 * The fields every lane carries, whatever it points at.
 *
 * `refusalCategory` is DELIBERATELY NOT NARROWED PER LANE. #1001 considered
 * pinning `held_draft`'s fixed category in the schema and DECLINED, because a
 * lane whose category is fixed by its type makes a future re-map
 * migration-bearing; narrowing it here would re-introduce in TypeScript exactly
 * what the schema rejected. It would also make the eval's forced-`23514` case
 * unwritable — that case bends one vocabulary entry to produce a REAL
 * constraint violation through the real helper, and a per-lane category type
 * would turn that into a compile error instead of the run-time abort it exists
 * to prove.
 */
interface RefusalEventBase {
  accountId: string;
  refusalCategory: RefusalCategory;
  /**
   * REQUIRED, never optional, and there is no default.
   *
   * An OPTIONAL field lets a lane drift into the transaction stamp silently:
   * `outreach_withheld` decides during the LLM round trip and persists
   * afterwards, so an omission there would record persist time — seconds late,
   * compiling, and passing every runtime test. Required plus a sentinel makes
   * that a type error instead.
   */
  occurredAt: RefusalOccurredAt;
}

/** C3 — every lane but `autonomy_suspended` names the location it happened at. */
type AtLocation = { businessId: string };

/**
 * C3's other half. NULL is the STATEMENT "this is account-wide", not a missing
 * value: the parent effort joined the audit log through `businesses` and
 * multiplied one account-level event by the location count.
 */
type AccountWide = { businessId: null };

/** C1 fixes the subject TYPE from the lane; C2 makes the pair whole. */
type Subject<Type extends RefusalSubjectType> = { subjectType: Type; subjectId: string };

/** C1's `IS NULL` arm — the one lane that points at nothing. C2 holds either way. */
type NoSubject = { subjectType: null; subjectId: null };

/** C4 — a code, verbatim and never normalised. C5 — no array outside one lane. */
type WithCode = { refusalCode: string; allRefusalCodes: null };

/**
 * C4's sole exception. `held_draft` has no code axis AT ALL:
 * `flagged_responses.reason` is moderation prose that may never leave the
 * server, so the lane itself is the whole fact.
 */
type WithoutCode = { refusalCode: null; allRefusalCodes: null };

/**
 * C5 — `policy_gate_held` alone carries the co-occurring codes.
 *
 * `readonly [string, ...string[]]` rather than `readonly string[]` because C5
 * requires `cardinality > 0`: NULL means "this lane has no code axis" and `'{}'`
 * would be a different fact, so an empty array must not be spellable. (C5 also
 * requires `refusalCode` to be a MEMBER of the array — that half stays in the
 * database, because a type cannot express it.)
 */
type WithCodeSet = { refusalCode: string; allRefusalCodes: readonly [string, ...string[]] };

/**
 * The per-lane half of the input: the five fields C1–C5 pin the moment a lane is
 * chosen — the location, both halves of the subject, and both code columns.
 * Lanes in migration 116's order, same as `REFUSAL_SOURCES`.
 *
 * A COMPILE-TIME PROJECTION OF MIGRATION 116, NEVER A REPLACEMENT FOR IT. Every
 * CHECK stays in the database and none of them is relaxed: TypeScript cannot
 * protect a row written by another process, a `psql` session or an operational
 * query, and #1001 locked the five CHECKs for exactly that reason. What the arms
 * remove is a DIFFERENT failure, and one the database cannot remove — a caller
 * pairing its lane with the wrong subject, code or location. That pairing
 * compiles under a flat nine-field input, raises `23514`, and (because this
 * module deliberately does not catch) ABORTS THE DECIDING TRANSACTION, so the
 * ledger breaks the very decision it exists to record. Eleven call sites land
 * across #1009–#1013; each now states its lane and has the rest checked for it.
 */
interface RefusalLaneShapes {
  held_draft: AtLocation & Subject<'response'> & WithoutCode;
  auto_post_revoked: AtLocation & Subject<'response'> & WithCode;
  autonomy_suspended: AccountWide & NoSubject & WithCode;
  ask_withheld: AtLocation & Subject<'solicitation_ask'> & WithCode;
  outreach_withheld: AtLocation & Subject<'solicitation_outreach'> & WithCode;
  batch_halted: AtLocation & Subject<'solicitation_batch'> & WithCode;
  policy_gate_held: AtLocation & Subject<'response'> & WithCodeSet;
}

/**
 * One arm per lane, discriminated on `refusalSource`.
 *
 * THE INDEXED ACCESS IS THE TOTALITY GUARD, and that is the whole reason this is
 * a mapped type rather than seven hand-written arms: `RefusalLaneShapes[Lane]`
 * is only legal while every `RefusalSource` is a key of `RefusalLaneShapes`, so
 * an eighth lane added to `REFUSAL_SOURCES` without a shape here is `TS2536`
 * right on this line. Adding a lane is already migration-bearing (the column
 * CHECK and C1 must admit it first), and this makes the TypeScript half fail in
 * the same change rather than at the first INSERT.
 */
export type WriteRefusalEventInput = {
  [Lane in RefusalSource]: RefusalEventBase & { refusalSource: Lane } & RefusalLaneShapes[Lane];
}[RefusalSource];

// ---------------------------------------------------------------------------
// The disabled-ledger warning — bounded per EPISODE, on two transports.
// ---------------------------------------------------------------------------

/**
 * Set once the current disabled episode has warned. CLEARED the moment
 * `writeRefusalEvent` sees the flag enabled again, because the rate-limit unit
 * is the EPISODE and not the process: a worker outlives many flag flips, and a
 * process-lifetime latch makes every outage after the first one silent.
 */
let warnedThisEpisode = false;

/**
 * Epoch ms before which no further warning attempt is made. Set ONLY when
 * `Sentry.captureMessage` threw SYNCHRONOUSLY, and cleared with the episode.
 *
 * A cooldown counted in TIME, never a lifetime attempt ceiling: a ceiling cannot
 * tell "Sentry is broken" from "Sentry was briefly broken" — three throws then a
 * recovery stay silent forever under one, and recover under this.
 */
let nextWarnAttemptAt = 0;

/**
 * Clears BOTH halves of the latch. Test-only, on `circuit-breaker.ts`'s
 * `reset()` precedent: the state is module-level and process-local, so without
 * this the first case to run would satisfy "exactly one warning" for all the
 * others.
 */
export function resetRefusalLedgerWarningForTests(): void {
  warnedThisEpisode = false;
  nextWarnAttemptAt = 0;
}

/**
 * The enabled path's one side effect: it ENDS the disabled episode.
 *
 * Two unconditional assignments and no I/O — cheaper than reading the state to
 * decide whether to clear it, and this is what makes the NEXT disabled episode
 * warn instead of inheriting the last one's silence.
 */
function endDisabledEpisode(): void {
  warnedThisEpisode = false;
  nextWarnAttemptAt = 0;
}

/**
 * One warning per DISABLED EPISODE, on two transports.
 *
 * WHY IT EXISTS AT ALL: the ledger structurally cannot show its own gap. An
 * absent row and a decision that never happened look identical at read time, so
 * without this a disabled ledger is invisible.
 *
 * THE STRUCTURED LOG LINE IS THE PRIMARY, DURABLE SIGNAL. It is emitted FIRST,
 * in its OWN guard, OUTSIDE the Sentry attempt — it is the transport this
 * process controls (`createWorkerLogger` writes one JSON line synchronously),
 * and no Sentry behaviour can take it away. Its own catch exists so that a
 * throwing console cannot take the Sentry capture with it, and cannot reject
 * this helper: a suspension that failed BECAUSE THE LEDGER WAS TURNED OFF is the
 * exact opposite of what a kill switch promises.
 *
 * SENTRY IS A BEST-EFFORT SECOND TRANSPORT WITH NO DELIVERY GUARANTEE. That is a
 * statement about the installed SDK, not a preference: `@sentry/node` 10.55.0's
 * `captureMessage` returns an event id immediately — it returns one even with no
 * client configured — buffers the event, sends the envelope asynchronously, and
 * catches a failed transport send INTERNALLY rather than throwing back. So a
 * capture that returns means QUEUED, never DELIVERED, and a bad DSN or a dead
 * network is indistinguishable from success at this call. Nothing here claims
 * otherwise. Awaiting `Sentry.flush()` WOULD tell us and is deliberately not
 * done: it would put network latency inside the deciding transaction, which is
 * worse than an unacknowledged warning. This is why the log line, not the
 * capture, is the signal an operator should be searching for.
 *
 * WHAT THE COOLDOWN ACTUALLY BUYS, stated accurately: it rate-limits the retry
 * of a capture call that threw SYNCHRONOUSLY — an unusual SDK or programming
 * failure. It does NOT retry delivery, because a delivery failure never reaches
 * this catch. It is kept because it is cheap and because it recovers.
 *
 * SO THE BOUND IS: one attempt per disabled episode once the capture returns,
 * and at most one attempt per cooldown window while capture keeps throwing —
 * every attempt emitting the durable log line. A suspended fleet cannot drown
 * the signal with one capture per decision, and a second outage is never silent.
 */
function warnLedgerDisabled(): void {
  if (warnedThisEpisode || Date.now() < nextWarnAttemptAt) return;

  try {
    logger.warn('refusal ledger disabled — no decisions are being recorded', {
      flag: REFUSAL_LEDGER_FLAG,
    });
  } catch {
    // Swallowed on purpose: a throwing console must not take the capture below
    // with it, and must never reject the helper (see the docblock). There is by
    // definition nothing left to log the failure with.
  }

  try {
    Sentry.captureMessage(
      `${REFUSAL_LEDGER_FLAG}=false — the Refusal ledger is not recording decisions`,
      {
        level: 'warning',
        tags: { subsystem: 'refusal_ledger', flag: REFUSAL_LEDGER_FLAG },
      },
    );
    // The episode is warned once the capture call RETURNS — which means queued,
    // not delivered. The log line above is what makes that acceptable.
    warnedThisEpisode = true;
  } catch {
    // Swallowed on purpose (see the docblock). A synchronous throw buys a
    // cooldown rather than the latch, so a recovered Sentry still gets to carry
    // the warning within this same episode.
    nextWarnAttemptAt = Date.now() + WARN_RETRY_COOLDOWN_MS;
  }
}

/**
 * `NOW()` unparameterised, or the caller's `Date` bound and cast. Two fragments,
 * ONE statement — the alternative is a second near-identical INSERT, which is
 * how the two arms drift apart. `nowIf` in `src/lib/solicitation/dispatch.ts` is
 * the same idiom.
 *
 * `NOW()` IS SANCTIONED HERE AND ONLY BEHIND THE SENTINEL. Migration 116's
 * header forbids a writer that HAS a decision time and passes `NOW()` out of
 * convenience — that writer records a write timestamp under a decision
 * timestamp's name, and the two diverge on a retried job or a long transaction.
 * A lane whose decision time IS the transaction is the narrower case the
 * migration could not yet name: in Postgres `NOW()` is `transaction_timestamp()`
 * — transaction START, not statement time, and stable across every statement in
 * the transaction — so `autonomy_suspended`, which decides inside the very
 * transaction that stamps it, gets its true decision time. That equality to the
 * microsecond against `account_audit_log.created_at` (also `DEFAULT NOW()`,
 * migration 034) is the join #1006 accepted INSTEAD OF a `suspension_event_id`
 * column. Measured against a live Postgres, not asserted from memory.
 *
 * A LANE MAY NEVER read `transaction_timestamp()` and hand it back as a JS
 * `Date`: postgres.js truncates microseconds on decode (#520), and the six
 * digits that carry the join die with them.
 */
function occurredAtFragment(
  tx: TransactionSql,
  occurredAt: RefusalOccurredAt,
): PendingQuery<Row[]> {
  return occurredAt === 'transaction_time' ? tx`NOW()` : tx`${occurredAt}::timestamptz`;
}

/**
 * Record one Refusal on the caller's deciding transaction.
 *
 * @param tx the DECIDING transaction — invariant #15, never `@/lib/db/server`.
 *           A helper that opened its own connection would stamp a different
 *           clock and survive a rollback that took the decision away.
 */
export async function writeRefusalEvent(
  tx: TransactionSql,
  input: WriteRefusalEventInput,
): Promise<void> {
  // READ LIVE, PER CALL, INSIDE THE BODY. A `const enabled =
  // readFlagEnabledByDefault(…)` at module scope can never observe a mid-process
  // toggle — it would satisfy "off means off" on a fresh process and then hold
  // the ledger dark for the life of the worker after someone flips it back on.
  // Same rule `circuit-breaker.ts` states for its own kill switch.
  if (!readFlagEnabledByDefault(REFUSAL_LEDGER_FLAG)) {
    // Return BEFORE touching the deciding transaction. This is the lever the
    // ticket names — "not a revert deploy": a decision still lands, unrecorded.
    warnLedgerDisabled();
    return;
  }

  // The flag is on, so any disabled episode is over. Clearing here — rather than
  // never — is what makes a second outage warn again.
  endDisabledEpisode();

  // Column order follows migration 116 exactly. `created_at` is `DEFAULT NOW()`
  // and is deliberately NOT written: it is the INSERT stamp, and the skew
  // between it and `occurred_at` is the only measurement that would catch a
  // writer stamping the decision time wrong.
  //
  // BOTH HALVES OF THE `all_refusal_codes` LINE ARE LOAD-BEARING, and a
  // "simplification" to `${input.allRefusalCodes}` breaks one or the other. The
  // SPREAD copies a `readonly string[]` into the mutable array postgres.js's
  // serializer requires. The explicit `null` arm keeps `null::text[]` distinct
  // from `'{}'::text[]`: NULL means "this lane has no code axis" and is a
  // different fact from an empty array (#1001), which C5 rejects outright.
  // (Nothing may be commented INSIDE the template — a `--` comment would eat the
  // rest of the squashed statement, and an interpolation inside one would emit a
  // bind parameter Postgres never consumes.)
  await tx`
    INSERT INTO refusal_events (
      id,
      account_id,
      business_id,
      refusal_source,
      refusal_code,
      all_refusal_codes,
      refusal_category,
      vocabulary_version,
      subject_type,
      subject_id,
      occurred_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.accountId}::uuid,
      ${input.businessId}::uuid,
      ${input.refusalSource},
      ${input.refusalCode},
      ${input.allRefusalCodes === null ? null : [...input.allRefusalCodes]}::text[],
      ${input.refusalCategory},
      ${REFUSAL_VOCABULARY_VERSION},
      ${input.subjectType},
      ${input.subjectId}::uuid,
      ${occurredAtFragment(tx, input.occurredAt)}
    )
    ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL
    DO NOTHING
  `;
  // THE PREDICATE IS RE-SPELLED BYTE-FOR-BYTE from `refusal_events_subject_uniq`
  // (migration 116), and it may NOT be parameterised. Postgres cannot infer a
  // partial index without its predicate, and a bind parameter inside
  // `ON CONFLICT … WHERE` defeats inference outright (invariant #2). A clause
  // that reads right and infers nothing raises 23505 on the second write and
  // poisons the transaction the decision lives in.
  //
  // DO NOTHING IS REQUIRED, NOT OPTIONAL, for the same reason: a bare unique
  // index raises on a duplicate and aborts the transaction it sits in — and that
  // transaction IS the decision. The ledger must never break the thing it
  // records. The index is PARTIAL, so `autonomy_suspended`'s NULL subject is
  // never deduplicated: two suspensions of one account stay two Refusals.
  //
  // `id` is minted HERE, inside the deciding transaction — the column has no DB
  // default, deliberately (116's own column comment). `vocabulary_version` is
  // the frozen literal and never a parameter: it records which map froze this
  // row's category, and #1002 ruled there is never a backfill.
}
