# Spec 11 — Data, Analytics & BI

> **Goal:** Five customer-facing KPIs on dashboard home, per-location + roll-up reporting, PostHog as the internal BI source through $500k ARR, single source-of-truth event taxonomy.

> **🟢 Implementation status (Wave 3, 2026-05-27):** LAUNCH SLICE CODE-COMPLETE (backend). **Done (PR #100, migration 052):** deterministic per-review sentiment (`reviews.sentiment_*`, star-based `classifySentiment`, one-time back-fill). **Done (PR #101, open):** the five launch KPIs as a dedicated `DashboardKpiSummary` (response rate, avg star, review-volume MoM, avg time-to-respond, 8-week sentiment trend) in `src/lib/kpi/*`, scoped per-location + per-account; served read-only by `GET /api/dashboard/kpis` (auth + IDOR + subscription read-entitlement + scope-UUID validation). PostHog dashboard definitions in `docs/analytics/posthog-dashboards.md`; the typed event taxonomy + CI drift audit shipped in PR #93. **Deferred:** the visible dashboard KPI **cards** (UI follow-up) and CSV/PDF export; production PostHog dashboards + Metabase/read-replica remain external/later.

---

## 1. Why this matters

Multi-location customers buy on reporting polish. Internal BI is how the founder makes non-anecdotal decisions. Both depend on a documented event taxonomy that doesn't drift — drift is the silent killer of analytics trust.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Owner dashboard redesigned (`docs/superpowers/plans/2026-05-07-owner-dashboard-redesign.md`) — **already renders customer-facing KPI cards** (`KpiCards.tsx`, plus Velocity/Ranking/IntelligenceBrief cards). Some of this spec's "5 KPIs" likely already exist; reconcile before rebuilding.
- An **internal KPI dashboard already exists** at `src/app/admin/overview` (`/api/admin/overview/route.ts`) computing metrics **directly from Postgres** (pending outbox, failed jobs, cost/day, email health, response rate, churn-risk via `computeChurnRiskScore`). This is the de-facto internal BI today — there is no PostHog.
- Multi-location schema (migration 034) supports per-location roll-up.
- **No PostHog yet** (decided Step 0, install pending — see [Spec 01](./01-product-market-fit.md) §2a). PostHog is the BI spine; Metabase-on-replica is the later scale option (see §Future). No `docs/analytics/events.md`, no data warehouse.
- **No sentiment classifier.** `reviews` has `star_rating` but **no sentiment column**; `mock-generator.ts`'s `classifySentiment()` only maps stars → template pools (not a real classifier).

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

### Internal BI — PostHog as the spine (decided Step 0, [Spec 01 §2a](./01-product-market-fit.md))
> Today, internal BI is the Postgres-direct `admin/overview` dashboard. PostHog becomes the spine below; Metabase-on-replica is the later scale option once custom-SQL needs exceed PostHog (see §Future), not a replacement.
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
2. Add CI script `scripts/ci/analytics-events-audit.ts` that diffs analytics `capture(...)` calls vs. doc entries. **Requires adding a specialized analytics audit job on top of the base GitHub Actions CI** ([Spec 24](./24-devops-deployment.md)).
3. **First, audit the existing `KpiCards.tsx`** against the 5 KPIs — extend it, don't rebuild. SQL lives in an account-scoped query module (e.g. `src/lib/kpi/*`); there is **no** `src/lib/repositories/` layer ([Spec 03](./03-multitenancy-isolation.md) decision), so scope inline by `account_id`.
4. Build per-location filter + roll-up toggle on dashboard.
5. Add `reviews.sentiment_score` + `sentiment_label` (claims the next free migration number; head 042 — coordinate per README). Backfill from existing reviews via a one-time worker job.
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
- Code anchors: `src/app/(authenticated)/dashboard/*` (`KpiCards.tsx`), `src/app/admin/overview/*` + `/api/admin/overview/route.ts` (`computeChurnRiskScore`), `reviews` schema (migration 001)

## 9. Implementation in the current repo

- **Two KPI surfaces already exist** — customer-facing `KpiCards.tsx` and internal `admin/overview`. This spec's work is to (a) confirm the 5 customer KPIs against `KpiCards`, (b) add per-location filter/roll-up, (c) add CSV/PDF export, (d) add sentiment. It is **not** a from-scratch dashboard build.
- **KPI queries** go in an account-scoped `src/lib/kpi/*` module (inline `WHERE account_id`), consistent with the no-repository-layer decision; the existing `/api/admin/overview/route.ts` is the pattern to mirror.
- **Sentiment** is a worker job on the ingest path (gpt-4o-mini batch via the existing `src/lib/responses/generator.ts` LLM client + cost guard); write to the new `reviews.sentiment_*` columns inside ingest.
- **Event taxonomy + its CI audit** — analytics tool is decided (PostHog, §2a); the audit still needs a specialized job added to the existing base CI ([Spec 24](./24-devops-deployment.md)).
- **Export** (CSV stream / PDF) for >100-location accounts runs async as a worker job → emailed link, not in a Next.js route.

---
_Verified 2026-05-23 against migration head 042. Noted both KPI dashboards already exist; corrected the no-repository-layer path, the no-sentiment-column reality, PostHog-not-installed, and the CI dependency for the events audit._
