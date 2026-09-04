'use client';

import type { DashboardDataActive, ReputationSummary } from '@/lib/dashboard/types';
import { computeWeeklyRecap, type RecapWeek } from '@/lib/dashboard/weekly-recap';
import { getBriefBullets } from '@/components/dashboard/kpi/brief-bullets';
import { InfoTip } from '@/components/ui/InfoTip';

interface Props {
  trend: ReputationSummary['trend'];
  /** The Insights agent's latest brief, when one has been sent. Optional by
   *  design: the recap stands on the weekly series alone, so an account whose
   *  Insights agent has not run yet still gets a complete card. */
  brief?: DashboardDataActive['latestBrief'];
}

/** The bullets the recap shows before it starts competing with the brief's own
 *  card on Analytics. */
const MAX_BRIEF_BULLETS = 3;

/**
 * "Your week" — the glance dashboard's weekly recap (Source B rules 22–23).
 *
 * A flat Harbor card, deliberately: the hero above it is already the screen's
 * one gradient, and the exception queue below is already its one inverted
 * panel. Every value is derived by `computeWeeklyRecap` from the same weekly
 * series the Analytics trend plots.
 */
export function WeeklyRecapCard({ trend, brief }: Props) {
  const recap = computeWeeklyRecap(trend);
  // No series at all: the hero already says the baseline is still building, and
  // two cards saying it is one too many.
  if (!recap) return null;

  const bullets = brief ? getBriefBullets(brief.text).slice(0, MAX_BRIEF_BULLETS) : [];

  return (
    <section className="card recap" aria-labelledby="recap-heading">
      {/* The shared card-heading row, not a private copy of it. */}
      <div className="card-h2-row">
        <h2 id="recap-heading">Your week</h2>
        {/* Beside the heading, not inside it: the section is
            `aria-labelledby="recap-heading"`. */}
        <InfoTip subject="Your week">
          A review counts in the week it was written, not the week RepWorth
          found it. So a review posted last week stays in last week, even if it
          reached you today.
        </InfoTip>
        <span className="recap-range">{recap.rangeLabel} · so far</span>
      </div>

      <div className="recap-body">
        <div className="recap-lede">
          <p className="recap-headline">{recap.headline}</p>
          <div className="recap-stats">
            <div className="recap-stat">
              <b>{recap.newReviews}</b>
              <span>new this week</span>
            </div>
            <div className="recap-stat">
              <b>{recap.runTotal}</b>
              <span>in the last {recap.series.length} weeks</span>
            </div>
          </div>
          {recap.why && <p className="recap-why">{recap.why}</p>}
        </div>

        <div className="recap-plot">
          <RecapSpark series={recap.series} />
          <span className="recap-plot-caption">{recap.series.length} weeks</span>
        </div>
      </div>

      {bullets.length > 0 && (
        <div className="recap-brief">
          <span className="recap-brief-label">From your Insights agent</span>
          <ul className="recap-brief-list">
            {bullets.map((bullet) => (
              <li key={bullet.key}>{bullet.text}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * The weekly counts as bars. Not a sparkline path: a line between weekly counts
 * implies values between the weeks, and there are none. Heights scale to the
 * busiest week, and a zero week keeps a visible floor so the run reads as eight
 * weeks rather than as four.
 */
function RecapSpark({ series }: { series: RecapWeek[] }) {
  const peak = series.reduce((max, week) => Math.max(max, week.reviewCount), 0);
  const total = series.reduce((sum, week) => sum + week.reviewCount, 0);

  return (
    <div
      className="recap-spark"
      role="img"
      aria-label={`Reviews per week over the last ${series.length} weeks, ${total} in total`}
    >
      {series.map((week) => (
        <span
          key={week.weekStart}
          className={`recap-bar ${week.isCurrent ? 'recap-bar--current' : ''}`}
          // A unitless ratio: the CSS applies it through scaleY, which takes a
          // number, and a zero week keeps a visible track rather than vanishing.
          style={{ '--recap-fill': peak === 0 ? 0 : week.reviewCount / peak } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
