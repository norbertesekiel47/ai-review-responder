import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import {
  computeGovernorRatesForAccounts,
  GOVERNOR_WINDOW_DAYS,
  type GovernorRates,
} from '@/lib/auto-approval/governor';
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import { writeAccountAuditLog } from '@/lib/audit/log';
import {
  enqueueAutonomyAdminAlert,
  enqueueAutonomySuspendedNotice,
} from '@/lib/shared/job-outbox-helpers';
import type {
  AutonomySuspensionEvidence,
  AutonomySuspensionTrigger,
} from '@/lib/shared/worker-types';

export const AUTONOMY_SUSPENSION_REASONS = {
  judge_flag: 'A safety review flagged a recently auto-posted reply.',
  governor_edit_rate: 'Recent owner edits exceeded the auto-posting safety threshold.',
  governor_veto_rate: 'Recent owner vetoes exceeded the auto-posting safety threshold.',
  governor_judge_signal_rate: 'Recent safety reviews exceeded the auto-posting safety threshold.',
} as const satisfies Record<AutonomySuspensionTrigger, string>;

export interface SuspendAccountAutonomyInput {
  accountId: string;
  trigger: AutonomySuspensionTrigger;
  suspensionEventId: string;
  evidence: AutonomySuspensionEvidence;
  correlationId?: string;
}

export interface UnsuspendAccountAutonomyInput {
  accountId: string;
  actorUserId: string;
  note: string;
}

interface SuspendedPolicyRow {
  policy_id: string;
  account_id: string;
  account_name: string;
  location_id: string | null;
  location_name: string | null;
  suspended_reason: string | null;
  suspended_at: Date;
  window_start: Date;
}

interface RecentFlagVerdictRow {
  id: string;
  account_id: string;
  business_id: string;
  review_id: string;
  response_id: string;
  reason_categories: string[];
  created_at: Date;
}

export interface RecentFlagVerdict {
  id: string;
  businessId: string;
  reviewId: string;
  responseId: string;
  reasons: string[];
  createdAt: Date;
}

export interface SuspendedPolicyListItem {
  policyId: string;
  accountId: string;
  accountName: string;
  locationId: string | null;
  locationName: string | null;
  scope: 'account' | 'location';
  suspendedReason: string | null;
  trigger: AutonomySuspensionTrigger | null;
  suspendedAt: Date;
  governorRates: GovernorRates;
  recentFlagVerdicts: RecentFlagVerdict[];
}

const suspensionTriggerByReason = new Map<string, AutonomySuspensionTrigger>(
  Object.entries(AUTONOMY_SUSPENSION_REASONS).map(([trigger, reason]) => [
    reason,
    trigger as AutonomySuspensionTrigger,
  ]),
);

async function loadSuspendedPolicyRows(sql: Sql): Promise<SuspendedPolicyRow[]> {
  return sql<SuspendedPolicyRow[]>`
    SELECT
      policy.id AS policy_id,
      policy.account_id,
      account.display_name AS account_name,
      policy.location_id,
      COALESCE(NULLIF(location.display_label, ''), location.name) AS location_name,
      policy.suspended_reason,
      policy.suspended_at,
      GREATEST(
        NOW() - make_interval(days => ${GOVERNOR_WINDOW_DAYS}),
        COALESCE(MAX(audit.created_at), '-infinity'::timestamptz)
      ) AS window_start
    FROM auto_approval_policies policy
    JOIN accounts account ON account.id = policy.account_id
    LEFT JOIN businesses location
      ON location.id = policy.location_id
      AND location.account_id = policy.account_id
    LEFT JOIN account_audit_log audit
      ON audit.account_id = policy.account_id
      AND audit.event_type = 'autonomy_unsuspended'
    WHERE policy.suspended_at IS NOT NULL
    GROUP BY
      policy.id,
      policy.account_id,
      account.display_name,
      policy.location_id,
      location.display_label,
      location.name,
      policy.suspended_reason,
      policy.suspended_at
    ORDER BY policy.suspended_at DESC, policy.id
    LIMIT 100
  `;
}

