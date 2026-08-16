# RepWorth Landing — load-bearing measurements

**Read before touching `src/components/sections/landing/**`.** Many values in there look
arbitrary and are not: §2 is the index of every load-bearing number, and each is also
commented at its call site with the measurement that produced it. §4 is how to re-measure
them — including the two ways contrast measurement on this page silently lies.

The page's design system — palette, type, components, copy contracts — is
[`DESIGN.md`](./DESIGN.md) beside this file. This document is its engineering companion.

**Status as of 2026-08-04:** sections 1–5 + 9 + footer built; 6–8 unbuilt. Audited
**19/20** across three `/impeccable audit` passes (16 → 17 → 19), with the remaining point
held by one missing asset — see §5. Gate at that point: typecheck ✓, lint ✓, 10,668
tests, build exit 0.

---

## 1. What exists

`LandingExperience.tsx` is a composition root (~230 lines) owning only the chrome — nav,
the single `<main id="main-content">` landmark, the chapter rail, the footer — plus a
numbered section map.

| # | Section | Component | Status |
|---|---|---|---|
| 1 | Hero | `hero/HeroSection.tsx` | built |
| 2 | Meet the fleet | `fleet/FleetSection.tsx` | built (+ click-to-open film) |
| 3 | The agents that act | `personas/PersonasSection.tsx` | built |
| 4 | The agents that watch | `watchdogs/WatchdogsSection.tsx` | built |
| 5 | Where this is going | `future/FutureSection.tsx` | built |
| 6 | The problem | — | **not built** |
| 7 | The pipeline (7 steps) | — | **not built** |
| 8 | Copilot vs Autopilot | — | **not built** |
| 9 | Closing CTA | `cta/CtaSection.tsx` | built |
| — | Footer | `footer/LandingFooter.tsx` | built |

Sections 6–8 come from the narrative spine in §3.4 of the owner's brief
(`~/Desktop/RepWorth-website-design-reference.md`).

**1 and 9 are a deliberate pair:** the same world, opened in daylight with the copy set
RIGHT and closed at night with it set LEFT. They are the only two full-bleed video
sections; they mirror rather than repeat.

### Files

```
src/components/sections/landing/
  LandingExperience.tsx        composition root + section map + nav
  landing-experience.css       nav, .rw-lp-glass, shared tokens
  agent-flip-card.tsx / .css   shared flip card (sections 3 + 4)
  ambient-motion.tsx           WCAG 2.2.2 pause control + AmbientVideo
  reveal.tsx                   shared scroll reveal (motion/react)
  hero/       {HeroSection.tsx, hero.css, hero-copy.ts}
  fleet/      {FleetSection.tsx, fleet.css, fleet-copy.ts,
               VideoLightbox.tsx, video-lightbox.css}
  personas/   {PersonasSection.tsx, personas.css, personas-copy.ts}
  watchdogs/  {WatchdogsSection.tsx, watchdogs.css, watchdogs-copy.ts}
  future/     {FutureSection.tsx, future.css, future-copy.ts}
  cta/        {CtaSection.tsx, cta.css, cta-copy.ts}
  footer/     {LandingFooter.tsx, footer.css, footer-copy.ts}
  scroll/     {SectionTransition.tsx, ChapterRail.tsx, SmoothScroll.tsx,
               section-map.ts, scroll-experience.css}
src/hooks/useMediaQuery.ts
src/app/(public)/page.tsx      passes primaryCtaHref/Label + selfServeEnabled
src/app/layout.tsx             Plus Jakarta weights 200/300
src/__tests__/focus-visible-marketing.test.ts   17 asserted focus rings
```

Every section keeps its copy in a `*-copy.ts`. That is deliberate: those files carry the
accuracy contracts (see [`DESIGN.md`](./DESIGN.md) → **Copy accuracy contracts**), and
keeping prose out of JSX makes them reviewable as prose.

---

## 2. Load-bearing values — do not "tidy" these

