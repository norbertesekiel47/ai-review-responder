// worker/jobs/auto-post-notice/context.ts
//
// Loads the response + business rows needed by the auto-approved post FYI
// dispatcher (Workstream B). Mirrors the approval-notification context loader
// but with FYI-specific guards:
//   - response not found / id mismatch → fail outbox
//   - status != 'posted'              → skip (defensive: FYI must reflect a
//                                        CONFIRMED post, never a stray)
//   - approval_method != 'auto_policy'→ skip (owner-approved posts get NO FYI)
//   - business not found              → fail outbox
//   - archived / offboarding          → skip
//
// Unlike the approval loader this selects businesses.google_maps_url (the FYI
// CTA destination) and resp.approval_method, and does NOT require
// pending_approval.

import { sql } from '../../../src/lib/db/server';
import {
  activeOffboardingStateFromProjection,
  isNotificationBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import type { AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';

export interface AutoPostNoticeContextInput {
  responseId: string;
  businessId: string;
}

export interface AutoPostNoticeContextLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface AutoPostResponseRow {
  id: string;
  status: string;
  approval_method: string | null;
  resp_business_id: string;
  review_id: string;
  reviewer_name: string;
  star_rating: number;
  review_date: string;
}

export interface AutoPostBusinessRow extends ActiveOffboardingProjection {
  account_id: string;
  name: string;
  display_label: string | null;
  google_maps_url: string | null;
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

export type AutoPostNoticeContextResult =
  | { kind: 'ok'; response: AutoPostResponseRow; business: AutoPostBusinessRow }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip'; reason: string };

// fallow-ignore-next-line complexity — discriminated ok/fail/skip context loader whose branches map 1:1 to the load-and-validate gates (response missing/mismatch, not posted, not auto_policy, business missing); inherent to a single-pass loader.
export async function loadAutoPostNoticeContext(
  input: AutoPostNoticeContextInput,
  logger: AutoPostNoticeContextLogger,
): Promise<AutoPostNoticeContextResult> {
  const [response] = await sql<AutoPostResponseRow[]>`
    SELECT resp.id, resp.status, resp.approval_method,
           resp.business_id AS resp_business_id, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_date
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
  // Defensive idempotency: the FYI is enqueued ONLY by the publisher helper for
  // an auto-policy response that just transitioned to posted. If the row is no
  // longer posted, or was not auto-approved, skip — never emit a stray FYI.
  if (response.status !== 'posted') {
    logger.warn(`Response ${input.responseId} is ${response.status}, not posted — skipping FYI`);
    return { kind: 'skip', reason: 'not_posted' };
  }
  if (response.approval_method !== APPROVAL_METHOD.AUTO_POLICY) {
    logger.warn(
      `Response ${input.responseId} approval_method=${response.approval_method} is not auto_policy — skipping FYI`,
    );
    return { kind: 'skip', reason: 'not_auto_policy' };
  }

  const [business] = await sql<AutoPostBusinessRow[]>`
    SELECT b.name, b.display_label, b.google_maps_url, b.archived_at,
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
    logger.warn(`Business ${input.businessId} is archived — skipping FYI`);
    return { kind: 'skip', reason: 'archived_location' };
  }
  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isNotificationBlocked(offboardingState)) {
    logger.warn(`Business ${input.businessId} account is offboarding — skipping FYI`);
    return { kind: 'skip', reason: 'offboarding' };
  }

  return { kind: 'ok', response, business };
}
