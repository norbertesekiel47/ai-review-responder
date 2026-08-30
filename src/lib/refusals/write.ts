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
 *     transaction. Catching would hide a writer bug in the one place the ledger
 *     cannot report it, and the lever against a writer bug is the kill switch —
 *     the ticket says so in those words. The `.claude/CLAUDE.md` rule about
 *     best-effort work needing its own `try/catch` is about work AFTER a primary
 *     side effect; this write is INSIDE the decision, not beside it.
 *   * It does not VALIDATE its input against C1–C5. The database owns those five
 *     facts (#1001); a TypeScript copy would be a second authority that drifts —
 *     the precise defect #1001 cites when it declines to CHECK the 22
 *     `AutoApprovalBlockReason` members.
 *   * It does not READ. The read path is #1014.
 *
 * THE TWO `try/catch` DECISIONS BELOW LOOK CONTRADICTORY AND ARE NOT. The ledger
 * INSERT is not caught because it CARRIES the fact. The Sentry warning is caught
 * because it merely OBSERVES it. Facts propagate; observations swallow.
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
 * How long a FAILED warning attempt suppresses the next one.
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
 * `WriteRefusalEventInput.occurredAt`.
 */
export type RefusalOccurredAt = Date | 'transaction_time';

export interface WriteRefusalEventInput {
  accountId: string;
  /** NULL for `autonomy_suspended` and ONLY for it — CHECK C3 is biconditional. */
  businessId: string | null;
  refusalSource: RefusalSource;
  /** The code verbatim, never normalised. NULL exactly for `held_draft` — C4. */
  refusalCode: string | null;
  /**
   * Non-empty, NULL-member-free, and containing `refusalCode`, for
   * `policy_gate_held` only; NULL for every other lane — C5. NULL and `'{}'` are
   * DIFFERENT FACTS (#1001): NULL means "this lane has no code axis" and must
   * never collide with an empty array.
   */
  allRefusalCodes: readonly string[] | null;
  refusalCategory: RefusalCategory;
  /** NULL together, or both present — C2. The lane decides which — C1. */
  subjectType: RefusalSubjectType | null;
  subjectId: string | null;
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

// ---------------------------------------------------------------------------
// The warn-once latch — bounded in BOTH directions.
// ---------------------------------------------------------------------------

/**
 * Set on a SUCCESSFUL capture, never before the attempt. Setting it first stops
 * spam but trades one transient network blip for permanent silence, and this
 * warning is the ONLY evidence a ledger gap exists.
 */
let warned = false;

/**
 * Epoch ms before which no further capture is attempted. A FAILURE sets this; it
 * is a cooldown counted in TIME, not a lifetime attempt ceiling. A ceiling
 * cannot tell "Sentry is broken" from "Sentry was briefly broken" — three
 * failures then a recovery stay silent forever under one, and recover under
 * this. Time always recovers.
 */
let nextWarnAttemptAt = 0;

/**
 * Clears BOTH halves of the latch. Test-only, on `circuit-breaker.ts`'s
 * `reset()` precedent: the state is module-level and process-local, so without
 * this the first case to run would satisfy "exactly one per process" for all the
 * others.
 */
export function resetRefusalLedgerWarningForTests(): void {
  warned = false;
  nextWarnAttemptAt = 0;
}

/**
 * One warning per process while the kill switch stays off.
 *
 * WHY IT EXISTS AT ALL: the ledger structurally cannot show its own gap. An
 * absent row and a decision that never happened look identical at read time, so
 * without this line a disabled ledger is invisible.
 *
 * WHY IT IS BOUNDED ONCE PER PROCESS: a suspended fleet would otherwise emit one
 * capture per decision and drown the signal it exists to give.
 *
 * WHY THE CATCH SWALLOWS: an unguarded emission that throws rejects before the
 * helper returns, and a suspension then fails BECAUSE THE LEDGER WAS TURNED OFF
 * — the exact opposite of what a kill switch promises. Telemetry observes the
 * path; it never carries it.
 *
 * The structured log line goes FIRST so it survives even when Sentry does not.
 */
function warnLedgerDisabled(): void {
  if (warned || Date.now() < nextWarnAttemptAt) return;
  try {
    logger.warn('refusal ledger disabled — no decisions are being recorded', {
      flag: REFUSAL_LEDGER_FLAG,
    });
    Sentry.captureMessage(
      `${REFUSAL_LEDGER_FLAG}=false — the Refusal ledger is not recording decisions`,
      {
        level: 'warning',
        tags: { subsystem: 'refusal_ledger', flag: REFUSAL_LEDGER_FLAG },
      },
    );
    warned = true;
  } catch {
    // Swallowed on purpose (see the docblock). A failure buys a cooldown rather
    // than the latch, so a recovered Sentry still gets to carry the warning.
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

  // Column order follows migration 116 exactly. `created_at` is `DEFAULT NOW()`
  // and is deliberately NOT written: it is the INSERT stamp, and the skew
  // between it and `occurred_at` is the only measurement that would catch a
  // writer stamping the decision time wrong.
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
