# Dashboard-redesign Docs IA Refresh (#345) Implementation Plan

> **For agentic workers:** This is a docs-only change. Steps use checkbox (`- [ ]`) syntax for tracking. No code, no migrations, no DB.

**Goal:** Stop the older `docs/design/dashboard-redesign/` artifacts (and the root `PLAN.md` they reference) from presenting the superseded IA — a live `/dashboard/insights` route and the reviews/needs-action queue living on the dashboard.

**Architecture:** Surgical supersede, not deletion. The FINAL/current IA source of truth is the **glance** spec `docs/superpowers/specs/2026-06-19-glance-dashboard-analytics-history-design.md`, which itself partly supersedes the intermediate "Overview / Reviews split" spec. The Warm Editorial *visual* system in `design-spec.md` is **still live** (referenced by `tokens.css` and `docs/design/README.md`), so we do **not** mark the whole doc dead — we add a scoped "IA superseded" banner pointing at the FINAL glance spec (chaining both supersession steps) and neutralize only the IA-specific lines. `index.html` (a static launcher mockup) and root `PLAN.md` get a banner + neutralized stale lines.

**Tech Stack:** Markdown + a single static HTML file. Verify gate: `pnpm lint && pnpm typecheck && pnpm test`.

---

## Decision (locked, self-resolved — no human in loop)

