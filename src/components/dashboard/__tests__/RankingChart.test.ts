import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('Warm Editorial token re-skin', () => {
  // The chart components moved onto the warm Analytics surface; none may keep
  // the Console-era cool grays (#E5E7EB gridlines / #9CA3AF axis text). They now
  // resolve --rw-hair / --rw-app-text-soft via CSS classes or inline style.
  const CHART_COMPONENTS = [
    'kpi/ReputationTrendChart.tsx',
    'kpi/RankingChart.tsx',
    'kpi/VelocityCard.tsx',
    'aggregate/AggregateVelocityCard.tsx',
    'aggregate/AggregateRankingCard.tsx',
  ];

  it.each(CHART_COMPONENTS)('%s contains no hardcoded #E5E7EB / #9CA3AF', (relPath) => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard', relPath),
      'utf8',
    );
    expect(source).not.toMatch(/#E5E7EB/i);
    expect(source).not.toMatch(/#9CA3AF/i);
  });
});
