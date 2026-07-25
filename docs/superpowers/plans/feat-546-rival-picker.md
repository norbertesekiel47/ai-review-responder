# Rival Picker (#546) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner pick the **Named rival** per location from that location's latest persisted **Competitor pack**, and have the **Competitor Delta line** honor the pick — including the dropout note and **Auto-default rival** fallback while the pick is absent.

**Architecture:** A new deep module `src/lib/competitors/named-rival.ts` becomes the single owner of competitor-lane resolution (primary tracked keyword + search location, latest pack load, Auto-default selection, pick honoring, pick writes). Its interface is three functions; everything else — DATE/NUMERIC parsing, the two-snapshot window, dropout derivation, pack-membership validation — is hidden behind them. Two composition roots consume it: `worker/jobs/WeeklySummaryWorker.ts` (which gets ~110 lines lighter) and a new owner-scoped route `src/app/api/settings/competitors/route.ts`. Storage is three additive nullable columns on `businesses`, following the migration-014 precedent for per-location ranking config.

**Tech Stack:** Postgres.js (`Sql` passed as an explicit parameter — invariant #15), Next.js 16 App Router server components + route handlers, Vitest, PostHog via the durable `analytics_events` lane.

**Intake contract:** `.feature/intake.json` (arming copy) / `docs/superpowers/plans/feat-546-rival-picker-intake.json` (audit copy). Every task stays inside `allowed_edit_surface`; the edit-surface guard hook enforces it.

**Glossary (CONTEXT.md — use verbatim, never paraphrase):**
- **Competitor Delta line** — the per-location weekly Insights digest line reporting the Named rival's review velocity since the most recent preceding matching snapshot and the review-count gap.
- **Named rival** — the single local-pack competitor the Competitor Delta line reports on: the owner's pick where one exists, otherwise the Auto-default rival.
- **Auto-default rival** — the deterministic stand-in Named rival before any owner pick (nearest-ahead-by-reviews; nearest tied-or-behind when none is ahead). Digest copy labels it `Auto-selected rival`.
- **Competitor pack** — the full ~20-entry `local_results` set persisted as `competitor_snapshots` rows per (business, keyword, search_location, snapshot_date).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/089_competitor_rival_pick.sql` *(create)* | Three additive nullable columns on `businesses` holding the pick. |
| `.claude/reference/migrations-log.md` *(modify)* | Head 088 → 089 + log entry. |
| `src/lib/competitors/named-rival.ts` *(create)* | **The deep module.** Owns competitor-lane context resolution, pack loading, Auto-default selection, pick honoring + dropout derivation, and pick writes. Owns the `CompetitorDelta` type. |
| `src/lib/competitors/__tests__/named-rival.test.ts` *(create)* | Pure-function tests over the module's internal selection seam + the exported resolution shape. |
| `worker/jobs/WeeklySummaryWorker.ts` *(modify)* | Composition root: calls `resolveNamedRival`, logs `competitor_delta_resolved`. Loses `selectAutoDefaultRival` / `loadCompetitorDelta` / `parseCompetitorRating` and their row interfaces. |
| `src/lib/notifications/email/templates/weekly-value-report.ts` *(modify)* | Renders the four Competitor Delta variants. Imports `CompetitorDelta` from the module. |
| `src/app/api/settings/competitors/route.ts` *(create)* | Owner-scoped GET (picker view) + PUT (set/clear). Parses, delegates to one module function, maps typed errors to status codes. |
| `src/app/api/settings/competitors/__tests__/route.test.ts` *(create)* | Tenant isolation, 409 pack_refreshed, is_self rejection, client-title rejection, analytics on set/clear. |
| `src/app/(authenticated)/settings/competitors/page.tsx` *(create)* | Server component: `requireOwnerAccess` → active locations → `loadRivalPickerView` per location → client component. |
| `src/app/(authenticated)/settings/competitors/CompetitorsClient.tsx` *(create)* | Client component: dropdown per location, three empty states, PUT on change. |
| `src/app/(authenticated)/settings/competitors/__tests__/CompetitorsClient.test.tsx` *(create)* | Option filtering/ordering, absent-pick entry, empty states. |
| `src/components/dashboard/settings/SettingsSidebar.tsx` *(modify)* | New `Competitors` nav item in the `Responses` group. |
| `src/lib/analytics/events.ts` *(modify)* | Register `competitor_rival_picked` in `ANALYTICS_EVENT_NAMES` (NOT in `CLIENT_ENQUEUEABLE_EVENT_NAMES`). |
| `docs/analytics/events.md` *(modify)* | Documentation block for the new event — `ci:analytics-events` fails without it. |
| `CONTEXT.md` *(modify)* | Sharpen the Named rival glossary entry with the shipped pick/dropout mechanics. |

**Module interface (the whole surface callers must learn):**

```ts
export type CompetitorDelta =
  | { kind: 'teaser'; keyword: string }
  | { kind: 'rival'; line: NamedRivalLine }
  | { kind: 'dropout'; droppedName: string; fallback: NamedRivalLine | null }
  | null;

export interface NamedRivalLine {
  rivalName: string;
  gap: number;
  reviewVelocity: number | null;
  source: 'owner_pick' | 'auto_default';
}

export async function resolveNamedRival(db: Sql, businessId: LocationId): Promise<CompetitorDelta>;
export async function loadRivalPickerView(db: Sql, input: { accountId: string; businessId: LocationId }): Promise<RivalPickerView>;
export async function setNamedRivalPick(db: Sql, input: { accountId: string; businessId: LocationId; placeId: string | null; userId: string }): Promise<RivalPickerView>;
```

Everything else — `resolveCompetitorContext`, `loadPackRows`, `selectAutoDefaultRival`, `selectNamedRival`, `parseCompetitorRating` — stays module-private. Tests reach the pure selection functions through a `__testing` export rather than widening the public interface.

---

## Task 1: Migration 089 — pick columns on `businesses`

**Blocking edges:** none (can run in parallel with Task 2).

**Files:**
- Create: `supabase/migrations/089_competitor_rival_pick.sql`
- Modify: `.claude/reference/migrations-log.md`

- [ ] **Step 1: Invoke the `new-migration` skill**

Invoke the Skill tool with `skill: "new-migration"` and follow it before writing any SQL. Confirm from `.claude/reference/migrations-log.md` that the current head is **088** and the next number is **089**. If the head has moved, use the real next number and adjust every path in this task.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/089_competitor_rival_pick.sql`:

```sql
-- 089_competitor_rival_pick.sql
-- Owner-picked Named rival for the Competitor Delta line (#546, wayfinder map
-- #528; semantics locked in #532 item 2).
--
-- Shape: three additive nullable columns on businesses, following the
-- migration-014 precedent that all per-location ranking/competitor config
-- (tracked_keywords, ranking_search_location, google_place_lat/lng) lives here.
-- A location has at most one pick, so a 1:1 column set beats a side table —
-- and the digest's existing businesses SELECT picks these up for free, costing
-- the WeeklySummaryWorker read path zero extra queries.
--
-- rival_place_id is the canonical ChIJ… Place ID of the picked competitor. It
-- is deliberately NOT a foreign key to competitor_snapshots: packs are replaced
-- wholesale on every ranking run (084's replace-pack idempotency), so an FK
-- would cascade-delete a pick the owner explicitly made. Pack membership is a
-- READ-side question, answered per-digest by resolveNamedRival.
--
-- rival_title_snapshot is the display name captured AT PICK TIME, server-derived
-- from the matched pack row (never client-supplied — it reaches a rendered
-- email). It is read only for the dropout note and the settings UI's
-- absent-pick entry; a rival present in the pack always renders its LIVE title.
--
-- The COLUMN additions are additive: no backfill, no default, existing rows
-- keep NULL and behave exactly as today (Auto-default rival). The CHECK
-- constraint below is NOT additive in the same sense — it is dropped and
-- re-added, which takes a brief ACCESS EXCLUSIVE lock on analytics_events and
-- re-validates every existing row. The end state is idempotent on re-run, but
-- the execution is not a no-op; hence the lock_timeout above.
-- Rollback: revert the deploy (the columns go unread and the constraint is a
-- superset of the old one, so both are safe to leave in place).
--
-- RLS: businesses' existing policies cover these columns unchanged. All writes
-- come from the owner-scoped Next.js route over the direct Postgres connection.

SET lock_timeout = '5s';

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS rival_place_id TEXT,
  ADD COLUMN IF NOT EXISTS rival_title_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS rival_picked_at TIMESTAMPTZ;

COMMENT ON COLUMN businesses.rival_place_id IS
  'Owner-picked Named rival Place ID for the Competitor Delta line (#546). NULL = use the Auto-default rival.';
COMMENT ON COLUMN businesses.rival_title_snapshot IS
  'Display name captured at pick time, server-derived from the pack row. Read only for the dropout note and the absent-pick UI entry.';
COMMENT ON COLUMN businesses.rival_picked_at IS
  'When the owner made the current pick. NULL when no pick is set.';

-- analytics_events.event_name is a DB-level CHECK allowlist (046, last extended
-- by 069). Registering the event in ANALYTICS_EVENT_NAMES is NOT enough: without
-- this, every pick transaction ROLLS BACK on the constraint, and
-- `ci:analytics-events` would not catch it (it only compares the TS allowlist
-- against docs/analytics/events.md, never the database).
ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_event_name_check;

ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_event_name_check
  CHECK (
    event_name IN (
      'signup_started',
      'email_verified',
      'sample_demo_started',
      'sample_demo_to_signup',
      'gbp_connect_started',
      'gbp_connect_failed',
      'gbp_connected',
      'first_review_ingested',
      'first_response_drafted',
      'activation_completed',
      'offboarding_started',
      'offboarding_reactivated',
      'offboarding_teardown_completed',
      'offboarding_purged',
      'trial_started',
      'trial_converted',
      'trial_payment_failed',
      'trial_cancelled',
      'competitor_rival_picked'
    )
  );
```

The list above is 069's list plus one name. Before writing it, re-read `supabase/migrations/069_trial_subscription.sql` and confirm no migration between 069 and 088 extended the constraint again — if one did, start from THAT list. Dropping a name silently breaks an existing event lane.

- [ ] **Step 3: Write the migration guard test**

This repo asserts migration contents in `src/lib/shared/__tests__/migration-0NN-*.test.ts` — read `migration-069-trial-subscription.test.ts` first and mirror it exactly. Create `src/lib/shared/__tests__/migration-089-competitor-rival-pick.test.ts` asserting: the three `ADD COLUMN IF NOT EXISTS` clauses are present; the `analytics_events_event_name_check` constraint is dropped and re-added; and — the point of the test — that **every name in `ANALYTICS_EVENT_NAMES` appears in the re-added CHECK list**, imported from `src/lib/analytics/events.ts` rather than hardcoded. That last assertion is what makes a future dropped name fail CI instead of production.

**You must also narrow the 069 test in the same commit.** `migration-069-trial-subscription.test.ts:44-49` currently holds the repo's only "effective CHECK list ≡ `ANALYTICS_EVENT_NAMES`" drift-guard, asserting `namesInCheck).toEqual([...ANALYTICS_EVENT_NAMES].sort()`. Registering ANY new event name breaks it — 069's SQL is immutable, so its list can never grow again. Change that test to assert only 069's own historical list (the 18 names it actually added, as a literal), and leave the live-equality assertion to 089's new test, which is now the latest constraint-extending migration.

This is a landmine, not a one-off: whichever migration test holds the live-equality assertion breaks the next time an event is added. Note it in the deviations file for promotion to `.claude/reference/lab-notes.md` at step 8 — the durable fix is to move that assertion out of per-migration tests into a single test that reads the latest constraint-extending migration, but that is out of this ticket's scope.

Run: `cd <worktree> && pnpm vitest run src/lib/shared/__tests__/migration-089-competitor-rival-pick.test.ts src/lib/shared/__tests__/migration-069-trial-subscription.test.ts`
Expected: both PASS.

Re-running this migration must be a no-op. Do NOT apply it to any database in this task — application is step 8 of the feature workflow (staging first, prod at promotion).

- [ ] **Step 4: Update the migrations log**

Modify `.claude/reference/migrations-log.md`: change the head line from `Current head: **088** — next migration is **089**` to `Current head: **089** — next migration is **090**`, and add a log entry for 089 in the same format as the 084/085/088 entries, recording: three nullable columns on `businesses` (additive, no backfill); **plus a DROP/ADD of `analytics_events_event_name_check`, which takes a brief ACCESS EXCLUSIVE lock and re-validates the table — do NOT describe 089 as "additive-only"**; no FK to `competitor_snapshots` and why (replace-pack would cascade-delete owner picks); staging-first lockstep application pending at promotion.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/089_competitor_rival_pick.sql .claude/reference/migrations-log.md \
        src/lib/shared/__tests__/migration-089-competitor-rival-pick.test.ts \
        src/lib/shared/__tests__/migration-069-trial-subscription.test.ts
git commit -m "feat(competitors): migration 089 — owner-picked Named rival columns (#546)"
```

---

## Task 2: Extract `named-rival.ts` — behavior-neutral

**Blocking edges:** none (parallel with Task 1).

This task must change NO behavior. It moves the existing Competitor Delta resolution out of `WeeklySummaryWorker.ts` into the new module verbatim. The existing `worker/jobs/__tests__/WeeklySummaryWorker.test.ts` competitor cases must pass **unmodified** — that is the proof the extraction was neutral. Do not add the pick, the dropout, or the source discriminator here; those are Task 3.

**Files:**
- Create: `src/lib/competitors/named-rival.ts`
- Create: `src/lib/competitors/__tests__/named-rival.test.ts`
- Modify: `worker/jobs/WeeklySummaryWorker.ts` (remove lines currently at ~55-77 interfaces and ~234-350 functions; rewire the one call site at ~222)
- Modify: `src/lib/notifications/email/templates/weekly-value-report.ts` (import the type instead of declaring it)

- [ ] **Step 1: Write the failing test**

Create `src/lib/competitors/__tests__/named-rival.test.ts`. These tests exercise the pure selection seam directly — no database:

```ts
import { describe, expect, it } from 'vitest';
import { __testing } from '../named-rival';

const { selectAutoDefaultRival, parseCompetitorRating } = __testing;

/** Minimal pack row factory — every field the selector reads, nothing else. */
function packRow(overrides: Partial<Parameters<typeof selectAutoDefaultRival>[0][number]> = {}) {
  return {
    snapshot_date: '2026-07-20',
    rank_position: 1,
    place_id: 'ChIJ_rival_a',
    title: 'Joe’s Bakery',
    rating: 4.7,
    review_count: 400,
    is_self: false,
    ...overrides,
  };
}

describe('selectAutoDefaultRival', () => {
  it('computes the gap from review counts only, ignoring rating and rank', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100, rating: 5.0, rank_position: 9 }),
      packRow({ place_id: 'ChIJ_rival_a', review_count: 127, rating: 2.1, rank_position: 20 }),
    ];

    const result = selectAutoDefaultRival(rows, '2026-07-20', undefined);

    expect(result).toEqual({
      rivalName: 'Joe’s Bakery',
      gap: 27,
      reviewVelocity: null,
      source: 'auto_default',
    });
  });

  it('picks the smallest positive gap when rivals are ahead', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_far', title: 'Far Ahead', review_count: 500, rank_position: 1 }),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110, rank_position: 8 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toMatchObject({
      rivalName: 'Near Ahead',
      gap: 10,
    });
  });

  it('breaks ties by rank position with NULL rank last, then place id', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_b', title: 'Null Rank', review_count: 150, rank_position: null }),
      packRow({ place_id: 'ChIJ_a', title: 'Ranked', review_count: 150, rank_position: 4 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toMatchObject({ rivalName: 'Ranked' });
  });

  it('returns null when no pack row is our own business', () => {
    const rows = [packRow({ review_count: 400 })];
    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toBeNull();
  });

  it('excludes rivals with a NULL review count from selection', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_unrated', review_count: null }),
    ];
    expect(selectAutoDefaultRival(rows, '2026-07-20', undefined)).toBeNull();
  });

  it('reports velocity against the preceding snapshot for the same place id', () => {
    const rows = [
      packRow({ place_id: 'ChIJ_self', is_self: true, review_count: 100 }),
      packRow({ place_id: 'ChIJ_rival_a', review_count: 127 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_rival_a', review_count: 123 }),
    ];

    expect(selectAutoDefaultRival(rows, '2026-07-20', '2026-07-06')).toMatchObject({
      gap: 27,
      reviewVelocity: 4,
    });
  });
});

