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

import type { Sql, TransactionSql } from 'postgres';
import type { LocationId } from '@/lib/shared/ids';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';

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

/** The owner's stored Named rival pick, as persisted on `businesses` (089). */
interface StoredRivalPick {
  placeId: string;
  titleSnapshot: string;
}

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

/**
 * Builds the Competitor Delta line for one already-chosen pack row.
 *
 * Single owner of the gap and review-velocity arithmetic: gap is the rival's
 * review count minus ours (never rating or rank), and velocity is measured
 * against the SAME place_id in the immediately preceding snapshot — absent or
 * uncountable there means "no velocity", not zero.
 */
function buildLineForRow(
  row: NormalizedCompetitorSnapshotRow,
  selfReviewCount: number,
  rows: NormalizedCompetitorSnapshotRow[],
  precedingDate: string | undefined,
  source: NamedRivalLine['source'],
): NamedRivalLine {
  const preceding = precedingDate
    ? rows.find((candidate) => (
      candidate.snapshot_date === precedingDate
      && candidate.place_id === row.place_id
      && Number.isInteger(candidate.review_count)
    ))
    : undefined;

  return {
    rivalName: row.title,
    gap: row.review_count! - selfReviewCount,
    reviewVelocity: preceding?.review_count === null || preceding?.review_count === undefined
      ? null
      : row.review_count! - preceding.review_count,
    source,
  };
}

/**
 * The latest pack's rows plus its countable self row — "countable" means an
 * integer `review_count`, the precondition every gap computation shares.
 */
function latestPackWithSelf(
  rows: NormalizedCompetitorSnapshotRow[],
  currentDate: string,
): {
  currentRows: NormalizedCompetitorSnapshotRow[];
  self: NormalizedCompetitorSnapshotRow | undefined;
} {
  const currentRows = rows.filter((row) => row.snapshot_date === currentDate);
  const self = currentRows.find(
    (row) => row.is_self && Number.isInteger(row.review_count),
  );
  return { currentRows, self };
}

function selectAutoDefaultRival(
  rows: NormalizedCompetitorSnapshotRow[],
  currentDate: string,
  precedingDate: string | undefined,
): NamedRivalLine | null {
  const { currentRows, self } = latestPackWithSelf(rows, currentDate);
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
  return buildLineForRow(selected.row, self.review_count, rows, precedingDate, 'auto_default');
}

/**
 * Resolves the Named rival for one snapshot window: the owner's pick where it
 * is usable in the latest Competitor pack, otherwise the Auto-default rival —
 * with a dropout note while the latest two-snapshot window shows the pick
 * leaving the pack (derived statelessly, so it repeats across every digest
 * that reads the same window — see the #546 deviations doc).
 *
 * A pick is never auto-removed here; this function only decides what THIS
 * digest reports.
 */
