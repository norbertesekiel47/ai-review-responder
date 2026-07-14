import type { Sql } from 'postgres';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { publisherSubscriptionEligibleSql } from '@/lib/shared/subscription-eligibility-sql';
import {
  JUDGE_ERROR_REASON_BUDGET_EXCEEDED,
  JUDGE_LOOKBACK_HOURS,
} from './judge-store';

const JUDGE_STALENESS_LIMIT_MINUTES = 60;
const JUDGE_ERROR_DENSITY_MIN_COUNT = 3;
const JUDGE_ERROR_DENSITY_SHARE = 0.5;

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
 * Staleness measures judge-system THROUGHPUT, not eligibility backlog: a row
 * is stale only when the judge system has KNOWN about it for over the limit
 * (a judge_verdict outbox row — any status — older than the limit exists) and
 * still produced no verdict. An old unjudged post that merely RE-ENTERS
 * eligibility (past-due recovery, admin extension, JUDGE_ENABLED off→on)
 * before the sweep could ever have enqueued it does NOT flag the fleet.
 * Accepted blind spot (spec §5): a dead sweep that never enqueues anything is
 * not detected by staleness — the judge kill-switch downgrade and the
 * error-density signal below remain the covers.
 */
export async function isJudgeHealthy(sql: Sql): Promise<boolean> {
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
  return !staleness.has_stale_unjudged && !errorDense;
}
