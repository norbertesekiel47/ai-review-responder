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

**2026-08-24 — the elevation pass (owner-directed).** Sections 6 (problem) and 8
(Copilot vs Autopilot, the dial-track) were built; section 7 is deliberately NOT a
section — the watchdogs section ends with a gold door to `/how-it-works` instead of
the page retelling the pipeline. Three motions were added back under an explicit owner
override of part of the Linear pass: the bookends' scroll-linked push-in/settle, the
hero's five-beat arrival, and the tiers thumb's breathing. New §2 entries below carry
the measurements ("Bookend cinema", "The zoom layer", "Hero entrance"); the focus test
asserted **14** rings at that point (superseded below).

**2026-08-24 (later) — the sections revamp (owner-directed, PR pending).** Sections
2–7 elevated in place: `Staged`/`StagedLine` beats page-wide (the hero-entrance
grammar shared — motion-driven, finite, pause-rule-immune), the fleet assembles on
arrival with hover wire-highlighting, the watchdog rows carry a larger avatar stage +
a front rule plate (`frontRule` on the shared flip card), the autonomy dial became a
circular OPERABLE gauge (v4 — two `aria-pressed` mode buttons, sprung needle), the
problem section pairs a trimmed left-column essay with a generated ambient diagram
clip (looping-clip count 8 → 9), and the future cards opened with a generated off-CRT
still (the cards became the route map on 2026-09-06 — see "Future" below). One header grammar: prose left, instruments centered, shared heading + lead
scales (the problem heading is the stated exception). The focus test now asserts
**16** landing controls across 15 rows (the dial's two buttons share one). New §2
entries below: "Staged beats", "Fleet assembly", "The dial's needle", "Problem grid
areas", "Watchdog front grid".

**2026-08-16 — the Linear pass (findings 2, 4, 7, 8 of the RepWorth-vs-Linear teardown).**
Four things changed, and several measurements in §2 changed with them: (a) the primary
action is one gold-filled pill in the nav, the hero and the closing band; (b) the page
scrolls natively — Lenis + Snap, the CSS snap fallback, the scroll-linked section
dissolve, the chapter rail and the vertical chapter markers are gone, and `Reveal` is a
single ≤200ms opacity fade; (c) the content column is 75rem and sections 2–5 are as tall
as their content plus a 96px rhythm, never `100svh`; the section-5 cards are static; (d)
one label style (mono, 12px, 0.04em), no scroll cue, and the pause control lives in the
footer's bottom bar. Every §2 entry that was invalidated is rewritten below rather than
deleted, so the reasoning that produced the old value survives beside the new one.

---

## 1. What exists

`LandingExperience.tsx` is a composition root (~230 lines) owning only the chrome — nav,
the single `<main id="main-content">` landmark, the footer — plus a numbered section map.
Sections sit directly in the landmark; there is no wrapper component.

| # | Section | Component | Status |
|---|---|---|---|
| 1 | Hero | `hero/HeroSection.tsx` | built |
| 2 | Meet the fleet | `fleet/FleetSection.tsx` | built (+ click-to-open film) |
| 3 | The agents that act | `personas/PersonasSection.tsx` | built |
| 4 | The agents that watch | `watchdogs/WatchdogsSection.tsx` | built |
| 5 | Where this is going | `future/FutureSection.tsx` | built |
| 6 | The problem | `problem/ProblemSection.tsx` | built (2026-08-24) |
| 7 | The pipeline (7 steps) | — | **deliberately not a section** — the watchdogs section links to `/how-it-works` instead (owner decision, 2026-08-24) |
| 8 | Copilot vs Autopilot | `tiers/TiersSection.tsx` | built (2026-08-24, the dial-track) |
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
  landing-experience.css       nav, .rw-lp-glass, shared tokens, the pause control
  agent-flip-card.tsx / .css   shared flip card (sections 3 + 4)
  carousel.tsx / .css          phone card rail (sections 2-5, ≤767px only);
                               .css MUST be imported after every section file
  ambient-motion.tsx           WCAG 2.2.2 pause control + AmbientVideo
  reveal.tsx                   shared arrival fade (motion/react, opacity, ≤200ms)
  hero/       {HeroSection.tsx, hero.css, hero-copy.ts}
  fleet/      {FleetSection.tsx, fleet.css, fleet-copy.ts,
               VideoLightbox.tsx, video-lightbox.css}
  personas/   {PersonasSection.tsx, personas.css, personas-copy.ts}
  jobs/       {JobsSection.tsx, jobs.css, jobs-copy.ts}   the five-jobs ledger (2026-09-06)
  problem/    {ProblemSection.tsx, problem.css, problem-copy.ts}
  tiers/      {TiersSection.tsx, tiers.css, tiers-copy.ts}
  watchdogs/  {WatchdogsSection.tsx, watchdogs.css, watchdogs-copy.ts}
  future/     {FutureSection.tsx, future.css, future-copy.ts, future-route.ts}
  cta/        {CtaSection.tsx, cta.css, cta-copy.ts}
  footer/     {LandingFooter.tsx, footer.css, footer-copy.ts}
src/hooks/useMediaQuery.ts
src/app/(public)/page.tsx      passes primaryCtaHref/Label + selfServeEnabled
src/app/layout.tsx             Plus Jakarta weights 200/300
src/__tests__/focus-visible-marketing.test.ts   18 asserted focus rings

(`scroll/` — SectionTransition, ChapterRail, SmoothScroll, section-map,
scroll-experience.css — was deleted 2026-08-16. See §2, "Scroll".)
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
have split the headline's gold from the CTA pill's in the same viewport. The 50% stop must
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

**`--rw-lp-inner-max` is 75rem (1200px) since 2026-08-16 — a reading ceiling, not a
fit-the-viewport one.** It WAS `102rem`, and that number was measured: with every section
bound to `100svh` and the persona/watchdog cards at `aspect-ratio: 3/4`, width was spent
as height, and at 1920×812 the persona row kept 48px of slack at 102rem and only 6px at
110rem. That constraint went with the bind. At 75rem the persona grid gives four ~264px
cards (~352px tall), the fleet's four persona nodes fit one row at their `13rem` flex
basis with room (4×208 + 3 gaps ≈ 916px in a 1104px content box), and the future
section's prose stays inside its 34rem measure. Re-measure the fleet tier fit before going
narrower; the persona/watchdog cards no longer have a height budget to overflow.

**`.rw-lp-personas-list` no longer carries `min(100%, calc(180svh + 3rem))`.** That cap
existed only to keep the row inside a `100svh` section on short viewports (1416px instead
of 1504px at 1920×760, buying back 29px). The section now grows with the row.

**Sections 2–5 are `padding: var(--rw-lp-section-gap) 0` and nothing else sets their
height.** `--rw-lp-section-gap` is `clamp(4rem, 8vw, 6rem)` — 96px from 1200px up. The
`min-height: 100svh` + `justify-content: center` pair each section carried is gone; the
`vh` terms that remain in the heading clamps (`min(4.4vw, 5.2vh)`) are kept only to keep
display type proportionate on short laptops — they no longer have to fit a screen. Sections
1 and 9 keep `min-height: 100svh`: they are full-bleed film, the clip is the content, and
their scrim stops are measured against the full frame.

**Fleet: the node cap, not the container, sets the drawing width.** The tiers are centred
flex rows, so a wider `-inner` only adds empty space. `.rw-lp-fleet-node` at `21rem` is
what fills it — and widening a node *buys* height (text cards wrap to fewer lines): slack
went 9px → 45px.

**Watchdog cards are the ROW form, not the shared portrait shape.** Portrait coupled width
to height and 32rem alone overflowed 1920×812. The row form also fixed a real clipping
bug: the Governor's back needed 337px in a 288px `overflow: hidden` box. The `15rem` height
floor is set by the 390px case — lower it and clipping returns.

**Future — the route map (2026-09-06) replaced the cards, and the fixed-attachment
glow went with them.** Until then the section's card glow was `background-attachment:
fixed`, which a **transformed ancestor silently downgrades to `scroll`** — the reason
`Reveal` is opacity-only and `Staged` has `rise={0}`. Both stay (the next fixed-attachment
surface needs them), but nothing on the page depends on them today.

**Future — fifteen stops fit one chart only because labels alternate sides.** The
stage is 2000×900 in `future-copy.ts` (20:9, full-bleed — the first cut was 1600×900
inside the 75rem column and the owner called it cramped; the chart now runs edge to
edge and the stops spread across it); the lit stops span x 170–860, the planned
1005–1520, the horizon past `HORIZON_X` (1590). Adjacent lit/planned stops sit
~130–175 units apart (≈95–125px at 1440), still narrower than a lit landmark
(`--rw-lp-landmark`, up to 8.5rem lit / 6rem planned), so a stop's label goes below the road on even indexes and above the landmark on
odd ones (`data-label`), and the road wanders ±50 units so neighbouring landmarks do not
stack. A horizon stop has no landmark, so its stage collapses to 1.375rem — leave it at a
landmark's height and its label lands 80px from its glyph, on top of the next label (the
2026-09-06 first cut). `hoverall.mjs`-style check: every stop must accept a hover at its
centre; an obstructed stop means two buttons overlap.

**Future — the chart arms on `amount: 'some'`, never a fraction.** Below 900px the same
element is the trail, ~2,200px tall at 390px wide; `amount: 0.3` never fired there and the
stops stayed at opacity 0. The bottom `margin` holds desktop arrival until the chart is
15% up the screen.

**Future — a fixed 20:9 stage, not a fluid one.** Stops are placed in percentages of the
stage, and the road is an SVG in the same coordinate space; the two only agree while the
box keeps the viewBox's ratio. `aspect-ratio: 20 / 9` on `.rw-lp-future-map` is the
contract — re-measure every stop before changing it. 20:9 and not 16:9 because at
viewport width a 16:9 chart is 1080px tall on a 1920 screen. The road sits in the
middle band (y 425–700): the bottom 6rem is a fade into the section ink, and a stop at
y 740 put its label inside it.

**CTA — the clip choice is the framing fix.** `hero3reverseVideo.mp4` puts the character at
x 58–85%, clear of the 45% copy column. `hero3Video.mp4` puts it at x 19–37%, *behind* the
copy, and there is no fix: `object-fit: cover` gives zero horizontal travel above 16:9, and
no crop can add space left of a subject already near the frame edge. Do not swap the source
without moving the copy with it.

**Scroll — native, since 2026-08-16. Nothing intercepts the wheel.** What was removed,
and the measurement behind each piece, so nobody re-derives them from scratch:

- *The scroll-linked dissolve* (`SectionTransition`): opacity floor 0.35, 34px drift, scale
  floor 0.982 on a narrow `[0, 0.42, 0.58, 1]` plateau. The plateau was narrow because
  snap parked a section at exactly 0.5 — a wide plateau measured 0.97/0.92 at the halfway
  point, no visible handoff. Without snap there is no rest point to tune around, and the
  measured cost was that **4 of 9 viewport captures at 1440×900 landed on blank or blurred
  frames** — the first read of every section was delayed by the transition it was mid-way
  through. Gone; nothing replaces it.
- *Lenis + Snap* (`SmoothScroll.tsx`) and the CSS `proximity` fallback: `distanceThreshold`
  35% (at 50% every rest position was within range of a snap point), `min-height: 700px`
  and `min-width: 901px` gates, `ignoreTransform: true` registration, the `:not(.lenis)`
  hand-off. All of it existed to make one-section-per-screen feel owned; with sections
  sized to content the premise is gone. Native scroll, no gate, no fallback. The `lenis`
  dependency and the lightbox's `data-lenis-prevent` opt-out went with it.
- *The chapter rail* (`ChapterRail.tsx`) and *the vertical chapter markers* (`02–05`):
  wayfinding for a page where every screen looked like it could be the last. Their
  contrast figures (index gold 0.85 = 7.44:1; label 0.55 = 5.40:1; the rail's 24px
  `min-width` target) are recorded here for the archive; none of the elements exist.
- *The hero scroll cue* (`SCROLL`, the running dot): the one infinite animation the hero
  carried. Gone; the ambient-motion control now governs two CSS animations, not three.

`Reveal` is the whole scroll vocabulary: opacity 0→1 over **0.2s**, `easeOut`, 60ms
stagger per index capped at 6, skipped under reduced motion. It was a 700ms `blur(10px)`
+ 22px drift; both were dropped for the same reason as the dissolve, and "opacity only" is
also what kept the old future glow safe (above).

**Bookend cinema — the accent still clears its floor under the push-in.** The hero's
film scales `1 → 1.045` as the section scrolls out. The gold headline accent is the
tight figure (3.38:1 at rest against a 3.0 floor), so the moving state was measured
with §4's honest method, not assumed: at scroll 250 (scale 1.0139 — near the largest
push-in at which the accent line is still fully readable; it has left the viewport
entirely by scale ~1.018), text hidden, six seeks awaited, brightest pixel in the
glyph band per frame → **≈3.35:1 worst case**. The push-in also carries the glyphs UP
into the darker top scrim band, so the margin grows during scroll rather than
shrinking. At rest the scale is exactly 1 — the state every scrim figure was measured
in. Re-run this if the scale ceiling, the scrim stops, or the copy position change.

**The zoom layer — a transformed box grows the page's scrollable overflow even when a
parent clips its pixels.** The first cut put the bookends' scale on `.rw-lp-*-media`
(absolute, inset 0, `overflow: hidden`) and the whole page grew a horizontal scrollbar:
`overflow: hidden` clips a CHILD's rendering, but the wrapper's own transformed box
still extends the scrollable area. The scale therefore lives on an internal
`.rw-lp-hero-zoom` / `.rw-lp-cta-zoom` layer, and the untransformed wrapper both clips
it and serves as `useScroll`'s stable measurement target (a scaling target would feed
its own animation).

**Hero entrance — reduced motion is `initial: false`, not a branch by element type.**
The five-beat arrival keeps the same `m.*` elements in both branches and disables the
animation via props, so anything that ever observes those nodes can never capture a
stale one — the `SectionTransition`/`ChapterRail` trap recorded below. The beats are
finite and motion/react-driven, so the CSS pause rule (keyframes only) cannot strand
them mid-flight; the y-drift sits on the hero's own children, never on a section
wrapper.

**Four infinite CSS animations exist — the fleet's pulse and flow, the tiers gauge
halo's breathing, and the route map's lit-stop halo (2026-09-06); re-count before
editing the pause-rule comment.** The tiers
breathing joined 2026-08-24 (on the straight track's thumb; the v4 circular dial moved
it to the hub's halo, opacity instead of box-shadow — SVG circles have no box-shadow);
the universal `animation-play-state` rule covered both incarnations with zero changes,
which is the rule working as designed. Every OTHER motion added in the sections revamp
is motion-driven and finite (staged beats, wire draw-in, needle travel) precisely so
the pause rule — CSS keyframes only — can never strand it mid-flight.

**Staged beats — same-element reduced motion, and `rise={0}`.**
`staged.tsx` renders ONE element type in both branches (`initial={false}` under
reduced motion) — the `SectionTransition` observer trap, §2 below, is why. `rise={0}`
writes NO transform at all; it was mandatory around the old future cards' fixed
glow and stays for the next fixed-attachment surface. Staged inline halves (`StagedLine` in a heading, quote or
pivot) need `display: inline-block` at the call site — a transform is silently ignored
on a plain inline box.

**Fleet assembly — measured elements enter by OPACITY ONLY.** The nodes and the media
card are measured for the wire endpoints; `getBoundingClientRect` INCLUDES transforms,
and the ResizeObserver re-fires only on size change — so an entrance transform bakes a
mid-flight position into the wires permanently. The wire draw-in is motion
`pathLength` on the LIVE wires only: the dashed NEXT connector keeps its stylesheet
dash geometry (`3 9` in user units) and fades in instead — a `pathLength`-normalised
dash array would turn its dashes solid.

**The dial's needle swings via sprung endpoint math, never a CSS rotate.** The first
v4 cut rotated an SVG line with a motion `rotate`; the rotation pivoted around the
line's own box centre (SVG transform-origin resolution is unreliable across engines)
and the needle detached from the hub. `useSpring` on the angle + `useTransform` to
x2/y2 attributes pins the pivot to the hub exactly. Copilot rest is fraction 0.12 of
the sweep (the v2 thumb's resting value), Autopilot mirrors at 0.88.

**Problem grid areas keep the pivot the exit at every width.** `'copy figure' /
'pivot figure'` on two columns, `copy / figure / pivot` on one — the diagram slots
BETWEEN body and pivot on phones without touching the DOM order. The clip is a 10s
ping-pong loop (5s forward + reverse, 720×720, 108KB) because the source generation
cannot be trusted to close its own loop — and generation used a start frame only (the
"pin both ends and the model barely moves" trap, §3).

**Watchdog front grid is 3 columns since the revamp** (`auto minmax(0,1fr) auto`):
avatar spans both rows in column 1 at `clamp(5.5rem, 19vh, 9.5rem)` — 21vh/10.5rem
squeezed the tagline to four lines — and the rule plate sits in column 3 at
`max-width: 9.5rem`, hidden below 560px (one-column fronts return to name + tagline;
the rule stays on the back). The card's 15rem height floor is untouched and still
load-bearing.

**Personas — the gold wash (`0.055` at 12% 0%) is measured like the watchdogs' teal one.**
Its peak lifts the ground to rgb(31,41,34); the 0.55 column-note measures 5.10:1 there
(5.40 on flat ink) and the gold eyebrow 8.79:1. Re-measure both before raising the alpha.
0.055, not the teal's 0.07 — gold is the brighter pigment.

**`Reveal` branches on element type for reduced motion (`div` vs `m.div`) — and that is
only safe because nothing observes its nodes.** `usePrefersReducedMotion` resolves `false`
then flips `true` after mount, so the branch replaces the DOM node once. `SectionTransition`
had the same shape and it bit: `ChapterRail`'s IntersectionObserver captured the originals
at mount and froze on "Top" for reduced-motion users. Both are gone (2026-08-16), but the
trap is worth keeping: if anything ever observes a `Reveal` node, render one element type
for every branch.

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

**Three flip selectors, all required:** `:hover` (hover-capable fine pointers only —
media-gated 2026-08-24, because sticky tap-hover held a card flipped after the tap that
set `data-flipped` back to false, so a second tap could never restore the front),
`[data-flipped='true']` (touch — the click toggle is gated to non-hover devices for the
mirror reason: on a pointer device a click latched the card flipped after the pointer
left), `:focus-visible` (keyboard).

**The nav row at 320px has ~70px of slack** since the motion toggle left it (2026-08-16).
It USED to have zero: lockup (185px) + gap + toggle (44px) + gap + hamburger (40px) landed
at exactly 304px inside a 304px content box, and only because `--rw-lp-edge` drops to
`1rem` and the gap to `0.5rem` below 380px. Those two overrides are kept so the corners
still read as corners; the hamburger stays `flex: 0 0 auto` (it measured 22px before that
was added). The nav pill (`.rw-lp-nav-cta`) is hidden ≤900px — the menu panel carries the
same door — so it never enters this arithmetic.

**The ambient-motion toggle lives in the footer's bottom bar, in flow, at every width.**
Until 2026-08-16 it was a nav child styled `position: fixed` bottom-left from 901px up
(and docked in the nav below, where the hero copy runs to within ~36px of the bottom edge
at 360/390/414/768). The floating box was measured against the hero and CTA *copy* — and
still sat on top of the closing band's note text at 1440×900, the page's one visible
overlap. In the footer it cannot overlap anything. The trade — the control now sits after
the moving content rather than fixed beside it — is stated in `landing-experience.css`; it
still satisfies 2.2.2, and every clip and animation also honours `prefers-reduced-motion`.

**The primary action is one gold-filled pill, three places.** `.rw-lp-nav-cta` (36px,
13px/600, ≥901px only), `.rw-lp-hero-cta` and `.rw-lp-cta-action` (44px, 15px/600, label
then arrow). Ink on gold is the same 9.82:1 pair as gold on ink, and the pill's fill is
opaque, so the clip under it does not enter the ratio — the CTA band's `action 14.72`
figure in `cta.css` was for the old ring-and-label and is superseded. Until this pass the
hero and closing actions were a hairline ring with a 12px tracked-caps label, and the nav
carried a pill only with self-serve on. **These three are the only gold-filled elements on
the page** — a fourth would spend the accent.

**Sections 2-5 are carousels below 767px, and the breakpoint has one owner: `carousel.css`.**
Five rails: the fleet's two tiers, the persona grid, the watchtower grid, and the committed
grid. Stacked, those four sections ran **6,891px at 390px wide**, measured — over eight
screens of cards to pass to reach the next argument. The rails bring them to **4,010px**.
Four values are load-bearing. (a) The rail restyles the container each section ALREADY
renders (`.rw-lp-personas-list`, `.rw-lp-watch-grid`, `.rw-lp-fleet-tier`; the future
grid was a fourth until the 2026-09-06 route map, whose trail is not a rail); a wrapper
would become the desktop grid item and every desktop rule
would have to be re-pointed at it. (b) `.rw-lp-carousel[data-carousel='true']` is 0,2,0 to
match `.rw-lp-fleet-tier[data-tier='watchdog']`, and carousel.css is imported **after** every
section file — move that import up and the fleet's watchdog tier stays a stacked column.
(c) `justify-content: flex-start` is required, not a default: the fleet tier centres its row,
and a centred flex line that overflows splits the overflow across both sides, where
`scrollLeft` cannot reach it — the first card sat 394px off the left edge while the rail
still reported `scrollLeft: 0`. (d) `opacity: 1 !important` / `transform: none !important` on
the slides: `Staged` gates each card on 30% of ITSELF being in view, a peeking card shows
~15%, so the peek — the only thing that says the row continues — was invisible. Motion writes
those as inline styles, which is the one case `!important` exists for. Slide measures are per
section: personas and committed `min(78vw, 19rem)` (personas is 3:4, so width IS height —
405px against a full-width card's 456px), watchtower `min(88vw, 24rem)` (the row form's 15rem
floor was measured at 342px wide; narrower re-opens the clipping bug), fleet
`min(80vw, 17rem)`. The committed rail also raises `--rw-lp-carousel-pad` to 1.25rem: its
glow wash sits at `inset: -0.875rem` and the rail's `overflow-y: hidden` would shear 14px off
it. **The 767px breakpoint is deliberately NOT the fleet's 900px one**: 900 is where the
constellation stops being readable, 767 is where the stack gets too long. The dots render
only when the slides actually run wider than the track — at 767px the fleet's two watchdog
cards already fit, and a control that does nothing when pressed is worse than no control.
That test measures the SLIDES (`first.left` to `last.right`), never `scrollWidth`: the
committed card's glow bleed put 570 into `scrollWidth` against a 556 client width, and the
desktop 2x2 rendered a hidden dot row it had no use for.

**Labels are one style: `--rw-lp-label-*` (mono, 12px, 0.04em, uppercase).** The five
section eyebrows, the persona column note, the watchdog tier label and the route map's
legend label all
consume it. Their alphas were NOT changed (0.55 on the notes/tier labels, measured
composited at 5.40 / 5.26 / 4.84 under the teal wash), but the face and size were: the
mono at 12px is a larger glyph than the display face at 10px, so every one of those
contrast figures is now a floor, not a measurement.

---

## 3. Assets

| Asset | Notes |
|---|---|
| `public/agents/*.{mp4,jpg}` | 6 agents, 736KB. Generated from a cropped hero frame so they inherit the real CRT body. Personas move their bodies; **watchdogs only change state** (Judge's body is still, only the iris moves). |
| `heroVideo-{1600,960}.mp4` + poster | 977K/316K/120K from a 23MB master |
| `ctaVideo-{1600,960}.mp4` + poster | 515K/204K/115K from `hero3reverseVideo.mp4` (27MB) |
| `repworth-explainer.mp4` + poster | 25MB, 2m26s, narrated. **Remuxed `+faststart`** — the moov atom was at the end, so playback would have blocked on the full 25MB download. Fetches 0 bytes until clicked. **Still has no captions** (probed 2026-08-04: video + audio streams only, and frames at 20s/75s carry no burned-in text). |
| `problem/problem-diagram.{mp4,jpg}` | 108K/24K. The reputation diagram (2026-08-24): café + orbiting review artifacts, generated (Higgsfield, nano-banana still → seedance clip, agent still as style ref), 720×720, 10s seamless ping-pong loop, audio stripped, `+faststart`. Asset rules: `problem/problem-copy.ts`. |
| `future/roadmap-ground{,-960}.jpg` | 143K/32K. The route map's chart ground (2026-09-06): a dark green survey chart, lamp-lit on the left, no text — generated (Runway, nano-banana-pro, the off-CRT still as style ref), 2752×1536 master downscaled with ffmpeg. Decorative; the road and stops carry the meaning. |
| `future/stops/*.webp` | 10 landmark cutouts, 253K total (7–52K each, ≤480px tall). Reply and Solicitor are the agent stills cut out; the other eight were generated on a flat dark-green ground against the same stills and cut out with a PIL corner flood-fill (`thresh 70`, 1px erode, 0.8px feather) — the Runway cutter kept only the television and dropped every second object (book, cable, ring, gate arm). Lit stops' screens are ON; planned stops' screens are OFF. No red or orange (the first gate arm and life ring were re-made). Which stop uses which: `future-copy.ts`. `future/off-crt.jpg` (13K, the old cards' unpowered set) was deleted with the cards. |

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

`focus-visible-marketing.test.ts` asserts a ring on **16** landing controls across 15
rows (the dial's two mode buttons share one). Adding an interactive element means
adding it there. Landing rings use `--rw-lp-accent`; the Island's `--rw-teal-strong`
is near-invisible on this ink.

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
- ~~Sections 2–5 overflow below ~700px viewport height.~~ No longer applies: sections
  are sized to content (2026-08-16), so there is nothing to overflow.

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