describe('parseCompetitorRating', () => {
  it('parses the NUMERIC rating string from Postgres.js rather than comparing it as a string', () => {
    expect(parseCompetitorRating('4.8')).toBe(4.8);
    expect(parseCompetitorRating(null)).toBeNull();
    expect(parseCompetitorRating('   ')).toBeNull();
    expect(parseCompetitorRating('not-a-number')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd <worktree> && pnpm vitest run src/lib/competitors/__tests__/named-rival.test.ts`
Expected: FAIL — `Failed to resolve import "../named-rival"`.

- [ ] **Step 3: Create the module by moving code verbatim**

Create `src/lib/competitors/named-rival.ts`. Move `CompetitorSnapshotRow`, `NormalizedCompetitorSnapshotRow`, `CompetitorDeltaSettingsRow`, `parseCompetitorRating`, `selectAutoDefaultRival`, and `loadCompetitorDelta` out of `worker/jobs/WeeklySummaryWorker.ts` **without changing a line of their bodies**. Rename `loadCompetitorDelta` to `resolveNamedRival` (the glossary term) and move the `CompetitorDelta` type here from the email template:

```ts
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
// NOTE: `LocationId` is the branded id type already used by WeeklySummaryWorker's
// call site. The route receives a plain `string` from Zod — read
// `src/lib/shared/ids.ts` and use whatever narrowing helper it already exports to
// cross that seam. Do NOT `as LocationId` your way past it, and do NOT widen the
// module's parameter to `string` just to avoid the brand.

// The FINAL shape lands here in Task 2, even though `source` is always
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

interface CompetitorContextRow {
  keyword: string | null;
  search_location: string | null;
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
```

Then paste `parseCompetitorRating` and `selectAutoDefaultRival` from `WeeklySummaryWorker.ts`, changing ONLY their return shape: `selectAutoDefaultRival` now returns `NamedRivalLine | null` (the bare line with `source: 'auto_default'`) instead of a `CompetitorDelta`, and `resolveNamedRival` wraps it as `{ kind: 'rival', line }`. The selection LOGIC — the self lookup, the candidate filter, the ahead/behind split, the tie ordering, the velocity lookup — moves character for character.

Move `loadCompetitorDelta` in renamed as `resolveNamedRival(db: Sql, businessId: LocationId): Promise<CompetitorDelta>`, and **collapse its three sequential reads into ONE statement**.

Why this is not optional: RankingTrackingWorker replaces the pack wholesale (084 replace-pack) and its `ranking_snapshots` upsert OVERWRITES `search_location` on a same-day re-run. Today's three separate statements can therefore observe a pack that does not correspond to the dates just read — a torn read that, once the dropout note lands in Task 3, surfaces to the owner as a phantom "dropped out of your local pack."

Do **not** try to fix this by wrapping the three statements in `db.begin()`. Postgres defaults to READ COMMITTED, which takes a **fresh snapshot per statement** — a plain transaction changes nothing here. The options are an explicit `REPEATABLE READ` transaction or a single statement; take the single statement, since it also halves the round trips and cannot raise a serialization failure the caller would have to retry.

Write it as one query with CTEs, shaped exactly like this:

```sql
WITH ctx AS (
  SELECT
    b.tracked_keywords->>0 AS keyword,
    CASE
      WHEN b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL
        THEN b.google_place_lat::text || ',' || b.google_place_lng::text
      ELSE b.ranking_search_location
    END AS search_location,
    b.rival_place_id,          -- Task 3 onward
    b.rival_title_snapshot     -- Task 3 onward
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
  d.snapshot_date::text AS window_date,     -- NULL when no snapshot exists at all
  cs.snapshot_date::text AS snapshot_date,  -- NULL for a date whose pack is empty
  cs.rank_position, cs.place_id, cs.title, cs.rating, cs.review_count, cs.is_self
FROM ctx
LEFT JOIN dates d ON true
LEFT JOIN competitor_snapshots cs
  ON cs.business_id = ${businessId}
 AND cs.keyword = ctx.keyword
 AND cs.search_location IS NOT DISTINCT FROM ctx.search_location
 AND cs.snapshot_date = d.snapshot_date
ORDER BY d.snapshot_date DESC, cs.rank_position ASC NULLS LAST, cs.place_id ASC NULLS LAST
```

Both `LEFT JOIN`s are load-bearing, for different reasons:
- `LEFT JOIN dates` keeps the `ctx` row alive when the location has no `ranking_snapshots` at all, so the caller can still distinguish **never configured** (`keyword` NULL) from **configured, awaiting first pack** (`keyword` set, `window_date` NULL). A plain join collapses both to an empty result.
- `LEFT JOIN competitor_snapshots` keeps a date alive when its pack was persisted empty — 084 treats that as a recorded fact, and it is the exact input the `currentRows.length === 0` dropout guard in Task 3 needs to see.

**Result contract (specify it in a comment above the mapper, it is not obvious):** take the distinct non-null `window_date` values, DESC, as `snapshotDates`. Take the rows where `snapshot_date IS NOT NULL` as the pack rows; a row with a non-null `window_date` but a null `snapshot_date` is the empty-pack sentinel and is **discarded** from the pack rows while its date is **kept** in `snapshotDates`. Everything downstream — `parseCompetitorRating`, `selectAutoDefaultRival`, `selectNamedRival` — then receives exactly the inputs it receives today.

Keep `snapshot_date::text` and the `tracked_keywords->>0` / lat-lng-or-`ranking_search_location` CASE exactly as they are today — the `::text` in particular is the #570 DATE-vs-string bug fix and must not be lost in the rewrite. The row-mapping and every selection function below stay verbatim; only the fetch shape changes.

This torn read already exists in the shipped #539 code; it becomes owner-visible once the dropout note lands, so it is fixed here rather than left for the ticket that adds the note.

Export the pure seam for tests without widening the public interface:

```ts
/** Internal seam exposed for unit tests only — not part of the module's interface. */
export const __testing = { selectAutoDefaultRival, parseCompetitorRating };
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd <worktree> && pnpm vitest run src/lib/competitors/__tests__/named-rival.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Rewire the worker and the email template**

In `worker/jobs/WeeklySummaryWorker.ts`:
- Delete `CompetitorDeltaSettingsRow`, `CompetitorSnapshotRow`, `NormalizedCompetitorSnapshotRow`, `parseCompetitorRating`, `selectAutoDefaultRival`, `loadCompetitorDelta`.
- Replace the `CompetitorDelta` import from `'../../src/lib/notifications/email'` with `import { resolveNamedRival, type CompetitorDelta } from '../../src/lib/competitors/named-rival';` (keep `buildWeeklyValueReportHtml` importing from the email barrel).
- Change the call site from `await loadCompetitorDelta(db, businessId)` to `await resolveNamedRival(db, businessId)`.

In `src/lib/notifications/email/templates/weekly-value-report.ts`:
- Delete the local `CompetitorDelta` type declaration.
- Add `import type { CompetitorDelta } from '@/lib/competitors/named-rival';` and `export type { CompetitorDelta };` so the `src/lib/notifications/email.ts` barrel (`export * from './email/templates/weekly-value-report'`) keeps re-exporting it for existing consumers.
- In `renderCompetitorDeltaHtml`, make the ONLY change the nested access: `competitorDelta.rivalName` → `competitorDelta.line.rivalName`, and likewise for `gap` / `reviewVelocity`. The emitted HTML string must be byte-identical, including the `Auto-selected rival: ` prefix (the `source` discriminator is not read until Task 3). Add a `dropout` branch that is unreachable in this task only if TypeScript's exhaustiveness check demands it — if so, have it `throw new Error('unreachable: dropout lands in #546 Task 3')` rather than rendering placeholder copy.

- [ ] **Step 6: Prove the extraction was behavior-neutral**

Run: `cd <worktree> && pnpm vitest run worker/jobs/__tests__/WeeklySummaryWorker.test.ts src/lib/notifications/__tests__/email-templates.test.ts`

The `CompetitorDelta` shape changed, so these test files DO need edits — but only where they construct a `competitorDelta` fixture (`{kind:'rival', rivalName, gap, reviewVelocity}` → `{kind:'rival', line:{rivalName, gap, reviewVelocity, source:'auto_default'}}`). **Every assertion about rendered HTML must stay byte-identical.** That is the neutrality proof for this task: if you find yourself changing an expected output string, the move was not verbatim — revert and redo it rather than adjusting the expectation.

Run: `cd <worktree> && pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/competitors worker/jobs/WeeklySummaryWorker.ts src/lib/notifications/email/templates/weekly-value-report.ts
git commit -m "refactor(competitors): extract named-rival module from WeeklySummaryWorker (#546)"
```

---

## Task 3: Honor the pick — source discriminator, dropout, worker log

**Blocking edges:** Task 1 (columns must exist), Task 2 (module must exist).

**Files:**
- Modify: `src/lib/competitors/named-rival.ts`
- Modify: `src/lib/competitors/__tests__/named-rival.test.ts`
- Modify: `src/lib/notifications/email/templates/weekly-value-report.ts`
- Modify: `src/lib/notifications/__tests__/email-templates.test.ts`
- Modify: `worker/jobs/WeeklySummaryWorker.ts`
- Modify: `worker/jobs/__tests__/WeeklySummaryWorker.test.ts`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Write the failing tests for the resolution branches**

Append to `src/lib/competitors/__tests__/named-rival.test.ts`. `selectNamedRival` is the new pure function; it takes the normalized rows, the two snapshot dates, and the stored pick:

```ts
const { selectNamedRival } = __testing;

const SELF = { place_id: 'ChIJ_self', is_self: true, review_count: 100 };

describe('selectNamedRival', () => {
  it('returns the owner pick as the Named rival when the picked place_id is in the latest pack', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110, rank_position: 8 }),
      packRow({ place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 180, rank_position: 3 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_picked',
      titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toEqual({
      kind: 'rival',
      line: { rivalName: 'Old Mill Bakery', gap: 80, reviewVelocity: null, source: 'owner_pick' },
    });
  });

  it('uses the live pack title, not the stored snapshot, when the picked rival was renamed', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_picked', title: 'Old Mill Bakehouse', review_count: 180 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_picked',
      titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toMatchObject({ line: { rivalName: 'Old Mill Bakehouse' } });
  });

  it('renders the dropout note then the Auto-default line when the pick left the pack after the preceding snapshot', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 175 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 108 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_picked',
      titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toEqual({
      kind: 'dropout',
      droppedName: 'Old Mill Bakery',
      fallback: { rivalName: 'Near Ahead', gap: 10, reviewVelocity: 2, source: 'auto_default' },
    });
  });

  it('renders the Auto-default line with no dropout note when the pick is absent from both snapshots', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 108 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_gone', titleSnapshot: 'Vanished Cafe',
    });

    expect(result).toEqual({
      kind: 'rival',
      line: { rivalName: 'Near Ahead', gap: 10, reviewVelocity: 2, source: 'auto_default' },
    });
  });

  it('renders the Auto-default line with no dropout note when only one snapshot date exists', () => {
    const rows = [packRow(SELF), packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 })];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_gone', titleSnapshot: 'Vanished Cafe',
    });

    expect(result).toMatchObject({ kind: 'rival', line: { source: 'auto_default' } });
  });

  it('falls back to the Auto-default rival when the picked rival has a NULL review count', () => {
    const rows = [
      packRow(SELF),
      packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 }),
      packRow({ place_id: 'ChIJ_picked', title: 'Unrated Rival', review_count: null }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', undefined, {
      placeId: 'ChIJ_picked', titleSnapshot: 'Unrated Rival',
    });

    expect(result).toMatchObject({ kind: 'rival', line: { rivalName: 'Near Ahead', source: 'auto_default' } });
  });

  it('labels the Auto-default rival source when there is no pick at all', () => {
    const rows = [packRow(SELF), packRow({ place_id: 'ChIJ_near', title: 'Near Ahead', review_count: 110 })];
    expect(selectNamedRival(rows, '2026-07-20', undefined, null)).toMatchObject({
      kind: 'rival', line: { source: 'auto_default' },
    });
  });

  it('emits no dropout note when the latest pack was persisted empty', () => {
    // Our own is_self row is missing for the current date — a recorded empty
    // pack (084). Every place_id looks "absent"; claiming the pick dropped out
    // would be a false alarm with no fallback line to soften it.
    const rows = [
      packRow({ snapshot_date: '2026-07-06', ...SELF, review_count: 96 }),
      packRow({ snapshot_date: '2026-07-06', place_id: 'ChIJ_picked', title: 'Old Mill Bakery', review_count: 175 }),
    ];

    const result = selectNamedRival(rows, '2026-07-20', '2026-07-06', {
      placeId: 'ChIJ_picked', titleSnapshot: 'Old Mill Bakery',
    });

    expect(result).toBeNull();
  });
});
```

Note the NULL-review-count pick case resolves to the Auto-default line, **not** a dropout note: the pick IS in the pack, it just has no countable reviews, so nothing "dropped out."

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <worktree> && pnpm vitest run src/lib/competitors/__tests__/named-rival.test.ts`
Expected: FAIL — `selectNamedRival is not a function`.

- [ ] **Step 3: Implement `selectNamedRival`**

The `CompetitorDelta` / `NamedRivalLine` types already landed in Task 2. Add only the pick type:

```ts
export interface StoredRivalPick {
  placeId: string;
  titleSnapshot: string;
}
```

Then add the new pure function:

```ts
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

function selectNamedRival(
  rows: NormalizedCompetitorSnapshotRow[],
  currentDate: string,
  precedingDate: string | undefined,
  pick: StoredRivalPick | null,
): CompetitorDelta {
  const autoDefault = selectAutoDefaultRival(rows, currentDate, precedingDate);
  if (!pick) return autoDefault ? { kind: 'rival', line: autoDefault } : null;

  const currentRows = rows.filter((row) => row.snapshot_date === currentDate);
  const self = currentRows.find((row) => row.is_self && Number.isInteger(row.review_count));

  const pickedRow = currentRows.find(
    (row) => row.place_id === pick.placeId && !row.is_self && Number.isInteger(row.review_count),
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
  // Present-but-unusable (NULL review count) is not a dropout: nothing left.
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
```

`resolveNamedRival` already selects `rival_place_id` and `rival_title_snapshot` in its `ctx` CTE (Task 2 included them). Do **not** add a second `await db` query for the pick — that would reintroduce the torn read Task 2 just closed. Add the two fields to the row type and derive the pick from the CTE columns:

```ts
  const pick: StoredRivalPick | null = context?.rival_place_id
    ? { placeId: context.rival_place_id, titleSnapshot: context.rival_title_snapshot ?? context.rival_place_id }
    : null;
```

Replace the final `selectAutoDefaultRival(...)` call with `selectNamedRival(normalizedRows, snapshotDates[0]!, snapshotDates[1], pick)`, keeping the `?? { kind: 'teaser', keyword }` fallback. Add `selectNamedRival` to the `__testing` export.

- [ ] **Step 4: Run the module tests to verify they pass**

Run: `cd <worktree> && pnpm vitest run src/lib/competitors/__tests__/named-rival.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Write the failing template tests**

Add to `src/lib/notifications/__tests__/email-templates.test.ts` (follow the file's existing `buildWeeklyValueReportHtml` test style and its existing params factory):

```ts
  it('labels the Auto-default rival "Auto-selected rival:" and omits the prefix for an owner pick', () => {
    const autoHtml = buildWeeklyValueReportHtml(weeklyParams({
      competitorDelta: {
        kind: 'rival',
        line: { rivalName: 'Joe’s Bakery', gap: 27, reviewVelocity: 4, source: 'auto_default' },
      },
    }));
    expect(autoHtml).toContain('Auto-selected rival: Joe&rsquo;s Bakery gained 4 reviews since our last check; gap now 27');

    const pickHtml = buildWeeklyValueReportHtml(weeklyParams({
      competitorDelta: {
        kind: 'rival',
        line: { rivalName: 'Joe’s Bakery', gap: 27, reviewVelocity: 4, source: 'owner_pick' },
      },
    }));
    expect(pickHtml).toContain('Joe&rsquo;s Bakery gained 4 reviews since our last check; gap now 27');
    expect(pickHtml).not.toContain('Auto-selected rival:');
  });

  it('renders the dropout note above the Auto-default line', () => {
    const html = buildWeeklyValueReportHtml(weeklyParams({
      competitorDelta: {
        kind: 'dropout',
        droppedName: 'Old Mill Bakery',
        fallback: { rivalName: 'Near Ahead', gap: 10, reviewVelocity: 2, source: 'auto_default' },
      },
    }));

    expect(html).toContain('Old Mill Bakery dropped out of your local pack.');
    expect(html).toContain('Auto-selected rival: Near Ahead gained 2 reviews since our last check; gap now 10');
    expect(html.indexOf('dropped out of your local pack')).toBeLessThan(html.indexOf('Auto-selected rival:'));
  });

  it('renders the dropout note alone when no Auto-default rival is available', () => {
    const html = buildWeeklyValueReportHtml(weeklyParams({
      competitorDelta: { kind: 'dropout', droppedName: 'Old Mill Bakery', fallback: null },
    }));

    expect(html).toContain('Old Mill Bakery dropped out of your local pack.');
    expect(html).not.toContain('Auto-selected rival:');
  });
```

Escape check: the existing template calls `escapeHtml` on the rival name, and the codebase's `escapeHtml` renders `’` as `&rsquo;` — confirm against the existing competitor-delta assertions in this file and match whatever escaping they already expect rather than assuming.

Update any existing competitor-delta assertions in this file to the new nested `line` shape.

- [ ] **Step 6: Run the template tests to verify they fail**

Run: `cd <worktree> && pnpm vitest run src/lib/notifications/__tests__/email-templates.test.ts`
Expected: FAIL — type error on the nested shape and missing dropout copy.

- [ ] **Step 7: Implement the template rendering**

In `src/lib/notifications/email/templates/weekly-value-report.ts`, split the renderer so each variant is total. Keep the existing velocity-copy logic verbatim — only the prefix and the wrapping change:

```ts
function renderRivalLineHtml(line: NamedRivalLine): string {
  let velocityCopy = '';
  if (line.reviewVelocity !== null) {
    if (line.reviewVelocity > 0) {
      const reviewLabel = line.reviewVelocity === 1 ? 'review' : 'reviews';
      velocityCopy = ` gained ${line.reviewVelocity} ${reviewLabel} since our last check;`;
    } else if (line.reviewVelocity < 0) {
      const lost = Math.abs(line.reviewVelocity);
      const reviewLabel = lost === 1 ? 'review' : 'reviews';
      velocityCopy = ` lost ${lost} ${reviewLabel} since our last check;`;
    } else {
      velocityCopy = ' had no new reviews since our last check;';
    }
  }

  // The Auto-default rival is always disclosed as algorithmic; an owner's own
  // pick is never presented as auto-selected (CONTEXT.md, Auto-default rival).
  const prefix = line.source === 'auto_default' ? 'Auto-selected rival: ' : '';

  return `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">${prefix}${escapeHtml(line.rivalName)}${velocityCopy} gap now ${line.gap}</p>
    </td></tr>`;
}

function renderCompetitorDeltaHtml(competitorDelta: CompetitorDelta): string {
  if (!competitorDelta) return '';

  if (competitorDelta.kind === 'teaser') {
    return `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">RepWorth is watching &lsquo;${escapeHtml(competitorDelta.keyword)}&rsquo; and will report Competitor Delta after our next check.</p>
    </td></tr>`;
  }

  if (competitorDelta.kind === 'dropout') {
    const note = `
    <tr><td style="padding:12px 24px 0;">
      <p style="margin:0;font-size:14px;color:#374151;">${escapeHtml(competitorDelta.droppedName)} dropped out of your local pack.</p>
    </td></tr>`;
    return competitorDelta.fallback ? note + renderRivalLineHtml(competitorDelta.fallback) : note;
  }

  return renderRivalLineHtml(competitorDelta.line);
}
```

Import `NamedRivalLine` alongside `CompetitorDelta` from `@/lib/competitors/named-rival`.

- [ ] **Step 8: Run the template tests to verify they pass**

Run: `cd <worktree> && pnpm vitest run src/lib/notifications/__tests__/email-templates.test.ts`
Expected: PASS.

- [ ] **Step 9: Add the worker observability line**

In `worker/jobs/WeeklySummaryWorker.ts`, at the `resolveNamedRival` call site, record which source rendered. Use the existing `createWorkerLogger` logger already in scope in that function (if none is in scope, thread the logger already used by the enclosing handler — do not create a second logger):

```ts
  const competitorDelta = await resolveNamedRival(db, businessId);
  logger.info('competitor_delta_resolved', {
    businessId,
    source: competitorDelta === null
      ? 'omitted'
      : competitorDelta.kind === 'teaser'
        ? 'teaser'
        : competitorDelta.kind === 'dropout'
          ? 'dropout'
          : competitorDelta.line.source,
  });
```

Never log the rival title (CLAUDE.md logging rule: no raw review/response text; keep third-party business names out of logs too — the businessId is sufficient to correlate).

Update `worker/jobs/__tests__/WeeklySummaryWorker.test.ts` for the nested `line` shape wherever it asserts on `competitorDelta`, and add:

```ts
  it('logs competitor_delta_resolved with the source that rendered', async () => {
    // follow the file's existing logger-spy pattern; assert the emitted
    // source is 'owner_pick' when the business has a pick in the latest pack
  });
```

Replace that comment with a real assertion following the file's existing spy setup — a placeholder here is a plan failure, so read the file's existing logging assertions and mirror them.

- [ ] **Step 10: Run the worker tests**

Run: `cd <worktree> && pnpm vitest run worker/jobs/__tests__/WeeklySummaryWorker.test.ts`
Expected: PASS.

- [ ] **Step 11: Update CONTEXT.md**

In the `## Competitor Delta` section, extend the **Named rival** bullet to record the shipped mechanics (owner pick stored as `businesses.rival_place_id` + `rival_title_snapshot`; live pack title wins for a present pick; the stored snapshot names the dropout; dropout is derived from the two-snapshot window, never stored) and append `*(pick mechanics locked in #546)*` to the citation trail. Do not restate the whole entry — sharpen it.

- [ ] **Step 12: Commit**

```bash
git add src/lib/competitors src/lib/notifications worker/jobs CONTEXT.md
git commit -m "feat(competitors): honor the owner-picked Named rival + dropout note (#546)"
```

---

## Task 4: Picker view + write route + analytics

**Blocking edges:** Task 3 (shares `named-rival.ts`; sequence after to avoid conflicting edits in one file).

**Files:**
- Modify: `src/lib/competitors/named-rival.ts`
- Modify: `src/lib/competitors/__tests__/named-rival.test.ts`
- Create: `src/app/api/settings/competitors/route.ts`
- Create: `src/app/api/settings/competitors/__tests__/route.test.ts`
- Modify: `src/lib/analytics/events.ts`
- Modify: `docs/analytics/events.md`

- [ ] **Step 1: Register the analytics event**

In `src/lib/analytics/events.ts`, add `'competitor_rival_picked'` to `ANALYTICS_EVENT_NAMES`, keeping the array's existing ordering convention. Do **NOT** add it to `CLIENT_ENQUEUEABLE_EVENT_NAMES` — this is a durable server-side fact.

In `docs/analytics/events.md`, add a `### \`competitor_rival_picked\`` block matching the file's existing block format, with `**Status:** live`, describing: fired by the owner-scoped competitors settings route when a Named rival pick is set or cleared; properties `action` (`set` | `cleared`) and `placeId` (null on clear); `distinctId` = accountId; the probe-engagement signal for wayfinder map #528.

Run: `cd <worktree> && pnpm ci:analytics-events`
Expected: PASS (registry and doc agree).

- [ ] **Step 2: Write the failing module tests for the picker view and writes**

These need a live Postgres and therefore belong in an integration suite. Create `src/lib/competitors/__tests__/named-rival.integration.test.ts` following the setup/teardown conventions of an existing integration suite in this repo (find one with `rg -l "TEST_DATABASE_POOL_URL" src worker --glob '*.integration.test.ts'` and copy its harness verbatim — do not invent a new harness). Cover:

```ts
  it('excludes is_self and blank-place_id rows from the pickable options and orders by rank then place_id', async () => { /* … */ });
  it('lists a pick absent from the latest pack as the selected option using the stored title snapshot', async () => { /* … */ });
  it('shows the not-configured state for a location with no primary tracked keyword', async () => { /* … */ });
  it('shows the teaser state for a configured location with no persisted pack yet', async () => { /* … */ });
  it('derives the stored title snapshot from the pack row and ignores any client-supplied title', async () => { /* … */ });
  it('rejects a pick whose place_id is absent from the latest pack with 409 pack_refreshed', async () => { /* … */ });
  it('rejects a pick targeting the location’s own is_self pack row', async () => { /* … */ });
  it('clears the pick and returns the location to the Auto-default rival when Auto-selected is chosen', async () => { /* … */ });
  it('records a durable competitor_rival_picked analytics event on set and on clear', async () => { /* … */ });
  it('does not store a pick when the pack is replaced concurrently with the request', async () => { /* … */ });
  it('does not store a pick when a newer snapshot date lands mid-request', async () => { /* … */ });
  it('writes exactly one analytics event when the same pick is submitted twice', async () => { /* … */ });
  it('returns 404 and writes no analytics event for a businessId outside the caller’s account', async () => { /* … */ });
```

The two concurrency tests exercise the atomic `UPDATE … FROM`, and they must cover BOTH interleavings — a same-date test alone would pass against a naive implementation that pre-resolves the date:
- **same-date replace** — a second connection replaces the pack for the same (business, keyword, snapshot_date) without the target rival;
- **new-date arrival** — a second connection commits a pack for a NEWER snapshot_date that does not contain the target rival, leaving the old date's rows persisted. This is the case that catches a pre-resolved `latestSnapshotDate`, and it is the exact hole the adversarial review found in an earlier draft of this plan.

In both, assert the pick is either rejected as stale or reflects the latest committed pack — never a rival absent from it. Mirror the interleaving harness of an existing suite (`rg -l "FOR UPDATE" --glob '*.integration.test.ts'`).

Do not skip these three because they are awkward: per CLAUDE.md, an existing-but-not-run integration suite is exactly how #520 shipped.

The blank-title exclusion in `options` is deliberate and needs no test of its own: the shipped `selectAutoDefaultRival` already refuses rows with `title.trim().length === 0`, so a blank-title rival is one the digest would never be able to name. Offering it in the picker would let an owner select a rival that can never render.

Each body seeds a business + a `competitor_snapshots` pack, calls the module function, and asserts the returned `RivalPickerView` / thrown error / `analytics_events` row. Write the real bodies — the `/* … */` markers above are the test titles this task must produce, not acceptable step content.

The two error-shaped titles assert the thrown typed error (`RivalPickStaleError`); the "409 pack_refreshed" and "404" HTTP mappings are asserted in the route test in Step 5.

- [ ] **Step 3: Run the integration tests to verify they fail**

Run: `cd <worktree> && TEST_DATABASE_POOL_URL=<staging pool url> pnpm vitest run src/lib/competitors/__tests__/named-rival.integration.test.ts`
Expected: FAIL — `loadRivalPickerView is not a function`.

If `TEST_DATABASE_POOL_URL` is not available, STOP and report — per the gate rules, DB-touching work is not review-ready with a skipped live-DB suite (the #520 class).

- [ ] **Step 4: Implement the picker view and the write**

Append to `src/lib/competitors/named-rival.ts`:

```ts
export interface RivalOption {
  placeId: string;
  title: string;
  rankPosition: number | null;
  reviewCount: number | null;
  rating: number | null;
}

export interface PickedRival {
  placeId: string;
  title: string;
  inLatestPack: boolean;
}

export type RivalPickerView =
  | { state: 'not_configured'; businessId: string }
  | { state: 'awaiting_pack'; businessId: string; keyword: string }
  | { state: 'ready'; businessId: string; keyword: string; options: RivalOption[]; pick: PickedRival | null };

/** The caller asked for a location their account does not own, or that does not exist. */
export class RivalPickNotFoundError extends Error {}
/** The submitted place_id is not a pickable rival in the location's latest pack. */
export class RivalPickStaleError extends Error {}
```

`loadRivalPickerView(db, { accountId, businessId })`:
1. Resolve context with the businesses query scoped by BOTH `id = businessId` AND `account_id = accountId`; no row → throw `RivalPickNotFoundError`.
2. No keyword or no search location → `{ state: 'not_configured' }`.
3. Load the single latest `snapshot_date` from `ranking_snapshots` for (business, keyword, search_location) as `::text`; none → `{ state: 'awaiting_pack', keyword }`.
4. Load that date's `competitor_snapshots` rows, ordered `rank_position ASC NULLS LAST, place_id ASC NULLS LAST`.
5. `options` = rows where `!is_self && place_id !== null && place_id.length > 0 && title.trim().length > 0`, mapped to `RivalOption` with `rating` parsed via `parseCompetitorRating`.
6. `pick` = null when `rival_place_id` is null; otherwise `{ placeId, title: <live pack title when the place_id is in options, else rival_title_snapshot>, inLatestPack: <whether it is in options> }`.
7. Return `{ state: 'ready', keyword, options, pick }` — `options` may legitimately be empty; the client renders the no-rivals copy.

`setNamedRivalPick(db, { accountId, businessId, placeId, userId })`:
1. Wrap everything in `db.begin(async (tx) => …)` so the UPDATE and the analytics INSERT commit together.
2. **Validate and write in ONE atomic statement — do not read-then-write.**

   A `SELECT` to validate followed by an `UPDATE` to store leaves a window in which RankingTrackingWorker can commit a replacement pack, after which we persist a pick for a rival no longer in the pack — and the very next digest would fire a dropout note for a rival the owner picked seconds earlier. Locking is the wrong tool here: the worker's `ranking_snapshots` row lock is keyed on `(business, keyword, snapshot_date)`, so a `FOR UPDATE` on whichever row is *currently* latest serializes nothing when the worker inserts a **new** date — and making it serialize would mean an advisory lock that `RankingTrackingWorker.ts` must also take, which is outside this ticket's edit surface.

   Instead, let one statement do both. A single `UPDATE … FROM` evaluates against one snapshot, so membership and write cannot disagree:

```ts
    const [updated] = await tx<{ rival_picked_at: Date }[]>`
      UPDATE businesses b
      SET rival_place_id = cs.place_id,
          rival_title_snapshot = cs.title,
          -- A retried request that re-submits the SAME rival must not move this
          -- timestamp: it seeds the analytics event key below, and a moving key
          -- would double-count one owner action as two engagement events.
          -- A rename-only refresh (same place_id, new title) likewise updates
          -- the snapshot without moving it — that is not a new owner action.
          rival_picked_at = CASE
            WHEN b.rival_place_id IS DISTINCT FROM cs.place_id THEN NOW()
            ELSE b.rival_picked_at
          END
      FROM competitor_snapshots cs
      WHERE b.id = ${businessId}
        AND b.account_id = ${accountId}
        AND cs.business_id = b.id
        AND cs.place_id = ${placeId}
        -- Keyword and search location are derived from `b` INSIDE the statement,
        -- never passed in: a value resolved by an earlier read is a value that
        -- can have changed by now.
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
        -- persisted, and we would happily store a rival that is absent from the
        -- now-latest pack.
        AND cs.snapshot_date = (
          SELECT MAX(cs2.snapshot_date)
          FROM competitor_snapshots cs2
          WHERE cs2.business_id = b.id AND cs2.keyword = cs.keyword
        )
      RETURNING b.rival_picked_at
    `;
    // Zero rows == the place_id is not a pickable rival in the latest committed
    // pack — whether it never was, or a pack replacement just landed.
    if (!updated) throw new RivalPickStaleError(placeId);
```

  Every predicate resolves against a single snapshot inside one statement, so nothing this request read earlier can go stale between validation and write. The title is read from the pack row inside the statement — there is no code path by which an argument can reach `rival_title_snapshot`.

3. `placeId === null` → clear, made retry-safe by the `IS NOT NULL` predicate:

```ts
    const [cleared] = await tx<{ cleared_at: Date }[]>`
      UPDATE businesses
      SET rival_place_id = NULL, rival_title_snapshot = NULL, rival_picked_at = NULL
      WHERE id = ${businessId} AND account_id = ${accountId}
        -- Without this, a retried clear matches the already-cleared row and
        -- returns a fresh NOW(), minting a second event key that slips past
        -- the ON CONFLICT dedupe below.
        AND rival_place_id IS NOT NULL
      RETURNING NOW() AS cleared_at
    `;
```

  Zero rows here means "already cleared" — return the current view without emitting an analytics event, do NOT throw.

7. Enqueue the analytics event on the same `tx`:

```ts
  await enqueueAnalyticsEvent(tx, {
    eventName: 'competitor_rival_picked',
    eventKey: makeAnalyticsEventKey('competitor_rival_picked', [
      businessId,
      placeId ?? 'cleared',
      (updated?.rival_picked_at ?? cleared!.cleared_at).toISOString(),
    ]),
    distinctId: accountId,
    accountId,
    userId,
    businessId,
    // businessId is ALSO in properties, not only in the analytics_events
    // business_id column: AnalyticsDispatchPoller's RETURNING clause selects
    // only (id, event_key, event_name, distinct_id, properties, attempts,
    // max_attempts) and forwards `{...properties, $insert_id}` to PostHog — the
    // column never leaves Postgres, so a properties-blob copy is the only way
    // the location dimension reaches the dashboard we are building this event
    // for. Widening the poller is out of this ticket's edit surface.
    properties: { action: placeId === null ? 'cleared' : 'set', placeId, businessId },
  });
```

  Both timestamps come from the database (`RETURNING`), never a JS `new Date()` — a JS timestamp differs on every retry and would defeat `ON CONFLICT (event_key) DO NOTHING`. Combined with the `IS DISTINCT FROM` guard on set and the `IS NOT NULL` guard on clear, a retried identical request is a true no-op: same key, conflict, nothing inserted.

8. Return the freshly re-loaded `RivalPickerView` so the caller renders committed state.

Both functions take `db: Sql` explicitly (invariant #15); neither imports `@/lib/db/server`.

- [ ] **Step 5: Write the failing route tests**

Create `src/app/api/settings/competitors/__tests__/route.test.ts` following the harness in `src/app/api/settings/auto-approval/__tests__/` (read it first and mirror its mocking of `requireOwnerWithAccount` and `sql`):

```ts
  it('returns 404 and writes no analytics event for a businessId outside the caller’s account', async () => { /* module throws RivalPickNotFoundError → 404, enqueue spy not called */ });
  it('rejects a pick whose place_id is absent from the latest pack with 409 pack_refreshed', async () => { /* module throws RivalPickStaleError → 409 { error: 'pack_refreshed' } */ });
  it('rejects a request that supplies a title alongside the place id', async () => { /* schema is strict: unknown keys rejected with 400 */ });
  it('returns the picker view for the caller’s own location', async () => { /* 200 with state: 'ready' */ });
```

Write real bodies mirroring the auto-approval route tests.

- [ ] **Step 6: Run the route tests to verify they fail**

Run: `cd <worktree> && pnpm vitest run src/app/api/settings/competitors/__tests__/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the route**

Create `src/app/api/settings/competitors/route.ts`, mirroring `src/app/api/settings/auto-approval/route.ts` structure exactly: `export const dynamic = 'force-dynamic'`, `requireOwnerWithAccount`, the `accountId` query-param rejection, `withSameOrigin` on the mutating verb, `jsonResponse`, `reportCaughtError` on the fallthrough.

- `GET` — requires a `businessId` search param; delegates to `loadRivalPickerView(sql, { accountId, businessId })`; `RivalPickNotFoundError` → 404 `{ error: 'not_found' }`.
- `PUT` (wrapped in `withSameOrigin`) — body parsed by a **strict** Zod schema (`.strict()` so a client-supplied `title` is a 400, not a silently ignored field):

```ts
const RivalPickSchema = z.object({
  businessId: z.string().uuid(),
  placeId: z.string().min(1).max(255).nullable(),
}).strict();
```

  delegates to `setNamedRivalPick(sql, { accountId, businessId, placeId, userId: owner.user.id })`; `RivalPickNotFoundError` → 404, `RivalPickStaleError` → 409 `{ error: 'pack_refreshed' }`, anything else → `reportCaughtError` + 500.

The route contains no business logic — it parses, calls one module function, and maps errors (repworth.md).

- [ ] **Step 8: Run the tests**

Run: `cd <worktree> && pnpm vitest run src/app/api/settings/competitors src/lib/competitors && TEST_DATABASE_POOL_URL=<pool url> pnpm vitest run src/lib/competitors/__tests__/named-rival.integration.test.ts`
Expected: PASS.

Run: `cd <worktree> && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:db-imports && pnpm ci:static-policy && pnpm ci:analytics-events`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/competitors src/app/api/settings/competitors src/lib/analytics/events.ts docs/analytics/events.md
git commit -m "feat(competitors): owner-scoped rival pick route + engagement event (#546)"
```

---

## Task 5: Settings page

**Blocking edges:** Task 4 (consumes `RivalPickerView` and the route).

**Files:**
- Create: `src/app/(authenticated)/settings/competitors/page.tsx`
- Create: `src/app/(authenticated)/settings/competitors/CompetitorsClient.tsx`
- Create: `src/app/(authenticated)/settings/competitors/__tests__/CompetitorsClient.test.tsx`
- Modify: `src/components/dashboard/settings/SettingsSidebar.tsx`
- Modify: `src/app/globals.css` (only if a new class is genuinely needed — prefer existing settings classes)

- [ ] **Step 1: Invoke the `repworth-brand-design` skill**

Invoke the Skill tool with `skill: "repworth-brand-design"` before writing any JSX. Follow its tokens, island layout, and anti-slop guardrails. Reuse the existing `.input`, `.settings-*` classes visible in `SettingsSidebar.tsx` and the auto-approval/channels clients rather than inventing new ones.

- [ ] **Step 2: Write the failing client-component tests**

Create `src/app/(authenticated)/settings/competitors/__tests__/CompetitorsClient.test.tsx`, following the harness of `src/app/(authenticated)/settings/voice/__tests__/VoiceReportCard.test.tsx` (read it first — same Testing Library setup and conventions):

```tsx
  it('excludes is_self and blank-place_id rows from the pickable options and orders by rank then place_id', () => { /* asserts on the option list rendered from a fixture view */ });
  it('lists a pick absent from the latest pack as the selected option using the stored title snapshot', () => { /* option labelled 'not in the latest pack', selected */ });
  it('shows the not-configured state for a location with no primary tracked keyword', () => { /* no combobox, explanatory copy */ });
  it('shows the teaser state for a configured location with no persisted pack yet', () => { /* keyword named, no combobox */ });
  it('clears the pick and returns the location to the Auto-default rival when Auto-selected is chosen', () => { /* selecting the first option PUTs placeId: null */ });
```

Note the first two titles also appear in Task 4's integration suite: the module test proves the SERVER produces the right view, the component test proves the UI RENDERS it. Both are required by the intake's `tests_to_add`; keep both.

Write real bodies. The fixture is a `RivalPickerView` literal per test.

- [ ] **Step 3: Run to verify failure**

Run: `cd <worktree> && pnpm vitest run "src/app/(authenticated)/settings/competitors"`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the client component**

`CompetitorsClient.tsx` (`'use client'`), props `{ views: RivalPickerView[]; locations: Array<{ id: string; name: string }>; multiLocation: boolean }`.

Per view:
- `not_configured` → copy: “Competitor tracking isn’t set up for this location yet.”
- `awaiting_pack` → copy: “We’re watching ‘{keyword}’ — the first competitor pack lands after the next check.”
- `ready` with `options.length === 0` → copy: “No competitors were found in the latest pack for ‘{keyword}’.”
- `ready` with options → a `<select>` labelled `Named rival for ‘{keyword}’`:
  - first `<option value="">Auto-selected (nearest ahead)</option>`;
  - then each option as `#{rankPosition ?? '—'}  {title}  {reviewCount ?? '—'} · {rating ?? '—'}`;
  - when `pick && !pick.inLatestPack`, a final `<option>` with the stored title and the suffix “ — not in the latest pack”, and it is the selected value.

`onChange` PUTs `{ businessId, placeId: value === '' ? null : value }` to `/api/settings/competitors`, replaces local state from the returned `RivalPickerView`, and on a `409 pack_refreshed` shows an inline message telling the owner the pack refreshed and re-fetches the view via GET rather than leaving a stale select. Disable the select while in flight. Follow the auto-approval client's error/pending pattern.

When `multiLocation` is false, render the single view with no location heading; when true, render one labelled block per active location (the `/settings/channels` presentation precedent).

- [ ] **Step 5: Implement the server page**

`page.tsx` (`export const dynamic = 'force-dynamic'`), mirroring `settings/auto-approval/page.tsx`:

```tsx
const access = await requireOwnerAccess(sql);
// Check `src/lib/locations/repo.ts` first: `getLocationsForAccount` may already
// exclude archived rows (there is a separate `getArchivedLocationsForAccount`).
// Do not add a redundant filter — and do not assume it excludes them either.
const locations = await getLocationsForAccount(sql, access.accountId);
const views = await Promise.all(
  // asLocationId (src/lib/shared/ids.ts) crosses the string → branded-id seam
  // here exactly as it must in the route handler. Do not cast.
  locations.map((location) => loadRivalPickerView(sql, {
    accountId: access.accountId,
    businessId: asLocationId(location.id),
  })),
);
const multiLocation = shouldUseMultiLocationSettings(multiLocationEnabled(), locations.length);
```

with a `TopBar` titled `Competitors` / subtitle “Choose which local-pack rival your weekly digest reports on.” and `rightLink` back to the dashboard. There is no feature flag and no `notFound()` gate — the page is available to every owner.

- [ ] **Step 6: Add the nav item**

In `src/components/dashboard/settings/SettingsSidebar.tsx`, add `{ label: 'Competitors', href: '/settings/competitors', icon: 'chart' }` as the last item of the `Responses` group. Use an `IconName` that already exists in `Icon.tsx` — check before choosing, and do not add a new icon.

- [ ] **Step 7: Run the tests and the build**

Run: `cd <worktree> && pnpm vitest run "src/app/(authenticated)/settings/competitors" && pnpm lint && pnpm typecheck && pnpm build`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(authenticated)/settings/competitors" src/components/dashboard/settings/SettingsSidebar.tsx src/app/globals.css
git commit -m "feat(competitors): rival picker settings page (#546)"
```

---

## After all tasks

Run the review-mode gate from the worktree:

```bash
cd <worktree> && bash scripts/verify-gate.sh --review
```

All rows must be green, including `promised-tests` (all 19 intake titles present verbatim) and `diff-coverage`. The changed integration suite must RUN, not SKIP — set `TEST_DATABASE_POOL_URL` first.

Anything the plan did not anticipate goes in `docs/superpowers/plans/feat-546-rival-picker-deviations.md`, not into a widened scope.
