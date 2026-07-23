'use client';

import {
  LazyMotion,
  domAnimation,
  m,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/ui/cn';

/**
 * 3D tilt-on-hover card (vendored from the be-ui kit).
 *
 * Adapted to the RepWorth codebase: reuses the app's `cn` (so no clsx /
 * tailwind-merge dependency), and the cursor "glare" uses the brand
 * `--rw-teal-strong` token instead of the kit's shadcn `--foreground`. The
 * tilt is disabled for reduced-motion and on non-hover/coarse-pointer devices,
 * so touch users get a plain static card.
 */

const SPRING_MOUSE = {
  stiffness: 200,
  damping: 15,
  mass: 0.3,
} as const;

function useHoverCapable() {
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setCanHover(mq.matches);

    update();
    mq.addEventListener?.('change', update);

    return () => mq.removeEventListener?.('change', update);
  }, []);

  return canHover;
}

export interface TiltCardProps {
  children: ReactNode;
  max?: number;
  glare?: boolean;
  className?: string;
}

export function TiltCard({ children, max = 12, glare = true, className }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  const enabled = !reduce && canHover;

  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const gx = useMotionValue(50);
  const gy = useMotionValue(50);

  const srx = useSpring(rx, SPRING_MOUSE);
  const sry = useSpring(ry, SPRING_MOUSE);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;

    if (!el || !enabled) return;

    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;

    ry.set((px - 0.5) * max);
    rx.set((0.5 - py) * max);
    gx.set(px * 100);
    gy.set(py * 100);
  };

  const onLeave = () => {
    rx.set(0);
    ry.set(0);
  };

  const transform = useMotionTemplate`perspective(1000px) rotateX(${srx}deg) rotateY(${sry}deg)`;
  const glareBg = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, var(--rw-teal-strong), transparent 50%)`;

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        // NOTE: no `transform-style: preserve-3d`. The card content is a flat
        // plane (no nested 3D layers), so the perspective tilt looks identical
        // without it; and `preserve-3d` puts the element in a 3D rendering
        // context, which disables `backdrop-filter` (used for the glass card).
        style={{ transform }}
        className={cn('relative overflow-hidden rounded-2xl will-change-transform', className)}
      >
        {children}

        {glare && enabled ? (
          <m.div
            aria-hidden
            style={{ background: glareBg }}
            className="pointer-events-none absolute inset-0 opacity-15"
          />
        ) : null}
      </m.div>
    </LazyMotion>
  );
}
