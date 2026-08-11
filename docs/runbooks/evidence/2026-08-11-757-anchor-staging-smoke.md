# #757 — Review-time anchor: staging smoke evidence

**Run date:** 2026-08-11 · **Branch:** `feat-757-dashboard-review-time-anchor` ·
**Commit under test:** `4e614b6e` (staging `4e614b6e`, Vercel deployment
`dpl_DbZqoP8BvEH7P2EDAn6o9c9RSgnb`, READY, aliased to `staging.repworth.net`)

Executes Task 7 of `docs/superpowers/plans/2026-08-11-feat-757-dashboard-review-time-anchor.md`.
The locked intake names this the **only semantic backstop in production**: a syntactically valid
but semantically wrong anchor emits no Sentry signal, so the rendered payload has to be read.

**Verdict: PASS.** All five assertions hold. One assertion was strengthened mid-run after the
first pass came back non-discriminating (see §4). One pre-existing, unrelated defect was found
and ticketed as **#791** (§6).

---

## 1. Environment

| | |
|---|---|
| Staging Supabase | `RepWorth-staging`, project `kubdiqdhqbhwmqfditeg` |
| Account under test | `019fd4b6-6ff1-71bb-b329-087f7077b692` (owner `norbertliverpool+e7@gmail.com`, `trialing`, 2 locations) |
| Scratch location | **"Tanicia 2"** `019fef1b-a9e5-77a9-8e55-2599b812460e` — **0 pre-existing reviews** |
| Control location | "Terry Business" `019fd4b6-6fef-708c-b2b4-ef30917ef39b` — 29 reviews, untouched |
| Migration lockstep | n/a — #757 ships no migration |

**Why a 0-review scratch location:** the plan's assertions are stated as absolute numbers
(`ratingBreakdown.total` = 4, five distinct non-zero weeks). Seeding into a location with
pre-existing reviews would have forced baseline-delta arithmetic and weakened the read. The
2-location account still exercises the `?scope=all` aggregate and `perLocationVelocity[]`, and
the untouched sibling proves the combine step sums correctly.

### Deviations from the plan's Task 7 as written

- **`curl` replaced by an authenticated browser session.** `staging.repworth.net` sits behind
  Vercel SSO deployment protection — an unauthenticated `curl` is 307-redirected to
  `vercel.com/sso-api`, so the plan's `curl -b "$STAGING_COOKIE"` cannot reach the route at all.
  Payloads were fetched same-origin from an authenticated tab (`fetch(..., {credentials:'include'})`),
  which exercises the identical route, auth path and cache.
- **`?scope=<locationId>` used instead of a bare `GET /api/dashboard`.** The bare form resolves to
  the user's default location ("Terry Business", 29 reviews). `resolveDashboardScopePolicy`
  (`src/app/api/dashboard/policy.ts`) accepts a location id in `?scope=`, which targets the scratch
  location directly and keeps the absolute assertions valid.
- **A second seeding pass added one `responses` row** — see §4.

---

## 2. Fixture

Seeded per the plan, at exact **day** offsets (not `DATE_TRUNC('week', …)`, so window membership
is weekday-independent):

```sql
INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name,
                     provider_location_name, reviewer_name, star_rating, review_text,
                     sentiment_score, review_date, detected_at, status)
SELECT gen_random_uuid(), '019fef1b-a9e5-77a9-8e55-2599b812460e'::uuid, 'zernio',
       'smoke-757-' || d, 'zernio://smoke-757/reviews/' || d,
       'zernio://smoke-757/locations/1', 'Smoke 757', 4, 'anchor smoke',
       0.5,
       NOW() - (d || ' days')::interval,  -- true review time
       NOW(),                             -- import time = today
       'new'
FROM unnest(ARRAY[7, 14, 21, 28, 45]) d;
```

Resulting rows — every `detected_at` is the import day, `review_date` spans five ISO weeks:

| `provider_review_id` | `review_date` | ISO week start | `detected_at` | inside 30d review-time window? |
|---|---|---|---|---|
| `smoke-757-7`  | 2026-08-04 | 2026-08-03 | 2026-08-11 | yes |
| `smoke-757-14` | 2026-07-28 | 2026-07-27 | 2026-08-11 | yes |
| `smoke-757-21` | 2026-07-21 | 2026-07-20 | 2026-08-11 | yes |
| `smoke-757-28` | 2026-07-14 | 2026-07-13 | 2026-08-11 | yes |
| `smoke-757-45` | 2026-06-27 | 2026-06-22 | 2026-08-11 | **no** (inside the 8-week series, outside 30d) |