**Hero — the scrim's 50% zero point is paired with the copy's 55% start.** The clip is
bright across its whole middle; the headline band needs ~0.38 scrim opacity from x=40% to
x=60%, so a gradient that is zero *at* the midline cannot darken text sitting on it. Move
the copy left of 55% and the first characters measure **1.4:1**.

**Hero — the 42–49.3% scrim stops were later RAISED, for the gold line only.** Those
original figures were derived against the near-white headline. The gold line under it is
darker, so the same ground buys it less, and it was never checked separately: sampled
against the brightest pixel under its own glyphs it measured **2.89:1** against a 3:1
floor while the white line above it measured 4.23 and passed. Deepening the ramp took it
to **3.38:1**. The fix went here rather than on the gold because ONE gold across the page
is load-bearing (see [`DESIGN.md`](./DESIGN.md) → **Overview**) — lifting the token would
have split the headline's gold from the CTA ring's in the same viewport. The 50% stop must
stay at zero.

**Hero — `object-position: 70%`** keeps the character clear of the copy column. Mobile
needs different values (phones ~18%, tablets ~10%).

**Hero — the top scrim band holds ~0.64 through 8%, then falls away by 19%.** The brand
lockup sits at ~6% over the brightest part of the frame (a linear decay left it at
**2.43:1**); the character's top edge is near 14%.

**`.rw-lp-` prefix everywhere.** `globals.css` owns `.rw-hero` (the `/features` hero) whose
`.rw-hero h1 { color: var(--rw-ink) }` is specificity 0,1,1 and beats a single-class title
rule, rendering headlines near-black on a dark scrim. Same trap for `.rw-foot` vs the
landing footer's `.rw-lp-foot-`.

**`.rw-lp-flip .rw-lp-flip-face` is scoped deliberately.** The faces also carry
`rw-lp-glass`, which sets `position: relative` at equal specificity — and
`landing-experience.css` imports *after* `agent-flip-card.css`, so flattening the selector
drops both faces into normal flow.

**`width: 100%` on every `*-inner` wrapper.** Sections are column flex containers, so
those wrappers are flex items; `margin: 0 auto` overrides `align-self: stretch` and
collapses them to fit-content, silently narrowing every grid inside.

**`--rw-lp-inner-max: 102rem` is a measured ceiling.** Width is spent as height:
persona/watchdog cards are `aspect-ratio: 3/4` and every section is bound to `100svh`. At
1920×812 the persona row keeps 48px of slack at 102rem and **6px at 110rem**.

**`.rw-lp-personas-list` carries `min(100%, calc(180svh + 3rem))`.** The grid fills the
container on tall viewports and pulls in on short ones (1416px instead of 1504px at
1920×760, buying back 29px). Left-aligned so it stays flush with the heading when the cap
bites.

**Fleet: the node cap, not the container, sets the drawing width.** The tiers are centred
flex rows, so a wider `-inner` only adds empty space. `.rw-lp-fleet-node` at `21rem` is
what fills it — and widening a node *buys* height (text cards wrap to fewer lines): slack
went 9px → 45px.

**Watchdog cards are the ROW form, not the shared portrait shape.** Portrait coupled width
to height and 32rem alone overflowed 1920×812. The row form also fixed a real clipping
bug: the Governor's back needed 337px in a 288px `overflow: hidden` box. The `15rem` height
floor is set by the 390px case — lower it and clipping returns.

**Future — `transform={false}` on its `SectionTransition` wrapper.** The card glow is
`background-attachment: fixed`, which a **transformed ancestor silently downgrades to
`scroll`**. It dissolves; it does not drift.

**Future — the glow's `::after` uses two stacked gradients, not `filter: brightness()`.** A
filter would make the pseudo-element a containing block and break the same fixed
attachment.

**CTA — the clip choice is the framing fix.** `hero3reverseVideo.mp4` puts the character at
x 58–85%, clear of the 45% copy column. `hero3Video.mp4` puts it at x 19–37%, *behind* the
copy, and there is no fix: `object-fit: cover` gives zero horizontal travel above 16:9, and
no crop can add space left of a subject already near the frame edge. Do not swap the source
without moving the copy with it.

