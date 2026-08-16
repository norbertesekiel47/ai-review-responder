# Design system docs & tokens — three-tier arrangement

_Status: **ACCEPTED 2026-08-16** (all §6 recommendations taken: D1 delete + tag,
D2 option A, D3 option A, D4 deferred then **taken in PR 3a**, D5 subdirs) · Owner: Norbert + Claude_
_Supersedes the ad-hoc layout of `docs/design/`, root `DESIGN.md`, and the
`repworth-brand-design` skill. Nothing here changes what the product looks
like; it changes where each look is **owned**. Landed as PR 1 (docs) + PR 2
(code + guards) + PR 3a (D4 scope hardening) + PR 3b (`globals.css`
extraction) — see §5._

## 0. Summary

RepWorth ships three visual systems, one per surface family:

| # | System | Surface | Scope selector |
|---|---|---|---|
| 1 | **Landing** | `/` only | `.rw-lp` |
| 2 | **Island** | every other public / marketing / auth page (+ admin, utilitarian) | `:root` (loads on every route) |
| 3 | **Console** ("Warm Editorial") | authenticated owner app | `.rw-console` |

Today those three are described across **nine docs in four places** with three
overlapping "which system is which" overviews, hex values restated in four
files, a Console spec that is a dated proposal with a superseded-IA banner, and
a root `DESIGN.md` nothing links to. The code side is closer to right — three
token owners already exist — but the Console's Tailwind utilities are declared
inside the Island's file, and the Console file re-declares Island font tokens.

**Proposal:** one authoritative *Style Reference* per system in the
refero.design shape (Overview → Tokens tables → Components → Do's/Don'ts →
Exports), one token file per system that **is** its CSS-variables + Tailwind v4
`@theme` export, one scope selector per system, one router README, one thin
brand-level root `DESIGN.md` for the impeccable skill, and a router skill.
Redesigning any one system then touches exactly **one doc + one token file +
one `@theme` block + the components under one selector**, and CI proves the
other two were not touched.

---

## 1. Current state

### 1.1 Files