All 13 columns in the plan's `INSERT` were verified against the live staging schema before
seeding.

---

## 3. Captured payloads

Read after the 45s Redis payload cache (`dashboard:location:<biz>:30d:rep`) had elapsed.

### `GET /api/dashboard?scope=019fef1b-a9e5-77a9-8e55-2599b812460e`

```json
{
  "location": "Tanicia 2",
  "reviewVelocity": [
    {"week":"2026-06-22","count":1}, {"week":"2026-06-29","count":0},
    {"week":"2026-07-06","count":0}, {"week":"2026-07-13","count":1},
    {"week":"2026-07-20","count":1}, {"week":"2026-07-27","count":1},
    {"week":"2026-08-03","count":1}, {"week":"2026-08-10","count":0}
  ],
  "reputationSummary.trend": [
    {"week":"2026-06-22","starEquivalent":4,"reviewCount":1},
    {"week":"2026-06-29","starEquivalent":null,"reviewCount":0},
    {"week":"2026-07-06","starEquivalent":null,"reviewCount":0},
    {"week":"2026-07-13","starEquivalent":4,"reviewCount":1},
    {"week":"2026-07-20","starEquivalent":4,"reviewCount":1},
    {"week":"2026-07-27","starEquivalent":4,"reviewCount":1},
    {"week":"2026-08-03","starEquivalent":4,"reviewCount":1},
    {"week":"2026-08-10","starEquivalent":null,"reviewCount":0}
  ],
  "ratingBreakdown": {
    "counts":[{"stars":5,"count":0},{"stars":4,"count":4},{"stars":3,"count":0},
              {"stars":2,"count":0},{"stars":1,"count":0}],
    "total": 4
  },
  "reputationSummary.averageStar": {"current":4,"delta":0,"priorSampleSize":1}
}
```

Response rate, second pass (with one `posted` response on `smoke-757-45`):

```json
{
  "reputationSummary.responseRate": {"current":20,"delta":null,"priorSampleSize":0},
  "valueSummary": {"totalReviewsHandled":1,"totalTimeSavedMinutes":7,
                   "currentResponseRate":20,"baselineResponseRate":null}
}
```

### `GET /api/dashboard?scope=all`

```json
{
  "activeLocationCount": 2,
  "reviewVelocity (combined)": [
    {"week":"2026-08-03","count":1}, {"week":"2026-08-10","count":0},
    {"week":"2026-07-06","count":0}, {"week":"2026-07-13","count":3},
    {"week":"2026-07-20","count":3}, {"week":"2026-07-27","count":3},
    {"week":"2026-06-22","count":2}, {"week":"2026-06-29","count":0}
  ],
  "perLocationVelocity": [
    {"locationId":"019fd4b6-6fef-708c-b2b4-ef30917ef39b","displayName":"Terry Business",
     "velocity":[{"2026-06-22":1},{"2026-06-29":0},{"2026-07-06":0},{"2026-07-13":2},
                 {"2026-07-20":2},{"2026-07-27":2},{"2026-08-03":0},{"2026-08-10":0}]},
    {"locationId":"019fef1b-a9e5-77a9-8e55-2599b812460e","displayName":"Tanicia 2",
     "velocity":[{"2026-06-22":1},{"2026-06-29":0},{"2026-07-06":0},{"2026-07-13":1},
                 {"2026-07-20":1},{"2026-07-27":1},{"2026-08-03":1},{"2026-08-10":0}]}
  ],
  "ratingBreakdown": {
    "counts":[{"stars":5,"count":4},{"stars":4,"count":5},{"stars":3,"count":0},
              {"stars":2,"count":0},{"stars":1,"count":1}],
    "total": 10
  },
  "valueSummary": {"totalReviewsHandled":11,"totalTimeSavedMinutes":77,
                   "currentResponseRate":32,"baselineResponseRate":null}
}
```

---

## 4. Assertions