function selectNamedRival(
  rows: NormalizedCompetitorSnapshotRow[],
  currentDate: string,
  precedingDate: string | undefined,
  pick: StoredRivalPick | null,
): CompetitorDelta {
  const autoDefault = selectAutoDefaultRival(rows, currentDate, precedingDate);
  if (!pick) return autoDefault ? { kind: 'rival', line: autoDefault } : null;

  const { currentRows, self } = latestPackWithSelf(rows, currentDate);

  // The blank-title exclusion mirrors `selectAutoDefaultRival` and the picker's
  // option filter: 084 stores `title = ''` when SerpAPI omits a name, and an
  // unnameable rival would render a nameless digest line. Honoring the pick
  // requires a row we can NAME, not merely one we can count.
  const pickedRow = currentRows.find(
    (row) => row.place_id === pick.placeId
      && !row.is_self
      && Number.isInteger(row.review_count)
      && row.title.trim().length > 0,
  );
  if (pickedRow && self) {
    return {
      kind: 'rival',
      line: buildLineForRow(pickedRow, self.review_count!, rows, precedingDate, 'owner_pick'),
    };
  }

  // The pick is not usable in the latest pack. It is a DROPOUT only when the
  // pick was present in the immediately preceding snapshot — first-absent is
  // derived from the same two-date window that drives velocity (#532 item 4).
  // Present-but-unusable (NULL review count, or a blank title) is not a
  // dropout: the rival is still in the pack, just uncountable or unnameable.
  const presentButUnusable = currentRows.some((row) => row.place_id === pick.placeId);
  const wasInPreceding = precedingDate !== undefined
    && rows.some((row) => row.snapshot_date === precedingDate && row.place_id === pick.placeId);

  // GUARD: never claim a rival dropped out of a pack we have no rows for. 084
  // treats an empty pack for a date as a recorded fact (SerpAPI returned
  // nothing), and with zero rows EVERY place_id looks "absent" — rendering
  // "<Rival> dropped out of your local pack" when the truth is "we have no pack
  // data", with a null fallback leaving the owner a bare false alarm.
  //
  // Guard on the ROW COUNT, not on `self`: a non-empty pack that simply lacks
  // our is_self row (our location fell out of its own local pack) is real pack
  // data, and a pick that left it really did leave. Suppressing that case would
  // trade a false positive for a false negative.
  if (currentRows.length === 0) return autoDefault ? { kind: 'rival', line: autoDefault } : null;

  if (!presentButUnusable && wasInPreceding) {
    return { kind: 'dropout', droppedName: pick.titleSnapshot, fallback: autoDefault };
  }

  return autoDefault ? { kind: 'rival', line: autoDefault } : null;
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

  const context = rows[0];
  const keyword = context?.keyword;
  const searchLocation = context?.search_location;
  if (!keyword?.trim() || !searchLocation?.trim()) return null;

  const { snapshotDates, packRows } = toObservationWindow(rows);
  if (snapshotDates.length === 0) return { kind: 'teaser', keyword };

  // The pick rides the SAME statement as the pack (the `ctx` CTE above): a
  // second read could observe a pick that does not belong to these pack rows.
  const pick: StoredRivalPick | null = context?.rival_place_id
    ? { placeId: context.rival_place_id, titleSnapshot: context.rival_title_snapshot ?? context.rival_place_id }
    : null;

  return selectNamedRival(packRows, snapshotDates[0]!, snapshotDates[1], pick)
    ?? { kind: 'teaser', keyword };
}

// ── Owner-facing rival picker (#546 Task 4) ──────────────────────────────────

/** One pickable rival from the location's latest Competitor pack. */
export interface RivalOption {
  placeId: string;
  title: string;
  rankPosition: number | null;
  reviewCount: number | null;
  rating: number | null;
}

/** The location's current Named rival pick, as the picker should render it. */
export interface PickedRival {
  placeId: string;
  /** Live pack title while the pick is in the pack, else the stored snapshot. */
  title: string;
  inLatestPack: boolean;
}

export type RivalPickerView =
  | { state: 'not_configured'; businessId: string }
  | { state: 'awaiting_pack'; businessId: string; keyword: string }
  | { state: 'ready'; businessId: string; keyword: string; options: RivalOption[]; pick: PickedRival | null };

/** The caller asked for a location their account does not own, or that does not exist. */
export class RivalPickNotFoundError extends Error {
  constructor(businessId: string) {
    super(`No location ${businessId} in this account`);
    this.name = 'RivalPickNotFoundError';
  }
}

/** The submitted place_id is not a pickable rival in the location's latest pack. */
export class RivalPickStaleError extends Error {
  constructor(placeId: string) {
    super(`Place ${placeId} is not a pickable rival in the latest competitor pack`);
    this.name = 'RivalPickStaleError';
  }
}

export interface RivalPickerScope {
  accountId: string;
  businessId: LocationId;
}

export interface SetNamedRivalPickInput extends RivalPickerScope {
  /** `null` clears the pick, returning the location to the Auto-default rival. */
  placeId: string | null;
  userId: string | null;
}

interface RivalPickerContextRow {
  keyword: string | null;
  search_location: string | null;
  rival_place_id: string | null;
  rival_title_snapshot: string | null;
}

