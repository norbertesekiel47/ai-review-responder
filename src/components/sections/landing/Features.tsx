'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

function VoiceWaveVis() {
  const bars = Array.from({ length: 22 });
  return (
    <svg viewBox="0 0 160 90" aria-hidden>
      <defs>
        <linearGradient id="rw-vwg" x1="0" x2="1">
          <stop offset="0" stopColor="var(--card-accent)" stopOpacity="0.35" />
          <stop offset="0.55" stopColor="var(--card-accent)" stopOpacity="1" />
          <stop offset="1" stopColor="var(--card-accent)" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <g>
        {bars.map((_, i) => {
          const x = 14 + i * 6;
          return (
            <rect
              key={i}
              className="rw-vv-bar"
              x={x}
              width={3}
              rx={1.5}
              y={45}
              height={6}
              fill="url(#rw-vwg)"
              style={{ ['--bi' as string]: i }}
            />
          );
        })}
      </g>
      <g className="rw-vv-bubble">
        <rect x="34" y="22" width="92" height="46" rx="14" fill="white" stroke="rgba(58,74,72,0.12)" />
        <rect x="44" y="34" width="58" height="3" rx="1.5" fill="rgba(58,74,72,0.5)" />
        <rect x="44" y="44" width="72" height="3" rx="1.5" fill="rgba(58,74,72,0.3)" />
        <rect x="44" y="54" width="40" height="3" rx="1.5" fill="rgba(58,74,72,0.3)" />
      </g>
    </svg>
  );
}

function TapApproveVis() {
  return (
    <svg viewBox="0 0 160 90" aria-hidden>
      <g>
        <g>
          <rect x="12" y="32" width="58" height="28" rx="8" fill="var(--rw-ink)" />
          <text x="41" y="50" textAnchor="middle" fontSize="10" fill="white" fontFamily="DM Sans, sans-serif" fontWeight="600">
            Approve
          </text>
        </g>
        <g>
          <rect x="76" y="32" width="36" height="28" rx="8" fill="white" stroke="rgba(58,74,72,0.18)" />
          <text x="94" y="50" textAnchor="middle" fontSize="10" fill="var(--rw-ink-soft)" fontFamily="DM Sans, sans-serif" fontWeight="500">
            Edit
          </text>
        </g>
        <g>
          <rect x="118" y="32" width="32" height="28" rx="8" fill="white" stroke="rgba(58,74,72,0.18)" />
          <g
            transform="translate(134 46)"
            stroke="var(--rw-ink-soft)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <path d="M -5.2 -1.4 A 5.2 5.2 0 1 1 -4.6 2.8" />
            <path d="M -5.4 -4.2 L -5.2 -1.4 L -2.4 -1.6" />
          </g>
        </g>
        <g className="rw-ta-tap">
          <circle cx="41" cy="46" r="18" fill="none" stroke="var(--card-accent)" strokeWidth="1.5" />
          <circle cx="41" cy="46" r="3" fill="var(--card-accent)" />
        </g>
      </g>
      <path
        className="rw-ta-check"
        d="M30 46 l7 7 15 -18"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BrandRingsVis() {
  return (
    <svg viewBox="0 0 160 90" aria-hidden>
      <g transform="translate(80 45)">
        <circle r="32" fill="none" stroke="var(--card-accent)" strokeOpacity="0.35" strokeWidth="1" className="rw-br-r1" />
        <circle r="22" fill="none" stroke="var(--card-accent)" strokeOpacity="0.55" strokeWidth="1.2" className="rw-br-r2" />
        <circle r="12" fill="var(--card-accent)" fillOpacity="0.18" stroke="var(--card-accent)" strokeWidth="1.2" className="rw-br-r3" />
        <g className="rw-br-marks">
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const a = (i / 6) * Math.PI * 2;
            return (
              <circle
                key={i}
                cx={Math.cos(a) * 32}
                cy={Math.sin(a) * 32}
                r="1.6"
                fill="var(--card-accent)"
              />
            );
          })}
        </g>
        <path
          d="M-4 0 l3 3 l6 -7"
          fill="none"
          stroke="var(--card-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="rw-br-check"
        />
      </g>
    </svg>
  );
}

const CARDS = [
  {
    eyebrow: '01 · Voice',
    title: 'Your voice, automated',
    desc: 'Trained on your best replies. The longer you use it, the more it sounds like you.',
    accent: '#97B3AE',
    wash: 'rgba(151,179,174,0.10)',
    Vis: VoiceWaveVis,
  },
  {
    eyebrow: '02 · Speed',
    title: 'Approve in one tap',
    desc: 'The email arrives with three buttons. Approve, edit, regenerate. Thirty seconds.',
    accent: '#E8A394',
    wash: 'rgba(242,195,185,0.12)',
    Vis: TapApproveVis,
  },
  {
    eyebrow: '03 · Consistency',
    title: 'Always on brand',
    desc: 'Consistent tone, consistent values, across every customer, every hour of the day.',
    accent: '#B8A995',
    wash: 'rgba(214,203,191,0.22)',
    Vis: BrandRingsVis,
  },
];

export function Features() {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (!ref.current || seen) return;
    const r = ref.current.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setSeen(true);
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -10% 0px' }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);

  return (
    <section className="rw-features" id="rw-features" ref={ref}>
      <div className={`rw-features-head ${seen ? 'in' : ''}`}>
        <div className="rw-eyebrow">Save 15 hours every week</div>
        <h2>
          Small things, done automatically, <span className="rw-f-accent">for every customer.</span>
        </h2>
        <p>
          RepWorth handles the part of running a business that&apos;s meaningful but
          never urgent — until it&apos;s too late to matter.
        </p>
      </div>
      <div className={`rw-features-grid ${seen ? 'in' : ''}`}>
        {CARDS.map((c, i) => (
          <article
            key={c.title}
            className="rw-feat-card"
            style={
              {
                '--card-accent': c.accent,
                '--card-wash': c.wash,
                '--card-delay': `${i * 140}ms`,
              } as CSSProperties
            }
          >
            <div className="rw-feat-vis-wrap">
              <div className="rw-feat-vis-bg" aria-hidden />
              <div className="rw-feat-vis">
                <c.Vis />
              </div>
            </div>
            <div className="rw-feat-eyebrow">{c.eyebrow}</div>
            <h3>{c.title}</h3>
            <p>{c.desc}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
