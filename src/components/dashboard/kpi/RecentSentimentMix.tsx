import { Icon } from '@/components/dashboard/shell/Icon';
import { classifySentiment, type SentimentLabel } from '@/lib/reviews/sentiment';
import { TIER_BY_SENTIMENT } from './sentiment-tier';

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

// Buckets derive from classifySentiment — the single owner of the star→sentiment rule.
const BUCKETS: ReadonlyArray<{ label: string; sentiment: SentimentLabel }> = [
  { label: 'Positive', sentiment: 'positive' },
  { label: 'Neutral', sentiment: 'neutral' },
  { label: 'Negative', sentiment: 'negative' },
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

  const reviewWord = total === 1 ? 'review' : 'reviews';
  const rows = BUCKETS.map(({ label, sentiment }) => {
    const count = stars.filter((value) => classifySentiment(value).label === sentiment).length;
    return { label, sentiment, count, pct: Math.round((count / total) * 100) };
  });

  return (
    <div className="card">
      <div className="card-h2-row">
        <Icon name="trend" size={18} />
        <h2>Sentiment mix</h2>
      </div>
      <p className="rating-breakdown-sub">
        Share of your {total} most recent {reviewWord}.
      </p>
      {/* The chart-level name (#1088 G6), matching its neighbour and the two
          plotted charts. The window phrase deliberately stays DIFFERENT from
          `RecentRatingBreakdown`'s: this chart reads the recent-review sample
          and that one reads the windowed aggregate (#405), so one shared
          phrase would misdescribe whichever chart it did not come from. */}
      <table className="sr-only">
        {/* Worded so it does NOT repeat the visible sub-label verbatim — see
            the twin in `RecentRatingBreakdown`. "most recent" is kept, because
            that phrase IS this chart's window and the pair must stay
            distinguishable from the rating breakdown's "selected period". */}
        <caption>{`Sentiment mix — across the ${total} most recent rated ${reviewWord}`}</caption>
        <thead>
          <tr>
            <th scope="col">Sentiment</th>
            <th scope="col">Reviews</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, count, pct }) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{count}</td>
              <td>{pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="rating-rows" aria-hidden="true">
        {rows.map(({ label, sentiment, pct }) => (
          <li key={label} className="rating-row wide">
            <span className="rating-row-label text">{label}</span>
            <span className="rating-track">
              <span
                className={`rating-fill rating-fill--${TIER_BY_SENTIMENT[sentiment]}`}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="rating-row-count">{pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
