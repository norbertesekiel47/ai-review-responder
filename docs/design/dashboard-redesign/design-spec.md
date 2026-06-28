# Design spec — Warm Editorial dashboard

_Status: locked direction, pending implementation · 2026-06-18_
_Owner: Norbert + Claude · Visual companion to [`PLAN.md`](../../../PLAN.md)_

> **⚠️ IA SUPERSEDED (2026-06-19) — visual system still current.** The
> *information architecture* described below — a separate `/dashboard/insights`
> route and the needs-action reviews queue living on the dashboard — is **stale**.
> It was superseded in two steps:
>
> 1. The overview/reviews-split restructure
>    ([`2026-06-19-dashboard-overview-reviews-split-design.md`](../../superpowers/specs/2026-06-19-dashboard-overview-reviews-split-design.md),
>    PR #347) removed the `/dashboard/insights` route — folding its analytics
>    into the dashboard — and moved the reviews action queue to its own
>    `/dashboard/reviews` page.
> 2. The **final, current IA**
>    ([`2026-06-19-glance-dashboard-analytics-history-design.md`](../../superpowers/specs/2026-06-19-glance-dashboard-analytics-history-design.md))
>    then made the **dashboard a two-second "glance"** (reputation hero +
>    intelligence brief + a pending-approvals doorway to `/dashboard/reviews` +
>    an Analytics doorway) and **moved the trend / velocity / ranking analytics
>    to a new `/dashboard/analytics` page**.
>
> Net current state: `/dashboard` = glance · `/dashboard/analytics` = the
> charts/analytics · `/dashboard/reviews` = the review queue (with a History
> tab). `/dashboard/insights` is **not** a live route, the analytics are **not**
> on the dashboard, and reviews are **not** on the dashboard. **Read the glance
> spec (step 2) for the authoritative current IA.**
>
> The **Warm Editorial visual system** in this doc (tokens, fonts, double-bezel
> cards, gold stars, motion) is **NOT** superseded — it remains the live Console
> visual source of truth, cited by `src/app/(authenticated)/_styles/tokens.css`
> and `docs/design/README.md`. Both 2026-06-19 specs explicitly keep it unchanged.

## 1. Purpose & scope

This spec pins the **visual design system** for the owner dashboard redesign so it can
be ported into the real app. It is the *visual* half; [`PLAN.md`](../../../PLAN.md) is the
*data / IA / behavior* half (reputation deltas, ramping rules). Where they overlap, **this
spec wins on look, type, motion, and component styling** — but the original IA in PLAN.md
(4-zone landing, the now-removed `/dashboard/insights` route) is **superseded**; the current
IA lives in the 2026-06-19 spec linked in the banner above.

**Visual source of truth:** the static mockups in this folder, viewable via the local
preview (`python3 -m http.server` over `docs/design/dashboard-redesign/`):

| Mockup | Screen |
|---|---|
| `index.html` | Launcher |
| `dashboard.html` | Landing — 4 zones |
| `insights.html` | _(superseded IA — the `/dashboard/insights` route is gone; its analytics now live on `/dashboard/analytics`; see banner)_ |
| `settings.html` | Settings shell + Brand Voice panel |
| `states.html` | Banners, all-caught-up, ramping hero, regenerate limit-reached |
| `style-comparison.html`, `type-specimen.html` | Direction + typeface exploration (archive) |

**In scope:** the authenticated owner surface — shell (sidebar / top bar / mobile tab bar),
dashboard landing, settings, and adaptive states. (The original "insights" surface is
superseded — the `/dashboard/insights` route is gone and its analytics now live on
`/dashboard/analytics`; see banner.) **Out of scope** (this round):
auth pages, onboarding, marketing, admin, and the multi-location **aggregate** redesign
(PLAN.md fast-follow). The brand-design skill is intentionally **not** applied here.

## 2. Design language

**Warm Editorial.** Chosen to deliberately *not* read as a typical blue SaaS dashboard.

- **Display:** Young Serif — page titles, stat numerals, section/card headings **only**.
  Single weight (400), so it is display-only; never body or labels.
- **Body / UI:** DM Sans (already the product body font) for everything functional.
- **Field:** warm off-white `#FDFBF7` with a fixed whisper grain overlay (opacity ~0.045).
- **Accents:** sage `#97B3AE` / sage-deep `#5E7C76` (primary, positive), blush `#F2C3B9` /
  blush-deep `#A85F4E` (attention), warm gold `#D4A24C` (star ratings), terracotta `#B4493A`
  (danger — never pure red), violet `#8A76B8` (auto-approved provenance).
- **Surfaces:** double-bezel cards (outer tray `#F4EEE4` + inner core `#FFFDF9`), soft *warm*
  diffused shadows (never harsh black), concentric radii.

### Anti-slop hygiene (enforced by the `impeccable` hook, kept as rules)
- No over-used faces (Inter / Roboto / Fraunces / Geist / Plus Jakarta / Space Grotesk / Instrument Serif).
- No numbered section markers (`01/02/03`); no eyebrow-chip on every card.
- Em-dash discipline in body copy (≤2; prefer periods/commas).
- Motion only via `transform` / `opacity` / `filter` (GPU-safe); `backdrop-blur` only on fixed/sticky elements.

## 3. Design tokens → `tokens.css`

Port into `src/app/(authenticated)/_styles/tokens.css`. The file already namespaces a
**marketing ("Island")** palette and an **app ("Console")** palette — **remap the Console
section to Warm Editorial; leave the marketing palette untouched.** Add the new accent/shape
tokens. Authoritative values live in `assets/warm-editorial.css` (`:root`); the table below
is the mapping intent.

| Concern | Token (proposed) | Value | Replaces / notes |
|---|---|---|---|
| App background | `--rw-app-bg` | `#FDFBF7` (+ `--rw-field` radial wash) | was `#F9FAFB` gray-50 |
| Card tray / core | `--rw-tray` `#F4EEE4` · `--rw-card` `#FFFDF9` | | new (double-bezel) |
| Recessed panel | `--rw-recess` `#F7F3EC` | | inputs, AI-reply panel |
| Ink scale | `--rw-app-text` `#2A2118` · `-2` `#4A3F33` · muted `#6B5E50` · faint `#9C8E7E` | | was gray-900/500/400 |
| Hairlines | `--rw-hair` `rgba(80,60,40,.08)` · `--rw-hair-2` `.14` | | was `#E5E7EB` |
| Primary accent | `--rw-sage` `#97B3AE` · `--rw-sage-deep` `#5E7C76` (+ soft/line) | | **remap `--rw-blue-*` usages** |
| Attention | `--rw-blush` `#F2C3B9` · `--rw-blush-deep` `#A85F4E` (+ soft) | | reuse existing `--rw-attn-*` |
| Stars | `--rw-gold` `#D4A24C` | | mockup uses warm gold for recognizability |
| Danger | `--rw-danger` `#B4493A` (+ soft) | | was `--rw-red-*` |
| Auto provenance | `--rw-violet` `#8A76B8` | | reuse `--rw-auto-*` slot |
| Display font | `--rw-font-display` | `'Young Serif', ui-serif, Georgia, serif` | **was Plus Jakarta Sans** |
| Body font | `--rw-font-body` | `'DM Sans', …` | unchanged |
| Radii | `--rw-radius-card` 24 · core 18 · sm 12 · pill | | concentric: core = card − pad(6) |
| Shadow | `--rw-sh-1/-2/-pop` warm diffused | | replace `--rw-shadow-*` on app surfaces |
| Motion | `--rw-ease-spring` `cubic-bezier(.32,.72,0,1)` · `--rw-ease-out` `cubic-bezier(.22,1,.36,1)` | | |

> **Migration cost flag.** Several dashboard components use **literal Tailwind hex** inline
> (e.g. error states `#FEF2F2`/`#991B1B` in `DashboardContent.tsx`, the save button
> `var(--rw-blue-600)` in `SettingsShell.tsx`). The port must sweep these to the warm tokens;
> grep for `#`, `blue-`, `gray-`, `green-`, `red-` under `src/components/dashboard` and the
> `_styles/*.css` files. Track as part of the visual-layer task, not the structural one.

## 4. Fonts & loading

- Add **Young Serif** to the `next/font/google` import in
  `src/app/(authenticated)/layout.tsx` (currently imports `Plus_Jakarta_Sans` + `DM_Sans`).
  Replace Plus Jakarta with Young Serif mapped to `--rw-font-display`; keep `DM_Sans` →
  `--rw-font-body`. Young Serif ships a single weight (400) — request `weight: ['400']`.
- Because the display face is single-weight, **all weight/hierarchy below H-level headings
  comes from DM Sans** (500/600/700). Do not fake-bold Young Serif.
- Public/marketing surfaces keep Plus Jakarta (their tokens are separate) — confirm no
  shared import breaks.

## 5. Component primitives

Translate `assets/warm-editorial.css` into the app's existing CSS files
(`_styles/console.css`, `_styles/settings.css`) — **not** a new Tailwind utility sprawl.
Keep the existing class-based architecture.

- **Double-bezel** (`.bezel` > `.core`): every major card. Outer tray + inner core + inset highlight.
- **Buttons:** `.btn-primary` (espresso ink), `.btn-sage`, `.btn-ghost`, `.btn-quiet` (tertiary, e.g. Regenerate), `.btn-danger`. **Button-in-button:** trailing arrow/check in its own nested circle (`.btn-icon`) that translates diagonally + scales on hover; whole button `active:scale(.975)`.
- **Badges:** `pending` (blush), `posted` (sage), `auto` (violet).
- **Stars:** warm gold filled / `#E3DCCF` empty.
- **Deltas** (`.delta` up/down/flat): pill with arrow; sage = good, blush = bad — honest, unit-carrying (rating points / points / hrs). Hidden while ramping.
- **Form controls:** `.textarea`/`.input` (recessed, sage focus ring + 3px halo), `.tone-chips`/`.chip` (sage selected), `.list-editor` (rows + delete + "Add another").
- **Save-bar:** sticky pill, blurred, "N unsaved changes · Discard / Save" — maps to existing `SettingsShell` save-bar markup.

## 6. Per-screen component mapping

Legend: **CSS** = restyle only · **NEW** = new component (per PLAN.md) · **PROP** = prop-extend shared component · **DATA** = needs PLAN.md `reputationSummary`.

> **IA note:** The component-styling intent in these tables is still useful, but the
> *placement* rows that reflect the old IA are superseded by the 2026-06-19 specs.
> Per the final (glance) IA: the nav is `Dashboard · Reviews · Analytics · Settings`
> (no Insights entry); the needs-action reviews queue is **not** a dashboard zone
> (it lives on `/dashboard/reviews`); and the trend / velocity / ranking charts are
> **not** dashboard zones either (they live on `/dashboard/analytics`). The glance
> dashboard keeps only the reputation hero, the intelligence brief, and the
> pending-approvals + Analytics doorways. Treat the placement rows as visual
> reference only.

### Shell (global — affects every authenticated screen)
| Mockup piece | Real file | Type |
|---|---|---|
| Sidebar (brand, nav, user chip) + **new "Insights" entry** | `src/components/dashboard/shell/Sidebar.tsx` | CSS + PLAN.md step 16 (nav branch) |
| Top bar | `src/components/dashboard/shell/TopBar.tsx` | CSS |
| Mobile tab bar + **Insights / Approvals entries** | `src/components/dashboard/shell/MobileTabBar.tsx` | CSS + PLAN.md step 16 |
| Shell wrapper / field bg / grain | `(authenticated)/layout.tsx` + `_styles/console.css` | CSS |
| Icons (ultra-light line) | `src/components/dashboard/shell/Icon.tsx` | CSS/extend set (regenerate, insights, etc.) |

### Dashboard landing — 4 zones (`DashboardContent.tsx` `DashboardOperationalContent`)
| Zone | Mockup | Real component | Type |
|---|---|---|---|
| Banners (above hero) | connect / past-due | `account-state/ConnectGoogleBanner.tsx`, `SubscriptionStatusBanner.tsx` | CSS |
| 1 · Reputation hero band | 3 stats + deltas | **`ReputationHeroBand`** (new) — replaces `KpiCards` on this path | NEW + DATA |
| 2 · Pending approvals strip | blush strip / calm | **`PendingApprovalsStrip`** (new) | NEW + DATA (SQL pending count) |
| 3 · Needs-action reviews _(superseded — moved off the dashboard to `/dashboard/reviews`)_ | queue + Approve/Edit/**Regenerate** | `reviews/ReviewsCard.tsx` + `ReviewActions.tsx` (+ single-loc variant of `ReviewFeedCard`) | CSS + PROP |
| 4 · Reputation trend _(superseded — moved off the dashboard to `/dashboard/analytics`)_ | clean line, star-equivalent | **`ReputationTrendChart`** (new) — replaces `VelocityCard` on landing | NEW + DATA |

> Shared `KpiCards` / `ValueKpiGrid` / `Sparkline` / `AggregateReviewsCard` **stay intact**
> for the untouched aggregate view (PLAN.md). The landing uses the new components.

### Insights _(SUPERSEDED — no longer a route per the 2026-06-19 specs)_
`/dashboard/insights` is gone. Velocity and ranking (plus the reputation trend) now render on
the new **`/dashboard/analytics`** page; the intelligence brief stays on the glance dashboard.
Mapping kept for visual reference only.

| Mockup | Real component | Type |
|---|---|---|
| Velocity bars | `kpi/VelocityCard.tsx` | CSS (reuse) |
| Local ranking | `kpi/RankingCard.tsx` | CSS (reuse) |
| Intelligence brief | `kpi/IntelligenceBriefCard.tsx` | CSS (reuse) |

### Settings (`SettingsShell.tsx` + panels)
| Mockup | Real component | Type |
|---|---|---|
| Tab bar (General · Brand Voice · Auto-approval · Notifications · Security) | `shell/SettingsTabs.tsx` | CSS |
| Section cards (icon chip + title + sub) | `settings/*Panel.tsx` | CSS |
| Tone chips | `settings/ToneChipPicker.tsx` | CSS |
| List editor | `settings/ListEditor.tsx` | CSS |
| Save bar / saved toast | `settings/SettingsShell.tsx` | CSS |

## 7. States (all in `states.html`)

| State | Owner | Notes |
|---|---|---|
| Connect-Google banner | `ConnectGoogleBanner.tsx` | blush, above hero |
| Past-due banner | `SubscriptionStatusBanner.tsx` / `PastDueBanner` | terracotta, 7-day grace (invariant #11) |
| All caught up | `PendingApprovalsStrip` (calm) | sage, no CTA, pending = 0 |
| Ramping hero | `ReputationHeroBand` (compact) | current values, **no delta arrows**, baseline copy; zone order unchanged (PLAN.md #14) |
| Regenerate limit reached | `ReviewActions.tsx` (`kind:'limit'`) | gold "heads up" + Back link, replaces action row (issue #335) — **not** a red error |
| Loading / error | existing skeleton + error card in `DashboardContent.tsx` | restyle to warm tokens |

## 8. Motion

- Entry: `reveal` → fade-up + de-blur (`translateY(18px)`, `blur(6px)` → 0) over ~800ms `ease-spring`, staggered ~80ms within a group. Maps to the existing `.section-enter` convention in `DashboardContent.tsx`.
- Velocity bars grow via `transform: scaleY()` (bottom origin) — **not** height.
- Trend line draws via `stroke-dashoffset`.
- Button-in-button hover physics; `active:scale(.975)`.
- Live pill pulse (sage ring).
- **`prefers-reduced-motion`:** all of the above resolve to final state, no transition.

## 9. Accessibility & responsive

- **Contrast (verify on port):** espresso ink `#2A2118` on cream is ~13:1 (AAA). Audit muted
  `#6B5E50` / faint `#9C8E7E` on `#FFFDF9`, sage-deep on white, and gold/blush badge text —
  target ≥4.5:1 for text, ≥3:1 for large/UI. Adjust faint usages that fail.
- Focus-visible rings (sage) on all interactive elements; settings tabs keep roving-tabindex +
  arrow-key nav already in `SettingsTabs.tsx`.
- Preserve existing `LiveRegion` announcements (dashboard load, settings saved/save-error).
- Star rating + trend chart carry text/`aria-label` equivalents (chart has `role="img"` + label in mockup).
- Touch targets ≥44px on mobile; tab bar + save-bar coexist (save-bar offsets above tab bar).
- Breakpoint: shell collapses to single column + floating glass bottom tab bar < 960px; bento → single column; settings tabs scroll horizontally.

## 10. Rollout sequencing

1. **Visual layer (global, low-risk, no data):** tokens.css remap + font swap + shell/Sidebar/TopBar/MobileTabBar + shared card/button/badge/form/save-bar styling + literal-color sweep. Affects single-location **and** aggregate **and** settings — they simply look Warm Editorial. Ships behind no new data.
2. **Structural layer (single-location, per PLAN.md):** new `ReputationHeroBand` / `PendingApprovalsStrip` / `ReputationTrendChart`, the `DashboardContent` rewrite, `ReviewFeedCard` single-loc prop. Needs PLAN.md backend (`reputationSummary` deltas, shared pending-count helper). _(IA superseded: the original `/dashboard/insights` route + nav was dropped; per the 2026-06-19 specs the analytics now live on `/dashboard/analytics`, the dashboard is a glance, and reviews moved to `/dashboard/reviews`.)_
3. **Aggregate fast-follow:** restyle aggregate components to the warm system + bring the 4-zone structure to the aggregate view (separate PR).

Land via PR, staging first (touches the dashboard data path). CI green incl. `pnpm build`,
`ci:tenant-scope`, `ci:rls-audit` (per PLAN.md step 17–18).

## 11. Open decisions to confirm

- **Star color:** mockup uses warm gold `#D4A24C` (recognizable). The existing product uses a
  deliberate **sage** star (`--rw-star`, "intentionally teal, not yellow"). Confirm gold vs sage.
- **Young Serif single weight** — accept display-only usage, or pick a 2-weight editorial face
  if more heading hierarchy is wanted.
- **Aggregate timing** — restyle aggregate in the visual-layer PR (consistent look immediately)
  or defer entirely to the fast-follow (temporary inconsistency, per PLAN.md)?
- **Contrast** — final values for `faint`/`muted` text after the audit.

## 12. Out of scope

Auth pages, onboarding, marketing, admin; new metrics/charts beyond PLAN.md data; the approval/
posting pipeline, notifications, billing; a charting library (keep hand-rolled SVG).
