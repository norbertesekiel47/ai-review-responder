'use client';

import { Icon } from '@/components/dashboard/shell/Icon';
import { Sparkline } from '@/components/dashboard/kpi/Sparkline';
import { useCountUp } from '@/hooks/useCountUp';
import { cn } from '@/lib/ui/cn';
import type { ValueSummary } from '@/lib/dashboard/types';

interface ValueKpiGridProps {
  valueSummary: ValueSummary;
  reviewsHandledFoot: string;
  timeSavedFoot: string;
}

// Sparkline strokes need a concrete hex (not a token) because Sparkline derives
// its gradient id from the color string. Warm Editorial sage / blush accents.
const SPARK_HANDLED = '#5E7C76'; // --rw-sage-deep
const SPARK_SAVED = '#A85F4E'; // --rw-blush-deep

export function ValueKpiGrid({
  valueSummary,
  reviewsHandledFoot,
  timeSavedFoot,
}: ValueKpiGridProps) {
  const reviewsHandled = valueSummary.totalReviewsHandled;
  const timeSavedH = Math.round((valueSummary.totalTimeSavedMinutes / 60) * 10) / 10;
  const responseRate = valueSummary.currentResponseRate;
  const clampedResponseRate = Math.max(0, Math.min(100, responseRate));
  const baseline = valueSummary.baselineResponseRate;

  const v1 = useCountUp(reviewsHandled, { duration: 900 });
  const v2 = useCountUp(timeSavedH * 10, { duration: 900 });
  const v3 = useCountUp(responseRate, { duration: 1100 });

  const rateClass = clampedResponseRate >= 80 ? 'green' : clampedResponseRate >= 50 ? 'amber' : 'red';

  const sparkHandled = synthesizeSpark(reviewsHandled, 8);
  const sparkSaved = synthesizeSpark(timeSavedH, 8);

  return (
    <div className="kpi-grid">
      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="inbox" size={14} /> Reviews handled
        </div>
        <Sparkline data={sparkHandled} color={SPARK_HANDLED} />
        <div className="kpi-value">{Math.round(v1).toLocaleString()}</div>
        <div className="kpi-foot">{reviewsHandledFoot}</div>
      </div>

      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="clock" size={14} /> Time saved
        </div>
        <Sparkline data={sparkSaved} color={SPARK_SAVED} />
        <div className="kpi-value">
          {(v2 / 10).toFixed(1)}
          <span className="kpi-unit">h</span>
        </div>
        <div className="kpi-foot">{timeSavedFoot}</div>
      </div>

      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="trend" size={14} /> Response rate
        </div>
        <div className="kpi-value">
          {Math.round(v3)}
          <span className="kpi-unit">%</span>
        </div>
        <div className="kpi-bar-wrap">
          <div className={cn('kpi-bar', rateClass)} style={{ width: `${clampedResponseRate}%` }} />
        </div>
        {baseline != null && <div className="kpi-foot">was {baseline}% before RepWorth</div>}
      </div>
    </div>
  );
}

/** Visual-only smooth ramp ending at `total`, length `n`. */
function synthesizeSpark(total: number, n: number): number[] {
  if (total <= 0) return Array(n).fill(0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const progress = (i + 1) / n;
    out.push(Math.round(total * progress * (0.4 + 0.6 * progress)));
  }
  return out;
}
