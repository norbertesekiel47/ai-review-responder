// src/lib/channels/telegram-enrollment.ts
//
// Shared transaction helpers for Telegram channel enrollment, used by both
// admin and owner routes. The route handlers own:
//   - rawToken generation (returned to client)
//   - tokenHash + expiresAt computation
//   - sql.begin opening
//   - advisory lock acquisition (inside the tx)
//   - QR generation (after tx commits)
//
// These helpers own the state-machine SELECT + INSERT/UPDATE inside the tx,
// and the 23505 → typed-error mapping.
//
// See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §4.2-4.4.

import { v7 as uuidv7 } from 'uuid';
import { classifyEnrollmentError } from './unique-violation';

// Postgres.js TransactionSql / Sql types return a PendingQuery that carries
// extra properties beyond a plain Promise. Using `unknown` return type lets
// the full Sql<{}> / TransactionSql<{}> shapes satisfy the constraint without
// requiring an explicit cast. Vitest mocks (plain async functions) satisfy it
// too since they return bare Promises which are assignable to `unknown`.
type TxLike = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export type StartTelegramResult = { kind: 'ok' } | { kind: 'already_verified' };

/**
 * Insert/update a Telegram enrollment row to `pending_verification` with a
 * fresh hash + expiry. Caller MUST:
 *   - Open `sql.begin(async (tx) => {...})` and pass `tx` here.
 *   - Acquire the `mobile_enroll:${accountId}` advisory lock inside the same tx BEFORE calling this.
 *   - Generate `rawToken` outside the tx and pass `tokenHash = sha256(rawToken)`
 *     and `expiresAt = new Date(Date.now() + TOKEN_TTL_MS)`.
 *   - Generate the QR data URL AFTER the tx commits.
 *
 * The SELECT uses FOR UPDATE to lock the org-default row for the account
 * (account_id = accountId, location_id IS NULL) so that a concurrent Telegram
 * inbound webhook (which also runs inside sql.begin) cannot flip the row to
 * `verified` between our SELECT and our UPDATE — the row lock serializes both
 * transactions.
 *
 * The INSERT still writes `business_id` as a NOT-NULL legacy FK; it is never
 * used for lookup.
 */
export async function startTelegramEnrollment(
  tx: TxLike,
  businessId: string,
  accountId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<StartTelegramResult> {
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE account_id = ${accountId} AND channel = 'telegram'
      AND location_id IS NULL AND archived_at IS NULL
    FOR UPDATE
  `) as Array<{ id: string; status: string }>;
  const existingRow = existing[0];

  if (existingRow?.status === 'verified') {
    return { kind: 'already_verified' };
  }

  try {
    if (existingRow) {
      await tx`
        UPDATE channel_enrollments
        SET status                       = 'pending_verification',
            handle                       = NULL,
            verification_token_hash      = ${tokenHash},
            verification_token_expires_at = ${expiresAt},
            disabled_at                  = NULL,
            unsubscribed_at              = NULL,
            unsubscribed_reason          = NULL,
            updated_at                   = NOW()
        WHERE id = ${existingRow.id}
      `;
    } else {
      await tx`
        INSERT INTO channel_enrollments
          (id, account_id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
        VALUES
          (${uuidv7()}, ${accountId}, ${businessId}, 'telegram', 'pending_verification', ${tokenHash}, ${expiresAt})
      `;
    }
  } catch (err) {
    classifyEnrollmentError(err); // always throws
  }

  return { kind: 'ok' };
}

/**
 * Cancels a pending Telegram enrollment by flipping it to `disabled` (with
 * `disabled_at = NOW()`) and clearing the token fields. This releases the
 * partial-unique-index slot for the account so a fresh enrollment can proceed
 * immediately.
 *
 * Idempotent — single UPDATE; concurrent cancel + cancel produces the same
 * end state. Does NOT open sql.begin, does NOT take an advisory lock.
 *
 * Caller MUST hold the `mobile_enroll:${accountId}` advisory lock inside
 * `sql.begin` — the helper does not lock. This prevents a concurrent start
 * from observing the pending row, falling through to its UPDATE branch (which
 * has no status WHERE guard), and overwriting cancel's disabled transition back
 * to pending_verification.
 *
 * NOTE: only non-archived `pending_verification` org-default rows
 * (location_id IS NULL) are matched. Archived and verified rows are never
 * mutated by this helper.
 */
export async function cancelTelegramEnrollment(
  sql: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        disabled_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}

/**
 * Owner-initiated disconnect. Flips verified → disabled, clears handle.
 * Targets the org-default row (location_id IS NULL) for the account.
 * Does NOT open sql.begin, does NOT take an advisory lock. Returns
 * `not_found` if no verified row matched (UI prevents this case via the
 * Disconnect-button-only-in-verified rule from spec §3).
 */
export async function disableTelegramEnrollment(
  sql: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'telegram'
      AND status = 'verified'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
