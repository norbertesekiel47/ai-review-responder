# Dashboard chart primitives — design

**Date:** 2026-07-22
**Status:** Approved (brainstorming session, owner-approved)
**Scope:** Replace the ad-hoc math inside the four fluid-width dashboard charts
with headless d3 primitives, a single shared measurement contract, and
`motion`-driven interactivity — fixing the responsive-sizing bug class at the
root.

## Problem

The dashboard's hand-rolled SVG charts draw into fixed-size viewBoxes and are
placed in fluid-width cards. Each chart reconciles that mismatch differently,
and both reconciliations are wrong:

- `ReputationTrendChart` and `RankingChart` use `preserveAspectRatio="none"` —
  on wide screens the SVG scales non-uniformly and every mark distorts (text
  stretches, the trend dot renders as an ellipse).
- `VelocityCard` and `AggregateVelocityCard` use `xMidYMid meet` with a fixed
  height — on wide cards the chart letterboxes to ~640 px and floats small
  inside the card.

The root cause is shared: a fixed viewBox in a variable-width container can
only stretch or letterbox. Each chart also duplicates its own scale/path
arithmetic, tooltip, and axis rendering.

## Decision summary

| Decision | Choice |
| --- | --- |
| Approach | Headless primitives inside the existing bespoke components (charts keep their identity; a library supplies arithmetic only) |
| Math library | `d3-scale` + `d3-shape` (+ `@types/*` dev deps). No visx, no chart framework. |
| Animation | `motion` v12 (already installed). Full pass: reveals, staggered entrances, springy hover. |
| Charts in scope | `ReputationTrendChart`, `VelocityCard`, `RankingChart`, `AggregateVelocityCard` |
| First paint | SSR/pre-measure render at canonical width (640), corrected to true pixels in `useLayoutEffect` before the post-hydration paint |
| Shared code shape | Thin primitives layer in `src/components/dashboard/charts/` — measurement, tokens, hover, motion presets. No composable `<Chart>` framework. |

## Shared layer — `src/components/dashboard/charts/`

New sibling folder to `kpi/`. Four files:

### `useMeasuredSvg.ts`

The measurement contract, written exactly once.

