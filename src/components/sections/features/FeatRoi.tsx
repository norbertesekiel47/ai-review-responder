'use client';

import { type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from './useReveal';

const ROI_TILES = [
  { label: 'Response rate', before: '12%', after: '96', afterUnit: '%', bar: 'var(--rw-teal-bar)' },
  { label: 'Avg rating', before: '4.1', after: '4.6', afterUnit: '★', bar: 'var(--rw-sage-bar)' },
  { label: 'Local map rank', before: '#14', after: '#3', afterUnit: '', bar: 'var(--rw-mist-bar)' },
];

/* ================== 09 ROI (wide chapter) ================== */
export function FeatRoi({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [gridRef, gridSeen] = useReveal<HTMLDivElement>();

  return (
    <section ref={innerRef} id="f-roi" aria-label="Results dashboard" className="rw-dl-band">
      <div className="rw-dl-col">
        <div className="feat-ch is-wide">
          <FeatIntro
            n="09"
            kicker="Proof"
            bar="var(--rw-teal-bar)"
            group="Craft and proof"
            title="Numbers to show your accountant."
            lede={
              <>
                Response rate before and after. Your average rating over time. Where you sit on the
                local map for the search terms we track for you. Estimated time saved. The kind of
                numbers that justify the line item.
                <span className="feat-roi-note"> Sample dashboard with illustrative numbers. Yours shows your own.</span>
              </>
            }
          />

          <div ref={gridRef} className={cn('feat-ch-ar feat-roi-grid rw-dl-rv', gridSeen && 'is-in')}>
            {ROI_TILES.map((t) => (
              <div key={t.label} className="feat-roi-tile" style={{ ['--bar' as string]: t.bar }}>
                <div className="feat-roi-lbl">{t.label}</div>
                <div className="feat-roi-nums">
                  <span className="feat-roi-before">{t.before}</span>
                  <svg className="feat-roi-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                  <span className="feat-roi-after">
                    {t.after}
                    {t.afterUnit && <small>{t.afterUnit}</small>}
                  </span>
                </div>
              </div>
            ))}

            <div className="feat-roi-wide">
              <div>
                <div className="feat-roi-lbl">Time saved · estimate</div>
                <p className="feat-roi-sub">
                  About 7 minutes per handled review, shown on your dashboard and in the weekly
                  brief.
                </p>
              </div>
              <div className="feat-roi-nums">
                <span className="feat-roi-after">1.6<small> hrs</small></span>
                <span className="feat-roi-meta">this week · 14 reviews</span>
              </div>
            </div>

            <div className="feat-roi-map">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-mist-bar)' }} />
                <span>Google map position · sample · &ldquo;taqueria near me&rdquo;</span>
                <span className="rw-dl-cap-tail">Google Maps · local pack</span>
              </div>
              <p className="feat-roi-map-t">Watch where you stand in the neighborhood.</p>
              <div className="feat-roi-spark">
                <svg viewBox="0 0 800 144" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="0" y1="36" x2="800" y2="36" stroke="var(--rw-line)" />
                  <line x1="0" y1="72" x2="800" y2="72" stroke="var(--rw-line)" />
                  <line x1="0" y1="108" x2="800" y2="108" stroke="var(--rw-line)" />
                  <path
                    className="rw-sparkline-path"
                    d="M0,124 L80,118 L160,110 L240,92 L320,84 L400,74 L480,60 L560,46 L640,38 L720,30 L800,24"
                    stroke="var(--rw-forest)"
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinecap="round"
                  />
                  <circle cx="800" cy="24" r="5" fill="var(--rw-forest)" />
                </svg>
                <span className="feat-roi-rank feat-roi-rank-top" aria-hidden="true">#1</span>
                <span className="feat-roi-rank feat-roi-rank-bottom" aria-hidden="true">#20</span>
              </div>
              <div className="feat-roi-axis" aria-hidden="true">
                <span>Jan</span>
                <span>Feb</span>
                <span>Mar</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