**Scroll — the dissolve plateau is narrow (`[0, 0.42, 0.58, 1]`) on purpose.** Snap parks a
section at exactly 0.5. A wide plateau (`0.26/0.74`) measured 0.97 and 0.92 at the halfway
point — no visible handoff at all. The transition has three channels on the same plateau:
opacity (floor 0.35), drift (34px) and a hair of scale (floor **0.982** — at the seam it
interpolates to ≈0.994, under 6px of edge reveal per side at 1920px; lower and the ink
behind reads as a border).

**Scroll — Lenis owns snapping while it is alive; the CSS block is the FALLBACK.**
`SmoothScroll.tsx` runs Lenis + its Snap module under exactly the CSS gate's bounds (native
CSS `proximity` snap places points correctly but the browser's landing animation is abrupt
and has no easing knob — that was the clunk). The instance stamps `lenis` on `<html>`; the
CSS rule is scoped `:not(.lenis)`, so reduced motion, small viewports, JS off, or a
destroyed instance all hand snapping back to CSS. Never let both run at once. Snap elements
register with `ignoreTransform: true` — the default `getBoundingClientRect()` would bake the
wrapper's mid-transition drift/scale into the snap position. `distanceThreshold` is **35%**,
not the 50% default: sections sit one viewport apart, so at 50% every rest position is
within range of some snap point and proximity degenerates into mandatory.

**Scroll — snap is bounded to `min-height: 700px` AND `min-width: 901px`.** Below 700px tall
sections overflow and `mandatory` would strand content; below 901px the layout stacks
(personas is 2214px against an 844px viewport) so snap points sit 2.6 screens apart. Scoped
with `:has(.rw-lp)` so other routes are untouched. `SmoothScroll.tsx` and the chapter markers
gate on the same bounds — the three must move together.

**Scroll — the rail jump walks `offsetTop`, never the element rect.** Mid-scroll the chapter
wrappers are transformed, so `lenis.scrollTo(element)` (rect-based) lands up to ~40px off
(measured: 1665 vs 1624) — and nothing corrects a programmatic scroll afterwards; snap only
follows wheel input. Native CSS snap used to absorb exactly this error after
`scrollIntoView`.

**Chapter markers (the vertical `02–05` stamps) are wrapper chrome, not section content.**
Rendered by `SectionTransition` from `SCROLL_CHAPTERS.marker` (single owner; indexes are
STATED, not derived, so unbuilt sections 6–8 landing later cannot renumber them), inside the
animated wrapper so each dissolves with its own section. Colors measured composited over
every ground they sit on: index gold 0.85 = 7.44:1 on ink / 7.08 under the personas wash;
label 0.55 = 5.40 / 5.26 / 5.25. The teal index restates `#a9c6c0` because
`--rw-lp-watch-accent` is scoped to a CHILD of the wrapper.

**Personas — the gold wash (`0.055` at 12% 0%) is measured like the watchdogs' teal one.**
Its peak lifts the ground to rgb(31,41,34); the 0.55 column-note measures 5.10:1 there
(5.40 on flat ink) and the gold eyebrow 8.79:1. Re-measure both before raising the alpha.
0.055, not the teal's 0.07 — gold is the brighter pigment.

**`SectionTransition` always renders `motion.div`, never an early `return <div>`.**
`usePrefersReducedMotion` resolves `false` then flips `true` after mount; branching on the
element type replaces the DOM node, and `ChapterRail`'s IntersectionObserver — captured at
mount — ends up watching detached elements. The rail froze on "Top" for reduced-motion users
only. `Reveal` has the same latent shape; harmless there because nothing observes its nodes.

