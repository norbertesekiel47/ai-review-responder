'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { RankingChart } from '@/components/dashboard/kpi/RankingChart';
import { buildRankingSeries } from '@/components/dashboard/kpi/RankingChart.helpers';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeRankingHeadline } from '@/components/dashboard/kpi/chart-headlines';

interface Props {
  ranking: DashboardDataActive['ranking'];
}

export function RankingCard({ ranking }: Props) {
  if (!ranking || ranking.length === 0) return null;

  const series = buildRankingSeries(ranking);
  const headline = computeRankingHeadline(ranking);

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Search Ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>local pack</span>
      </div>
      <ChartHeadlineBanner data={headline} />
      <RankingChart series={series} />
    </div>
  );
}
