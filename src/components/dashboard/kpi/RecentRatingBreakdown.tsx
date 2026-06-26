import { Icon } from '@/components/dashboard/shell/Icon';

interface RatedReview {
  starRating: number | null;
}

interface Props {
  /**
   * Recent reviews from either dashboard scope. Only `starRating` is read, so
   * both the per-location and aggregate review shapes satisfy this contract
   * without leaking source-specific fields.
   */
  reviews: ReadonlyArray<RatedReview>;
}

const TIERS = [5, 4, 3, 2, 1] as const;

/** Sentiment-cued bar color: 4–5 positive, 3 neutral, 1–2 attention. */
function tierClass(stars: number): 'good' | 'mid' | 'low' {
  if (stars >= 4) return 'good';
  if (stars === 3) return 'mid';
  return 'low';
}

/**
 * Recent reviews by rating — a horizontal-bar breakdown derived from the
 * recent-reviews list already in the dashboard payload. Honest by construction:
 * it counts only that recent sample (not a lifetime aggregate) and the subtitle
 * says so. Renders nothing when no recent review carries a star rating, so the
 * caller can drop the slot cleanly.
 */
export function RecentRatingBreakdown({ reviews }: Props) {
  const counts = new Map<number, number>(TIERS.map((stars) => [stars, 0]));
  for (const review of reviews) {
    if (review.starRating == null) continue;
    const bucket = Math.max(1, Math.min(5, Math.round(review.starRating)));
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const total = Array.from(counts.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;

  return (
    <div className="card rating-breakdown">
      <div className="card-h2-row">
        <Icon name="chart" size={18} />
        <h2>Recent reviews by rating</h2>
      </div>
      <p className="rating-breakdown-sub">
        Based on your {total} most recent {total === 1 ? 'review' : 'reviews'}.
      </p>
      <ul className="rating-rows">
        {TIERS.map((stars) => {
          const count = counts.get(stars) ?? 0;
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
                  className={`rating-fill rating-fill--${tierClass(stars)}`}
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
