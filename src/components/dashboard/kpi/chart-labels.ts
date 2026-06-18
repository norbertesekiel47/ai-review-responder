/**
 * Abbreviated week-axis tick label for the dashboard charts. Shows ~every other
 * tick (plus the last) to avoid crowding, and renders nothing for an unparseable
 * date. Single owner shared by VelocityCard, AggregateVelocityCard, and
 * ReputationTrendChart.
 */
export function weekTickLabel(weekStartIso: string, index: number, total: number): string {
  if (index % 2 !== 0 && index !== total - 1) return '';
  const d = new Date(weekStartIso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
