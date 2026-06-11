// src/lib/channels/whatsapp-enrollment.ts
//
// Shared transaction helpers for WhatsApp channel enrollment. Mirrors
// the Telegram helpers in src/lib/channels/telegram-enrollment.ts.
// Caller must hold the `mobile_enroll:${accountId}` advisory lock
// inside sql.begin — these helpers do not lock.

import { v7 as uuidv7 } from 'uuid';
import { classifyEnrollmentError } from './unique-violation';

// Postgres.js TransactionSql / Sql types return a PendingQuery that carries
// extra properties beyond a plain Promise. Using `unknown` return type lets
// the full Sql<{}> / TransactionSql<{}> shapes satisfy the constraint without
// requiring an explicit cast. Vitest mocks (plain async functions) satisfy it
// too since they return bare Promises which are assignable to `unknown`.
type TxLike = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export type StartWhatsAppResult = { kind: 'ok' } | { kind: 'already_verified' };

/**
 * Insert/update a WhatsApp enrollment row to `pending_verification` with a
 * fresh hash + expiry. Caller MUST:
 *   - Open `sql.begin(async (tx) => {...})` and pass `tx` here.
 *   - Acquire the `mobile_enroll:${accountId}` advisory lock inside the same
 *     tx BEFORE calling this.
 *   - Generate `rawToken` outside the tx and pass `tokenHash = sha256(rawToken)`
 *     and `expiresAt = new Date(Date.now() + TOKEN_TTL_MS)`.
 *   - Generate the QR data URL AFTER the tx commits.
 *
 * The SELECT uses FOR UPDATE so that a concurrent WhatsApp inbound webhook
 * (which also runs inside sql.begin) cannot flip the org-default row for the
 * account to `verified` between our SELECT and our UPDATE — the row lock
 * serializes both transactions.
 *
 * Mirrors startTelegramEnrollment.
 */
export async function startWhatsAppEnrollment(
  tx: TxLike,
  businessId: string,
  accountId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<StartWhatsAppResult> {
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE account_id = ${accountId} AND channel = 'whatsapp'
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
        SET status                        = 'pending_verification',
            handle                        = NULL,
            verification_token_hash       = ${tokenHash},
            verification_token_expires_at = ${expiresAt},
            disabled_at                   = NULL,
            unsubscribed_at               = NULL,
            unsubscribed_reason           = NULL,
            updated_at                    = NOW()
        WHERE id = ${existingRow.id}
      `;
    } else {
      await tx`
        INSERT INTO channel_enrollments
          (id, account_id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
        VALUES
          (${uuidv7()}, ${accountId}, ${businessId}, 'whatsapp', 'pending_verification', ${tokenHash}, ${expiresAt})
      `;
    }
  } catch (err) {
    classifyEnrollmentError(err); // always throws
  }

  return { kind: 'ok' };
}

/**
 * Cancel a pending WhatsApp verification. Flips status pending → disabled
 * so the row exits migration 027's mobile-channel predicate. Idempotent.
 * Caller MUST hold the mobile_enroll lock inside sql.begin.
 */
export async function cancelWhatsAppEnrollment(
  tx: TxLike,
  accountId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await tx`
    UPDATE channel_enrollments
    SET status = 'disabled',
        disabled_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE account_id = ${accountId}
      AND channel = 'whatsapp'
      AND status = 'pending_verification'
      AND location_id IS NULL
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
