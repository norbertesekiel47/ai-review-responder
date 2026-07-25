// src/lib/competitors/named-rival.ts
//
// Single owner of Competitor Delta resolution (#546, map #528; semantics #532).
// Callers learn three functions; this module hides primary-keyword resolution,
// search-location resolution, the two-snapshot window, DATE/NUMERIC parsing,
// Auto-default selection, and (from Task 3) pick honoring + dropout derivation.
//
// Invariant #15: the Sql client arrives as an explicit parameter. Only
// composition roots (WeeklySummaryWorker, the settings route) import the
// singleton and pass it down.

import type { Sql } from 'postgres';
import type { LocationId } from '@/lib/shared/ids';

// The FINAL shape lands here in #546 Task 2, even though `source` is always
// 'auto_default' and `dropout` is unreachable until Task 3. Introducing an
// intermediate shape would churn every test twice for no safety.
export interface NamedRivalLine {
  rivalName: string;
  gap: number;
  reviewVelocity: number | null;
  source: 'owner_pick' | 'auto_default';
}

export type CompetitorDelta =
  | { kind: 'teaser'; keyword: string }
  | { kind: 'rival'; line: NamedRivalLine }
  | { kind: 'dropout'; droppedName: string; fallback: NamedRivalLine | null }
  | null;

interface CompetitorSnapshotRow {
  snapshot_date: string;
  rank_position: number | null;
  place_id: string | null;
  title: string;
  rating: string | null;
  review_count: number | null;
  is_self: boolean;
}

interface NormalizedCompetitorSnapshotRow extends Omit<CompetitorSnapshotRow, 'rating'> {
  rating: number | null;
}

// One row per (competitor-lane context × snapshot date × pack entry). The two
// LEFT JOINs mean the context columns survive with NULL date/pack columns, so
// a single read distinguishes "never configured" from "configured, awaiting
// first pack" from "pack recorded empty".
interface NamedRivalContextRow {
  keyword: string | null;
  search_location: string | null;
  rival_place_id: string | null;
  rival_title_snapshot: string | null;
  window_date: string | null;
  snapshot_date: string | null;
  rank_position: number | null;
  place_id: string | null;
  title: string | null;
  rating: string | null;
  review_count: number | null;
  is_self: boolean | null;
}

/** A context row that carried a real `competitor_snapshots` match. */
type PackJoinRow = NamedRivalContextRow & {
  snapshot_date: string;
  title: string;
  is_self: boolean;
};

function parseCompetitorRating(rating: string | null): number | null {
  if (rating === null || rating.trim().length === 0) return null;
  const parsed = Number(rating);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectAutoDefaultRival(
  rows: NormalizedCompetitorSnapshotRow[],
  currentDate: string,
  precedingDate: string | undefined,
): NamedRivalLine | null {
  const currentRows = rows.filter((row) => row.snapshot_date === currentDate);
  const self = currentRows.find(
    (row) => row.is_self && Number.isInteger(row.review_count),
  );
  if (!self || self.review_count === null) return null;

  const candidates = currentRows
    .filter((row) => (
      !row.is_self
      && row.place_id !== null
      && row.place_id.length > 0
      && row.title.trim().length > 0
      && Number.isInteger(row.review_count)
    ))
    .map((row) => ({
      row,
      gap: row.review_count! - self.review_count!,
    }));
  if (candidates.length === 0) return null;

  const ahead = candidates.filter(({ gap }) => gap > 0);
  const eligible = ahead.length > 0 ? ahead : candidates;
  eligible.sort((left, right) => {
    const gapOrder = ahead.length > 0
      ? left.gap - right.gap
      : right.gap - left.gap;
    if (gapOrder !== 0) return gapOrder;

    const leftRank = left.row.rank_position ?? Number.POSITIVE_INFINITY;
    const rightRank = right.row.rank_position ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.row.place_id! < right.row.place_id!) return -1;
    if (left.row.place_id! > right.row.place_id!) return 1;
    return 0;
  });

  const selected = eligible[0]!;
  const preceding = precedingDate
    ? rows.find((row) => (
      row.snapshot_date === precedingDate
      && row.place_id === selected.row.place_id
      && Number.isInteger(row.review_count)
    ))
    : undefined;

  return {
    rivalName: selected.row.title,
    gap: selected.gap,
    reviewVelocity: preceding?.review_count === null || preceding?.review_count === undefined
      ? null
      : selected.row.review_count! - preceding.review_count,
    source: 'auto_default',
  };
}

