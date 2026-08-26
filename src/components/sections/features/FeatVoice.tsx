'use client';

import { type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from '@/hooks/useReveal';

const VOICE_BARS = [
  { h: 85, d: '80ms' },
  { h: 72, d: '160ms' },
  { h: 61, d: '240ms' },
  { h: 48, d: '320ms' },
  { h: 35, d: '400ms' },
  { h: 28, d: '480ms' },
  { h: 18, d: '560ms' },
  { h: 12, d: '640ms', anno: true },
];

/* ================== 08 VOICE (flipped chapter: chart left, text right) ================== */
export function FeatVoice({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [chartRef, chartSeen] = useReveal<HTMLDivElement>();
  return (
    <section ref={innerRef} id="f-voice" aria-label="Voice learning" className="rw-dl-band is-paper is-tight">
      <div className="rw-dl-col">
        <div className="feat-ch is-flip">
          <FeatIntro
            n="08"
            kicker="Over time"
            bar="var(--rw-mist-bar)"
            group="Craft and proof"
            title="It learns your voice, edit by edit."
            lede="Every reply you edit and post teaches it. After your first five, drafts start matching your edits: your warmth level, your phrasing, the way you handle a complaint. The aim is drafts you approve untouched."
          />

          <div ref={chartRef} className={cn('feat-ch-ar rw-dl-rv', chartSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span>% of drafts edited by owner</span>
                <span className="rw-dl-cap-tail">the curve we aim for</span>
              </div>
              <div className="feat-voice-chart">
                <div className="feat-voice-grid" aria-hidden="true">
                  <span /><span /><span /><span />
                </div>
                <div className="feat-voice-bars">
                  {VOICE_BARS.map((b) => (
                    <div
                      key={b.d}
                      className={cn('rw-voice-bar', b.anno && 'is-goal')}
                      style={{ height: `${b.h}%`, ['--bar-d' as string]: b.d }}
                    >
                      {b.anno && <span className="feat-voice-anno">the goal: hands-off</span>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="feat-voice-axis" aria-hidden="true">
                {['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'].map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
              <p className="rw-dl-fine">Illustrative target, not live performance data.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
