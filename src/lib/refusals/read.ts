import type { Sql } from 'postgres';
import { dashboardWindowParams, type DashboardWindow } from '@/lib/kpi/types';
import type {
  RefusalCategory,
  // `RefusalSource` is imported for `EntryRow` and `resolveLinkKind` ONLY. It
  // decides `linkKind` server-side and is never placed on a DTO field.
  RefusalSource,
  RefusalSubjectType,
} from './vocabulary';

/**
 * The **Restraint tab**'s only data source: ONE scan of `refusal_events` plus
 * two scoped context reads.
 *
 * WHY THIS IS NOT A PROJECTION. The parent effort (`feat/refusal-log`) built
 * this surface as six `UNION ALL` arms over the source tables and could not
 * order the result, because two lanes carry no immutable timestamp of their
 * own. That failure is why `refusal_events.occurred_at` exists and why it is
 * writer-supplied. #1002 then decided there is never a backfill, so those arms
 * have no second life. This file reads the ledger and re-derives nothing.
 *
 * WHAT IT NEVER SELECTS, and both are load-bearing (ADR 0023):
 *   * `all_refusal_codes` — non-owner-facing evidence for support and trust-dial
 *     tuning. `refusal_events` is deny-all RLS and this module reads through the
 *     RLS-BYPASSING `postgres` role, so RLS is not the guard here. RLS filters
 *     ROWS, not COLUMNS. The omission below IS the access control.
 *   * `refusal_code` — the **Refusal source**'s verbatim lane code. The tab
 *     renders the **Refusal category**; a raw code is not owner-facing language.
 *
 * INVARIANT #15 — `sql` is an explicit parameter. This module never imports
 * `@/lib/db/server`; the route is the composition root that hands it down.
 */
export interface RefusalLogEntry {
  id: string;
  /** The STORED refusal_category. Never re-derived (#995). */
  category: RefusalCategory;
  /** ISO 8601. The DECISION time (occurred_at), never created_at. */
  occurredAt: string;
  subjectType: RefusalSubjectType | null;
  subjectId: string | null;
  /**
   * WHERE THIS ROW MAY LINK, resolved SERVER-SIDE. Invariant I14.
   *
   * It exists because link authority is per-LANE and the category does not
   * carry the lane. `held_draft` maps to `unsafe_content` and so does
   * `policy_gate_held`'s `moderation_flagged`, and migration 116's CHECK C1
   * gives BOTH lanes `subject_type = 'response'`. A link rule keyed on category
   * alone therefore hands a policy-gate row a held draft's review link.
   *
   * `null` also absorbs the second case migration 116's `subject_id` comment
   * insists stay distinguishable: a non-null id whose subject has aged away.
   * The tab drops the link, never the row.
   */
  linkKind: 'review' | 'auto-approval' | 'contacts' | null;
}

/** One archived-then-maybe-reactivated period for ONE location. */
export interface ArchivedPeriod {
  archivedAt: string;
  /** null = still archived at the end of the window. */
  reactivatedAt: string | null;
}

export interface ArchivedLocationSummary {
  refusalCount: number;
  locationCount: number;
}

export type RefusalLogScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'location'; accountId: string; businessId: string };

export interface RefusalLog {
  total: number;
  /** Newest first. */
  entries: RefusalLogEntry[];
  /** ISO 8601 lower bound actually queried, CLAMPED to `coverageStart` (E13). */
  windowStart: string;
  /** ISO 8601 upper bound, from the same clock as windowStart. Queries bind it (I15). */
  windowEnd: string;
  /** accounts.created_at (account) or businesses.created_at (location). null when unknown. */
  coverageStart: string | null;
  /** Account scope only; null in a location scope. */
  archivedLocations: ArchivedLocationSummary | null;
  /** Location scope only; [] in an account scope. */
  archivedPeriods: ArchivedPeriod[];
}