| File | Lines | What it is | Problem |
|---|---|---|---|
| `docs/design/README.md` | 64 | Router: Island vs Console, landing exception, tokens-in-code rule, single-source guard, teal a11y | Good bones. Two stale follow-ups (`--rw-blue-*` rename is **done**; the "~51 files hardcode `bg-[#hex]`" count is unverified). Says the skill "mirrors" `brand-island.md` — it doesn't. |
| `docs/design/brand-island.md` | 348 | Island playbook — principle, anti-slop guardrails, **hex color table**, island/parallax/nav code, type scale, motion, buttons, cards, rules | Restates hex (contradicts README's "tokens live in code"). Mixes system reference with recipe code. |
| `docs/design/brand-story.md` | 76 | Narrative layer: positioning, story arc, messaging guardrails, tagline | Fine. Not a visual system; stays as-is. |
| `docs/design/landing-page.md` | 497 | Landing exception: §2 its own design system, §3 index of load-bearing measurements, §6 how to re-measure, §7 asset gap | Half style reference, half engineering runbook for `sections/landing/**`. |
| `docs/design/dashboard-redesign/design-spec.md` | 248 | Console (Warm Editorial) spec, "locked direction, pending implementation · 2026-06-18" | Leads with a **"IA SUPERSEDED — visual system still current"** banner; links root `PLAN.md`; a proposal, not a living reference. |
| `docs/design/dashboard-redesign/*.html` (7) + `assets/warm-editorial.css` | — | Mockups | Encode the **superseded** IA (`insights.html`, needs-action queue). Twice flagged by fallow; kept as "false positive". |
| `DESIGN.md` (repo root) | 410 | impeccable-format: YAML frontmatter (colors/typography/radii/spacing/components for **both** systems) + prose "Design System: RepWorth", North Star = Warm Editorial Console | The **freshest** Console description (#747, #797) and **not linked from** README, `brand-island.md`, the skill, or `CLAUDE.md`. |
| `PRODUCT.md` (repo root) | 226 | impeccable product schema; holds the 2026-08-03 landing-page exception decision | Fine. Referenced by README. |
| `.claude/skills/repworth-brand-design/SKILL.md` | 36 | Thin pointer to `brand-island.md` + Island non-negotiables (with hex inline) | Island-centric name and body; routes Console work by one bullet; ignores Landing. |

### 1.2 Code owners (already three-way — the good news)

| System | Token declarations | Tailwind utilities | Guards |
|---|---|---|---|
| Island | `src/app/globals.css` `:root` (`--rw-sage`, `--rw-teal`, `--rw-teal-strong`, `--rw-peach`, `--rw-pink`, `--rw-beige`, `--rw-cream`, `--rw-ink`, …, `--rw-font-*`) — inside a **2,613-line** file that also carries the landing-island / features / how-it-works / pricing page CSS | `@theme inline` in `globals.css` — **also declares the Console utilities** (`--color-rw-app-bg: var(--rw-app-bg)` …) | `design-token-single-source.test.ts` (Island colors single-sourced; `--rw-sage` collision closed) |
| Console | `src/app/(authenticated)/_styles/tokens.css` `:root` (`--rw-app-*`, `--rw-tray/card/recess`, `--rw-accent-*`, semantic sets, charts, radii, shadows, motion, type roles), imported by `(authenticated)/layout.tsx`; `.rw-console` scoping lives in `console.css` | in `globals.css` (see left) | same test (contrast floors), `console-admin-palette.test.ts`, `no-yellow-star-colors.test.ts`, `save-bar-sidebar-width.test.ts` |
| Landing | `src/components/sections/landing/landing-experience.css` `.rw-lp` (`--rw-lp-*`, rgb-channel form) + `hero.css` | none (plain CSS) | none |

Cross-contamination found while auditing (all cheap to fix):

- `tokens.css` re-declares `--rw-font-display` / `--rw-font-body` / `--rw-font-mono` on `:root` with the **Island** values, then `console.css` overrides display to Young Serif inside `.rw-console`. Unguarded duplicate (the single-source test checks colors only).
- `tokens.css` declares nine `--rw-mkt-*` marketing type-role tokens with **zero consumers** anywhere in `src/`.
- `globals.css` still carries `@config '../../tailwind.config.mjs'` — a v3-style config with empty `theme`/`plugins`.
- Admin (`src/app/admin/**`) sits **outside** `.rw-console` and consumes **no** Console tokens (0 hits for `rw-app-`/`--rw-card`/`--rw-tray`/`--rw-accent`). It is an Island-palette surface with an amber/orange ban — README's "Console (plus the admin tool)" wording is loose.

---

## 2. Target arrangement

### 2.1 The contract — one row per system

Everything below hangs off this table. If a change touches two rows, it is a
brand-level change and goes through the router + root `DESIGN.md`, not a
system doc.

| System | Scope | Style Reference (doc) | Token file (`:root`/scope block = the "CSS variables" export) | `@theme` block (= the "Tailwind v4" export) | Guard |
|---|---|---|---|---|---|
| **Landing** | `.rw-lp` | `docs/design/landing/DESIGN.md` | `src/components/sections/landing/landing-experience.css` (+ `hero.css`) | none — Landing is plain CSS; add `landing/theme.css` only if a `bg-rw-lp-*` utility is ever needed | new: `landing-*.css` may declare only `--rw-lp-*` |
| **Island** | `:root` | `docs/design/island/DESIGN.md` | `src/app/globals.css` `:root` | `globals.css` `@theme inline` — **Island entries only** | existing single-source test + new: no `--rw-app-*`/Console names in this block |
| **Console** | `.rw-console` | `docs/design/console/DESIGN.md` | `src/app/(authenticated)/_styles/tokens.css` | **new** `src/app/(authenticated)/_styles/theme.css`, `@import`ed from `globals.css` | existing tests + new: Console files declare no Island tokens (extend from colors to fonts) |
| _Brand (shared)_ | — | `docs/design/README.md` (router) + root `DESIGN.md` (impeccable) + `docs/design/brand-story.md` (narrative) | `--rw-font-*` families in `globals.css` (single owner) | — | — |

Tailwind v4 supports the Console `@theme` move directly: `@theme` may live in a
dedicated file that the entry file `@import`s (`@import "tailwindcss";
@import "./theme.css";`) — Tailwind bundles local `@import`s itself and reads
theme variables across them (tailwindcss.com → Theme → "Share theme variables
across projects"). `@theme inline` (reference-not-copy) stays exactly as today
so the `--rw-*` declarations remain the only source of values.

### 2.2 Docs tree

```
docs/design/
├── README.md                    # ROUTER (~50 lines). The 2.1 table, "which system am I in" by path,
│                                #   the three cross-system rules, and "how to overhaul one system" (§4).
│                                #   No hex. No component recipes.
├── brand-story.md               # unchanged — narrative/messaging layer
├── landing/
│   ├── DESIGN.md                # Landing Style Reference (refero shape) — from landing-page.md §2 (+ §4/§5 as applicable)
│   └── measurements.md          # the engineering companion — from landing-page.md §1 status, §3 load-bearing index,
│                                #   §6 how to re-measure (incl. the two ways contrast measurement lies), §7 asset gap
├── island/
│   └── DESIGN.md                # Island Style Reference — from brand-island.md, restructured; recipes → Components
└── console/
    └── DESIGN.md                # Console Style Reference — from dashboard-redesign/design-spec.md (visual system only)
                                 #   MERGED with root DESIGN.md's Console prose (Overview, Named Rules, components,
                                 #   do's/don'ts — the fresher of the two)
```

Deleted: `docs/design/dashboard-redesign/` (all 7 HTML mockups + `assets/`) —
see decision D1. Git history keeps them; tag the pre-delete commit
`design-mockups-2026-06` so they stay one checkout away.

Naming note: `<system>/DESIGN.md` mirrors the refero/impeccable convention you
asked for and leaves room for per-system companions (`measurements.md`,
future specimens). The flat alternative (`docs/design/{landing,island,console}.md`)
is fewer files but forces the Landing runbook back into the style doc.

### 2.3 The per-system `DESIGN.md` template (refero shape)

Every system doc has the **same** section order so a reader who knows one
knows all three, and so the doc↔code guard (§2.7) can parse the token tables.

```markdown
# RepWorth <System> — Style Reference

> **Scope:** `<selector>` · **Tokens:** `<token file>` · **Utilities:** `<@theme file>` · **Guard:** `<test>`
> Which system am I in? → docs/design/README.md

## Overview
Creative thesis in 2–3 sentences, then 4–6 "Key characteristics" bullets.
(Landing: the 2026-08-03 exception + why it is unlocked. Island: the island
principle. Console: two-second scan, plain status language, product truth over
dashboard spectacle.)

## Tokens — Colors
| Name | Value | Token | Role |
(brand/accent group, then neutrals/surfaces, then semantic — every row is a
`--rw-*` declared in THIS system's token file; the guard fails otherwise)

## Tokens — Typography
Families table, then
| Role | Size | Line height | Weight | Letter spacing | Token |

## Tokens — Spacing & Shape
### Spacing scale   | Name | Value | Token |
### Border radius   | Element | Value | Token |
### Shadows / elevation | Name | Value | Token |
### Motion          | Name | Value | Token |   (durations, easings, reduced-motion stance)
### Layout          (max-widths, gutters, breakpoints, section rhythm)

## Components
One `###` per component: role · spec (which tokens, which utilities) · states ·
"never" line. (Island: island wrapper, parallax cards, dot nav, navbar,
buttons, feature cards, floating accent cards. Console: double-bezel card,
tray/core, HealthBadge/status chips, save bar, drawer, chart primitives.
Landing: hero, chapter rail, fleet/persona flip cards, ambient-video control.)

## Do's and Don'ts
Do: … / Don't: …  (the anti-slop pass, the teal rule, the amber/orange ban,
"tokens not literals", inline-SVG-only, motion import path — whichever apply)

## Surfaces & Elevation
## Imagery & Motion
## Agent prompt guide
Five one-liners: "Build a primary button on this surface" → the exact
utilities/tokens. This is what the skill points agents at.

## Exports
- **CSS variables:** `<token file>` — the `:root`/scope block IS the export; do not copy it here.
- **Tailwind v4:** `<@theme file>` — the `@theme inline` block IS the export.
(refero shows these as generated blocks; ours live in code so they cannot drift.)
```

Filled fragment, so the shape is concrete (values are the real ones from
`tokens.css` today):

```markdown
# RepWorth Console — Style Reference
> **Scope:** `.rw-console` · **Tokens:** `src/app/(authenticated)/_styles/tokens.css` ·
> **Utilities:** `src/app/(authenticated)/_styles/theme.css` · **Guard:** `design-token-single-source.test.ts`

## Tokens — Colors
| Name | Value | Token | Role |
|---|---|---|---|
| App field | `#FDFBF7` | `--rw-app-bg` | page canvas, warm off-white |
| Tray | `#F4EEE4` | `--rw-tray` | double-bezel outer |
| Card core | `#FFFDF9` | `--rw-card` | double-bezel inner |
| Espresso | `#2A2118` | `--rw-app-text` | primary text |
| Sage deep | `#527069` | `--rw-sage-deep` / `--rw-accent-600` | accessible accent — active nav, links, CTAs (5.33:1 on card) |
| Blush deep | `#934D3F` | `--rw-blush-deep` | negative-lane text on blush wash (5.45:1) |
| Terracotta | `#A64033` | `--rw-danger` | destructive / error (5.11:1) |
| Violet | `#6F579E` | `--rw-violet` | Insights provenance (5.85:1) |
| Gold | `#9A691D` | `--rw-star` | review star glyph (4.68:1) |

## Tokens — Spacing & Shape
### Border radius
| Element | Value | Token |
|---|---|---|
| Card (outer tray) | 20px | `--rw-radius-card` |
| Card core (inner) | 14px | `--rw-radius-core` |
### Motion
| Name | Value | Token |
|---|---|---|
| Ease out | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | `--rw-ease` |
| Base duration | 500ms | `--rw-dur-base` |
```

### 2.4 Code — one token file, one `@theme`, one scope per system

Required (PR 2):

1. **Move the Console utility declarations out of `globals.css`.** Create
   `src/app/(authenticated)/_styles/theme.css` holding only the `@theme inline`
   Console block (`--color-rw-app-bg: var(--rw-app-bg); …`), and add
   `@import '../app/(authenticated)/_styles/theme.css';` (path relative to
   `globals.css`) after `@import 'tailwindcss';`. Behaviour is identical —
   same utilities, same `var()` references — but a Console overhaul no longer
   edits the Island file.
2. **Delete the Island font re-declarations from `tokens.css`** (`--rw-font-display`,
   `--rw-font-body`, `--rw-font-mono` on `:root`; keep the `--rw-font-sans`
   legacy alias if still referenced, or migrate its consumers). `globals.css`
   provides them on every route; `console.css` keeps the `.rw-console` Young
   Serif override. Extend the single-source test from colors to font families.

   > **As built (PR 2).** `--rw-font-sans` had zero consumers and went with the
   > others. `--rw-font-mono` was **moved, not deleted**: tokens.css's stack is
   > the system mono and globals.css's is JetBrains Mono, so a bare delete would
   > have re-faced three Console call sites. It is now a `.rw-console` override
   > in `console.css` — an override inside the scope, which is the sanctioned
   > mechanism; a second `:root` declaration is not.
   >
   > **The gotcha this uncovered, worth not re-learning:** a `var()` inside a
   > custom property is substituted where the property is **declared**, not where
   > it is used. `--rw-app-h1: … var(--rw-font-display)` is declared on `:root`,
   > so it carries the ROOT display family even inside `.rw-console` — which is
   > why every `font: var(--rw-app-hN)` call site in `console.css` is followed by
   > an explicit `font-family: var(--rw-font-display)`. Verified in Chromium, not
   > assumed. The one Console consumer WITHOUT that follow-up line is the inline
   > `HEADING` const in `dashboard/connect/page.tsx`; its `<h1>`s therefore change
   > from the unresolvable `'Plus Jakarta Sans'` literal (which fell back to
   > `ui-sans-serif`) to the real self-hosted Plus Jakarta. **Done in PR 3a**
   > (#845): moving the tokens to `.rw-console` makes the composite resolve to
   > Young Serif by substitution, and the const now restates
   > `fontFamily: var(--rw-font-display)` the way `.page-title` does — the
   > approved visual change that own PR was for.
3. **Delete the nine dead `--rw-mkt-*` tokens** from `tokens.css` (0 consumers).
   If a marketing type-role scale is wanted later it belongs to Island.
4. **Delete `tailwind.config.mjs` and the `@config` line** — verify `pnpm build`
   is byte-identical in output classes (v4 auto-detects content; the file
   contributes nothing). Revert if anything relied on it.

Optional hardening (D4): move Console declarations from `:root` to `.rw-console`
in `tokens.css`. Correct in principle (the file only loads with the authenticated
layout, but `:root` declarations leak if the chunk survives a client navigation
— the exact mechanism behind the old `--rw-sage` collision). Risk: any Console
component rendered through a portal **outside** the `.rw-console` div (Radix
dialogs/toasts mounted on `body`) would lose its tokens. Needs a portal audit
first; not required for independence.

> **As built (PR 3a, #845).** The portal audit came back empty, so the move
> shipped: `tokens.css` is one `.rw-console { … }` block and opens no `:root`.
> What was checked — 0 `createPortal` under `src/app/(authenticated)/**` or
> `src/components/dashboard/**`; no Radix / sonner / react-hot-toast /
> react-toastify / headlessui dependency; the only overlays are native
> `<dialog>` + `showModal()` (`SettingsModal`, `EditReplyDrawer`,
> `PastDueModal`), promoted to the top layer but left in their DOM position and
> therefore still inheriting the scope; both return paths of
> `(authenticated)/layout.tsx` render everything inside the `.rw-console` div,
> the route group has no `template.tsx` / `not-found.tsx`, its `error.tsx`
> boundaries render as children of that layout, and the root `global-error.tsx`
> (which does replace the layout) consumes zero `--rw-*`; no
> `var(--rw-<console token>)` and no Console Tailwind utility is referenced
> outside the Console scope, across all 126 declared tokens; and `tokens.css`
> is imported only by `(authenticated)/layout.tsx` and `console.css`.
>
> **It also fixed the PR 2 gotcha above rather than working around it.** The
> composites are now declared on the same element that carries the `localFont`
> `--rw-font-display` / `--rw-font-body` variables, so `var()` substitution at
> declaration time yields Young Serif: `font: var(--rw-app-hN)` alone is enough
> inside the Console. The explicit `font-family: var(--rw-font-display)`
> follow-up lines in `console.css` are now redundant — harmless, and left in
> place.
>
> Two things went with it. `::selection` in `console.css` was the one rule in
> that file matching elements OUTSIDE the Console, so it moved inside the scope
> with the tokens (otherwise a stale chunk turns a leaked selection color into
> an unresolvable `var()` and an invisible highlight). And the dead `.rw-app`
> element-style block at the end of `tokens.css` was deleted — the class was
> applied nowhere in `src/`; the `--rw-app-*` composite TOKENS are unrelated and
> stay.

Optional, larger (PR 3): extract the ~2,400 lines of landing-island /
features / how-it-works / pricing page CSS out of `globals.css` into colocated
section files (as `sections/landing/**` already does), leaving `globals.css` as
a ~200-line token + base + `@theme` file. Pure mechanical move; makes the
Island token file readable but is not needed for the three-way independence.

> **As built (PR 3b, #846).** Done, as a directory rather than per-section
> colocation: `src/app/(public)/_styles/{island,features,how-it-works,pricing}.css`,
> mirroring `(authenticated)/_styles/`. `globals.css` went 2,604 → 154 lines
> (`@import 'tailwindcss'`, the Console `theme.css` import, the Island
> `@theme inline` block, the Island `:root` tokens, and the four page-CSS
> `@import`s). Line ranges: 117–1124 → `island.css` (the `.rw-marquee-field`
> atmosphere leads the file, then the original landing chrome), 1125–1350 →
> `features.css`, 1351–2001 → `how-it-works.css`, 2002–2604 → `pricing.css`.
> Text is verbatim apart from each file's new header comment; no rule was
> renamed, reordered or deleted.
>
> **The ordering argument, and the one place the obvious mechanism is wrong.**
> The plan of record was four `import` statements in `src/app/layout.tsx` right
> after `import './globals.css'` — Next orders CSS by import order
> (`node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` →
> "Ordering and Merging"), so the cascade would be identical. It is not: a file
> imported from `layout.tsx` is a separate stylesheet that
> `@tailwindcss/postcss` skips (no Tailwind directives → early bail), so it
> never gets the Lightning CSS pass the rest of `globals.css` gets. Measured on
> `/features`: **47 of the 158 `@supports (color: color-mix(…))` fallbacks
> stopped being emitted**, silently dropping the flat-colour fallback for
> browsers without `color-mix()`, and the emitted chunks changed
> (175,119 B → 110,073 + 59,982 B, 1,935 → 1,866 rules). The shipped mechanism
> is four CSS `@import`s at the **bottom** of `globals.css` — the same thing
> line 2 already does for `theme.css`, and Tailwind v4 inlines each file where
> its `@import` sits, so the page CSS stays inside the Tailwind entry AND lands
> exactly where it used to. Bottom placement is load-bearing: hoisting the
> `@import`s would move 2,400 lines of page CSS ahead of the token and `@theme`
> blocks. Guarded by `design-scope-purity.test.ts`, which pins the four names,
> their order, their position after `:root`, and the absence of a `layout.tsx`
> import.
>
> **Proof (zero change).** (a) *Rule-sequence identity*: for each of the 24
> prerendered routes, the ordered `<link>` chunk list was concatenated and
> flattened into a `selector{declarations}` sequence before and after — all 24
> identical (1,956 rules each; 2,136 on `/login` and `/signup`). (b) Stronger:
> **all 10 emitted `.css` chunks are byte-identical**, same content-hashed
> filenames, same sizes, same SHA-256. (c) *Screenshots*: `next start` on each
> build, Playwright at 1280×900 and 390×844, `reducedMotion: 'reduce'` +
> `animations: 'disabled'`, full-page, on `/`, `/features`, `/how-it-works`,
> `/pricing`, `/login`, `/signup`, `/help/contact`, `/book-a-demo`,
> `/legal/privacy` — 18/18 PNGs byte-identical, 0 differing pixels, no route
> skipped.
>
> **Later optimization, deliberately not taken here:** loading each page's CSS
> per-route (importing `features.css` from `FeaturesContent`, etc.) so `/pricing`
> stops shipping the how-it-works rules. That is a real behaviour change — CSS
> would stop loading on every route — and it needs its own before/after, so it
> is not part of a move whose whole claim is "nothing changed".
>
> **Dead-rule candidates (reported, not deleted).** `island.css`: 83 of its 103
> classes have no `.tsx`/`.ts` mention anywhere in `src/` or `e2e/`, and none
> appears even as a substring — the old ticker (`rw-tk-*`), voice
> (`rw-voice-*`, `rw-vv-*`), timeline (`rw-timeline-*`), inline demo
> (`rw-demo-*` except `rw-demo-stars`), old hero/feature-card chrome
> (`rw-hero`, `rw-hero-{ctas,demo,split}`, `rw-feat-{card,eyebrow,vis*}`,
> `rw-features*`), the clock/badge glyphs (`rw-clock-*`, `rw-cl-dot`,
> `rw-br-*`, `rw-ta-*`), `rw-btn-{ghost,pill}`, `rw-cta`, `rw-eyebrow`,
> `rw-lead`, `rw-line`, `rw-reply*`, `rw-src*`, `rw-sec-inner`, `rw-tick`,
> `rw-caret`, `rw-f-accent`, `rw-float-stat`, `sep`, `tone-{sage,teal,peach,beige}`.
> The live `/` renders `sections/landing/**` instead, which is why. `pricing.css`:
> 17 — `hl` and the unused video-hero block (`rw-video-hero`,
> `rw-has-video-hero`, 14 × `rw-vh-*`, which is also where the local
> `--rw-vh-night` is declared). `features.css` and `how-it-works.css`: zero.
> `is-copilot` / `is-autopilot` look dead to a literal grep but are **alive** —
> `PricingContent.tsx` composes them as `` `pr-plan-swatch is-${plan.icon}` ``.

### 2.5 Root `DESIGN.md` + `PRODUCT.md` (the impeccable skill)

Verified: `~/.claude/skills/impeccable/scripts/context.mjs` resolves exactly
**one** `DESIGN.md` at the project root (`DESIGN_NAMES = ['DESIGN.md',
'Design.md', 'design.md']`) plus per-surface briefs under `.impeccable/surfaces/`
(gitignored, local). It cannot be pointed at three docs. Options:

- **A (recommended): root `DESIGN.md` becomes a thin brand-level index in
  impeccable's format.** Frontmatter keeps only what is genuinely brand-wide
  (the `--rw-font-*` families, the wordmark, the a11y commitments, the
  amber/orange/stone ban); the prose Overview says "three registers, one per
  surface family; the authoritative Style Reference for each is
  `docs/design/{landing,island,console}/DESIGN.md` — read the one matching
  `--target`" and gives the path→system routing (`sections/landing/**` →
  Landing; `src/app/(authenticated)/**` → Console; else Island). Its per-system
  detail is deleted (it lives in `console/DESIGN.md` after the merge).
  Header comment: hand-curated; `/impeccable document` output goes into the
  matching `docs/design/<system>/DESIGN.md`, never here.
- B: keep root `DESIGN.md` as the Console doc and symlink `console/DESIGN.md` → root.
  Rejected: git symlinks + impeccable + a "both systems" file = the same confusion.
- C: delete root `DESIGN.md`; impeccable falls back to incumbent-code discovery.
  Rejected: loses the design context that made #747/#797 audits useful.

`PRODUCT.md` is untouched — the router README already cites it for the landing
exception.

### 2.6 The skill — `repworth-brand-design` becomes the router skill

Keep the name (referenced by `CLAUDE.md`, `console-admin-palette.test.ts`, and
several specs); update the description to cover all three systems. Body
(~40 lines):

1. **Which system am I in?** — three path rules (the same table as README).
2. **Per-system non-negotiables** — 3–4 bullets each, **no hex**: token names and
   the doc link. (Island: island wrapper, `rw-teal-strong` for text/fills,
   inline SVG, motion import path, anti-slop. Console: `.rw-console` tokens only,
   double-bezel, Young Serif display single-weight, no amber/orange/stone.
   Landing: read `measurements.md` first, `--rw-lp-*` only, do not "restore"
   sage/teal/peach.)
3. **Read the Style Reference before building or finalizing** — the three links.

Fix the "the skill mirrors this file" sentences in the Island doc and README.

### 2.7 Guards

Keep: `design-token-single-source.test.ts`, `console-admin-palette.test.ts`,
`no-yellow-star-colors.test.ts`, `save-bar-sidebar-width.test.ts`.

Add (all reuse the existing `declares(file, token)` CSS-parsing helper):

| Guard | Asserts | Catches |
|---|---|---|
| Landing scope | `landing-experience.css` / `hero.css` declare only `--rw-lp-*` custom properties | Landing quietly growing a fourth palette or re-declaring Island names |
| Island `@theme` purity | `globals.css` `@theme inline` names no `--rw-app-*`, `--rw-tray/card/recess/accent-*`, `--rw-star`, … (list derived from `tokens.css` declarations) | Console utilities creeping back into the Island file |
| Console purity (extend) | `tokens.css`/`theme.css` declare none of the Island color **or font** tokens | the `--rw-font-display` duplicate found above |
| Doc ↔ code pin (D2, option A) | every `` `--rw-*` `` in a `docs/design/<system>/DESIGN.md` **Tokens** table exists in that system's token file, and every hex/px value beside it matches the declaration | the tables drifting from the CSS — the failure the README's "no hex here" rule was protecting against |

Wire the new file(s) as `design-*.test.ts` beside the existing ones; no new CI
job — `pnpm test` runs them.

---

## 3. Move / delete / rewire ledger

| Action | From | To |
|---|---|---|
| Restructure | `docs/design/brand-island.md` | `docs/design/island/DESIGN.md` |
| Restructure + merge | `docs/design/dashboard-redesign/design-spec.md` (visual system only; drop IA banner, IA sections, `PLAN.md` link) + root `DESIGN.md` Console prose | `docs/design/console/DESIGN.md` |
| Split | `docs/design/landing-page.md` §2 (+ any of §4/§5 that is design) | `docs/design/landing/DESIGN.md` |
| Split | `docs/design/landing-page.md` §1, §3, §6, §7 | `docs/design/landing/measurements.md` |
| Rewrite | `docs/design/README.md` | router (§2.2); fix stale follow-ups; fix "mirrors" wording; correct the admin sentence |
| Thin | root `DESIGN.md` | brand-level index (§2.5 A) |
| Rewrite | `.claude/skills/repworth-brand-design/SKILL.md` | router skill (§2.6) |
| Delete | `docs/design/dashboard-redesign/*.html`, `assets/warm-editorial.css` | — (tag `design-mockups-2026-06`) |
| Unchanged | `docs/design/brand-story.md`, `PRODUCT.md` | — |
| Cross-refs to update (same PR, per the CLAUDE.md delete-a-doc rule) | `docs/directory.md`, `CLAUDE.md` (skill description only), `PRODUCT.md`, `src/app/globals.css` header, `src/app/(authenticated)/_styles/tokens.css` header, `src/components/sections/landing/{landing-experience,hero}.css`, `docs/superpowers/specs/2026-07-22-marketing-pages-agentic-refresh-design.md`, `docs/superpowers/plans/2026-06-26-audit-stage5-review-publisher-seam.md`, `docs/superpowers/plans/2026-06-28-345-dashboard-docs-ia.md`, `docs/superpowers/plans/admin-invite-funnel-deviations.md`, `docs/reviews/admin-invite-funnel/standards-maintainability.md`, `docs/reviews/feat-competitor-snapshots-538/adversarial-review.md`, `docs/progresstracking.md` + the two `docs/audits/2026-06-26 / 07-01` modularity docs (the "warm-editorial.css false positive" notes become "deleted in #NNN") | — |

---

## 4. The payoff — "overhaul the dashboard" walkthrough

With the arrangement in place, a Console redesign is:

1. Rewrite `docs/design/console/DESIGN.md` — new thesis, new token tables,
   new component specs. (If you use `/impeccable`, run it with
   `--target src/app/(authenticated)/…`; write its output **here**.)
2. Rewrite `src/app/(authenticated)/_styles/tokens.css` (values) and
   `_styles/theme.css` (which tokens become utilities). Rename tokens freely —
   the doc↔code pin tells you which table rows are now stale.
3. Change components under `.rw-console` (`src/app/(authenticated)/**`,
   `src/components/dashboard/**`).
4. `pnpm test` — the purity guards prove `globals.css` `:root`, the Island
   `@theme` block, and `landing-*.css` are byte-identical to before; the
   Landing and Island docs were never opened.

Same shape for Landing (one dir, two CSS files, `.rw-lp`) and Island (one dir,
`globals.css` `:root` + its `@theme` block, everything not under the other two
selectors). Nothing else in the repo needs to know a redesign happened.

---

## 5. Phasing

| PR | Scope | Notes |
|---|---|---|
| **1 — docs** (#843) | §2.2 tree, three `DESIGN.md`, `landing/measurements.md`, router README, thin root `DESIGN.md`, router skill, mockup delete + tag, full cross-ref sweep (§3) | Docs-only → `changes` short-circuits the heavy CI jobs. Content is a **restructure**, not a rewrite: every rule in the current docs survives, just under the template's headings. Landed 2026-08-16. |
| **2 — code, small** (#844) | §2.4 items 1–4 + the four guards in §2.7 | Zero visual change; the guards are the proof. Runs full CI. Guards shipped as `design-scope-purity.test.ts` (Landing scope + Island `@theme` purity), an extension of `design-token-single-source.test.ts` (Console purity, colors **and** font families, + `theme.css` references), and `design-doc-token-pin.test.ts` (D2 option A). |
| **3a — Console scope hardening** (#845) | D4 `.rw-console` scoping after the portal audit; the dead `.rw-app` element-style block; the connect `<h1>` on the display face | Audit came back empty — §2.4 "As built (PR 3a)" lists what was checked. One deliberate visual change (eight connect-flow headings become Young Serif). New guard: `tokens.css` may open no `:root` block. |
| **3b — globals.css extraction** (#846) | page CSS → `(public)/_styles/`; two new guards; four marketing tests retargeted | zero-change proof: rule sequence identical on all 24 prerendered routes (in fact all 10 CSS chunks byte-identical) + 9 routes × 2 viewports pixel-identical |

The "3 — optional" placeholder is gone: both of its items shipped as 3a and 3b, so
nothing from this spec is outstanding.

---

## 6. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Console HTML mockups: **delete** (git tag) vs archive under `docs/progress-archive/` | Delete. They encode the superseded IA; the visual system is fully captured in `console/DESIGN.md` + `tokens.css`; the live app is the specimen. |
| D2 | Doc↔code drift: **A** hand-maintained tables + pin test vs **B** generated tables between markers via a script + freshness check | A now (small, matches the existing test style). Promote to B only if the tables churn enough to annoy. |
| D3 | Root `DESIGN.md`: **thin index (A)** vs delete (C) | A — keeps impeccable useful without a fourth source of truth. |
| D4 | Console `:root` → `.rw-console` scoping | Deferred behind a portal audit; **taken in PR 3a (#845)** once the audit found no portal, no portal-capable dependency, and no consumer outside the scope. See §2.4. |
| D5 | Docs layout: `<system>/DESIGN.md` subdirs vs flat files | Subdirs (room for `measurements.md` and future per-system specimens). |

## 7. Non-goals

- No visual change to any surface. No token renames beyond deleting dead/duplicate declarations.
  (One exception, taken knowingly in PR 3a and recorded in §2.4: the eight
  `/dashboard/connect` headings move onto the Console display face, which is what every
  other Console page title already used.)
- No change to which surfaces belong to which system (admin stays Island-palette; `/` stays unlocked).
- No new top-level directories; no generator script unless D2 flips to B.
