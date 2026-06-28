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

type SentimentTier = 'good' | 'mid' | 'low';

/** Positive 4–5★, Neutral 3★, Negative 1–2★ — the same buckets and colors as
 *  RecentRatingBreakdown, so the two cards read as one story side by side. */
const BUCKETS: ReadonlyArray<{ label: string; tier: SentimentTier; holds: (stars: number) => boolean }> = [
  { label: 'Positive', tier: 'good', holds: (stars) => stars >= 4 },
  { label: 'Neutral', tier: 'mid', holds: (stars) => stars === 3 },
  { label: 'Negative', tier: 'low', holds: (stars) => stars <= 2 },
];

/**
 * Sentiment mix — the share of recent reviews that read positive / neutral /
 * negative, derived from the same recent-review star sample as the rating
 * breakdown (honest by construction: it counts only that recent sample, not a
 * lifetime aggregate). Renders nothing when no recent review carries a rating,
 * so the caller can drop the slot cleanly.
 */
export function RecentSentimentMix({ reviews }: Props) {
  const stars = reviews
    .map((review) => review.starRating)
    .filter((rating): rating is number => rating != null)
    .map((rating) => Math.max(1, Math.min(5, Math.round(rating))));

  const total = stars.length;
  if (total === 0) return null;

  return (
    <div className="card">
      <div className="card-h2-row">
        <Icon name="trend" size={18} />
        <h2>Sentiment mix</h2>
      </div>
      <p className="rating-breakdown-sub">
        Share of your {total} most recent {total === 1 ? 'review' : 'reviews'}.
      </p>
      <ul className="rating-rows">
        {BUCKETS.map(({ label, tier, holds }) => {
          const count = stars.filter(holds).length;
          const pct = Math.round((count / total) * 100);
          return (
            <li key={label} className="rating-row wide" aria-label={`${label}: ${pct}%`}>
              <span className="rating-row-label text" aria-hidden="true">
                {label}
              </span>
              <span className="rating-track" aria-hidden="true">
                <span className={`rating-fill rating-fill--${tier}`} style={{ width: `${pct}%` }} />
              </span>
              <span className="rating-row-count" aria-hidden="true">
                {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
