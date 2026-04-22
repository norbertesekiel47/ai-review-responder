import { randomUUID, createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import type { ChannelId } from '@/lib/notifications/channels/types';

/**
 * Creates a fresh approval link for a response on a specific channel.
 *
 * Revoke behavior (scoped to the caller's channel — prevents cross-channel
 * accidents when the dispatcher creates one link per enrolled channel):
 *   'orphaned_only' (default): revoke existing same-channel open links ONLY
 *     if no prior same-channel delivery exists (orphaned from worker crash).
 *   'always': revoke all same-channel open links unconditionally (used by
 *     owner-nudge emails which want a fresh email link each time).
 *
 * Returns the raw token + hash + approval_links row ID. Caller must use the
 * rawToken immediately in a URL and never persist it. approvalLinkId is safe
 * to persist (non-sensitive).
 */
export async function createApprovalLink(params: {
  responseId: string;
  businessId: string;
  channel: ChannelId;
  /** 'orphaned_only' (default): only revoke if no same-channel delivery exists.
   *  'always': revoke all same-channel open links regardless. */
  revokeMode?: 'orphaned_only' | 'always';
}): Promise<{ rawToken: string; tokenHash: string; approvalLinkId: string }> {
  const { responseId, businessId, channel } = params;
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const approvalLinkId = uuidv7();
  const revokeMode = params.revokeMode ?? 'orphaned_only';

  // Serialize concurrent link creation per (response_id, channel) to prevent a
  // TOCTOU race: without the lock, two workers can both (a) observe no prior
  // delivery, (b) start their own transactions, and (c) have one worker's
  // revoke statement clobber the other worker's freshly-inserted link — the
  // owner then receives an approval URL whose link has already been revoked.
  //
  // pg_advisory_xact_lock is transaction-scoped (auto-released on commit/abort),
  // process-agnostic, and costs nothing when there's no contention. The lock
  // key is a hash of (responseId || ':' || channel) so concurrent calls for
  // DIFFERENT responses or DIFFERENT channels do not serialize on each other.
  //
  // The delivery-check + revoke + insert all run INSIDE the transaction under
  // the lock so every concurrent caller observes a consistent state.
  await sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(hashtext(${responseId + ':' + channel}))
    `;

    let shouldRevoke = revokeMode === 'always';
    if (!shouldRevoke && revokeMode === 'orphaned_only') {
      const [existingDelivery] = await tx<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${responseId}
          AND channel = ${channel}
          AND template = 'approval_request'
          AND sent_at IS NOT NULL
        LIMIT 1
      `;
      shouldRevoke = !existingDelivery;
    }

    if (shouldRevoke) {
      await tx`
        UPDATE approval_links SET revoked_at = NOW()
        WHERE response_id = ${responseId}
          AND channel = ${channel}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `;
    }

    await tx`
      INSERT INTO approval_links (id, response_id, business_id, token_hash, channel, expires_at)
      VALUES (
        ${approvalLinkId}, ${responseId}, ${businessId}, ${tokenHash}, ${channel},
        NOW() + INTERVAL '48 hours'
      )
    `;
  });

  return { rawToken, tokenHash, approvalLinkId };
}
