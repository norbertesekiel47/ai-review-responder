// src/lib/notifications/channels/enroll-email-owner.ts
//
// Single-sourced "mark the owner's email channel verified" INSERT. Both
// self-serve signup entry points (Google OAuth via finish-signup, and
// email/password via verify-otp) call this once the owner's email has been
// proven — the row is what lets the dispatcher find a recipient for
// approval emails. createBusinessTx deliberately does NOT insert this row
// for self_serve mode (see create-business.ts) — this module fills the gap
// post-proof.

import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';

/**
 * Idempotently marks the owner's email as a verified channel enrollment.
 *
 * Born-injected: `sql` is a parameter, not an import — the composition root
 * (the calling route) supplies the singleton. Best-effort at the call site:
 * callers wrap this in their own try/catch and log via reportCaughtError
 * with their own tag, since a failure here shouldn't block the redirect.
 *
 * The ON CONFLICT predicate matches the post-migration-034 partial unique
 * index on channel_enrollments byte-for-byte — Postgres won't recognize the
 * constraint otherwise.
 */
export async function enrollOwnerEmailChannel(
  sql: Sql,
  params: { accountId: string; businessId: string; ownerEmail: string },
): Promise<void> {
  await sql`
    INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status, verified_at)
    VALUES (${uuidv7()}::uuid, ${params.accountId}::uuid, ${params.businessId}::uuid, 'email', ${params.ownerEmail}, 'verified', NOW())
    ON CONFLICT (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000')) WHERE archived_at IS NULL DO NOTHING
  `;
}
