// worker/jobs/pending-post-notice/context.ts
//
// Loads the response + review + business rows needed by the veto-window
// pending-post-notice dispatcher (WS4 spec §2.7). Mirrors the auto-post-notice
// context loader but with freshness guards specific to the veto window:
//   - response not found / id mismatch   → fail outbox
//   - status != 'approved' OR
//     approval_method != 'auto_policy'   → skip (vetoed, kill-switch-downgraded,
//                                          posted, or superseded meanwhile —
//                                          the notice would be stale noise)
//   - auto_post_scheduled_at NULL or
//     already passed                     → skip (stale outbox backlog; a notice
//                                          the owner can't act on is noise)
//   - business not found                 → fail outbox
//   - archived / offboarding             → skip
//
// The deadline comparison is computed IN SQL (`auto_post_scheduled_at <=
// NOW()`) so the same clock that stamped the deadline (persist.ts uses DB
// NOW()) decides staleness — worker wall-clock skew never flips the guard.

import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isNotificationBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import type { AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';

export interface PendingPostNoticeContextInput {
  responseId: string;
  businessId: string;
}

export interface PendingPostNoticeContextLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface PendingPostResponseRow {
  id: string;
  status: string;
  approval_method: string | null;
  resp_business_id: string;
  review_id: string;
  /** The auto-approved draft the notice previews (set by the same tx that enqueued this job). */
  approved_text: string | null;
  auto_post_scheduled_at: Date | null;
  /** SQL-computed `auto_post_scheduled_at <= NOW()` — DB clock owns staleness. */
  deadline_passed: boolean | null;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
}

export interface PendingPostNoticeBusinessRow extends ActiveOffboardingProjection {
  account_id: string;
  name: string;
  display_label: string | null;
  owner_email_bounced: boolean;
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

/** The ok-branch row: the loader's guards guarantee a live draft + deadline. */
export type ScheduledPendingPostResponseRow = PendingPostResponseRow & {
  approved_text: string;
  auto_post_scheduled_at: Date;
};

export type PendingPostNoticeContextResult =
  | { kind: 'ok'; response: ScheduledPendingPostResponseRow; business: PendingPostNoticeBusinessRow }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip'; reason: string };

// discriminated ok/fail/skip context loader whose branches map 1:1 to the
// load-and-validate gates (response missing/mismatch, no longer scheduled,
// deadline passed, business missing, archived, offboarding); inherent to a
// single-pass loader.
// fallow-ignore-next-line complexity
export async function loadPendingPostNoticeContext(
  sql: Sql,
  input: PendingPostNoticeContextInput,
  logger: PendingPostNoticeContextLogger,
): Promise<PendingPostNoticeContextResult> {
  const [response] = await sql<PendingPostResponseRow[]>`
    SELECT resp.id, resp.status, resp.approval_method,
           resp.business_id AS resp_business_id, resp.review_id,
           resp.approved_text, resp.auto_post_scheduled_at,
           (resp.auto_post_scheduled_at <= NOW()) AS deadline_passed,
           r.reviewer_name, r.star_rating, r.review_text
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
  // Freshness guard (spec §2.7): the notice is only meaningful while the reply
  // is still an approved auto_policy row awaiting its deadline. Anything else —
  // vetoed (downgraded to pending_approval), kill-switch-downgraded, already
  // posted, or superseded — means the window closed or never applies; skip.
  if (response.status !== 'approved') {
    logger.warn(`Response ${input.responseId} is ${response.status}, not approved — skipping notice`);
    return { kind: 'skip', reason: 'not_approved' };
  }
  if (response.approval_method !== APPROVAL_METHOD.AUTO_POLICY) {
    logger.warn(
      `Response ${input.responseId} approval_method=${response.approval_method} is not auto_policy — skipping notice`,
    );
    return { kind: 'skip', reason: 'not_auto_policy' };
  }
  // Stale outbox backlog: a notice whose deadline is unset or already passed
  // can't be acted on — sending it is noise, not transparency. The publish row
  // is independent and fires (or already fired) on its own.
  if (response.auto_post_scheduled_at === null) {
    logger.warn(`Response ${input.responseId} has no auto_post_scheduled_at — skipping notice`);
    return { kind: 'skip', reason: 'no_scheduled_deadline' };
  }
  if (response.deadline_passed === true) {
    logger.warn(`Response ${input.responseId} deadline already passed — skipping stale notice`);
    return { kind: 'skip', reason: 'deadline_passed' };
  }
  // Data-integrity surprise: an approved auto_policy row always has
  // approved_text (persist.ts sets both in one UPDATE). Fail loudly rather
  // than send a notice with an empty draft preview.
  if (response.approved_text === null) {
    logger.error(`Response ${input.responseId} is approved/auto_policy but approved_text is NULL`);
    return { kind: 'fail', reason: 'approved_text_missing' };
  }

  const [business] = await sql<PendingPostNoticeBusinessRow[]>`
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
    logger.warn(`Business ${input.businessId} is archived — skipping notice`);
    return { kind: 'skip', reason: 'archived_location' };
  }
  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isNotificationBlocked(offboardingState)) {
    logger.warn(`Business ${input.businessId} account is offboarding — skipping notice`);
    return { kind: 'skip', reason: 'offboarding' };
  }

  return {
    kind: 'ok',
    // Re-state the two guard-narrowed fields so the ok branch carries the
    // non-null types the dispatcher needs (no `!` at the call site).
    response: {
      ...response,
      approved_text: response.approved_text,
      auto_post_scheduled_at: response.auto_post_scheduled_at,
    },
    business,
  };
}
