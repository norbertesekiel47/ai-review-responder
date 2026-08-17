# RepWorth Landing — Style Reference

> **Scope:** `.rw-lp` · **Tokens:** [`src/components/sections/landing/landing-experience.css`](../../../src/components/sections/landing/landing-experience.css) (+ [`hero/hero.css`](../../../src/components/sections/landing/hero/hero.css)) ·
> **Utilities:** none (plain CSS) · **Guards:** [`design-scope-purity.test.ts`](../../../src/__tests__/design-scope-purity.test.ts) (every custom property under `sections/landing/**` must be `--rw-lp-*`) · [`design-doc-token-pin.test.ts`](../../../src/__tests__/design-doc-token-pin.test.ts) (this doc's tables ↔ the CSS)
> Which system am I in? → [`docs/design/README.md`](../README.md)
> Before touching `src/components/sections/landing/**`, read [`measurements.md`](./measurements.md) — most of the numbers in that folder are measurements with a documented failure mode, not preferences.

## Overview

**The landing page is deliberately unlocked from the Island system.** `PRODUCT.md`
records this exception (agreed 2026-08-03): `/` may establish its own world; the rest of
the site does not follow it. Do not "restore" sage/teal/peach here.

The world is a green-black ink ground that ties to the hero video, a single gold accent
carried across the whole page, and a cooler teal reserved for the watchdog tier — set in
Plus Jakarta Sans at 200/300, weights that exist for this page.

**Key characteristics:**

- One ground: `--rw-lp-ink`, the near-black green sampled off the hero clip's foliage.
- One gold: `--rw-lp-accent`, which is simultaneously the accent, the focus-ring colour,
  and the **acting agents**' temperature.
- One cooler teal, used only for the **watchdogs** — the temperature shift is the tier.
- Warm near-white text, never pure `#fff`.
- Every colour carried as a channel token so any translucent shade rides the token
  instead of a hand-written `rgba()` copy.
- Full-bleed video bookends (sections 1 and 9), liquid-glass narrative sections between.
- **Native scroll, content-height sections (2026-08-16 Linear pass).** No smooth-scroll
  layer, no snap, no scroll-linked dissolve, no chapter rail or markers, no scroll cue.
  Sections 2–5 are as tall as their content plus `--rw-lp-section-gap`; the one motion
  on arrival is `Reveal`'s ≤200ms opacity fade. One gold-filled pill is the primary action
  (nav, hero, closing band). Every label is the mono `--rw-lp-label-*` role.

**Sections 1 and 9 are a deliberate pair:** the same world, opened in daylight with the
copy set RIGHT and closed at night with it set LEFT. They are the only two full-bleed
video sections; they mirror rather than repeat.

## Tokens — Colors

Every row is declared in `.rw-lp` (`landing-experience.css`) or `.rw-lp-hero`
(`hero/hero.css`).

### Page

| Name | Value | Token | Role |
|---|---|---|---|
| Ink channels | `20 32 28` | `--rw-lp-ink-rgb` | the ground, as bare RGB channels |
| Ink | `rgb(var(--rw-lp-ink-rgb))` | `--rw-lp-ink` | page ground (green-black, ties to the hero video) |
| Text channels | `244 242 236` | `--rw-lp-text-rgb` | the type colour, as bare RGB channels |
| Text | `rgb(var(--rw-lp-text-rgb))` | `--rw-lp-text` | warm near-white, never pure `#fff` |
| Accent channels | `220 196 137` | `--rw-lp-accent-rgb` | the gold, as bare RGB channels |
| Gold | `rgb(var(--rw-lp-accent-rgb))` | `--rw-lp-accent` | accent + focus rings + **acting agents** (9.82:1 on the page ink) |

`rgb(244 242 236)` **is** `#f4f2ec`, `rgb(20 32 28)` **is** `#14201c`, and
`rgb(220 196 137)` **is** `#dcc489` — the derived form and the channel form cannot drift
because one is computed from the other.

### Hero

| Name | Value | Token | Role |
|---|---|---|---|
| Hero ink | `#14201c` | `--rw-lp-hero-ink` | hero ground behind the clip |
| Hero text | `#f4f2ec` | `--rw-lp-hero-text` | hero copy |
| Hero accent | `var(--rw-lp-accent, #dcc489)` | `--rw-lp-hero-accent` | hero headline accent; owned by `.rw-lp` so the accent and the focus ring cannot drift apart — the literal is only a standalone fallback |
| Hero rule | `rgb(var(--rw-lp-text-rgb) / 0.28)` | `--rw-lp-hero-rule` | hairline |

### The watchdog teal

The cooler teal that marks the oversight tier is **section-scoped**, not a page token:
`--rw-lp-watch-accent` in `watchdogs/watchdogs.css`.

**Gold vs teal is load-bearing, not decoration.** Sections 3 and 4 are the same kind of
content; the temperature shift is the only thing making the oversight layer read as a
different tier from the action layer. Collapse the two and the diagram stops arguing
anything.

### Channel tokens — why

`--rw-lp-text`, `--rw-lp-ink` and `--rw-lp-accent` are complete colours, and a complete
colour cannot be given an alpha. Every translucent shade therefore had to be hand-written
as a literal — 101 of them across eleven files, each a copy of a value that has a token,
and each a place the page could drift if any of the three were retuned. Channel tokens
let the alpha ride on the token: `rgb(var(--rw-lp-text-rgb) / 0.62)`.
`color-mix(in srgb, …)` would do the same job; the channel form is preferred because the
alpha stays a plain number you can read at a glance, which matters on a page where
several of those numbers are load-bearing contrast measurements.

### Deliberate literals — do not "fold these in"

- **24 `rgba(255, 255, 255, x)`** — the liquid-glass highlights. A specular highlight is
  genuinely white, not the text colour at low alpha; folding them into a token would be
  wrong, not tidier.
- **1 `rgba(169, 198, 192, 0.07)`** — the watchdogs' teal wash. One caller, one alpha; a
  channel token for it would be an abstraction for a single use.
- **3 one-off darks** (`rgba(0,0,0,…)` ×2, `rgba(10,16,14,0.94)` for the lightbox
  `::backdrop`) — none of them is a page token.

## Tokens — Typography

| Role | Stack | Weights |
|---|---|---|
| Display | Plus Jakarta Sans | 200 / 300 |
| Button | Plus Jakarta Sans | 600 |
| Label | JetBrains Mono (`--rw-lp-label-font` → `--rw-font-mono`) | 400 |

The 200/300 weights exist for this page's light-weight editorial register and are added
in `src/app/layout.tsx` (the family's variable range there is `200 800`; 400–800 are the
established app/marketing weights). The Landing page declares no font *families* of its
own — it consumes the brand families from `globals.css` — but it does own the **label
role**: every section eyebrow and tier label is set in the mono face at
`--rw-lp-label-size` (12px) with `--rw-lp-label-tracking` (0.04em), uppercase at the call
site. One label style for the page, instead of 10–11px display-face caps at 0.24–0.28em.

| Name | Value | Token | Role |
|---|---|---|---|
| Label font | `var(--rw-font-mono)` | `--rw-lp-label-font` | section eyebrows, tier labels, the persona column note |
| Label size | `0.75rem` | `--rw-lp-label-size` | 12px |
| Label tracking | `0.04em` | `--rw-lp-label-tracking` | a hair, not a spread |

**No negative letter spacing or viewport-scaled type** beyond what is already measured
(the footer wordmark's `-0.02em` tracking is a measured value — see
[`measurements.md`](./measurements.md)).

## Tokens — Spacing & Shape

### Layout

| Name | Value | Token | Role |
|---|---|---|---|
| Content gutter | `clamp(1.5rem, 4vw, 4rem)` | `--rw-lp-gutter` | contained blocks (the sections' inner columns, the footer's inner row) |
| Content column | `75rem` | `--rw-lp-inner-max` | the narrative sections' column (2–5) and the footer, single owner — 1200px |
| Section gap | `clamp(4rem, 8vw, 6rem)` | `--rw-lp-section-gap` | top + bottom padding of sections 2–5 — 96px at desktop; replaces the `100svh` bind |
| Page edge | `clamp(1.25rem, 3vw, 3rem)` | `--rw-lp-edge` | full-bleed chrome in the viewport corners (the nav); drops to `1rem` below 380px |

`--rw-lp-inner-max` is a **reading ceiling** since 2026-08-16 (it was a measured
fit-the-viewport ceiling of 102rem while sections were bound to `100svh`), and
`--rw-lp-edge` is deliberately tighter than the content gutter so the corners read as
corners. Sections 2–5 are as tall as their content plus `--rw-lp-section-gap` — never as
tall as the screen. Sections 1 and 9 keep `min-height: 100svh`: they are full-bleed film,
the clip is the content, and their scrim geometry is measured against the full frame. The
reasoning and the numbers are in [`measurements.md`](./measurements.md).

### Shape & surface

- **Liquid glass** (`.rw-lp-glass`) is the shared surface for the narrative sections. Its
  border is a gradient **stroke**, not a flat 1px rule: a `::before` inset with
  `padding: 1.4px` filled with a vertical white gradient, then the interior punched out
  with `mask-composite: exclude`. That leaves only the ring, so the edge is bright at top
  and bottom and vanishes at the sides — the way real glass catches light. A plain
  `border` cannot vary along its own length.
- `-webkit-` prefixes are load-bearing: Safari still requires them for both
  `mask-composite` (as `xor`) and `backdrop-filter`.

### Motion

| Name | Value | Where |
|---|---|---|
| Arrival fade | `0.2s`, opacity only, `easeOut` | `Reveal` — the ONE motion a block gets on entering the viewport |
| Arrival stagger | `60ms` per index, capped at 6 | `Reveal` |
| Pill hover | `translateY(-1px)` + lifted gold, `200–240ms` | nav pill, hero CTA, closing action |

Native scroll. There is no smooth-scroll layer, no snap (Lenis or CSS), and no
scroll-linked section dissolve — all removed 2026-08-16 so the reader owns the wheel and
content is present when the viewport arrives. `Reveal` is opacity-only on purpose: it
never puts a transform on an ancestor of the future section's `background-attachment:
fixed` glow. Zero layout-animating transitions remain on the page; zero `transition:
all`; zero `will-change` at rest. The reasoning is in
[`measurements.md`](./measurements.md).

## Components

Each narrative section is its own module under `sections/landing/<section>/` with
colocated CSS and a `*-copy.ts`. `LandingExperience.tsx` is a composition root owning only
the chrome — nav, the single `<main id="main-content">` landmark, the footer — plus a
numbered section map. Sections sit directly in the landmark; there is no wrapper.

### Hero (section 1)

Role: the daylight bookend. Full-bleed character video, copy set RIGHT, a scrim ramp
carrying the copy column.

- Spec: `.rw-lp-hero` owns `--rw-lp-hero-*`; `min-height: 100svh`; `isolation: isolate`;
  `object-fit: cover` with a measured `object-position`. No scroll cue (removed
  2026-08-16).
- **Never** lower a scrim stop or move the copy column without re-measuring — the scrim
  stops and the copy start are a paired system (`measurements.md`).
- The primary CTA (`.rw-lp-hero-cta`) is a **filled gold pill** — ink text, label then
  arrow, 44px tall, focus ring 3px outward. See **Primary action pill** below.

### Primary action pill (nav · hero · closing band)

Role: the page's one action, in one grammar, three places. Gold fill (`--rw-lp-accent`),
ink text (`--rw-lp-ink`), Plus Jakarta 600, sentence case, radius `999px`, arrow after
the label on the hero and closing band. Ink on gold is the same 9.82:1 pair as gold on
ink. Hover lifts to `#e8d3a1` and `translateY(-1px)`.

- `.rw-lp-nav-cta` — 36px, 13px type. Flag on: "Sign up" (with Log in beside it); flag
  off: `primaryCtaLabel` → `primaryCtaHref`. Never both. Hidden ≤900px, where the menu
  panel carries the same door.
- `.rw-lp-hero-cta` and `.rw-lp-cta-action` — 44px, 15px type, arrow.
- **These three are the only gold-FILLED elements on the page.** That is what lets the
  gold read as "the action" rather than as decoration. Do not add a fourth.

### Fleet (section 2)

Role: the agent map. Centred flex tiers of nodes; a click opens the film in
`VideoLightbox`.

- The **node cap**, not the container, sets the drawing width (`.rw-lp-fleet-node`).
- Unshipped capabilities render with a dashed border, dimmed media, a `COMING` tag, and a
  dashed unanimated connector.

### Persona / watchdog flip cards (sections 3 + 4)

Role: the action layer and the oversight layer, distinguished by temperature.
`agent-flip-card.tsx` is shared; each section styles it.

- Personas are the shared portrait shape; **watchdog cards are the ROW form**, not the
  portrait shape.
- **Three flip selectors, all required:** `:hover` (pointer), `[data-flipped='true']`
  (touch), `:focus-visible` (keyboard).
- `.rw-lp-flip .rw-lp-flip-face` is scoped deliberately — flattening the selector drops
  both faces into normal flow.

### Future (section 5)

Role: what is coming. **Static** cards (tag, name, body all visible — the flip was
removed 2026-08-16; a roadmap does not need a reveal) whose glow is
`background-attachment: fixed`.

- Nothing above the section may put a transform on an ancestor — a transformed ancestor
  silently downgrades fixed attachment to `scroll`. `Reveal` is opacity-only for exactly
  this reason.
- The glow's `::after` uses two stacked gradients, **not** `filter: brightness()`.
- The `PLANNED` tag is load-bearing: a skim reads the four names before a body, and the
  tag is what marks them as unbuilt at that glance.
- Card padding is `1.5rem` (24px); cards are sized by content.

### CTA (section 9)

Role: the night bookend. Full-bleed video, copy set LEFT.

- The clip choice **is** the framing fix. Do not swap the source without moving the copy
  with it.
- The action (`.rw-lp-cta-action`) is the same filled pill as the hero's.

### Footer

- The wordmark is decorative (`aria-hidden`) and its viewBox is measured; re-measure the
  glyph run before changing the wordmark text, font size, or tracking.
- **Legal is a bottom-bar ROW, not a third column.** The links reuse `.rw-lp-foot-link`
  so the asserted focus ring covers them.
- The bottom bar's leading cell (`.rw-lp-foot-bottom-lead`) holds the ambient-motion
  toggle and the copyright as one unit, so the bar wraps as a pair.

### Ambient-motion control

Role: the WCAG 2.2.2 pause control. **One** control (`ambient-motion.tsx`) governs all 8
looping clips *and* every infinite CSS animation. The CSS half is a single universal
`animation-play-state` rule on `.rw-lp[data-ambient-motion]`, so an animation added later
is covered without anyone remembering to.

- It lives **in the footer's bottom bar, in flow, at every width** (since 2026-08-16). The
  fixed bottom-left placement it had before overlapped the closing band's note text at
  1440×900. The trade — the control now sits after the moving content — is stated in
  `landing-experience.css`; if the nav ever becomes sticky, this is the control to move
  into it.
- The pause state does not persist. Deliberate: a persisted "motion off" is a preference,
  and this page has no preference store.

## Do's and Don'ts

### Do:

- **Do** read [`measurements.md`](./measurements.md) before touching
  `src/components/sections/landing/**`. Many values in there look arbitrary and are not.
- **Do** use `--rw-lp-*` tokens only. Any translucent shade of ink, text, or gold rides
  its channel token.
- **Do** keep the `.rw-lp-` prefix on every class in this folder.
- **Do** add any new interactive element to `focus-visible-marketing.test.ts` (it asserts
  a ring on **13** landing controls today).
- **Do** take the **structure** from a reference and keep RepWorth's palette and Plus
  Jakarta. Four references were adapted, never copied — each shipped its own palette
  (EOSAI dark/gold; a `#0a0a0a` + Playfair spec; an Orbis `#010828` + Anton spec; a
  `#3ca2fa` blue hover-footer with a five-stop rainbow). Keep doing that.
- **Do** import from `motion/react` — the import path for Motion v12, never
  `framer-motion` — and keep the page on `LazyMotion + m` with `strict` at the root, so a
  stray `motion.*` throws instead of silently re-inflating the bundle.
- **Do** measure before claiming. Contrast, motion, section fit, jank and clipping were
  all verified numerically, and in several cases the measurement contradicted what the
  screenshot suggested.
- **Do** correct the comment when the measurement disagrees.
- **Do** flag conflicts rather than silently picking.

### Don't:

- **Don't** "restore" sage / teal / peach here. `/` is unlocked from the Island system.
- **Don't** reuse the Island's `--rw-teal-strong` focus token — it is a dark teal, all but
  invisible on this ink. Landing rings use `--rw-lp-accent`.
- **Don't** shorten the prefix to `.rw-hero-*` or `.rw-foot-*`. `globals.css` already owns
  `.rw-hero` (the `/features` hero) and `.rw-foot`, whose descendant selectors beat a
  single-class rule and silently render headlines near-black on the dark scrim.
- **Don't** collapse the gold and the teal — the temperature shift *is* the tier.
- **Don't** fold the deliberate literals into tokens (see **Tokens — Colors**).
- **Don't** reintroduce snap, smooth-scroll, or a scroll-linked section transform. The
  page scrolls natively (2026-08-16); a transformed ancestor also breaks the future
  section's fixed-attachment glow.
- **Don't** add a fourth gold-filled element. The nav pill, the hero CTA and the closing
  action are the whole set.
- **Don't** "tidy" a load-bearing number. Every one of them is indexed in
  [`measurements.md`](./measurements.md) and commented at its call site.

## Surfaces & Elevation

There is one ground and one surface: the page ink, and liquid glass on top of it. Depth
comes from the gradient stroke and a `1px` inner highlight, not from shadow stacks.
The two video sections have no surface at all — the clip *is* the ground, darkened by a
measured scrim ramp.

## Imagery & Motion

### The agent media

Six agent clips (`public/agents/*.{mp4,jpg}`) generated from a cropped hero frame so they
inherit the real CRT body. **Personas move their bodies; watchdogs only change state** —
the Judge's body is still, only the iris moves. That distinction carries the same tier
argument the gold/teal split does.

The 6 avatar clips are `aria-hidden`, declared on the wrapper so it covers the
reduced-motion still as well as the video.

### Ambient video

Every looping background clip must go through `AmbientVideo` (`ambient-motion.tsx`) so
none can escape the WCAG 2.2.2 pause control.

### Scroll

Native. Nothing intercepts the wheel, nothing snaps, nothing dissolves on scroll. Blocks
inside a section arrive with `Reveal` (opacity, ≤200ms) and that is the whole scroll
vocabulary. The Lenis + Snap layer, the CSS snap fallback, `SectionTransition`, the
chapter rail and the chapter markers were removed together on 2026-08-16 — see
[`measurements.md`](./measurements.md) §2 for what was measured and why it went.

### Generating new media

**A mistake worth not repeating:** pinning both start and end frames to the same still
tells the model "return exactly here", and the cheapest way to satisfy that is to barely
move (measured 0.10 and 0.07 inter-frame motion). Generate with a **start frame only** and
make loops seamless in post via ping-pong.

## Copy accuracy contracts

The brief's §3.2 calls confusing shipped capability with roadmap "the one genuinely
damaging mistake available here." Each `*-copy.ts` opens with its contract. Binding
across all of them:

- **Solicitor is NOT shipped.** Verified in code: `SOLICITATION_SEND_ENABLED` is in no
  environment file. Dashed border, dimmed media, `COMING` tag, dashed unanimated
  connector. Future tense everywhere.
- **The Judge governs auto-posting only.** On Copilot the owner approves and the Judge is
  not in that path. Never "reviews everything that goes out".
- **Guardian never acts publicly** — that is its whole identity.
- **Reply is the only persona that can publish**, and only inside owner bounds.
- **Section 5's `PLANNED` tag is load-bearing.** A skim reads the four names before it
  reads a body, and the tag is what marks them as unbuilt at that glance (the body — and
  every future-tense "will" — is on the card since 2026-08-16; before that it was behind a
  flip). Do not remove it.
- **The exploring tier was cut** (owner decision). The eight ideas survive as a comment in
  `future-copy.ts`, not an export, so they cannot render by accident. If they return:
  plain text lines under their own label, never cards.
- **The CTA button label is server-resolved.** `primaryCtaLabel` becomes "Start your N-day
  free trial" when `TRIAL_ENABLED` flips. Never hard-code "Join for early access" —
  invariant #13.
- **No fabricated proof.** No customers, testimonials, logos, metrics, phone numbers,
  postal addresses, or social accounts exist. The footer omits the social row rather than
  linking `#`. `support@repworth.net` is real — it is the contact of record in
  `src/lib/legal/content.ts`.
- **Nav auth is flag-gated as marketing posture** (revised 2026-08-14). It used to be
  correctness: both `/login` and `/signup` called `notFound()` when
  `SELF_SERVE_SIGNUP_ENABLED` was off. Since the flag was re-scoped to mean only
  *strangers may mint accounts*, **`/login` is always on** — only `/signup` still 404s
  without it. The nav pair stays gated deliberately: with self-serve off there is nothing
  for an anonymous visitor to sign up for, and admin-invited owners reach `/login` from
  their invite email rather than from this nav.

Every section keeps its copy in a `*-copy.ts`. That is deliberate: those files carry the
accuracy contracts, and keeping prose out of JSX makes them reviewable as prose.

## Agent prompt guide

- **"Build a primary CTA on this page"** → gold ring / gold type on the ink ground:
  `--rw-lp-accent` for the ring and the label, `rgb(var(--rw-lp-accent-rgb) / a)` for any
  translucent state. Never `--rw-teal-strong`.
- **"Add a narrative section"** → a new module under `sections/landing/<section>/` with
  its own CSS and `*-copy.ts`, placed directly in `<main>`, width bound to
  `--rw-lp-inner-max`, `width: 100%` on its `-inner` wrapper, registered in
  `scroll/section-map.ts`.
- **"Add a surface"** → `.rw-lp-glass`. Do not hand-roll a border; the gradient stroke is
  the surface.
- **"Add a looping background clip"** → `AmbientVideo`, `aria-hidden` on the wrapper.
- **"Add an interactive control"** → give it a `--rw-lp-accent` focus ring and add it to
  `focus-visible-marketing.test.ts`.

## Exports

- **CSS variables:** [`src/components/sections/landing/landing-experience.css`](../../../src/components/sections/landing/landing-experience.css)
  (`.rw-lp` block) and [`hero/hero.css`](../../../src/components/sections/landing/hero/hero.css)
  (`.rw-lp-hero` block) — those blocks ARE the export; do not copy them here.
- **Tailwind v4:** none. Landing is plain CSS. Add a `landing/theme.css` only if a
  `bg-rw-lp-*` utility is ever needed.