**Chosen: scoped supersede banner + surgical neutralization** (the issue's recommended default), with two refinements discovered during research:

- **The IA was superseded in TWO steps; banners must point at the FINAL state** (Codex review caught the first pass stopping at the intermediate state):
  1. `2026-06-19-dashboard-overview-reviews-split-design.md` (PR #347) removed `/dashboard/insights` (analytics folded into the dashboard) and moved reviews to `/dashboard/reviews`.
  2. `2026-06-19-glance-dashboard-analytics-history-design.md` (final) then made the dashboard a **glance** (reputation hero + intelligence brief + Reviews/Analytics doorways) and **moved trend/velocity/ranking analytics to a new `/dashboard/analytics` page** (confirmed live: `src/app/(authenticated)/dashboard/analytics/page.tsx`, `AnalyticsContent.tsx`, `AnalyticsLinkCard.tsx`).
  Banners therefore chain both steps and link the glance spec as authoritative; no copy may say analytics were "merged into the dashboard" as the current state.
- `design-spec.md`'s **visual** half is NOT superseded (both 2026-06-19 specs say "No change to the Warm Editorial visual system"; `src/app/(authenticated)/_styles/tokens.css:18,32` and `docs/design/README.md:14` still cite it as the live Console visual spec). So the banner is explicitly scoped: **"IA superseded; visual system current."** A blanket "this doc is dead" banner would have wrongly invalidated the live token source-of-truth references.
- `README.md` and `tokens.css` references to `design-spec.md` are **intentionally kept** — they point at the still-authoritative visual content, and the new banner disambiguates. They do not mention `/dashboard/insights` or reviews-on-dashboard, so they are not stale.
- Root `PLAN.md` is the original (PR2) plan that the 2026-06-19 specs supersede. It presents `/dashboard/insights` as the plan and is the "IA/behavior half" that `design-spec.md` links to. It gets a top banner recontextualizing its IA as superseded (chaining both steps), preserving the body as a historical record (no body rewrite).

## Current source of truth (do not edit — these are correct)

- `docs/superpowers/specs/2026-06-19-glance-dashboard-analytics-history-design.md` (FINAL/authoritative current IA)
- `docs/superpowers/specs/2026-06-19-dashboard-overview-reviews-split-design.md` (intermediate; partly superseded by the glance spec)
- `docs/superpowers/plans/2026-06-19-dashboard-overview-reviews-split.md`

These legitimately mention `/dashboard/insights` (describing its deletion). That is correct context and must remain.

## Files to touch

- Modify: `docs/design/dashboard-redesign/design-spec.md` — scoped IA-superseded banner + neutralize IA lines (~9-10, 21, 121-138, 184).
- Modify: `docs/design/dashboard-redesign/index.html` — visible banner + neutralize "needs-action queue" + Insights launcher card copy.
- Modify: `PLAN.md` — top IA-superseded banner pointing at the 2026-06-19 spec.

---

### Task 1: design-spec.md — scoped IA-superseded banner

**Files:**
- Modify: `docs/design/dashboard-redesign/design-spec.md`

- [ ] **Step 1:** Insert a banner block immediately under the title/status lines (after line ~4) that chains BOTH supersession steps and links the FINAL glance spec (`../../superpowers/specs/2026-06-19-glance-dashboard-analytics-history-design.md`) as authoritative: `/dashboard/insights` removed → analytics now on `/dashboard/analytics`, dashboard is a glance, reviews on `/dashboard/reviews`. The Warm Editorial **visual** system below remains the live Console source of truth.
- [ ] **Step 2:** Neutralize the IA references in the prose/tables so none presents `/dashboard/insights` as a live route or reviews-on-dashboard as current behavior:
  - Purpose line (~9-10): drop `/dashboard/insights` from the IA list, add "(IA superseded — see banner)".
  - Mockup table row (~21): mark `insights.html` row as archived/superseded IA.
  - "Dashboard landing — 4 zones" (~121-131): annotate that zone 3 (needs-action reviews) moved off the dashboard to `/dashboard/reviews`.
  - "Insights (`/dashboard/insights`…)" section heading (~133): convert to a superseded note.
  - Rollout step 2 (~184): mark the `/dashboard/insights` route item superseded.
- [ ] **Step 3:** Confirm every remaining `/dashboard/insights` string in this file sits inside a superseded annotation (none stated as live).

### Task 2: index.html — visible banner + neutralize stale launcher copy

**Files:**
- Modify: `docs/design/dashboard-redesign/index.html`

- [ ] **Step 1:** Add a visible banner under the page heading chaining both supersession steps and linking the FINAL glance spec: `/dashboard/insights` removed, analytics now on `/dashboard/analytics`, dashboard is a glance, reviews on `/dashboard/reviews`; these mockups are an archived visual exploration.
- [ ] **Step 2:** Edit the Dashboard launcher card copy: remove "needs-action queue" as current dashboard content.
- [ ] **Step 3:** Edit the Insights launcher card: mark it an archived/superseded screen (page no longer a live route).

### Task 3: PLAN.md — top IA-superseded banner

**Files:**
- Modify: `PLAN.md`

- [ ] **Step 1:** Insert a banner block immediately under the H1 stating its IA decision (secondary analytics → `/dashboard/insights`) is superseded, chaining both steps and linking the FINAL glance spec `docs/superpowers/specs/2026-06-19-glance-dashboard-analytics-history-design.md` — `/dashboard/insights` removed, analytics now on `/dashboard/analytics`, dashboard is a glance, reviews on `/dashboard/reviews`. Body retained as historical record.

### Task 4: Verify gate + cross-ref sweep

- [ ] **Step 1:** `rg -n "/dashboard/insights" .` — confirm every hit is either the 2026-06-19 source-of-truth files, or inside a superseded banner/annotation. No doc presents it as live.
- [ ] **Step 2:** `rg -n "dashboard-redesign/design-spec.md" .` and `rg -n "dashboard-redesign/index.html" .` — confirm `README.md`/`tokens.css` references remain valid (point at the still-live visual spec) and no dangling/misleading refs.
- [ ] **Step 3:** From the worktree root run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all green (docs change must not affect them).
- [ ] **Step 4:** Commit on `docs/345-dashboard-ia` referencing #345.

## Self-review

- Spec coverage: acceptance criteria #1 (updated/marked superseded with pointer) → Tasks 1-3; #2 (no doc presents insights/reviews-on-dashboard as current) → Tasks 1-3 + Task 4 grep; #3 (clean every cross-reference) → Task 4 grep of all three patterns.
- No placeholders.
- Decision documented above.
