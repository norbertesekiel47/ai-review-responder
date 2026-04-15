import { randomUUID, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';

/**
 * Creates a fresh approval link for a response.
 * - Revokes existing open links if no delivery record exists (orphaned from crash)
 * - Generates a random token, stores only the SHA-256 hash in DB
 * - Returns the raw token (caller must use it immediately in a URL and never persist it)
 */
export async function createApprovalLink(params: {
  responseId: string;
  businessId: string;
}): Promise<{ rawToken: string; tokenHash: string }> {
  const { responseId, businessId } = params;
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // Only revoke existing links if NO delivery record exists (orphaned from crash).
  // If a delivery exists, the link is live in the owner's inbox — do NOT revoke.
  const [existingDelivery] = await sql<{ id: string }[]>`
    SELECT id FROM notification_deliveries
    WHERE response_id = ${responseId} AND template = 'approval_request' AND sent_at IS NOT NULL
    LIMIT 1
  `;

  await sql.begin(async (tx) => {
    if (!existingDelivery) {
      await tx`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = ${responseId}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `;
    }

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${uuidv7()}, ${responseId}, ${businessId}, ${tokenHash}, 'email',
        NOW() + INTERVAL '48 hours'
      )
    `;
  });

  return { rawToken, tokenHash };
}
