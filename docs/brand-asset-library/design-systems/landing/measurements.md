# RepWorth Landing — load-bearing measurements

**Read before touching `src/components/sections/landing/**`.** Many values in there look
arbitrary and are not: §2 is the index of every load-bearing number, and each is also
commented at its call site with the measurement that produced it. §4 is how to re-measure
them — including the two ways contrast measurement on this page silently lies.

The page's design system — palette, type, components, copy contracts — is
[`DESIGN.md`](DESIGN.md) beside this file. This document is its engineering companion.

**Scope since 2026-09-10.** Sections 2–8 are the owner-selected design. Their measurements and contracts — the responsive CRT index and reading line, the arched watchdog containment, the lever timing, the 3840px map's 1.75× framing — live in [the chosen design record](../../collections/2026-09-final/chosen-design.md). This file keeps the page-wide, bookend, nav and footer measurements. The §2 entries for the deleted original middle sections were removed in the cleanup (git history holds them). The dated notes below are history.

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

| # | Section | Component |
|---|---|---|
| 1 | Hero | `hero/HeroSection.tsx` |
| 2 | The problem | `problem/ProblemSection.tsx` |
| 3 | Meet the fleet (+ click-to-open film) | `fleet/FleetSection.tsx` |
| 4 | The agents that act | `personas/PersonasSection.tsx` |
| 5 | The five jobs | `jobs/JobsSection.tsx` |
| 6 | The agents that watch | `watchdogs/WatchdogsSection.tsx` |
| 7 | Owner controls — Copilot vs Autopilot | `tiers/TiersSection.tsx` |
| 8 | Where this is going (the Working Atlas) | `future/FutureSection.tsx` |
| 9 | Closing CTA | `cta/CtaSection.tsx` |
| — | Footer | `footer/LandingFooter.tsx` |

The pipeline is deliberately not a section: the watchdogs section links to
`/how-it-works` instead (owner decision, 2026-08-24).

**1 and 9 are a deliberate pair:** the same world, opened in daylight with the copy set
RIGHT and closed at night with it set LEFT. They are the only two full-bleed video
sections; they mirror rather than repeat.

### Files

```
src/components/sections/landing/
  LandingExperience.tsx        composition root: nav, menu, section order, CSS order
  landing-experience.css       nav, shared tokens, the pause control
  section-scopes.css           the two type scopes of sections 2-8; MUST be imported
                               after landing-experience.css, before the section files
  brand-clip.tsx               the problem house and watchdog CRT clips
  ambient-motion.tsx           WCAG 2.2.2 pause control + AmbientVideo
  hero/       {HeroSection.tsx, hero.css, hero-copy.ts}
  problem/    {ProblemSection.tsx, problem.css, problem-copy.ts}
  fleet/      {FleetSection.tsx, fleet.css, VideoLightbox.tsx, video-lightbox.css}
  personas/   {PersonasSection.tsx, personas.css, personas-copy.ts}
  jobs/       {JobsSection.tsx, jobs.css, jobs-copy.ts}
  watchdogs/  {WatchdogsSection.tsx, watchdogs.css, watchdogs-copy.ts}
  tiers/      {TiersSection.tsx, tiers.css, tiers-copy.ts}
  future/     {FutureSection.tsx, future.css, future-copy.ts}
  cta/        {CtaSection.tsx, cta.css, cta-copy.ts}
  footer/     {LandingFooter.tsx, footer.css, footer-copy.ts}
src/app/(public)/page.tsx      passes primaryCtaHref/Label + selfServeEnabled
src/app/layout.tsx             Plus Jakarta weights 200/300
src/__tests__/focus-visible-marketing.test.ts   the asserted focus rings

(`scroll/` — SectionTransition, ChapterRail, SmoothScroll, section-map,
scroll-experience.css — was deleted 2026-08-16. The original middle sections and
their helpers — agent-flip-card, carousel, staged, reveal, future-route — were
deleted 2026-09-10.)
```

Every section keeps its copy in a `*-copy.ts`. That is deliberate: those files carry the
accuracy contracts (see [`DESIGN.md`](DESIGN.md) → **Copy accuracy contracts**), and
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
is load-bearing (see [`DESIGN.md`](DESIGN.md) → **Overview**) — lifting the token would
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

**`width: 100%` on every `*-inner` wrapper.** Sections are column flex containers, so
those wrappers are flex items; `margin: 0 auto` overrides `align-self: stretch` and
collapses them to fit-content, silently narrowing every grid inside.

**`--rw-lp-inner-max` is 75rem (1200px) since 2026-08-16 — a reading ceiling, not a
fit-the-viewport one.** It was `102rem` while every section was bound to `100svh` and width
was spent as card height. Since the 2026-09-10 cleanup the footer is its only user; the
middle sections set their own widths.

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
  carried. Gone.

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
stale one. (`SectionTransition` swapped its node after mount and `ChapterRail`'s
IntersectionObserver froze on the original; both went 2026-08-16. If anything ever
observes an animated node, render one element type in every branch.) The beats are
finite and motion/react-driven, so the CSS pause rule (keyframes only) cannot strand
them mid-flight; the y-drift sits on the hero's own children, never on a section
wrapper.

