# Dashboard Chart Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc math inside the four fluid-width dashboard charts with d3-scale/d3-shape primitives, one shared measurement contract (`useMeasuredSvg`), and `motion` springs — killing the stretch/letterbox bug class at the root.

**Architecture:** A thin primitives layer at `src/components/dashboard/charts/` owns measurement, styling tokens, hover math, tooltip, and motion presets. Each chart component keeps its name, file, props, and card chrome; only chart internals change. After mount the SVG viewBox always equals rendered CSS pixels (no SVG scaling ever); pre-measure/SSR frames render at a canonical width and scale uniformly (default `xMidYMid meet` — never distorted).

**Tech Stack:** Next.js 16 / React 19, `d3-scale` + `d3-shape` (new, pure math), `motion` v12 (already installed, `LazyMotion`/`m` pattern per onboarding), Vitest + jsdom (`// @vitest-environment jsdom` pragma) + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-22-dashboard-chart-primitives-design.md`

**Branch:** `feat/dashboard-chart-primitives` (already created; spec committed on it).

**Repo facts the engineer must know:**
- Vitest defaults to `environment: 'node'`; component tests need the `// @vitest-environment jsdom` pragma as line 1.
- jsdom has no `ResizeObserver`; `useMeasuredSvg` must guard, tests must stub it.
- `vitest.setup.ts` already stubs `window.matchMedia` (reports "no preference"), so `usePrefersReducedMotion` (existing hook at `src/hooks/usePrefersReducedMotion.ts`) works in jsdom tests.
- `motion` is imported as `import { LazyMotion, m, domAnimation } from 'motion/react'` in this repo. Always use `m.*` inside `<LazyMotion features={domAnimation} strict>`, never bare `motion.*`.
- Run targeted tests with `pnpm vitest run <path>`. Full gates: `pnpm lint && pnpm typecheck && pnpm test`.
- Never edit files outside this branch's working tree.

---

### Task 1: Install d3 dependencies

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via pnpm only)

- [ ] **Step 1: Install runtime + type packages**

```bash
pnpm add d3-scale d3-shape && pnpm add -D @types/d3-scale @types/d3-shape
```

Verify the exact package names above (they are the official d3 micro-packages; no `@visx/*`, no `d3` meta-package).

- [ ] **Step 2: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add d3-scale + d3-shape for headless chart primitives"
```

---

### Task 2: `chart-tokens.ts` — single owner of chart styling constants

**Files:**
- Create: `src/components/dashboard/charts/chart-tokens.ts`
- Modify: `src/components/dashboard/kpi/RankingChart.helpers.ts` (remove `RANKING_COLORS` export, import from tokens)
- Modify: `src/components/dashboard/aggregate/AggregateRankingCard.tsx:9` (import path swap)
- Modify: `src/components/dashboard/aggregate/AggregateVelocityCard.tsx:5` (import path swap)

- [ ] **Step 1: Create the tokens file**

```ts
// src/components/dashboard/charts/chart-tokens.ts

// Single authoritative owner of Warm Editorial chart styling constants.
// Every value references the existing --rw-* custom properties; the only
// literal hexes are the multi-hue series ramp, which encodes WHICH
// location/series and intentionally is not sage.

export const CHART_ACCENT = 'var(--rw-sage-deep)';
export const CHART_GRID_STROKE = 'var(--rw-hair)';
export const CHART_AXIS_FILL = 'var(--rw-app-text-soft)';
export const CHART_AXIS_FILL_ACTIVE = 'var(--rw-app-text-muted)';
export const CHART_DOT_FILL = 'var(--rw-card)';
export const CHART_DANGER = 'var(--rw-danger)';
export const CHART_FONT_BODY = 'var(--rw-font-body)';
export const CHART_FONT_DISPLAY = 'var(--rw-font-display)';

// Moved from RankingChart.helpers.ts (spec: one owner; old export removed).
// Shared by RankingChart series, AggregateRankingCard legend, and the
// stacked velocity bars so a location keeps one color everywhere.
export const RANKING_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ea580c',
  '#9333ea',
  '#0891b2',
  '#dc2626',
] as const;
```

- [ ] **Step 2: Move `RANKING_COLORS` out of RankingChart.helpers.ts**

In `src/components/dashboard/kpi/RankingChart.helpers.ts`, delete line 1 (`export const RANKING_COLORS = [...] as const;`) and add at the top:

```ts
import { RANKING_COLORS } from '@/components/dashboard/charts/chart-tokens';
```

(`buildRankingSeries` keeps using `RANKING_COLORS` internally — only the export moves.)

- [ ] **Step 3: Update the two import call sites**

In `src/components/dashboard/aggregate/AggregateRankingCard.tsx`, remove `RANKING_COLORS` from the `RankingChart.helpers` import and add:

```ts
import { RANKING_COLORS } from '@/components/dashboard/charts/chart-tokens';
```

In `src/components/dashboard/aggregate/AggregateVelocityCard.tsx`, replace line 5 with:

```ts
import { RANKING_COLORS } from '@/components/dashboard/charts/chart-tokens';
```

- [ ] **Step 4: Verify nothing else imported it and tests pass**

Run: `rg -n "RANKING_COLORS" src --glob '!**/charts/chart-tokens.ts'`
Expected: hits only in `RankingChart.helpers.ts` (internal use), `AggregateRankingCard.tsx`, `AggregateVelocityCard.tsx` — all importing from `chart-tokens`.

Run: `pnpm vitest run src/components/dashboard/__tests__/RankingChart.test.ts src/components/dashboard/__tests__/RankingChart.styling.test.tsx && pnpm typecheck`
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/charts/chart-tokens.ts src/components/dashboard/kpi/RankingChart.helpers.ts src/components/dashboard/aggregate/AggregateRankingCard.tsx src/components/dashboard/aggregate/AggregateVelocityCard.tsx
git commit -m "refactor: move RANKING_COLORS into chart-tokens single owner"
```

---

### Task 3: `useMeasuredSvg` — the measurement contract

**Files:**
- Create: `src/components/dashboard/charts/useMeasuredSvg.ts`
- Test: `src/components/dashboard/charts/__tests__/useMeasuredSvg.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/dashboard/charts/__tests__/useMeasuredSvg.test.tsx
// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL_CHART_WIDTH, useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';

type ROCallback = (entries: Array<{ contentRect: { width: number } }>) => void;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ROCallback;
  observed: Element[] = [];
  constructor(callback: ROCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
}

function Probe() {
  const { ref, width, measured } = useMeasuredSvg<HTMLDivElement>();
  return (
    <div ref={ref}>
      <span data-testid="width">{width}</span>
      <span data-testid="measured">{String(measured)}</span>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockResizeObserver.instances = [];
});

describe('useMeasuredSvg', () => {
  it('reports the canonical width, unmeasured, when ResizeObserver is unavailable (SSR/jsdom default)', () => {
    render(<Probe />);
    expect(screen.getByTestId('width').textContent).toBe(String(CANONICAL_CHART_WIDTH));
    expect(screen.getByTestId('measured').textContent).toBe('false');
  });

  it('adopts the observed width once ResizeObserver reports a positive size', () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    render(<Probe />);
    const instance = MockResizeObserver.instances[0]!;
    act(() => instance.callback([{ contentRect: { width: 831 } }]));
    expect(screen.getByTestId('width').textContent).toBe('831');
    expect(screen.getByTestId('measured').textContent).toBe('true');
  });

  it('falls back to canonical width and measured=false on a zero-size report', () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    render(<Probe />);
    act(() => MockResizeObserver.instances[0]!.callback([{ contentRect: { width: 0 } }]));
    expect(screen.getByTestId('width').textContent).toBe(String(CANONICAL_CHART_WIDTH));
    expect(screen.getByTestId('measured').textContent).toBe('false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/useMeasuredSvg.test.tsx`
