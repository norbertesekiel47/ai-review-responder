'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

function useInView(ref: RefObject<HTMLElement | null>, threshold = 0.05) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!ref.current || seen) return;
    const markSeen = () => setSeen(true);
    // IntersectionObserver delivers an initial callback for an already-visible
    // element on observe(), so no synchronous getBoundingClientRect check is
    // needed (which would adjust state purely from the ref/threshold deps).
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) markSeen();
        });
      },
      { threshold, rootMargin: '0px 0px -10% 0px' }
    );
    io.observe(ref.current);
    const t = setTimeout(() => markSeen(), 3000);
    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, [ref, threshold, seen]);
  return seen;
}

function HoursBars({ active }: { active: boolean }) {
  const seed = [38, 42, 51, 47, 58, 63, 71, 68, 79, 86, 92, 100];
  return (
    <svg viewBox="0 0 120 36" width="120" height="36" aria-hidden="true">
      {seed.map((h, i) => (
        <rect
          key={i}
          x={i * 10 + 1}
          y={36 - (active ? h * 0.32 : 0)}
          width={7}
          height={active ? h * 0.32 : 0}
          rx={1.5}
          fill={i === seed.length - 1 ? 'var(--rw-teal)' : 'rgba(58,74,72,0.35)'}
          style={{
            transition: `y 900ms cubic-bezier(.2,.7,.2,1) ${i * 60}ms, height 900ms cubic-bezier(.2,.7,.2,1) ${i * 60}ms`,
          }}
        />
      ))}
    </svg>
  );
}

function PulseRing({ active }: { active: boolean }) {
  return (
    <div className={`rw-tk-pulse ${active ? 'on' : ''}`} aria-hidden="true">
      <span className="p1" />
      <span className="p2" />
      <span className="p3" />
      <svg viewBox="0 0 24 24" width="14" height="14">
        <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" fill="var(--rw-teal)" />
      </svg>
    </div>
  );
}

function ApprovalArc({ active, pct = 96 }: { active: boolean; pct?: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const offset = active ? c * (1 - pct / 100) : c;
  return (
    <svg viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(58,74,72,0.12)" strokeWidth="3" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke="#E8A394"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 20 20)"
        style={{ transition: 'stroke-dashoffset 950ms cubic-bezier(.2,.7,.2,1) 200ms' }}
      />
    </svg>
  );
}

function BizOrbit({ active }: { active: boolean }) {
  const dots = Array.from({ length: 14 });
  return (
    <svg className={`rw-tk-orbit ${active ? 'on' : ''}`} viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
      <circle cx="22" cy="22" r="16" fill="none" stroke="rgba(58,74,72,0.12)" strokeDasharray="1.5 2.5" />
      <circle cx="22" cy="22" r="3" fill="var(--rw-sage)" />
      <g className="rw-tk-orbit-ring">
        {dots.map((_, i) => {
          const a = (i / dots.length) * Math.PI * 2;
          return (
            <circle
              key={i}
              cx={22 + Math.cos(a) * 16}
              cy={22 + Math.sin(a) * 16}
              r={i % 3 === 0 ? 1.8 : 1.2}
              fill={i % 4 === 0 ? '#E8A394' : 'var(--rw-ink)'}
              opacity={0.55 + (i % 3) * 0.15}
            />
          );
        })}
      </g>
    </svg>
  );
}

// Illustrative "what RepWorth does" tiles. These describe how the product is
// designed to work — not live, fabricated aggregate counts. The eyebrow labels
// each as an example so nothing reads as the visitor's real account data.
const ITEMS = [
  {
    tone: 'teal' as const,
    vis: (active: boolean) => <HoursBars active={active} />,
    headline: 'About 15 hours a week',
    lbl: 'The review work RepWorth takes off your plate',
  },
  {
    tone: 'sage' as const,
    vis: (active: boolean) => <PulseRing active={active} />,
    headline: 'Minutes, not days',
    lbl: 'From new review to a draft waiting for your approval',
  },
  {
    tone: 'peach' as const,
    vis: (active: boolean) => <ApprovalArc active={active} pct={96} />,
    headline: 'One tap to approve',
    lbl: 'Drafts arrive in your voice, ready to post',
  },
  {
    tone: 'beige' as const,
    vis: (active: boolean) => <BizOrbit active={active} />,
    headline: 'Every review covered',
    lbl: 'Across every location, every hour of the day',
  },
];

export function TickerBar() {
  const barRef = useRef<HTMLDivElement>(null);
  const seen = useInView(barRef);

  return (
    <div className={`rw-ticker-bar ${seen ? 'in' : ''}`} ref={barRef}>
      <p
        className="rw-tk-lbl"
        style={{
          gridColumn: '1 / -1',
          margin: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 500,
        }}
      >
        How RepWorth works — an illustration, not live account data
      </p>
      {ITEMS.map((it, i) => (
        <div
          key={it.tone}
          className={`rw-tk-tile tone-${it.tone}`}
          style={{ transitionDelay: `${i * 90}ms` }}
        >
          <div className="rw-tk-vis-wrap">{it.vis(seen)}</div>
          <div className="rw-tk-body">
            <div className="rw-tk-num" style={{ fontSize: 20 }}>{it.headline}</div>
            <div className="rw-tk-lbl">{it.lbl}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
