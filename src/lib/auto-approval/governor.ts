import type { Sql, TransactionSql } from 'postgres';
import { lockAutonomyAccount } from '@/lib/auto-approval/suspension';
import type { AutonomySuspensionEvidence, AutonomySuspensionTrigger } from '@/lib/shared/worker-types';

export const GOVERNOR_WINDOW_DAYS = 7;
export const GOVERNOR_MIN_SAMPLE = 5;
export const GOVERNOR_EDIT_RATE_THRESHOLD = 0.5;
export const GOVERNOR_VETO_RATE_THRESHOLD = 0.3;
export const GOVERNOR_JUDGE_SIGNAL_RATE_THRESHOLD = 0.4;

export interface GovernorRate {
  numerator: number;
  denominator: number;
  rate: number;
}

export interface GovernorRates {
  edit: GovernorRate;
  veto: GovernorRate;
  judgeSignal: GovernorRate;
}

export interface GovernorBreach {
  trigger: Exclude<AutonomySuspensionTrigger, 'judge_flag'>;
  evidence: Extract<AutonomySuspensionEvidence, { rate: number }>;
}

export interface GovernorCandidate {
  account_id: string;
  window_start: Date;
}

interface OutcomeCounts {
  edited_count: number;
  approved_count: number;
  vetoed_count: number;
  auto_posted_count: number;
}

interface JudgeCounts {
  pass_count: number;
  warn_count: number;
  flag_count: number;
}

interface LockedGovernorPolicy {
  location_id: string | null;
  persona: string;
  action_class: string;
  auto_approve_min_star: number | null;
  suspended_at: Date | null;
}

const MAX_CANDIDATES = 100;

export async function listGovernorCandidates(
  sql: Sql,
  limit: number,
  afterAccountId: string | null = null,
): Promise<GovernorCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
    throw new RangeError('governor candidate limit must be an integer from 1 to 100');
  }

  return sql<GovernorCandidate[]>`
    SELECT
      armed.account_id,
      GREATEST(
        NOW() - make_interval(days => ${GOVERNOR_WINDOW_DAYS}),
        COALESCE(MAX(aal.created_at), '-infinity'::timestamptz)
    ) AS window_start
    FROM auto_approval_policies armed
    LEFT JOIN account_audit_log aal
      ON aal.account_id = armed.account_id
      AND aal.event_type = 'autonomy_unsuspended'
    WHERE armed.auto_approve_min_star IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM auto_approval_policies account_default
        WHERE account_default.account_id = armed.account_id
          AND account_default.location_id IS NULL
          AND account_default.persona = 'reply'
          AND account_default.action_class = 'posting'
          AND account_default.suspended_at IS NOT NULL
    )
    GROUP BY armed.account_id
    ORDER BY
      CASE WHEN COALESCE(armed.account_id > ${afterAccountId}::uuid, TRUE)
        THEN 0 ELSE 1
      END,
      armed.account_id
    LIMIT ${limit}
  `;
}

/**
 * Locks current policy rows and rejects a stale governor snapshot before the
 * suspension writer runs in the same transaction. This lane deliberately
 * touches policy/audit rows only and takes no review-lane locks.
 */
