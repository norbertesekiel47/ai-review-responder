import { describe, expect, it } from 'vitest';
import { buildRankingSeries, formatRankingDateLabel } from '@/components/dashboard/kpi/RankingChart.helpers';

describe('RankingChart helpers', () => {
  it('formats ISO dates into short dashboard labels', () => {
    expect(formatRankingDateLabel('2026-05-19')).toBe('May 19');
  });

  it('builds chart series while preserving raw date keys', () => {
    const series = buildRankingSeries([
      {
        keyword: 'pizza near me',
        snapshots: [
          { date: '2026-05-18', position: 4 },
          { date: '2026-05-19', position: 2 },
        ],
      },
      {
        keyword: 'best cafe',
        snapshots: [{ date: '2026-05-19', position: 1 }],
      },
    ]);

    expect(series).toEqual([
      {
        keyword: 'pizza near me',
        color: '#2563eb',
        points: [
          { date: '2026-05-18', label: 'May 18', position: 4 },
          { date: '2026-05-19', label: 'May 19', position: 2 },
        ],
      },
      {
        keyword: 'best cafe',
        color: '#16a34a',
        points: [{ date: '2026-05-19', label: 'May 19', position: 1 }],
      },
    ]);
  });
});