| # | Assertion | Result |
|---|---|---|
| 1 | **`reviewVelocity` shows five distinct non-zero weeks**, not a single spike in the current week | **PASS.** Weeks `06-22`, `07-13`, `07-20`, `07-27`, `08-03` each `count: 1`; the **import week `08-10` is `0`**. Under `detected_at` this would have been a single spike of 5 in `08-10`. This is the whole point of the change. |
| 2 | `reputationSummary.trend` spreads across those same weeks | **PASS.** `starEquivalent: 4` on exactly the five populated weeks, `null` on the three empty ones. |
| 3 | `ratingBreakdown.total` counts **4** of the seeded rows | **PASS.** `total: 4`, all in the 4★ bucket. The 45-day row is correctly excluded from the 30-day review-time window while remaining in the 8-week series. |
| 4 | `perLocationVelocity` shows the same five-week spread and the combined `reviewVelocity` agrees | **PASS on values.** Tanicia 2's slice matches the single-location payload exactly; combined = per-location sum on every week (`07-13`: 2+1=3, `06-22`: 1+1=2, `08-03`: 0+1=1, `08-10`: 0+0=0). Zero-fill survives — Terry Business keeps `08-03`/`08-10` zero rows, so the `LEFT JOIN … ON` anchor did not degenerate into an inner join. **Combined array *ordering* is wrong — pre-existing, see §6.** |
| 5 | `responseRate.current` reflects all five imports as received and none as handled — the workflow KPI is deliberately untouched by the anchor | **PASS, after strengthening.** See below. |

### Assertion 5 was strengthened mid-run

The first pass returned `responseRate.current: 0` on a location with **zero responses** — which is
0% under *either* anchor. The assertion as written was therefore **non-discriminating**: it could
not have caught a wrongly re-anchored response rate.

A second seeding pass added one `posted` response on `smoke-757-45` (the 45-day review, inside the
`detected_at` window but **outside** the 30-day review-time window). That makes the two hypotheses
produce different numbers:

| Hypothesis | received | handled | rate |
|---|---|---|---|
| Response rate on `detected_at` (**intended**) | 5 (all detected today) | 1 | **20%** |
| Response rate wrongly on the review-time anchor | 4 (45-day row excluded) | 0 (its review is out of window) | 0% |

**Observed: `responseRate.current = 20`.** Response rate is confirmed still keyed on `detected_at`,
matching `src/lib/dashboard/service.ts:485-511` (literal `r.detected_at >= NOW() - make_interval(…)`)
and the intake's `non_goals`.

**This run is also the first live demonstration of finding A2 / #790.** In that same payload the
period shows a **20% response rate** beside a `ratingBreakdown.total` of **4** that excludes the very
review the 20% is counting. The mixed clock is real and now owner-visible — exactly the legibility
question #790 carries. ADR 0019 Decision 2 stands until #790 concludes; nothing was changed here.

---

## 5. Cleanup

```sql
DELETE FROM responses WHERE review_id IN (SELECT id FROM reviews WHERE provider_review_id LIKE 'smoke-757-%');
DELETE FROM reviews WHERE provider_review_id LIKE 'smoke-757-%';
```

Verified in a **separate statement** — a data-modifying CTE and its outer query share one snapshot,
so counting residuals inside the delete statement reports the pre-delete numbers and looks like a
failed cleanup:

```
residual_smoke_reviews: 0   residual_smoke_responses: 0
tanicia2_reviews: 0         tanicia2_responses: 0
```

"Tanicia 2" is back to its pre-seed state. "Terry Business" was never touched.

---

## 6. Defect found: combined aggregate velocity is mis-ordered (#791, pre-existing)

The combined `reviewVelocity` array is ordered
`08-03, 08-10, 07-06, 07-13, 07-20, 07-27, 06-22, 06-29` — **alphabetical by month name**, not
chronological. Per-location series are correctly ordered.

**Mechanism.** `weekStart` is `String(row.week_start)` (`src/lib/dashboard/active-mappers.ts:25`,
`src/lib/dashboard/reputation-summary.ts:104`); postgres.js decodes the column to a JS `Date`, so
the string is `"Mon Jun 22 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"`.
`src/lib/dashboard/aggregate-service.ts:277` sorts those with `.localeCompare()`, which after the
shared `"Mon "` prefix orders by month name: `Aug` < `Jul` < `Jun`. That reproduces the observed
order exactly. Counts are correct; only the sequence is wrong.

**Not caused by #757.** `aggregate-service.ts` is not in this branch's diff, and the sort line dates
to `56636f91` (2026-05-10, PR #28). This smoke is simply the first close read of the combined series.

**Not fixed here.** Out of `allowed_edit_surface`, and #757's amendment budget is 2 of 2 — a third
trips the abort criteria. Filed as **#791** with the mechanism and a fix sketch.

This is the same family as the handoff's standing warning that `weekStart` is a stringified `Date`
(the `weekMarkers()` rule for week assertions). The durable fix is to stop round-tripping the week
through `Date.toString()` at the mapper and carry ISO `YYYY-MM-DD` end to end, which makes
`localeCompare` correct by construction.
