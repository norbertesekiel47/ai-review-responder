# Glance Dashboard · Analytics Page · Reviews⊕History — Design Spec

**Date:** 2026-06-19
**Status:** Design (approved by owner — interview-locked)
**Author:** Norbert + Claude

## Context & lineage

RepWorth is notification-driven: owners approve drafts from WhatsApp/email links
and are *meant not to need* the dashboard. This spec sharpens three surfaces so
that intent holds.

It **builds on and partly supersedes** `2026-06-19-dashboard-overview-reviews-split-design.md`
(shipped as PR #347), which merged the old *Insights* page into the dashboard —
making today's dashboard a 6-zone "editorial stack" (reputation hero · pending
strip · intelligence brief · trend · velocity · ranking).

> **Supersedes** the overview-reviews-split decision to render the **trend,
> velocity, and ranking charts on the dashboard.** Those three move to a new
> **Analytics** page. The principle ("dashboard is a reputation/ROI overview, not
> a work queue") is preserved and taken one step further: **the dashboard is a
> two-second glance; depth lives on Analytics.** Everything else from PR #347
> (Reviews on its own page, the action strip, pending badge) stands.

### Problems this fixes (owner-stated)

1. The dashboard shows too much at once and "the graphs are very hard to
   understand." Cramming 6 zones fights the rarely-visited, reassure-at-a-glance
   goal — especially on the phone owners actually use.
2. Reviews and Past Replies feel like they conflict. The Reviews queue's "All
   Recent" tab duplicates (worse) what the Past Replies archive already does.

## Goals

- **Dashboard = glance.** A few large, legible signals + the full intelligence
  brief + one action doorway. Readable in ~2 seconds, whole on a phone.
- **Analytics = depth.** A new top-level page that re-homes the three charts and
  surfaces existing KPIs, with a **headline-first** design that states each
  metric's takeaway in plain English.
- **Reviews owns the whole review lifecycle.** `Needs Action` (the queue) and
  `History` (the Past Replies archive, moved verbatim) live as two tabs on the
  Reviews page. Past Replies retires as a standalone nav item.
- Ship **Past Replies + reply editing to production** (flag rollout), staging
  verified first.

## Non-goals / constraints

- **No backend/API changes for the UI work.** `/api/dashboard` already returns
  reputation, velocity, ranking, brief, reviews; `src/lib/kpi/*` already computes
  the KPIs Analytics shows. The `/api/dashboard/past-replies/*` edit endpoints
  **stay exactly where they are** (the edit drawer calls them by absolute path).
- **Past Replies is kept byte-for-byte.** Its server queries, `?page=`
  pagination, premium/`canEdit` gating, edit/recovery drawer, and both sections
  ("active period" / "before you joined") are **moved, not modified.** The only
  additions are a tab-bar line and the removal of its now-redundant
  "Back to dashboard" link.
- **No change to the Warm Editorial visual system** (bezels, gold stars, grain,
  Young Serif). The chart re-skin *adopts* its tokens; it does not change them.
- **Per-metric headlines are deterministic templates** computed from data already
  on the payload (e.g. `Up ${delta} spots this month`). The LLM is reserved for
  the holistic intelligence brief — no new LLM call sites, no cost-guard surface.
- Architecture invariants hold (CLAUDE.md): feature flags stay
  server-authoritative (#13), no `NEXT_PUBLIC_*` companion; Vercel UI-only (#1).

## Information architecture

### Navigation (final)

**Sidebar** (`Sidebar.tsx`): `Dashboard · Reviews · Analytics · Settings`
- **Remove** the standalone "Past Replies" item (now the Reviews → History tab).
- **Add** "Analytics" item.
- Active-state: `/dashboard/reviews` and `/dashboard/reviews/history` both
  highlight **Reviews**; `/dashboard/analytics` highlights **Analytics**;
  `/dashboard` (and other `/dashboard/*` not matched above) highlights Dashboard.

**Mobile tab bar** (`MobileTabBar.tsx`): `Home · Reviews · Analytics · Settings`
- **Remove** the standalone "History" tab (it becomes a sub-tab inside Reviews).
- **Add** "Analytics". Reviews keeps the pending badge.

### Routes

- **New:** `(authenticated)/dashboard/analytics/page.tsx` → `/dashboard/analytics`.
- **Moved:** `(authenticated)/dashboard/past-replies/` →
  `(authenticated)/dashboard/reviews/history/` (server `page.tsx`,
  `PastRepliesClient.tsx`, `loading.tsx`, `__tests__/`) — **verbatim** except the
  tab-bar line and the dropped TopBar back-link.
- **Redirect:** `/dashboard/past-replies` → `/dashboard/reviews/history`
  (permanent) via `next.config.ts` `redirects()`. (Only consumer today is the
  sidebar link, which we replace; redirect is hygiene for staging bookmarks.)

## Surface 1 — Dashboard (glance)

`DashboardContent.tsx`, active per-location branch. Reduce the editorial stack to:

1. Conditional banners (past-due, connect-Google) — unchanged.
2. **ReputationHeroBand** — the 3 hero signals (avg ★, response rate, time saved)
   + lifetime line. Unchanged component.
3. **IntelligenceBriefCard** (full-width) — the brief is the glance centerpiece.
4. **PendingApprovalsStrip** — action doorway → `/dashboard/reviews`. Unchanged.

**Removed from the dashboard** (relocated to Analytics): `ReputationTrendChart`,
`VelocityCard`, `RankingCard`, and the `.chart-row` wrapper.

`AggregateDashboardContent.tsx` follows the same rule:

1. Conditional banners — unchanged.
2. **AggregateKpiCards** (the aggregate headline).
3. **AggregateIntelligenceBriefCard**.
4. **PendingApprovalsStrip** (cross-location pending) → `/dashboard/reviews`.
5. **LocationKpiStrip** (per-location cards) — kept; it is glanceable, not a chart.

**Removed from aggregate** (→ Analytics): `AggregateVelocityCard`,
`AggregateRankingCard`.

> A "View analytics →" link is **not** required (Analytics is a nav peer), but a
> small secondary link at the foot of the dashboard is allowed if it reads well.

## Surface 2 — Analytics (depth, headline-first)

`(authenticated)/dashboard/analytics/page.tsx` renders a thin client wrapper
`AnalyticsContent.tsx` (mirrors the `ReviewsContent` pattern) using
`useDashboardData(currentScope)` — same cached payload, per-location and
aggregate. It renders the relocated chart components, each wrapped in the
**headline-first** layout:

```
┌──────────────────────────────────────┐
│ ▲ Up 2 spots this month               │   ← deterministic plain-English headline
│ You're #3 for "cafe near me"          │   ← one supporting sentence
│ ╰── chart (small, Warm Editorial) ──╯ │   ← evidence, not the message
└──────────────────────────────────────┘
```

Each metric leads with a headline derived from data already on the payload
(delta, current value). The chart is secondary.

### Chart defect fixes (apply during relocation)

1. **`ReputationTrendChart.tsx` — zoom the Y-axis.** Today it pins 1–5, which
   flattens the meaningful 4.x band. Compute the domain from the data
   (`[min−0.2, max+0.2]` clamped to `[1,5]`, minimum span ~0.6) so real movement
   is visible. Keep the empty state.
2. **`RankingChart.tsx` — de-spaghetti.** Render the owner's own series **bold in
   `--rw-sage-deep`**; competitor series faded/`--rw-app-text-soft`. Avoid the
   6-color rainbow for the owner-facing default. Keep the inverted-rank axis but
   add the headline ("Up N spots") so the owner never has to decode the axis.
3. **Re-skin to Warm Editorial tokens.** Replace hardcoded `#E5E7EB` gridlines and
   `#9CA3AF` axis text with `var(--rw-hair)` / `var(--rw-app-text-soft)`; series
   accents use sage tokens. No more Console-era grays on the warm surface.
4. **`VelocityCard.tsx`** — same headline-first wrap + token re-skin.

These are presentational; no data-shape changes.

## Surface 3 — Reviews ⊕ History

The Reviews page hosts two **routed** tabs (nav links, not `useState`) so the
server-rendered archive keeps its exact data model:

- `/dashboard/reviews` — **Needs Action**, the client queue (`ReviewsContent` →
  `ReviewsCard`). Default tab.
- `/dashboard/reviews/history` — **History**, the moved Past Replies server page.

### Tab bar — `src/components/dashboard/reviews/ReviewsTabs.tsx` (new)

- A presentational tab bar of two `<Link>`s: `Needs Action` (→ `/dashboard/reviews`)
  and `History` (→ `/dashboard/reviews/history`). Highlights the active tab.
- Rendered by **each** route directly under its existing `TopBar` (not a layout —
  this preserves each page's own TopBar; the history page keeps its title/subtitle
  verbatim).
- **Flag gate:** the `History` tab renders only when `historyEnabled` is true.
  This is read **server-side** (`PAST_REPLIES_VIEW_ENABLED === 'true'`) and passed
  down — never inferred client-side (invariant #13). The history route already
  `notFound()`s when the flag is off; the tab simply isn't shown when off, so the
  two stay consistent.
- The Reviews pending badge logic is unchanged.

### Drop "All Recent"

`ReviewFeedCard.tsx` — remove the in-card `[Needs Action | All Recent]` tab
machinery; render just the pending/needs feed. History (the full archive)
supersedes "All Recent." (`initialTab` / `tab` state and the All-Recent branch
are deleted.) Update `ReviewsCard` / `ReviewsContent` call sites accordingly.

### Multi-location History

History is single-location by construction (`history/page.tsx` reads
`owner.currentLocationId`; every query is `business_id`-scoped). In **aggregate
("all locations") scope** the History tab still shows **one** location's archive
(current/primary), switched by the existing sidebar `LocationPicker`. Add a small
`Showing: ‹location› ▾` affordance on the History view so the per-location vs
aggregate distinction is honest. No query changes.

## Feature-flag rollout (full send, staging-first)

All three flags go on; **staging first → verify the edit loop end-to-end → prod
the same day, Vercel + Railway in lockstep.** This is an ops step *after* the PRs
merge, not part of a PR.

| Flag | Reads | Effect |
|---|---|---|
| `EXTERNAL_REPLY_IMPORT_ENABLED` | Next.js | Inserts imported `posted` rows → fills History "before you joined." **Side effect: bumps the dashboard "answered %"** (imported replies count as handled). Accrues on re-ingestion, not an instant backfill. |
| `PAST_REPLIES_VIEW_ENABLED` | Next.js | Un-404s `/dashboard/reviews/history`; reveals the History tab. |
| `EDIT_REPLIES_ENABLED` | **Next.js AND Railway worker** | Enables editing posted replies (worker DELETE-then-POST). **Must be set in both** or split-brain. |

Prereqs: migration 031 confirmed applied on **both** Supabase projects. Verify
per `docs/runbooks/multi-location-e2e-full-loop.md`: edit a posted reply on the
staging sandbox profile, confirm DELETE-then-POST lands and the worker + Vercel
agree, before flipping prod.

> ⚠️ Editing a posted reply mutates a customer's public Google review and is
> **not reversible** by flipping the flag off. The staging dry-run is the guard.

`env-vars.md` rows for the three flags get their state updated when prod flips.

## Components: new / moved / modified / deleted

**New**
- `(authenticated)/dashboard/analytics/page.tsx`
- `src/components/dashboard/analytics/AnalyticsContent.tsx`
- `src/components/dashboard/reviews/ReviewsTabs.tsx`

**Moved (verbatim)**
- `(authenticated)/dashboard/past-replies/*` → `(authenticated)/dashboard/reviews/history/*`

**Modified**
- `DashboardContent.tsx` — glance stack (hero · brief · strip); remove trend/velocity/ranking + `.chart-row`.
- `AggregateDashboardContent.tsx` — remove aggregate velocity/ranking; keep KPI cards · brief · strip · location strip.
- `ReputationTrendChart.tsx`, `RankingChart.tsx`, `VelocityCard.tsx`/`RankingCard.tsx` — headline-first wrap + scale/skin fixes (now rendered by Analytics).
- `ReviewFeedCard.tsx` (+ `ReviewsCard.tsx`, `ReviewsContent.tsx`) — drop "All Recent".
- `reviews/history/page.tsx` — add `<ReviewsTabs active="history" historyEnabled />` under TopBar; drop the redundant "Back to dashboard" rightLink. (Otherwise verbatim from past-replies.)
- `reviews/page.tsx` — read `PAST_REPLIES_VIEW_ENABLED` server-side, pass `historyEnabled` into `ReviewsContent` → `ReviewsTabs active="needs"`.
- `Sidebar.tsx` — remove Past Replies, add Analytics, active-state logic.
- `MobileTabBar.tsx` — remove History tab, add Analytics.
- `next.config.ts` — `/dashboard/past-replies` → `/dashboard/reviews/history` redirect.
- `.claude/reference/env-vars.md` — flag states on prod flip.

**Deleted**
- The old `past-replies` route location (after the move).
- The "All Recent" tab code path.

## Edge cases

- **Flag off (pre-rollout):** History tab hidden; `/dashboard/reviews/history`
  404s; Reviews shows only Needs Action. No coverage gap that matters — the
  glance brief + queue cover current state.
- **Ramping / young account:** hero renders compact; brief block omitted when
  absent; Analytics charts show their empty states.
- **Read-only (past-due):** glance + strip + Reviews render; write actions
  disabled; History read-only.
- **Aggregate scope on History:** shows current/primary location with the
  "Showing:" label; LocationPicker switches.
- **Edit split-brain:** if `EDIT_REPLIES_ENABLED` is set in only one of
  Vercel/Railway, the edit UI and the worker disagree — the staging dry-run must
  assert both before prod.

## Testing / verification contract

- **Nav:** Sidebar renders `Dashboard · Reviews · Analytics · Settings` (no Past
  Replies); correct active state for `/dashboard/reviews`,
  `/dashboard/reviews/history`, `/dashboard/analytics`. MobileTabBar 4-tab set
  with Reviews badge, no History tab.
- **Dashboard:** composition test asserts hero · brief · strip present and
  trend/velocity/ranking **absent**; aggregate variant likewise.
- **Analytics:** renders the three charts (per-location) / aggregate variants;
  each has its headline; loading/error/empty states.
- **ReviewsTabs:** renders both tabs when `historyEnabled`, hides History when
  not; active highlighting; both are real links.
- **Reviews:** Needs Action feed renders; "All Recent" gone; History route
  renders the moved archive unchanged (reuse the existing past-replies tests at
  the new path).
- **Redirect:** `/dashboard/past-replies` → `/dashboard/reviews/history`.
- **Chart fixes:** trend domain zoom unit-tested; ranking owner-series styling;
  no hardcoded `#E5E7EB`/`#9CA3AF` remain in the chart components.
- **Full gates:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus
  `ci:static-policy`, `ci:analytics-events`, `ci:tenant-scope`, `ci:rls-audit`.

## Staged PR sequence

- **PR 1 — Reviews ⊕ History** (UI only, flag-gated; safe, independent): move
  past-replies → reviews/history, `ReviewsTabs`, drop "All Recent", Sidebar
  (remove Past Replies), MobileTabBar (remove History), redirect, multi-loc label.
- **PR 2 — Glance Dashboard + Analytics** (UI only): glance the dashboard +
  aggregate, new Analytics page, headline-first chart relocation + fixes, Sidebar
  (add Analytics), MobileTabBar (add Analytics). Branches from `main` **after**
  PR 1 lands (both touch Sidebar/MobileTabBar — sequence to avoid conflicts).
- **OPS — flag rollout** (post-merge): staging all three flags → verify edit loop
  → prod same-day, Vercel + Railway lockstep; update `env-vars.md`.

## Out of scope / future

- A reviews-only / analytics-only API endpoint (perf optimization).
- A true cross-location reputation hero / aggregate History (needs backend
  aggregation).
- Auth-pages redesign (tracked separately).