Expected: FAIL — cannot resolve `@/components/dashboard/charts/useMeasuredSvg`.

- [ ] **Step 3: Implement the hook**

```ts
// src/components/dashboard/charts/useMeasuredSvg.ts
'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const CANONICAL_CHART_WIDTH = 640;

interface MeasuredSvg<T extends HTMLElement> {
  ref: RefObject<T | null>;
  /** Always a positive number safe to build scales/viewBox from. */
  width: number;
  /** True only after a positive real measurement of the wrapper. */
  measured: boolean;
}

/**
 * The chart measurement contract — the ONLY place chart sizing may live.
 *
 * Contract: after mount, a chart's viewBox width MUST equal this hook's
 * `width` (the wrapper's rendered CSS pixel width), so the SVG renders 1:1
 * and the stretch/letterbox bug class is structurally impossible. Before
 * measurement (SSR + hydration frame) `width` is the canonical width; that
 * frame scales uniformly under the default `xMidYMid meet` — charts must
 * never set `preserveAspectRatio`, and no chart file may construct its own
 * ResizeObserver.
 */
export function useMeasuredSvg<T extends HTMLElement = HTMLDivElement>(
  { canonicalWidth = CANONICAL_CHART_WIDTH }: { canonicalWidth?: number } = {},
): MeasuredSvg<T> {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const apply = (next: number) => setWidth((prev) => (prev === next ? prev : next));
    apply(el.getBoundingClientRect().width);

    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apply(entry.contentRect.width));
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const hasSize = width != null && width > 0;
  return { ref, width: hasSize ? width : canonicalWidth, measured: hasSize };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/useMeasuredSvg.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/charts/useMeasuredSvg.ts src/components/dashboard/charts/__tests__/useMeasuredSvg.test.tsx
git commit -m "feat: useMeasuredSvg measurement contract for dashboard charts"
```

---

### Task 4: `useNearestDatum` — shared hover math

**Files:**
- Create: `src/components/dashboard/charts/useNearestDatum.ts`
- Test: `src/components/dashboard/charts/__tests__/useNearestDatum.test.ts`

- [ ] **Step 1: Write the failing test (pure function — node env, no pragma needed)**

```ts
// src/components/dashboard/charts/__tests__/useNearestDatum.test.ts
import { describe, expect, it } from 'vitest';
import { nearestIndex } from '@/components/dashboard/charts/useNearestDatum';

describe('nearestIndex', () => {
  it('returns null for an empty position list', () => {
    expect(nearestIndex([], 100)).toBeNull();
  });

  it('picks the closest x position', () => {
    expect(nearestIndex([10, 50, 90], 47)).toBe(1);
    expect(nearestIndex([10, 50, 90], 75)).toBe(2);
  });

  it('clamps to the edges for out-of-range pointers', () => {
    expect(nearestIndex([10, 50, 90], -30)).toBe(0);
    expect(nearestIndex([10, 50, 90], 500)).toBe(2);
  });

  it('breaks ties toward the earlier index', () => {
    expect(nearestIndex([10, 30], 20)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/useNearestDatum.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/dashboard/charts/useNearestDatum.ts
'use client';

import { useState, type PointerEvent } from 'react';

/** Index of the closest x position to the pointer; ties go to the earlier index. */
export function nearestIndex(xPositions: readonly number[], pointerX: number): number | null {
  if (xPositions.length === 0) return null;
  let best = 0;
  let bestDist = Math.abs(xPositions[0]! - pointerX);
  for (let i = 1; i < xPositions.length; i++) {
    const dist = Math.abs(xPositions[i]! - pointerX);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Pointer→datum hover state. Because the viewBox equals rendered pixels
 * (useMeasuredSvg contract), `clientX − rect.left` IS the chart-space x —
 * no inverse scaling needed. Spread the handlers onto the <svg>.
 */
export function useNearestDatum(xPositions: readonly number[]) {
  const [index, setIndex] = useState<number | null>(null);

  const onPointerMove = (event: PointerEvent<Element>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setIndex(nearestIndex(xPositions, event.clientX - rect.left));
  };
  const onPointerLeave = () => setIndex(null);

  return { index, onPointerMove, onPointerLeave };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/useNearestDatum.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/charts/useNearestDatum.ts src/components/dashboard/charts/__tests__/useNearestDatum.test.ts
git commit -m "feat: shared nearest-datum hover math for dashboard charts"
```

---

### Task 5: `motion-presets.ts` — named transitions + reduced-motion collapse

**Files:**
- Create: `src/components/dashboard/charts/motion-presets.ts`
- Test: `src/components/dashboard/charts/__tests__/motion-presets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/dashboard/charts/__tests__/motion-presets.test.ts
import { describe, expect, it } from 'vitest';
import { BAR_SPRING, chartTransition } from '@/components/dashboard/charts/motion-presets';

describe('chartTransition', () => {
  it('passes the base transition through when motion is allowed', () => {
    expect(chartTransition(false, BAR_SPRING)).toEqual(BAR_SPRING);
  });

  it('applies a stagger delay when motion is allowed', () => {
    expect(chartTransition(false, BAR_SPRING, 0.09)).toEqual({ ...BAR_SPRING, delay: 0.09 });
  });

  it('collapses to an instant cut under prefers-reduced-motion, dropping any delay', () => {
    expect(chartTransition(true, BAR_SPRING, 0.09)).toEqual({ duration: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/motion-presets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/dashboard/charts/motion-presets.ts
import type { Transition } from 'motion/react';

/** Tween for path-draw reveals — springs visibly overshoot pathLength. */
export const LINE_REVEAL: Transition = { duration: 0.9, ease: [0.33, 1, 0.68, 1] };

/** Spring for bar entrances (animate y + height from the baseline). */
export const BAR_SPRING: Transition = { type: 'spring', stiffness: 260, damping: 26 };

/** Per-bar entrance stagger, in seconds (multiply by bar index). */
export const BAR_STAGGER_S = 0.045;

/** Spring for hover/end dot position. */
export const DOT_SPRING: Transition = { type: 'spring', stiffness: 320, damping: 22 };

/**
 * The one reduced-motion gate for charts: every animated mark builds its
 * transition through this, so prefers-reduced-motion collapses the whole
 * system to instant, finished renders. `reduced` comes from the existing
 * usePrefersReducedMotion hook (src/hooks/usePrefersReducedMotion.ts).
 */
export function chartTransition(reduced: boolean, base: Transition, delaySeconds = 0): Transition {
  if (reduced) return { duration: 0 };
  return delaySeconds > 0 ? { ...base, delay: delaySeconds } : base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/motion-presets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/charts/motion-presets.ts src/components/dashboard/charts/__tests__/motion-presets.test.ts
git commit -m "feat: chart motion presets with reduced-motion collapse"
```

