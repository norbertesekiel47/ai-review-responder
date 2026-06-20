'use client';

import { useEffect, useRef, useState } from 'react';
import { useCountUp } from '@/hooks/useCountUp';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/ui/cn';

// Static frame shown under reduced motion — mid-afternoon, when both review and
// owner-reply layers are populated, so the still image still reads as the insight.
const REDUCED_MOTION_HOUR = 14.5;

const CLOCK_REVIEWS = [
  { h: 7.5, stars: 5 },
  { h: 9.2, stars: 4 },
  { h: 10.8, stars: 5 },
  { h: 12.1, stars: 3 },
  { h: 13.4, stars: 5 },
  { h: 15.6, stars: 5 },
  { h: 16.9, stars: 4 },
  { h: 18.2, stars: 5 },
  { h: 19.7, stars: 2 },
  { h: 21.3, stars: 5 },
  { h: 22.6, stars: 4 },
  { h: 23.8, stars: 5 },
  { h: 0.7, stars: 1 },
  { h: 2.4, stars: 5 },
];

const ang = (h: number) => (h / 24) * Math.PI * 2 - Math.PI / 2;

// Polar→cartesian projection onto the clock face, and elapsed-hours-since
// helpers. They close over the face center / current time in HourClock, so the
// SVG sub-layers below receive them as props rather than recomputing geometry.
type PointAt = (h: number, r: number) => { x: number; y: number };
type HoursSince = (h: number) => number;

function ClockTicks({ c, rOuter }: { c: number; rOuter: number }) {
  return (
    <>
      {Array.from({ length: 24 }).map((_, i) => {
        const a = ang(i);
        const major = i % 6 === 0;
        const x1 = c + Math.cos(a) * (rOuter - 4);
        const y1 = c + Math.sin(a) * (rOuter - 4);
        const x2 = c + Math.cos(a) * (rOuter - (major ? 16 : 8));
        const y2 = c + Math.sin(a) * (rOuter - (major ? 16 : 8));
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="rgba(42,42,42,0.35)"
            strokeWidth={major ? 1.8 : 0.7}
            strokeLinecap="round"
          />
        );
      })}
    </>
  );
}

function ClockHourLabels({ pt, rOuter }: { pt: PointAt; rOuter: number }) {
  return (
    <>
      {[0, 6, 12, 18].map((h) => {
        const p = pt(h, rOuter - 30);
        return (
          <text
            key={h}
            x={p.x}
            y={p.y + 4}
            textAnchor="middle"
            style={{ font: '600 10px/1 var(--rw-font-body)', fill: '#6a6a6a', letterSpacing: '0.08em', textTransform: 'uppercase' }}
          >
            {h === 0 ? '12A' : h === 12 ? '12P' : h > 12 ? `${h - 12}P` : `${h}A`}
          </text>
        );
      })}
    </>
  );
}

function OwnerReplyDots({ pt, since, rOwn }: { pt: PointAt; since: HoursSince; rOwn: number }) {
  return (
    <>
      {/* Owner reply dots — pile up at 9-10am */}
      {CLOCK_REVIEWS.map((r, i) => {
        if (r.h >= 9 && r.h <= 17) return null;
        const rh = 9 + i * 0.2;
        const p = pt(rh, rOwn);
        const s = since(r.h);
        const ownerDelay = 10;
        let opacity = 0;
        if (s > ownerDelay) opacity = Math.min(0.95, (s - ownerDelay) / 2);
        return (
          <circle
            key={`own${i}`}
            cx={p.x}
            cy={p.y}
            r={3.5}
            fill="#D6CBBF"
            opacity={opacity}
            style={{ transition: 'opacity 600ms ease-out' }}
          />
        );
      })}
    </>
  );
}

function ReviewTendrils({ pt, since, rRev, rRep }: { pt: PointAt; since: HoursSince; rRev: number; rRep: number }) {
  return (
    <>
      {/* Per-review clock-mark geometry; branches are independent visual cases. */}
      {/* fallow-ignore-next-line complexity */}
      {CLOCK_REVIEWS.map((r, i) => {
        const s = since(r.h);
        const reviewActive = s < 24;
        const reviewScale = s < 0.4 ? s / 0.4 : 1;
        const replyS = since(r.h + 0.15);
        const replyScale = replyS < 0.4 ? replyS / 0.4 : 1;
        const rp = pt(r.h, rRev);
        const rep = pt(r.h + 0.15, rRep);
        const tendrilAlpha = Math.max(0.15, 1 - s / 3);
        const rippleT = replyS / 0.6;
        const showRipple = rippleT >= 0 && rippleT < 1;

        return (
          <g key={i}>
            {reviewActive && (
              <line
                x1={rp.x}
                y1={rp.y}
                x2={rep.x}
                y2={rep.y}
                stroke="#97B3AE"
                strokeWidth={1.2}
                strokeLinecap="round"
                opacity={tendrilAlpha}
              />
            )}
            {showRipple && (
              <circle
                cx={rep.x}
                cy={rep.y}
                r={4 + rippleT * 18}
                fill="none"
                stroke="#97B3AE"
                strokeWidth={1.5}
                opacity={(1 - rippleT) * 0.7}
              />
            )}
            {replyS >= 0 && replyS < 24 && (
              <circle
                cx={rep.x}
                cy={rep.y}
                r={4.2 * replyScale}
                fill="#97B3AE"
                style={{ filter: showRipple ? 'drop-shadow(0 0 6px rgba(151,179,174,0.9))' : 'none' }}
              />
            )}
            {s < 0.5 && s >= 0 && (
              <circle
                cx={rp.x}
                cy={rp.y}
                r={4 + (1 - s / 0.5) * 14}
                fill="none"
                stroke="#2a2a2a"
                strokeWidth={1}
                opacity={(1 - s / 0.5) * 0.6}
              />
            )}
            {reviewActive && (
              <circle
                cx={rp.x}
                cy={rp.y}
                r={4.5 * reviewScale}
                fill={r.stars <= 2 ? '#D97757' : '#2a2a2a'}
                opacity={0.85}
              />
            )}
          </g>
        );
      })}
    </>
  );
}

