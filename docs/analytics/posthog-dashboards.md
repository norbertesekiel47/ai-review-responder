# PostHog Dashboard Definitions

PostHog is the near-term internal BI spine (Spec 11). `docs/analytics/events.md`
is the event source of truth; this file documents the dashboards/insights we
build on those events, plus the customer-facing KPIs computed directly from
Postgres. Production dashboard creation is an external gate (see bottom).

## Customer KPIs (Postgres-computed, not PostHog)

These render from the dashboard payload (`src/lib/dashboard/*`, served by
`GET /api/dashboard`), scoped per-location or per-account — NOT from PostHog events.

> **Updated by #757 (2026-08-11).** This section previously pointed at
> `src/lib/kpi/*` (`DashboardKpiSummary`) and `GET /api/dashboard/kpis`. That stack had
> **zero consumers** and was deleted; the dashboard payload is now the one KPI path.
> Two of the five KPIs below went with it — see the deferred rows. Formally superseding
> Spec 11's launch-KPI clause is tracked in **#789**; ADR 0019's addendum holds the
> deleted metrics' full behavioral contract so they can be rebuilt faithfully.

Reputation KPIs bucket on the **Review-time anchor** `LEAST(review_date, detected_at)`
(ADR 0019) so a consented Review import lands in its true weeks. Workflow KPIs stay on
`detected_at` — an import is account activity.

| KPI | Source | Window | Clock |
|---|---|---|---|
| Response rate | `reviews` + handled `responses` | last 30 days | `detected_at` |
| Average star rating | `reviews.star_rating` | last 30 days | Review-time anchor |
| Rating breakdown | `reviews.star_rating` | last 30 days | Review-time anchor |
| Review velocity | `reviews` | weekly, last 8 weeks | Review-time anchor |
| Sentiment trend | `reviews.sentiment_score` | weekly, last 8 weeks | Review-time anchor |
| ~~Review volume MoM~~ | — | — | **Deferred — deleted in #757, tracked by #789** |
| ~~Average time-to-respond~~ | — | — | **Deferred — deleted in #757, tracked by #789** |

## PostHog dashboards (internal ops/product)

Built over the documented events in `docs/analytics/events.md`. Create these in
the PostHog UI (external gate); definitions below are the spec. Events marked
**(planned)** are not yet emitted — wire the dashboard once the event ships.

### 1. Activation funnel

All steps are emitted today (see `events.md`):

- `signup_started` → `email_verified` → `gbp_connect_started` → `gbp_connected`
  → `first_review_ingested` → `first_response_drafted` → `activation_completed`.
- Breakdown: by signup week (cohort).
- Insight: funnel conversion + median time-to-convert per step. Watch the
  `gbp_connected → first_review_ingested` and
  `first_response_drafted → activation_completed` drop-offs.

### 2. Pre-signup demo

- `sample_demo_started` → `sample_demo_to_signup` → `signup_started`.
- Insight: demo-to-signup conversion; where the public sample demo loses people.

### 3. Connect reliability

- `gbp_connect_started` vs `gbp_connect_failed`.
- Insight: GBP/Zernio connect failure rate and failure-reason breakdown.

### 4. Generation health (planned)

- `llm_generation_completed` **(planned)**, `llm_generation_flagged` **(planned)**.
- Insight (once emitted): generation volume, flagged rate, provider-fallback
  rate. Until these events exist, generation/flag health is observed via
  structured worker logs and the `api_costs` / `flagged_responses` tables.

## External gates

- Create the above dashboards in production PostHog.
- Confirm `POSTHOG_API_KEY` is set in production and event delivery is verified
  (the dispatch poller no-ops without it).
- Add the `llm_generation_*` events to `docs/analytics/events.md` + the code
  allowlist before building dashboard #4.
- Revisit Metabase / read-replica only when PostHog can no longer answer founder
  BI questions (Spec 11 explicitly defers these).
