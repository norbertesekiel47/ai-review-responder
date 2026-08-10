# ADR 0019 — Reputation KPIs anchor on review time, not detection time

## Status

Accepted — 2026-08-10 (#688 grilling, owner-adjudicated). #688 is the deciding
ticket on this question from map #667. Supersedes the #675 intake's
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
- **KPI card copy is unchanged.** Zero production customers; the new semantics
  are the intuitive reading of the existing labels, so no microcopy rides this
  change.
- **Glossary**: the term **Review-time anchor** is coined in `CONTEXT.md`
  alongside the Review-import cluster; the fragment doc comment in
  `src/lib/kpi/service.ts` cites this ADR.
