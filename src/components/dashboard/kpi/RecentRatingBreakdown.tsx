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

  const reviewWord = (n: number) => (n === 1 ? 'review' : 'reviews');
  const rows = counts.map(({ stars, count }) => ({
    stars,
    count,
    pct: Math.round((count / total) * 100),
  }));

  return (
    <div className="card rating-breakdown">
      <div className="card-h2-row">
        <Icon name="chart" size={18} />
        <h2>Reviews by rating</h2>
      </div>
      <p className="rating-breakdown-sub">
        Across {total} {reviewWord(total)} in the selected period.
      </p>
      {/* The chart-level name (#1088 G6). The rows used to carry the only
          labels, and a row label names a ROW — the chart itself was anonymous,
          so a reader met five unattributed bars. This is the same `sr-only`
          table the velocity and ranking charts use, so all four charts now
          announce themselves the same way, and the caption states the window
          as well as the subject. The visual list goes `aria-hidden` in the
          same move: it is the same data, and two copies would make every row
          speak twice — which G6 explicitly forbids. */}
      <table className="sr-only">
        {/* Worded so it does NOT repeat the visible sub-label verbatim: an
            `sr-only` copy of the same sentence makes `getByText` ambiguous and
            gives a reader the line twice over. */}
        <caption>{`Reviews by rating — ${total} rated ${reviewWord(total)} in the selected period`}</caption>
        <thead>
          <tr>
            <th scope="col">Rating</th>
            <th scope="col">Reviews</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ stars, count, pct }) => (
            <tr key={stars}>
              <th scope="row">{`${stars} star${stars === 1 ? '' : 's'}`}</th>
              <td>{`${count} ${reviewWord(count)}`}</td>
              <td>{pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="rating-rows" aria-hidden="true">
        {rows.map(({ stars, count, pct }) => (
          <li key={stars} className="rating-row">
            <span className="rating-row-label">
              {stars}
              <span className="rating-row-star">★</span>
            </span>
            <span className="rating-track">
              <span
                className={`rating-fill rating-fill--${tierForStars(stars)}`}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="rating-row-count">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