interface PackOptionRow {
  rank_position: number | null;
  place_id: string | null;
  title: string;
  rating: string | null;
  review_count: number | null;
  is_self: boolean;
}

/**
 * A pack row an owner may pick and the digest can actually name.
 *
 * The blank-title exclusion is deliberate and mirrors `selectAutoDefaultRival`:
 * offering a whitespace-only title here would let an owner select a rival no
 * digest line could ever render.
 */
function isPickableOption(row: PackOptionRow): row is PackOptionRow & { place_id: string } {
  return !row.is_self
    && row.place_id !== null
    && row.place_id.length > 0
    && row.title.trim().length > 0;
}

/**
 * Loads the owner-facing rival picker state for one location.
 *
 * Three flat reads rather than the single CTE `resolveNamedRival` uses: this is
 * a read-only view whose worst concurrent outcome is rendering a pack that was
 * replaced a moment ago, and `setNamedRivalPick` re-validates membership
 * against committed state anyway — so the digest's one-statement consistency
 * requirement does not apply here, and flat predicates stay legible.
 *
 * @throws RivalPickNotFoundError when `businessId` is not a location of `accountId`.
 */
export async function loadRivalPickerView(
  db: Sql,
  { accountId, businessId }: RivalPickerScope,
): Promise<RivalPickerView> {
  const [context] = await db<RivalPickerContextRow[]>`
    SELECT
      b.tracked_keywords->>0 AS keyword,
      CASE
        WHEN b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL
          THEN b.google_place_lat::text || ',' || b.google_place_lng::text
        ELSE b.ranking_search_location
      END AS search_location,
      b.rival_place_id,
      b.rival_title_snapshot
    FROM businesses b
    WHERE b.id = ${businessId} AND b.account_id = ${accountId}
  `;
  if (!context) throw new RivalPickNotFoundError(businessId);

  const { keyword, search_location: searchLocation } = context;
  if (!keyword?.trim() || !searchLocation?.trim()) {
    return { state: 'not_configured', businessId };
  }

  // ranking_snapshots — not competitor_snapshots — answers "has a run happened
  // for this lane": 084 treats an empty pack for a date as a recorded fact, so
  // asking the pack table would misreport a real empty pack as "no pack yet".
  const [latest] = await db<{ snapshot_date: string }[]>`
    SELECT rs.snapshot_date::text AS snapshot_date
    FROM ranking_snapshots rs
    WHERE rs.business_id = ${businessId}
      AND rs.keyword = ${keyword}
      AND rs.search_location = ${searchLocation}
    ORDER BY rs.snapshot_date DESC
    LIMIT 1
  `;
  if (!latest) return { state: 'awaiting_pack', businessId, keyword };

  const packRows = await db<PackOptionRow[]>`
    SELECT cs.rank_position, cs.place_id, cs.title, cs.rating, cs.review_count, cs.is_self
    FROM competitor_snapshots cs
    WHERE cs.business_id = ${businessId}
      AND cs.keyword = ${keyword}
      AND cs.search_location IS NOT DISTINCT FROM ${searchLocation}
      AND cs.snapshot_date = ${latest.snapshot_date}::date
    ORDER BY cs.rank_position ASC NULLS LAST, cs.place_id ASC NULLS LAST
  `;

  const options: RivalOption[] = packRows.filter(isPickableOption).map((row) => ({
    placeId: row.place_id,
    title: row.title,
    rankPosition: row.rank_position,
    reviewCount: row.review_count,
    rating: parseCompetitorRating(row.rating),
  }));

  // `options` may legitimately be empty (a pack of one, or an empty pack) —
  // the client renders the no-rivals copy rather than an error.
  return { state: 'ready', businessId, keyword, options, pick: toPickedRival(context, options) };
}

function toPickedRival(
  context: RivalPickerContextRow,
  options: RivalOption[],
): PickedRival | null {
  const placeId = context.rival_place_id;
  if (!placeId) return null;

  const live = options.find((option) => option.placeId === placeId);
  return {
    placeId,
    title: live?.title ?? context.rival_title_snapshot ?? placeId,
    inLatestPack: live !== undefined,
  };
}

