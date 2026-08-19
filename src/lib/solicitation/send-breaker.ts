// The Send breaker — RepWorth's platform-wide reputation circuit breaker
// (#898; #622 §3.2B). The asset it protects is the Sending identity, which is
// ONE mailbox and ONE sending domain shared by every account, so the breaker is
// a singleton rather than a per-tenant dial: one account's bad list burns the
// deliverability every other account sends on.
//
// Distinct from the Halt latch, which stops ONE batch. This stops ALL sending,
// platform-wide, and NEVER self-clears — only resetSendBreaker closes a trip.
//
// Three functions, three audiences:
//   - evaluateSendBreaker  — the HealthAlertPoller's tick. Expensive read model.
//   - readSendBreaker      — the send loop's gate read (#900). Cheap, fail-closed.
//   - resetSendBreaker     — the admin arm. The only thing that clears a trip.
//
// Takes its client explicitly (invariant #15); this module never imports
// @/lib/db/server.
import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { createWorkerLogger } from '@/lib/shared/logger';
// Type-only, therefore erased: the finding SHAPE has one owner (the poller that
// consumes it) and duplicating it here would let the two drift. No runtime edge
// from src/lib into worker/ is created.
import type { HealthFinding } from '../../../worker/background/pollers/health-alert/checks';

const logger = createWorkerLogger('[SendBreaker]');

/**
 * #622 §3.2B, locked. Rates are fractions, not percentages, and both are
 * strict `>` comparisons — a window sitting exactly on the bar does not trip.
 */
export const BREAKER_WINDOW_DAYS = 7;
export const BREAKER_MIN_SENDS = 100;
export const BREAKER_HARD_BOUNCE_RATE = 0.02; // > 2%
export const BREAKER_COMPLAINT_RATE = 0.003; // > 0.3% — Gmail's stated bar

export const BREAKER_TRIP_REASONS = ['hard_bounce_rate', 'complaint_rate'] as const;
export type BreakerTripReason = (typeof BREAKER_TRIP_REASONS)[number];

/**
 * The Breaker window: one measurement of the last BREAKER_WINDOW_DAYS days.
 *
 * A `type` alias rather than an `interface` ON PURPOSE, and not a style choice:
 * this value goes into JSONB verbatim via `sql.json()`, whose `JSONValue`
 * parameter requires a string index signature. TypeScript grants one implicitly
 * to a type alias of an object type and never to an interface, so declaring
 * this as an interface fails to compile at the insert — with a message about
 * index signatures that says nothing about JSONB.
 */
export type BreakerWindow = {
  sends: number;
  hardBounces: number;
  complaints: number;
  hardBounceRate: number;
  complaintRate: number;
};

/** One open or closed Send breaker trip, as the gate and the admin surface read it. */
export interface SendBreakerTrip {
  id: string;
  trippedAt: Date;
  tripReason: BreakerTripReason;
  metrics: BreakerWindow;
}

export interface SendBreakerState {
  open: boolean;
  trip: SendBreakerTrip | null;
}

/**
 * Compute the Breaker window, trip the latch if it breaches, and return the
 * HealthFinding to page on (null only when nothing is open and nothing breaches).
 *
 * WINDOW BASIS, locked in grilling and NOT symmetric:
 *   - denominator is SEND-dated  (`sent_at` within the window)
 *   - numerators are SIGNAL-dated (`bounced_at` / `complained_at` within it)
 * Bounces lag their send by minutes to days, so a cohort measure — the
 * intuitive one — would dilute a fresh bad batch with sends whose bounces have
 * not landed yet, which is the fail-OPEN direction on a governor specified to
 * fail closed. Signal-dating means a burst of bounces from a send nine days ago
 * still trips it, and that the ratio can exceed 1.0 in a pathological burst.
 * That is a trip, not a bug.
 *
 * The MIN_SENDS floor is checked before any rate: small-N noise must not halt
 * sending for the whole platform.
 *
 * Cross-account BY DESIGN — the asset protected is the shared Sending identity,
 * not one tenant's. Allowlisted in scripts/ci/tenant-scope-allowlist.ts.
 *
 * LEVEL-TRIGGERED, NOT EDGE-TRIGGERED (round-1 review, adversarial-3 / std-2).
 * The first shape returned `null` on every tick after the one that inserted,
 * so the whole mechanism produced exactly ONE alert-shaped event for a
 * condition that halts the entire product line and never self-clears: one
 * dropped Sentry message (quota, transport blip, a worker restart before the
 * flush) left sending halted platform-wide with no notification, forever. An
 * open breaker is a STATE; the finding now reports that state on every tick,
 * the way every sibling check in `runHealthChecks` does. Sentry groups
 * captureMessage by its text and both titles below are stable, so the repeat
 * lands in ONE issue that keeps receiving events rather than N issues.
 *
 * The open-trip probe runs FIRST, which also means the expensive aggregate is
 * skipped entirely while sending is halted — there is nothing it could change.
 * The `INSERT … ON CONFLICT DO NOTHING` therefore only guards the (single-
 * replica: unreachable) race between the probe and the insert.
 */
