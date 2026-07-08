// worker/jobs/escalation-notice/context.ts
//
// Loads the escalation + review + business rows needed by the Guardian
// escalation-notice dispatcher (WS3). Mirrors the auto-post-notice context
// loader but with escalation-specific guards:
//   - escalation not found / id mismatch → fail outbox
//   - status = 'resolved'                → skip (the notice is moot;
//                                           'acknowledged' still sends — the
//                                           notice may be what acknowledges it
//                                           elsewhere)
//   - business not found                 → fail outbox
//   - archived / offboarding             → skip
//
// The triage snapshot (severity/source/issues) comes from the
// review_escalations row persisted at raise time — no LLM call here.

import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isNotificationBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import type { AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import type { TriageIssue, TriageSeverity } from '../../../src/lib/reviews/triage-schema';
import { ESCALATION_STATUS } from '../../../src/lib/escalations/types';

export interface EscalationNoticeContextInput {
  escalationId: string;
  businessId: string;
}

export interface EscalationNoticeContextLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface EscalationRow {
  id: string;
  status: string;
  esc_business_id: string;
  account_id: string;
  review_id: string;
  triage_severity: TriageSeverity;
  triage_source: string;
  triage_issues: TriageIssue[] | null;
  reviewer_name: string;
  star_rating: number | null;
  review_text: string | null;
}

export interface EscalationNoticeBusinessRow extends ActiveOffboardingProjection {
  account_id: string;
  name: string;
  display_label: string | null;
  owner_email_bounced: boolean;
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

export type EscalationNoticeContextResult =
  | { kind: 'ok'; escalation: EscalationRow; business: EscalationNoticeBusinessRow }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip'; reason: string };

// discriminated ok/fail/skip context loader whose branches map 1:1 to the
// load-and-validate gates (escalation missing/mismatch, already resolved,
// business missing, archived, offboarding); inherent to a single-pass loader.
// fallow-ignore-next-line complexity
export async function loadEscalationNoticeContext(
  sql: Sql,
  input: EscalationNoticeContextInput,
  logger: EscalationNoticeContextLogger,
): Promise<EscalationNoticeContextResult> {
  const [escalation] = await sql<EscalationRow[]>`
    SELECT e.id, e.status, e.business_id AS esc_business_id, e.account_id,
           e.review_id, e.triage_severity, e.triage_source, e.triage_issues,
           r.reviewer_name, r.star_rating, r.review_text
    FROM review_escalations e
    JOIN reviews r ON r.id = e.review_id
    WHERE e.id = ${input.escalationId}
  `;

  if (!escalation) {
    logger.warn(`Escalation ${input.escalationId} not found`);
    return { kind: 'fail', reason: 'escalation_not_found' };
  }
  if (escalation.esc_business_id !== input.businessId) {
    logger.error(
      `Escalation ${input.escalationId} belongs to business ${escalation.esc_business_id}, not ${input.businessId}`,
    );
    return { kind: 'fail', reason: 'business_id_mismatch' };
  }
  // Resolved means the owner already closed it out — the notice is moot.
  // 'acknowledged' still sends: the acknowledgement may have raced the notice.
  if (escalation.status === ESCALATION_STATUS.RESOLVED) {
    logger.warn(`Escalation ${input.escalationId} is resolved — skipping notice`);
    return { kind: 'skip', reason: 'already_resolved' };
  }

  const [business] = await sql<EscalationNoticeBusinessRow[]>`
    SELECT b.name, b.display_label, b.owner_email_bounced, b.archived_at,
           a.id AS account_id, a.subscription_status,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags,
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
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.terminal_at IS NULL
    WHERE b.id = ${input.businessId}
    ORDER BY ao.created_at DESC NULLS LAST
    LIMIT 1
  `;
  if (!business) {
    logger.warn(`Business ${input.businessId} not found`);
    return { kind: 'fail', reason: 'business_not_found' };
  }
  if (business.archived_at !== null) {
    logger.warn(`Business ${input.businessId} is archived — skipping escalation notice`);
    return { kind: 'skip', reason: 'archived_location' };
  }
  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isNotificationBlocked(offboardingState)) {
    logger.warn(`Business ${input.businessId} account is offboarding — skipping escalation notice`);
    return { kind: 'skip', reason: 'offboarding' };
  }

  return { kind: 'ok', escalation, business };
}
