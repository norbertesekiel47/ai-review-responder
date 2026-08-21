'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface StatDef {
  bar: string;
  /** Rendered number parts: count targets with optional prefix/join. */
  counts: readonly number[];
  prefix?: string;
  join?: string;
  unit: string;
  desc: string;
}

// Illustrative figures — the band's fine print labels them as such.
const STATS: readonly StatDef[] = [
  { bar: 'var(--rw-sage-bar)', counts: [5], prefix: '~', unit: 'min', desc: 'backup check behind the instant alert' },
  { bar: 'var(--rw-mist-bar)', counts: [30], unit: 'sec', desc: 'your time per reply on Copilot' },
  { bar: 'var(--rw-blush-bar)', counts: [15, 30], join: '/', unit: 'min', desc: 'veto window on Autopilot' },
  { bar: 'var(--rw-gold-bar)', counts: [100], unit: '%', desc: 'of auto-posts reviewed by the Judge' },
];

const COUNT_DURATION_MS = 1400;
const STAGGER_MS = 280;

function useCountTo(target: number, active: boolean, reduced: boolean): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    // Reduced motion renders the target directly (the return below), so the
    // effect only ever drives the animated path.
    if (!active || reduced) return;
    let raf = 0;
    let t0: number | null = null;
    const step = (ts: number) => {
      if (t0 === null) t0 = ts;
      const linear = Math.min(1, (ts - t0) / COUNT_DURATION_MS);
      const eased = 1 - (1 - linear) ** 3;
      setValue(Math.round(target * eased));
      if (linear < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active, reduced, target]);
  return reduced ? target : value;
}

function StatNumber({ stat, active, reduced }: { stat: StatDef; active: boolean; reduced: boolean }) {
  const first = useCountTo(stat.counts[0] ?? 0, active, reduced);
  const second = useCountTo(stat.counts[1] ?? 0, active, reduced);
  return (
    <div className="hiw-stat-n">
      <span>
        {stat.prefix}
        {first}
      </span>
      {stat.counts.length > 1 && (
        <>
          {stat.join}
          <span>{second}</span>
        </>
      )}
      <small>{stat.unit}</small>
    </div>
  );
}

/**
 * The four hero stat cards: left colour bar wipes in, cards stagger
 * left → right, numbers count up (Daylight Gallery II). Reduced motion:
 * final frame immediately.
 */
export function StatCards() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '-60px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    // Reduced motion derives the final frame at render time (effectiveActive),
    // so the effect only ever drives the staggered path.
    if (!seen || prefersReducedMotion) return;
    const timers = STATS.map((_, i) =>
      window.setTimeout(() => setActiveCount((count) => Math.max(count, i + 1)), i * STAGGER_MS)
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [prefersReducedMotion, seen]);

  const effectiveActive = prefersReducedMotion && seen ? STATS.length : activeCount;

  return (
    <div className="hiw-stats" ref={rootRef}>
      {STATS.map((stat, i) => (
        <div
          key={stat.desc}
          className={`hiw-stat ${i < effectiveActive ? 'is-in' : ''}`}
          style={{ ['--bar' as string]: stat.bar }}
        >
          <StatNumber stat={stat} active={i < effectiveActive} reduced={prefersReducedMotion} />
          <div className="hiw-stat-d">{stat.desc}</div>
        </div>
      ))}
    </div>
  );
}
