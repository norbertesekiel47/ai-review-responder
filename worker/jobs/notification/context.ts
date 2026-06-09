// worker/jobs/notification/context.ts
//
// Loads the response + business rows needed by the notification orchestrator
// and applies the early-exit guards verbatim from the original worker:
//   - response not found              → fail outbox with reason
//   - response/business id mismatch   → fail outbox with reason
//   - response status != pending      → complete outbox (skip)
//   - business not found              → fail outbox with reason
//   - business is archived            → complete outbox (skip) [VAL-LOC-044]
//
// VAL-LOC-044: When a location with pending_approval responses is archived,
// the archive succeeds and pending responses remain pending_approval. The
// notification worker skips dispatch for archived locations — pending
// notifications stay in the outbox but the publisher worker does not send
// them. This is the "subscription guard pattern" where the guard check
// prevents dispatch without modifying the response status.
//
// The orchestrator decides outbox finalization based on the discriminated
// result: 'ok' continues to dispatch, 'skip' means complete outbox cleanly,
// 'fail' carries the reason string for markOutboxFailed.

import { sql } from '../../../src/lib/db/server';
import {
  activeOffboardingStateFromProjection,
  isNotificationBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import type { AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';

export interface NotificationContextInput {
  responseId: string;
  businessId: string;
}

export interface ContextLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ResponseRow {
  id: string;
  response_text: string;
  status: string;
  resp_business_id: string;
  review_id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: string;
}

export interface BusinessRow extends ActiveOffboardingProjection {
  account_id: string;
  name: string;
  display_label: string | null;
  owner_email_bounced: boolean;
  subscription_status: string;
  account_updated_at: Date;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

export type NotificationContextResult =
  | { kind: 'ok'; response: ResponseRow; business: BusinessRow }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip' };

export async function loadNotificationContext(
  input: NotificationContextInput,
  logger: ContextLogger,
): Promise<NotificationContextResult> {
  const [response] = await sql<ResponseRow[]>`
    SELECT resp.id, resp.response_text, resp.status,
           resp.business_id AS resp_business_id, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.id = ${input.responseId}
  `;

  if (!response) {
    logger.warn(`Response ${input.responseId} not found`);
    return { kind: 'fail', reason: 'response_not_found' };
  }
  if (response.resp_business_id !== input.businessId) {
    logger.error(
      `Response ${input.responseId} belongs to business ${response.resp_business_id}, not ${input.businessId}`,
    );
    return { kind: 'fail', reason: 'business_id_mismatch' };
  }
  if (response.status !== 'pending_approval') {
    logger.warn(
      `Response ${input.responseId} is ${response.status}, not pending_approval — skipping`,
    );
    return { kind: 'skip' };
  }

  const [business] = await sql<BusinessRow[]>`
    SELECT b.name, b.display_label, b.owner_email_bounced, b.archived_at,
           a.id AS account_id, a.subscription_status, a.updated_at AS account_updated_at,
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

  // VAL-LOC-044: Skip notification dispatch for archived locations.
  // Pending responses remain pending_approval but the publisher worker
  // does not send notifications for archived locations. Existing approval
  // links still resolve (the approval page uses service-role access).
  // The resolver (resolveChannels) does not return channels for archived
  // locations as an additional guard.
  if (business.archived_at !== null) {
    logger.warn(
      `Business ${input.businessId} is archived (archived_at=${business.archived_at}) — skipping notification`,
    );
    return { kind: 'skip' };
  }

  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isNotificationBlocked(offboardingState)) {
    logger.warn(
      `Business ${input.businessId} account is offboarding — skipping notification`,
    );
    return { kind: 'skip' };
  }

  return { kind: 'ok', response, business };
}