**Footer — the wordmark viewBox is `375×58`, and the WIDTH is measured.** The glyph run
("REPWORTH", font-size 68, -0.02em tracking) is 370.8 user units by
`getComputedTextLength()`. In the 300-unit box this shipped with, 35.4 units overflowed each
side: the footer's `overflow: hidden` clipped the R's and H's outer strokes, and the reveal
mask's `<rect>` ends at the viewBox edge, so the hover light could never reach either letter.
Stroke-width rides the box — `0.44 = 0.35 × 375/300` keeps the rendered weight. Height stays
58, not the source's 100 (the extra 42 units rendered as ~230px of empty box that the source
hid with negative margins; sizing the box to the type dropped the footer 816px → 705px).
Re-measure the run before changing the wordmark text, font size or tracking.

**Footer — Legal is a bottom-bar ROW, not a third column.** Six legal links stacked in one
narrow column beside a one-link Company column read as crowded-right/empty-middle. The bottom
bar carries them beside the copyright; the links reuse `.rw-lp-foot-link` so the asserted
focus ring covers them, and `.rw-lp-foot-legal-link` only sets the smaller size plus the same
6px target-size padding trick the column links use.

**Three flip selectors, all required:** `:hover` (pointer), `[data-flipped='true']` (touch),
`:focus-visible` (keyboard).

**`.rw-lp-rail-dot` states `min-width: 1.5rem` and it is load-bearing.** The dot's 24px target
used to come out at 23px *by accident* — the flex `gap` sat between the mark and the
then-in-flow label. Taking the label out of flow (to stop it animating `max-width`) removed
the gap from the box and silently shrank the target to 13px. The size is now stated, so a
change to a sibling cannot undo it.

**The nav row at 320px has zero slack.** Lockup (185px) + gap + motion toggle (44px) + gap +
hamburger (40px) lands at exactly 304px inside a 304px content box, and only because
`--rw-lp-edge` drops to `1rem` and the gap to `0.5rem` below 380px. Both the toggle and the
hamburger are `flex: 0 0 auto`, so nothing in that row can be squeezed below its target size —
the hamburger measured 22px before that was added. Anything else added to the nav needs the
lockup to give way first.

**The ambient-motion toggle is a nav CHILD styled `position: fixed` at ≥901px.** Not two
controls, one — see the placement note in `landing-experience.css` for the measurements.
Below 901px there is genuinely no free corner: the hero copy runs to within ~36px of the
bottom edge at 360/390/414/768, and both bottom corners intersect the last line of the hero
note at one size or another.

---

## 3. Assets

