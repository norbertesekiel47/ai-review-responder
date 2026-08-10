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
//
// Deliberately distinct consumers — do NOT consolidate onto this module.
// Four categories read/write flagged_responses with DIFFERENT semantics, and
// force-fitting them is how a shared helper acquires a boolean parameter
// meaning "actually a different query" (full 16-consumer inventory: #725):
//   - Admin surfaces (/api/admin/flagged, flagged-service, nav-counts): their
//     subject is the FLAG ROW itself (disposition by id, queue enumeration,
//     cross-tenant badge count) — not a response's held-ness.
//   - Health alerting (health-alert/checks.ts): cross-tenant COUNT of open
//     rows vs threshold; worker alerting must not couple to an owner-UI read.
//   - Offboarding purge lane (purge-verification, purge-stages,
//     table-disposition): deliberately IGNORES status — a closed flag left
//     behind is still a purge violation.
//   - The producer (response-generation/persist.ts): writes the flag row and
//     keeps its own module-local status const (different lifecycle).

import type postgres from 'postgres';

type TxClient = postgres.TransactionSql;
type DbClient = postgres.Sql | postgres.TransactionSql;

/** Thrown by owner release paths when a draft is held for admin moderation review. */
export class HeldForReviewError extends Error {
  constructor() {
    super('held_for_review');
    this.name = 'HeldForReviewError';
  }
}

/**
 * The one read-side spelling of "response X has an OPEN moderation flag".
 * Composable Postgres.js fragment (nested queries splice as raw SQL text):
 * projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` — D9 sites) or
 * filtered (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`). `ref` is
 * itself a fragment: a correlated column ref (sql`resp.id`) or a bound
 * parameter (tx`${responseId}::uuid`). Client-agnostic like statusArraySql —
 * pass the surrounding query's client. The internal alias `fr` is reserved —
 * never pass a ref qualified by an outer alias named `fr` (the EXISTS
 * subquery's own `fr` would shadow it and the predicate would silently
 * self-correlate).
 */
export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
  // 'open' is a literal, not a bind, on purpose: it must match the partial
  // unique index's WHERE status = 'open' predicate byte-for-byte (migration 051)
  // for partial-index inference — a bound parameter defeats it and the table
  // has no fallback index on response_id.
  return db`EXISTS (
    SELECT 1 FROM flagged_responses fr
    WHERE fr.response_id = ${ref} AND fr.status = 'open'
  )`;
}

/**
 * Returns true when an OPEN moderation flag exists for the response. Callers
 * should already hold a `FOR UPDATE` lock on the response row so the check is
 * serialized against the admin disposition that closes the flag.
 */
export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one
    WHERE ${openFlagExistsSql(tx, tx`${responseId}::uuid`)}
  `;
  return rows.length > 0;
}
