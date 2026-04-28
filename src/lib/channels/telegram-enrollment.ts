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

// Postgres.js TransactionSql / Sql types are inferred from the inner callback;
// we accept `any` here because vitest mocks supply a vi.fn() and the runtime
// signature is the same tagged-template-callable shape. The type alias keeps
// call sites readable.
type TxLike = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export type StartTelegramResult = { kind: 'ok' } | { kind: 'already_verified' };

/**
 * Insert/update a Telegram enrollment row to `pending_verification` with a
 * fresh hash + expiry. Caller MUST:
 *   - Open `sql.begin(async (tx) => {...})` and pass `tx` here.
 *   - Acquire the advisory lock inside the same tx BEFORE calling this.
 *   - Generate `rawToken` outside the tx and pass `tokenHash = sha256(rawToken)`
 *     and `expiresAt = new Date(Date.now() + TOKEN_TTL_MS)`.
 *   - Generate the QR data URL AFTER the tx commits.
 */
export async function startTelegramEnrollment(
  tx: TxLike,
  businessId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<StartTelegramResult> {
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE business_id = ${businessId} AND channel = 'telegram' AND archived_at IS NULL
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
          (id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
        VALUES
          (${uuidv7()}, ${businessId}, 'telegram', 'pending_verification', ${tokenHash}, ${expiresAt})
      `;
    }
  } catch (err) {
    classifyEnrollmentError(err); // always throws
  }

  return { kind: 'ok' };
}

/**
 * Idempotent — single UPDATE; concurrent cancel + cancel produces the same end state.
 * Does NOT open sql.begin, does NOT take an advisory lock.
 */
export async function cancelTelegramEnrollment(
  sql: TxLike,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}

/**
 * Owner-initiated disconnect. Flips verified → disabled, clears handle.
 * Does NOT open sql.begin, does NOT take an advisory lock. Returns
 * `not_found` if no verified row matched (UI prevents this case via the
 * Disconnect-button-only-in-verified rule from spec §3).
 */
export async function disableTelegramEnrollment(
  sql: TxLike,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'verified'
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