---

### Task 6: `ChartTooltip` — shared HTML-overlay tooltip (+ CSS)

**Files:**
- Create: `src/components/dashboard/charts/ChartTooltip.tsx`
- Modify: `src/app/(authenticated)/_styles/console.css` (append tooltip + crosshair rules after the `.rep-trend-*` block at ~line 1759)
- Test: `src/components/dashboard/charts/__tests__/ChartTooltip.test.tsx`

- [ ] **Step 1: Write the failing test**

> **DEVIATION (applied in commit 39d31a95, from code-quality review):** the shipped
> component uses `aria-hidden="true"` instead of `role="status"` — a hover-only
> decorative overlay must not be a live region (AT spam on every hover move) —
> and the tests query `.chart-tip` by class instead of `getByRole('status')`.
> A sync comment above `TIP_W` cross-references the `.chart-tip` CSS width.

```tsx
// src/components/dashboard/charts/__tests__/ChartTooltip.test.tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartTooltip } from '@/components/dashboard/charts/ChartTooltip';

describe('ChartTooltip', () => {
  it('renders title and value centered on the anchor', () => {
    render(<ChartTooltip x={300} y={120} title="Week of Jul 19" value="65 reviews" containerWidth={640} />);
    expect(screen.getByText('Week of Jul 19')).toBeInTheDocument();
    expect(screen.getByText('65 reviews')).toBeInTheDocument();
    const tip = screen.getByRole('status');
    expect(tip.style.left).toBe('252px'); // 300 − 96/2
    expect(tip.style.top).toBe('68px'); // 120 − 52
  });

  it('clamps inside the container at both edges', () => {
    const { rerender } = render(<ChartTooltip x={2} y={10} title="t" value="v" containerWidth={640} />);
    expect(screen.getByRole('status').style.left).toBe('4px');
    expect(screen.getByRole('status').style.top).toBe('4px');
    rerender(<ChartTooltip x={639} y={120} title="t" value="v" containerWidth={640} />);
    expect(screen.getByRole('status').style.left).toBe('540px'); // 640 − 96 − 4
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/ChartTooltip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/dashboard/charts/ChartTooltip.tsx
'use client';

interface ChartTooltipProps {
  /** Anchor position in chart pixels (== wrapper pixels per useMeasuredSvg). */
  x: number;
  y: number;
  title: string;
  value: string;
  containerWidth: number;
}

const TIP_W = 96;
const TIP_LIFT = 52;
const EDGE = 4;

/** Dark-pill tooltip as an HTML overlay: real text, never SVG-scaled. Parent must be position:relative. */
export function ChartTooltip({ x, y, title, value, containerWidth }: ChartTooltipProps) {
  const left = Math.min(Math.max(x - TIP_W / 2, EDGE), containerWidth - TIP_W - EDGE);
  const top = Math.max(y - TIP_LIFT, EDGE);
  return (
    <div className="chart-tip" role="status" style={{ left, top }}>
      <span className="chart-tip-title">{title}</span>
      <span className="chart-tip-value">{value}</span>
    </div>
  );
}
```

- [ ] **Step 4: Append CSS to `console.css` (directly after the `.rep-trend-empty` rule, ~line 1759)**

```css
/* Shared chart hover chrome (charts/ChartTooltip + crosshair). */
.chart-tip {
  position: absolute;
  width: 96px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--rw-app-text);
  opacity: 0.95;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  z-index: 5;
}
.chart-tip-title { font-size: 9px; font-weight: 500; color: var(--rw-app-text-soft); font-family: var(--rw-font-body); }
.chart-tip-value { font-size: 14px; font-weight: 700; color: var(--rw-card); font-family: var(--rw-font-display); }
.chart-crosshair { stroke: var(--rw-sage-deep); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.5; pointer-events: none; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/ChartTooltip.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/charts/ChartTooltip.tsx src/components/dashboard/charts/__tests__/ChartTooltip.test.tsx "src/app/(authenticated)/_styles/console.css"
git commit -m "feat: shared ChartTooltip overlay + crosshair styles"
```

---

### Task 7: Migrate `ReputationTrendChart`

**Files:**
- Modify: `src/components/dashboard/kpi/ReputationTrendChart.tsx` (full rewrite below)
- Modify: `src/app/(authenticated)/_styles/console.css:1754` (`.rep-trend-svg` rule + new `.rep-trend-plot`)
- Test: `src/components/dashboard/__tests__/ReputationTrendChart.test.tsx` (existing — must stay green; one new assertion added)

- [ ] **Step 1: Add a failing assertion to the existing test file**

Append inside the existing `describe('ReputationTrendChart', ...)` block:

```tsx
  it('never sets preserveAspectRatio (measured-viewBox contract)', () => {
    render(<ReputationTrendChart trend={trendWith([4.3, 4.4, null, 4.6, 4.8])} />);
    const chart = screen.getByRole('img');
    expect(chart).not.toHaveAttribute('preserveAspectRatio');
    expect(chart.getAttribute('viewBox')).toBe('0 0 640 200'); // canonical width in jsdom (no ResizeObserver)
  });
```

Run: `pnpm vitest run src/components/dashboard/__tests__/ReputationTrendChart.test.tsx`
Expected: the new test FAILS (current component sets `preserveAspectRatio="none"` and viewBox `0 0 720 200`); the others pass.

- [ ] **Step 2: Rewrite the component**

