# Launch Ready P2 Polish — audit points 24–28

> **Date:** 2026-05-29
> **Source:** `docs/launch-ready-part2.md` → "Prioritized fix list" → **P2 — Polish**, items 24–28 (lines 161–165).
> **Brand authority:** `~/.claude/skills/repworth-brand-design/SKILL.md` (color tokens, typography scale, tap-target guidance).
> **Scope:** Presentational / accessibility polish only. No behavior, data, routing, or copy-semantics changes except where explicitly noted.

---

## Goal

Close the five remaining P2 polish items as one cohesive PR, subagent-driven. Each item touches a mostly-disjoint set of files, so they decompose into independent tasks. Where behavior is testable, add a TDD / contract test that locks the fix.

## Decisions locked (from brainstorming)

1. **Point 24 — logo only.** Only the SiteNav logo (a real static asset) converts to `next/image`. The 5 QR codes are runtime `data:` URLs that `next/image` cannot optimize, so they stay `<img>` with an honest one-line rationale + correct eslint-disable. No `dangerouslyAllowSVG` in `next.config` — the logo `<Image>` uses `unoptimized` to skip the SVG-optimizer path.
2. **Point 28 stars — everywhere + guard test.** All 16 review-star glyph colors (Console, marketing, auth-island, **and** admin) move to brand teal `#97B3AE`. The Console token `--rw-yellow-500` is renamed `--rw-star`. A contract test bans yellow star colors going forward.
3. **Point 27 ARIA — correct route-nav semantics.** Settings tabs and MobileTabBar are `<Link>` route navigations, so the truthful ARIA is `aria-current="page"`, **not** in-page `role="tab"` semantics. Settings tabs additionally get roving-tabindex + ←/→ arrow-key navigation.

## Non-goals

- No redesign of any page. Typography point (26) adjusts scale/color only.
- No new owner/admin features. No changes to QR generation, MFA, auth, or routing logic.
- No touching of yellow **status badges** (e.g. `past_due`, `pending_*`) — point 28 is strictly about the star **glyph** color, not status semantics.

---

## Current-state facts (verified)

| Item | Fact |
|---|---|
| 24 | 6 `<img>` total. `SiteNav.tsx:42` logo (`/Logo - SVG.svg`, eslint-disabled). 5 QR data-URLs: `settings/security/SecurityClient.tsx:276` (**not** disabled — the lone lint warning), `OwnerWhatsAppWidget.tsx:81`, `OwnerTelegramWidget.tsx:81`, admin `WhatsAppEnrollmentWidget.tsx:40`, admin `TelegramEnrollmentWidget.tsx:38` (these 4 already disabled). `next.config.mjs` has no `images` block. Disk file is literally `public/Logo - SVG.svg` (spaces). `public/Logo - PNG.png` also exists. |
| 25 | `console.css` `.kpi-grid` = 3-col (`.has-pending` 4-col); only `@media (max-width:768px)` → 2-col exists. `past-replies.css` `.pr-stats` = 4-col; only `@media (max-width:768px)` → 2-col. No tablet (769–900px) breakpoint either place. |
| 26 | `(public)/security/page.tsx`: h1 `text-3xl`, h2 `text-xl`, body `text-sm text-[#4a4a4a]`. `legal/LegalPage.tsx`: h1 `text-3xl`, body `text-sm` color `#4a4a4a`; table first-col `whitespace-nowrap` (correct, keep). |
| 27 | `SettingsTabs.tsx`: `<Link role="tab" aria-selected>` in a `<div role="tablist">` — anti-pattern for route links; no arrow-key nav. `MobileTabBar.tsx`: `<Link>` in a bare `<nav className="mobile-tabbar">`, no ARIA. Tap targets below 44×44: EditReplyDrawer close `px-2 py-1` (~24px), `.mtab` `padding:8px 4px`, `PageShell`/marketing dot-nav `w-3 h-3` (12px). |
| 28 | Settings loading = `<p>Loading settings…</p>` (`SettingsClient.tsx:48`; same pattern in `VoiceClient.tsx:39`, `ChannelsTabClient.tsx:93`). Zero-replies empty state **already exists & branded** (`PastRepliesClient.tsx` `Empty()` → `.pr-empty`), but its icon uses `--rw-blue-*`. `admin/runbook/page.tsx:87` root `<div>` lacks `min-h-screen`. `--rw-yellow-500` is used **only** for stars (safe to rename). |

