# RepWorth Landing — Style Reference

> **Scope:** `.rw-lp` · **Tokens:** [`src/components/sections/landing/landing-experience.css`](../../../../src/components/sections/landing/landing-experience.css) (+ [`hero/hero.css`](../../../../src/components/sections/landing/hero/hero.css)) ·
> **Utilities:** none (plain CSS) · **Guards:** [`design-scope-purity.test.ts`](../../../../src/__tests__/design-scope-purity.test.ts) (every custom property under `sections/landing/**` must be `--rw-lp-*`) · [`design-doc-token-pin.test.ts`](../../../../src/__tests__/design-doc-token-pin.test.ts) (this doc's tables ↔ the CSS)
> Which system am I in? → [`docs/brand-asset-library/design-systems/README.md`](../README.md)
> Before touching `src/components/sections/landing/**`, read [`measurements.md`](measurements.md) — most of the numbers in that folder are measurements with a documented failure mode, not preferences.

## Overview

**Middle sections — owner selection, 2026-09-10.** Sections 2–8 follow the owner-selected composition. Its exact decisions, measurements and interaction contracts live in [the chosen design record](../../collections/2026-09-final/chosen-design.md); this page covers the page-wide system, the bookends, the chrome, and a summary of each middle section.

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
- Full-bleed video bookends (sections 1 and 9). Between them, editorial sections on warm
  paper and ink, set in two type scopes (`section-scopes.css`): serif headings over the
  body face, and Georgia editorial headings.
- **Native scroll, content-height sections (2026-08-16 Linear pass).** No smooth-scroll
  layer, no snap, no scroll-linked dissolve, no chapter rail or markers, no scroll cue.
  Every section except the two bookends is as tall as its content. One gold-filled pill
  is the primary action (nav, hero, closing band). Labels use the mono `--rw-lp-label-*`
  role.
- **Bookend cinema + arrival choreography (2026-08-24, owner override).** The two film
  bookends carry a scroll-linked push-in/settle (≤1.045, on an internal zoom layer,
  reader-driven), and the hero copy enters in five staged beats on load. Native scroll
  is untouched and no section wrapper transforms.

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
| Page edge | `clamp(1.25rem, 3vw, 3rem)` | `--rw-lp-edge` | full-bleed chrome in the viewport corners (the nav); drops to `1rem` below 380px |

`--rw-lp-inner-max` is a **reading ceiling** since 2026-08-16 (it was a measured
fit-the-viewport ceiling of 102rem while sections were bound to `100svh`), and
`--rw-lp-edge` is deliberately tighter than the content gutter so the corners read as
corners. Sections 2–8 are as tall as their content — never as tall as the screen. Sections 1 and 9 keep `min-height: 100svh`: they are full-bleed film,
the clip is the content, and their scrim geometry is measured against the full frame. The
reasoning and the numbers are in [`measurements.md`](measurements.md).

### Shape & surface

- The middle sections have no shared surface. Each paints its own paper or ink ground,
  and the two type scopes carry their tokens (`section-scopes.css`). Framed media — the
  problem house's tilted square, the courtyard, the agents' CRT arch, the watchdogs' arched
  scene — is shaped per section; shapes and radii are in the chosen design record.
- A curved frame owns `overflow: hidden`, so its media cannot protrude through the curve.

### Motion

| Name | Value | Where |
|---|---|---|
| Pill hover | `translateY(-1px)` + lifted gold, `200–240ms` | nav pill, hero CTA, closing action |
| Hero entrance | 5 beats, `650ms` fade + 14px rise, `110ms` apart, once on load | hero copy column (`useHeroEntrance`); reduced motion renders the final frame via `initial: false` |
| Bookend push-in / settle | scale `1 → 1.045` (hero exit) and `1.045 → 1` (closing-band arrival), scroll-linked | `.rw-lp-hero-zoom` / `.rw-lp-cta-zoom` — internal zoom layers, never the media wrapper (a transformed box grows the page's scrollable overflow) |
| Agent selection | the CRT shows the agent whose paragraph crosses the reading line: 50% of the viewport on desktop; on phones the sticky strip's bottom + 64px, capped at 80% | `PersonasSection` — `useScroll` plus a resize listener |
| Lever swing | `0.7s` (the film plays at `duration / 0.7`); the film into Autopilot starts at 44% | `TiersSection`; reduced motion or pause switches instantly |
| Roadmap chapter | the ground pans by `transform-origin` (`.35s`); the cloud plates fade in on Horizon (`.35s`) | `.rw-lp-final-atlas-map` in `future.css`; reduced motion drops the transitions |
| Ambient clips | load near the viewport, play only in view, keep their still under reduced motion or on failure | `AmbientVideo`, through `brand-clip.tsx` and each section's clip helper |

Native scroll. There is no smooth-scroll layer, no snap (Lenis or CSS), and no
scroll-linked section dissolve — all removed 2026-08-16 so the reader owns the wheel and
content is present when the viewport arrives. The 2026-08-24 bookend cinema is
scroll-LINKED, not scroll-hijacking: the push-in rides the reader's own scroll on a layer
inside sections 1 and 9. The reasoning is in [`measurements.md`](measurements.md).

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

### Problem (section 2)

`problem/`. A warm paper band: the heading, the house film in a tilted square (16px
corners, −3°) and the explanation, in one row on desktop; on phones the film sits small
beside the heading. The film is decorative, `aria-hidden`, claim-free (asset rules in
`problem/problem-copy.ts`), and shows its still under reduced motion.

### Fleet (section 3)

`fleet/`. The pivot line, the heading and the film button above a full-width 3:1
courtyard (`public/fleet/courtyard.webp`) with four station pills; each pill links to its
agent in section 4. The film opens in `VideoLightbox`. Phones keep the whole scene with
numbered pins and move the pills into a two-column index under it. Never crop the scene
to fill a taller box.

### The agents that act (section 4)

`personas/`. Copy alternates left and right of a tall central CRT arch on desktop; the
CRT shows the agent whose paragraph sits on the reading line (see the Motion table). On
phones the CRT is a sticky strip, `min(190px, 28svh)` tall, with four 44px numbered
controls below its arch on a solid paper ground. Each agent states its limit
(`publishLabel`).

### The five jobs (section 5)

`jobs/`. One row per job — Respond, Protect, Request, Brief, Measure — with a sticky
verb, the job's own film (`public/jobs/*.{webp,mp4}`), a claim, a body, and where the
owner meets the result. Equal rows are the argument: no job grows a card or a bigger type
step than its neighbours.

### The agents that watch (section 6)

`watchdogs/`. The Judge and Governor on the left; the paired original CRTs inside an
arched scene on the right, above the trust statement. The scene owns `overflow: hidden`.
The section ends with the gold text link to `/how-it-works`: the pipeline is deliberately
not a landing section (owner decision, 2026-08-24).

### Owner controls — Copilot vs Autopilot (section 7)

`tiers/`. Light paper: the heading spans the left column; the dispatch scene
(`public/tiers/`) and a two-button selector stack on the right. Copilot is the lever at
the left, over the approval tray; Autopilot is the lever at the right, over the dispatch
desk. The selector explains the plans — it changes no subscription. This section is the
page's door to `/pricing`. Its controls ring in the darker brass `#b17f30` on this light
paper.

### Where this is going (section 8)

`future/`. The Working Atlas: three chapter buttons (Shipped, Planned, Horizon), a map
of the chapter's five illustrated stops, and a detail ledger. The chapter only reframes
the ground — Shipped bright left, Planned darker centre, Horizon right under cloud plates
— from the original 3840px `public/future/roadmap-ground.jpg` at 1.75×. Landmark cutouts
live under `public/future/stops/`. Every stop's detail says "Available today" or "Not
available yet", and the section footer repeats it. Unbuilt stops are hinted, not named
(owner decision 2026-09-06; the stop-to-phase mapping is a comment in `future-copy.ts`).

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

Role: the WCAG 2.2.2 pause control. **One** control (`ambient-motion.tsx`) governs every
looping clip *and* any keyframe animation. The CSS half is a single universal
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
- **Do** add any new interactive element to `focus-visible-marketing.test.ts` (one row per
  control, or per scope where a scope rule rings all its controls).
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

There is no shared surface. The chrome sits on the page ink; the middle sections paint
their own paper or ink grounds. Depth comes from framed media, not from shadow stacks.
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

The 2026-09-10 selection added `public/fleet/courtyard.webp`, the five job films
(`public/jobs/*.{webp,mp4}`) and the owner-control media (`public/tiers/`: lever stills,
transition films, station activity). Provenance is in the 2026-09-final collection.

### Ambient video

Every looping background clip must go through `AmbientVideo` (`ambient-motion.tsx`) so
none can escape the WCAG 2.2.2 pause control.

### Scroll

Native. Nothing intercepts the wheel, nothing snaps, nothing dissolves on scroll.
Sections do not animate in on arrival; only the hero copy stages its entrance, once, on
load. The Lenis + Snap layer, the CSS snap fallback, `SectionTransition`, the
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
  PRODUCT.md "Shipped today"). Solicitor sends **email
  only** and never posts — never name SMS, Telegram, or WhatsApp for it.
- **The five jobs ledger (`jobs/`) is the balance device.** Respond, Protect, Request,
  Brief, Measure get one equal row each. Do not let a job's row grow a card, a control,
  or a bigger type step than its neighbours — equality is the argument.
- **The Judge governs auto-posting only.** On Copilot the owner approves and the Judge is
  not in that path. Never "reviews everything that goes out".
- **Guardian never acts publicly** — that is its whole identity.
- **Reply is the only persona that can publish**, and only inside owner bounds.
- **The roadmap's markers are load-bearing.** Every unbuilt stop shows `Planned · Phase n`
  or `Horizon · Later` beside its name, and its detail says "Not available yet". A skim
  reads names before bodies; the marker is what marks a stop as unbuilt at that glance.
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
  its own CSS and `*-copy.ts`, rendered in order from `LandingExperience.tsx`, with its
  stylesheet imported there after `landing-experience.css`.
- **"Add a surface"** → render inside one of the two type scopes (`section-scopes.css`) and
  paint the section's own ground; there is no shared glass surface.
- **"Add a looping background clip"** → `AmbientVideo`, `aria-hidden` on the wrapper.
- **"Add an interactive control"** → give it a `--rw-lp-accent` focus ring and add it to
  `focus-visible-marketing.test.ts`.

## Exports

- **CSS variables:** [`src/components/sections/landing/landing-experience.css`](../../../../src/components/sections/landing/landing-experience.css)
  (`.rw-lp` block) and [`hero/hero.css`](../../../../src/components/sections/landing/hero/hero.css)
  (`.rw-lp-hero` block) — those blocks ARE the export; do not copy them here.
- **Tailwind v4:** none. Landing is plain CSS. Add a `landing/theme.css` only if a
  `bg-rw-lp-*` utility is ever needed.
