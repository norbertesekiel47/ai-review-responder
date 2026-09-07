import type { Sql, TransactionSql } from 'postgres';
import { POLLER_JUDGE_SWEEP, readPollerLiveness } from '@/lib/shared/poller-liveness';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { publisherSubscriptionEligibleSql } from '@/lib/shared/subscription-eligibility-sql';
import {
  JUDGE_ERROR_REASON_BUDGET_EXCEEDED,
  JUDGE_LOOKBACK_HOURS,
} from './judge-store';

const JUDGE_STALENESS_LIMIT_MINUTES = 60;
const JUDGE_ERROR_DENSITY_MIN_COUNT = 3;
const JUDGE_ERROR_DENSITY_SHARE = 0.5;
/**
 * How stale the sweep's durable heartbeat may be before the Judge counts as
 * dead (#949). Fifteen missed 60-second ticks: long enough that a Railway
 * redeploy or a slow database does not trip it, short enough that a dead loop
 * is caught in minutes rather than the hour the staleness arm would take.
 * Deliberately NOT sharing JUDGE_STALENESS_LIMIT_MINUTES — the two arms measure
 * different things on different clocks.
 */
const JUDGE_SWEEP_LIVENESS_LIMIT_MINUTES = 15;
/**
 * Exported so `checkJudgeSweepLiveness` (the health-alert probe) thresholds on
 * the SAME number the gate does. An alert that disagreed with the gate about
 * whether the sweep is alive would be worse than no alert at all.
 */
export const JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS = JUDGE_SWEEP_LIVENESS_LIMIT_MINUTES * 60;

interface StalenessRow {
  has_stale_unjudged: boolean;
}

interface ErrorDensityRow {
  total_count: number;
  error_count: number;
}

/**
 * Fleet-wide Judge health used only by the auto-policy publisher gate.
 * Both scans are time-bounded and backed by migration 076 indexes. Database
 * errors intentionally propagate so BullMQ retries instead of downgrading a
 * valid post because the health query itself had a transient failure.
 *
 * Three independent arms, each covering a failure the others cannot see.
 *
 * 1. STALENESS measures judge-system THROUGHPUT, not eligibility backlog: a row
 *    is stale only when the judge system has KNOWN about it for over the limit
 *    (a judge_verdict outbox row — any status — older than the limit exists)
 *    and still produced no verdict. An old unjudged post that merely RE-ENTERS
 *    eligibility (past-due recovery, admin extension, JUDGE_ENABLED off→on)
 *    before the sweep could ever have enqueued it does NOT flag the fleet.
 *
 * 2. ERROR DENSITY catches a judge that answers, but answers badly.
 *
 * 3. SWEEP LIVENESS (#949) catches the failure neither of the above can, and
 *    the reason is structural rather than a matter of tuning. Arm 1's
 *    `EXISTS (… job_outbox …)` clause IS the sweep's own output: a sweep that
 *    never runs writes no such row, so the clause is vacuously false for every
 *    response and the arm cannot fire. Arm 2 needs verdicts, and a dead sweep
 *    produces none. Both signals are therefore silent in exactly the scenario
 *    where the Judge is doing nothing at all, and the probe answered "healthy"
 *    indefinitely. The durable heartbeat (migration 118, written by
 *    `runJudgeSweepCycle`) is the only signal that distinguishes "no Judge work
 *    due" from "no Judge". It FAILS CLOSED on a missing row: an absent
 *    heartbeat is what a loop that has never once run looks like, so treating
 *    it as healthy would reopen the whole hole.
 *
 * Read as a THIRD query rather than folded into the staleness SELECT above:
 * `scripts/ci/tenant-scope-allowlist.ts` keys its cross-account exemptions by
 * file + table + sqlSnippet, so editing either existing statement would break
 * its snippet match. One extra primary-key lookup is cheaper than that churn.
 */
export async function isJudgeHealthy(sql: Sql | TransactionSql): Promise<boolean> {
  const [staleness] = await sql<StalenessRow[]>`
    SELECT EXISTS (
      SELECT 1
      FROM responses r
      JOIN businesses b ON b.id = r.business_id
      JOIN accounts a ON a.id = b.account_id
      WHERE r.status = 'posted'
        AND r.approval_method = 'auto_policy'
        AND r.posted_at >= NOW() - make_interval(hours => ${JUDGE_LOOKBACK_HOURS})
        AND r.posted_at < NOW() - make_interval(mins => ${JUDGE_STALENESS_LIMIT_MINUTES})
        AND ${publisherSubscriptionEligibleSql(sql)}
        AND NOT EXISTS (
          SELECT 1 FROM judge_verdicts jv
          WHERE jv.response_id = r.id
        )
        AND EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.JUDGE_VERDICT}
            AND jo.aggregate_id = r.id
            AND jo.created_at < NOW() - make_interval(mins => ${JUDGE_STALENESS_LIMIT_MINUTES})
        )
    ) AS has_stale_unjudged
  `;

  // Error density excludes budget-DECISION error verdicts (marked
  // 'budget_exceeded' by the judge failed hook): one account exhausting its
  // daily budget is not systemic judge failure and must not gate the fleet.
  // Budget rows still count toward total_count — they are real judge
  // throughput and keep staleness satisfied.
  const [density] = await sql<ErrorDensityRow[]>`
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (
        WHERE verdict = 'error'
          AND NOT COALESCE(reasons @> ${sql.json([JUDGE_ERROR_REASON_BUDGET_EXCEEDED])}, false)
      )::int AS error_count
    FROM judge_verdicts
    WHERE created_at >= NOW() - make_interval(mins => ${JUDGE_STALENESS_LIMIT_MINUTES})
  `;

  if (!staleness || !density) {
    throw new Error('Judge health aggregate query returned no row');
  }

  const errorDense = density.error_count >= JUDGE_ERROR_DENSITY_MIN_COUNT
    && density.error_count / density.total_count >= JUDGE_ERROR_DENSITY_SHARE;
  if (staleness.has_stale_unjudged || errorDense) return false;

  // Arm 3 runs LAST and only when the first two found nothing. The order is a
  // cost choice, not a precedence one: all three arms veto, so any arm firing
  // gives the same answer, and skipping a primary-key lookup once the answer is
  // already `false` costs nothing. The reverse order would be cheaper in the
  // dead-sweep case and more expensive in the healthy case, which is the case
  // that actually runs on every auto-post.
  const liveness = await readPollerLiveness(sql, POLLER_JUDGE_SWEEP);
  if (liveness === null) return false;
  return liveness.ageSeconds < JUDGE_SWEEP_LIVENESS_LIMIT_SECONDS;
}
