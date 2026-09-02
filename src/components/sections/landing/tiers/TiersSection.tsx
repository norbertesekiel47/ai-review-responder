'use client';

import Link from 'next/link';
import { m, useSpring, useTransform } from 'motion/react';
import { useEffect, useId, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { MARKETING_LINKS } from '@/components/ui/marketing-links';
import { Staged } from '../staged';
import {
  EYEBROW,
  GOVERNOR_NOTE,
  HEADING_ACCENT,
  HEADING_LEAD,
  HEADING_PLAIN,
  LEAD_IN,
  MOVEMENT_NOTE,
  PRICING_LINK_LABEL,
  TIERS,
} from './tiers-copy';

/**
 * Copilot vs Autopilot — the circular dial (v4, owner-directed 2026-08-24).
 *
 * v1 (floating gauge + cards) read as decoration; v2 (static hairline track)
 * under-sold the metaphor; v3 (straight interactive track) worked but the
 * owner preferred the round instrument. v4 is a semicircular gauge: a
 * machined arc with detents, a gold needle, and a fill that measures how much
 * autonomy has been granted. The two mode names are buttons flanking the
 * instrument — pressing one swings the needle to that side, and the mode
 * texts shift emphasis with it. The copy's own instruction — "Move the dial
 * when you are ready — and back, any time" — is something the visitor does.
 *
 * ── Semantics ─────────────────────────────────────────────────────────────
 * Two toggle buttons with `aria-pressed`, not a slider: the dial has exactly
 * two meaningful positions (the detents between them are visual texture, the
 * "range, not toggle" argument), and paired buttons give keyboard users two
 * plain tab stops with no custom key handling to get wrong. The gauge itself
 * is `aria-hidden` — it is the needle, not the control.
 *
 * The needle and fill travel via motion springs (JS-driven, finite), so the
 * ambient pause rule — CSS keyframes only — never strands them mid-swing.
 * The hub's breathing halo stays a CSS keyframe and stays covered by it.
 *
 * This is an ILLUSTRATION of the product's autonomy dial, not a live setting:
 * it changes nothing but the page. Both buttons are in
 * src/__tests__/focus-visible-marketing.test.ts.
 */

type TierId = (typeof TIERS)[number]['id'];

/** Rest positions along the arc, as fractions of the sweep. Copilot's 0.12 is
 *  the v2/v3 resting value (left of the first detent — set, not parked at the
 *  end stop); Autopilot mirrors it from the right. */
const POSITION: Record<string, number> = {
  copilot: 0.12,
  autopilot: 0.88,
};

/* ── Gauge geometry (viewBox 0 0 220 132) ─────────────────────────────────
   A semicircle: fraction 0 is the LEFT end of the arc, 1 the right. */
const CX = 110;
const CY = 116;
const R = 92;

function pointAt(radius: number, fraction: number) {
  const angle = Math.PI * (1 - fraction);
  return { x: CX + radius * Math.cos(angle), y: CY - radius * Math.sin(angle) };
}

const ARC_D = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
/** Three mid detents: the range argument, between the two operable ends. */
const DETENTS = [0.25, 0.5, 0.75].map((f) => pointAt(R, f));
/** End stops as radial ticks: the travel ends here. */
const END_TICKS = [0, 1].map((f) => ({ from: pointAt(R - 10, f), to: pointAt(R + 10, f) }));

export function TiersSection() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const hubGradientId = useId();
  /* Every account starts on Copilot — the dial does too. */
  const [mode, setMode] = useState<TierId>('copilot');

  /* The fallback can only fire if a third tier id ever appears; it parks the
     needle on the Copilot side — the default posture. */
  const fraction = POSITION[mode] ?? POSITION.copilot ?? 0.12;
  const travel = prefersReducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 170, damping: 26 };

  /* The needle swings via a sprung ANGLE value whose endpoints are computed
     in viewBox coordinates — not via a CSS rotation. A CSS `rotate` on an
     SVG line rotates around the line's own box centre (transform-origin on
     SVG children is unreliable across engines), which pivoted the needle in
     mid-air on the first cut. The motion values bind straight to the line's
     x2/y2 attributes, so the pivot is exactly the hub. */
  const needleAngle = useSpring((fraction - 0.5) * 180, { stiffness: 170, damping: 26 });
  useEffect(() => {
    const target = (fraction - 0.5) * 180;
    if (prefersReducedMotion) needleAngle.jump(target);
    else needleAngle.set(target);
  }, [needleAngle, fraction, prefersReducedMotion]);

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const tipX = useTransform(needleAngle, (deg) => CX + 64 * Math.sin(toRad(deg)));
  const tipY = useTransform(needleAngle, (deg) => CY - 64 * Math.cos(toRad(deg)));
  const tailX = useTransform(needleAngle, (deg) => CX - 12 * Math.sin(toRad(deg)));
  const tailY = useTransform(needleAngle, (deg) => CY + 12 * Math.cos(toRad(deg)));

  return (
    <section className="rw-lp-tiers" aria-labelledby="rw-lp-tiers-heading">
      <div className="rw-lp-tiers-inner">
        <Staged beat={0}>
          <header className="rw-lp-tiers-intro">
            <p className="rw-lp-tiers-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-tiers-heading" id="rw-lp-tiers-heading" aria-label={HEADING_PLAIN}>
              {HEADING_LEAD} <span className="rw-lp-tiers-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-tiers-lead">{LEAD_IN}</p>
          </header>
        </Staged>

        <Staged beat={1} className="rw-lp-tiers-dialplate-reveal">
          <div className="rw-lp-tiers-dialplate">
            <div className="rw-lp-tiers-instrument">
              <svg
                className="rw-lp-tiers-gauge"
                viewBox="0 0 220 132"
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <radialGradient id={hubGradientId} cx="0.35" cy="0.3" r="0.9">
                    <stop offset="0%" stopColor="#ecd9a8" />
                    <stop offset="70%" stopColor="var(--rw-lp-accent, #dcc489)" />
                    <stop offset="100%" stopColor="#c4ab74" />
                  </radialGradient>
                </defs>

                {/* The machined groove: a specular lip under a recessed dark
                    channel, then the travelled portion in gold. */}
                <path className="rw-lp-tiers-gauge-lip" d={ARC_D} />
                <path className="rw-lp-tiers-gauge-groove" d={ARC_D} />
                <m.path
                  className="rw-lp-tiers-gauge-fill"
                  d={ARC_D}
                  pathLength={1}
                  strokeDasharray="1"
                  initial={false}
                  animate={{ strokeDashoffset: 1 - fraction }}
                  transition={travel}
                />

                {DETENTS.map((p) => (
                  <circle
                    key={`${p.x.toFixed(1)}-${p.y.toFixed(1)}`}
                    className="rw-lp-tiers-gauge-detent"
                    cx={p.x}
                    cy={p.y}
                    r={2.5}
                  />
                ))}
                {END_TICKS.map((t) => (
                  <line
                    key={`${t.from.x.toFixed(1)}-${t.from.y.toFixed(1)}`}
                    className="rw-lp-tiers-gauge-tick"
                    x1={t.from.x}
                    y1={t.from.y}
                    x2={t.to.x}
                    y2={t.to.y}
                  />
                ))}

                {/* The needle: endpoints driven by the sprung angle (see the
                    motion values above). The halo breathes via CSS (infinite —
                    covered by the ambient pause rule). */}
                <m.line className="rw-lp-tiers-gauge-tail" x1={CX} y1={CY} x2={tailX} y2={tailY} />
                <m.line className="rw-lp-tiers-gauge-needle" x1={CX} y1={CY} x2={tipX} y2={tipY} />
                <circle className="rw-lp-tiers-gauge-halo" cx={CX} cy={CY} r={16} />
                <circle
                  className="rw-lp-tiers-gauge-hub"
                  cx={CX}
                  cy={CY}
                  r={8.5}
                  fill={`url(#${hubGradientId})`}
                />
              </svg>
            </div>

            <div className="rw-lp-tiers-modes">
              {TIERS.map((tier) => (
                <article
                  key={tier.id}
                  className="rw-lp-tiers-mode"
                  data-tier={tier.id}
                  data-active={mode === tier.id ? 'true' : 'false'}
                >
                  <h3 className="rw-lp-tiers-mode-name">
                    <button
                      type="button"
                      className="rw-lp-tiers-mode-button"
                      aria-pressed={mode === tier.id}
                      onClick={() => setMode(tier.id)}
                    >
                      {tier.name}
                    </button>
                  </h3>
                  <p className="rw-lp-tiers-mode-claim">{tier.claim}</p>
                  <p className="rw-lp-tiers-mode-body">{tier.body}</p>
                </article>
              ))}
            </div>
          </div>
        </Staged>

        <Staged beat={2}>
          <p className="rw-lp-tiers-note">
            {MOVEMENT_NOTE} <span className="rw-lp-tiers-note-governor">{GOVERNOR_NOTE}</span>
          </p>
          {/* The door to /pricing — the same gold text-link grammar as the
              watchdogs section's door to /how-it-works. Why it is here and not
              a sticky nav: tiers-copy.ts, PRICING_LINK_LABEL. */}
          <p className="rw-lp-tiers-door">
            <Link href={MARKETING_LINKS.pricing.href} className="rw-lp-tiers-pricing-link">
              {PRICING_LINK_LABEL}
              <span className="rw-lp-tiers-pricing-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </p>
        </Staged>
      </div>
    </section>
  );
}