```tsx
// src/components/dashboard/kpi/ReputationTrendChart.tsx
'use client';

import { scaleLinear } from 'd3-scale';
import { line as d3Line, curveMonotoneX } from 'd3-shape';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { ReputationSummary } from '@/lib/dashboard/types';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeTrendHeadline } from '@/components/dashboard/kpi/chart-headlines';
import { ChartTooltip } from '@/components/dashboard/charts/ChartTooltip';
import { chartTransition, DOT_SPRING, LINE_REVEAL } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { useNearestDatum } from '@/components/dashboard/charts/useNearestDatum';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface Props {
  trend: ReputationSummary['trend'];
}

// Plot geometry (real pixels — the viewBox equals the measured wrapper width
// per the useMeasuredSvg contract). The Y-axis domain is computed from the
// data (see computeTrendDomain) rather than pinned to 1–5, so movement inside
// the real 4.x band is visible instead of flattened.
const H = 200;
const LEFT = 34;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 174; // H − 26 for x labels

/** Smallest star span the axis will ever show, so a flat-ish trend still reads. */
const MIN_DOMAIN_SPAN = 0.6;

/**
 * Y-axis domain zoomed to the data: [min−0.2, max+0.2] clamped to [1,5] with a
 * minimum span of ~0.6. A 4.3→4.8 run fills the axis instead of hugging the top
 * of a fixed 1–5 chart. Empty input falls back to the full 1–5 range.
 */
export function computeTrendDomain(stars: number[]): { min: number; max: number } {
  if (stars.length === 0) return { min: 1, max: 5 };

  let min = Math.max(1, Math.min(...stars) - 0.2);
  let max = Math.min(5, Math.max(...stars) + 0.2);

  if (max - min < MIN_DOMAIN_SPAN) {
    const mid = (min + max) / 2;
    min = mid - MIN_DOMAIN_SPAN / 2;
    max = mid + MIN_DOMAIN_SPAN / 2;
    // Shift the window back inside [1,5] if expanding pushed it past an edge.
    if (min < 1) {
      max += 1 - min;
      min = 1;
    }
    if (max > 5) {
      min -= max - 5;
      max = 5;
    }
    min = Math.max(1, min);
    max = Math.min(5, max);
  }

  return { min, max };
}

function weekLabel(weekStartIso: string): string {
  return new Date(weekStartIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ReputationTrendChart({ trend }: Props) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

  const points = trend
    .map((week, index) => ({ index, star: week.starEquivalent }))
    .filter((p): p is { index: number; star: number } => p.star != null);

  const domain = computeTrendDomain(points.map((p) => p.star));
  const headline = computeTrendHeadline(trend);

  const y = scaleLinear().domain([domain.min, domain.max]).range([BOTTOM, TOP]).clamp(true);
  const x = scaleLinear().domain([0, Math.max(1, trend.length - 1)]).range([LEFT, width - RIGHT]);

  const path =
    d3Line<{ index: number; star: number }>()
      .x((p) => x(p.index))
      .y((p) => y(p.star))
      .curve(curveMonotoneX)(points) ?? '';

  const hover = useNearestDatum(points.map((p) => x(p.index)));
  const hovered = hover.index != null ? points[hover.index] : undefined;
  const last = points[points.length - 1];
  const focus = hovered ?? last;

  // Three gridlines spanning the zoomed domain (top / mid / bottom).
  const gridStars = [domain.max, (domain.min + domain.max) / 2, domain.min];

  return (
    <div className="card rep-trend">
      <div className="rep-trend-head">
        <h2 className="card-h2" style={{ margin: 0 }}>Reputation trend</h2>
        <span className="rep-trend-sub">star-equivalent · last 8 weeks</span>
      </div>

      {points.length === 0 ? (
        <p className="rep-trend-empty">Not enough reviews yet to chart a trend. Check back in a few weeks.</p>
      ) : (
        <>
          <ChartHeadlineBanner data={headline} />
          <div ref={ref} className="rep-trend-plot">
            <LazyMotion features={domAnimation} strict>
              <svg
                className="rep-trend-svg"
                viewBox={`0 0 ${width} ${H}`}
                role="img"
                aria-label={`Reputation trend, star-equivalent, last 8 weeks, latest ${points[points.length - 1]!.star.toFixed(1)} stars`}
                onPointerMove={hover.onPointerMove}
                onPointerLeave={hover.onPointerLeave}
              >
                {gridStars.map((star) => (
                  <line key={star} className="rep-trend-grid" x1={LEFT} x2={width - RIGHT} y1={y(star)} y2={y(star)} />
                ))}
                {gridStars.map((star) => (
                  <text key={`l-${star}`} className="rep-trend-axis" x={20} y={y(star) + 4}>{star.toFixed(1)}</text>
                ))}
                {hovered && (
                  <line className="chart-crosshair" x1={x(hovered.index)} x2={x(hovered.index)} y1={TOP} y2={BOTTOM} />
                )}
                <m.path
                  className="rep-trend-line"
                  d={path}
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={chartTransition(reduced, LINE_REVEAL)}
                />
                {focus && (
                  <m.g
                    animate={{ x: x(focus.index), y: y(focus.star) }}
                    transition={chartTransition(reduced, DOT_SPRING)}
                  >
                    <circle className="rep-trend-dot" r={4.5} />
                  </m.g>
                )}
                <text className="rep-trend-axis" x={LEFT} y={194}>8 weeks ago</text>
                <text className="rep-trend-axis" x={width - RIGHT} y={194} textAnchor="end">now</text>
              </svg>
            </LazyMotion>
            {hovered && (
              <ChartTooltip
                x={x(hovered.index)}
                y={y(hovered.star)}
                title={`Week of ${weekLabel(trend[hovered.index]!.weekStart)}`}
                value={`${hovered.star.toFixed(1)}★`}
                containerWidth={width}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

Note (CORRECTED after review of commit 2ba3e6ee): motion only skips the mount-enter animation when `initial === false` (or initial equals animate) — an *unset* `initial` still animates from the element's default transform (0,0). The dot's `m.g` therefore MUST set `initial={false}` so it mounts at rest and only springs on hover-driven position changes (fixed in the follow-up commit). Any later task copying this dot pattern must include `initial={false}`. Under reduced motion `chartTransition` makes hover moves instant too.

- [ ] **Step 3: Update the CSS**

In `src/app/(authenticated)/_styles/console.css`, replace the `.rep-trend-svg` rule (line 1754) with:

```css
.rep-trend-plot { position: relative; margin-top: 14px; }
.rep-trend-svg { width: 100%; height: 200px; display: block; }
```

(Margin moves from the svg to the wrapper; wrapper is the measured, position-relative tooltip parent.)

- [ ] **Step 4: Run the test file to verify everything passes**

Run: `pnpm vitest run src/components/dashboard/__tests__/ReputationTrendChart.test.tsx`
Expected: PASS, including the new contract assertion.

- [ ] **Step 5: Run adjacent suites (consumer + headline)**

Run: `pnpm vitest run src/components/__tests__/DashboardContent.test.tsx src/components/dashboard/__tests__/chart-headlines.test.ts && pnpm typecheck`
Expected: PASS / exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/kpi/ReputationTrendChart.tsx src/components/dashboard/__tests__/ReputationTrendChart.test.tsx "src/app/(authenticated)/_styles/console.css"
git commit -m "feat: ReputationTrendChart on measured d3 primitives with hover + reveal"
```

---

### Task 8: Shared `VelocityChart`, `KpiSummary`, and `computeVelocitySummary`

