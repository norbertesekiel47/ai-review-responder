import type { ChartHeadline } from '@/components/dashboard/kpi/chart-headlines';

const DIRECTION_ARROW: Record<ChartHeadline['direction'], string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

/**
 * The headline-first block that leads every Analytics chart card: a large
 * plain-English takeaway + one supporting sentence, with the chart as evidence
 * below it. Renders nothing when there is no headline (empty/ramping state).
 */
export function ChartHeadlineBanner({ data }: { data: ChartHeadline | null }) {
  if (!data) return null;
  return (
    <div className="chart-headline-block">
      <div className={`chart-headline chart-headline--${data.direction}`}>
        <span className="chart-headline-arrow" aria-hidden="true">
          {DIRECTION_ARROW[data.direction]}
        </span>
        {data.headline}
      </div>
      <div className="chart-headline-detail">{data.detail}</div>
    </div>
  );
}
