# Spec 11 — Data, Analytics & BI

> **Goal:** Five customer-facing KPIs on dashboard home, per-location + roll-up reporting, PostHog as the internal BI source through $500k ARR, single source-of-truth event taxonomy.

---

## 1. Why this matters

Multi-location customers buy on reporting polish. Internal BI is how the founder makes non-anecdotal decisions. Both depend on a documented event taxonomy that doesn't drift — drift is the silent killer of analytics trust.

## 2. Current state (RepWorth)

- Owner dashboard redesigned (PR #27) — front-end ready to host new KPIs.
- Multi-location schema (migration 034) supports per-location roll-up.
- No documented `docs/analytics/events.md`.
- PostHog adoption unclear (referenced in CLAUDE.md MCPs only as "in use").
- No data warehouse.

## 3. Target state

### Customer-facing dashboard — 5 KPIs on home
| KPI | Definition | Time window |
|---|---|---|
| Response rate | `published_responses / received_reviews` | Last 30 days |
| Average star rating | `AVG(reviews.star)` | Last 30 days |
| Review volume MoM | (`this_month_count - last_month_count) / last_month_count` | Calendar month |
| Avg time-to-respond | `AVG(published_at - received_at)` | Last 30 days |
| Sentiment trend | Weekly sentiment score from LLM classifier; trend arrow vs. prior week | Last 8 weeks |

- Per-location filter on Growth+ tier.
- Roll-up on Scale tier (aggregate across all locations + per-location toggle).
- Export to CSV + PDF for marketing managers reporting upward.
- Build with `@tanstack/react-query` + server components; cache 5 min.

### Internal BI — PostHog as the spine
- Cohorts (signup week, vertical, ICP-fit score).
- Retention curves split by activation.
- Funnels: signup → activation, trial → paid, paid → expansion.
- Dashboards: weekly business review, NPS trend, top features by adoption.

Skip Hex/Mode until $1M ARR.

### Future: Metabase on read-replica
- Set up **Metabase + Supabase read-replica** when custom SQL needs exceed PostHog (likely at $250k ARR).
- Skip BigQuery + dbt + Fivetran until $500k ARR or a serious data hire.

### Event taxonomy
**Single source of truth: `docs/analytics/events.md`.**

Standard schema:
```yaml
- name: response_published
  description: A response was published to Google after owner approval
  fired_from: worker/jobs/publisher/publish.ts
  properties:
    - account_id: uuid (required)
    - business_id: uuid (required)
    - review_id: uuid (required)
    - response_id: uuid (required)
    - star_rating: int (required, 1-5)
    - hours_since_review: float (required)
    - llm_model: string (required)
    - is_first_for_account: boolean (required, drives activation)
```

Naming: `noun_verb_past_tense` (`response_published`, not `publishResponse`).

CI rule: any new `posthog.capture(...)` call without a corresponding entry in `events.md` fails the build.

### Sentiment classification
- Run cheap classifier (GPT-4o-mini batch) on every ingested review's text.
- Result: `sentiment_score ∈ [-1, 1]` and `sentiment_label ∈ {positive, neutral, negative}`.
- Store on `reviews.sentiment_score` + `sentiment_label`. Migration **047**.
- Weekly rollup table for trend chart.

### Reporting export
- Server-rendered PDF via **Puppeteer** or **react-pdf** (whichever lighter).
- CSV via streaming response (no in-memory buffering for large multi-location accounts).
- Async export for accounts > 100 locations: enqueue job → email link.

## 4. Implementation tasks

1. Write `docs/analytics/events.md` with the launch event set ([Spec 07](./07-observability.md)).
2. Add CI script `scripts/ci/posthog-events-audit.ts` that diffs `posthog.capture(...)` calls in code vs. doc entries.
3. Build `<DashboardKpiGrid />` component with 5 KPIs. SQL queries in `src/lib/repositories/kpi-repo.ts` (scoped by `account_id` — see [Spec 03](./03-multitenancy-isolation.md)).
4. Build per-location filter + roll-up toggle on dashboard.
5. Add `reviews.sentiment_score` + `sentiment_label` (migration 047). Backfill from existing reviews via one-time worker job.
6. Build CSV + PDF export. Async export for > 100 locations.
7. Add PostHog dashboards: signup funnel, activation rate, trial → paid, NPS, expansion MRR.
8. Add server-rendered analytics page `src/app/dashboard/analytics/page.tsx` (8-week sentiment trend, top performing locations, lowest-rating-review-needing-attention list).

## 5. Acceptance criteria

- [ ] `docs/analytics/events.md` exists with the launch event set; CI audit script blocks merges with undocumented events.
- [ ] 5 KPIs render on dashboard home, scoped per-account, within p95 < 1.5s.
- [ ] Per-location filter works on Growth+; roll-up on Scale.
- [ ] CSV + PDF export for an account with 50 locations completes < 30s.
- [ ] Sentiment classifier running on every new review; backfill complete.
- [ ] PostHog has the 5 core dashboards bookmarked.

## 6. Metrics

| Metric | Target |
|---|---|
| Event-taxonomy doc coverage | 100% |
| Dashboard load p95 | < 1.5s |
| Sentiment classifier latency | < 2s per review |
| Sentiment classifier cost / 1k reviews | < $0.10 |
| Per-location filter usage (Growth+) | ≥ 40% of MAU touch it |

## 7. Risks & mitigations

- **Risk:** Event taxonomy drifts as features ship fast. **Mitigation:** CI gate forces doc update with each new event.
- **Risk:** PostHog free tier exceeded at scale. **Mitigation:** monitor monthly event count; upgrade at 800k/mo trigger.
- **Risk:** PDF export memory blow-up for large accounts. **Mitigation:** async-export path; row-streaming CSV.

## 8. Dependencies & cross-links

- [Spec 01 — PMF](./01-product-market-fit.md) (activation event)
- [Spec 03 — Multi-tenancy](./03-multitenancy-isolation.md) (KPI queries scoped)
- [Spec 07 — Observability](./07-observability.md) (event taxonomy alignment)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (sentiment classifier cost)
- Code anchors: PR #27 owner dashboard redesign; `src/app/dashboard/*`