**Files:**
- Create: `src/components/dashboard/charts/VelocityChart.tsx`
- Create: `src/components/dashboard/charts/KpiSummary.tsx`
- Test: `src/components/dashboard/charts/__tests__/VelocityChart.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/dashboard/charts/__tests__/VelocityChart.test.tsx
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  VelocityChart,
  computeVelocitySummary,
  weekShortLabel,
} from '@/components/dashboard/charts/VelocityChart';

describe('computeVelocitySummary', () => {
  it('derives last week, delta, total, and 1-decimal average', () => {
    expect(computeVelocitySummary([0, 4, 8])).toEqual({ lastWeek: 8, deltaPct: 100, total: 12, avg: 4 });
    expect(computeVelocitySummary([5, 5])).toEqual({ lastWeek: 5, deltaPct: 0, total: 10, avg: 5 });
  });

  it('reports 0% delta when the previous week is zero or missing', () => {
    expect(computeVelocitySummary([0, 7]).deltaPct).toBe(0);
    expect(computeVelocitySummary([7]).deltaPct).toBe(0);
    expect(computeVelocitySummary([]).total).toBe(0);
  });
});

describe('weekShortLabel', () => {
  it('labels every other tick plus the final one', () => {
    expect(weekShortLabel('2026-07-13T00:00:00Z', 1, 8)).toBe('');
    expect(weekShortLabel('2026-07-13T00:00:00Z', 7, 8)).not.toBe('');
    expect(weekShortLabel('2026-07-13T00:00:00Z', 2, 8)).not.toBe('');
  });
});

describe('VelocityChart', () => {
  const data = [
    { label: 'May 31', count: 0 },
    { label: '', count: 2 },
    { label: 'Jun 14', count: 65 },
  ];

  it('renders one bar per datum with a measured-contract viewBox', () => {
    const { container } = render(<VelocityChart data={data} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 220'); // canonical in jsdom
    expect(svg.hasAttribute('preserveAspectRatio')).toBe(false);
    expect(container.querySelectorAll('rect').length).toBe(3);
    expect(screen.getByText('May 31')).toBeInTheDocument();
  });

  it('renders the average reference line label', () => {
    render(<VelocityChart data={data} />);
    expect(screen.getByText(/avg 22.3/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/VelocityChart.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `KpiSummary` (extracted verbatim from the two cards)**

```tsx
// src/components/dashboard/charts/KpiSummary.tsx
import { CHART_ACCENT, CHART_DANGER, CHART_FONT_DISPLAY } from '@/components/dashboard/charts/chart-tokens';

interface KpiSummaryProps {
  label: string;
  value: number;
  delta?: number;
}

