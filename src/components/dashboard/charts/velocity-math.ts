// Pure math + geometry constants for the velocity charts. Kept separate from
// VelocityChart.tsx so the component file exports only components (Fast
// Refresh hygiene, react-doctor only-export-components).

export interface VelocitySummary {
  lastWeek: number;
  deltaPct: number;
  total: number;
  avg: number;
}

/** Derives the stat row (This week / delta / total / 1-decimal avg) from weekly counts. */
export function computeVelocitySummary(counts: number[]): VelocitySummary {
  const lastWeek = counts[counts.length - 1] ?? 0;
  const prevWeek = counts[counts.length - 2] ?? lastWeek;
  return {
    lastWeek,
    deltaPct: prevWeek ? Math.round(((lastWeek - prevWeek) / prevWeek) * 100) : 0,
    total: counts.reduce((a, b) => a + b, 0),
    avg: Number((counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length)).toFixed(1)),
  };
}

/**
 * Shows only ~half the tick labels (every other, plus the last) to avoid crowding.
 *
 * `timeZone: 'UTC'` is load-bearing, not decoration. `weekStartIso` is a
 * calendar DAY (`YYYY-MM-DD`), which JS parses as UTC midnight — so formatting
 * it in the viewer's zone rolls it back a day everywhere west of Greenwich, and
 * a week starting Monday Jun 22 labels its tick "Jun 21", a Sunday. A week
 * bucket has no time of day to localize; pinning the zone is what makes the
 * label mean the same date for every owner. Same reason as
 * `formatRankingDateLabel` and `src/components/admin/ui/format.ts`.
 */
export function weekShortLabel(weekStartIso: string, idx: number, total: number): string {
  if (idx % 2 !== 0 && idx !== total - 1) return '';
  return new Date(weekStartIso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Shared geometry: the total and stacked velocity charts toggle in place in
// the same card, so they must agree on height/margins (one owner).
export const VELOCITY_PAD = { l: 36, r: 16, t: 28, b: 32 } as const;
export const VELOCITY_H = 220;