### Star locations (point 28, all → `#97B3AE`)
- Console (token-driven): `tokens.css:73` token def, `console.css:697 .stars`, `past-replies.css:79 .pr-chip-stars`, `PastRepliesClient.tsx:275` inline `var(--rw-yellow-500)`.
- Console (Tailwind): `EditReplyDrawer.tsx:118 text-yellow-500`.
- Marketing: `globals.css:79`, `globals.css:278 .rw-demo-stars`, `globals.css:1488 .hiw-feed-stars` (`#EAB308`); `HowItWorksContent.tsx:288` inline `#EAB308`; `FeaturesContent.tsx:302,499,595 text-yellow-400`.
- Auth: `auth-island.css:51 .rw-pcard-stars`, `auth-island.css:93 .rw-review-stars` (`#eab308`).
- Admin: `ReviewsList.tsx:55`, `ZernioConnectionPanel.tsx:247` (`text-yellow-500`).

---

## Design by point

### Point 24 — `next/image` for the logo

- **Rename** `public/Logo - SVG.svg` → `public/logo.svg`. **Pre-step:** grep every reference to `Logo - SVG.svg` (and `Logo - PNG.png` if touched) across `src/`, `public/`, and config (`next.config`, manifest, favicon, OG metadata); update all. Only rename the PNG if it has the same spaced-filename problem and is referenced; otherwise leave it (keep scope tight).
- **`SiteNav.tsx`:** replace raw `<img>` with `import Image from 'next/image'` →
  `<Image src="/logo.svg" alt="RepWorth" width={32} height={32} className="w-8 h-8 object-contain" unoptimized />`.
  Remove the eslint-disable. `<Image>` satisfies `no-img-element`; `unoptimized` avoids the SVG optimizer (no `dangerouslyAllowSVG` needed).
- **5 QR `<img>`:** keep as `<img>`. Ensure each has `{/* eslint-disable-next-line @next/next/no-img-element */}` immediately above with a clear rationale, e.g. `// QR is a runtime base64 data: URI — next/image cannot optimize a data URL`. The `SecurityClient.tsx:276` one currently lacks the disable (the lone warning); add it.
- **Success:** `pnpm lint` → 0 warnings, 0 errors. `pnpm build` succeeds (logo renders).

### Point 25 — tablet breakpoints (KPI + Past-Replies stats)

- **`console.css`:** add `@media (max-width: 900px) { .kpi-grid, .kpi-grid.has-pending { grid-template-columns: repeat(2, 1fr); } }` ordered **above** the existing 768px rule (so 769–900px → 2-col, ≤768px keeps its existing 2-col).
- **`past-replies.css`:** add `@media (max-width: 900px) { .pr-stats { grid-template-columns: repeat(2, 1fr); } }` above the existing 768px rule.
- **Test:** CSS-contract test asserting both files contain a `max-width: 900px` rule setting the respective grid to two columns (string/regex assertion in the style of `island-overflow.test.ts`).

### Point 26 — Security + Legal typography to rubric

- **`(public)/security/page.tsx`:**
  - h1 `text-3xl` → `text-5xl md:text-6xl lg:text-7xl font-medium leading-tight` (keep `text-[#2a2a2a]`).
  - h2 `text-xl` → `text-2xl md:text-3xl font-medium` — a deliberate calm step **below** the rubric's `text-4xl md:text-5xl` (this is a dense security/compliance page with many subsections, not a marketing hero).
  - body `text-sm text-[#4a4a4a]` → `text-lg text-[#6a6a6a] leading-relaxed`.
- **`legal/LegalPage.tsx`:**
  - h1 `text-3xl` → rubric h1 scale (`text-5xl md:text-6xl lg:text-7xl font-medium leading-tight`).
  - body `text-sm` → `text-base` (16px; right density for dense legal — `text-lg` would be too loose).
  - body color `#4a4a4a` → brand `#6a6a6a` (≈5.7:1 on white → AA pass).
  - keep the sub-processors table first-col `whitespace-nowrap`.
- **Test:** light render/contract test asserting security h1 carries the `text-5xl` class and body uses `#6a6a6a` (snapshot-free string assertion). Optional for legal.

### Point 27 — ARIA route-nav semantics + 44×44 tap targets

- **`SettingsTabs.tsx`:**
  - Remove `role="tablist"` from the container and `role="tab"`/`aria-selected` from the links.
  - Add `aria-current={active ? 'page' : undefined}` on the active `<Link>`.
  - Add roving tabindex (active link `tabIndex=0`, others `-1`) + `onKeyDown` ←/→ (and Home/End) moving focus between the tab links. Keep the visual underline behavior unchanged.
