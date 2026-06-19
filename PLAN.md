# Plan: Redesign the owner dashboard around reputation-health/ROI (single-location)
_Locked via grill — by Claude + Norbert · revised after Codex round 1_

## Goal
Rebuild the single-location owner dashboard so its primary job is **reassurance + proving subscription value** ("your reputation is improving, and you're getting time back"), with the pending-approval queue as a strong *secondary* action. Apply the 7 dashboard principles: a single dominant hero (composite reputation band, top), honest trend/comparison context on every number (no bare values, no decorative chart junk), an aggressively decluttered ~4-zone above-the-fold view, and one purpose-fit trend chart. Secondary analytics move to a new `/dashboard/insights` drill-down rather than competing on the landing view. Multi-location aggregate is explicitly a fast-follow, but every new piece is built to be reusable there.

## Approach

### A. Backend — one dashboard response, honest deltas
1. **Fold the reputation/hero metrics into the existing `/api/dashboard` response** (extend `src/lib/dashboard/service.ts` + `DashboardDataActive`), computed **after the same scope resolution** the dashboard already does — so the archived-location fallback (falls back to primary) is shared, not split against `/api/dashboard/kpis`'s 404 behavior. The UI consumes ONE dashboard response with ONE refresh. (`/api/dashboard/kpis` stays as-is for non-UI callers; the redesigned UI does not add a second fetch.)
   - **Opt-in, to protect the aggregate path:** gate the new work behind `getActiveDashboardData(id, { includeReputationMetrics: true })`. `getAggregateDashboardData` (which calls `getActiveDashboardData` **once per location** and already warns it's slow at 5+ locations) keeps the lighter path — it must NOT inherit the heavier hero-metric batch until the aggregate fast-follow.
2. Compute **prior-30-day-window** counterparts for each hero stat with **explicit per-metric window timestamps** (no generic "handled in 30 days"):
   - **Response rate** — denominator = reviews with `detected_at` in the window; numerator = those with an approved response whose `approved_at <= window_end` (so the prior-window rate reflects status **as of the prior window's end**, not "as of now" — late approvals don't retroactively inflate history). Prior window's `window_end` = current window's start.
   - **Average star rating** — windowed by `detected_at`; AVG(star) current vs prior.
   - **Time saved** — windowed by the **owner-approval timestamp** (handled count × per-review minutes), so delayed approvals land in the period they happened, not the period the review arrived.
   Prefer single windowed queries using `FILTER (WHERE ...)` for current/prior buckets to avoid doubling round-trips (respect `statement_timeout: 30_000`; keep the existing parallel-query pattern).
3. **Typed delta fields per metric, with units + sample size** — star rating in **rating points**, response rate in **percentage points**, time saved in **minutes/hours** (never a generic percent). Each delta carries the prior-period denominator/sample count so the UI can decide whether to show it.
4. **One shared pending-count helper.** Extract a single owner-visible pending-count function (count drafts awaiting approval, **excluding open `flagged_responses`**, scoped correctly) and call it in BOTH places that currently diverge: the `PendingCountProvider` seed in `src/app/(authenticated)/layout.tsx` (today a raw `responses WHERE status='pending_approval'` that includes flagged drafts and only counts `currentLocationId`) AND the `/api/dashboard` response. The strip and tabbar badge then read one authoritative count and cannot disagree or undercount.
5. Fetch the scoped **business/location `created_at`** (pass from the dashboard query or an explicit scoped age query) to drive the ramping rule in C — `getLocationKpiSummary` does not currently load creation time.
6. Extend `DashboardDataActive`/types backward-compatibly (don't break aggregate consumers). Add/extend service + route tests for delta math, units, sample sizes, pending count, and ramping.

### B. Frontend — new components (do NOT mutate shared `KpiCards`/`ValueKpiGrid`/`ReviewFeedCard`, still used by aggregate)
7. Consume the unified `/api/dashboard` response via the existing `useDashboardData` (single refresh that already re-fetches on approval success). **No sibling KPI hook.**
8. New **`ReputationHeroBand`** — full-width hero, top, blending avg star rating, response rate, time saved; each with its **typed, unit-correct delta** vs last 30 days and a good/bad color cue. Largest type, top-left emphasis (#3/#4). No sparklines.
9. New **`PendingApprovalsStrip`** — full-width action strip directly under the hero, shown only when the **SQL pending count** > 0 ("N drafts need your approval → Review now," scroll to reviews); quiet "all caught up" otherwise. Secondary, not hero.
10. Reviews zone: render the Needs-Action feed; demote "All Recent" via a **new prop / single-location variant on `ReviewFeedCard`** — do NOT change behavior for `AggregateReviewsCard`, which reuses the same component.
11. New **`ReputationTrendChart`** — clean SVG **line** chart of the 8-week `sentimentTrend`. **Honest labeling:** `sentimentTrend` is `AVG(sentiment_score)` on a −1..1 scale (from `sentiment.ts`), NOT a star series. Lock the mapping as the inverse of `classifySentiment`: **`starEquivalent = clamp(3 + 2 * averageScore, 1, 5)`**, with rating-less reviews treated as neutral (3.0); verify against `classifySentiment` during implementation. Label explicitly ("reputation trend, star-equivalent"); never present the raw −1..1 number as a star rating. Strip chart junk (no pulsing peak, no gradient fill, minimal gridlines — #6/#7).
12. Rewrite `DashboardOperationalContent` (`DashboardContent.tsx`) to render exactly 4 primary zones: hero band → approvals strip → Needs-Action reviews → reputation trend chart. Banners (past-due, connect-Google) stay conditional, above the hero. Stop using `Sparkline` on this path (leave it intact for aggregate).

### C. Empty / "ramping up" state (two independent rules)
13. **Per-metric delta suppression:** hide an individual delta arrow only when **that metric's prior-period denominator/sample is zero** (e.g. no prior-window reviews → no response-rate delta). A mature low-volume business still sees the deltas it has — fixes the "fewer than 3 sentiment weeks hides forever" trap.
14. **Account-level ramping copy:** drive the warm "Still building your baseline — trends appear after a few weeks" message off **location/account age** (`created_at`), NOT off sentiment-week count. **DOM/zone order is fixed in both states** (hero → approvals → reviews → trend); ramping does NOT reorder zones (avoids layout-shift + a second tested layout). Instead, while ramping the hero band renders **compact** (current values, no delta arrows, baseline copy) so the approvals/reviews zones naturally dominate attention. Test both the ramped and mature hero renders.

### D. New drill-down route
15. New **`/dashboard/insights`** route under `(authenticated)` reusing `VelocityCard`, `RankingCard`, `IntelligenceBriefCard`. **Gate it to per-location operational data** with explicit handling for aggregate / pending / cancelled shapes (aggregate lacks `latestBrief`; account-state shapes lack analytics fields) — don't blindly reuse the union type.
16. Add a **distinct "Insights" active branch** to `Sidebar.tsx` (currently every `/dashboard/*` except `past-replies` highlights "Dashboard") and a `MobileTabBar` entry, so nav active-state is correct.

### E. Verification
17. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (build is **required** — behavior-affecting Next.js route/layout changes). KPI SQL is in scope → `pnpm ci:tenant-scope` and `pnpm ci:rls-audit` are **required**, not optional. Update/extend `KpiCards.test.tsx`, `DashboardContent.test.tsx`, `MobileTabBar.test.tsx`, KPI/dashboard service + route tests, plus a new `/dashboard/insights` test. Responsive browser verification (desktop + mobile) of the redesigned dashboard. Land via PR (single-location scope), staging first (touches the dashboard data path).
18. **Query-cost gate (concrete, not "needs measurement"):** run `EXPLAIN (ANALYZE, BUFFERS)` on the new reputation-metric SQL against staging and confirm the end-to-end `/api/dashboard` (with `includeReputationMetrics`) stays within a defined timing budget (proposal: ≤ the current dashboard p95, and well under `statement_timeout`). If it regresses, fall back to `FILTER`-bucketed single queries or defer non-hero deltas.

## Key decisions & tradeoffs
- **Primary goal = reputation-health/ROI, NOT action-queue** (owner-chosen, contrarian). Risk: owners who log in *to act* find approvals one zone below the hero. Mitigation: the conditional `PendingApprovalsStrip` sits immediately under the hero + tabbar badge, both fed by the same SQL count.
- **Composite hero band, not a single synthetic score** — three honest, unit-correct stats in one prominent zone. Mild tension with strict #3 accepted; star rating is the visual anchor.
- **One unified `/api/dashboard` response (hero metrics folded in), not a second UI fetch** — chosen post-review to share scope/archived-location fallback and keep a single refresh path.
- **Real prior-30-day deltas with explicit per-metric timestamps + units** over cheap baselines — honest, unambiguous #4 context.
- **Aggressive declutter to 4 zones + new `/dashboard/insights`** — risk: discoverability of demoted analytics. Mitigation: distinct nav + tabbar entry.
- **Two-rule empty state** — per-metric suppression (zero prior sample) + age-based ramping copy.
- **Single-location first, new components only** — `KpiCards`/`ValueKpiGrid`/`Sparkline`/`ReviewFeedCard` stay intact for the untouched aggregate view; we add or prop-extend rather than mutate. Temporary visual inconsistency with aggregate accepted; fast-follow planned.

## Risks / open questions
- **Star-rating attribution honesty.** RepWorth controls responses, not star ratings. Hero copy frames star rating as "your reputation," never implies RepWorth *caused* movement. Exact copy open.
- **Sentiment→star mapping** — formula locked (`clamp(3 + 2·avgScore, 1, 5)`, rating-less = 3.0); residual risk is only that the label must not overstate precision (resolved by explicit "star-equivalent" labeling).
- **Query cost** — now gated by step 18 (`EXPLAIN ANALYZE` + timing budget on staging); fallback path defined. Residual: the exact budget number to enforce.
- **Ramping/age threshold** exact value (how many weeks of age before deltas/trend are "trustworthy").
- **Subscription/gated states.** Hero band must degrade gracefully for cancelled/pending_payment (reuse existing account-state screens).
- **Mobile** stacking order of the 3-stat hero band.
- **Time-saved per-review constant** — confirm the existing source of "minutes saved per review" so windowed time-saved matches the current lifetime figure.

## Implementation notes (non-blocking — from Codex round 3, plan APPROVED)
- **Scope the opt-in tightly.** `includeReputationMetrics: true` should be passed only from the dashboard **landing** path — other per-location `/api/dashboard` consumers (e.g. `/dashboard/connect`) must not pay the new metric cost, or accept+measure it explicitly.
- **Model the field as optional.** Add `reputationSummary?: …` to `DashboardDataActive` (aggregate / `includeReputationMetrics:false` won't populate it); `DashboardContent` presents it only on the redesigned per-location path and falls back otherwise.
- **De-duplicate the time-saved constant first.** Extract `MINUTES_SAVED_PER_RESPONSE` into one shared module before adding windowed time-saved math, so the windowed and lifetime figures derive from a single source.

## Out of scope
- Multi-location **aggregate** redesign (`AggregateDashboardContent` and friends) — fast-follow PR.
- Deleting demoted components or `Sparkline` outright (they move/stay for aggregate).
- Any new metric beyond what `DashboardDataActive` + `DashboardKpiSummary` data already provide (no new data sources).
- Changes to the approval/posting pipeline, notifications, or billing.
- Net-new charting library (keep hand-rolled SVG).
