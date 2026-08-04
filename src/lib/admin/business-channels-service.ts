// src/lib/admin/business-channels-service.ts
//
// Extracted verbatim from src/app/api/admin/businesses/[id]/channels/route.ts's
// GET body (admin console Phase 3, Task 3): the account resolution, the
// enrollment query, the per-channel dedup, and the handle masking. Born-injected
// — `sql` is a parameter, not an import — so the route and the business-detail
// server page (both composition roots) supply the singleton (invariant #15).
//
// The one behavioral addition over the route: every TIMESTAMPTZ column is
// converted to an ISO string HERE. The route got away without it because
// `JSON.stringify` serializes a `Date` to the same ISO text; a server component
// handing this DTO to a client component does not — the RSC serializer preserves
// the `Date`, and a field typed `string` then blows up on first paint. The wire
// response is byte-identical either way.

import type { Sql } from 'postgres';
import type { LocationId } from '@/lib/shared/ids';
import { CHANNEL_IDS, type ChannelId } from '@/lib/notifications/channels/types';
import { maskChannelHandle } from '@/lib/notifications/mask-handle';

/** Raw enrollment row, before per-channel dedup and handle masking. */
interface ChannelEnrollmentQueryRow {
  channel: string;
  handle: string | null;
  status: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  unsubscribed_at: Date | null;
  unsubscribed_reason: string | null;
  expires_at: Date | null;
  last_activity_at: Date | null;
  /** null = account-scoped org-default; non-null = per-location override. */
  location_id: string | null;
}

/** App-enforced enrollment lifecycle (no DB CHECK — migration 021). */
export type ChannelEnrollmentStatus =
  | 'pending_verification'
  | 'verified'
  | 'disabled'
  | 'unsubscribed';

/**
 * One effective channel enrollment for a location, handle masked. Snake_case
 * field names are the wire contract the admin channels route has always
 * returned — kept as-is so the route response stays byte-identical.
 *
 * Single owner for this DTO: the admin detail page's `ChannelEnrollmentRow`
 * re-exports this type rather than hand-copying it.
 */
export interface AdminChannelEnrollment {
  channel: ChannelId;
  /** Masked, or '(pending verification)' when no handle is recorded yet. */
  handle: string;
  status: ChannelEnrollmentStatus;
  /** ISO-8601 — converted here so the RSC path is safe. */
  verified_at: string | null;
  /** ISO-8601 — converted here so the RSC path is safe. */
  disabled_at: string | null;
  /** ISO-8601 — converted here so the RSC path is safe. */
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  /** ISO-8601 — converted here so the RSC path is safe. */
  expires_at: string | null;
  /** ISO-8601 — converted here so the RSC path is safe. */
  last_activity_at: string | null;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Collapses account-scoped rows to one effective enrollment per channel,
 * preferring a per-location override over the org-default. Relies on the
 * query's ORDER BY placing overrides (location_id NOT NULL) before org-defaults
 * for each channel, so the first row seen per channel is the one that wins.
 */
function resolveEffectiveEnrollments(
  rows: ChannelEnrollmentQueryRow[],
): ChannelEnrollmentQueryRow[] {
  const byChannel = new Map<string, ChannelEnrollmentQueryRow>();
  for (const row of rows) {
    if (!byChannel.has(row.channel)) {
      byChannel.set(row.channel, row);
    }
  }
  return Array.from(byChannel.values());
}

/**
 * The effective channel enrollments an admin sees on a location's detail page.
 *
 * Channel enrollment is ACCOUNT-scoped: admin start/disable act on the
 * org-default row (account_id + channel + location_id IS NULL), regardless of
 * which location's detail page is open. `business_id` on the table is a legacy
 * FK and is NOT the org-default lookup key. So we resolve the account from the
 * location, then read account-scoped — mirroring resolveChannels' precedence
 * (per-location override beats org-default).
 *
 * An unknown location yields `{ enrollments: [] }` without a second query.
 */
export async function getBusinessChannelEnrollments(
  sql: Sql,
  businessId: LocationId,
): Promise<{ enrollments: AdminChannelEnrollment[] }> {
  const [accountRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (!accountRow) {
    return { enrollments: [] };
  }
  const accountId = accountRow.account_id;

  const rows = await sql<ChannelEnrollmentQueryRow[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at,
      e.location_id,
      -- Per-row COALESCE (delivered OR sent), THEN aggregate MAX. Doing it
      -- the other way (COALESCE(MAX(delivered), MAX(sent))) would return
      -- the older delivered timestamp when a newer row has only sent_at.
      -- Scope deliveries to the VIEWED location (the caller's businessId), not
      -- the enrollment row's legacy business_id: an org-default row carries
      -- the creator location's business_id, so e.business_id would surface a
      -- different location's activity on this page.
      (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at))
         FROM notification_deliveries nd
         WHERE nd.business_id = ${businessId}
           AND nd.channel = e.channel) AS last_activity_at
    FROM channel_enrollments e
    WHERE e.account_id = ${accountId}
      AND (e.location_id = ${businessId} OR e.location_id IS NULL)
      AND e.archived_at IS NULL
      AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
    ORDER BY
      -- Per-location overrides first so the dedup keeps them over org-defaults
      -- for the same channel (mirrors resolveChannels VAL-NOTIF-003).
      CASE WHEN e.location_id IS NOT NULL THEN 0 ELSE 1 END,
      e.created_at ASC
  `;

  const effective = resolveEffectiveEnrollments(rows);

  // `location_id` is an internal resolution detail used only for override-vs-
  // org-default precedence; it is intentionally not part of the response.
  const enrollments = effective.map((r) => ({
    // The query's `e.channel = ANY(CHANNEL_IDS)` predicate is what makes this
    // narrowing sound; `status` is app-enforced with no DB CHECK (migration 021).
    channel: r.channel as ChannelId,
    handle: r.handle !== null ? maskChannelHandle(r.channel, r.handle) : '(pending verification)',
    status: r.status as ChannelEnrollmentStatus,
    verified_at: toIso(r.verified_at),
    disabled_at: toIso(r.disabled_at),
    unsubscribed_at: toIso(r.unsubscribed_at),
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: toIso(r.expires_at),
    last_activity_at: toIso(r.last_activity_at),
  }));

  return { enrollments };
}
