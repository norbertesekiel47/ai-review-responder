# RepWorth Island — Style Reference

> **Scope:** `:root` (loads on every route) · **Tokens:** [`src/app/globals.css`](../../../src/app/globals.css) `:root` ·
> **Utilities:** `src/app/globals.css` `@theme inline` (Island entries) ·
> **Page CSS:** [`src/app/(public)/_styles/*.css`](../../../src/app/(public)/_styles) (`@import`ed from `globals.css`, order = cascade) ·
> **Guards:** [`design-token-single-source.test.ts`](../../../src/__tests__/design-token-single-source.test.ts) · [`design-scope-purity.test.ts`](../../../src/__tests__/design-scope-purity.test.ts) (the `@theme` block may name no Console token) · [`design-doc-token-pin.test.ts`](../../../src/__tests__/design-doc-token-pin.test.ts) (this doc's tables ↔ the CSS)
> Which system am I in? → [`docs/design/README.md`](../README.md)

## Overview

The Island is the default register for everything that is not the landing page (`/`)
and not the authenticated Console: public/marketing pages, auth, the approval page,
legal, and the (more utilitarian) admin tool. Its token file loads on every route, so
the other two systems inherit these values by fall-through wherever they do not
override them.

Since the 2026-08 rebrand the Island carries **two registers**:

1. **Daylight Gallery II** — the marketing pages (`/how-it-works`, `/features`,
   `/pricing`) and the site-wide SiteNav/SiteFooter chrome. Approved demo + token
   spec: [`docs/design/daylight-ii/`](../daylight-ii). A bone island
   (`--rw-bone`) floats on the untouched sage marquee field; paper cards
   (`--rw-paper`) sit on the bone with hairline borders and **no drop shadows
   inside the island** (the island's own soft shadow is the container and
   stays). One family, one weight: **DM Sans 400** — hierarchy comes from size
   only. Ink (`--rw-ink2`) is text, hairlines, the dark CTA surface, and the
   Judge bar; forest (`--rw-forest`) is the **only action colour** (button
   fills, arrow discs, live/verdict dots); the five bar accents appear only as
   4–10px bars and small dots, never as text, never as broad fills. Review
   stars are ink — ratings are content, not action. **Premium pass
   (2026-08-22):** `/pricing` and `/features` adopt the `/how-it-works`
   vocabulary — two-column hero with a product artifact and the masked-line
   h1 entrance, dossier header rows (number · kicker · tail between
   hairlines), ledger strips, paper/bone band rhythm, scroll reveals. The
   pricing FAQ renders the shared `.rw-dl-faq*` accordion; the features
   chapters sit on a `.feat-ch` grid that alternates text-left, artifact-left,
   and full-width. The scroll-reveal wrapper is `src/components/ui/Reveal.tsx`.
2. **Classic island** — the functional Island surfaces (auth, approve, legal,
   security, help, demo, onboarding, admin). White `rounded-[3rem]`-style
   islands with the teal family, Plus Jakarta display over DM Sans body, and
   the ADR 0004 teal rules. These pages inherited the rebranded nav + footer
   chrome but keep their own page CSS; do not restyle them to Daylight
   piecemeal.

**Key characteristics (both registers):**

- An island on a sage field — content never sits on the sage directly.
- Decorative atmosphere (the drifting review marquee) that is abstract and
  non-informational by rule.
- Anti-slop by construction: specificity, restraint, purpose, truthfulness, craft,
  accessibility, token discipline.

## Tokens — Colors

Every row is declared in `src/app/globals.css` `:root`. Utility names mirror the token
names 1:1 (`--rw-sage` → `bg-rw-sage` / `text-rw-sage` / `border-rw-sage`).

### Daylight Gallery II (marketing surfaces + site chrome)

| Name | Value | Token | Role |
|---|---|---|---|
| Ink 2 | `#15191a` | `--rw-ink2` | text, hairline base, the dark CTA surface, the Judge bar |
| Ink 2 soft | `rgba(21, 25, 26, 0.74)` | `--rw-ink2-soft` | secondary text on bone/paper |
| Ink 2 mute | `rgba(21, 25, 26, 0.62)` | `--rw-ink2-mute` | captions, labels, meta text |
| Line | `rgba(21, 25, 26, 0.12)` | `--rw-line` | hairline borders and dividers |
| Line 2 | `rgba(21, 25, 26, 0.22)` | `--rw-line-2` | stronger hairline (outlines, quote rules) |
| Bone | `#f6f6f2` | `--rw-bone` | the island canvas |
| Paper | `#ffffff` | `--rw-paper` | cards on bone |
| Forest | `#2e5b4f` | `--rw-forest` | the single ACTION colour — button fills, arrow discs, live/verdict dots |
| Forest ink | `#24483f` | `--rw-forest-ink` | forest hover |
| Sage bar | `#8fb99b` | `--rw-sage-bar` | bar accent — Watch / Copilot |
| Teal bar | `#6f9d8f` | `--rw-teal-bar` | bar accent — Post |
| Mist bar | `#8fb1e6` | `--rw-mist-bar` | bar accent — Draft |
| Blush bar | `#eca396` | `--rw-blush-bar` | bar accent — Triage |
| Gold bar | `#dcb94a` | `--rw-gold-bar` | bar accent — Gate / Autopilot |

Bar accents are **bar-only**: 4–10px card bars and small dots, never text, never a
broad fill. The Judge/06 bar is deliberately `--rw-ink2`. The sage marquee field
behind the island stays `--rw-sage` and is unchanged by the rebrand.

### Brand & accent (classic register)

| Name | Value | Token | Role |
|---|---|---|---|
| Sage | `#D2E0D3` | `--rw-sage` | page background / secondary sage (`bg-rw-sage`) |
| Teal | `#97B3AE` | `--rw-teal` | primary decoration — large fills, dots, page accent, text-free bands |
| Teal strong | `#557069` | `--rw-teal-strong` | the **actionable** teal — text, links, button fills |
| Peach | `#F2C3B9` | `--rw-peach` | accent / blush |
| Pink | `#F0DDD6` | `--rw-pink` | soft accent wash |
| Beige | `#D6CBBF` | `--rw-beige` | warm beige / muted |
| Cream | `#F0EEEA` | `--rw-cream` | off-white background |

### Neutrals (classic register)

| Name | Value | Token | Role |
|---|---|---|---|
| Ink | `#2a2a2a` | `--rw-ink` | heading text (`text-rw-ink`) |
| Ink soft | `#6a6a6a` | `--rw-ink-soft` | body text (`text-rw-ink-soft`) |

### Semantic

| Name | Value | Token | Role |
|---|---|---|---|
| Error | `#b3261e` | `--rw-error` | AA body-text error, 6.47:1 on white |
| Success | `#1d6b4f` | `--rw-success` | AA body-text success, 5.10:1 on white |
| Alert red | `#DC2626` | `--rw-red-600` | error-glyph red (approval page + Console fall-through) |
| Alert red deep | `#B91C1C` | `--rw-red-700` | error-glyph red, darker |

### Extended tints (issue #373)

Tokenized at their exact prior `bg-[#hex]` values (zero pixel change) so onboarding,
auth, the approval page, and admin — none of which load the Console token file — can
consume them from the one Island owner.

| Name | Value | Token | Role |
|---|---|---|---|
| Warm gray | `#9a948a` | `--rw-warm-gray` | muted warm-gray text (placeholders, captions) |
| Warm gray soft | `#e3ddd3` | `--rw-warm-gray-soft` | light warm-gray surface — inactive step dots |
| Cream hover | `#e7e3dc` | `--rw-cream-hover` | cream secondary-button hover |
| Brown | `#6a4a44` | `--rw-brown` | brown badge text on peach (admin costs) |
| Teal hover | `#7e9b96` | `--rw-teal-hover` | hover shade for teal links/buttons |
| Sage muted | `#cdd9ce` | `--rw-sage-muted` | muted sage — inactive / empty states |
| Sage text | `#5e7d77` | `--rw-sage-text` | muted-sage badge text (approval location chip) |
| Teal deep | `#2a6a64` | `--rw-teal-deep` | deep teal badge text (admin costs) |
| Teal strong hover | `#46645d` | `--rw-teal-strong-hover` | darker teal-strong — button hover + CTA gradient end |
| Teal strong hover deep | `#46594f` | `--rw-teal-strong-hover-deep` | deeper teal-strong button hover (auth card) |
| Teal darkest | `#3f544f` | `--rw-teal-darkest` | darkest sage — approval confirm action |

**Never use:** amber, orange, stone, or any color not in the tables above.

## Tokens — Typography

### Families

| Role | Stack | Token |
|---|---|---|
| Display | Plus Jakarta Sans (variable, 100–900) | `--rw-font-display` |
| Body | DM Sans | `--rw-font-body` |
| Serif | Fraunces | `--rw-font-serif` |
| Mono | JetBrains Mono | `--rw-font-mono` |

The families are brand-wide: `globals.css` is their single owner and they load on every
route. The Console re-points `--rw-font-display` at Young Serif on its own wrapper; the
Island value is what every other surface resolves.

### Daylight type rules (marketing surfaces + site chrome)

**One family, one weight: DM Sans 400 everywhere.** No Plus Jakarta, no Fraunces, no
bold — hierarchy comes from size only. Normal letter-spacing; no negative tracking; no
viewport-scaled type beyond the clamps below. `font-variant-numeric: tabular-nums` and
`font-variation-settings: 'opsz' 16` on the page scope pin the variable font's optical
size so stroke weight stays uniform at display sizes.

| Element | Size |
|---|---|
| Hero h1 | `clamp(44px, 4.2vw, 64px)`, line-height 1.04 |
| Section h2 (`.rw-dl-h2`) | `clamp(32px, 3.6vw, 48px)`, line-height 1.12 |
| Card h3 (dossier step) | 34px |
| Body / lede | 18px / 1.5, `--rw-ink2-soft` |
| Card text | 15px / 1.5–1.56 |
| Captions, labels, meta | 13px, `--rw-ink2-mute` |

### Classic scale (functional surfaces)

The classic register keeps its Tailwind-utility scale — the sizes live in the
components:

| Element | Classes |
|---|---|
| Page h1 | `text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-rw-ink` |
| Section h2 | `text-4xl md:text-5xl font-medium text-rw-ink` |
| Card h3 | `text-xl md:text-2xl font-medium text-rw-ink` |
| Body | `text-lg text-rw-ink-soft leading-relaxed` |
| Eyebrow | `text-sm tracking-wider uppercase text-rw-teal-strong` |
| Caption / note | `text-sm text-rw-teal-strong italic` |

Eyebrows, captions, labels, and the wordmark are **text**, so they take the actionable
teal (`text-rw-teal-strong`) on white/cream — never the decorative `text-rw-teal`
(2.24:1, fails AA). Rationale and the per-background table:
[`docs/adr/0004-accessible-teal-token-split.md`](../../adr/0004-accessible-teal-token-split.md).

## Tokens — Spacing & Shape

### Border radius

Daylight (marketing):

| Element | Value |
|---|---|
| Island wrapper | 48px |
| Cards, receipts, panels | 8px |
| Buttons, pills, chips, tabs, badges | 9999px |
| Inputs (CTA band form) | 4px |
| Dossier steps (sticky stack) | 0 — square-cornered by design |

Classic (functional surfaces): island `rounded-[3rem]`, cards `rounded-2xl`/`rounded-3xl`,
pills `rounded-full`, as the components already write.

### Shadows / elevation

**Daylight: no drop shadows inside the island.** Depth comes from the paper/bone
surface split and hairline borders. The island's own soft shadow
(`box-shadow` on `.rw-island`) is the container and stays. The classic register keeps
its existing `shadow-lg`/`shadow-xl` recipes.

### Motion (Daylight)

| Name | Behaviour |
|---|---|
| Ease | `cubic-bezier(0.22, 0.61, 0.36, 1)` throughout |
| Hero entrance | staged: masked h1 lines rise (0.9s, +0.1s per line), lede/CTAs/card fade up (delays .45/.6/.75s) |
| Scroll reveal | `.rw-dl-rv` → `.is-in`: opacity + 12px rise, 0.6/0.7s |
| Stat cards | stagger left→right (+280ms), left bar wipes in (scaleY), numbers count up 1.4s |
| Sticky stack | each `.hiw-step` pins at `--top: 116 + i·8px`; the 8px colour bars form a flush ribbon |
| Pills | hover: translateY(-1px); arrow disc slides 2px |
| Loops | marquee drift, wash drift, pulse dot, typewriter caret |

Everything is gated on `prefers-reduced-motion: reduce` — reveals land on the final
frame, loops stop, the wash video never mounts (the blurred poster stays).

### Layout (Daylight)

- Content column: `.rw-dl-col` — max-width 1200px, 48px side padding (28px ≤1040px,
  18px ≤680px). Bands: `.rw-dl-band` 96px vertical (56px ≤680px); `.is-paper` bands are
  white with hairline top/bottom borders.
- Island: max-width 1440px, **`overflow: clip`** (never `hidden` — hidden would make
  the island a scroll container and break the sticky nav).
- Nav: sticky pill, `top: 14px`, inside the island as its first child.

## Components

### Island wrapper (REQUIRED on every page)

`SiteShell` (`src/components/ui/SiteShell.tsx`) is the single owner of the marketing
chrome: marquee field → `.rw-island-wrap` → `.rw-island` (bone, radius 48px,
`overflow: clip`) → `SiteNav` + `<main id="main-content">` + `SiteFooter`. The marquee
stays visible outside the island; the island is opaque bone. Functional pages compose
`PageShell` or their own island markup and render `SiteNav`/`SiteFooter` directly.

**Never:** `overflow-hidden` on the root page container — it breaks iOS Safari fixed
element scroll. (`overflow: clip` on the island itself is deliberate and sticky-safe.)

### Site nav (`.rw-nav*`, island.css)

A sticky white pill: brand (logo + "RepWorth", 17px), centre links (15px,
`--rw-ink2-soft`; active = ink + inset underline via `.is-active` and
`aria-current="page"`), right cluster "Log in" + the forest CTA pill with an arrow
disc. The CTA label is flag-aware: "Start free trial" only when the card-up-front
trial is on (`trialEnabled` prop), otherwise "Create account" — the chrome never makes
a stale trial claim. ≤680px the links collapse into a hamburger disclosure (44px
target, Escape closes, focus restored) that opens a paper card below the pill.

### Pills (`.rw-pill*`, island.css — the one CTA family)

| Variant | Classes | Use |
|---|---|---|
| Forest (primary) | `rw-pill rw-pill-forest` | the action — nav CTA, hero CTA, plan door |
| Ink | `rw-pill rw-pill-ink` | dark-surface alternative |
| Outline | `rw-pill rw-pill-line` | secondary door ("All nine features", "Tell me when…") — its arrow disc fills forest |
| Paper | `rw-pill rw-pill-paper` | on the dark ink CTA band |

Arrow disc: `.rw-pill-circ` (28px circle, slides 2px on hover). Focus: 2px forest
outline (`--rw-ink2` outline on the forest pill).

### Shared marketing primitives (`.rw-dl-*`, island.css)

| Primitive | Class | Anatomy |
|---|---|---|
| Card | `rw-dl-card` | paper, hairline border, radius 8px, 28px padding |
| Card caption | `rw-dl-cap` | 13px mute row + status dot (`rw-dl-cap-dot`, forest; `.is-bar` variant takes `--bar`) + right-aligned tail |
| Reply box | `rw-dl-reply` | bone inset with label row |
| Quote | `rw-dl-quote` | 2px `--rw-line-2` left rule + meta line |
| Receipt | `rw-dl-rec` | 3 labelled cells, hairline dividers; value dots forest (`.is-mid` = gold) |
| Buttons | `rw-dl-btn` (+ `.is-go` forest fill) | small pill actions inside cards |
| Tabs / segmented | `rw-dl-tabs` | pill group; selected = ink text + 1px inset ring (`aria-selected` or `aria-pressed`) |
| Check bullets | `rw-dl-bul` | ink check in a hairline circle |
| Stars | `rw-dl-stars` (+ `.off`) | ink glyphs; wrap with an `aria-label="N out of 5 stars"` |
| FAQ | `rw-dl-faq*` | hairline rows, 28px `+` disc rotates 45° when open; button + panel keep `aria-expanded`/`aria-controls` |
| CTA band | `rw-dl-cta` | dark ink full-bleed band, 7/5 grid: copy + text links left, `.rw-dl-cta-panel` right |
| Reveal | `rw-dl-rv` → `.is-in` | the scroll-reveal primitive |
| Fine print | `rw-dl-fine` | 13px mute — every illustrative figure carries one |

Page CSS (`how-it-works.css`, `features.css`, `pricing.css`) carries only each page's
delta on top of these. `--bar` / `--top` are element-scoped plumbing set inline by
components — never palette tokens (scope-purity guard).

### Classic components

The functional surfaces keep their existing recipes — white island via `PageShell`
(parallax cards, dot nav), teal-strong buttons, feature cards with icon circles, and
the CTA-band rules from ADR 0004. Read those components in place; do not port them to
Daylight piecemeal, and do not copy their teal recipes into the marketing pages.

### The marquee field

`src/components/ui/MarqueeBackground.tsx` (`.rw-marquee-field` in
`src/app/(public)/_styles/island.css`) is the reusable atmosphere layer: four rows of
translucent review cards drifting at different speeds under a radial sage vignette,
with an `animation: none` branch under `prefers-reduced-motion`. Unchanged by the
rebrand.

### The hero wash (approved exception)

The `/how-it-works` hero carries a blurred "wash" video loop
(`public/video/hero-wash-loop.mp4`, poster
`public/images/hero-wash-poster.jpg`; source stills in
`docs/design/daylight-ii/media/` — paid Higgsfield renders, do NOT regenerate). It is
an approved, deliberate exception to the no-atmosphere rule, confined to the hero and
fading to bone before the hero ends. The still is the poster and reduced-motion
fallback; the video fades in on `canplay` and replays on `visibilitychange`
(`HeroWash.tsx`).

## Do's and Don'ts

### The anti-AI design guardrails

RepWorth pages must feel specific to RepWorth, not like a generic AI/SaaS template.
Treat "AI influence" as any default visual, copy, or interaction pattern that looks
generated rather than chosen: blue-purple gradients, neon glows, orb or blob
backgrounds, black-glass dashboards, vague product mockups, synthetic chat bubbles,
fake metrics, generic icons, oversized hero type, and decorative UI that does not
explain the product.

This system is intentionally anti-slop. Slop means plausible-looking output that is
generic, unverifiable, over-decorated, inaccessible, or disconnected from the actual
RepWorth product. The fix is not to add more polish; the fix is to make each choice more
specific, truthful, useful, and restrained.

Before designing or finalizing any page, section, or component, check:

- **Specificity:** Use RepWorth-specific content, product language, customer context, and real interface states. Do not use generic placeholder narratives.
- **Restraint:** Keep hierarchy calm and intentional. Do not inflate type, spacing, shadows, gradients, or animation to make the page look more "AI."
- **Purpose:** Every visual element must either support navigation, explain the product, show a real state, or reinforce the RepWorth brand. Remove decorative filler.
- **Truthfulness:** Do not invent metrics, testimonials, logos, avatars, conversation snippets, customer names, dashboard data, or claims unless the user or product provides them. Illustrative samples must be labelled as such ("Sample", "Typical figures shown for illustration, not live performance data.").
- **Craft:** Replace template compositions with designed choices: strong alignment, intentional whitespace, readable density, consistent controls, and content that fits its container.
- **Accessibility:** Preserve contrast, keyboard-friendly controls, semantic labels, readable text sizes, and non-overlapping content on mobile and desktop.
- **Token discipline:** Use only the RepWorth color tokens above, and use accents sparingly so the page does not become a pastel or gradient showcase.

### Banned generic AI patterns

- No purple/blue AI gradients, neon cyan, random color glows, black-glass panels, orb/blob/bokeh backgrounds, atmospheric gradient fields, or decorative light leaks. (The `/how-it-works` hero wash is the single approved exception — see above.)
- No generic "AI startup" hero sections with oversized claims, abstract backgrounds, and vague dashboard cards.
- No fake chat bubbles, fake analytics widgets, fake avatars, fake testimonials, fake logos, fake customer names, or fake metrics unless supplied by the product context.
- No stock-like synthetic people, generic robot/brain/sparkle imagery, decorative network graphs, or meaningless "insight" panels.
- No placeholder hype copy such as "unlock insights," "supercharge," "seamless," "AI-powered," "next-generation," "revolutionize," "transform your workflow," "empower teams," "drive growth," or similar filler.
- No claims without evidence. If proof is missing, use neutral product-language placeholders like "Evidence summary" or omit the proof block.
- No new "AI product" font choices such as generic Inter/SF Pro-style defaults. Use the app's established font stack.
- No negative letter spacing or viewport-scaled type. Keep letter spacing normal except for the existing RepWorth wordmark and classic eyebrow styles.

### Rules

- **Daylight surfaces: one family, one weight** — DM Sans 400; hierarchy by size. No serif accent words, no mono labels, no bold.
- **Forest is the only action colour** on Daylight surfaces; bar accents are bars and dots only; stars are ink.
- **No drop shadows inside the island** on Daylight surfaces — paper + hairline is the depth model.
- **No generic AI visual language** — avoid purple/blue gradients, neon glows, black-glass dashboards, orb/blob/bokeh backgrounds, atmospheric gradients, and vague generated mockups
- **No invented proof** — do not fabricate metrics, testimonials, logos, avatars, chat snippets, dashboard data, customer names, or customer claims; label illustrative samples
- **No AI hype copy** — replace generic claims with concrete RepWorth product language and user outcomes
- **No slop density** — do not add repeated cards, filler grids, duplicate CTAs, or extra sections just to make the page feel larger
- **No unlabeled icon-only controls** — provide accessible names and clear intent for interactive elements
- **No external icon libraries** (no lucide-react, heroicons, etc.) — use inline SVGs only
- **No amber, orange, or stone** colors — those are the old palette, fully replaced
- **No `overflow-hidden` on the root page container** — breaks iOS Safari fixed element scroll (`overflow: clip` on `.rw-island` is deliberate)
- **Always `'use client'`** on components using `useRef`, `useState`, observers, or timers
- **Import from `motion/react`** — not `framer-motion`
- **Decorative background elements** get `aria-hidden="true"` on their wrapper
- **Never place page content directly on sage green** — always inside the island
- **Tokens, never literals** — use `var(--rw-*)` or the `rw-*` Tailwind utilities, never a raw `bg-[#hex]`
- **The two teals (classic register)** — `--rw-teal` is decoration only and fails WCAG AA for text; text, links, and button fills use `--rw-teal-strong`, which passes AA on white and cream but **not** on sage or teal (use `--rw-ink` there). Rationale: [`docs/adr/0004-accessible-teal-token-split.md`](../../adr/0004-accessible-teal-token-split.md)
- **A11y contract:** exactly one `<main id="main-content">` per page (SiteShell provides it on marketing pages); FAQ accordions keep `aria-expanded`/`aria-controls`; star glyphs carry an `aria-label`; every reveal/loop respects `prefers-reduced-motion`.

### Anti-slop final pass

Before finalizing RepWorth UI, run this pass and revise anything that fails:

| Check | Pass condition |
|---|---|
| Brand specificity | The page could not be mistaken for a generic AI/SaaS template |
| Truthfulness | Every metric, quote, logo, avatar, and customer claim is supplied, labelled illustrative, or omitted |
| Copy quality | No hype phrases, vague benefits, or filler labels remain |
| Visual purpose | Every card, background element, icon, and mockup explains or supports the product |
| Accessibility | Text contrast, labels, focus states, and mobile layout are usable |
| Layout craft | No overlapping text, cramped controls, unstable sizing, or viewport-scaled type |
| Token discipline | Only approved RepWorth colors appear, with accents used sparingly |

If a section only exists to look impressive, delete it or replace it with one concrete
RepWorth workflow/state.

### Common mistakes

| Mistake | Fix |
|---|---|
| Drop shadow on a card inside the Daylight island | Paper + hairline border is the depth model; remove the shadow |
| Bold text or a serif accent word on a marketing page | DM Sans 400 only; make it bigger, not bolder |
| A bar accent used as text or a broad fill | Bar accents are 4–10px bars and small dots only |
| White text on `--rw-teal` or a low-contrast label | Classic register: use `--rw-teal-strong`/`--rw-ink` per ADR 0004 |
| `overflow: hidden` on `.rw-island` | Use `overflow: clip` — hidden breaks the sticky nav |
| `import { Check } from 'lucide-react'` | Inline SVG only |
| `import { motion } from 'framer-motion'` | `import { motion } from 'motion/react'` |
| Fake metrics, logos, avatars, or testimonials | Remove them, or label them "Sample"/"illustrative" as the product context supplies |
| Icon-only controls without labels | Add accessible names and clear intent |
| Declaring a `--rw-*` token in page CSS | Tokens live in `globals.css` `:root` only (scope-purity guard) |

## Surfaces & Elevation

Daylight depth is a short stack: the sage field, the drifting marquee behind, the bone
island, paper cards and paper bands on the bone, and the single dark ink CTA band.
Nothing else.

| Section type | Background |
|---|---|
| Default band | bone (the island itself) |
| Paper band | `.rw-dl-band.is-paper` — white with hairline top/bottom borders |
| CTA (last section) | `.rw-dl-cta` — `--rw-ink2`, white copy, paper pill |
| Footer | bone, hairline top border |

The classic register keeps its white-island section recipes (white / cream tint / teal
CTA band per ADR 0004).

## Agent prompt guide

- **"Build a primary button on a marketing page"** → `rw-pill rw-pill-forest` (+
  `.rw-pill-circ` arrow disc when it is the nav/section door). Secondary door →
  `rw-pill rw-pill-line`. On the ink CTA band → `rw-pill rw-pill-paper`. Never a teal
  fill, never a drop shadow.
- **"Add a marketing section"** → `.rw-dl-band` (alternate `.is-paper`), `.rw-dl-col`
  column, centred `.rw-dl-intro` (kicker + h2 + lede), content in `.rw-dl-card`s,
  reveals via `.rw-dl-rv`.
- **"Show a product state"** → the card anatomy: `rw-dl-cap` caption row with a
  status dot, then `rw-dl-quote` / `rw-dl-reply` / `rw-dl-rec` as the state demands;
  label samples as samples.
- **"Add an icon"** → paste the SVG path inline with
  `fill="none" viewBox="0 0 24 24" stroke="currentColor"`. Never import `lucide-react`.
- **"Show a metric / testimonial"** → only if the product supplied it, with the
  illustrative disclaimer verbatim; otherwise omit the block.
- **"Touch auth / approve / admin / legal"** → classic register: keep the teal
  recipes and ADR 0004 rules; only the nav/footer chrome is Daylight there.

## Exports

- **CSS variables:** [`src/app/globals.css`](../../../src/app/globals.css) — the `:root`
  block IS the export; do not copy it here.
- **Tailwind v4:** [`src/app/globals.css`](../../../src/app/globals.css) `@theme inline`,
  Island entries — the block IS the export. `@theme inline` means each utility emits
  `var(--rw-*)` (a reference, not a copied hex), so the `:root` declarations stay the
  single source of truth.
- **Page CSS:** [`src/app/(public)/_styles/`](../../../src/app/(public)/_styles) — four
  files, `island.css` (the shared chrome: nav pill, pills, footer, the `.rw-dl-*`
  primitives, the marquee atmosphere), `features.css`, `how-it-works.css`,
  `pricing.css`. `globals.css` `@import`s them in that order, at the bottom of the
  file, and the order is the cascade. They consume `var(--rw-*)` and declare no tokens
  — `globals.css` owns those. Guard:
  [`design-scope-purity.test.ts`](../../../src/__tests__/design-scope-purity.test.ts).
- **Approved demo + spec:** [`docs/design/daylight-ii/`](../daylight-ii) — the demo is
  the visual spec; `system-amendments.md` is the token spec.
