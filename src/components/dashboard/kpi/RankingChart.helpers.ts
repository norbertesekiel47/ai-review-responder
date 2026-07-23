import { RANKING_COLORS } from '@/components/dashboard/charts/chart-tokens';

export interface RankingSnapshotPoint {
  date: string;
  position: number;
}

export interface RankingSourceSeries {
  keyword: string;
  snapshots: RankingSnapshotPoint[];
}

export interface RankingChartSeries {
  keyword: string;
  color: string;
  points: { date: string; label: string; position: number }[];
}

export function formatRankingDateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function buildRankingSeries(series: RankingSourceSeries[]): RankingChartSeries[] {
  return series.map((s, i) => ({
    keyword: s.keyword,
    color: RANKING_COLORS[i % RANKING_COLORS.length]!,
    points: s.snapshots.map((p) => ({
      date: p.date,
      label: formatRankingDateLabel(p.date),
      position: p.position,
    })),
  }));
}