| Asset | Notes |
|---|---|
| `public/agents/*.{mp4,jpg}` | 6 agents, 736KB. Generated from a cropped hero frame so they inherit the real CRT body. Personas move their bodies; **watchdogs only change state** (Judge's body is still, only the iris moves). |
| `heroVideo-{1600,960}.mp4` + poster | 977K/316K/120K from a 23MB master |
| `ctaVideo-{1600,960}.mp4` + poster | 515K/204K/115K from `hero3reverseVideo.mp4` (27MB) |
| `repworth-explainer.mp4` + poster | 25MB, 2m26s, narrated. **Remuxed `+faststart`** — the moov atom was at the end, so playback would have blocked on the full 25MB download. Fetches 0 bytes until clicked. **Still has no captions** (probed 2026-08-04: video + audio streams only, and frames at 20s/75s carry no burned-in text). |

**The masters are no longer in the repo.** `heroVideo.mp4` (23M), `hero2Video.mp4` (30M),
`hero3Video.mp4` (20M), `landing-hero.mp4` (13M) and `hero3reverseVideo.mp4` (27M, the CTA
master) moved to `~/Developer/startups/RepWorth-media/masters/` on 2026-08-04 — 113MB that
shipped on every deploy and that no code referenced. Checksums verified on both sides before
the originals were removed. The first four were git-tracked, so they are also recoverable
with `git checkout 4a16bcfd -- public/video/<name>`; `hero3reverseVideo.mp4` was untracked and
exists only at that path now. `public/video/` is 27M, of which 25M is the referenced
explainer.

**A mistake worth not repeating:** pinning both start and end frames to the same still tells
the model "return exactly here", and the cheapest way to satisfy that is to barely move
(measured 0.10 and 0.07 inter-frame motion). Generate with a **start frame only** and make
loops seamless in post via ping-pong.

---

## 4. How to verify

```bash
pnpm typecheck && pnpm lint && REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test && pnpm build
```

Last run: typecheck ✓, lint ✓, **10,549 tests passing**, build exit 0.

**Stop the dev server before `pnpm build`** — both write `.next/` and the build wins, killing
the server mid-session. Run it detached so the harness does not reap it:

```bash
nohup env PORT=3010 pnpm dev > /tmp/dev.log 2>&1 < /dev/null & disown
```

**Contrast — the one trap.** You **must** composite the text's alpha over the sampled
background before computing the ratio. Parsing only the RGB overstates it: on the CTA that
reported ~15:1 for text actually sitting at **4.93**. Over video, sample several timestamps
and take the brightest pixel under each text band, not one frame.

**Contrast over VIDEO cannot be read from CSS at all.** Walking up for the first opaque
`background-color` finds `.rw-lp` (the page ink) and reports a number for a ground that is
not there — it scored the hero headline against ink and passed it. The honest method is: hide
the text, seek the clip to N timestamps **awaiting the `seeked` event** (setting `currentTime`
on a paused video without waiting repaints nothing — 24 "different" frames came back byte
identical), screenshot the **tight glyph band** from `Range.getClientRects()` rather than the
block box, and take the brightest pixel. That is what found the hero accent at 2.89:1.

`focus-visible-marketing.test.ts` asserts a ring on **17** landing controls. Adding an
interactive element means adding it there. Landing rings use `--rw-lp-accent`; the Island's
`--rw-teal-strong` is near-invisible on this ink.

---

## 5. Audit — 19/20 (Excellent), 2026-08-04 (third pass)

Three `/impeccable audit` runs: 16/20 → 17/20 → **19/20**. Detector: **0 findings** across
the landing folder every run (control-tested — it still correctly finds 7 in `globals.css`).

| Dimension | 1st | 2nd | Now | What is left |
|---|---|---|---|---|
| Accessibility | 3 | 3 | **3** | **Only the uncaptioned film** (1.2.2 Level A). AA is fully met. |
| Performance | 3 | 4 | **4** | — |
| Theming | 3 | 3 | **4** | — |
| Responsive | 3 | 3 | **4** | — |
| Implementation Integrity | 4 | 4 | **4** | — |

**The score is now gated on one asset.** Every code-side finding across three passes is
closed. Dropping in the subtitled cut takes Accessibility to 4 and the page to 20/20; nothing
else is outstanding.

### Closed across the three passes

- **Three contrast failures, all measured composited.** `.rw-lp-personas-column-note` 4.07 →
  **5.40:1**; `.rw-lp-watch-tier-label` 3.45 → **5.26:1** flat and **4.84:1** under the teal
  wash at its peak, which is the case that sets the value (at alpha 0.50 the wash case is only
  4.27); and `.rw-lp-hero-title-accent` 2.89 → **3.38:1** against the brightest pixel under its
  glyphs across 20 frames.
- **WCAG 2.2.2.** One control, `ambient-motion.tsx`, governs all 8 looping clips *and* all 11
  infinite CSS animations. Verified live both ways. The CSS half is a single universal
  `animation-play-state` rule on `.rw-lp[data-ambient-motion]`, so an animation added later is
  covered without anyone remembering to.
- **`motion` → `LazyMotion + m`** in the three files that had drifted, with `strict` at the page
  root so a stray `motion.*` throws instead of silently re-inflating the bundle.
- **113MB of masters out of `public/`** (see §3).
- **101 hand-written alpha literals → 0.** Three channel tokens (`--rw-lp-text-rgb`,
  `--rw-lp-ink-rgb`, `--rw-lp-accent-rgb`), with `--rw-lp-text`, `--rw-lp-ink` and
  `--rw-lp-accent` all *derived* from them so the two forms of each colour cannot drift.
- **`.rw-lp-rail-label` no longer animates `max-width`.** Zero layout-animating transitions
  remain on the page; zero `transition: all`; zero `will-change` at rest.
- **Every interactive target clears 24px** at 390 and 1440 (was 21 under it), and there is zero
  horizontal overflow from 320px to 1920px.
- **The 6 avatar clips are `aria-hidden`**, on the wrapper so the declaration covers the
  reduced-motion still as well as the video.

### Still open

**P1 — captions (WCAG 1.2.2, Level A).** The 2m26s narrated explainer has none. Probed
2026-08-04: video + audio streams only, and sampled frames at 20s and 75s carry no burned-in
text. The subtitled cut has not been supplied, so the comment at `fleet/VideoLightbox.tsx:88`
still stands. Drop-in steps are in §3. **This is the only thing between the page and 20/20.**

### Deliberately left as literals

- **24 `rgba(255, 255, 255, x)`** — the liquid-glass highlights. A specular highlight is
  genuinely white, not the text colour at low alpha; folding them into a token would be wrong,
  not tidier.
- **1 `rgba(169, 198, 192, 0.07)`** — the watchdogs' teal wash. One caller, one alpha; a channel
  token for it would be an abstraction for a single use.
- **3 one-off darks** (`rgba(0,0,0,…)` ×2, `rgba(10,16,14,0.94)` for the lightbox `::backdrop`)
  — none of them is a page token.

### Deliberate — do not "fix"

- **Footer wordmark at 1.25:1.** `aria-hidden`, decorative, and the brand name is also a real
  link. Exempt under 1.4.3. The contrast sweep flags it every run — it is the only entry in that
  report that is meant to be there.
- **Sections 2–5 overflow below ~700px viewport height.** By design; snap is bounded to
  `min-height: 700px` for exactly this reason.

**Out of scope:** 7 pre-existing `globals.css` findings on Features/How-it-works/Pricing.

## 6. Open items beyond the audit

- **Sections 6–8 unbuilt** (problem, pipeline, Copilot vs Autopilot).
- **Base was `4a16bcfd`**, still level with `origin/main` when the PR opened. `main` moves fast
  — re-check before any follow-up branch.
- **Two video-production markdown files remain untracked at the repo root**
  (`RepWorth-hero-video-script.md`, `RepWorth-launch-video-production.md`). They are unrelated to
  this page and were deliberately left out of its PR; decide separately whether they belong in
  `docs/`.
- **The CTA backdrop is a near-copy of the hero's**, not a shared component. Extracting one means
  editing the hero's measured scrim values; do it as a change that does nothing else.
- **`main` is protected** — landing this means a PR.
- Sections 2–5 overflow below ~700px viewport height by design.
- **The pause state does not persist.** It resets on reload and is not written to storage.
  Deliberate for now — a persisted "motion off" is a preference, and this page has no preference
  store. If it becomes one, it belongs beside `prefers-reduced-motion`, not in a bespoke key.
- **The bundle win from `LazyMotion` was not measured in bytes.** The Next 16 build table in this
  project does not print per-route sizes, so the migration is justified by consistency with the
  other 25 files and by `strict` preventing regression — not by a number. If a number is wanted,
  measure it deliberately.

---

## 7. Working agreements

- **Measure before claiming.** Contrast, motion, section fit, jank, and clipping were all
  verified numerically, and in several cases the measurement contradicted what the screenshot
  suggested.
- **Correct the comment when the measurement disagrees.** Two comments in this branch quoted
  numbers computed the wrong way and were rewritten, not kept.
- **Flag conflicts rather than silently picking.** The Solicitor status, the reference palettes,
  and the CTA clip's subject position were all surfaced.
- `motion/react` is the import path for Motion v12, never `framer-motion`.
