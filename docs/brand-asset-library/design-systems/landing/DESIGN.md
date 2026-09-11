# RepWorth Landing — Style Reference

> **Scope:** `.rw-lp` · **Tokens:** [`src/components/sections/landing/landing-experience.css`](../../../../src/components/sections/landing/landing-experience.css) (+ [`hero/hero.css`](../../../../src/components/sections/landing/hero/hero.css)) ·
> **Utilities:** none (plain CSS) · **Guards:** [`design-scope-purity.test.ts`](../../../../src/__tests__/design-scope-purity.test.ts) (every custom property under `sections/landing/**` must be `--rw-lp-*`) · [`design-doc-token-pin.test.ts`](../../../../src/__tests__/design-doc-token-pin.test.ts) (this doc's tables ↔ the CSS)
> Which system am I in? → [`docs/brand-asset-library/design-systems/README.md`](../README.md)
> Before touching `src/components/sections/landing/**`, read [`measurements.md`](measurements.md) — most of the numbers in that folder are measurements with a documented failure mode, not preferences.

## Overview

**Current middle narrative — owner selection, 2026-09-10:** `/` uses **F3 with F1's Working Atlas roadmap**. Its authoritative composition, paper/ink sections, responsive refinements, imagery and motion contracts are saved in [the chosen design record](../../collections/2026-09-final/chosen-design.md). That selection supersedes the original middle-section anatomy described below. The existing hero, navigation, closing CTA, footer and their measured scrims remain current. The original middle sections and their helpers (`Staged`, the phone carousel, the agent flip card, the route-map path builder) were deleted from the codebase in the same day's cleanup, together with the `design-*` comparison routes: where this page describes sections 2–8, it is history, not a spec.

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
  The narrative sections (2–6, 8) are as tall as their content plus
  `--rw-lp-section-gap`; the one motion a block gets on arrival is `Reveal`'s ≤200ms
  opacity fade. One gold-filled pill is the primary action (nav, hero, closing band).
  Every label is the mono `--rw-lp-label-*` role.
- **Bookend cinema + arrival choreography (2026-08-24, owner override).** Three motions
  were deliberately added back inside the Linear pass's constraints: the two film
  bookends carry a scroll-linked push-in/settle (≤1.045, on an internal zoom layer,
  reader-driven), the hero copy enters in five staged beats on load, and the tiers
  gauge halo breathes. Native scroll is untouched, no section wrapper transforms, and no
  transform ever sits on an ancestor of the future section's glow.
- **The sections revamp (2026-08-24, owner-directed).** Sections 2–7 were elevated in
  place: every section's blocks enter as `Staged` beats (the hero-entrance grammar made
  shareable — motion-driven and finite, so the ambient pause rule cannot strand them),
  the fleet diagram assembles on arrival (wires draw in via motion `pathLength`) and a
  hovered node brightens its own wire, the autonomy dial is a circular OPERABLE gauge
  (two `aria-pressed` mode buttons swing a sprung needle), the problem section pairs the
  essay with an ambient generated diagram clip, and the future cards open with a
  generated off-CRT still. One header grammar binds all six: prose sections set left,
  instrument sections (fleet, tiers) centered, one heading scale
  (`clamp(1.75rem, min(4.4vw, 5.2vh), 3rem)`) and one lead scale
  (`clamp(0.9375rem, 1.1vw, 1.0625rem)`) — the problem essay's larger heading is the one
  stated exception. Constraints kept: native scroll, no snap, no transform on any
  ancestor of the future glow (future-section entrances are opacity-only), reduced
  motion renders settled frames everywhere.

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
[`measurements.md`](measurements.md)).

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
reasoning and the numbers are in [`measurements.md`](measurements.md).

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
| Arrival fade | `0.2s`, opacity only, `easeOut` | `Reveal` — the quiet default for a block entering the viewport |
| Arrival stagger | `60ms` per index, capped at 6 | `Reveal` |
| Staged beat | `650ms` fade + 14px rise, `110ms` per beat, once in view | `Staged` / `StagedLine` (`staged.tsx`) — the hero-entrance grammar shared by sections 2–7; `rise={0}` (opacity only) exists for any fixed-attachment surface (none on the page since the 2026-09-06 route map); reduced motion renders the final frame via `initial: false` |
| Pill hover | `translateY(-1px)` + lifted gold, `200–240ms` | nav pill, hero CTA, closing action |
| Hero entrance | 5 beats, `650ms` fade + 14px rise, `110ms` apart, once on load | hero copy column (`useHeroEntrance`); reduced motion renders the final frame via `initial: false` |
| Bookend push-in / settle | scale `1 → 1.045` (hero exit) and `1.045 → 1` (closing-band arrival), scroll-linked | `.rw-lp-hero-zoom` / `.rw-lp-cta-zoom` — internal zoom layers, never the media wrapper (a transformed box grows the page's scrollable overflow) |
| Route map arrival | ground fades (0.9s); lit road draws (`pathLength 0 → 1`, 1.1s); stops rise in travel order (0.55s, 70ms stagger); dashed roads and horizon fade after | `FutureSection` + `future.css`; one `useInView` arming signal, `amount: 'some'` |
| Stop card | glass card fades 180ms beside the hovered/focused stop; stop lifts 4px | `.rw-lp-future-stop-item[data-active='true']` |
| Lit-stop halo | opacity `1 → 0.55`, `4.5s`, infinite | `.rw-lp-future-stop-item[data-state='shipped'] .rw-lp-future-landmark::before`; covered by the universal pause rule, skipped under reduced motion |
| Fleet assembly | live wires draw in (motion `pathLength 0 → 1`, `0.9s`, `90ms` stagger); nodes/centre fade (opacity ONLY — they are measured); flow current + dashed NEXT wire fade in after (`data-armed` transitions) | `FleetSection` + `fleet.css`; one `useInView` arming signal |
| Wire hover | hovered node's wire goes steady full-strength, flow to `0.85` | `g[data-hot='true']` in `fleet.css`, driven by node `pointerenter` |
| Dial travel | needle + fill on a spring (`stiffness 170, damping 26`); needle swings via sprung endpoint math, never a CSS rotate on SVG | `TiersSection` — `useSpring`/`useTransform`; reduced motion jumps |
| Halo breathe | opacity `1 → 0.55`, `4.5s`, infinite | `.rw-lp-tiers-gauge-halo`; covered by the universal pause rule, skipped under reduced motion |
| Problem finale | gold rule draws (`scaleX 0 → 1`, `0.8s`), pivot beats land on it | `.rw-lp-problem-pivot-rule` — transform on the span itself, never an ancestor |

Native scroll. There is no smooth-scroll layer, no snap (Lenis or CSS), and no
scroll-linked section dissolve — all removed 2026-08-16 so the reader owns the wheel and
content is present when the viewport arrives. `Reveal` is opacity-only on purpose: it
never puts a transform on an ancestor of the future section's `background-attachment:
fixed` glow. The 2026-08-24 bookend cinema is scroll-LINKED, not scroll-hijacking: the
push-in rides the reader's own scroll on a layer inside sections 1 and 9, which are
siblings — not ancestors — of the future section. Zero layout-animating transitions remain on the page; zero `transition:
all`; zero `will-change` at rest. The reasoning is in
[`measurements.md`](measurements.md).

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

Role: the agent map — a LIVING diagram since 2026-08-24. Centred flex tiers of
nodes; a click opens the film in `VideoLightbox`.

- The **node cap**, not the container, sets the drawing width (`.rw-lp-fleet-node`).
- Unshipped capabilities render with a dashed border, dimmed media, a `COMING` tag, and a
  dashed unanimated connector.
- The diagram assembles on first view (one `useInView` arming signal): live wires draw
  in, nodes and centre fade up, the flow current starts after. Hovering a node lifts it
  and brightens its own wire (`data-hot`).
- **Measured elements enter by opacity only.** The nodes and the media card are measured
  for the wire endpoints (`getBoundingClientRect` includes transforms, and the observer
  re-fires only on size change) — an entrance transform would bake a mid-flight position
  into the wires. Nodes carry the object craft: lit top edge, inset highlight, hover lift
  with an ink shadow and a faint gold halo.

### Persona / watchdog flip cards (sections 3 + 4)

Role: the action layer and the oversight layer, distinguished by temperature.
`agent-flip-card.tsx` is shared; each section styles it.

- Personas are the shared portrait shape; **watchdog cards are the ROW form**, not the
  portrait shape. Since 2026-08-24 the row WORKS its width: a larger avatar stage
  (`clamp(5.5rem, 19vh, 9.5rem)`, teal rim) and the governing rule stamped as a mono
  plate in column 3 (`frontRule` prop on `AgentFlipCard`; hidden below 560px, where the
  rule stays on the back). The backs carry a teal cast that deepens on hover
  (hover-gated like every flip arm).
- **Three flip selectors, all required:** `:hover` (hover-capable fine pointers —
  media-gated, because sticky tap-hover latched cards flipped on touch),
  `[data-flipped='true']` (touch — the click toggle is gated to non-hover devices,
  since on a pointer device a click would latch the card flipped after the pointer
  left), `:focus-visible` (keyboard).
- `.rw-lp-flip .rw-lp-flip-face` is scoped deliberately — flattening the selector drops
  both faces into normal flow.

### The five jobs (between personas and watchdogs)

`jobs/JobsSection.tsx` + `jobs.css` + `jobs-copy.ts`. A hairline ledger, not a card
grid: index + verb (display 200, `clamp(1.5rem, 2.6vw, 2.25rem)`) · claim + body · two
meta cells ("Who does it", "Where you see it") under a column head that disappears ≤ 900px
in favour of per-row labels. `data-tone` follows the page's temperature rule — acting
agents gold, the watching layer and the run spine teal (the teal channels are copied from
`--rw-lp-watch-accent`; keep them in step). Static: no controls, so nothing joins
`focus-visible-marketing.test.ts`.

### Problem (section 6)

Role: the kinetic essay + the reputation diagram (v0.2, owner-directed 2026-08-24).
The essay owns the left column — staged heading lines, trimmed body, and the pivot
landing on a drawn gold rule; the right carries the section's one visual: an ambient
generated clip of a café orbited by what a customer finds (stars, a review bubble, a
reply arrow, one dark card — the silence). Grid AREAS keep the pivot the section's
exit at every width. Framed at reputation width (owner direction, 2026-08-24) so the
copy cannot go stale as new agents ship; the only product claim is the pivot line's
existence claim ("So we built the staff"). The diagram is decorative, `aria-hidden`,
claim-free (asset rules in `problem/problem-copy.ts`), rides `AmbientVideo`, and
shows its still under reduced motion.

### Tiers — Copilot vs Autopilot (section 8)

Role: the circular dial (v4, owner-directed 2026-08-24 — v3's straight track was
rejected in favour of the round instrument). A semicircular machined gauge sits
between the two modes: recessed groove, three detents and two end ticks ("a range,
not a toggle"), a sprung gold needle, and a fill that measures the granted autonomy.
It is OPERABLE: the mode names are two `aria-pressed` buttons (keyboard tab stops, no
custom key handling) that swing the needle and shift the modes' emphasis
(`data-active`); the gauge itself stays `aria-hidden` — it is the needle, not the
control. Both buttons ring in `--rw-lp-accent` and sit in the focus test. The needle
starts on Copilot — where every account starts — and the dial is an ILLUSTRATION: it
changes nothing but the page. Below 720px the gauge centres above the stacked modes
on a vertical travel line whose active node takes the gold. Neither mode takes a tier
temperature — they are modes, not agents — and nothing here is gold-filled in the
pill sense (the three pills stay the whole set).

### The watchdogs' door (section 4 → /how-it-works)

The pipeline is deliberately NOT a landing section (owner decision, 2026-08-24):
`/how-it-works` already tells it in depth, so the watchdogs section ends with a gold
text link there — `.rw-lp-watch-pipeline-link`, asserted in the focus test. Gold, not
teal: it is an action, not part of the oversight diagram. A text link, not a pill.

### Future (section 5)

Role: where this is going — the **route map** since 2026-09-06 (owner-directed; it
replaced the four "screens not yet on" cards). One **full-bleed** survey chart — a
sibling of the content column, edge to edge, 25:18 — a generated ground
(`/future/roadmap-ground.jpg`, made against the agent stills), an SVG road in the
chart's own 2000×1440 space, and fifteen HTML stops positioned by the same
coordinates (`future-copy.ts` owns them). **From 1280px up the header is the map's
title**: the section starts straight under the dial with no ink gap, the chart fades
up from ink over its top 36% (`--rw-lp-title-band`), and the header — eyebrow,
heading, lead, closing quote, legend — sits over that band inside the reading column
(`pointer-events: none`). Below 1280px the header stacks above the chart; below 900px
the chart is a trail, and the trail is an **accordion** — one row per stop (glyph,
marker, name, chevron), a tap opens the hint under it, one open at a time. Three states, and the difference is the
honesty mechanism: **shipped** stops are lit — a solid gold road, a gold `Shipped`
marker, a breathing halo, a landmark cutout with its screen on; **planned** stops are
the roadmap's locked Phases 1–5 — dashed dim road, `Phase n` marker, unpowered
landmark; **horizon** stops sit past the horizon line in fog — dotted branches fanning
out from Phase 5 (the order past it "may be re-ordered"), a `Later` marker, a glyph and
no landmark. A `Today` pin marks the end of the lit road. Every stop is a button:
hover, focus or tap opens a glass card with the body beside it (`aria-pressed`,
`aria-describedby` to the always-present body), and the chart's legend carries the
"not available yet" disclaimer. Below 900px the chart is abandoned for a trail — same
stops, same order, every body visible.

- The road draws in (`pathLength`) and the stops rise in travel order on one
  `useInView` arming signal (`amount: 'some'` — the trail is taller than a phone
  viewport, so a fraction never arms). Reduced motion renders the settled frame.
- Landmarks are cutouts under `public/future/stops/*.webp` (asset rules in
  `future-copy.ts`); lit stops stand taller than planned ones (`--rw-lp-landmark`).
- Labels alternate above/below the road along its length (`data-label`), which is what
  lets fifteen stops share one chart; neighbours never share a side.
- The marker beside every unbuilt name is load-bearing: a skim reads names before
  bodies. Do not give a planned or horizon stop the lit treatment, and do not move the
  legend off the chart.
- **Clouds past the horizon**: two generated plates screen-blended over the fog, drifting
  on CSS keyframes (pause-rule covered), under the stops. See `measurements.md` assets.
- **Unbuilt stops are hinted, not named** (owner decision 2026-09-06): the name is a
  short tease, the body one future-tense sentence about the outcome, the landmark the
  only literal clue. The stop-to-phase mapping is a comment in `future-copy.ts`.
- The old cards' `background-attachment: fixed` glow left with them; this section no
  longer forbids transforms on its ancestors (see `staged.tsx` on `rise=0`).

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

Role: the WCAG 2.2.2 pause control. **One** control (`ambient-motion.tsx`) governs all 9
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

- **Do** read [`measurements.md`](measurements.md) before touching
  `src/components/sections/landing/**`. Many values in there look arbitrary and are not.
- **Do** use `--rw-lp-*` tokens only. Any translucent shade of ink, text, or gold rides
  its channel token.
- **Do** keep the `.rw-lp-` prefix on every class in this folder.
- **Do** add any new interactive element to `focus-visible-marketing.test.ts` (it asserts
  a ring on **16** landing controls today, across 15 rows — the dial's two mode buttons
  share one).
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
- **Don't** reintroduce snap, smooth-scroll, or a scroll-linked transform on a section
  wrapper. The page scrolls natively (2026-08-16). The one sanctioned scroll-linked
  transform is the bookends' internal zoom layer (2026-08-24, owner override) —
  inside sections 1 and 9, never on them.
- **Don't** add a fourth gold-filled element. The nav pill, the hero CTA and the closing
  action are the whole set.
- **Don't** "tidy" a load-bearing number. Every one of them is indexed in
  [`measurements.md`](measurements.md) and commented at its call site.

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

Two generated companions joined 2026-08-24, both made against the agent stills as
style reference so they inherit the world: `public/problem/problem-diagram.{mp4,jpg}`
(the reputation diagram — a café orbited by review artifacts; 10s seamless ping-pong
loop, 108KB, locked camera) and — until 2026-09-06 — `public/future/off-crt.jpg` (the
unpowered set on the old future cards). The route map's assets replaced it: the chart
ground `public/future/roadmap-ground.jpg` (3840px, a 2× upscale of the 2752px generation)
and ten landmark cutouts under
`public/future/stops/` (Runway nano-banana-pro against the same stills; flat-ground
cutouts via a PIL flood-fill, WebP with alpha). Asset rules for the diagram live in
`problem/problem-copy.ts`, for the map in `future/future-copy.ts`.

### Ambient video

Every looping background clip must go through `AmbientVideo` (`ambient-motion.tsx`) so
none can escape the WCAG 2.2.2 pause control.

### Scroll

Native. Nothing intercepts the wheel, nothing snaps, nothing dissolves on scroll. Blocks
inside a section arrive with `Reveal` (opacity, ≤200ms) or as `Staged` beats (the
hero-entrance grammar, once, on first view — see the Motion table); both are
viewport-triggered arrivals, never scroll-scrubbed. The Lenis + Snap layer, the CSS snap fallback, `SectionTransition`, the
chapter rail and the chapter markers were removed together on 2026-08-16 — see
[`measurements.md`](measurements.md) §2 for what was measured and why it went.

### Generating new media

**A mistake worth not repeating:** pinning both start and end frames to the same still
tells the model "return exactly here", and the cheapest way to satisfy that is to barely
move (measured 0.10 and 0.07 inter-frame motion). Generate with a **start frame only** and
make loops seamless in post via ping-pong.

## Copy accuracy contracts

The brief's §3.2 calls confusing shipped capability with roadmap "the one genuinely
damaging mistake available here." Each `*-copy.ts` opens with its contract. Binding
across all of them:

- **Solicitor is present tense since 2026-09-06** (owner decision, on the commitment to
  flip `SOLICITATION_WATCH_ENABLED` + `SOLICITATION_SEND_ENABLED` on in production;
  PRODUCT.md "Shipped today"). `status: 'live'` in `fleet-copy.ts` and
  `personas-copy.ts`; the `'next'` treatment (dashed border, dimmed media, `COMING` tag,
  dashed connector) stays wired for the next unshipped agent. Solicitor sends **email
  only** and never posts — never name SMS, Telegram, or WhatsApp for it.
- **The five jobs ledger (`jobs/`) is the balance device.** Respond, Protect, Request,
  Brief, Measure get one equal row each. Do not let a job's row grow a card, a control,
  or a bigger type step than its neighbours — equality is the argument.
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

- **CSS variables:** [`src/components/sections/landing/landing-experience.css`](../../../../src/components/sections/landing/landing-experience.css)
  (`.rw-lp` block) and [`hero/hero.css`](../../../../src/components/sections/landing/hero/hero.css)
  (`.rw-lp-hero` block) — those blocks ARE the export; do not copy them here.
- **Tailwind v4:** none. Landing is plain CSS. Add a `landing/theme.css` only if a
  `bg-rw-lp-*` utility is ever needed.