async function loadGovernorRatesByAccount(
  sql: Sql,
  rows: SuspendedPolicyRow[],
): Promise<Map<string, GovernorRates>> {
  const windowStartByAccount = new Map<string, Date>();
  for (const row of rows) {
    if (!windowStartByAccount.has(row.account_id)) {
      windowStartByAccount.set(row.account_id, row.window_start);
    }
  }
  return computeGovernorRatesForAccounts(sql, [...windowStartByAccount].map(
    ([accountId, windowStart]) => ({ accountId, windowStart }),
  ));
}

async function loadRecentFlagRows(
  sql: Sql,
  accountIds: string[],
): Promise<RecentFlagVerdictRow[]> {
  return sql<RecentFlagVerdictRow[]>`
    WITH ranked_flags AS (
      SELECT
        verdict.id,
        verdict.account_id,
        verdict.business_id,
        verdict.review_id,
        verdict.response_id,
        ARRAY(
          SELECT jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(verdict.reasons) = 'array' THEN verdict.reasons
              ELSE '[]'::jsonb
            END
          )
        ) AS reason_categories,
        verdict.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY verdict.account_id
          ORDER BY verdict.created_at DESC, verdict.id DESC
        ) AS flag_rank
      FROM judge_verdicts verdict
      WHERE verdict.account_id = ANY(${accountIds}::uuid[])
        AND verdict.verdict = 'flag'
    )
    SELECT
      id,
      account_id,
      business_id,
      review_id,
      response_id,
      reason_categories,
      created_at
    FROM ranked_flags
    WHERE flag_rank <= 5
    ORDER BY account_id, created_at DESC, id DESC
  `;
}

function groupRecentFlags(
  flagRows: RecentFlagVerdictRow[],
): Map<string, RecentFlagVerdict[]> {
  const flagsByAccount = new Map<string, RecentFlagVerdict[]>();
  for (const verdict of flagRows) {
    const accountFlags = flagsByAccount.get(verdict.account_id) ?? [];
    accountFlags.push({
      id: verdict.id,
      businessId: verdict.business_id,
      reviewId: verdict.review_id,
      responseId: verdict.response_id,
      reasons: verdict.reason_categories,
      createdAt: verdict.created_at,
    });
    flagsByAccount.set(verdict.account_id, accountFlags);
  }
  return flagsByAccount;
}

function projectSuspendedPolicies(
  rows: SuspendedPolicyRow[],
  ratesByAccount: Map<string, GovernorRates>,
  flagsByAccount: Map<string, RecentFlagVerdict[]>,
): SuspendedPolicyListItem[] {
  return rows.map((row) => {
    const governorRates = ratesByAccount.get(row.account_id);
    if (!governorRates) throw new Error('suspended policy is missing governor rates');
    return {
      policyId: row.policy_id,
      accountId: row.account_id,
      accountName: row.account_name,
      locationId: row.location_id,
      locationName: row.location_name,
      scope: row.location_id === null ? 'account' : 'location',
      suspendedReason: row.suspended_reason,
      trigger: row.suspended_reason
        ? (suspensionTriggerByReason.get(row.suspended_reason) ?? null)
        : null,
      suspendedAt: row.suspended_at,
      governorRates,
      recentFlagVerdicts: flagsByAccount.get(row.account_id) ?? [],
    };
  });
}

/**
 * Admin-only bounded projection for the autonomy recovery queue.
 *
 * The caller owns the admin+AAL2 gate. This deep module keeps the cross-account
 * SQL and aggregation out of the route: at most 100 policy rows, one pair of
 * indexed governor queries per unique account, and five flag verdicts per
 * account. It is read-only and takes no review-lane or account locks.
 */