- **`MobileTabBar.tsx`:** add `aria-label="Dashboard"` to the `<nav>`; add `aria-current={active ? 'page' : undefined}` to the active tab link. (Hash-based active logic from PR #171 stays.)
- **Tap targets → ≥44×44:**
  - `EditReplyDrawer.tsx` close button: `px-2 py-1` → flex-centered `min-h-11 min-w-11` (44px), keep the `✕` glyph visually small.
  - `.mtab` (`console.css`): add `min-height: 44px` (keep current padding/look).
  - Dot-nav (`PageShell.tsx` + marketing `.rw-dot-nav`): **keep the 12px visual dot**; expand the interactive hit area to 44×44 via a transparent `::after` (absolutely-positioned, `content:''`, `inset:-16px` or sized to 44px) so layout, spacing, and the visual dot are unchanged. Marketing `.rw-dot-nav` buttons get the same treatment in CSS.
- **Tests:** component tests — SettingsTabs renders `aria-current="page"` on the active tab and moves focus on ArrowRight/ArrowLeft; MobileTabBar nav has `aria-label` and active tab has `aria-current`. CSS-contract test for the dot-nav 44px hit area + `.mtab` min-height.

### Point 28 — skeleton, stars, runbook, empty-state verify

- **Settings loading skeleton:** new shared `SettingsSkeleton` component (Console-palette shimmer rows; reuse existing skeleton tokens if present, else a minimal `.settings-skeleton` block) replacing the three `<p>Loading…</p>` texts in `SettingsClient.tsx:48`, `VoiceClient.tsx:39`, `ChannelsTabClient.tsx:93`. One owner of the loading look.
- **Star sweep → `#97B3AE`:**
  - Rename `tokens.css` `--rw-yellow-500: #EAB308` → `--rw-star: #97B3AE`. Update the 3 Console references (`console.css .stars`, `past-replies.css .pr-chip-stars`, `PastRepliesClient.tsx` inline) to `var(--rw-star)`.
  - `EditReplyDrawer.tsx:118` `text-yellow-500` → `text-[#97B3AE]`.
  - Marketing `globals.css` (3 sites) + `HowItWorksContent.tsx:288` inline + `FeaturesContent.tsx` (3 sites `text-yellow-400`) → `#97B3AE` / `text-[#97B3AE]`.
  - Auth `auth-island.css:51,93` → `#97B3AE`.
  - Admin `ReviewsList.tsx:55`, `ZernioConnectionPanel.tsx:247` → `text-[#97B3AE]`.
  - **Guard test** (`no-yellow-star-colors.test.ts`, mirroring `console-admin-palette.test.ts`): assert the star-bearing files contain no `#eab308`/`#EAB308`, `text-yellow-400`, `text-yellow-500`, and `--rw-yellow-500`, scoped to the star call-sites.
- **Empty-state verify:** the filtered empty state already exists and is branded; recolor its icon from `--rw-blue-*` to teal (`--rw-app` teal or `#97B3AE`) for brand consistency, and confirm a genuine first-run (no replies ever) render path reaches `Empty()` with sensible copy. No new component unless a real gap is found (note it if so).
- **Runbook:** add `min-h-screen` to the `admin/runbook/page.tsx:87` root `<div>`.

---

## Files touched (summary)

- **24:** `public/Logo - SVG.svg`→`public/logo.svg`, `src/components/ui/SiteNav.tsx`, `settings/security/SecurityClient.tsx`, `OwnerWhatsAppWidget.tsx`, `OwnerTelegramWidget.tsx`, admin `WhatsAppEnrollmentWidget.tsx`, admin `TelegramEnrollmentWidget.tsx`, any ref to the old filename.
- **25:** `_styles/console.css`, `_styles/past-replies.css` (+ contract test).
- **26:** `(public)/security/page.tsx`, `components/legal/LegalPage.tsx` (+ test).
- **27:** `settings/SettingsTabs.tsx`, `dashboard/MobileTabBar.tsx`, `dashboard/EditReplyDrawer.tsx`, `ui/PageShell.tsx`, `_styles/console.css`, marketing dot-nav CSS (`globals.css`) (+ tests).
- **28:** `settings/SettingsClient.tsx`, `settings/voice/VoiceClient.tsx`, `settings/channels/ChannelsTabClient.tsx`, new `SettingsSkeleton`, `_styles/tokens.css`, `_styles/console.css`, `_styles/past-replies.css`, `PastRepliesClient.tsx`, `EditReplyDrawer.tsx`, `globals.css`, `HowItWorksContent.tsx`, `FeaturesContent.tsx`, `auth-island.css`, admin `ReviewsList.tsx`, admin `ZernioConnectionPanel.tsx`, `admin/runbook/page.tsx` (+ guard test).

## Verification

- `pnpm lint` → 0 warnings / 0 errors.
- `pnpm typecheck` clean.
- `pnpm test` green (existing suite + new contract/component tests).
- `pnpm build` succeeds (logo asset resolves).
- No DB/tenant changes → tenant-scope / RLS audits not required.

## Risks & mitigations

- **Logo rename breaks a reference** → grep-all before rename; `pnpm build` catches a 404 asset.
- **Dot-nav 44px hit area shifts layout** → use a transparent `::after` overlay, not real box growth; visual dot unchanged.
- **Star token rename misses a reference** → guard test + `grep` for `--rw-yellow-500` returning zero after.
- **Lighter legal body color** (`#4a4a4a`→`#6a6a6a`) slightly lowers contrast → still AA (≈5.7:1); matches brand body token.