/**
 * Sets or clears the location's Named rival pick and records the owner action.
 *
 * `placeId === null` clears the pick, returning the location to the
 * Auto-default rival. A pick is validated and stored by ONE statement, so no
 * pack replacement can slip between the check and the write; the stored display
 * name is read from the matched pack row, never from an argument.
 *
 * Retry-safe: an identical resubmission leaves `rival_picked_at` untouched, and
 * that timestamp seeds the analytics event key, so the retry's event conflicts
 * away instead of double-counting one owner action.
 *
 * @throws RivalPickNotFoundError when `businessId` is not a location of `accountId`.
 * @throws RivalPickStaleError when `placeId` is not a pickable rival in the latest pack.
 */
export async function setNamedRivalPick(
  db: Sql,
  input: SetNamedRivalPickInput,
): Promise<RivalPickerView> {
  const { accountId, businessId, placeId, userId } = input;

  await db.begin(async (tx) => {
    const decidedAt = placeId === null
      ? await clearRivalPick(tx, input)
      : await storeRivalPick(tx, input, placeId);

    // A clear that matched no row was already cleared — no owner action to record.
    if (!decidedAt) return;

    await enqueueAnalyticsEvent(tx, {
      eventName: 'competitor_rival_picked',
      eventKey: makeAnalyticsEventKey('competitor_rival_picked', [
        businessId,
        placeId ?? 'cleared',
        decidedAt.toISOString(),
      ]),
      distinctId: accountId,
      accountId,
      userId,
      businessId,
      // businessId is ALSO in properties, not only in the analytics_events
      // business_id column: AnalyticsDispatchPoller's RETURNING never selects
      // that column, so it never leaves Postgres. The properties blob is the
      // only way the location dimension reaches PostHog.
      properties: { action: placeId === null ? 'cleared' : 'set', placeId, businessId },
    });
  });

  // Re-read outside the transaction so the caller renders committed state.
  return loadRivalPickerView(db, { accountId, businessId });
}

/**
 * Validates and stores the pick in ONE statement.
 *
 * A `SELECT` to validate followed by an `UPDATE` to store leaves a window in
 * which RankingTrackingWorker can commit a replacement pack, after which we
 * persist a pick for a rival no longer in the pack — and the very next digest
 * would fire a dropout note for a rival the owner picked seconds earlier.
 * Locking is the wrong tool: the worker's `ranking_snapshots` row lock is keyed
 * on (business, keyword, snapshot_date), so locking whichever row is currently
 * latest serializes nothing when the worker inserts a NEW date.
 */
