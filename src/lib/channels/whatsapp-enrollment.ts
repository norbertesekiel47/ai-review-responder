// src/lib/channels/whatsapp-enrollment.ts
//
// Shared transaction helpers for WhatsApp channel enrollment. Mirrors
// the Telegram helpers in src/lib/channels/telegram-enrollment.ts.
// Caller must hold the `mobile_enroll:${businessId}` advisory lock
// inside sql.begin — these helpers do not lock.

// Postgres.js TransactionSql / Sql types return a PendingQuery that carries
// extra properties beyond a plain Promise. Using `unknown` return type lets
// the full Sql<{}> / TransactionSql<{}> shapes satisfy the constraint without
// requiring an explicit cast. Vitest mocks (plain async functions) satisfy it
// too since they return bare Promises which are assignable to `unknown`.
type TxLike = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/**
 * Cancel a pending WhatsApp verification. Flips status pending → disabled
 * so the row exits migration 027's mobile-channel predicate. Idempotent.
 * Caller MUST hold the mobile_enroll lock inside sql.begin.
 */
export async function cancelWhatsAppEnrollment(
  tx: TxLike,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await tx`
    UPDATE channel_enrollments
    SET status = 'disabled',
        disabled_at = NOW(),
        verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'whatsapp'
      AND status = 'pending_verification'
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
