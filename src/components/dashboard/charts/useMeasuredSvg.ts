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
