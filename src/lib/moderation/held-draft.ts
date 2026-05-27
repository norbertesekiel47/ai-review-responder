// Held-draft gate ─────────────────────────────────────────────────────────
//
// A high-severity moderation flag writes a `flagged_responses` row (status
// 'open') and leaves the draft at `pending_approval` (see
// ResponseGeneratorWorker.persistResponseAndNotify). Suppressing the owner
// email is NOT enough on its own — the dashboard renders pending drafts and
// the owner can approve/edit/publish them directly. This module is the
// shared gate that makes the hold actually binding: every owner-facing
// release path must call `hasOpenFlag` (in-tx, post-lock) and refuse to act
// while a flag is open.
//
// The flag is released only by an admin disposition at /admin/flagged:
//   - approved_for_owner_review → flag closed, draft released
//   - dismissed_false_positive  → flag closed, draft released (was safe)
//   - requires_regeneration     → flag closed AND draft superseded + regenerated

import type postgres from 'postgres';

type TxClient = postgres.TransactionSql;

/** Thrown by owner release paths when a draft is held for admin moderation review. */
export class HeldForReviewError extends Error {
  constructor() {
    super('held_for_review');
    this.name = 'HeldForReviewError';
  }
}

/**
 * Returns true when an OPEN moderation flag exists for the response. Callers
 * should already hold a `FOR UPDATE` lock on the response row so the check is
 * serialized against the admin disposition that closes the flag.
 */
export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one
    FROM flagged_responses
    WHERE response_id = ${responseId}::uuid AND status = 'open'
    LIMIT 1
  `;
  return rows.length > 0;
}