/** One stat in the row above a velocity chart (This week / Total / Weekly avg). */
export function KpiSummary({ label, value, delta }: KpiSummaryProps) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--rw-app-text-muted)', fontWeight: 500, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: CHART_FONT_DISPLAY, fontWeight: 700, fontSize: 24, letterSpacing: '-0.02em' }}>
          {value}
        </span>
        {delta != null && (
          <span style={{ fontSize: 12, fontWeight: 600, color: delta >= 0 ? CHART_ACCENT : CHART_DANGER }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `VelocityChart`**

```tsx
// src/components/dashboard/charts/VelocityChart.tsx
'use client';

import { scaleBand, scaleLinear } from 'd3-scale';
import { line as d3Line, curveMonotoneX } from 'd3-shape';
import { LazyMotion, domAnimation, m } from 'motion/react';
import {
  CHART_ACCENT,
  CHART_AXIS_FILL,
  CHART_AXIS_FILL_ACTIVE,
  CHART_DOT_FILL,
  CHART_FONT_BODY,
  CHART_GRID_STROKE,
} from '@/components/dashboard/charts/chart-tokens';
import { ChartTooltip } from '@/components/dashboard/charts/ChartTooltip';
import { BAR_SPRING, BAR_STAGGER_S, chartTransition, LINE_REVEAL } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { useNearestDatum } from '@/components/dashboard/charts/useNearestDatum';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export interface VelocityDatum {
  label: string;
  count: number;
}

export interface VelocitySummary {
  lastWeek: number;
  deltaPct: number;
  total: number;
  avg: number;
}

/** Derives the stat row (This week / delta / total / 1-decimal avg) from weekly counts. */
export function computeVelocitySummary(counts: number[]): VelocitySummary {
  const lastWeek = counts[counts.length - 1] ?? 0;
  const prevWeek = counts[counts.length - 2] ?? lastWeek;
  return {
    lastWeek,
    deltaPct: prevWeek ? Math.round(((lastWeek - prevWeek) / prevWeek) * 100) : 0,
    total: counts.reduce((a, b) => a + b, 0),
    avg: Number((counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length)).toFixed(1)),
  };
}

/** Shows only ~half the tick labels (every other, plus the last) to avoid crowding. */
export function weekShortLabel(weekStartIso: string, idx: number, total: number): string {
  if (idx % 2 !== 0 && idx !== total - 1) return '';
  return new Date(weekStartIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PAD = { l: 36, r: 16, t: 28, b: 32 };
const H = 220;
const GRAD_ID = 'velGrad';
const LINE_ID = 'velLine';

/** Weekly bars + smoothed trend line + avg reference, on the measured-viewBox contract. */
export function VelocityChart({ data }: { data: VelocityDatum[] }) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

  const counts = data.map((d) => d.count);
  const max = Math.max(...counts, 1);
  const avg = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const peakIdx = counts.indexOf(Math.max(...counts));
  const innerH = H - PAD.t - PAD.b;

  const xBand = scaleBand<number>()
    .domain(data.map((_, i) => i))
    .range([PAD.l, width - PAD.r])
    .paddingInner(0.5)
    .paddingOuter(0.25);
  const yScale = scaleLinear().domain([0, max]).range([PAD.t + innerH, PAD.t]);
  const barW = xBand.bandwidth();
  const centerX = (i: number) => (xBand(i) ?? PAD.l) + barW / 2;

  const linePath =
    d3Line<VelocityDatum>()
      .x((_, i) => centerX(i))
      .y((d) => yScale(d.count))
      .curve(curveMonotoneX)(data) ?? '';

  const hover = useNearestDatum(data.map((_, i) => centerX(i)));
  const hoveredDatum = hover.index != null ? data[hover.index] : undefined;
  const yTicks = [0, Math.round(max / 2), max];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <LazyMotion features={domAnimation} strict>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          className="chart-shell"
          style={{ height: H, display: 'block', overflow: 'visible' }}
          onPointerMove={hover.onPointerMove}
          onPointerLeave={hover.onPointerLeave}
        >
          <defs>
            <linearGradient id={GRAD_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: CHART_ACCENT, stopOpacity: 0.95 }} />
              <stop offset="100%" style={{ stopColor: CHART_ACCENT, stopOpacity: 0.32 }} />
            </linearGradient>
            <linearGradient id={LINE_ID} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" style={{ stopColor: CHART_ACCENT, stopOpacity: 0.4 }} />
              <stop offset="100%" style={{ stopColor: CHART_ACCENT, stopOpacity: 1 }} />
            </linearGradient>
          </defs>

          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={width - PAD.r} y1={yScale(t)} y2={yScale(t)} style={{ stroke: CHART_GRID_STROKE }} strokeWidth="1" />
              <text x={PAD.l - 8} y={yScale(t) + 3} textAnchor="end" fontSize="10" style={{ fill: CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}>
                {t}
              </text>
            </g>
          ))}

          <line
            x1={PAD.l}
            x2={width - PAD.r}
            y1={yScale(avg)}
            y2={yScale(avg)}
            style={{ stroke: CHART_AXIS_FILL }}
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity="0.7"
          />
          <text
            x={width - PAD.r}
            y={yScale(avg) - 4}
            textAnchor="end"
            fontSize="9"
            fontWeight="500"
            style={{ fill: CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}
          >
            avg {avg.toFixed(1)}
          </text>

          {data.map((d, i) => {
            const xPos = xBand(i) ?? PAD.l;
            const h = (d.count / max) * innerH;
            const yPos = PAD.t + innerH - h;
            const isHover = hover.index === i;
            return (
              <g key={i}>
                <m.rect
                  x={xPos}
                  width={barW}
                  rx={6}
                  ry={6}
                  fill={`url(#${GRAD_ID})`}
                  initial={reduced ? false : { y: PAD.t + innerH, height: 0 }}
                  animate={{ y: yPos, height: h, opacity: hover.index == null || isHover ? 1 : 0.5 }}
                  transition={chartTransition(reduced, BAR_SPRING, i * BAR_STAGGER_S)}
                />
                {i === peakIdx && (
                  <circle cx={centerX(i)} cy={yPos - 12} r="3" style={{ fill: CHART_ACCENT }}>
                    <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />
                  </circle>
                )}
                <text
                  x={centerX(i)}
                  y={H - 12}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight={isHover ? 600 : 400}
                  style={{ fill: isHover ? CHART_AXIS_FILL_ACTIVE : CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}
                >
                  {d.label}
                </text>
              </g>
            );
          })}

          {hover.index != null && (
            <line className="chart-crosshair" x1={centerX(hover.index)} x2={centerX(hover.index)} y1={PAD.t} y2={PAD.t + innerH} />
          )}

          <m.path
            d={linePath}
            fill="none"
            stroke={`url(#${LINE_ID})`}
            strokeWidth={2}
            strokeLinecap="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={chartTransition(reduced, LINE_REVEAL)}
          />
          {data.map((d, i) => (
            <circle
              key={i}
              cx={centerX(i)}
              cy={yScale(d.count)}
              r={hover.index === i ? 5 : 3}
              style={{ fill: CHART_DOT_FILL, stroke: CHART_ACCENT, strokeWidth: 2, transition: 'r 160ms' }}
            />
          ))}
        </svg>
      </LazyMotion>

      {hover.index != null && hoveredDatum && (
        <ChartTooltip
          x={centerX(hover.index)}
          y={yScale(hoveredDatum.count)}
          title={`Week of ${hoveredDatum.label || `#${hover.index + 1}`}`}
          value={`${hoveredDatum.count} reviews`}
          containerWidth={width}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/charts/__tests__/VelocityChart.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/charts/VelocityChart.tsx src/components/dashboard/charts/KpiSummary.tsx src/components/dashboard/charts/__tests__/VelocityChart.test.tsx
git commit -m "feat: shared VelocityChart + KpiSummary on measured d3 primitives"
```

---

### Task 9: Adopt shared components in `VelocityCard` and `AggregateVelocityCard`

**Files:**
- Modify: `src/components/dashboard/kpi/VelocityCard.tsx` (full rewrite below — shrinks to a thin card)
- Modify: `src/components/dashboard/aggregate/AggregateVelocityCard.tsx` (total mode → shared chart; stacked chart onto the contract)
- Test: existing `src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx` must stay green

- [ ] **Step 1: Rewrite `VelocityCard.tsx`**

```tsx
// src/components/dashboard/kpi/VelocityCard.tsx
'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeVelocityHeadline } from '@/components/dashboard/kpi/chart-headlines';
import { KpiSummary } from '@/components/dashboard/charts/KpiSummary';
import {
  VelocityChart,
  computeVelocitySummary,
  weekShortLabel,
} from '@/components/dashboard/charts/VelocityChart';

interface Props {
  reviewVelocity: DashboardDataActive['reviewVelocity'];
}

export function VelocityCard({ reviewVelocity }: Props) {
  const data = reviewVelocity.map((r, i) => ({
    label: weekShortLabel(r.weekStart, i, reviewVelocity.length),
    count: r.count,
  }));
  const headline = computeVelocityHeadline(reviewVelocity);
  const summary = computeVelocitySummary(data.map((d) => d.count));

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Review Velocity</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>
          last {data.length} weeks
        </span>
      </div>
      <ChartHeadlineBanner data={headline} />
      <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <KpiSummary label="This week" value={summary.lastWeek} delta={summary.deltaPct} />
        <KpiSummary label="Total · last weeks" value={summary.total} />
        <KpiSummary label="Weekly avg" value={summary.avg} />
      </div>
      <VelocityChart data={data} />
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `AggregateVelocityCard.tsx`**

Keep the card shell and Total/By-Location toggle exactly as they are (lines 23–67). Replace the local `VelocityChart`, `KpiSummary`, and `shortLabel` (delete them) and migrate `StackedVelocityChart` onto the contract:

```tsx
// src/components/dashboard/aggregate/AggregateVelocityCard.tsx
'use client';

import { useState } from 'react';
import { scaleBand, scaleLinear } from 'd3-scale';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import {
  CHART_AXIS_FILL,
  CHART_FONT_BODY,
  CHART_GRID_STROKE,
  RANKING_COLORS,
} from '@/components/dashboard/charts/chart-tokens';
import { KpiSummary } from '@/components/dashboard/charts/KpiSummary';
import { BAR_SPRING, BAR_STAGGER_S, chartTransition } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import {
  VelocityChart,
  computeVelocitySummary,
  weekShortLabel,
} from '@/components/dashboard/charts/VelocityChart';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

// One authoritative per-location palette, shared with AggregateRankingCard so a
// location is the same color in both aggregate charts. Multi-hue on purpose:
// here color encodes WHICH location, so a single sage would erase the signal
// (unlike the owner-facing single-location chart).
const STACK_COLORS = RANKING_COLORS;

const PAD = { l: 36, r: 16, t: 28, b: 32 };
const H = 220;

interface Props {
  reviewVelocity: AggregateDashboardData['reviewVelocity'];
  perLocationVelocity: AggregateDashboardData['perLocationVelocity'];
}

export function AggregateVelocityCard({ reviewVelocity, perLocationVelocity }: Props) {
  const [mode, setMode] = useState<'total' | 'stacked'>('total');

  const data = reviewVelocity.map((r, i) => ({
    label: weekShortLabel(r.weekStart, i, reviewVelocity.length),
    count: r.count,
  }));
  const summary = computeVelocitySummary(data.map((d) => d.count));

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Review Velocity</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>
          last {data.length} weeks
        </span>
      </div>

      {/* VAL-DASH-015: stacked-by-location toggle */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--rw-recess)', borderRadius: 9999, width: 'fit-content', marginBottom: 14 }}>
        <button
          type="button"
          className={`tab ${mode === 'total' ? 'active' : ''}`}
          onClick={() => setMode('total')}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          Total
        </button>
        <button
          type="button"
          className={`tab ${mode === 'stacked' ? 'active' : ''}`}
          onClick={() => setMode('stacked')}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          By Location
        </button>
      </div>

      {mode === 'total' ? (
        <>
          <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <KpiSummary label="This week" value={summary.lastWeek} delta={summary.deltaPct} />
            <KpiSummary label="Total · last weeks" value={summary.total} />
            <KpiSummary label="Weekly avg" value={summary.avg} />
          </div>
          <VelocityChart data={data} />
        </>
      ) : (
        <StackedVelocityChart perLocationVelocity={perLocationVelocity} />
      )}
    </div>
  );
}

function StackedVelocityChart({ perLocationVelocity }: { perLocationVelocity: AggregateDashboardData['perLocationVelocity'] }) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

  if (perLocationVelocity.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--rw-app-text-muted)' }}>No velocity data available</div>;
  }

  // Find all week keys across locations
  const weekSet = new Set<string>();
  for (const loc of perLocationVelocity) {
    for (const v of loc.velocity) {
      weekSet.add(v.weekStart);
    }
  }
  const weeks = Array.from(weekSet).sort();

  // Build stacked data per week
  const maxStack = weeks.reduce((max, week) => {
    const stack = perLocationVelocity.reduce((sum, loc) => {
      const v = loc.velocity.find((x) => x.weekStart === week);
      return sum + (v?.count ?? 0);
    }, 0);
    return Math.max(max, stack);
  }, 1);

  const innerH = H - PAD.t - PAD.b;
  const xBand = scaleBand<string>().domain(weeks).range([PAD.l, width - PAD.r]).paddingInner(0.4).paddingOuter(0.2);
  const barW = xBand.bandwidth();
  const yScale = scaleLinear().domain([0, maxStack]).range([PAD.t + innerH, PAD.t]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <LazyMotion features={domAnimation} strict>
        <svg viewBox={`0 0 ${width} ${H}`} className="chart-shell" style={{ height: H, display: 'block', overflow: 'visible' }}>
          {[0, Math.round(maxStack / 2), maxStack].map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={width - PAD.r} y1={yScale(t)} y2={yScale(t)} style={{ stroke: CHART_GRID_STROKE }} strokeWidth="1" />
              <text x={PAD.l - 8} y={yScale(t) + 3} textAnchor="end" fontSize="10" style={{ fill: CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}>
                {t}
              </text>
            </g>
          ))}

          {weeks.map((week, wi) => {
            const x = xBand(week) ?? PAD.l;
            let yOffset = 0;
            const segments = perLocationVelocity.flatMap((loc, li) => {
              const v = loc.velocity.find((entry) => entry.weekStart === week);
              const count = v?.count ?? 0;
              if (count <= 0) return [];
              const color = STACK_COLORS[li % STACK_COLORS.length]!;
              const h = (count / maxStack) * innerH;
              const y = PAD.t + innerH - yOffset - h;
              yOffset += h;
              return [{ color, y, h }];
            });

            return (
              <g key={week}>
                {segments.map((seg, si) => (
                  <m.rect
                    key={si}
                    x={x}
                    width={barW}
                    fill={seg.color}
                    opacity={0.85}
                    initial={reduced ? false : { y: PAD.t + innerH, height: 0 }}
                    animate={{ y: seg.y, height: seg.h }}
                    transition={chartTransition(reduced, BAR_SPRING, wi * BAR_STAGGER_S)}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </LazyMotion>

      {/* Legend */}
      <div className="chart-legend">
        {perLocationVelocity.map((loc, i) => (
          <span key={loc.locationId}>
            <span className="legend-dot" style={{ background: STACK_COLORS[i % STACK_COLORS.length] }} />
            {loc.displayName}
          </span>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run consumer suites + typecheck**

Run: `pnpm vitest run src/components/dashboard/aggregate/__tests__/AggregateDashboardContent.test.tsx src/components/dashboard/analytics/__tests__/AnalyticsContent.test.tsx src/components/__tests__/DashboardContent.test.tsx && pnpm typecheck`
Expected: PASS / exit 0. If a test asserts on removed internals (e.g. per-bar `onMouseEnter`), update the assertion to the new structure — behavior parity is bars/labels/legend rendering, not implementation details.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/kpi/VelocityCard.tsx src/components/dashboard/aggregate/AggregateVelocityCard.tsx
git commit -m "refactor: velocity cards adopt shared measured VelocityChart"
```

---

### Task 10: Migrate `RankingChart`

**Files:**
- Modify: `src/components/dashboard/kpi/RankingChart.tsx`
- Test: existing `RankingChart.test.ts` + `RankingChart.styling.test.tsx` must stay green; one new assertion added

- [ ] **Step 1: Add a failing contract assertion to `RankingChart.styling.test.tsx`**

Append inside the existing describe block:

```tsx
  it('never sets preserveAspectRatio (measured-viewBox contract)', () => {
    const { container } = render(<RankingChart series={series} />);
    const svg = container.querySelector('svg')!;
    expect(svg.hasAttribute('preserveAspectRatio')).toBe(false);
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 240'); // canonical width in jsdom
  });
```

Run: `pnpm vitest run src/components/dashboard/__tests__/RankingChart.styling.test.tsx`
Expected: new test FAILS (current: `preserveAspectRatio="none"`, viewBox `0 0 600 240`).

- [ ] **Step 2: Rewrite the chart internals**

Replace the body of `RankingChart.tsx` below the (unchanged) props interface and color constants:

```tsx
// src/components/dashboard/kpi/RankingChart.tsx
'use client';

import { scaleLinear, scalePoint } from 'd3-scale';
import { line as d3Line } from 'd3-shape';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { RankingChartSeries } from '@/components/dashboard/kpi/RankingChart.helpers';
import { chartTransition, LINE_REVEAL } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface RankingChartProps {
  series: RankingChartSeries[];
  formatSeriesLabel?: (keyword: string) => string;
  labelFontSize?: string;
  labelFontWeight?: string;
  /**
   * 'owner' (default): the owner-facing single-location view — the first
   * (primary) series is bold in --rw-sage-deep, the rest fade to
   * --rw-app-text-soft, so the line you care about reads at a glance instead of
   * competing in a 6-color rainbow. 'series': color per series (the aggregate
   * per-location view, where color distinguishes locations via the legend).
   */
  emphasis?: 'owner' | 'series';
}

const PAD = { l: 36, r: 80, t: 16, b: 28 };
const H = 240;

// Warm Editorial series colors for the owner-facing default. Concrete values
// (not var()) because they flow into inline `style` where they read fine, and
// stay literal for the gridline/axis which use CSS-class tokens below.
const OWNER_PRIMARY = 'var(--rw-sage-deep)';
const OWNER_FADED = 'var(--rw-app-text-soft)';

export function RankingChart({
  series,
  formatSeriesLabel = (keyword) => keyword,
  labelFontSize = '10',
  labelFontWeight = '600',
  emphasis = 'owner',
}: RankingChartProps) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

  // Build a union axis from every series' dates so sparse / mismatched
  // series still position points correctly. The axis is sorted ascending so
  // line paths render left-to-right by chronology, not by array order.
  const allDates = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.date)))).sort();
  const labelByDate = new Map<string, string>();
  for (const s of series) {
    for (const p of s.points) {
      if (!labelByDate.has(p.date)) labelByDate.set(p.date, p.label);
    }
  }

  const allPositions = series.flatMap((s) => s.points.map((p) => p.position));
  const minRank = 1;
  const maxRank = Math.max(...allPositions, 5);

  const x = scalePoint<string>().domain(allDates).range([PAD.l, width - PAD.r]);
  const xFor = (date: string) => x(date) ?? PAD.l;
  const y = scaleLinear().domain([minRank, maxRank]).range([PAD.t, H - PAD.b]);
  const yTicks = [1, Math.ceil((maxRank + 1) / 2), maxRank];

  // In owner mode the first series is the headline series (sage, bold); the
  // rest recede. In series mode every line keeps its own legend color.
  const colorFor = (s: RankingChartSeries, si: number) =>
    emphasis === 'series' ? s.color : si === 0 ? OWNER_PRIMARY : OWNER_FADED;
  const isFaded = (si: number) => emphasis === 'owner' && si > 0;

  return (
    <div ref={ref}>
      <LazyMotion features={domAnimation} strict>
        <svg viewBox={`0 0 ${width} ${H}`} className="chart-shell tall" style={{ height: H }}>
          {yTicks.map((t, i) => (
            <g key={i}>
              <line className="rank-grid" x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} strokeDasharray="3 3" />
              <text className="rank-axis" x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10">
                #{t}
              </text>
            </g>
          ))}
          {allDates.map((date) => (
            <text key={date} className="rank-axis" x={xFor(date)} y={H - 10} textAnchor="middle" fontSize="10">
              {labelByDate.get(date) ?? ''}
            </text>
          ))}
          {series.map((s, si) => {
            const sorted = s.points.toSorted((a, b) => a.date.localeCompare(b.date));
            const path =
              d3Line<(typeof sorted)[number]>()
                .x((p) => xFor(p.date))
                .y((p) => y(p.position))(sorted) ?? '';
            const last = sorted[sorted.length - 1];
            if (!last) return null;
            const color = colorFor(s, si);
            const faded = isFaded(si);
            return (
              <g key={`${s.keyword}-${si}`} style={{ opacity: faded ? 0.65 : 1 }}>
                <m.path
                  d={path}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ stroke: color, strokeWidth: faded ? 1.5 : 2.5 }}
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={chartTransition(reduced, LINE_REVEAL, si * 0.12)}
                />
                {sorted.map((p, pi) => (
                  <circle
                    key={`${si}-${pi}-${p.date}`}
                    cx={xFor(p.date)}
                    cy={y(p.position)}
                    r={faded ? 2.5 : 3}
                    style={{ fill: 'var(--rw-card)', stroke: color, strokeWidth: 2 }}
                  />
                ))}
                <text
                  x={xFor(last.date) + 8}
                  y={y(last.position) + 3}
                  fontSize={labelFontSize}
                  fontWeight={faded ? '500' : labelFontWeight}
                  style={{ fill: color, fontFamily: 'var(--rw-font-body)' }}
                >
                  {formatSeriesLabel(s.keyword)}
                </text>
              </g>
            );
          })}
        </svg>
      </LazyMotion>
    </div>
  );
}
```

Notes: lines stay straight (default `curveLinear`) — rank movements are discrete; smoothing would lie. A single-date axis is handled by `scalePoint` (centers the point) exactly like the old `Math.max(1, allDates.length - 1)` guard.

- [ ] **Step 3: Run both RankingChart suites**

Run: `pnpm vitest run src/components/dashboard/__tests__/RankingChart.test.ts src/components/dashboard/__tests__/RankingChart.styling.test.tsx`
Expected: PASS, including the new contract assertion (the styling tests query `path` elements and inline `style` stroke values — both preserved by `m.path`).

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/kpi/RankingChart.tsx src/components/dashboard/__tests__/RankingChart.styling.test.tsx
git commit -m "feat: RankingChart on measured d3 primitives with staggered line reveals"
```

---

### Task 11: Full gates, contract audit, and visual verification

**Files:** none created — verification only.

- [ ] **Step 1: Contract audit — no chart file owns its own observer or aspect hack**

Run: `rg -n "new ResizeObserver|preserveAspectRatio" src/components/dashboard --glob '!**/charts/useMeasuredSvg.ts'`
Expected: zero hits. Any hit is a contract violation — fix it before proceeding.

- [ ] **Step 2: Full test suite, lint, typecheck**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all pass. (No DB surface touched — tenant-scope/RLS audits run in lint's `ci:*` set as usual and are unaffected.)

- [ ] **Step 3: Visual verification at three widths (the original bug repro)**

Run: `pnpm dev`, open the dashboard analytics view (charts live in AnalyticsPerLocationView / AnalyticsAggregateView), and check at ~360 px, ~800 px, and ~1700 px viewport widths:
- Reputation trend: line + dot crisp, dot perfectly round at every width (was: stretched ellipse).
- Review Velocity: bars fill the card width at every size (was: small chart letterboxed in a big box).
- Ranking chart: lines/labels undistorted.
- Hover: crosshair + dark-pill tooltip track the nearest datum; tooltip clamps at card edges.
- Reveals: line draws in, bars stagger up; with OS "reduce motion" enabled everything renders instantly finished.

If no data renders locally, set `MOCK_EXTERNAL_APIS=true` in `.env.local` per CLAUDE.md.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/dashboard-chart-primitives
gh pr create --title "feat: dashboard charts on headless d3 primitives + measured-viewBox contract" --body "$(cat <<'EOF'
## Summary
- Fixes the chart stretch/letterbox bug class at the root: new `useMeasuredSvg` contract keeps every chart viewBox equal to rendered pixels
- Replaces hand-rolled chart math with d3-scale/d3-shape (only new deps, ~10 KB gz, pure math)
- Adds motion: line-draw reveals, staggered bar entrances, springy hover crosshair + shared tooltip (reduced-motion collapses to instant)
- Single owners: chart styling tokens in `charts/chart-tokens.ts` (RANKING_COLORS moved), velocity chart + KPI row deduped out of the two velocity cards

Spec: docs/superpowers/specs/2026-07-22-dashboard-chart-primitives-design.md

## Test plan
- [ ] New unit suites: useMeasuredSvg, useNearestDatum, motion-presets, ChartTooltip, VelocityChart
- [ ] Existing chart suites green (ReputationTrendChart, RankingChart ×2, DashboardContent, AggregateDashboardContent)
- [ ] Visual check at 360/800/1700 px: no distortion, no letterboxing, hover + reveals work, reduced-motion instant

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013RePwp6impN1ZoRcRTg4i9
EOF
)"
```

Expected: PR opens; the 4 CI checks (lint, typecheck, test, build) must go green before merge.
