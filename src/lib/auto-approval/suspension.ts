import type { TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
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

/**
 * Serializes every autonomy suspension transition on a guaranteed parent row.
 * Mixed review-lane callers (Judge) must acquire their review/business/child
 * locks before entering this account lock; governor/admin callers never acquire
 * review-lane locks, so they cannot form the reverse edge.
 */
export async function lockAutonomyAccount(
  tx: TransactionSql,
  accountId: string,
): Promise<void> {
  const [account] = await tx<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;
  if (!account) throw new Error('autonomy account does not exist');
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
