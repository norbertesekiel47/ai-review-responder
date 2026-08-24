// worker/jobs/solicitation-veto-notice/context.ts
//
// Loads the business + send-batch rows needed by the Auto-approval lane's
// Veto notice dispatcher (#631 Task 5). Mirrors pending-post-notice/context.ts's
// shape, but the notice is about a BATCH, not a response, and the worker gates
// on BATCH STATE ONLY (owner re-lock decision 11 — no flag reads anywhere in
// this family). The business+account lookup runs FIRST (unlike
// pending-post-notice, which validates its response before its business) —
// that is what supplies `account_id`, which the payload does not carry, so
// the batch lookup below can be tenant-scoped by BOTH `account_id` AND
// `business_id` (invariant #8; byte-matches the `WHERE id = … AND account_id
// = … AND business_id = …` shape every other solicitation_batches query in
// this codebase uses — see src/lib/solicitation/approval.ts and
// src/lib/solicitation/auto-approval.ts). Gates:
//   - business not found                   → fail outbox
//   - archived / offboarding               → skip
//   - batch not found (incl. cross-tenant — the scoped WHERE clause makes a
//     wrong-tenant batch id indistinguishable from a missing one, which is
//     the point: no cross-tenant row is ever read into memory to compare)
//                                           → fail outbox
//   - approval_method != 'auto_policy'     → skip (owner-approved, downgraded
//                                            at release, or never auto-approved
//                                            — the notice would be stale noise)
//   - halted_at IS NOT NULL                → skip (Halt latch fired)
//   - send_closed_at IS NOT NULL           → skip (batch already settled)
// Anchored (veto_deadline_at IS NOT NULL) is DELIBERATELY NOT a skip — a
// retry must still be able to claim + send on any channel that hasn't
// delivered yet, and the anchor itself is computed FROM this notice's own
// sent_at (decision 4), so refusing an already-anchored batch would starve
// the anchor of its input on every retry.
//
// N — the copy's live review-request count — is read HERE, fresh, not carried
// on the payload: `COUNT(*) FROM solicitation_outreach ... AND delivery_status
// = 'rendered'` is the same shape `approveBatch`/`autoApproveBatch` use to
// record `approved_count` on the `batch_approved` spine step
// (src/lib/solicitation/approval.ts:409-411) — reading it live means the copy
// never drifts from what's actually still live to send.

import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isNotificationBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import type { AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';

export interface SolicitationVetoNoticeContextInput {
  batchId: string;
  businessId: string;
}

export interface SolicitationVetoNoticeContextLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface SolicitationVetoNoticeBatchRow {
  id: string;
  account_id: string;
  approval_method: string | null;
  halted_at: Date | null;
  send_closed_at: Date | null;
}

export interface SolicitationVetoNoticeBusinessRow extends ActiveOffboardingProjection {
  account_id: string;
  name: string;
  display_label: string | null;
  owner_email_bounced: boolean;
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

export type SolicitationVetoNoticeContextResult =
  | {
      kind: 'ok';
      batch: SolicitationVetoNoticeBatchRow;
      business: SolicitationVetoNoticeBusinessRow;
      /** Live COUNT of rendered Outreach rows on the batch, read at send time. */
      requestCount: number;
    }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip'; reason: string };

// discriminated ok/fail/skip context loader whose branches map 1:1 to the
// load-and-validate gates (business missing, archived, offboarding, batch
// missing/state); inherent to a single-pass loader.
// fallow-ignore-next-line complexity
export async function loadSolicitationVetoNoticeContext(
  sql: Sql,
  input: SolicitationVetoNoticeContextInput,
  logger: SolicitationVetoNoticeContextLogger,
): Promise<SolicitationVetoNoticeContextResult> {
  // Business+account FIRST (unlike pending-post-notice) — this is what
  // supplies account_id, absent from the payload, so the batch lookup below
  // can be tenant-scoped by BOTH account_id AND business_id (ci:tenant-scope;
  // see module header).
  const [business] = await sql<SolicitationVetoNoticeBusinessRow[]>`
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
    WHERE b.id = ${input.businessId}::uuid
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

  // Tenant-scoped by id + account_id + business_id, matching every other
  // solicitation_batches query in the codebase byte-for-byte in shape. A
  // cross-tenant batch id (belongs to a different account/business) is
  // indistinguishable from a missing one here — no other tenant's row is ever
  // read into memory to compare, unlike a bare `WHERE id = …` would allow.
  const [batch] = await sql<SolicitationVetoNoticeBatchRow[]>`
    SELECT id, account_id, approval_method, halted_at, send_closed_at
    FROM solicitation_batches
    WHERE id = ${input.batchId}::uuid
      AND account_id = ${business.account_id}::uuid
      AND business_id = ${input.businessId}::uuid
  `;
  if (!batch) {
    logger.warn(`Batch ${input.batchId} not found for business ${input.businessId}`);
    return { kind: 'fail', reason: 'batch_not_found' };
  }
  // Batch-state gate (decision 11): only a still-live auto_policy batch gets a
  // Veto notice. Anchored is deliberately NOT checked here — see module header.
  if (batch.approval_method !== APPROVAL_METHOD.AUTO_POLICY) {
    logger.warn(
      `Batch ${input.batchId} approval_method=${batch.approval_method} is not auto_policy — skipping notice`,
    );
    return { kind: 'skip', reason: 'not_auto_policy' };
  }
  if (batch.halted_at !== null) {
    logger.warn(`Batch ${input.batchId} is halted — skipping notice`);
    return { kind: 'skip', reason: 'halted' };
  }
  if (batch.send_closed_at !== null) {
    logger.warn(`Batch ${input.batchId} is closed — skipping notice`);
    return { kind: 'skip', reason: 'send_closed' };
  }

  const [live] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM solicitation_outreach
    WHERE batch_id = ${input.batchId}::uuid
      AND account_id = ${batch.account_id}::uuid
      AND business_id = ${input.businessId}::uuid
      AND delivery_status = 'rendered'
  `;
  const requestCount = live?.count ?? 0;

  return { kind: 'ok', batch, business, requestCount };
}