async function storeRivalPick(
  tx: TransactionSql,
  { accountId, businessId }: RivalPickerScope,
  placeId: string,
): Promise<Date> {
  const [updated] = await tx<{ rival_picked_at: Date }[]>`
    UPDATE businesses b
    SET rival_place_id = cs.place_id,
        rival_title_snapshot = cs.title,
        -- A retried request that re-submits the SAME rival must not move this
        -- timestamp: it seeds the analytics event key, and a moving key would
        -- double-count one owner action as two engagement events. A rename-only
        -- refresh (same place_id, new title) likewise updates the snapshot
        -- without moving it — that is not a new owner action. The IS NULL leg
        -- only fires for a hand-edited row and keeps RETURNING non-null.
        rival_picked_at = CASE
          WHEN b.rival_place_id IS DISTINCT FROM cs.place_id OR b.rival_picked_at IS NULL
            THEN NOW()
          ELSE b.rival_picked_at
        END
    FROM competitor_snapshots cs
    WHERE b.id = ${businessId}
      AND b.account_id = ${accountId}
      AND cs.business_id = ${businessId}
      AND cs.place_id = ${placeId}
      -- Keyword and search location are derived from the businesses row INSIDE
      -- the statement, never passed in: a value resolved by an earlier read is
      -- a value that can have changed by now.
      AND cs.keyword = b.tracked_keywords->>0
      AND cs.search_location IS NOT DISTINCT FROM (
        CASE
          WHEN b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL
            THEN b.google_place_lat::text || ',' || b.google_place_lng::text
          ELSE b.ranking_search_location
        END
      )
      AND cs.is_self = false
      -- btrim, not <> '': the picker options and the digest both reject
      -- whitespace-only titles via trim(), and a bare <> '' would let a direct
      -- API request store a rival the digest can never name.
      AND btrim(cs.title) <> ''
      -- LOAD-BEARING: the latest date is computed in the same statement, not
      -- supplied. Passing in a date resolved earlier in the request reopens
      -- exactly the window this statement exists to close — the worker can
      -- commit a NEW date's pack in between, the old date's rows remain
      -- persisted, and we would happily store a rival absent from the
      -- now-latest pack.
      --
      -- The subquery is scoped by search location as well as keyword, matching
      -- the NULL-safe comparison above: a location whose effective search
      -- location changed keeps the old lane's rows, and an unscoped MAX() would
      -- return a date belonging to a DIFFERENT lane's pack than the one both
      -- read paths derive their window from.
      AND cs.snapshot_date = (
        SELECT MAX(cs2.snapshot_date)
        FROM competitor_snapshots cs2
        WHERE cs2.business_id = b.id
          AND cs2.keyword = cs.keyword
          AND cs2.search_location IS NOT DISTINCT FROM cs.search_location
      )
      -- A (hypothetical) duplicate place_id in one pack must not make the
      -- stored title arbitrary: pin one row deterministically.
      AND cs.id = (
        SELECT cs3.id
        FROM competitor_snapshots cs3
        WHERE cs3.business_id = cs.business_id
          AND cs3.keyword = cs.keyword
          AND cs3.search_location IS NOT DISTINCT FROM cs.search_location
          AND cs3.snapshot_date = cs.snapshot_date
          AND cs3.place_id = cs.place_id
        ORDER BY cs3.rank_position ASC NULLS LAST, cs3.id ASC
        LIMIT 1
      )
    RETURNING b.rival_picked_at
  `;
  // Zero rows == the place_id is not a pickable rival in the latest committed
  // pack — whether it never was, or a pack replacement just landed. It is also
  // what a foreign location returns, so ownership is disambiguated separately.
  if (!updated) {
    await assertLocationOwned(tx, { accountId, businessId });
    throw new RivalPickStaleError(placeId);
  }
  return updated.rival_picked_at;
}

/** Clears the pick. Resolves to `null` when there was nothing to clear. */
async function clearRivalPick(
  tx: TransactionSql,
  { accountId, businessId }: RivalPickerScope,
): Promise<Date | null> {
  const [cleared] = await tx<{ cleared_at: Date }[]>`
    UPDATE businesses
    SET rival_place_id = NULL, rival_title_snapshot = NULL, rival_picked_at = NULL
    WHERE id = ${businessId} AND account_id = ${accountId}
      -- Without this, a retried clear matches the already-cleared row and
      -- returns a fresh NOW(), minting a second event key that slips past the
      -- ON CONFLICT dedupe.
      AND rival_place_id IS NOT NULL
    RETURNING NOW() AS cleared_at
  `;
  if (cleared) return cleared.cleared_at;

  // Zero rows is either "already cleared" (benign) or "not your location".
  await assertLocationOwned(tx, { accountId, businessId });
  return null;
}

/**
 * Distinguishes a zero-row write caused by a failed predicate from one caused
 * by the location belonging to another account. Only ever runs on the failure
 * path, where the write has already been declined.
 */
async function assertLocationOwned(
  tx: TransactionSql,
  { accountId, businessId }: RivalPickerScope,
): Promise<void> {
  const [owned] = await tx<{ id: string }[]>`
    SELECT id FROM businesses
    WHERE id = ${businessId} AND account_id = ${accountId}
  `;
  if (!owned) throw new RivalPickNotFoundError(businessId);
}

/** Internal seam exposed for unit tests only — not part of the module's interface. */
export const __testing = { selectAutoDefaultRival, selectNamedRival, parseCompetitorRating };
