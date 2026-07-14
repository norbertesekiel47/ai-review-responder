import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isNotificationBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import {
  AUTONOMY_SUSPENSION_REASONS,
} from '@/lib/auto-approval/suspension';
import type { AccountFlagsInput } from '@/lib/shared/subscription-guard';
import type { AutonomySuspensionTrigger } from '@/lib/shared/worker-types';

export interface AutonomySuspendedNoticeContextInput {
  accountId: string;
  suspensionEventId: string;
  trigger: AutonomySuspensionTrigger;
}

export interface AutonomySuspendedNoticeContextLogger {
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface AutonomySuspendedAccountRow extends ActiveOffboardingProjection {
  account_id: string;
  display_name: string;
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  suspended_at: Date | null;
}

export interface AutonomySuspendedBusinessRow {
  business_id: string;
  name: string;
  display_label: string | null;
  owner_email_bounced: boolean;
}

export interface AutonomySuspensionAuditRow {
  trigger: AutonomySuspensionTrigger;
  suspension_event_id: string;
  reason: string;
}

export type AutonomySuspendedNoticeContextResult =
  | {
      kind: 'ok';
      account: AutonomySuspendedAccountRow;
      business: AutonomySuspendedBusinessRow;
      audit: AutonomySuspensionAuditRow;
    }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip'; reason: string };

export async function loadAutonomySuspendedNoticeContext(
  sql: Sql,
  input: AutonomySuspendedNoticeContextInput,
  logger: AutonomySuspendedNoticeContextLogger,
): Promise<AutonomySuspendedNoticeContextResult> {
  const [account] = await sql<AutonomySuspendedAccountRow[]>`
    SELECT a.id AS account_id, a.display_name, a.subscription_status,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags,
           policy.suspended_at,
           ao.id AS offboarding_id,
           ao.account_id AS offboarding_account_id,
           ao.mode AS offboarding_mode,
           ao.status AS offboarding_status,
           ao.failed_step AS offboarding_failed_step,
           ao.access_ends_at AS offboarding_access_ends_at,
           ao.teardown_started_at AS offboarding_teardown_started_at,
           ao.purge_after AS offboarding_purge_after,
           ao.purge_started_at AS offboarding_purge_started_at,
           ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM accounts a
    LEFT JOIN auto_approval_policies policy
      ON policy.account_id = a.id
     AND policy.location_id IS NULL
     AND policy.persona = 'reply'
     AND policy.action_class = 'posting'
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.terminal_at IS NULL
    WHERE a.id = ${input.accountId}::uuid
    ORDER BY ao.created_at DESC NULLS LAST
    LIMIT 1
  `;
  if (!account) {
    logger.warn(`autonomy_suspended_notice account-not-found account=${input.accountId}`);
    return { kind: 'fail', reason: 'account_not_found' };
  }
  if (account.suspended_at === null) {
    logger.warn(`autonomy_suspended_notice stale-unsuspended account=${input.accountId}`);
    return { kind: 'skip', reason: 'not_suspended' };
  }
  if (isNotificationBlocked(activeOffboardingStateFromProjection(account))) {
    logger.warn(`autonomy_suspended_notice offboarding account=${input.accountId}`);
    return { kind: 'skip', reason: 'offboarding' };
  }

  const [business] = await sql<AutonomySuspendedBusinessRow[]>`
    SELECT b.id AS business_id, b.name, b.display_label, b.owner_email_bounced
    FROM businesses b
    WHERE b.account_id = ${input.accountId}::uuid
      AND b.archived_at IS NULL
    ORDER BY b.is_primary DESC, b.created_at ASC
    LIMIT 1
  `;
  if (!business) {
    logger.warn(`autonomy_suspended_notice no-active-location account=${input.accountId}`);
    return { kind: 'skip', reason: 'no_active_location' };
  }

  const [audit] = await sql<{
    trigger: string;
    suspension_event_id: string;
  }[]>`
    SELECT payload->>'trigger' AS trigger,
           payload->>'suspension_event_id' AS suspension_event_id
    FROM account_audit_log
    WHERE account_id = ${input.accountId}::uuid
      AND event_type = 'autonomy_suspended'
      AND payload->>'suspension_event_id' = ${input.suspensionEventId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!audit || audit.trigger !== input.trigger || !(audit.trigger in AUTONOMY_SUSPENSION_REASONS)) {
    logger.error(`autonomy_suspended_notice invalid-audit event=${input.suspensionEventId}`);
    return { kind: 'fail', reason: 'suspension_audit_not_found' };
  }

  const [latestTransition] = await sql<{
    event_type: string;
    suspension_event_id: string | null;
  }[]>`
    SELECT event_type, payload->>'suspension_event_id' AS suspension_event_id
    FROM account_audit_log
    WHERE account_id = ${input.accountId}::uuid
      AND event_type IN ('autonomy_suspended', 'autonomy_unsuspended')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  if (
    !latestTransition ||
    latestTransition.event_type === 'autonomy_unsuspended' ||
    latestTransition.suspension_event_id !== input.suspensionEventId
  ) {
    logger.warn(`autonomy_suspended_notice stale-event event=${input.suspensionEventId}`);
    return { kind: 'skip', reason: 'stale_suspension_event' };
  }

  const trigger = audit.trigger as AutonomySuspensionTrigger;
  return {
    kind: 'ok',
    account,
    business,
    audit: {
      trigger,
      suspension_event_id: audit.suspension_event_id,
      reason: AUTONOMY_SUSPENSION_REASONS[trigger],
    },
  };
}
