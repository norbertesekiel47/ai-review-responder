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
