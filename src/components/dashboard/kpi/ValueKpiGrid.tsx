'use client';

import { Icon } from '@/components/dashboard/shell/Icon';
import { useCountUp } from '@/hooks/useCountUp';
import { cn } from '@/lib/ui/cn';
import type { ValueSummary } from '@/lib/dashboard/types';
import { RESPONSE_RATE_PERIOD_CONTEXT } from '@/components/dashboard/kpi/response-rate-copy';

interface ValueKpiGridProps {
  valueSummary: ValueSummary;
  reviewsHandledFoot: string;
  timeSavedFoot: string;
}

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

  return (
    <div className="kpi-grid">
      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="inbox" size={14} /> Reviews handled
        </div>
        <div className="kpi-value">{Math.round(v1).toLocaleString()}</div>
        <div className="kpi-foot">{reviewsHandledFoot}</div>
      </div>

      <div className="kpi">
        <div className="kpi-eyebrow">
          <Icon name="clock" size={14} /> Time saved
        </div>
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
        <div className="kpi-context">
          {RESPONSE_RATE_PERIOD_CONTEXT}
        </div>
        {baseline != null && <div className="kpi-foot">was {baseline}% before RepWorth</div>}
      </div>
    </div>
  );
}