export async function evaluateSendBreaker(sql: Sql | TransactionSql): Promise<HealthFinding | null> {
  const state = await readSendBreaker(sql);
  // Re-page while the trip stands, INCLUDING after the breaching signals have
  // aged out of the window: the halt outlives the breach that caused it,
  // because only an admin reset clears it.
  if (state.trip) return openTripFinding(state.trip);

  const breakerWindow = await readBreakerWindow(sql);
  const reason = classifyBreach(breakerWindow);
  if (reason === null) return null;

  // The conflict target and its WHERE match solicitation_send_breaker_one_open
  // BYTE-FOR-BYTE — `((reset_at IS NULL)) WHERE reset_at IS NULL`. A mismatch
  // does not fail to compile; Postgres raises "no unique or exclusion
  // constraint matching the ON CONFLICT specification" at runtime, on the
  // SECOND breach, which is the worst possible moment to learn it.
  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO solicitation_send_breaker (id, trip_reason, metrics)
    VALUES (${uuidv7()}, ${reason}, ${sql.json(breakerWindow)})
    ON CONFLICT ((reset_at IS NULL)) WHERE reset_at IS NULL DO NOTHING
    RETURNING id
  `;
  // Lost the probe→insert race to a concurrent tripper. Returning null here is
  // NOT the edge-triggered bug: a trip is now open, so the very next tick's
  // probe pages on it. The exposure is one poll interval, not forever, and the
  // worker is single-replica so this branch should never execute at all.
  if (!inserted) return null;

  // The intake's promised trip log line. AGGREGATE ONLY — counts, rates and
  // thresholds; never a recipient address, subject or body.
  logger.warn({
    msg: 'solicitation send breaker tripped',
    trip_id: inserted.id,
    trip_reason: reason,
    sends: breakerWindow.sends,
    hard_bounces: breakerWindow.hardBounces,
    complaints: breakerWindow.complaints,
    hard_bounce_rate: breakerWindow.hardBounceRate,
    complaint_rate: breakerWindow.complaintRate,
    hard_bounce_threshold: BREAKER_HARD_BOUNCE_RATE,
    complaint_threshold: BREAKER_COMPLAINT_RATE,
    min_sends: BREAKER_MIN_SENDS,
    window_days: BREAKER_WINDOW_DAYS,
  });
  return breakerFinding(reason, breakerWindow);
}

/**
 * Is solicitation sending halted?
 *
 * FAIL-CLOSED CONTRACT — part of this interface, not of each caller's judgment.
 * This function returns state or THROWS. **The throw IS the halt signal**:
 * #622 §3.2B requires a DB failure in the breaker's own read path to degrade to
 * HALT, never to "unmeasured therefore send". It is the deliberate inverse of
 * the replica-cardinality precedent, which fails OPEN because a worker that
 * will not start is worse than a duplicated one.
 *
 * There is therefore NO try/catch in this body and NO "unknown" verdict in the
 * return type — adding either would be the bug. A caller that wraps this in
 * try/catch and proceeds to send has broken the invariant.
 *
 * Cheap by construction: one indexed existence probe against
 * `solicitation_send_breaker_one_open`. The expensive read model lives in
 * evaluateSendBreaker, which runs on the HealthAlertPoller, not on the send
 * loop.
 */
export async function readSendBreaker(sql: Sql | TransactionSql): Promise<SendBreakerState> {
  const [row] = await sql<
    { id: string; tripped_at: Date; trip_reason: BreakerTripReason; metrics: unknown }[]
  >`
    SELECT id, tripped_at, trip_reason, metrics
      FROM solicitation_send_breaker
     WHERE reset_at IS NULL
  `;
  if (!row) return { open: false, trip: null };
  return {
    open: true,
    trip: {
      id: row.id,
      trippedAt: row.tripped_at,
      tripReason: row.trip_reason,
      // PgBouncer can hand JSONB back as a string — the one sanctioned
      // exception to the no-`any` rule (CLAUDE.md "PgBouncer JSONB").
      metrics: (typeof row.metrics === 'string'
        ? JSON.parse(row.metrics)
        : row.metrics) as BreakerWindow,
    },
  };
}

/**
 * Close the open trip. The ONLY thing that clears the breaker — it never
 * self-clears, because a breach is a fact someone must look at.
 *
 * The actor is passed in by the route from its gate identity and is NEVER read
 * from a request body — the same discipline adminHaltBatch applies to its
 * reason. A note is mandatory and is enforced by 110's reset_consistency CHECK
 * rather than re-spelled here, so "who cleared this, and why" cannot be
 * unanswerable by omission; a blank note surfaces as a 23514 for the route to
 * map, not as a silently-written reset.
 *
 * Resetting a still-breached window is PERMITTED and correct: the operator may
 * have just rolled the platform ceiling down, and forcing them to wait out a
 * seven-day window would be worse.
 *
 * THE RESET IS ALSO THE WINDOW'S NEW LOWER EDGE. readBreakerWindow bounds every
 * counter by `GREATEST(NOW() - 7 days, MAX(reset_at))`, so the next poller tick
 * measures only what happened AFTER this row was written — which is what makes
 * the reset mean anything at all. Before that bound the breaker measured a
 * history no operator action could change, and a reset re-tripped within one
 * poll interval every time (round-1 review, adversarial-1). The full argument,
 * including why the resulting BREAKER_MIN_SENDS grace period is the intended
 * half-open probe rather than a hole, is on readBreakerWindow.
 *
 * Returns `{ reset: false, tripId: null }` when nothing was open — the route
 * maps that to 409, mirroring the unsuspend route's not_suspended arm. Takes a
 * TransactionSql, not `Sql | TransactionSql`: the reset is one act and the
 * caller owns the transaction the audit of it belongs in.
 */
export async function resetSendBreaker(
  tx: TransactionSql,
  input: { actorUserId: string; note: string },
): Promise<{ reset: boolean; tripId: string | null }> {
  const [row] = await tx<{ id: string }[]>`
    UPDATE solicitation_send_breaker
       SET reset_at = NOW(),
           reset_by = ${input.actorUserId}::uuid,
           reset_note = ${input.note}
     WHERE reset_at IS NULL
    RETURNING id
  `;
  if (!row) return { reset: false, tripId: null };
  return { reset: true, tripId: row.id };
}

/**
 * One pass over `solicitation_outreach` producing all three counters.
 *
 * ONE statement with three FILTERed counters rather than three queries: the
 * numerators and the denominator must describe the SAME instant, and three
 * round trips against NOW() cannot promise that.
 *
 * Hard bounces are read from `bounce_kind = 'hard'` and never by parsing
 * `provider_error`: recordFailure COALESCEs `failed:<reason>` into that same
 * column, so an `email.failed` arriving before `email.bounced` would mask a
 * real hard bounce — the fail-OPEN direction (migration 110's column comment).
 *
 * Rates are 0 at zero sends rather than NaN, which keeps the metrics snapshot
 * JSON-serialisable; classifyBreach's MIN_SENDS floor means those zeros are
 * never compared against a threshold anyway.
 *
 * ── THE WINDOW'S LOWER EDGE IS THE LAST RESET, NOT ONLY `NOW() - 7 days` ────
 * (round-1 review, adversarial-1 / B2.1. This makes recovery reachable; the
 * first shape made it arithmetically impossible.)
 *
 * The bug: while a trip is open #900 sends nothing, so the denominator
 * (`sent_at` in the window) drains toward zero as old sends age out, while the
 * numerators keep RECEIVING late-landing bounce and complaint signals from
 * pre-halt sends. The ratio therefore gets monotonically WORSE the longer the
 * halt lasts. An admin reset re-tripped within one poll interval, every time,
 * and runbook §8.3's documented "roll the platform ceiling down, then reset"
 * could not work: rolling a ceiling down changes future volume, and the window
 * is a pure function of history. The only real recoveries were "wait ~7 days
 * for the signals to age out" and "wait for the denominator to fall under
 * BREAKER_MIN_SENDS", i.e. roughly seven days of zero sending.
 *
 * The fix: `GREATEST(NOW() - 7 days, MAX(reset_at))`, applied to the WHERE and
 * to all three FILTERs, so a reset means what an operator thinks it means —
 * only post-reset activity is measured. `GREATEST` IGNORES NULL arguments in
 * Postgres (unlike almost every other function), so with no reset ever
 * recorded this is exactly the old `NOW() - 7 days`; no COALESCE is needed and
 * adding one would be wrong.
 *
 * TWO CONSEQUENCES, both deliberate:
 *
 *  1. Immediately after a reset the window is nearly empty, so `classifyBreach`
 *     cannot trip until BREAKER_MIN_SENDS (100) fresh sends accumulate. That
 *     grace period is the POINT, not a bug: it is the half-open probe a circuit
 *     breaker needs, expressed with the floor the design already has. Without
 *     it the reset is a no-op and the breaker has no exit at all.
 *
 *  2. This CANNOT be abused into silently disabling the breaker. Each reset
 *     buys at most 100 sends of ungoverned volume — three hard bounces inside
 *     that 100 re-trips at once — and the very next 100 post-reset sends are
 *     measured honestly, so a genuinely bad list re-trips almost immediately.
 *     An admin resetting in a loop is a human problem with a durable audit
 *     trail (append-only table, `reset_by` + non-blank `reset_note` enforced by
 *     110's reset_consistency CHECK), not something the arithmetic must defend
 *     against. A NORMAL operator gets a bounded probe, not a disabled governor.
 *
 * THE `WHERE` IS LOAD-BEARING, not cosmetic (adversarial-4 / B1.2): aggregate
 * `FILTER` predicates do not restrict the scan, so the first shape read every
 * row `solicitation_outreach` has ever held — an append-only, retained table —
 * once per poll cycle, forever. Migration 110's comment claiming a bitmap scan
 * is wrong about this statement; 110 is immutable and already at head, so the
 * correction is recorded in the deviations file for a follow-up rather than
 * edited into the migration.
 */
async function readBreakerWindow(sql: Sql | TransactionSql): Promise<BreakerWindow> {
  const [row] = await sql<{ sends: number; hard_bounces: number; complaints: number }[]>`
    WITH bounds AS (
      SELECT GREATEST(
               NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS}::int),
               (SELECT MAX(reset_at) FROM solicitation_send_breaker)
             ) AS window_start
    )
    SELECT
      COUNT(*) FILTER (WHERE o.sent_at >= b.window_start)::int AS sends,
      -- UNCLASSIFIED BOUNCES COUNT AS HARD (spec-3 / B1.4), and this half is
      -- required for the lane's half to mean anything. classifyBounce defaults
      -- an unrecognised or missing bounce.type to 'soft'; that default was tuned
      -- for business flagging, but here it is a GOVERNOR's numerator, so the
      -- Solicitation lane now leaves bounce_kind NULL rather than asserting a
      -- kind it cannot know. A NULL kind on a bounced row is therefore
      -- "the provider bounced this and we could not classify it" — and a
      -- governor the intake specifies as fail-CLOSED must count that with the
      -- hard bounces, not silently drop it. Dropping it is exactly how a Resend
      -- payload-shape change would make the breaker never trip.
      COUNT(*) FILTER (
        WHERE o.bounced_at >= b.window_start
          AND (o.bounce_kind = 'hard' OR o.bounce_kind IS NULL)
      )::int AS hard_bounces,
      COUNT(*) FILTER (WHERE o.complained_at >= b.window_start)::int AS complaints
    FROM solicitation_outreach o
    CROSS JOIN bounds b
    WHERE o.sent_at >= b.window_start
       OR o.bounced_at >= b.window_start
       OR o.complained_at >= b.window_start
  `;
  const sends = row?.sends ?? 0;
  const hardBounces = row?.hard_bounces ?? 0;
  const complaints = row?.complaints ?? 0;
  return {
    sends,
    hardBounces,
    complaints,
    hardBounceRate: sends === 0 ? 0 : hardBounces / sends,
    complaintRate: sends === 0 ? 0 : complaints / sends,
  };
}

/**
 * The breach verdict, in a fixed precedence: MIN_SENDS floor, then hard bounce,
 * then complaint.
 *
 * Hard bounce is checked before complaint because it is the louder signal and
 * the one a provider acts on soonest; when both breach in the same window the
 * page must name the metric an operator has to fix first. That precedence is
 * unobservable from any single-threshold test, so it has one of its own.
 */
function classifyBreach(w: BreakerWindow): BreakerTripReason | null {
  if (w.sends < BREAKER_MIN_SENDS) return null;
  if (w.hardBounceRate > BREAKER_HARD_BOUNCE_RATE) return 'hard_bounce_rate';
  if (w.complaintRate > BREAKER_COMPLAINT_RATE) return 'complaint_rate';
  return null;
}

/**
 * How this module renders a breaker rate — and it has a TWIN, deliberately.
 *
 * IF YOU CHANGE THE FORMAT HERE, CHANGE IT IN `SendBreakerClient.tsx` TOO. That
 * file keeps its own byte-identical copy (std-5 / B1.11, an open LOW follow-up),
 * so the two can drift and nothing catches it. The harm is concrete: the Sentry
 * page this module writes links straight to the admin panel, an operator reads
 * the same two rates in both places within seconds, and a one-decimal drift makes
 * the page and the panel look like they disagree about whether the threshold was
 * crossed.
 *
 * NOT exported, and the client MUST NOT import it from here — that is a build
 * constraint, not a preference. This module instantiates a worker logger at
 * module scope (`createWorkerLogger` -> `log-context` -> `node:async_hooks`), so
 * one RUNTIME import from a `'use client'` file drags that chain into the client
 * chunk and Turbopack fails the route build. #898 proved it both ways: exporting
 * this helper broke `pnpm build`, and reverting to the client's local copy fixed
 * it. Type-only imports are erased and stay fine.
 *
 * The honest close is a shared formatter under `src/components/admin/ui/`, which
 * needs a surface amendment this branch has not spent; recorded as a follow-up.
 */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * The page. DETAIL IS AGGREGATE-ONLY — counts, rates, thresholds and the window
 * length — following the checkStalledSendBatches precedent ("ids and durations
 * only"). Never a recipient address, a subject, or body text: this finding
 * leaves the platform through an alert sink.
 */
function breakerFinding(reason: BreakerTripReason, w: BreakerWindow): HealthFinding {
  const title =
    reason === 'hard_bounce_rate'
      ? `Solicitation sending halted — hard bounce rate ${formatRate(w.hardBounceRate)} over ${w.sends} sends in ${BREAKER_WINDOW_DAYS} days exceeds ${formatRate(BREAKER_HARD_BOUNCE_RATE)}`
      : `Solicitation sending halted — complaint rate ${formatRate(w.complaintRate)} over ${w.sends} sends in ${BREAKER_WINDOW_DAYS} days exceeds ${formatRate(BREAKER_COMPLAINT_RATE)}`;
  return {
    key: 'solicitation_send_breaker_tripped',
    level: 'error',
    title,
    detail: breakerDetail(reason, w),
  };
}

/**
 * The LEVEL-TRIGGERED re-page: sending is still halted and nobody has reset it.
 *
 * Same `key` as the trip finding on purpose — the key is the alert-routing tag
 * (`tags.finding` in emitHealthFindings), so one condition keeps one routing
 * rule. The TITLE differs and is deliberately CONSTANT per trip reason: Sentry
 * groups captureMessage by its text, so a stable title collapses the repeat
 * into one issue that keeps receiving events, while a title carrying a
 * changing rate or elapsed time would open a fresh issue every five minutes.
 * Elapsed information rides in `detail`, which is Sentry `extra` and plays no
 * part in grouping.
 *
 * The metrics are the trip's own frozen snapshot, not a fresh measurement:
 * recomputing the window on every halted tick would re-run the expensive
 * aggregate to no purpose, since nothing is sending. A live window read for the
 * admin surface is a separate, still-open follow-up.
 */
function openTripFinding(trip: SendBreakerTrip): HealthFinding {
  return {
    key: 'solicitation_send_breaker_tripped',
    level: 'error',
    title: `Solicitation sending is STILL halted — the ${trip.tripReason} breaker trip is open and has not been reset`,
    detail: {
      ...breakerDetail(trip.tripReason, trip.metrics),
      trip_id: trip.id,
      tripped_at: trip.trippedAt.toISOString(),
      still_open: true,
    },
  };
}

/** The aggregate-only detail body both findings carry. */
function breakerDetail(reason: BreakerTripReason, w: BreakerWindow): Record<string, unknown> {
  return {
    trip_reason: reason,
    sends: w.sends,
    hard_bounces: w.hardBounces,
    complaints: w.complaints,
    hard_bounce_rate: w.hardBounceRate,
    complaint_rate: w.complaintRate,
    hard_bounce_threshold: BREAKER_HARD_BOUNCE_RATE,
    complaint_threshold: BREAKER_COMPLAINT_RATE,
    min_sends: BREAKER_MIN_SENDS,
    window_days: BREAKER_WINDOW_DAYS,
  };
}
