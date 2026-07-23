// Single authoritative owner of Warm Editorial chart styling constants.
// Every value references the existing --rw-* custom properties; the only
// literal hexes are the multi-hue series ramp, which encodes WHICH
// location/series and intentionally is not sage.

export const CHART_ACCENT = 'var(--rw-sage-deep)';
export const CHART_GRID_STROKE = 'var(--rw-hair)';
export const CHART_AXIS_FILL = 'var(--rw-app-text-soft)';
export const CHART_AXIS_FILL_ACTIVE = 'var(--rw-app-text-muted)';
export const CHART_DOT_FILL = 'var(--rw-card)';
export const CHART_DANGER = 'var(--rw-danger)';
export const CHART_FONT_BODY = 'var(--rw-font-body)';
export const CHART_FONT_DISPLAY = 'var(--rw-font-display)';

// Moved from RankingChart.helpers.ts (spec: one owner; old export removed).
// Shared by RankingChart series, AggregateRankingCard legend, and the
// stacked velocity bars so a location keeps one color everywhere.
export const RANKING_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ea580c',
  '#9333ea',
  '#0891b2',
  '#dc2626',
] as const;