export async function listSuspendedPolicies(sql: Sql): Promise<SuspendedPolicyListItem[]> {
  const rows = await loadSuspendedPolicyRows(sql);
  if (rows.length === 0) return [];

  const accountIds = [...new Set(rows.map((row) => row.account_id))];
  const ratesByAccount = await loadGovernorRatesByAccount(sql, rows);
  const flagRows = await loadRecentFlagRows(sql, accountIds);
  return projectSuspendedPolicies(rows, ratesByAccount, groupRecentFlags(flagRows));
}

/**
 * Sole production writer for auto-approval suspension fields.
 *
 * The governor/suspension-only path intentionally touches policy, account
 * audit, and outbox rows only: it takes no review-lane locks and is cycle-free
 * with the global reviews → businesses → response children → agent_runs order.
 * A Judge caller must anchor its review lane before entering this helper.
 */
export async function suspendAccountAutonomy(
  tx: TransactionSql,
  input: SuspendAccountAutonomyInput,
): Promise<{ newlySuspended: boolean }> {
  await lockAutonomyAccount(tx, input.accountId);

  const [policy] = await tx<{ id: string }[]>`
    INSERT INTO auto_approval_policies (
      id,
      account_id,
      location_id,
      persona,
      action_class,
      auto_approve_min_star,
      suspended_at,
      suspended_reason
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.accountId}::uuid,
      NULL,
      'reply',
      'posting',
      NULL,
      NOW(),
      ${AUTONOMY_SUSPENSION_REASONS[input.trigger]}
    )
    ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
    DO UPDATE SET
      suspended_at = NOW(),
      suspended_reason = EXCLUDED.suspended_reason,
      updated_at = NOW()
      WHERE auto_approval_policies.suspended_at IS NULL
    RETURNING id
  `;

  if (!policy) return { newlySuspended: false };

  const auditPayload = {
    trigger: input.trigger,
    suspension_event_id: input.suspensionEventId,
    evidence: input.evidence,
  };
  await writeAccountAuditLog(tx, {
    accountId: input.accountId,
    eventType: 'autonomy_suspended',
    entityType: 'auto_approval_policy',
    payload: auditPayload,
  });
  await enqueueAutonomySuspendedNotice(tx, {
    accountId: input.accountId,
    suspensionEventId: input.suspensionEventId,
    trigger: input.trigger,
    correlationId: input.correlationId,
  });
  await enqueueAutonomyAdminAlert(tx, {
    accountId: input.accountId,
    suspensionEventId: input.suspensionEventId,
    trigger: input.trigger,
    evidence: input.evidence,
  });

  return { newlySuspended: true };
}

export async function unsuspendAccountAutonomy(
  tx: TransactionSql,
  input: UnsuspendAccountAutonomyInput,
): Promise<{ unsuspended: boolean; rearmed: boolean }> {
  await lockAutonomyAccount(tx, input.accountId);

  const [policy] = await tx<{
    previous_reason: string | null;
    auto_approve_min_star: number | null;
  }[]>`
    WITH target AS (
      SELECT id, suspended_reason, auto_approve_min_star
      FROM auto_approval_policies
      WHERE account_id = ${input.accountId}::uuid
        AND location_id IS NULL
        AND persona = 'reply'
        AND action_class = 'posting'
        AND suspended_at IS NOT NULL
      FOR UPDATE
    ), updated AS (
      UPDATE auto_approval_policies AS policy
      SET suspended_at = NULL,
          suspended_reason = NULL,
          updated_at = NOW()
      FROM target
      WHERE policy.id = target.id
      RETURNING target.suspended_reason AS previous_reason,
                target.auto_approve_min_star
    )
    SELECT previous_reason, auto_approve_min_star FROM updated
  `;

  if (!policy) return { unsuspended: false, rearmed: false };

  await writeAccountAuditLog(tx, {
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    eventType: 'autonomy_unsuspended',
    entityType: 'auto_approval_policy',
    payload: {
      note: input.note,
      previous_reason: policy.previous_reason,
    },
  });

  return {
    unsuspended: true,
    rearmed: policy.auto_approve_min_star !== null,
  };
}
