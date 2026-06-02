'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { RankingChart } from './RankingChart';
import { buildRankingSeries } from './RankingChart.helpers';

interface Props {
  ranking: DashboardDataActive['ranking'];
}

export function RankingCard({ ranking }: Props) {
  if (!ranking || ranking.length === 0) return null;

  const series = buildRankingSeries(ranking);

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Search Ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6B7280' }}>local pack</span>
      </div>
      <RankingChart series={series} />
    </div>
  );
}
