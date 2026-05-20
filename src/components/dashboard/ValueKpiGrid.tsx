'use client';

import { Icon } from './Icon';
import { Sparkline } from './Sparkline';
import { useCountUp } from './useCountUp';

interface ValueSummary {
  totalReviewsHandled: number;
  totalTimeSavedMinutes: number;
  currentResponseRate: number;
  baselineResponseRate: number | null;
}

interface ValueKpiGridProps {
  valueSummary: ValueSummary;
  pendingCount: number;
  reviewsHandledFoot: string;
  timeSavedFoot: string;
  onScrollToReviews: () => void;
}

export function ValueKpiGrid({
  valueSummary,
  pendingCount,
  reviewsHandledFoot,
  timeSavedFoot,
  onScrollToReviews,
}: ValueKpiGridProps) {
  const reviewsHandled = valueSummary.totalReviewsHandled;
  const timeSavedH = Math.round((valueSummary.totalTimeSavedMinutes / 60) * 10) / 10;
  const responseRate = valueSummary.currentResponseRate;
  const clampedResponseRate = Math.max(0, Math.min(100, responseRate));
  const baseline = valueSummary.baselineResponseRate;

  const v1 = useCountUp(reviewsHandled, 900);
  const v2 = useCountUp(timeSavedH * 10, 900);
  const v3 = useCountUp(responseRate, 1100);

  const rateClass = clampedResponseRate >= 80 ? 'green' : clampedResponseRate >= 50 ? 'amber' : 'red';
  const showPending = pendingCount > 0;

  const sparkHandled = synthesizeSpark(reviewsHandled, 8);
  const sparkSaved = synthesizeSpark(timeSavedH, 8);

  return (
    <div className={`kpi-grid ${showPending ? 'has-pending' : ''}`}>
      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="inbox" size={14} /> Reviews handled
        </div>
        <Sparkline data={sparkHandled} color="#2563eb" />
        <div className="kpi-value">{Math.round(v1).toLocaleString()}</div>
        <div className="kpi-foot">{reviewsHandledFoot}</div>
      </div>

      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="clock" size={14} /> Time saved
        </div>
        <Sparkline data={sparkSaved} color="#16a34a" />
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
          <div className={`kpi-bar ${rateClass}`} style={{ width: `${clampedResponseRate}%` }} />
        </div>
        {baseline != null && <div className="kpi-foot">was {baseline}% before RepWorth</div>}
      </div>

      {showPending && (
        <div className="kpi pending">
          <div className="kpi-eyebrow">
            <Icon name="alert" size={14} /> Pending approvals
          </div>
          <div className="kpi-value">{pendingCount}</div>
          <button type="button" className="scroll-link" onClick={onScrollToReviews}>
            Review now <Icon name="scroll-down" size={12} />
          </button>
        </div>
      )}
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
