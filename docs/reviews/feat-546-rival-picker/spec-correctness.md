# Spec & correctness review — `feat/546-rival-picker`

Reviewer axis: does the diff faithfully implement `.feature/intake.json` and the plan?
Not reviewed here: naming, style, maintainability (owned by the standards agent).

Diff reviewed: `git diff $(git merge-base HEAD origin/main)..HEAD` — 28 files,
+4716 / −227, commits `9f3167b4 4ee64b34 8518dc97 1a0d5354 b8c134bf fc2ce4f9 470ba518 6fdf5e9a`
plus the owner-approved unrelated `860402ba`.

---

## Findings (≥80% confidence only)

| Severity | file:line | Finding |
|---|---|---|
| Medium | `src/lib/competitors/named-rival.ts:183-190` (renders at `:109`) | The pick-honor path has no blank-title guard. Every sibling path rejects whitespace-only titles (`selectAutoDefaultRival` `:134`, `isPickableOption` `:413`, `storeRivalPick`'s `btrim(cs.title) <> ''` `:606`), but `pickedRow` matches on `place_id` + `!is_self` + integer `review_count` only. 084 documents `title TEXT NOT NULL, -- '' when SerpAPI omits the name`, so a picked rival whose name is omitted in a later pack renders a nameless Competitor Delta line in the owner's email: `<p> gained 4 reviews since our last check; gap now 27</p>`. `rival_title_snapshot` is available and unused here. |
| Low | `src/lib/competitors/named-rival.ts:613-617` | The write's "latest pack" and the read view's "latest pack" are derived from **different tables**. `storeRivalPick` uses `MAX(cs2.snapshot_date) FROM competitor_snapshots WHERE cs2.business_id = b.id AND cs2.keyword = cs.keyword` (no `search_location` predicate); `loadRivalPickerView` (`:453-462`) and `resolveNamedRival` (`:292-299`) use the latest `ranking_snapshots.snapshot_date` for keyword **and** search location. 084 records an empty pack for a date as a fact (`RankingTrackingWorker.ts:279-296` writes the `ranking_snapshots` row unconditionally and inserts zero pack rows), so when the newest run returns an empty pack the write's `MAX` falls back to the previous date and **accepts** a pick absent from the latest pack. Violates intake invariant *"A pick is only accepted for a place_id present in that location's latest persisted pack … anything else is rejected, never silently stored"* and edge case *"Pick submitted for a place_id that left the pack between page render and submit → 409 pack_refreshed"*. |

**Verdict on the axis:** the diff faithfully implements the contract apart from
the two rows above. Both are read/write-asymmetry defects inside
`named-rival.ts`; neither is a tenant-isolation, analytics, or migration defect.

---

## Field-by-field intake verification

### `allowed_edit_surface` — PASS (no drift)

Every changed path maps to a glob:

| Changed path | Glob |
|---|---|
| `supabase/migrations/089_competitor_rival_pick.sql` | `supabase/migrations/089_*.sql` ✔ |
| `.claude/reference/migrations-log.md` | exact ✔ |
| `src/lib/shared/__tests__/migration-089-…test.ts`, `…migration-069-…test.ts` | `src/lib/shared/__tests__/migration-*.test.ts` ✔ (amendment #1) |
| `src/lib/competitors/*` (3 files) | `src/lib/competitors/**` ✔ |
| `src/app/api/settings/competitors/*` (2) | `src/app/api/settings/competitors/**` ✔ |
| `src/app/(authenticated)/settings/competitors/*` (3) | `src/app/(authenticated)/settings/competitors/**` ✔ |
| `src/components/dashboard/settings/SettingsSidebar.tsx` + its `__tests__` | exact + `…/__tests__/**` ✔ |
| `worker/jobs/WeeklySummaryWorker.ts` + test | exact ✔ |
| `src/lib/notifications/email/templates/weekly-value-report.ts` + `src/lib/notifications/__tests__/email-templates.test.ts` | exact ✔ |
| `src/lib/analytics/events.ts` + `__tests__/events.test.ts` | exact + `**` ✔ |
| `docs/analytics/events.md`, `CONTEXT.md`, `docs/superpowers/plans/**` | exact ✔ |
| `scripts/ci/tenant-scope-allowlist.ts` | amendment #2 ✔ |
| `docs/runbooks/channels-staging-smoke-test.md` | **outside** — commit `860402ba`, owner-approved carve-out |

`860402ba` verified in isolation (`git show --stat`): one file, 28 insertions /
2 deletions, all prose about the staging Telegram bot username and the Twilio
sandbox join keyword. No code, no other file. Confirmed clean.

`src/app/globals.css` was in the surface and deliberately **not** touched (Task 5
deviation: `.auto-policy-warning` reused). Unused permission is not drift.

### `user_visible_behavior` — 13/13 implemented

| # | Behavior | Evidence |
|---|---|---|
| 1 | Settings > Responses > Competitors page, per active location | `page.tsx:23-33` (`getLocationsForAccount` excludes archived), `SettingsSidebar.tsx:24` |
| 2 | Options = latest pack, minus `is_self`, minus NULL/blank `place_id`, ordered rank ASC NULLS LAST then place_id; title / reviews / rating with em dash | `isPickableOption` `:410-414`, `ORDER BY` `:471`, `optionLabel` (`MISSING_VALUE = '—'`, U+2014) |
| 3 | NULL review count selectable | `isPickableOption` does not test `review_count` ✔ |
| 4 | First option `Auto-selected (nearest ahead)` clears the pick | `AUTO_DEFAULT_LABEL`, `<option value="">`, `placeId: selected === '' ? null : selected` |
| 5 | Absent pick still shown, stored snapshot, flagged "not in the latest pack" | `toPickedRival` `:492-500`, extra `<option>` + `DROPPED_SUFFIX = ' — not in the latest pack'` |
| 6 | Not-configured copy | `state: 'not_configured'` `:447` → client copy |
| 7 | Teaser copy naming the keyword | `state: 'awaiting_pack'` `:462` → client copy |
| 8 | No selectable rival → no dropdown, "no competitors found" copy | `options.length === 0` branch |
| 9 | Pick present ⇒ no `Auto-selected rival:` prefix, LIVE pack title | `weekly-value-report.ts` `prefix = line.source === 'auto_default' ? … : ''`; `buildLineForRow` uses `row.title` |
| 10 | No pick ⇒ unchanged `Auto-selected rival: …` | `selectNamedRival` early return `:178` |
| 11 | Dropout note + Auto-default line | `:214` + template `kind === 'dropout'` branch |
| 12 | Absent from both / one snapshot ⇒ no note | `wasInPreceding` requires `precedingDate !== undefined` `:206-208` |
| 13 | (implied) durable analytics on set + clear | `setNamedRivalPick` `:521-539` |

No behavior found outside this list. The offboarding 403 gate and the
`accountId`-query-param rejection in `route.ts:88-95` are **not** scope creep —
they are byte-for-byte the pattern of the named exemplar
`src/app/api/settings/auto-approval/route.ts:78-85`.

### `invariants` — 12/12 held (one with the caveat in finding #2)

1. **Tenant isolation, 404 for a foreign `businessId`** — HELD, and this is the
   branch's highest-risk area. All three writers/readers carry
   `account_id = ${accountId}`: `loadRivalPickerView` `:437`, `storeRivalPick`
   `:594`, `clearRivalPick` `:639`. The zero-row ambiguity the plan missed is
   disambiguated by `assertLocationOwned` `:657-665`, called on the failure path
   of **both** writers — so a foreign *pick* is 404 (not the plan's 409, which
   would have confirmed the row's existence) and a foreign *clear* is 404 (not
   the plan's 200). Verified by reading the SQL, not the deviations note. The
   three-way disambiguation is airtight:
   - pick, zero rows, location owned → `RivalPickStaleError` → 409
   - pick, zero rows, location not owned → `RivalPickNotFoundError` → 404
   - clear, zero rows, owned → benign already-cleared, `null`, **no event**
   - clear, zero rows, not owned → 404
   No existence leak: the 409 is only ever reachable after ownership is proven.
   Analytics writes happen inside the same `db.begin`, after the write decided,
   so a 404 rolls back with zero events (integration test asserts `count = 0`).
2. **`rival_title_snapshot` always server-derived** — HELD. `SET rival_title_snapshot = cs.title`
   `:574`; `SetNamedRivalPickInput` has no title field; `RivalPickSchema` is
   `.strict()` so a client-supplied `title` is a 400, not a silent drop.
   No code path lets a client string reach the column.
3. **Pick only accepted for a `place_id` in the latest pack, not `is_self`** —
   `is_self = false` HELD (`:601`); "latest pack" **partially held** — see
   finding #2.
4. **Gap = review counts only** — HELD, single owner `buildLineForRow:110`.
   `rating` and `rank_position` never enter the arithmetic.
5. **Strictly per-location, primary (first) tracked keyword** — HELD:
   `tracked_keywords->>0` in all three query sites; no account rollup exists.
6. **A pick is never auto-removed** — HELD. No `UPDATE businesses SET rival_place_id = NULL`
   anywhere except the explicit owner clear. `resolveNamedRival` is read-only.
7. **Owner picks never labeled "Auto-selected"** — HELD, `prefix` is derived from
   `line.source`, which is set at exactly two construction sites.
8. **Invariant #1 (Vercel = UI only)** — HELD. Route + page do Postgres only; no
   LLM/HTTP call added. `named-rival.ts` imports only `postgres` types,
   `@/lib/shared/ids`, and the analytics enqueue helper.
9. **Invariant #13 (no `NEXT_PUBLIC_*`, no new flag)** — HELD. `git diff` contains
   zero `NEXT_PUBLIC_` additions and zero new env reads. `page.tsx` explicitly
   documents "no feature flag".
10. **Invariant #15 (explicit `Sql` param)** — HELD. `named-rival.ts` takes
    `db: Sql` / `tx: TransactionSql` on every exported and private function and
    does not import `@/lib/db/server`. The singleton is imported only by
    `route.ts`, `page.tsx` (server component) and `WeeklySummaryWorker.ts` — all
    composition roots. `tx.json` is not needed here (no JSONB write).
11. **Digest performs no write to `businesses`** — HELD. `resolveNamedRival` is a
    single `SELECT`; dropout is derived in `selectNamedRival`, stored nowhere.
12. **Analytics inserted server-side, not client-postable** — HELD.
    `CLIENT_ENQUEUEABLE_EVENT_NAMES` (events.ts:78-84) was **not** extended;
    the diff adds the name to `ANALYTICS_EVENT_NAMES` only.

### `edge_cases` — 14/14 addressed (one partial)

| Edge case | Verdict |
|---|---|
| left the pack between render and submit → 409 | Held for a *replaced* pack (integration test, both same-date and new-date variants). **Not** held when the newest date recorded an **empty** pack — finding #2. |
| `is_self` row picked → 409, never stored | `AND cs.is_self = false` + integration test |
| foreign `businessId` → 404, no state change, no event | `assertLocationOwned`; integration test asserts zero events |
| NULL review count picked → stored, excluded from gap math, falls through | `isPickableOption` allows it; `pickedRow` requires `Number.isInteger`; `presentButUnusable` suppresses the false dropout `:204` |
| NULL/blank `place_id` never offered | `isPickableOption:412` |
| keyword/search-location edited → derived dropout/fallback, no orphan | Held: pack rows for the old lane stop matching `ctx.search_location`; nothing is written |
| only one snapshot date, pick absent → no dropout note | `precedingDate === undefined` ⇒ `wasInPreceding === false` |
| renamed rival → live title; snapshot only for dropout + UI | `buildLineForRow` uses `row.title`; snapshot used at `:214` and `:498` only |
| NUMERIC rating returns as string → parsed on read | `parseCompetitorRating:79-83`, applied in `toObservationWindow:249` and `loadRivalPickerView:480`. 085 confirms `NUMERIC(2,1)`. |
| `snapshot_date` is DATE → `::text` end-to-end | `::text` on both `d.snapshot_date` and `cs.snapshot_date` (`:302-304`) and in `loadRivalPickerView:454`. The one re-cast back (`= ${latest.snapshot_date}::date`, `:470`) is a comparison against a DATE column — correct, not the #570 bug. |
| archived location not listed | `getLocationsForAccount` (page comment verified against the repo helper) |
| multi-location presentation via `shouldUseMultiLocationSettings` | `page.tsx:44`; client ORs `views.length > 1` (Task 5 deviation — a *widening* of when names show, never a narrowing; prevents indistinguishable pickers when the flag is off) |
| repeated biweekly pair repeats the dropout note | Accepted by design; `selectNamedRival` is stateless per digest |

### `tests_to_add` — 19/19 present VERBATIM

Verified by literal string search across the repo (excluding `docs/`). All 19
intake titles resolve to at least one test file:

- `src/lib/competitors/__tests__/named-rival.test.ts` — 8 titles
- `src/lib/competitors/__tests__/named-rival.integration.test.ts` — 10 titles
- `src/app/(authenticated)/settings/competitors/__tests__/CompetitorsClient.test.tsx` — 5 titles (overlapping)
- `src/app/api/settings/competitors/__tests__/route.test.ts` — 2 titles (overlapping)
- `src/lib/notifications/__tests__/email-templates.test.ts` — 1 title
  (`labels the Auto-default rival 'Auto-selected rival:' and omits the prefix for an owner pick`)

Spot-checked that titles are not merely present but assert their claim — e.g.
`rejects a pick whose place_id is absent from the latest pack with 409 pack_refreshed`
asserts `RivalPickStaleError` **and** that the columns stayed NULL **and**
`readAnalyticsEvents()` is empty; the 404 test exercises read, set **and** clear
against an outsider account.

### `verification_commands`, `dependencies_added`, `observability`

- Five audits named; the step-5 gate evidence records all 13 `ci:*` green.
  `ci:analytics-events` needs `docs/analytics/events.md` — the new section is
  present and complete (status, owner, source, distinct id, event key, required
  properties, privacy note).
- `dependencies_added: []` — `package.json` / lockfile untouched ✔.
- Observability: `competitor_delta_resolved` emitted with all five documented
  sources (`competitorDeltaSource`, WeeklySummaryWorker); no rival name logged
  ✔. `reportCaughtError` tagged with route name + `accountId`, never the title ✔.

---

## Load-bearing plan claims — verified against shipped code

| Claim | Verdict |
|---|---|
| Pick write resolves keyword, search location AND latest snapshot date INSIDE one `UPDATE … FROM`; nothing passed in from an earlier read | **Held** for keyword (`cs.keyword = b.tracked_keywords->>0`) and search location (the `CASE` is inlined, correlated to `b`). The date is computed in-statement but from the **wrong source table** — finding #2. |
| `rival_picked_at` moves only on `IS DISTINCT FROM`; clear carries `AND rival_place_id IS NOT NULL` | Held (`:576-581`, `:641`). The extra `OR b.rival_picked_at IS NULL` leg is correct and does not weaken idempotency: it fires only when `rival_place_id` is set while the timestamp is NULL, which is unreachable through this module. |
| Both event-key timestamps come from `RETURNING`, never JS `new Date()` | Held — `RETURNING b.rival_picked_at` and `RETURNING NOW() AS cleared_at`. No `new Date()` in `named-rival.ts`. |
| `businessId` in the analytics **properties blob**, not only the column | Held (`properties: { action, placeId, businessId }`). Confirmed `businessId` survives `sanitizeAnalyticsProperties` — it is not in `BLOCKED_PROPERTY_KEYS` / `BLOCKED_NORMALIZED_PROPERTY_KEYS` and matches no `token`/`secret`/`password` substring. |
| Dropout guard is `currentRows.length === 0`, NOT `!self` | Held (`:212`), with the reasoning correctly captured in the comment. |
| `resolveNamedRival` issues exactly ONE query | Held — one tagged template, no second read. The pick rides the same `ctx` CTE. |
| Migration 089's re-added CHECK drops NO name 069 allowed | Held — 089's list is 069's 18 names in the same order plus `competitor_rival_picked`. A dedicated regression test (`does not drop any name that 069 had already allowed`) parses both files and asserts the subset. |
| `rival_title_snapshot` server-derived; no client-supplied title path | Held — see invariant 2 above; the integration test smuggles `title` / `rivalTitleSnapshot` through a cast and asserts `'Bravo Beans'` is stored. |

---

## Blast-radius caller analysis

Two files were restructured; typecheck cannot catch a semantic change whose
callers relied on the old behavior, so each consumer was read.

### `worker/jobs/WeeklySummaryWorker.ts` — 4 importers

- **`worker/index.ts`** — imports `handleWeeklySummary` only. Its signature is
  unchanged (`job: Job<WeeklySummaryPayload>`). The new `logger` parameter is on
  the *private* `loadWeeklyValueInputs`, threaded from the handler's existing
  `createWorkerLogger` at `:419`. No new logger instance, no boot-time change. ✔
- **`worker/jobs/__tests__/WeeklySummaryWorker.test.ts`** — updated in-diff;
  added a `createWorkerLogger` mock that spreads `importOriginal`, so
  `toError` / `logUnhandledPollError` stay real for every other module in that
  import graph. Correct approach — a bare `vi.mock` would have broken siblings.
- **`worker/jobs/notification/__tests__/bounced-skip.test.ts`** and
  **`src/lib/agents/__tests__/run-spine.integration.test.ts`** — both drive
  `handleWeeklySummary`; neither reads `competitorDelta` nor asserts the
  three-statement query shape. The only new observable is one extra
  `logger.log('competitor_delta_resolved', …)` line, which neither asserts on
  (no exhaustive log-call assertions in either file). ✔
- **Semantic change consumers could rely on:** the competitor read went from
  3 statements to 1. Any test feeding a mock `sql` queue positionally would
  break — only `WeeklySummaryWorker.test.ts` does that, and it was updated
  (`competitorLaneRows()` helper models both `LEFT JOIN`s including the
  empty-pack sentinel and the NULL `window_date` case). Recorded coverage loss
  (keyword / search_location no longer bound params, asserted as query text) is
  real but does not change runtime behavior — the correlation moved *into* SQL,
  which is stronger, not weaker.

### `src/lib/notifications/email/templates/weekly-value-report.ts` — 1 importer

- **`src/lib/notifications/email.ts`** does `export * from './email/templates/weekly-value-report'`,
  so the barrel keeps re-exporting `CompetitorDelta` — which the template now
  re-exports from `named-rival.ts`. Import sites of the *value*
  `buildWeeklyValueReportHtml` are unaffected.
- **The type's shape CHANGED** (`{ kind:'rival'; rivalName; gap; reviewVelocity }`
  → `{ kind:'rival'; line: NamedRivalLine }`, plus a new `'dropout'` member).
  Exhaustive search for `CompetitorDelta` / `competitorDelta` across the repo
  returns exactly four files: the template, the worker, and their two test
  files — all updated in-diff. **No third-party consumer relies on the old
  shape.** ✔
- `renderCompetitorDeltaHtml` is not exported; the only entry point is
  `buildWeeklyValueReportHtml`, whose params object is unchanged apart from the
  widened `competitorDelta` type. Existing non-competitor assertions in
  `email-templates.test.ts` are untouched. ✔

### Other changed files

- **`src/lib/analytics/events.ts` — 15 importers.** Change is a pure array
  append. `CLIENT_ENQUEUEABLE_EVENT_NAMES` untouched, so
  `/api/analytics/enqueue` still refuses the new name. `events.test.ts` pins the
  array exactly and was extended in-diff. `scripts/ci/analytics-events-audit.ts`
  is satisfied by the new `docs/analytics/events.md` section. ✔
- **`src/components/dashboard/settings/SettingsSidebar.tsx`** — one nav entry.
  `settings/layout.tsx` renders it unchanged; its test's exhaustive enumeration
  was extended (otherwise it would have claimed completeness while checking
  7 of 8 items). ✔
- **`scripts/ci/tenant-scope-allowlist.ts`** — `ALLOWLIST_BASELINE` 405 → 407 with
  exactly two new entries, both `tenant-root-lookup`, both sharing the hoisted
  `NAMED_RIVAL_LANE_SQL` const (the file's stated convention). The two entries
  are for `businesses` and `ranking_snapshots`; `competitor_snapshots` needs
  none because its `business_id` predicate is in the outer `ON`. The scoping
  claimed in the reasons is real — I read the query: all three legs bind
  `${businessId}`. Not a scope hole. ✔
- **`src/lib/shared/__tests__/migration-069-…test.ts`** — the live drift-guard was
  handed to 089 and 069 keeps its historical list pinned as a literal. The guard
  is not lost; 089's version is a subset assertion in the correct direction
  (every `ANALYTICS_EVENT_NAMES` entry must be in the CHECK). ✔

---

## Low-confidence appendix (NOT findings)

Observations below did not meet the ≥80% bar or are outside my axis. Recorded
for completeness only.

1. **Duplicated notice rendering.** `CompetitorsClient` passes
   `saveError={notice?.message}` to `SettingsShell` *and* renders
   `<p className="auto-policy-warning">{notice}</p>` inside the matching
   `LocationRivalPicker`. On a 409 the same sentence likely appears twice. UI
   polish, not a contract violation; I did not render the component to confirm.
2. **`replaceView(body as RivalPickerView)` on a 200 whose body failed to parse.**
   `await res.json().catch(() => null)` can yield `null`, which would be spliced
   into `views` and crash the next `view.businessId` read. `jsonResponse` always
   emits a body, so this is unreachable through this route today.
3. **Rank in the option label.** `optionLabel` renders `#<rank>` in addition to
   the contract's title / reviews / rating. Ordering by rank is required, so
   surfacing it is defensible; it is extra text the contract did not name.
4. **`page.tsx` issues 3 statements per location in `Promise.all`.** A
   10-location account costs 30 round trips per page load. Correct, not fast.
   `resolveNamedRival`'s single-CTE form could have been reused if the
   tenant-scope allowlist entries were extended; the Task 4 deviation explains
   why it was not.
5. **`SET lock_timeout = '5s'` in 089 is session-scoped, not `SET LOCAL`.** It
   persists for the remainder of the applying session. The migration test even
   accepts either form (`/SET (LOCAL )?lock_timeout/`). Harmless in practice
   given how migrations are applied one file per session.
6. **`storeRivalPick` with duplicate `place_id` rows in one pack.** 084 has no
   per-row unique key, so `UPDATE … FROM` could join two rows for the same
   `place_id`; Postgres would apply one arbitrarily. The title picked would be
   nondeterministic. Requires SerpAPI returning the same Place ID twice in one
   pack — I could not establish that this happens.
7. **`MAX(cs2.snapshot_date)` also omits a `search_location` predicate.** Folded
   into finding #2 as the same subquery. On its own it is benign: after a
   search-location change with no run yet, the read view returns
   `awaiting_pack`, so the owner cannot reach the write.
8. **Archived locations are pickable via the API.** `PUT` does not check
   `archived_at`; only the page listing excludes them. The contract's edge case
   is worded about listing only, so this is arguably in spec.
9. **A stored pick becomes invisible when the latest pack is empty** — the
   `options.length === 0` branch renders copy with no `<select>`, so the owner
   cannot see or clear an existing pick. This is exactly what
   `user_visible_behavior` #8 specifies, so it is in spec, but it interacts
   badly with finding #2.

---

## Verdict

**The diff faithfully implements the intake contract**, with two correctness
defects logged above. No edit-surface drift, no scope creep, no missing test
title, all 12 invariants held (one with the caveat in finding #2), and the
tenant-isolation area — the branch's highest risk — is correctly built:
`assertLocationOwned` closes the zero-row ambiguity the plan would have shipped
as a 409 leak and a 200 no-op on foreign clears.

---

## Step 7 triage verdicts

Recorded decisions from the step-7 dual-review triage. These are the
orchestrator's dispositions, not a re-review.

### Finding 1 (Medium) — blank-title guard on the pick-honor path — **ACCEPTED — fixed**

`selectNamedRival`'s `pickedRow` filter now also requires
`row.title.trim().length > 0`, matching `selectAutoDefaultRival`,
`isPickableOption`, and the write's `btrim(cs.title) <> ''`.

Semantics as decided: a blank-title picked row is **present but unusable** and
behaves exactly like the existing NULL-review-count case — the digest falls
through to the Auto-default rival and emits **no dropout note**, because the
rival did not leave the pack, it is merely unnameable. `presentButUnusable`
keys on `place_id` alone, so it already suppresses the dropout for this row;
verified by a new test that seeds the pick in the preceding snapshot (the shape
that would otherwise fire a dropout) and asserts `kind: 'rival'` with the
Auto-default line.

`pick.titleSnapshot` was deliberately **not** substituted here: CONTEXT.md is
explicit that a rival present in the pack renders its LIVE title, and the
stored snapshot names the dropout note only.

Test added: `src/lib/competitors/__tests__/named-rival.test.ts` —
`'falls back to the Auto-default rival when the picked rival has a blank title in the latest pack'`.

### Finding 2 (Low) — write vs read "latest pack" derivation — **PARTIALLY ACCEPTED**

- **Fixed:** the `MAX(cs2.snapshot_date)` subquery in `storeRivalPick` is now
  scoped by search location as well as business and keyword
  (`AND cs2.search_location IS NOT DISTINCT FROM cs.search_location`, NULL-safe
  to match the outer predicate). A location whose effective search location
  changes can no longer have `MAX` return a date belonging to a different
  lane's pack. The LOAD-BEARING comment (latest date must be computed inside
  the statement, never passed in) is retained and extended to cover the
  scoping.
- **DEFERRED to a follow-up ticket:** the underlying source disagreement — the
  write derives "latest pack" from `competitor_snapshots` while both read paths
  derive it from `ranking_snapshots`, so a newest run with an empty pack makes
  the write fall back to the prior date. The finding is real, but changing the
  write's source of truth re-plans a locked decision; it is a follow-up ticket,
  not a review patch.