function HourClock({ speed = 1.5 }: { speed?: number }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [animatedNow, setAnimatedNow] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    // Reduced motion: skip the rAF clock entirely; `now` is frozen on a static
    // representative frame via the pure derivation below (no setState here).
    if (prefersReducedMotion) return;
    const period = 18000 / Math.max(0.1, speed);
    const tick = (t: number) => {
      if (startRef.current == null) startRef.current = t;
      const elapsed = (t - startRef.current) % period;
      setAnimatedNow((elapsed / period) * 24);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [speed, prefersReducedMotion]);

  const now = prefersReducedMotion ? REDUCED_MOTION_HOUR : animatedNow;

  const size = 380;
  const c = size / 2;
  const rOuter = c - 14;
  const rRev = c - 48;
  const rRep = c - 88;
  const rOwn = c - 128;

  const pt = (h: number, r: number) => ({
    x: c + Math.cos(ang(h)) * r,
    y: c + Math.sin(ang(h)) * r,
  });

  const since = (h: number) => {
    let d = now - h;
    if (d < 0) d += 24;
    return d;
  };

  const handP = pt(now, rOuter - 6);
  const handTailP = pt(now + 12, 20);

  const periodLabel =
    Math.floor(now) < 6 || Math.floor(now) >= 22
      ? 'OVERNIGHT'
      : Math.floor(now) < 12
        ? 'MORNING'
        : Math.floor(now) < 18
          ? 'AFTERNOON'
          : 'EVENING';

  const hh = Math.floor(now);
  const mm = Math.floor((now - hh) * 60);
  const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const timeLabel = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;

  return (
    <div className="rw-clock-wrap">
      <svg
        className="rw-clock-svg"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="A 24-hour clock showing reviews arriving around the clock — including late at night and at lunchtime — each answered by RepWorth within minutes, while an unaided owner only replies the next morning."
      >
        <defs>
          <radialGradient id="rw-face" cx="50%" cy="42%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="70%" stopColor="#F7F5F1" />
            <stop offset="100%" stopColor="#ECE7DF" />
          </radialGradient>
          <linearGradient id="rw-handgrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#97B3AE" stopOpacity="0" />
            <stop offset="60%" stopColor="#97B3AE" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#97B3AE" stopOpacity="1" />
          </linearGradient>
          <radialGradient id="rw-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#97B3AE" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#97B3AE" stopOpacity="0" />
          </radialGradient>
          <filter id="rw-soft">
            <feGaussianBlur stdDeviation="2" />
          </filter>
          <filter id="rw-strong">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        <circle cx={c} cy={c} r={rOuter + 10} fill="url(#rw-glow)" filter="url(#rw-strong)" opacity={0.6} />
        <circle cx={c} cy={c} r={rOuter} fill="url(#rw-face)" stroke="rgba(151,179,174,0.18)" strokeWidth={1} />

        {/* Night arc */}
        <path
          d={(() => {
            const p1 = pt(22, rOuter - 2);
            const p2 = pt(6, rOuter - 2);
            const p3 = pt(6, rOuter - 34);
            const p4 = pt(22, rOuter - 34);
            return `M ${p1.x} ${p1.y} A ${rOuter - 2} ${rOuter - 2} 0 0 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rOuter - 34} ${rOuter - 34} 0 0 0 ${p4.x} ${p4.y} Z`;
          })()}
          fill="rgba(106, 95, 110, 0.08)"
        />
        {/* Day arc */}
        <path
          d={(() => {
            const p1 = pt(6, rOuter - 2);
            const p2 = pt(18, rOuter - 2);
            const p3 = pt(18, rOuter - 34);
            const p4 = pt(6, rOuter - 34);
            return `M ${p1.x} ${p1.y} A ${rOuter - 2} ${rOuter - 2} 0 0 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${rOuter - 34} ${rOuter - 34} 0 0 0 ${p4.x} ${p4.y} Z`;
          })()}
          fill="rgba(242, 195, 185, 0.13)"
        />

        <ClockTicks c={c} rOuter={rOuter} />

        <ClockHourLabels pt={pt} rOuter={rOuter} />

        <circle cx={c} cy={c} r={rRep} fill="none" stroke="rgba(151,179,174,0.35)" strokeWidth={1} strokeDasharray="2 5" />
        <circle cx={c} cy={c} r={rOwn} fill="none" stroke="rgba(214,203,191,0.45)" strokeWidth={1} />
        <circle cx={c} cy={c} r={rRev} fill="none" stroke="rgba(42,42,42,0.06)" strokeWidth={1} />

        <path
          d={(() => {
            const p1 = pt(now - 6, rOuter - 4);
            const p2 = pt(now, rOuter - 4);
            return `M ${p1.x} ${p1.y} A ${rOuter - 4} ${rOuter - 4} 0 0 1 ${p2.x} ${p2.y}`;
          })()}
          fill="none"
          stroke="url(#rw-handgrad)"
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.9}
        />

        <OwnerReplyDots pt={pt} since={since} rOwn={rOwn} />

        <ReviewTendrils pt={pt} since={since} rRev={rRev} rRep={rRep} />

        <g>
          <circle cx={handP.x} cy={handP.y} r={8} fill="#97B3AE" opacity={0.35} filter="url(#rw-soft)" />
          <line
            x1={handTailP.x}
            y1={handTailP.y}
            x2={handP.x}
            y2={handP.y}
            stroke="url(#rw-handgrad)"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <circle cx={handP.x} cy={handP.y} r={3.5} fill="#2a2a2a" />
        </g>

        <circle cx={c} cy={c} r={26} fill="white" stroke="rgba(151,179,174,0.2)" strokeWidth={1} />
        <circle cx={c} cy={c} r={4} fill="#2a2a2a" />

        <text
          x={c}
          y={c - 38}
          textAnchor="middle"
          style={{ font: '500 9px/1 var(--rw-font-body)', fill: '#557069', letterSpacing: '0.14em', textTransform: 'uppercase' }}
        >
          {periodLabel}
        </text>
        <text
          x={c}
          y={c + 52}
          textAnchor="middle"
          style={{
            font: '600 15px/1 var(--rw-font-display)',
            fill: '#2a2a2a',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {timeLabel}
        </text>
      </svg>

      <div className="rw-clock-legend">
        <div className="item">
          <span className="rw-cl-dot" style={{ background: '#2a2a2a' }} />
          Review arrives
        </div>
        <div className="item">
          <span className="rw-cl-dot pulse" style={{ background: '#97B3AE' }} />
          RepWorth, 8 min later
        </div>
        <div className="item">
          <span className="rw-cl-dot" style={{ background: '#D6CBBF' }} />
          Owner, next morning
        </div>
      </div>
    </div>
  );
}

function TimelineStats() {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (!ref.current || seen) return;
    const r = ref.current.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setSeen(true)),
      { threshold: 0.25 }
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);

  const mult = useCountUp(143, { active: seen, duration: 1800 });
  const rep = useCountUp(8, { active: seen, duration: 1100 });
  const owner = useCountUp(19, { active: seen, duration: 1500 });

  return (
    <div ref={ref} className={cn('rw-tl-verdict', seen && 'in')}>
      <div className="rw-tl-v-compare">
        <div className="rw-tl-v-line">
          <div className="rw-tl-v-bar">
            <span className="rw-tl-v-bar-fill" style={{ width: seen ? '6%' : '0%' }} />
          </div>
          <div className="rw-tl-v-meta">
            <div className="rw-tl-v-meta-lbl">RepWorth</div>
            <div className="rw-tl-v-meta-val">
              <b>{Math.round(rep)}</b>
              <span>min</span>
            </div>
          </div>
        </div>
        <div className="rw-tl-v-line">
          <div className="rw-tl-v-bar">
            <span className="rw-tl-v-bar-fill owner" style={{ width: seen ? '100%' : '0%' }} />
          </div>
          <div className="rw-tl-v-meta">
            <div className="rw-tl-v-meta-lbl">Owner, unaided</div>
            <div className="rw-tl-v-meta-val">
              <b>{Math.round(owner)}</b>
              <span>hrs</span>
            </div>
          </div>
        </div>
      </div>
      <div className="rw-tl-v-tag">
        <span className="rw-tl-v-tag-num">{Math.round(mult)}×</span>
        <span className="rw-tl-v-tag-lbl">faster to the customer</span>
      </div>
    </div>
  );
}

export function TimelineSection() {
  return (
    <section className="rw-timeline-section" id="rw-timeline">
      <div className="rw-sec-inner" style={{ maxWidth: 1000 }}>
        <div className="rw-timeline-grid">
          <div className="rw-timeline-text">
            <div className="rw-eyebrow">Instant responses</div>
            <h2>Reviews arrive at 11pm. Yours reply almost instantly.</h2>
            <p>
              Most negative reviews are written late at night or at lunchtime, the
              exact moments you&apos;re not at your desk. RepWorth drafts immediately
              and sends you a one-tap approval. Your reply lands in minutes,
              not tomorrow morning.
            </p>
            <TimelineStats />
          </div>
          <HourClock />
        </div>
      </div>
    </section>
  );
}