interface EntryRow {
  id: string;
  /** Server-side ONLY — it decides `linkKind` and never reaches the wire. */
  refusal_source: RefusalSource;
  refusal_category: RefusalCategory;
  subject_type: RefusalSubjectType | null;
  subject_id: string | null;
  occurred_at: Date;
  subject_resolves: boolean;
}

interface CoverageRow {
  created_at: Date | null;
}

/**
 * WHERE A ROW MAY LINK. Invariant I14 — authority is per-LANE.
 *
 * `held_draft` is the ONLY lane that links to a review. `policy_gate_held`
 * shares its `unsafe_content` **Refusal category** through `moderation_flagged`
 * AND its `subject_type = 'response'` (migration 116, C1), so a category-keyed
 * rule would give it a held draft's link to a draft the owner was never asked
 * to review.
 *
 * The two category-keyed links carry no subject and are safe to key that way.
 * Everything else links nowhere: the ticket names exactly three links, and
 * `owner_review_required` is not one of them.
 */
function resolveLinkKind(
  source: RefusalSource,
  category: RefusalCategory,
  subjectResolves: boolean,
): RefusalLogEntry['linkKind'] {
  if (source === 'held_draft') return subjectResolves ? 'review' : null;
  if (category === 'autonomy_paused') return 'auto-approval';
  if (category === 'no_permission') return 'contacts';
  return null;
}

interface ArchivalEvent {
  eventType: 'location_archived' | 'location_reactivated';
  at: Date;
}

/**
 * Pair archive/reactivate events into periods, then keep only the periods that
 * INTERSECT the window.
 *
 * This is the tab's ONLY read from a table the ledger does not own. It is
 * CONTEXT — *when were we not watching* — and never a re-derived **Refusal**.
 * `ArchivalPoller` never sweeps `account_audit_log`, so the history is complete
 * for as long as the account exists.
 *
 * A trailing `location_archived` with no reactivation yields an OPEN period
 * (`reactivatedAt: null`). A leading `location_reactivated` with no preceding
 * archive is ignored: it describes a period that began before this log did, and
 * inventing a start date for it would be the same lie the **Coverage start**
 * exists to prevent.
 *
 * Exported for its own tests. `getRefusalLog` is its only production caller.
 */
export function pairArchivedPeriods(
  events: ArchivalEvent[],
  windowStart: Date,
  windowEnd: Date,
): ArchivedPeriod[] {
  const periods: ArchivedPeriod[] = [];
  let openedAt: Date | null = null;

  for (const event of events) {
    if (event.eventType === 'location_archived') {
      // Two archives in a row cannot happen (archive refuses an archived
      // location), so the first wins and the second is ignored rather than
      // silently closing the first.
      openedAt ??= event.at;
      continue;
    }
    if (openedAt === null) continue;
    periods.push({
      archivedAt: openedAt.toISOString(),
      reactivatedAt: event.at.toISOString(),
    });
    openedAt = null;
  }

  if (openedAt !== null) {
    periods.push({ archivedAt: openedAt.toISOString(), reactivatedAt: null });
  }

  // Half-open intersection: a period touching the window at all is rendered. An
  // OPEN period runs to the window's end by construction, so it always
  // intersects a window it started before.
  return periods.filter((period) => {
    const start = new Date(period.archivedAt);
    const end = period.reactivatedAt ? new Date(period.reactivatedAt) : windowEnd;
    return start <= windowEnd && end >= windowStart;
  });
}

function toEntry(row: EntryRow): RefusalLogEntry {
  return {
    id: row.id,
    category: row.refusal_category,
    occurredAt: row.occurred_at.toISOString(),
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    linkKind: resolveLinkKind(row.refusal_source, row.refusal_category, row.subject_resolves),
  };
}

