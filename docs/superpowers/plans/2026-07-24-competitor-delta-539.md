# Competitor Delta Line (#539) Implementation Plan

**Goal:** Add the per-location Competitor Delta line to the weekly Insights
digest from persisted Competitor pack snapshots: the Auto-default rival's
review-count gap now and, where a preceding place-identity match exists,
review velocity since our last check.

**Architecture:** Deepen the existing `WeeklySummaryWorker` module with one
tenant-scoped read and private deterministic selection implementation. It
returns a small discriminated Competitor Delta value to the existing weekly
email template module, which owns escaped presentation copy. This adds no new
module or seam: the worker already owns weekly report inputs and the template
already owns conditional report rows.

**Intake contract:** `docs/superpowers/plans/feat-competitor-delta-539-intake.json`
(drift detector). RISK is high because the change touches `worker/`; no schema
or write path changes.

**Locked semantics:** `CONTEXT.md` section “Competitor Delta,” ticket #532,
wayfinder map #528, and the #539 cadence clarification. Ranking tracking is
biweekly, so velocity copy says “since our last check,” never “this week.”

**Precedents:**

- `worker/jobs/WeeklySummaryWorker.ts:loadWeeklyValueInputs` for scoped report
  reads and typed rendering inputs.
- `worker/jobs/summary-report-helpers.ts:loadLatestRankingSummary` for a compact
  read-model interface.
- `src/lib/notifications/email/templates/weekly-value-report.ts` for
  conditional ranking/intelligence report rows.
- The queued-SQL worker harness and `baseWeeklyParams` template fixture in the
  two existing test files.

**Blocking edges:** The single task has no blocking edge beyond shipped ticket
#538. Ticket #546 remains independent: it adds Named rival persistence and
connects the locked picked-rival dropout/fallback behavior after this
Auto-default probe ships.

**Reclassification checkpoint:** After the worker slice reached green, the
actual diff crossed the intake's 2× trigger because repeated Competitor pack
fixtures made the tests substantially larger than estimated. The user approved
a revised `+350/-10` estimate with unchanged risk, surface, architecture, and
behavior. Fixture builders should recover 70–90 lines after the complete
focused suite is green.

---

## Task 1: Competitor Delta from persisted pack to delivered digest

One tracer bullet crosses the database read, deterministic selection, report
input, and rendered email so every test proves owner-visible behavior through
an existing interface.

### Step 1 — RED: lock read and selection behavior in WeeklySummaryWorker tests

Extend `worker/jobs/__tests__/WeeklySummaryWorker.test.ts` with the promised
tests, using the existing queued SQL harness:

- `selects the Auto-default rival by nearest review-count gap with deterministic tie breakers`
- `degrades Competitor Delta through omit teaser and gap-only empty states`
- `parses NUMERIC competitor ratings returned by Postgres.js as strings`

The fixtures cover:

1. Settings read returns the first tracked keyword plus the active search
   location inputs. No keyword/location means `null` and no pack query.
   Coordinate-backed keys preserve the Postgres NUMERIC text representation
   exactly; they are never round-tripped through JS numbers.
2. The pack query is scoped by `business_id`, the primary keyword, and the
   current computed `search_location`, and returns at most the two latest
   snapshot dates.
3. Current self review count is the comparison baseline.
4. Auto-default ordering is: smallest positive gap; if none, closest
   non-positive gap (zero before behind); ties by `rank_position`, then
   `place_id`. A null `rank_position` sorts after every numeric rank.
5. `NULL` review counts/identities, empty titles, and self rows never become
   Auto-default rivals.
6. A preceding row must match the selected rival by `place_id`; otherwise the
   result is gap-only.
7. NUMERIC `rating` values arrive as strings and normalize to finite numbers
   or `null` at the read boundary, though rating remains absent from v1
   selection and copy.

Run the focused worker test and confirm the new assertions fail for the
missing behavior.

### Step 2 — GREEN: deepen WeeklySummaryWorker

In `worker/jobs/WeeklySummaryWorker.ts`:

1. Add private row/domain types and a discriminated report value:
   `null`, teaser, or rival report with `rivalName`, `gap`, and nullable
   `reviewVelocity`.
2. Read the first keyword with `tracked_keywords->>0` so this new path does not
   add another PgBouncer JSONB-string parsing carve-out. Compute the writer's
   current search-location key in SQL from the coordinates' NUMERIC text when
   present, otherwise use the configured `ranking_search_location`. Do not
   coerce coordinates through JS numbers: that would remove stored scale and
   silently miss the persisted series.
3. Read only the two latest Competitor pack dates for that exact
   `(business_id, keyword, search_location)` series. Keep the query directly
   tenant-scoped and bounded to the small persisted packs.
4. Normalize the Postgres.js NUMERIC rating string with `Number`, accepting
   only finite values.
5. Resolve the current self row, choose the Auto-default rival
   deterministically, calculate `gap = rival - self`, and calculate velocity
   only from a preceding `place_id` match.
6. Degrade to omit/teaser/gap-only exactly as the intake declares.
7. Add the resolved value to `WeeklyValueInputs` and pass it to
   `buildWeeklyValueReportHtml`.

Keep all selection implementation private to the existing worker module. Do
not create a future-facing Named rival interface before #546 supplies its
second concrete use.

Run the focused worker test until green.

### Step 3 — RED/GREEN: render and escape the line

Extend `src/lib/notifications/__tests__/email-templates.test.ts` first:

- `renders review velocity since our last check and the current review-count gap`
- `escapes the Competitor Delta rival name and teaser keyword`

Also cover positive, zero, and negative velocity grammar; a signed negative
gap for the behind-rival fallback; gap-only output; cadence-safe teaser output;
the exact “Auto-selected rival” disclosure; and omission for `null`.

Then update
`src/lib/notifications/email/templates/weekly-value-report.ts`:

1. Add the compact Competitor Delta discriminated value to
   `WeeklyValueReportParams`.
2. Render one conditional report row near the ranking row.
3. Escape rival names and keywords with the shared `escapeHtml` helper.
4. Prefix rival reports with `Auto-selected rival:` until ticket #546 supplies
   an owner-picked Named rival.
5. Use cadence-safe teaser language (“after our next check”), never “next
   week.”
6. Keep rating and rank out of all v1 copy and preserve signed gap values.

Run both focused suites until green.

### Step 4 — glossary and focused verification

Keep the `CONTEXT.md` cadence wording synchronized with the approved intake:
“since our last check,” not week-over-week/“this week.”

Run:

```text
pnpm exec vitest run worker/jobs/__tests__/WeeklySummaryWorker.test.ts src/lib/notifications/__tests__/email-templates.test.ts
```

Then commit the tracer bullet. The implementation summary must explain any
actual diff above the intake estimate or any path outside the signed surface;
otherwise neither is permitted.

---

## Verification and staging evidence

Run `scripts/verify-gate.sh`, then the high-risk review workflow and
`scripts/verify-gate.sh --review`. For staging, use one configured location
with at least two persisted pack dates and reconcile the delivered email
against `competitor_snapshots`:

- selected rival follows the Auto-default order;
- gap equals current rival count minus current self count;
- velocity equals current rival count minus the preceding matching row;
- rating strings are not displayed;
- an unmatched preceding rival degrades to gap-only.

No migration, external API call, or rollback beyond reverting the application
commit is involved.