export async function revalidateGovernorCandidate(
  tx: TransactionSql,
  accountId: string,
  observedWindowStart: Date,
): Promise<boolean> {
  await lockAutonomyAccount(tx, accountId);

  const policies = await tx<LockedGovernorPolicy[]>`
    SELECT
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      suspended_at
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
    ORDER BY id
    FOR UPDATE
  `;

  const armed = policies.some((policy) => policy.auto_approve_min_star !== null);
  const suspendedDefault = policies.some((policy) =>
    policy.location_id === null
    && policy.persona === 'reply'
    && policy.action_class === 'posting'
    && policy.suspended_at !== null);
  if (!armed || suspendedDefault) return false;

  const [newerUnsuspend] = await tx<{ id: string }[]>`
    SELECT id
    FROM account_audit_log
    WHERE account_id = ${accountId}::uuid
      AND event_type = 'autonomy_unsuspended'
      AND created_at > ${observedWindowStart}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return !newerUnsuspend;
}

const asRate = (numerator: number, denominator: number): GovernorRate => ({
  numerator,
  denominator,
  rate: denominator > 0 ? numerator / denominator : 0,
});

export async function computeGovernorRates(
  sql: Sql,
  accountId: string,
  windowStart: Date,
): Promise<GovernorRates> {
  const [outcomes] = await sql<OutcomeCounts[]>`
    SELECT
      COALESCE(SUM(unit_count) FILTER (
        WHERE outcome_kind = ${'reply_edited_by_owner'}
      ), 0)::int AS edited_count,
      COALESCE(SUM(unit_count) FILTER (
        WHERE outcome_kind = ${'reply_approved_no_edit'}
      ), 0)::int AS approved_count,
      COALESCE(SUM(unit_count) FILTER (
        WHERE outcome_kind = ${'reply_vetoed_by_owner'}
      ), 0)::int AS vetoed_count,
      COALESCE(SUM(unit_count) FILTER (
        WHERE outcome_kind = ${'reply_auto_posted'}
      ), 0)::int AS auto_posted_count
    FROM agent_outcomes
    WHERE account_id = ${accountId}::uuid
      AND occurred_at >= ${windowStart}
      AND outcome_kind IN (
        ${'reply_edited_by_owner'},
        ${'reply_approved_no_edit'},
        ${'reply_vetoed_by_owner'},
        ${'reply_auto_posted'}
      )
  `;
  const [verdicts] = await sql<JudgeCounts[]>`
    SELECT
      COUNT(*) FILTER (WHERE verdict = 'pass')::int AS pass_count,
      COUNT(*) FILTER (WHERE verdict = 'warn')::int AS warn_count,
      COUNT(*) FILTER (WHERE verdict = 'flag')::int AS flag_count
    FROM judge_verdicts
    WHERE account_id = ${accountId}::uuid
      AND created_at >= ${windowStart}
      AND verdict IN ('pass', 'warn', 'flag')
  `;

  const edited = outcomes?.edited_count ?? 0;
  const approved = outcomes?.approved_count ?? 0;
  const vetoed = outcomes?.vetoed_count ?? 0;
  const autoPosted = outcomes?.auto_posted_count ?? 0;
  const passed = verdicts?.pass_count ?? 0;
  const warned = verdicts?.warn_count ?? 0;
  const flagged = verdicts?.flag_count ?? 0;

  return {
    edit: asRate(edited, edited + approved),
    veto: asRate(vetoed, vetoed + autoPosted),
    judgeSignal: asRate(warned + flagged, passed + warned + flagged),
  };
}

const breach = (
  trigger: GovernorBreach['trigger'],
  value: GovernorRate,
): GovernorBreach => ({
  trigger,
  evidence: {
    rate: value.rate,
    numer: value.numerator,
    denom: value.denominator,
    windowDays: GOVERNOR_WINDOW_DAYS,
  },
});

export function evaluateAccount(rates: GovernorRates): GovernorBreach | null {
  if (
    rates.edit.denominator >= GOVERNOR_MIN_SAMPLE
    && rates.edit.rate >= GOVERNOR_EDIT_RATE_THRESHOLD
  ) {
    return breach('governor_edit_rate', rates.edit);
  }
  if (
    rates.veto.denominator >= GOVERNOR_MIN_SAMPLE
    && rates.veto.rate >= GOVERNOR_VETO_RATE_THRESHOLD
  ) {
    return breach('governor_veto_rate', rates.veto);
  }
  if (
    rates.judgeSignal.denominator >= GOVERNOR_MIN_SAMPLE
    && rates.judgeSignal.rate >= GOVERNOR_JUDGE_SIGNAL_RATE_THRESHOLD
  ) {
    return breach('governor_judge_signal_rate', rates.judgeSignal);
  }
  return null;
}