export async function getRefusalLog(
  sql: Sql,
  scope: RefusalLogScope,
  window: DashboardWindow,
): Promise<RefusalLog> {
  const { windowDays } = dashboardWindowParams(window);
  const windowEndMs = Date.now();
  const windowEnd = new Date(windowEndMs);
  const selectedStart = new Date(windowEndMs - windowDays * 24 * 60 * 60 * 1000);

  // **Coverage start** FIRST, because it BOUNDS the entry query below.
  //
  // It is when we began recording, NOT when the account began. A two-day-old
  // account selecting 30d must never be told we held nothing back across 28 days
  // we were not recording — that is the false zero this whole surface exists to
  // avoid, and E13 is where it enters.
  const [coverage] = scope.kind === 'location'
    ? await sql<CoverageRow[]>`
        SELECT b.created_at
        FROM businesses b
        WHERE b.id = ${scope.businessId}
          AND b.account_id = ${scope.accountId}
      `
    : await sql<CoverageRow[]>`
        SELECT a.created_at
        FROM accounts a
        WHERE a.id = ${scope.accountId}
      `;

  const coverageStart = coverage?.created_at ?? null;
  const windowStart = coverageStart && coverageStart > selectedStart
    ? coverageStart
    : selectedStart;

  // BOTH ENDS ARE BOUND (I15). `occurred_at` is WRITER-supplied, not a database
  // clock, so an unbounded upper edge admits a clock-skewed row dated after the
  // very `windowEnd` the tab prints as the range it covers.
  //
  // Neither bound is round-tripped from a row — both come from one `Date.now()`
  // — so the #520 microsecond trap does not apply and NO `date_trunc` belongs
  // here. That trap is fatal only when a row is compared against a window
  // derived FROM that row. Adding one would also make the predicate non-sargable
  // against `idx_refusal_events_account_window`.
  //
  // `subject_resolves` answers the question migration 116's `subject_id` comment
  // insists stay answerable: a NULL id means "this lane points at nothing", and a
  // non-null id that no longer resolves means "the subject aged away". The tab
  // drops the LINK, never the row.
  //
  // A CORRELATED `EXISTS`, not a LEFT JOIN, and `ci:tenant-scope` is why. That
  // audit proves a nested tenant table through a `business_id` correlation only
  // ACROSS nesting levels (`scopedFromAncestor`); inside one block it wants a
  // literal binding, which the account arm has no single value for. `responses`
  // has no `account_id`, so a same-block join to it is unprovable by
  // construction. The subquery makes `r` an ancestor and the correlation
  // `resp.business_id = r.business_id` proves the binding — and it is stronger
  // than a bare id match either way: a response belonging to another location
  // cannot resolve.
  //
  // The two arms are spelled out rather than composed from a shared fragment.
  // `ci:tenant-scope` reads QUERY BLOCKS, so every block carries its own tenant
  // keys literally. This is `getAgentTeamSummary`'s shape and its reason.
  const rows = scope.kind === 'location'
    // The location arm enforces I9 ITSELF rather than trusting its one caller.
    // `resolveDashboardLocation` already 404s an archived location, but
    // `getRefusalLog` is a documented public seam and its own promised test
    // ("excludes rows belonging to an archived location from a location total")
    // calls it directly. An invariant that only holds at the route is not an
    // invariant of the read.
    ? await sql<EntryRow[]>`
        SELECT r.id, r.refusal_source, r.refusal_category, r.subject_type,
               r.subject_id, r.occurred_at,
               EXISTS (
                 SELECT 1 FROM responses resp
                 WHERE r.subject_type = 'response'
                   AND resp.id = r.subject_id
                   AND resp.business_id = r.business_id
               ) AS subject_resolves
        FROM refusal_events r
        WHERE r.account_id = ${scope.accountId}
          AND (r.business_id = ${scope.businessId} OR r.business_id IS NULL)
          AND r.occurred_at >= ${windowStart}
          AND r.occurred_at <= ${windowEnd}
          AND EXISTS (
            SELECT 1 FROM businesses b
            WHERE b.id = ${scope.businessId}
              AND b.account_id = ${scope.accountId}
              AND b.archived_at IS NULL
          )
        ORDER BY r.occurred_at DESC, r.id DESC
      `
    // The account arm excludes an ARCHIVED location's rows while KEEPING the
    // account-wide ones (`business_id IS NULL`, the `autonomy_suspended` lane).
    //
    // EXISTS, never a JOIN, and that is not style. Joining `refusal_events` to
    // `businesses` is the exact shape that multiplied one account-level event by
    // the account's location count in the parent effort — the defect migration
    // 116's CHECK C3 exists to make unrepresentable. `businesses.id` is a primary
    // key so a join here would in fact be 1:1, but EXISTS cannot fan out at all,
    // and a structure that cannot express the bug beats one that merely does not.
    : await sql<EntryRow[]>`
        SELECT r.id, r.refusal_source, r.refusal_category, r.subject_type,
               r.subject_id, r.occurred_at,
               EXISTS (
                 SELECT 1 FROM responses resp
                 WHERE r.subject_type = 'response'
                   AND resp.id = r.subject_id
                   AND resp.business_id = r.business_id
               ) AS subject_resolves
        FROM refusal_events r
        WHERE r.account_id = ${scope.accountId}
          AND r.occurred_at >= ${windowStart}
          AND r.occurred_at <= ${windowEnd}
          AND (
            r.business_id IS NULL
            OR EXISTS (
              SELECT 1 FROM businesses b
              WHERE b.id = r.business_id
                AND b.account_id = ${scope.accountId}
                AND b.archived_at IS NULL
            )
          )
        ORDER BY r.occurred_at DESC, r.id DESC
      `;

  // The footnote. ACCOUNT SCOPE ONLY — a location view shows one ACTIVE
  // location and therefore hides nothing (#1005). An INNER JOIN is correct
  // here and cannot fan out (`businesses.id` is the primary key); it also
  // drops `business_id IS NULL` rows for free, which is right: an account-wide
  // suspension never came "from an archived location".
  //
  // BOTH window bounds are bound again, for the same reason the entry query
  // binds them: the footnote states a count for THE SAME window the tab prints,
  // and a writer-supplied `occurred_at` after that range must not inflate it.
  const archivedLocations = scope.kind === 'account'
    ? (await sql<{ refusal_count: number; location_count: number }[]>`
        SELECT
          COUNT(*)::int                        AS refusal_count,
          COUNT(DISTINCT r.business_id)::int   AS location_count
        FROM refusal_events r
        JOIN businesses b ON b.id = r.business_id
        WHERE r.account_id = ${scope.accountId}
          AND b.account_id = ${scope.accountId}
          AND b.archived_at IS NOT NULL
          AND r.occurred_at >= ${windowStart}
          AND r.occurred_at <= ${windowEnd}
      `)[0] ?? { refusal_count: 0, location_count: 0 }
    : null;

  // Location scope only. `account_audit_log` is a table `ArchivalPoller` never
  // sweeps, so this history outlives the 180-day ledger retention.
  const archivedPeriods = scope.kind === 'location'
    ? pairArchivedPeriods(
        (await sql<{ event_type: 'location_archived' | 'location_reactivated'; created_at: Date }[]>`
          SELECT l.event_type, l.created_at
          FROM account_audit_log l
          WHERE l.account_id = ${scope.accountId}
            AND l.location_id = ${scope.businessId}
            AND l.event_type IN ('location_archived', 'location_reactivated')
          ORDER BY l.created_at ASC
        `).map((row) => ({ eventType: row.event_type, at: row.created_at })),
        windowStart,
        windowEnd,
      )
    : [];

  const entries = rows.map(toEntry);

  return {
    total: entries.length,
    entries,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    // `businesses.created_at` is NULLABLE (migration 001); `accounts.created_at`
    // is NOT NULL (034). The tab OMITS the line rather than claiming a date it
    // does not have — and a null coverage start also leaves `windowStart`
    // unclamped, which is right: an unknown start cannot narrow anything.
    coverageStart: coverageStart?.toISOString() ?? null,
    archivedLocations: archivedLocations
      ? {
          refusalCount: archivedLocations.refusal_count,
          locationCount: archivedLocations.location_count,
        }
      : null,
    archivedPeriods,
  };
}
