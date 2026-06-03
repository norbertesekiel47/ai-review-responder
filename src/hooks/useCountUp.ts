'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Animates a number from 0 to `target` over `duration` ms using a cubic
 * ease-out curve. Returns the current value on each rAF tick.
 */
export function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    startRef.current = null;
    const step = (t: number) => {
      if (startRef.current == null) startRef.current = t;
      const progress = Math.min(1, (t - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
