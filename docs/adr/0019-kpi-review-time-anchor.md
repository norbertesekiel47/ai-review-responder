# ADR 0019 — Reputation KPIs anchor on review time, not detection time

## Status

Accepted — 2026-08-10 (#688 grilling, owner-adjudicated); Decision 2 amended
2026-08-12 by #790. #688 is the deciding ticket on this question from map #667.
Supersedes the #675 intake's
"accepted as-is" holding position — that intake noted the consented import
would distort the KPIs and accepted it pending a decision; this ADR is the
decision.

## Context

The consented **Review import** (ADR 0015, spec
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md`) stores
up to 100 historical reviews in one pass, and every stored row carries
`detected_at` = import time. Every customer KPI in `src/lib/kpi/service.ts`
(`DashboardKpiSummary`) was keyed on `detected_at`. Issue #688 catalogued the
four distortions that follow:

1. **Volume spike.** Review volume MoM counts imported reviews in the import
   month: a 100-review import reads as +100 growth in one month.
2. **Trend pile-up.** The 8-week sentiment trend buckets every imported review
   into the import week — one spike bucket instead of a history.
3. **Response-rate drag.** Imported unanswered reviews land inside the
   response-rate window and drag the rate down. This one is deliberate and is
   kept (see Decision): from the #675 intake onward, the unanswered-import drag
   doubles as the nudge to go answer them.
4. **Negative time-to-respond.** `reconcileExternallyAnsweredReview`
   (`worker/jobs/zernio/zernio-ingest-shared.ts`) imports a pre-existing Google
   reply with its ORIGINAL timestamp, so `approved_at` can predate the review's
   `detected_at` and the TTR average ingests a negative duration. Measured on
   staging: 16 such rows, skewed by up to −2.9 years. Stated precisely: the
   extreme rows already fall outside the 30-day `approved_at` window filter, so
   the live damage is the bounded in-window case — but the class is open until
   filtered.

## Decision

Three parts, decided together at the #688 grilling:

1. **The reputation KPIs — review volume MoM, 8-week sentiment trend, avg
   star — bucket on the Review-time anchor `LEAST(review_date, detected_at)`.**
   Single owner: the `reviewTimeAnchor` lazy fragment in
   `src/lib/kpi/service.ts`, composed exactly like `detectedAtWindowFilter` —
   the fragment never contains FROM/JOIN or tenant-scope predicates, which stay
   written out literally in every query template for the tenant-scope audit.
   Location scope and account scope (`getLocationKpiSummary` /
   `getAccountKpiSummary`) receive identical treatment.

   **Why `LEAST` and not `COALESCE`.** Postgres `LEAST` ignores NULLs, so a
   NULL `review_date` falls back to `detected_at` for free — and it also clamps
   a clock-skewed **future** `review_date` to `detected_at`. Under a naive
   `COALESCE(review_date, detected_at)` a future-dated row lands in a week the
   trend's `generate_series` LEFT JOIN never generates, so it silently
   vanishes from the trend. The anchor can never exceed `detected_at`.

2. **Response rate AND the MonthlyImpactWorker digest stay on `detected_at`.**
   These are workflow KPIs — they answer "what happened on this account", not
   "what did customers say, and when". An import *is* account activity, and an
   imported unanswered review is meant to drag the rate: that is the #675
   nudge, preserved on purpose.

   **#790 legibility amendment.** Every owner-facing response-rate card states:
   "Response rate is based on reviews added to RepWorth in this period,
   including imported history." The metric keeps its workflow clock, but the UI
   may not present it as though it shares the adjacent reputation charts'
   Review-time anchor.

3. **Avg time-to-respond gains the validity filter
   `approved_at >= detected_at`** — an exclusion, not a clamp, composed into
   `ttrHandledWindowFilter`. A pre-existing Google reply's latency is never our
   response latency; the row contributes no sample, and the average can never
   go negative.

## Alternatives considered

### An import discriminator column (migration) — rejected

Mark imported rows with a provenance column and exclude them from the KPIs.
Rejected on two grounds:

- **Schema cost for a single consumer.** Provenance-by-column is deferred until
  a second consumer actually exists; today the KPI service would be its only
  reader, and the anchor gets the same answer from columns that already exist.
- **Exclusion makes the surfaces disagree.** Imported rows would be invisible
  in KPI volume while the **Reviews list** shows them as first-class inventory
  — the dashboard says 12 reviews, the list shows 112. Under the anchor,
  imported rows *participate*, in their true buckets.

### Accept as-is — rejected

The #675 intake's holding position. With zero production customers it costs
nothing today, but it ships a fake growth spike into the first GA customer's
first month — the volume card would read +100 in the import month for reviews
the business earned over years.

### TTR clamp-to-zero — rejected

Clamp negative durations to zero instead of excluding the row. Artificial
zeros read as faster-than-real response times, biasing the average downward on
exactly the accounts with imported history. An invalid sample is dropped, not
laundered.

## Consequences

- **No migration, no new index.** Pure read-path change over columns that
  already exist (`idx_reviews_business_review_date`, migration 031). Backout
  is reverting the PR; the 45-second KPI cache self-expires.
- **An import instantly yields a real historical trend.** A 100-review import
  redistributes into its true months and weeks the moment the cache turns
  over — the import becomes a feature of the dashboard rather than a
  distortion of it.
- **Week/month boundary drift for organic rows is accepted.** An organically
  detected review has `review_date ≈ detected_at`, so a row near a bucket
  boundary may shift one week or month relative to the old semantics. That is
  more truthful, not a regression.
- **Imported reviews older than a KPI window drop out entirely** — correct
  under review-time semantics; they are history, not recent performance.
- **Response-rate card copy names its denominator.** #790 keeps the
  `detected_at` workflow semantics and makes the mixed-clock dashboard legible
  with the Decision 2 explanation. Other KPI card copy is unchanged.
- **Glossary**: the term **Review-time anchor** is coined in `CONTEXT.md`
  alongside the Review-import cluster; the fragment doc comment in
  `src/lib/kpi/fragments.ts` cites this ADR.

## Addendum — 2026-08-11 (#757): one stack, one fragment owner

#688 applied this ADR to `src/lib/kpi/service.ts`, which nothing rendered. The
customer-visible dashboard reads `src/lib/dashboard/service.ts` +
`aggregate-queries.ts`, which still bucketed on `detected_at` — so a consented
Review import produced exactly the spike this ADR removes, on the only surfaces
owners see. #757 closes that gap (Pathfinder 2026-08-10 P1):

- The anchor fragments moved to **`src/lib/kpi/fragments.ts`**, now their single
  owner, enforced by a source audit in `fragments.test.ts` that fails if any
  other non-test file spells `LEAST(review_date, detected_at)`.
- **Single-location payload:** velocity, rating breakdown, avg star (current AND
  prior buckets, so `star_n_prior` and the delta move with them) and the
  sentiment trend are anchored.
- **All-Locations aggregate:** velocity and rating breakdown are anchored. It has
  no avg-star or sentiment-trend query; its review counters
  (`windowedReceived`/`windowedResponded`) stay on `detected_at` because they
  feed the account response rate.
- Unchanged everywhere: response rate (Decision 2), timeSaved (`approved_at`),
  the recent-review feed (`detected_at` = ingestion recency), all-time totals,
  pending counts.
- `getLocationKpiSummary`, `getAccountKpiSummary` and `GET /api/dashboard/kpis`
  were **deleted** — zero consumers. Their calendar-month volume MoM and TTR
  duration metrics have never rendered anywhere; when the deferred KPI-cards work
  ships it extends the dashboard payload composing the same fragments.

**Supersedes P1 item 1 on one point.** P1 required extracting four fragments;
only `reviewTimeAnchor` and `reviewTimeWindowFilter` were extracted. Once Stack A
is deleted, `detectedAtWindowFilter` and the TTR validity filter have zero
composers — Stack B's response rate stays literal per Decision 2, and Stack B has
no duration metric. Decision 3 (the TTR validity filter) is therefore **recorded
but no longer implemented in code**; it returns with the metric.

**Deferred, recorded here so it is not rediscovered as a surprise.** The relevant
indexes are composite — `idx_reviews_business_detected_at` (migration 010) and
`idx_reviews_business_review_date` (migration 031), both `(business_id, <ts>)`.
`LEAST(review_date, detected_at) >= …` is not sargable on either, so these reads
keep the `business_id` prefix but lose the timestamp as a range key: they become
prefix-scan-plus-filter. At the #474 Capacity target (250 locations, ~125
reviews/day) per-business row counts are small, and Stack A has run this way
since #688. Revisit with an expression index only if dashboard read latency
regresses — that is a migration, and this ADR's no-migration property is
deliberate. The All-Locations aggregate is the path to measure first: it scans
every active location of an account in one statement.

### Spec 11's launch-KPI clause is superseded, and what the deleted metrics contracted

Raised by the #757 branch's adversarial review. Spec 11
(`docs/superpowers/specs/2026-05-26-wave-3-visibility-ai-safety-design.md` §Spec 11)
is an **active** contract naming five launch KPIs. Deleting Stack A removed two
of them from the codebase entirely — calendar-month **review volume MoM** and
**average time-to-respond** — and the rendered dashboard has never had either.
That is a rollback of a decided contract, not merely dead-code removal, and
neither the Pathfinder P1 consolidation nor the #757 intake grilling checked
Spec 11 before adjudicating DELETE.

**Resolution: Spec 11's KPI clause is superseded on those two metrics only.** The
other three (response rate, avg star, sentiment trend) render today in the
dashboard payload. The two removed ones return when the deferred KPI-cards
product work ships, composing the same fragments. Tracked as **issue #789**; the
annotation on the spec file itself rides the post-merge documentation sweep.

**Decision 2 was amended by issue #790.** #757 was the first release in which
the reputation/workflow clock split became visible on one screen: a consented
import counts in full toward the `detected_at`-windowed response rate while
contributing little to the adjacent review-time charts. #790 keeps that
workflow semantic and the #675 unanswered-backlog nudge, but requires the
owner-facing denominator explanation recorded in Decision 2. Re-anchoring the
rate, adding an import discriminator, and building a separate imported-backlog
surface remain out of scope.

The behavioral contract is recorded here so it is recoverable from the decision
record rather than only from `git show f5151902:src/lib/kpi/service.ts`:

**Review volume MoM** (`reviewVolume`)
- **Calendar-month**, never the rolling `windowDays` lookback: `currentMonth` =
  anchor `>= DATE_TRUNC('month', NOW())`; `priorMonth` = anchor in
  `[DATE_TRUNC('month', NOW()) - 1 month, DATE_TRUNC('month', NOW()))`.
- Buckets on the **Review-time anchor** (Decision 1). Counts every non-deleted
  review regardless of `star_rating` — no NULL-rating exclusion.
- `deltaPct = round((current - prior) / prior * 100)`, and **null when
  `prior = 0`** — a delta is suppressed rather than shown as infinite growth.

**Average time-to-respond** (`averageTimeToRespondHours`)
- `AVG(EXTRACT(EPOCH FROM (resp.approved_at - r.detected_at)) / 3600.0)`,
  rounded to **1 decimal**, null when no sample.
- Measures against **`detected_at`, not the anchor** — response latency is
  workflow time (when we could first have acted), so it is deliberately not
  review-time. Only the *validity filter* below is anchor-adjacent.
- Filters: response status in the handled vocabulary, `approved_at IS NOT NULL`,
  **`approved_at >= r.detected_at`** (Decision 3), and
  `approved_at >= NOW() - windowDays` — note the window is on **`approved_at`**,
  not on the review.
- **Multiplicity asymmetry, the least obvious part of the contract:** TTR selects
  `FROM responses resp JOIN reviews r`, so a review carrying N handled responses
  contributes **N samples**. Response rate, by contrast, uses
  `COUNT(*) FILTER (WHERE EXISTS (...))` over `reviews`, so the same review
  counts **once**. Any reimplementation must preserve this or the two metrics
  will silently disagree about the same data.

**Shared across both** — 45-second fail-open Redis cache (read and write both
degrade to a fresh computation); account scope joins `businesses` with
`archived_at IS NULL`; `windowDays`/`trendWeeks` reach SQL only as bound
integers via `make_interval` (#403); `ratePct` and every rounded average return
**null on an empty sample**, never `0`.