function isPackJoinRow(row: NamedRivalContextRow): row is PackJoinRow {
  // `competitor_snapshots.title` and `.is_self` are NOT NULL (migration 084),
  // so a joined snapshot_date means the whole pack entry is present.
  return typeof row.snapshot_date === 'string';
}

/**
 * Result contract for the single read below.
 *
 * `snapshotDates` is the distinct non-null `window_date` values in DESC order —
 * the one- or two-entry observation window. The pack rows are the rows whose
 * `snapshot_date` is non-null; a row carrying a `window_date` but a NULL
 * `snapshot_date` is the empty-pack sentinel, so it is DISCARDED from the pack
 * rows while its date is KEPT in `snapshotDates`. Everything downstream then
 * receives exactly the inputs the three-statement version fed it.
 */
function toObservationWindow(rows: NamedRivalContextRow[]): {
  snapshotDates: string[];
  packRows: NormalizedCompetitorSnapshotRow[];
} {
  const snapshotDates: string[] = [];
  for (const row of rows) {
    if (typeof row.window_date === 'string' && !snapshotDates.includes(row.window_date)) {
      snapshotDates.push(row.window_date);
    }
  }
  const packRows = rows.filter(isPackJoinRow).map((row) => ({
    snapshot_date: row.snapshot_date,
    rank_position: row.rank_position,
    place_id: row.place_id,
    title: row.title,
    rating: parseCompetitorRating(row.rating),
    review_count: row.review_count,
    is_self: row.is_self,
  }));
  return { snapshotDates, packRows };
}

/**
 * Resolves the Competitor Delta line for one location from its primary tracked
 * keyword's local-pack series.
 *
 * Reads the competitor lane in ONE statement on purpose: RankingTrackingWorker
 * replaces the pack wholesale (084 replace-pack) and its `ranking_snapshots`
 * upsert overwrites `search_location` on a same-day re-run, so sequential
 * statements can observe a pack that does not correspond to the dates just
 * read. `db.begin()` would NOT fix that — Postgres defaults to READ COMMITTED,
 * one snapshot per statement.
 */
export async function resolveNamedRival(
  db: Sql,
  businessId: LocationId,
): Promise<CompetitorDelta> {
  // snapshot_date is a DATE column: without ::text Postgres.js hands back a
  // JS Date object, and the === string comparisons downstream are always
  // false (lab note: keep DATE values ::text end-to-end).
  const rows = await db<NamedRivalContextRow[]>`
    WITH ctx AS (
      SELECT
        b.tracked_keywords->>0 AS keyword,
        CASE
          WHEN b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL
            THEN b.google_place_lat::text || ',' || b.google_place_lng::text
          ELSE b.ranking_search_location
        END AS search_location,
        b.rival_place_id,          -- read from Task 3 onward (owner pick)
        b.rival_title_snapshot     -- read from Task 3 onward (dropout name)
      FROM businesses b
      WHERE b.id = ${businessId}
    ),
    dates AS (
      SELECT rs.snapshot_date
      FROM ranking_snapshots rs, ctx
      WHERE rs.business_id = ${businessId}
        AND rs.keyword = ctx.keyword
        AND rs.search_location = ctx.search_location
      ORDER BY rs.snapshot_date DESC
      LIMIT 2
    )
    SELECT
      ctx.keyword,
      ctx.search_location,
      ctx.rival_place_id,
      ctx.rival_title_snapshot,
      d.snapshot_date::text AS window_date,
      cs.snapshot_date::text AS snapshot_date,
      cs.rank_position, cs.place_id, cs.title, cs.rating, cs.review_count, cs.is_self
    FROM ctx
    LEFT JOIN dates d ON true
    LEFT JOIN competitor_snapshots cs
      ON cs.business_id = ${businessId}
     AND cs.keyword = ctx.keyword
     AND cs.search_location IS NOT DISTINCT FROM ctx.search_location
     AND cs.snapshot_date = d.snapshot_date
    ORDER BY d.snapshot_date DESC, cs.rank_position ASC NULLS LAST, cs.place_id ASC NULLS LAST
  `;

  const keyword = rows[0]?.keyword;
  const searchLocation = rows[0]?.search_location;
  if (!keyword?.trim() || !searchLocation?.trim()) return null;

  const { snapshotDates, packRows } = toObservationWindow(rows);
  if (snapshotDates.length === 0) return { kind: 'teaser', keyword };

  const line = selectAutoDefaultRival(packRows, snapshotDates[0]!, snapshotDates[1]);
  return line ? { kind: 'rival', line } : { kind: 'teaser', keyword };
}

/** Internal seam exposed for unit tests only — not part of the module's interface. */
export const __testing = { selectAutoDefaultRival, parseCompetitorRating };
