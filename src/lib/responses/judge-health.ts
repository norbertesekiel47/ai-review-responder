import type { Sql } from 'postgres';
import { publisherSubscriptionEligibleSql } from '@/lib/shared/subscription-eligibility-sql';

export const JUDGE_STALENESS_LIMIT_MINUTES = 60;
export const JUDGE_ERROR_DENSITY_MIN_COUNT = 3;
export const JUDGE_ERROR_DENSITY_SHARE = 0.5;
export const JUDGE_LOOKBACK_HOURS = 24;

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
    ) AS has_stale_unjudged
  `;

  const [density] = await sql<ErrorDensityRow[]>`
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE verdict = 'error')::int AS error_count
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