**No keyframe animation exists under `sections/landing/` (checked 2026-09-10).** The
universal `animation-play-state` pause rule stays universal so the next animation added
is covered without anyone remembering to. Motion in the middle sections is either
Motion-driven and finite, or a clip that reads the pause through context — neither can be
stranded mid-flight by the CSS rule.

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

**Labels are one face: `--rw-lp-label-*` (mono, 12px, 0.04em).** Uppercase is applied at
the call site so a label can opt out. The middle sections use the label font at their own
sizes; essential small captions stay at 11px or more (chosen-design.md).

---

## 3. Assets

| Asset | Notes |
|---|---|
| `public/agents/*.{mp4,jpg}` | 6 agents, 736KB. Generated from a cropped hero frame so they inherit the real CRT body. Personas move their bodies; **watchdogs only change state** (Judge's body is still, only the iris moves). |
| `heroVideo-{1600,960}.mp4` + poster | 977K/316K/120K from a 23MB master |
| `ctaVideo-{1600,960}.mp4` + poster | 515K/204K/115K from `hero3reverseVideo.mp4` (27MB) |
| `repworth-explainer.mp4` + poster | 25MB, 2m26s, narrated. **Remuxed `+faststart`** — the moov atom was at the end, so playback would have blocked on the full 25MB download. Fetches 0 bytes until clicked. **Still has no captions** (probed 2026-08-04: video + audio streams only, and frames at 20s/75s carry no burned-in text). |
| `problem/problem-diagram.{mp4,jpg}` | 108K/24K. The reputation diagram (2026-08-24): café + orbiting review artifacts, generated (Higgsfield, nano-banana still → seedance clip, agent still as style ref), 720×720, 10s seamless ping-pong loop, audio stripped, `+faststart`. Asset rules: `problem/problem-copy.ts`. |
| `future/roadmap-ground.jpg` | 1.0M, 3840×2143. The route map's chart ground (2026-09-06): a dark green survey chart, lamp-lit on the left, no text — generated (Runway, nano-banana-pro, the off-CRT still as style ref) at 2752×1536, then **upscaled 2× (Runway sublime, low detail invention) and downscaled to 3840** so a full-bleed 1920px viewport gets a 2× file on retina. The first cut shipped a 1920px file with `sizes="75rem"`, so the browser fetched a ~1200px variant for a 1920px-wide chart and the owner read the whole section as low-resolution; Since the Working Atlas (2026-09-10) it renders `unoptimized` at 1.75× so each chapter's crop stays sharp on Retina; the ~1MB file is shared by all three chapters (chosen-design.md, "Map rendering contract"). Decorative; the stops carry the meaning. |
| `future/clouds-{a,b}.jpg` | 52K each, 1600×900. Two cloud plates for the region past the horizon (owner request 2026-09-06): white mist on pure black (Runway, nano-banana-pro, no reference), `mix-blend-mode: screen` so the black is a no-op and only the mist lightens the chart; shown only on the Horizon chapter (opacity .42), with a vertical mask. Under the stops, so the hints stay legible. |
| `future/stops/*.webp` | 10 landmark cutouts, 253K total (7–52K each, ≤480px tall). Reply and Solicitor are the agent stills cut out; the other eight were generated on a flat dark-green ground against the same stills and cut out with a PIL corner flood-fill (`thresh 70`, 1px erode, 0.8px feather) — the Runway cutter kept only the television and dropped every second object (book, cable, ring, gate arm). Lit stops' screens are ON; planned stops' screens are OFF. No red or orange (the first gate arm and life ring were re-made). Which stop uses which: `future-copy.ts`. `future/off-crt.jpg` (13K, the old cards' unpowered set) was deleted with the cards. |
| `fleet/courtyard.webp` | 284K, 2172×724. The fleet section's 3:1 courtyard: four CRT agents at a reply counter, lookout balcony, report kiosk and outbound postbox. Provenance: the 2026-09-final collection. |
| `jobs/{respond,protect,request,brief,measure}.{webp,mp4}` | 472K stills, 8.0M films. One generated film per job, each with its still (the still is the poster, the reduced-motion frame and the failure fallback). Films load only near the viewport. |
| `tiers/*` | 2.0M. `lever-{copilot,autopilot}.webp` (the settled lever, left and right), `lever-to-{copilot,autopilot}.mp4` (the swing into each mode) and `activity-{copilot,autopilot}.mp4` (the selected side station). Named by mode since 2026-09-10; the generated files had reversed names until then. |

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

`focus-visible-marketing.test.ts` asserts a ring per landing control, or per scope where
one scope rule rings all its controls (sections 2–6 and 8). Adding an interactive element
means adding it there. Landing rings use `--rw-lp-accent` — except the light-paper owner
controls, which ring in `#b17f30`; the Island's `--rw-teal-strong` is near-invisible on
this ink.

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
