'use client';

import Link from 'next/link';
import { m } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { COMPANY_LINKS, LEGAL_LINKS, MARKETING_LINKS } from '@/components/ui/marketing-links';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { BLURB, SUPPORT_EMAIL, WORDMARK } from './footer-copy';

/**
 * Landing-page footer.
 *
 * Adapted from a hover-reveal footer pattern. What was kept is the structure —
 * an outlined display wordmark whose stroke fills where the cursor passes, over
 * a column grid on a soft gradient ground. What was replaced is everything
 * else, and the replacements are the point:
 *
 *   PALETTE   The source strokes in #3ca2fa and reveals through a five-stop
 *             rainbow (yellow/red/green/cyan/violet). This page has a
 *             load-bearing gold/teal split, and a rainbow sweep through it
 *             would flatten that distinction into decoration. The reveal is a
 *             single gold ramp instead.
 *   CONTENT   The source ships placeholder links (`href="#"`), an invented
 *             email, phone and city, and five social accounts. None of those
 *             exist for RepWorth. Every link here resolves to a real route
 *             from `marketing-links.ts`, the address is the one published in
 *             the legal content, and the social row is omitted rather than
 *             pointed at `#` — a dead icon row is worse than no icon row.
 *   DEPS      No `lucide-react` (not installed, and five icons is not worth a
 *             dependency), and no `cn`/`clsx` (this page styles in plain CSS
 *             with `rw-lp-` classes, not Tailwind utilities).
 *
 * The wordmark is `aria-hidden`: it is a decorative repeat of the brand name,
 * and the accessible name comes from the real link above it. It is also not
 * `cursor-pointer` — the source marks it clickable, but nothing happens when
 * you click it.
 */

interface FooterColumn {
  heading: string;
  links: ReadonlyArray<{ label: string; href: string }>;
}

/** Composed here, not reordered in `marketing-links.ts` — that module owns the
 *  label/href facts, each surface owns its own ordering. */
const FOOTER_COLUMNS: ReadonlyArray<FooterColumn> = [
  {
    heading: 'Product',
    links: [MARKETING_LINKS.features, MARKETING_LINKS.howItWorks, MARKETING_LINKS.pricing],
  },
  { heading: 'Company', links: COMPANY_LINKS },
  { heading: 'Legal', links: LEGAL_LINKS },
];

/**
 * The outlined wordmark, filled along a cursor-tracked radial mask.
 *
 * Two SVG text layers stacked: a static outline, and the same glyphs stroked in
 * gold and masked by a radial gradient that follows the pointer. Moving the
 * mask — rather than redrawing text — keeps the effect on the compositor.
 *
 * Pointer coordinates are converted to percentages of the SVG's own box, so the
 * mask lands under the cursor at any width without a resize listener.
 */
function WordmarkReveal({ text }: { text: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [maskPosition, setMaskPosition] = useState({ cx: '50%', cy: '50%' });

  // Unique per instance: two footers on one page would otherwise share `#id`
  // references and the second would mask against the first's gradient.
  const rawId = useId();
  const maskId = `rw-lp-foot-mask-${rawId}`;
  const revealId = `rw-lp-foot-reveal-${rawId}`;

  // Pointer tracking is a hover affordance, so it is not attached at all when
  // the pointer is coarse — on touch there is no hover state to drive it.
  const [isFinePointer, setIsFinePointer] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const sync = () => setIsFinePointer(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    setMaskPosition({
      cx: `${((event.clientX - box.left) / box.width) * 100}%`,
      cy: `${((event.clientY - box.top) / box.height) * 100}%`,
    });
  };

  return (
    <svg
      ref={svgRef}
      className="rw-lp-foot-wordmark"
      /* 300x58, not the source's 300x100. The SVG's height is derived from its
         viewBox ratio (width/300*H), so the extra 42 units were rendering as
         ~230px of empty box above and below the glyphs — the source hides that
         with large negative margins instead. Sizing the box to the type is the
         same result without margins that have to be re-tuned per breakpoint. */
      viewBox="0 0 300 58"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      onMouseEnter={isFinePointer ? () => setHovered(true) : undefined}
      onMouseLeave={isFinePointer ? () => setHovered(false) : undefined}
      onMouseMove={isFinePointer ? handleMove : undefined}
    >
      <defs>
        <m.radialGradient
          id={revealId}
          gradientUnits="userSpaceOnUse"
          r="22%"
          initial={{ cx: '50%', cy: '50%' }}
          animate={maskPosition}
          transition={{ duration: 0.28, ease: 'easeOut' }}
        >
          <stop offset="0%" stopColor="white" />
          <stop offset="100%" stopColor="black" />
        </m.radialGradient>
        <mask id={maskId}>
          <rect x="0" y="0" width="100%" height="100%" fill={`url(#${revealId})`} />
        </mask>
      </defs>

      {/* Base outline. Always visible, so the wordmark reads as a deliberate
          graphic rather than appearing only on hover. */}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="rw-lp-foot-wordmark-base">
        {text}
      </text>

      {/* Gold fill, revealed only where the cursor's mask is white. Under
          reduced motion the draw-on animation is skipped and the layer simply
          renders — the mask still works, it just does not animate in. */}
      <m.text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="middle"
        mask={`url(#${maskId})`}
        className="rw-lp-foot-wordmark-fill"
        data-hovered={hovered ? 'true' : 'false'}
        initial={prefersReducedMotion ? false : { strokeDashoffset: 1000, strokeDasharray: 1000 }}
        whileInView={prefersReducedMotion ? undefined : { strokeDashoffset: 0, strokeDasharray: 1000 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 3, ease: 'easeInOut' }}
      >
        {text}
      </m.text>
    </svg>
  );
}

export function LandingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="rw-lp-foot">
      <div className="rw-lp-foot-glow" aria-hidden="true" />

      <div className="rw-lp-foot-inner">
        <div className="rw-lp-foot-top">
          <div className="rw-lp-foot-brand">
            <Link href="/" className="rw-lp-foot-brand-name">
              RepWorth
            </Link>
            <p className="rw-lp-foot-blurb">{BLURB}</p>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="rw-lp-foot-mail">
              {SUPPORT_EMAIL}
            </a>
          </div>

          <div className="rw-lp-foot-columns">
            {FOOTER_COLUMNS.map((column) => (
              <nav key={column.heading} aria-label={column.heading} className="rw-lp-foot-column">
                <h2 className="rw-lp-foot-column-heading">{column.heading}</h2>
                <ul className="rw-lp-foot-list">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href} className="rw-lp-foot-link">
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="rw-lp-foot-wordmark-wrap">
          <WordmarkReveal text={WORDMARK} />
        </div>

        <div className="rw-lp-foot-bottom">
          {/* The server renders the year at build time and the client at view
              time; across a New Year boundary those differ and React would warn
              on a mismatch that is not worth a client-only render. */}
          <span suppressHydrationWarning>&copy; {year} RepWorth. All rights reserved.</span>
        </div>
      </div>
    </footer>
  );
}
