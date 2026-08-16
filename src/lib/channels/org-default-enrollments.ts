// src/lib/channels/org-default-enrollments.ts
//
// One owner for the ORG-DEFAULT channel-enrollment read: the rows an account's
// owner sees at the top of Settings → Notifications, and the same rows GET
// /api/dashboard/channels returns. Both surfaces spelled this SELECT out for
// themselves; the SSR page and the status endpoint feeding the same UI must not
// be able to disagree about which rows are org defaults.
//
// The lookup key is ACCOUNT-SCOPED — `account_id` + `channel` +
// `location_id IS NULL`. `channel_enrollments.business_id` is a legacy FK
// written on INSERT and is NOT part of this lookup (an org-default row carries
// whichever location happened to create it), so it is deliberately not selected
// and never filtered on.
//
// Returns raw rows, not a DTO: the route masks handles and ISO-formats the
// timestamps, the page maps a different shape, and pushing either concern in
// here would give the module a second job.
//
// NOT the owner of the per-location override rows — that is
// `getChannelOverridesView` in this directory. `src/lib/admin/business-channels-service.ts`
// runs a deliberately different query (org defaults UNIONed with the viewed
// location's overrides, plus a last-activity correlated subquery and an
// override-first ordering) and is not a caller.

import type { Sql } from 'postgres';
import { CHANNEL_IDS } from '@/lib/notifications/channels/types';

export interface OrgDefaultEnrollmentRow {
  channel: string;
  handle: string | null;
  status: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  unsubscribed_at: Date | null;
  unsubscribed_reason: string | null;
  expires_at: Date | null;
}

/**
 * Every live org-default enrollment for an account, oldest first.
 *
 * `verification_token_hash` is INTENTIONALLY excluded — only the expiry
 * timestamp is exposed, so a UI can render a countdown without the raw token
 * material ever leaving the database (invariant #5's posture, applied to
 * channel verification).
 *
 * @param sql Postgres.js client — supplied by the composition root (invariant #15).
 */
export async function getOrgDefaultChannelEnrollments(
  sql: Sql,
  accountId: string,
): Promise<OrgDefaultEnrollmentRow[]> {
  return sql<OrgDefaultEnrollmentRow[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at
    FROM channel_enrollments e
    WHERE e.account_id = ${accountId}
      AND e.location_id IS NULL
      AND e.archived_at IS NULL
      AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
    ORDER BY e.created_at ASC
  `;
}
