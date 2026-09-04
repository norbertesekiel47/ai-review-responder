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
/**
 * The kill switch's NAME, exported so nothing re-spells it (#1010 follow-up).
 * Six test files each carried their own `'REFUSAL_LEDGER_ENABLED'` literal; a
 * rename would have left them green while testing a flag that no longer
 * exists. This module reads the flag, so it owns the name.
 */
export const REFUSAL_LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED';

/**
 * Is the Refusal ledger recording? THE WRITE PATH'S ONE READER OF THE FLAG.
 *
 * WHY IT IS EXPORTED. Both write arms below read the switch, but by then a
 * caller has already done ledger work: `recordPolicyGateRefusal`
 * (`worker/jobs/response-generation/persist.ts`) RESOLVES a Refusal category
 * from the gate's block reasons before either arm is reached, and a resolver
 * fault there aborted the response-persist transaction with the switch already
 * off (#1079). A kill switch that cannot stop the code in front of it is not a
 * lever. So the read gets one name, and a caller with work to skip asks first.
 *
 * IT IS SIDE-EFFECT-FREE, AND THAT IS A CONTRACT, not an implementation detail.
 * It reads the flag and returns: NO logging, NO Sentry, NO latch mutation.
 * `warnLedgerDisabled` and `endDisabledEpisode` stay private to this module, so
 * a caller cannot claim the ledger has a gap as a side effect of merely asking
 * whether it is on. A caller that HAS established a gap says so explicitly, via
 * `noteRefusalLedgerDark` below.
 *
 * THE WORD IS "SIDE-EFFECT-FREE" AND NOT "PURE", deliberately. `vocabulary.ts`
 * defines PURE for this same feature area as "no DB handle, no clock, no flag
 * read" — and this function's whole body is a flag read that MUST differ between
 * calls. Branch review round 1 (standards axis) caught the two meanings
 * colliding inside one area; the property relied on here is the absence of
 * transports and latch writes, which is what the contract now names.
 *
 * READ LIVE, PER CALL — never hoisted to a module-scope `const`. The rule and
 * its reason are spelled out at `writeRefusalEvent` below and in
 * `src/lib/llm/circuit-breaker.ts`.
 *
 * THE ONE SANCTIONED SECOND READER is `src/app/api/dashboard/refusals/route.ts`,
 * on the READ path, which keeps its own literal spelling of the flag name so
 * `ci:env-registry` can see it. That is deliberate and is not a duplicate of
 * this predicate.
 */
export function isRefusalLedgerEnabled(): boolean {
  return readFlagEnabledByDefault(REFUSAL_LEDGER_FLAG);
}

/**
 * Record that a decision WOULD have been recorded and was not, because the
 * ledger is off. The side-effecting sibling of `isRefusalLedgerEnabled`.
 *
 * WHY IT EXISTS, and why it is not a second flag read. #1079 moved the kill
 * switch in front of `recordPolicyGateRefusal`'s vocabulary resolve, which
 * contained the fault it had to contain — and took the lane's ledger-dark
 * warning with it, because the two write arms below are now unreachable on that
 * lane when the switch is off. Branch review round 1 (async axis) showed the
 * loss was avoidable: the premise that a guard cannot know whether a row would
 * have been written WITHOUT running the throwing resolver is false. Membership
 * in the category map is decidable with `Object.hasOwn`, which cannot throw, so
 * the caller establishes the gap itself and then says so here.
 *
 * IT IS THE SAME WARNING, NOT A SECOND ONE. It calls the same private
 * `warnLedgerDisabled` the write arms call, so it shares their once-per-episode
 * latch and their cooldown: a lane that warns here does not make the next arm
 * warn again, and the operator still sees one line per disabled episode.
 *
 * THE CALLER OWNS THE PRECONDITION, and it is narrow: call this ONLY when a row
 * would genuinely have been written. `writeRefusalEvents`' contract below states
 * the rule this protects — an empty build, and equally a decision every one of
 * whose reasons maps to `null`, withheld nothing and has no ledger GAP to warn
 * about. Warning there would put noise on the one signal that says the ledger is
 * dark. The predicate that satisfies this is EVERY-mapped-and-non-null, never
 * SOME: one `null`-mapped member vetoes the whole row (#1003), so a `some` test
 * would warn about a decision that was never going to be recorded. THE
 * COUNTEREXAMPLE IS A MIXED SET, NOT A VETO-ONLY ONE — `some` is false on a
 * veto-only set too, because its only member maps to `null`; it goes wrong on a
 * set holding one mapped non-null member AND one `null`-mapped member, which is
 * why the `!== null` test must sit INSIDE the callback. The shipped predicate is
 * `wouldRecordRefusal` in `worker/jobs/response-generation/persist.ts`, whose
 * docblock carries the machine-produced counterexample; this docblock states the
 * rule, not the measurement.
 *
 * IT HAS A SIBLING, AND CHOOSING BETWEEN THEM IS EASY ONCE NAMED (#1105).
 * `noteUnmappedBlockReasons` below reports that a block reason has no category
 * MAPPING. This one reports that a row would have been WRITTEN and was not. An
 * unmapped member would have THROWN rather than written, so it belongs to the
 * sibling and never here — and the two cannot both fire on one decision, because
 * an unmapped member is exactly what makes `wouldRecordRefusal` false. They do
 * not share a latch: this one's is an EPISODE of the kill switch and re-arms
 * when the ledger comes back; the sibling's is per PROCESS, because a map hole
 * does not end when someone flips the flag.
 */
