// src/lib/approval/locks.ts
//
// Lock + validation helpers shared by all three approval modes.
// Each helper takes a Postgres.js TransactionSql and uses
// SELECT ... FOR UPDATE to hold row-level locks for the duration of
// the surrounding transaction.

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  ResponseNotPendingError,
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
  ArchivedLocationError,
} from './errors';
import type { ApprovalLink } from './types';

type TxClient = postgres.TransactionSql;

export function hashApprovalToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Lock and validate an approval link by raw token.
 * Uses SELECT ... FOR UPDATE to hold a row-level lock for the duration of the transaction.
 */
export async function lockValidLink(tx: TxClient, rawToken: string): Promise<ApprovalLink> {
  const tokenHash = hashApprovalToken(rawToken);

  const rows = await tx<ApprovalLink[]>`
    SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at
    FROM approval_links
    WHERE token_hash = ${tokenHash}
    FOR UPDATE
  `;

  const link = rows[0];
  if (!link) throw new InvalidTokenError();
  if (link.consumed_at !== null) throw new ConsumedTokenError();
  if (link.revoked_at !== null) throw new RevokedTokenError();
  if (new Date(link.expires_at) <= new Date()) throw new ExpiredTokenError();

  return link;
}

export function verifyDevice(link: ApprovalLink, deviceCookieHash: string): void {
  if (link.device_cookie_hash !== deviceCookieHash) {
    throw new DeviceConflictError();
  }
}

export async function consumeLink(tx: TxClient, linkId: string): Promise<void> {
  await tx`UPDATE approval_links SET consumed_at = NOW() WHERE id = ${linkId}`;
}

/**
 * Lock the response row, verify it is still pending_approval, and verify its
 * location is not archived. Must be called BEFORE consumeLink so the
 * transaction rolls back cleanly if the response is no longer actionable.
 *
 * The archived check lives HERE, inside the claim primitive, so that
 * "a pending response can only be acted on for a live location" holds for
 * every current and future lane by construction — and so the
 * responses FOR UPDATE always precedes the businesses FOR SHARE
 * (uniform lock order; a concurrent archive can never form a cycle).
 * The business_id comes from the response row itself, not the caller.
 */
export async function lockPendingResponse(
  tx: TxClient,
  responseId: string,
): Promise<{ status: string; original_draft_text: string; response_text: string; version: number; review_id: string; business_id: string }> {
  const rows = await tx<{ status: string; original_draft_text: string; response_text: string; version: number; review_id: string; business_id: string }[]>`
    SELECT status, original_draft_text, response_text, version, review_id, business_id
    FROM responses WHERE id = ${responseId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new ResponseNotPendingError('not_found');
  if (row.status !== 'pending_approval') throw new ResponseNotPendingError(row.status);
  await assertLocationNotArchived(tx, row.business_id);
  return row;
}

export async function revokeSiblings(tx: TxClient, responseId: string, excludeLinkId: string): Promise<void> {
  await tx`
    UPDATE approval_links
    SET revoked_at = NOW()
    WHERE response_id = ${responseId}
      AND id != ${excludeLinkId}
      AND consumed_at IS NULL
  `;
}

/**
 * Revoke ALL open (unconsumed, unrevoked, unexpired) approval links for a response.
 * Used by session-based dashboard actions where there is no "current link" to exclude.
 * Token-based actions use revokeSiblings() which excludes the consumed link.
 */
export async function revokeOpenLinksForResponse(tx: TxClient, responseId: string): Promise<void> {
  await tx`
    UPDATE approval_links
    SET revoked_at = NOW()
    WHERE response_id = ${responseId}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > NOW()
  `;
}

/**
 * Reject mutating approval actions that target an archived location.
 *
 * Two consumers: lockPendingResponse (which gives every approval lane the
 * gate by construction — token, callback, and dashboard-session approve/
 * edit/regenerate all claim through it) and the admin flagged-disposition
 * lane's release-style actions (api/admin/flagged — it tolerates
 * non-pending responses so it cannot use the claim primitive, and
 * dismissed_false_positive is deliberately ungated so flags on archived
 * locations can still be closed). An archived location has no live Google
 * connection to post to and the generator skips its regenerate jobs, so any
 * approve/edit/regenerate would either fail downstream or destructively
 * supersede the pending draft.
 *
 * FOR SHARE makes this a locking read: the archive tx takes the same
 * businesses row FOR UPDATE, so an in-flight archive blocks this gate and
 * the re-evaluated read sees the committed archived_at — no TOCTOU window.
 * Callers MUST run inside the same sql.begin() as the mutation (all do);
 * outside a transaction PgBouncer drops the lock immediately. Call it only
 * AFTER any responses FOR UPDATE in the same tx (uniform lock order).
 *
 * Fails closed: a missing business row also rejects.
 */
export async function assertLocationNotArchived(
  tx: TxClient,
  businessId: string,
): Promise<void> {
  const [business] = await tx<{ archived_at: Date | null }[]>`
    SELECT archived_at FROM businesses WHERE id = ${businessId} FOR SHARE
  `;
  if (!business || business.archived_at !== null) {
    throw new ArchivedLocationError();
  }
}

export async function lockLinkByIdForCallback(
  tx: TxClient,
  approvalLinkId: string,
  expectedChannel: string,
): Promise<ApprovalLink> {
  const rows = await tx<ApprovalLink[]>`
    SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at
    FROM approval_links
    WHERE id = ${approvalLinkId}
    FOR UPDATE
  `;
  const link = rows[0];
  if (!link) throw new InvalidTokenError();
  if (link.channel !== expectedChannel) throw new ChannelMismatchError(expectedChannel, link.channel);
  if (link.consumed_at !== null) throw new ConsumedLinkError();
  if (link.revoked_at !== null) throw new RevokedLinkError();
  if (new Date(link.expires_at) <= new Date()) throw new ExpiredLinkError();
  return link;
}
