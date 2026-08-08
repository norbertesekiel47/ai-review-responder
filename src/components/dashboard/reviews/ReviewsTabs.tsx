import Link from 'next/link';

interface Props {
  /** Which routed tab is the current page. */
  active: 'needs' | 'history';
}

/**
 * Routed tab bar for the Reviews surface: `Needs Action` (the queue) and
 * `All Reviews` (the **Reviews list** — every review for the location).
 *
 * Both tabs render unconditionally as of #678: `PAST_REPLIES_VIEW_ENABLED` is
 * retired, so there is no flag left to gate the second tab on and no route
 * `notFound()` for it to stay consistent with.
 *
 * Plain navigation links — not useState — so each route keeps its own
 * server-rendered data model. Reuses the existing `.tabs`/`.tab` pill styling.
 */
export function ReviewsTabs({ active }: Props) {
  return (
    <nav className="tabs" aria-label="Reviews views">
      <Link
        href="/dashboard/reviews"
        className={`tab ${active === 'needs' ? 'active' : ''}`}
        aria-current={active === 'needs' ? 'page' : undefined}
      >
        Needs Action
      </Link>
      <Link
        href="/dashboard/reviews/history"
        className={`tab ${active === 'history' ? 'active' : ''}`}
        aria-current={active === 'history' ? 'page' : undefined}
      >
        All Reviews
      </Link>
    </nav>
  );
}