export function noteRefusalLedgerDark(): void {
  warnLedgerDisabled();
}

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
 * The unmapped codes this PROCESS has already signalled (#1105).
 *
 * A SEPARATE LATCH WITH A SEPARATE LIFETIME, and the separation is the whole
 * decision. `warnedThisEpisode` above belongs to a DISABLED EPISODE: the ledger
 * being off is a deliberate operator act, `endDisabledEpisode` clears the latch
 * the moment the ledger is observed on, and the next outage is meant to warn
 * again. A block reason with no category mapping is not an episode of anything —
 * it is a defect, it does not end when someone flips the flag back, and
 * re-arming it on that flip would report the same hole twice for no new
 * information. So this one is a PROCESS latch. A worker restart clears it.
 *
 * PER CODE, NOT ONE BOOLEAN — AND THE FIRST VERSION OF THIS BRANCH GOT IT
 * WRONG. That version latched a single boolean and justified it as "a map hole
 * is systemic, so one line is enough". Branch review round 1 (adversarial axis)
 * refuted the justification rather than the design: since #1080 the compiler
 * REJECTS the systemic static hole — `POLICY_GATE_HELD_REFUSAL_CATEGORIES`
 * carries `satisfies Record<AutoApprovalBlockReason, …>`, so a member with no
 * entry is a TS1360 at `pnpm typecheck`. What is left is a value that escaped
 * the union at run time, and THAT varies from decision to decision. In a
 * long-lived single-replica worker a single boolean would let the first bad
 * value permanently hide a second, from a different unsafe producer. The two
 * events are not redundant evidence.
 *
 * BOUNDED, BECAUSE THE INPUT IS NOT. The set holds at most
 * `UNMAPPED_SIGNAL_CAP` distinct codes and then stops growing — the values are
 * by definition ones the type system did not vouch for, so an unbounded Set
 * keyed on them is a memory leak with extra steps. Reaching the cap emits ONE
 * overflow marker and nothing after it.
 */
const signalledUnmappedCodes = new Set<string>();

/**
 * How many distinct unmapped codes one process reports before it stops.
 *
 * Exported so the eval pins the overflow case on it rather than on a hard-coded
 * literal that would pass while measuring nothing — `WARN_RETRY_COOLDOWN_MS`
 * below is exported for the same reason.
 *
 * EIGHT IS A BOUND, NOT A TUNED VALUE. The whole 22-member block vocabulary is
 * mapped by construction, so any distinct code here is already an escapee; a
 * process producing more than eight DIFFERENT ones has a fault the ninth code
 * will not clarify.
 */
export const UNMAPPED_SIGNAL_CAP = 8;

/**
 * The capture message — A CONSTANT, and that is the point.
 *
 * Sentry groups by message. An interpolated code list opens a new issue group
 * for every distinct set, ordering and duplication of codes, which scatters one
 * fault's history and defeats per-issue throttling. The codes ride `extra`
 * instead, and the structured log line carries them too. Exported so the eval
 * pins grouping on the constant rather than on a copied literal.
 */
export const UNMAPPED_BLOCK_REASON_MESSAGE = 'auto_approval_unmapped_block_reason';

/** The overflow marker's message. A constant for the same grouping reason. */
export const UNMAPPED_BLOCK_REASON_OVERFLOW_MESSAGE =
  'auto_approval_unmapped_block_reason_cap_reached';

/** Set once the cap is reached, so the overflow marker is emitted exactly once. */
let unmappedOverflowSignalled = false;

/**
 * The cooldown half, on `nextWarnAttemptAt`'s exact terms: it rate-limits the
 * retry of a capture that threw SYNCHRONOUSLY, and buys time rather than the
 * latch so a recovered Sentry still gets to carry the signal.
 */
let nextUnmappedAttemptAt = 0;

/**
 * Clears both halves of the vocabulary-hole latch. Test-only.
 *
 * A SECOND RESET RATHER THAN AN EXTENSION OF THE ONE ABOVE, and the reason is a
 * live suite. `refusal-write.integration.test.ts` calls
 * `resetRefusalLedgerWarningForTests` MID-TEST, to open a fresh disabled episode
 * inside a case. Folding this latch into that reset would make an episode
 * boundary silently clear an unrelated process-lifetime signal — two lifetimes
 * sharing one clear is how they drift. Two latches, two resets.
 */
export function resetUnmappedBlockReasonSignalForTests(): void {
  signalledUnmappedCodes.clear();
  unmappedOverflowSignalled = false;
  nextUnmappedAttemptAt = 0;
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
 * Report that a gate decision carried a block reason the category map does not
 * hold. THE SECOND SIGNAL ON A DARK LEDGER, and not a variant of the first.
 *
 * WHY IT EXISTS (#1105). #1079 put the kill switch in FRONT of
 * `resolvePolicyGateRefusal`, so an unmapped block reason no longer aborts the
 * response persist. That containment is correct and stays. Its cost is that the
 * fault became invisible: the resolver never runs, so `withLedgerAttribution`
 * raises nothing, and `wouldRecordRefusal` is `every(mapped && non-null)`, so an
 * unmapped member makes IT false too and no ledger-dark line fires either. An
 * operator could not tell "the ledger is off deliberately" from "the ledger is
 * off AND decisions are being made against a broken map".
 *
 * IT IS NOT `noteRefusalLedgerDark`, AND MUST NOT BECOME IT. That helper says
 * "a Refusal row would have been written and was not" — a ledger GAP. This one
 * says "a code has no mapping". An unmapped member would have THROWN rather than
 * written, so it costs no row and creates no gap; `writeRefusalEvents`' contract
 * below forbids claiming one. Different fault, different message, different
 * level, different latch. The two are MUTUALLY EXCLUSIVE at the one call site by
 * construction, because an unmapped member is exactly what makes
 * `wouldRecordRefusal` false.
 *
 * `error`, WHERE THE LEDGER-DARK LINE IS `warning`. The ledger being off is a
 * deliberate operator act. A vocabulary hole behind it is a defect. If both
 * carried one level an operator would have to read the message to tell a pulled
 * lever from a broken map, which is the confusion this helper removes.
 *
 * IT CANNOT THROW, AND THAT IS A CONTRACT, not a property of today's body. Its
 * only call site is guard 4's off-arm in
 * `worker/jobs/response-generation/persist.ts`, where containment is by
 * NON-EXECUTION: an escape from here would abort the response persist through
 * the very lever an operator had already pulled. Two consequences bind any
 * future edit. This helper NEVER calls `resolvePolicyGateRefusal`, not even
 * inside a `try`. And each transport keeps its own `catch`, so a broken console
 * cannot take the capture with it and neither can reject the caller.
 *
 * THE CALLER OWNS THE PRECONDITION, exactly as `noteRefusalLedgerDark`'s does,
 * and the parameter is ALREADY-UNMAPPED codes. This module does not classify;
 * `unmappedBlockReasons` in `persist.ts` does, with `Object.hasOwn`, beside
 * `wouldRecordRefusal` and under the same cannot-throw rule. The first draft put
 * the membership test in here, and the eval refuted it — the single account of
 * that event, which four documents previously told two ways: with the test
 * inside this helper, four of the lane suite's five cases FAILED, because that
 * suite mocks this module and its spy recorded a call for a healthy set too.
 * A lane-level contract needs a lane-level oracle. (Branch review round 1 then
 * showed one of the surviving cases had the same weakness in a milder form; see
 * `persist.test.ts`'s mixed-set case, which now asserts the ARGUMENT.)
 *
 * IT DECLINES AN EMPTY LIST AND ALREADY-REPORTED CODES, and nothing else. Give
 * it a mapped code and it signals, because deciding that is not its job.
 *
 * THE CODES GO OUT VERBATIM AND IN INPUT ORDER, never sorted or de-duplicated.
 * The gate's evaluation order is evidence for whoever debugs it — the same rule
 * `resolvePolicyGateRefusal` states for `allRefusalCodes` — and a repeat is
 * itself a fact about the decision. They ride `extra`, never the capture
 * MESSAGE: Sentry groups by message, so an interpolated code list would open a
 * new issue for every distinct set, ordering and duplication, scatter one
 * fault's history across those groups, and defeat the per-issue throttling this
 * repository's alerting already depends on. The message is a CONSTANT for that
 * reason. (Branch review round 1, adversarial axis.)
 *
 * IT REPORTS EACH DISTINCT CODE ONCE, then stops at `UNMAPPED_SIGNAL_CAP` with
 * a single overflow marker. A call may therefore signal for SOME of its codes
 * and stay silent about the rest, which is why the already-reported ones are
 * filtered out before anything is emitted rather than after.
 */
export function noteUnmappedBlockReasons(unmapped: readonly string[]): void {
  if (Date.now() < nextUnmappedAttemptAt) return;

  // FILTERED AGAINST THE LATCH FIRST, so a set mixing a known code with a new
  // one still reports the new one. A whole-call latch would lose it.
  const fresh = unmapped.filter((code) => !signalledUnmappedCodes.has(code));
  if (fresh.length === 0) return;

  if (signalledUnmappedCodes.size >= UNMAPPED_SIGNAL_CAP) {
    noteUnmappedOverflow();
    return;
  }

  // JOINED ONCE, and both transports carry the same string. Also the only shape
  // that SURVIVES the log: `createWorkerLogger` runs object args through
  // `sanitizeAnalyticsProperties`, which keeps strings, numbers, booleans, null
  // and nested plain objects — and DROPS ARRAYS, silently. A `codes: fresh`
  // array logs as an absent key, so the durable transport would name no code
  // while the Sentry event named all of them.
  const codes = fresh.join(', ');

  try {
    logger.warn('refusal ledger vocabulary hole — a block reason has no category mapping', {
      flag: REFUSAL_LEDGER_FLAG,
      codes,
    });
  } catch {
    // Swallowed on purpose, on `warnLedgerDisabled`'s terms: a throwing console
    // must not take the capture below with it, and must never reject this
    // helper. There is by definition nothing left to log the failure with.
  }

  try {
    Sentry.captureMessage(UNMAPPED_BLOCK_REASON_MESSAGE, {
      level: 'error',
      tags: { subsystem: 'refusal_ledger', fault: 'unmapped_block_reason' },
      extra: { flag: REFUSAL_LEDGER_FLAG, codes },
    });
    // Latched once the capture RETURNS — queued, not delivered. The log line
    // above is what makes that acceptable. Only the codes THIS call reported are
    // marked, so a code suppressed by the cap is not recorded as reported.
    for (const code of fresh) signalledUnmappedCodes.add(code);
  } catch {
    // A synchronous throw buys a cooldown rather than the latch, so a recovered
    // Sentry still carries the signal. Counted in TIME, never as an attempt
    // ceiling: a ceiling cannot tell "Sentry is broken" from "Sentry was briefly
    // broken".
    nextUnmappedAttemptAt = Date.now() + WARN_RETRY_COOLDOWN_MS;
  }
}

/**
 * The cap reached: say so ONCE, then go quiet for the life of the process.
 *
 * IT IS ITS OWN EVENT, not a suppressed copy of the one above. "Eight distinct
 * codes escaped the union and there are more" is a different operational fact
 * from "this code has no mapping" — it says the producer is generating varied
 * garbage rather than missing one entry. A silently dropped ninth code would
 * report neither.
 *
 * IT NAMES NO CODE, deliberately: the codes past the cap are unbounded input,
 * and the point of the cap is to stop carrying them.
 */
function noteUnmappedOverflow(): void {
  if (unmappedOverflowSignalled) return;

  try {
    logger.warn('refusal ledger vocabulary hole — distinct unmapped code cap reached', {
      flag: REFUSAL_LEDGER_FLAG,
      cap: UNMAPPED_SIGNAL_CAP,
    });
  } catch {
    // Swallowed on the same terms as every other transport in this module.
  }

  try {
    Sentry.captureMessage(UNMAPPED_BLOCK_REASON_OVERFLOW_MESSAGE, {
      level: 'error',
      tags: { subsystem: 'refusal_ledger', fault: 'unmapped_block_reason_overflow' },
      extra: { flag: REFUSAL_LEDGER_FLAG, cap: UNMAPPED_SIGNAL_CAP },
    });
    unmappedOverflowSignalled = true;
  } catch {
    // Shares the SAME cooldown as the signal above, deliberately: both are the
    // same Sentry transport, and one broken SDK should buy one window rather
    // than two independent retry storms.
    nextUnmappedAttemptAt = Date.now() + WARN_RETRY_COOLDOWN_MS;
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
  // isRefusalLedgerEnabled()` at module scope can never observe a mid-process
  // toggle — it would satisfy "off means off" on a fresh process and then hold
  // the ledger dark for the life of the worker after someone flips it back on.
  // Same rule `circuit-breaker.ts` states for its own kill switch. The predicate
  // is SIDE-EFFECT-FREE, so the warning stays HERE, in the arm that would have
  // written — or is raised explicitly by a caller that established the gap
  // itself, through `noteRefusalLedgerDark`.
  if (!isRefusalLedgerEnabled()) {
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

/**
 * One row of the set arm's `jsonb_to_recordset` input.
 *
 * `occurred_at` is NULLABLE HERE AND ONLY HERE, and it is not the column's
 * nullability: `refusal_events.occurred_at` is `NOT NULL`. NULL is how the
 * `'transaction_time'` SENTINEL rides a JSONB payload — the statement resolves
 * it with `COALESCE(…, NOW())`, which is the same `transaction_timestamp()` the
 * single-row arm's `occurredAtFragment` emits. A lane that supplied a `Date`
 * lands its own instant and never touches the fallback.
 */
interface RefusalEventRow {
  id: string;
  account_id: string;
  business_id: string | null;
  refusal_source: string;
  refusal_code: string | null;
  all_refusal_codes: string[] | null;
  refusal_category: string;
  vocabulary_version: string;
  subject_type: string | null;
  subject_id: string | null;
  occurred_at: string | null;
}

/**
 * Record N Refusals on the caller's deciding transaction, in ONE statement.
 *
 * WHY THIS ARM EXISTS, and it is not a convenience. `ask_withheld` is the
 * highest-volume lane in the ledger: `loadCandidateWindow` bounds a batch's
 * evaluated cohort at `MAX_DATA_ROWS` (5,000, `src/lib/solicitation/contacts-csv.ts`)
 * and a rebuild re-evaluates the whole accumulated pool, so a build in which
 * every candidate fails an individual mapped gate proposes 5,000 Refusals at
 * once. Looping `writeRefusalEvent` would put 5,000 sequential round trips
 * inside a transaction already holding the per-Business advisory lock AND the
 * batch row lock, behind the `src/lib/db/admission.ts` chokepoint. (The
 * all-ELIGIBLE case is the OTHER one and writes nothing at all: its withholds
 * are `velocity_banked`, which maps to `null`.)
 *
 * IT LIVES HERE, BESIDE THE SINGLE-ROW ARM, AND NEVER IN A LANE MODULE. #1001
 * made this module the only place `INSERT INTO refusal_events` is spelled; a set
 * insert built in `batch-builder.ts` would be a second owner of the statement
 * and of the partial-index predicate.
 *
 * EVERY GUARANTEE OF THE SINGLE-ROW ARM HOLDS, and for the same reasons — read
 * that function's contract first. Two differences, both deliberate:
 *
 *   1. AN EMPTY INPUT ISSUES NO STATEMENT. An `INSERT` of zero rows is not a
 *      decision, and `jsonb_to_recordset` over `[]` is a round trip that records
 *      nothing. The check runs BEFORE the kill-switch read on purpose: a build
 *      that withheld nothing has no ledger GAP to warn about, and warning there
 *      would put noise on the one signal that says the ledger is dark.
 *   2. IT ASSERTS NO AFFECTED-ROW COUNT. `commitAskDecisions` — the
 *      `jsonb_to_recordset` idiom this follows — asserts
 *      `inserted.count === input.length`, which is correct THERE because that
 *      statement has no `ON CONFLICT`. Copying it here would be a bug: under
 *      `ON CONFLICT DO NOTHING` a subject already stored by an EARLIER call
 *      legitimately lowers the count, and the throw would land inside a decision
 *      transaction — the ledger breaking the very thing it records (plan review
 *      round 1, R1-7).
 *
 * @param tx the DECIDING transaction — invariant #15, never `@/lib/db/server`.
 */
export async function writeRefusalEvents(
  tx: TransactionSql,
  inputs: readonly WriteRefusalEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  // READ LIVE, PER CALL, INSIDE THE BODY — the same rule, and the same reason,
  // as the single-row arm. AFTER the empty check above, never before it.
  if (!isRefusalLedgerEnabled()) {
    warnLedgerDisabled();
    return;
  }

  endDisabledEpisode();

  // Column names, not the input's camelCase: these are the `jsonb_to_recordset`
  // column aliases, so the JSON keys and the AS list are one contract.
  const rows: RefusalEventRow[] = inputs.map((input) => ({
    id: uuidv7(),
    account_id: input.accountId,
    business_id: input.businessId,
    refusal_source: input.refusalSource,
    refusal_code: input.refusalCode,
    // The SPREAD copies a `readonly string[]` into the mutable array the JSON
    // serializer requires; the explicit `null` arm keeps NULL ("this lane has no
    // code axis") distinct from `'{}'`, which C5 rejects outright.
    all_refusal_codes: input.allRefusalCodes === null ? null : [...input.allRefusalCodes],
    refusal_category: input.refusalCategory,
    vocabulary_version: REFUSAL_VOCABULARY_VERSION,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    // ISO 8601, never the `Date` object: this value is JSON, and a `Date`
    // serialized by `JSON.stringify` is the same string with none of the
    // guarantee. The `timestamptz` column of the recordset parses it back at
    // full precision.
    occurred_at: input.occurredAt === 'transaction_time' ? null : input.occurredAt.toISOString(),
  }));

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
    )
    SELECT
      event.id,
      event.account_id,
      event.business_id,
      event.refusal_source,
      event.refusal_code,
      event.all_refusal_codes,
      event.refusal_category,
      event.vocabulary_version,
      event.subject_type,
      event.subject_id,
      COALESCE(event.occurred_at, NOW())
    FROM jsonb_to_recordset(${tx.json(rows as never)}) AS event(
      id uuid,
      account_id uuid,
      business_id uuid,
      refusal_source text,
      refusal_code text,
      all_refusal_codes text[],
      refusal_category text,
      vocabulary_version text,
      subject_type text,
      subject_id uuid,
      occurred_at timestamptz
    )
    ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL
    DO NOTHING
  `;
  // THE PREDICATE IS RE-SPELLED BYTE-FOR-BYTE from the single-row arm above,
  // which is itself byte-for-byte `refusal_events_subject_uniq` (migration 116).
  // `write.test.ts` reads BOTH clauses out of this module's source and compares
  // them as text — that comparison is the compensating control for the second
  // spelling #1001 warned about, and it is why neither may be "tidied" into a
  // shared string constant: an interpolated clause is a bind parameter, and a
  // bind parameter inside `ON CONFLICT … WHERE` defeats partial-index inference
  // outright (invariant #2).
  //
  // `DO NOTHING` also resolves a duplicate the statement is inserting AGAINST
  // ITSELF, which `DO UPDATE` cannot — it raises 21000 on exactly that shape. A
  // build proposing one subject twice therefore commits with one row rather than
  // poisoning the transaction the decision lives in.
  //
  // `NOW()` HERE IS THE SENTINEL'S RESOLUTION AND NOTHING ELSE. `COALESCE`
  // reaches it only for a row whose lane said `'transaction_time'`; in Postgres
  // `NOW()` is `transaction_timestamp()` — transaction START, stable across every
  // statement — so such a lane gets the same instant the single-row arm's
  // `occurredAtFragment` would have given it.
}
