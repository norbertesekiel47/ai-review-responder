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
// Type-only, therefore erased: the finding SHAPE has one owner (the poller that
// consumes it) and duplicating it here would let the two drift. No runtime edge
// from src/lib into worker/ is created.
import type { HealthFinding } from '../../../worker/background/pollers/health-alert/checks';

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
 * HealthFinding to page on (null when healthy or already open).
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
 * IDEMPOTENT WHILE A TRIP IS OPEN. The insert's conflict target is inferred
 * from `solicitation_send_breaker_one_open`, so a second breached tick is a
 * no-op that returns null — the breaker pages ONCE, not every five minutes for
 * as long as the breach stands.
 */
export async function evaluateSendBreaker(sql: Sql | TransactionSql): Promise<HealthFinding | null> {
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
  if (!inserted) return null; // a trip was already open — do not re-page
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
 * seven-day window would be worse. The next poller tick re-evaluates honestly
 * and re-trips if the breach stands.
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
 */
async function readBreakerWindow(sql: Sql | TransactionSql): Promise<BreakerWindow> {
  const [row] = await sql<{ sends: number; hard_bounces: number; complaints: number }[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE sent_at >= NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS}::int)
      )::int AS sends,
      COUNT(*) FILTER (
        WHERE bounce_kind = 'hard'
          AND bounced_at >= NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS}::int)
      )::int AS hard_bounces,
      COUNT(*) FILTER (
        WHERE complained_at >= NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS}::int)
      )::int AS complaints
    FROM solicitation_outreach
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
    detail: {
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
    },
  };
}
