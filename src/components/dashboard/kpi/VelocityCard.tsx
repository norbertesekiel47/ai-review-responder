'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeVelocityHeadline } from '@/components/dashboard/kpi/chart-headlines';
import { KpiSummary } from '@/components/dashboard/charts/KpiSummary';
import {
  VelocityChart,
  computeVelocitySummary,
  weekShortLabel,
} from '@/components/dashboard/charts/VelocityChart';

interface Props {
  reviewVelocity: DashboardDataActive['reviewVelocity'];
}

export function VelocityCard({ reviewVelocity }: Props) {
  const data = reviewVelocity.map((r, i) => ({
    label: weekShortLabel(r.weekStart, i, reviewVelocity.length),
    count: r.count,
  }));
  const headline = computeVelocityHeadline(reviewVelocity);
  const summary = computeVelocitySummary(data.map((d) => d.count));

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Review Velocity</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>
          last {data.length} weeks
        </span>
      </div>
      <ChartHeadlineBanner data={headline} />
      <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <KpiSummary label="This week" value={summary.lastWeek} delta={summary.deltaPct} />
        <KpiSummary label="Total · last weeks" value={summary.total} />
        <KpiSummary label="Weekly avg" value={summary.avg} />
      </div>
      <VelocityChart data={data} />
    </div>
  );
}
