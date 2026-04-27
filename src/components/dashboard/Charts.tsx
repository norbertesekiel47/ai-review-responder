'use client';

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  LineChart, Line, CartesianGrid,
} from 'recharts';
import type { DashboardDataActive } from '@/lib/dashboard/types';

const RANKING_LINE_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2',
];

function formatWeekLabel(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00Z');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function ReviewVelocityChart({
  reviewVelocity,
}: {
  reviewVelocity: DashboardDataActive['reviewVelocity'];
}) {
  if (reviewVelocity.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Review Velocity</h2>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={reviewVelocity}>
          <XAxis
            dataKey="weekStart"
            tickFormatter={formatWeekLabel}
            tick={{ fontSize: 12 }}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
          <Tooltip
            labelFormatter={(label) => formatWeekLabel(String(label))}
            formatter={(value) => [String(value), 'Reviews']}
          />
          <Bar
            dataKey="count"
            fill="#2563eb"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RankingChart({
  ranking,
}: {
  ranking: DashboardDataActive['ranking'];
}) {
  if (!ranking || ranking.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold text-gray-900">Search Ranking</h2>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            type="category"
            allowDuplicatedCategory={false}
            tickFormatter={formatWeekLabel}
            tick={{ fontSize: 12 }}
          />
          <YAxis
            reversed
            domain={[1, 'auto']}
            allowDecimals={false}
            tick={{ fontSize: 12 }}
            label={{ value: 'Rank', angle: -90, position: 'insideLeft', fontSize: 12 }}
          />
          <Tooltip labelFormatter={(label) => formatWeekLabel(String(label))} />
          {ranking.map((entry, idx) => (
            <Line
              key={entry.keyword}
              data={entry.snapshots}
              dataKey="position"
              name={entry.keyword}
              stroke={RANKING_LINE_COLORS[idx % RANKING_LINE_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
