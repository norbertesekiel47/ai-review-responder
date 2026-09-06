'use client';

import { type CSSProperties, type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from '@/hooks/useReveal';
import { REP_PULSE_WEIGHTS } from '@/lib/dashboard/rep-pulse';

// Sample values, labelled as such on the card. The formula line is built from
// the product's own weights so the copy cannot drift from what the dashboard
// computes.
const SAMPLE_RATING = 4.6;
const SAMPLE_RESPONSE_RATE = 93;
const SAMPLE_SCORE = Math.round(
  (SAMPLE_RATING / 5) * REP_PULSE_WEIGHTS.rating + (SAMPLE_RESPONSE_RATE / 100) * REP_PULSE_WEIGHTS.response
);

const VELOCITY_WEEKS = [
  { label: 'W1', n: 8 },
  { label: 'W2', n: 11 },
  { label: 'W3', n: 9 },
  { label: 'W4', n: 13 },
  { label: 'W5', n: 10 },
  { label: 'W6', n: 14 },
] as const;
const VELOCITY_MAX = Math.max(...VELOCITY_WEEKS.map((w) => w.n));
const LATEST_WEEK = VELOCITY_WEEKS[VELOCITY_WEEKS.length - 1] ?? VELOCITY_WEEKS[0];

const DASHBOARD_FACTS = [
  `Rep Pulse: rating ÷ 5 × ${REP_PULSE_WEIGHTS.rating} + response rate × ${REP_PULSE_WEIGHTS.response}, stated on the card`,
  'No score while an account is still ramping, never an invented one',
  'Rating and volume trend by week, review velocity, the weekly recap',
  'Agent activity: what Reply, Guardian, and Insights each did',
];

export function FeatDashboard({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section ref={innerRef} id="f-dashboard" aria-label="Dashboard: Rep Pulse and trends" className="rw-dl-band is-tight">
      <div className="rw-dl-col">
        <div className="feat-ch is-flip">
          <FeatIntro
            n="07"
            kicker="Dashboard · Rep Pulse"
            bar="var(--rw-teal-bar)"
            group="Measure"
            title="One score you can check the maths on."
            lede={
              <>
                Rep Pulse is a 0–100 score with a formula you can read: {REP_PULSE_WEIGHTS.rating} percent
                your average rating, {REP_PULSE_WEIGHTS.response} percent your response rate. It stays
                blank until there is enough history to be honest. Around it, the dashboard keeps the
                week-by-week picture: rating and volume trends, review velocity, the weekly recap, and
                what each agent did.
              </>
            }
          >
            <ul className="rw-dl-bul">
              {DASHBOARD_FACTS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </FeatIntro>
          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
            <div className="rw-dl-card feat-dash">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-teal-bar)' }} />
                <span>Your dashboard · sample · last 30 days</span>
                <span className="rw-dl-cap-tail">Rep Pulse</span>
              </div>
              <div className="feat-dash-pulse">
                <div>
                  <div className="feat-dash-score">{SAMPLE_SCORE}</div>
                  <div className="feat-dash-formula">
                    {SAMPLE_RATING} ÷ 5 × {REP_PULSE_WEIGHTS.rating} + {SAMPLE_RESPONSE_RATE}% × {REP_PULSE_WEIGHTS.response}
                  </div>
                </div>
                <dl className="feat-dash-kpis">
                  <div>
                    <dt>Average rating</dt>
                    <dd>{SAMPLE_RATING}</dd>
                  </div>
                  <div>
                    <dt>Response rate</dt>
                    <dd>{SAMPLE_RESPONSE_RATE}%</dd>
                  </div>
                  <div>
                    <dt>Reviews this week</dt>
                    <dd>{LATEST_WEEK.n}</dd>
                  </div>
                </dl>
              </div>
              <p className="feat-dash-lbl">Review velocity · reviews per week</p>
              <div className="feat-dash-velocity" aria-hidden="true">
                {VELOCITY_WEEKS.map((w, i) => (
                  <span key={w.label} className="feat-dash-vcol">
                    <span
                      className="feat-dash-vbar"
                      style={
                        {
                          '--fill-r': w.n / VELOCITY_MAX,
                          '--fill-d': `${300 + i * 110}ms`,
                        } as CSSProperties
                      }
                    />
                    <span className="feat-dash-vlabel">{w.label}</span>
                  </span>
                ))}
              </div>
              <p className="rw-dl-fine">Sample values. Your dashboard shows a dash, not a score, until it has enough history.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
