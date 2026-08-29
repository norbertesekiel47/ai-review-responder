'use client';

import { useState } from 'react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { RankingChart } from '@/components/dashboard/kpi/RankingChart';
import {
  buildRankingSeries,
  formatRankingDateLabel,
} from '@/components/dashboard/kpi/RankingChart.helpers';
import { RANKING_COLORS } from '@/components/dashboard/charts/chart-tokens';
import { CardViewTabs } from '@/components/dashboard/charts/CardViewTabs';

const RANKING_VIEWS = [
  { value: 'aggregate', label: 'Best Across Locations' },
  { value: 'per-location', label: 'Per Location' },
] as const;

interface Props {
  ranking: AggregateDashboardData['ranking'];
  perLocationRanking: AggregateDashboardData['perLocationRanking'];
}

export function AggregateRankingCard({ ranking, perLocationRanking }: Props) {
  const [mode, setMode] = useState<'aggregate' | 'per-location'>('aggregate');

  if (!ranking && perLocationRanking.length === 0) return null;

  // Aggregate series (best position across locations)
  const aggregateSeries = ranking ? buildRankingSeries(ranking) : [];

  // Per-location series
  const perLocationSeries = perLocationRanking.flatMap((loc, li) => {
    if (!loc.ranking) return [];
    return loc.ranking.map((kw) => ({
      locationDisplayName: loc.displayName,
      locationId: loc.locationId,
      keyword: kw.keyword,
      color: RANKING_COLORS[li % RANKING_COLORS.length]!,
      points: kw.snapshots.map((p) => ({
        date: p.date,
        label: formatRankingDateLabel(p.date),
        position: p.position,
      })),
    }));
  });

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Search Ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>local pack</span>
      </div>

      {/* VAL-DASH-015: per-location ranking view */}
      <CardViewTabs
        label="Search ranking view"
        value={mode}
        onChange={setMode}
        options={RANKING_VIEWS}
      >
        {mode === 'aggregate' ? (
          <RankingChart
            series={aggregateSeries}
            formatSeriesLabel={formatAggregateSeriesLabel}
            labelFontSize="9"
            labelFontWeight="500"
            emphasis="series"
          />
        ) : (
          <>
            <RankingChart
              series={perLocationSeries.map((s) => ({
                keyword: `[${s.locationDisplayName}] ${s.keyword}`,
                color: s.color,
                points: s.points,
              }))}
              formatSeriesLabel={formatAggregateSeriesLabel}
              labelFontSize="9"
              labelFontWeight="500"
              emphasis="series"
            />
            <div className="chart-legend">
              {perLocationRanking.map((loc, i) => (
                <span key={loc.locationId}>
                  <span className="legend-dot" style={{ background: RANKING_COLORS[i % RANKING_COLORS.length] }} />
                  {loc.displayName}
                </span>
              ))}
            </div>
          </>
        )}
      </CardViewTabs>
    </div>
  );
}

function formatAggregateSeriesLabel(keyword: string): string {
  return keyword.length > 18 ? keyword.slice(0, 16) + '…' : keyword;
}
