import { Icon } from '@/components/dashboard/shell/Icon';
import type { RatingBreakdown } from '@/lib/dashboard/types';
import { tierForStars } from './sentiment-tier';

interface Props {
  /**
   * Windowed reviews-by-rating aggregate (#405). A TRUE distribution across the
   * selected analytics window — not the recent-reviews sample — so both dashboard
   * scopes (per-location and account aggregate) feed the same shape.
   */
  breakdown: RatingBreakdown;
}

/**
 * Reviews by rating — a horizontal-bar breakdown over every rated review in the
 * selected analytics window (#405). Renders nothing when the window holds no
 * rated review, so the caller can drop the slot cleanly. Bar color is
 * sentiment-cued — tiers derive from classifySentiment.
 */
export function RecentRatingBreakdown({ breakdown }: Props) {
  const { counts, total } = breakdown;
  if (total === 0) return null;

  return (
    <div className="card rating-breakdown">
      <div className="card-h2-row">
        <Icon name="chart" size={18} />
        <h2>Reviews by rating</h2>
      </div>
      <p className="rating-breakdown-sub">
        Across {total} {total === 1 ? 'review' : 'reviews'} in the selected period.
      </p>
      <ul className="rating-rows">
        {counts.map(({ stars, count }) => {
          const pct = Math.round((count / total) * 100);
          return (
            <li
              key={stars}
              className="rating-row"
              aria-label={`${stars} star${stars === 1 ? '' : 's'}: ${count} review${count === 1 ? '' : 's'}, ${pct}%`}
            >
              <span className="rating-row-label" aria-hidden="true">
                {stars}
                <span className="rating-row-star">★</span>
              </span>
              <span className="rating-track" aria-hidden="true">
                <span
                  className={`rating-fill rating-fill--${tierForStars(stars)}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="rating-row-count" aria-hidden="true">
                {count}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