- Client hook: `const { ref, width, measured } = useMeasuredSvg({ canonicalWidth?: number })`.
- ResizeObserver on the wrapper element, rAF-debounced, drives `width`.
- **Contract: after mount, the SVG's viewBox always equals its rendered CSS
  pixel box** (measured width × the chart's fixed CSS height). No SVG scaling
  ever occurs, so the stretch/letterbox bug class is structurally impossible.
- Before measurement (SSR + hydration frame) it reports the canonical width
  (default 640). Measurement runs in `useLayoutEffect`, so the corrected
  render lands before the browser paints after hydration. The only frame that
  can show canonical width is the pre-hydration SSR HTML, which scales
  uniformly (`meet` semantics at matching aspect — no distortion).
- A zero-size container (`width === 0`) renders no marks until a real size is
  reported.
- Charts must not set `preserveAspectRatio`.

### `chart-tokens.ts`

Single authoritative owner of chart styling constants: sage series ramp
(absorbs `RANKING_COLORS`), hairline grid stroke, axis text fill, tooltip
surface, font families. Every value references the existing Warm Editorial CSS
custom properties (`--rw-*`); no new hex literals.

### `ChartTooltip.tsx` + `useNearestDatum.ts`

Shared hover machinery:

- `useNearestDatum`: pointermove → `scale.invert` (or band-index math) →
  nearest datum index. Pure math, unit-testable.
- `ChartTooltip`: positioned HTML element in real pixel space, the current
  dark-pill visual extracted from `VelocityCard`. Fat invisible hit-bands
  remain the hover targets.

### `motion-presets.ts`

Named spring configs consumed by all charts: `lineReveal` (pathLength draw),
`barStagger` (scaleY from baseline, per-index delay), `hoverDot` (radius/
position spring). One `prefers-reduced-motion` guard collapses every preset to
instant, finished renders.

## Per-chart changes

All four charts keep their component names, file locations, props, and
card/headline chrome. Only the chart internals change.

- **`ReputationTrendChart`** — becomes `'use client'` (props keep arriving
  from the server parent unchanged). `scaleLinear` x/y; `d3.line()` with
  `curveMonotoneX`. `computeTrendDomain` (zoomed star domain, `MIN_DOMAIN_SPAN`
  clamp) is preserved along with its exported tests. Gains: line-draw reveal,
  hover crosshair + tooltip (new capability), springy end-dot. Loses:
  `preserveAspectRatio="none"`, the fixed 720 viewBox, and the `.rep-trend-svg`
  fixed-stretch CSS.
- **`VelocityCard`** — `scaleBand` for bars, `scaleLinear` for y; the
  hand-rolled quadratic path string is replaced by `d3.line().curve(curveMonotoneX)`.
  Staggered bar entrance; hover moves to the shared crosshair/tooltip. The KPI
  summary row (`This week / Total / Weekly avg`) is untouched.
- **`RankingChart`** — same treatment for its multi-series lines;
  `RANKING_COLORS` moves into `chart-tokens.ts` and every call site imports it
  from there; the old export in `RankingChart.helpers` is removed.
- **`AggregateVelocityCard`** — both of its SVGs adopt the measured contract
  and reuse the same helpers as `VelocityCard`.

`Sparkline.tsx` is explicitly out of scope (fixed-size, not exhibiting the
bug).

CSS follow-through: `.rep-trend-svg` sizing rules and any `preserveAspectRatio`
assumptions in `console.css` (`.chart-shell`) are updated so wrappers own
width and fixed height, SVGs render 1:1.

## Edge cases

- **Empty series** → existing empty states unchanged.
- **Single point** → point centered horizontally (current behavior kept).
- **Flat series** → `MIN_DOMAIN_SPAN` domain-zoom logic kept.
- **Zero-width container** → *as-built:* a zero-width wrapper renders a
  zero-width SVG (invisible by construction); the hook reports `measured=false`
  and falls back to the canonical width for the math, so no NaN geometry.
- **Reduced motion** → all presets collapse to instant renders.

> **As-built deviation (hover targets):** instead of per-mark invisible
> hit-bands, hover uses whole-SVG `pointermove` + nearest-datum index
> (`useNearestDatum`) — strictly larger hit area (hover works between marks).
- **Accessibility** → existing `role="img"` + `aria-label` summaries preserved
  on every chart; hit-bands remain keyboard-irrelevant (hover-only, as today).

## Explicitly out of scope

- Geographic/location maps (a separate decision; revisit if the multi-location
  map view lands on the roadmap).
- `Sparkline.tsx` migration.
- Visually-hidden data-table twins for screen readers (candidate follow-up).
- Server/worker-rendered chart artifacts for email digests (candidate
  follow-up; the pure math extraction makes it cheap later).
- Any visual redesign — colors, typography, and layout stay as-is.

## Testing

- Existing `computeTrendDomain` unit tests keep passing unmodified.
- New unit tests: `useMeasuredSvg` (mocked ResizeObserver: pre-measure
  canonical width, post-measure real width, zero-size guard),
  `useNearestDatum` (nearest-index math incl. band scales), reduced-motion
  collapse in `motion-presets`.
- Behavioral verification: dashboard rendered at ~360 px, ~800 px, and
  ~1700 px container widths — no distortion, no letterboxing (the exact repro
  of the two reported screenshots).
- Gates: `pnpm lint && pnpm typecheck && pnpm test`. No DB surface touched, so
  tenant-scope/RLS audits are not triggered by this change.

## Risks

- **Measurement contract leakage** — if pre-measure policy or observer wiring
  is re-implemented per chart, we recreate the original ad-hoc problem one
  layer up. Mitigation: the contract lives only in `useMeasuredSvg`; review
  gate is "no chart file constructs its own ResizeObserver."
- **Hydration flash** — mitigated by canonical-width SSR + `useLayoutEffect`
  correction (decision above).
- **Bundle** — `d3-scale` + `d3-shape` ≈ 10 KB gz, client-side only, no ESLint
  boundary implications (pure math, no server-only imports).
