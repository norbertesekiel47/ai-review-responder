import Link from 'next/link';

interface Props {
  /** Which routed tab is the current page. */
  active: 'needs' | 'history';
  /**
   * Server-authoritative (PAST_REPLIES_VIEW_ENABLED) — passed down, never read
   * client-side (invariant #13). The History tab is rendered only when true, so
   * it stays consistent with the history route's own notFound() gate.
   */
  historyEnabled: boolean;
}

/**
 * Routed tab bar for the Reviews surface: `Needs Action` (the queue) and
 * `History` (the moved Past Replies archive). Plain navigation links — not
 * useState — so each route keeps its own server-rendered data model. Reuses the
 * existing `.tabs`/`.tab` pill styling.
 */
export function ReviewsTabs({ active, historyEnabled }: Props) {
  return (
    <nav className="tabs" aria-label="Reviews views">
      <Link
        href="/dashboard/reviews"
        className={`tab ${active === 'needs' ? 'active' : ''}`}
        aria-current={active === 'needs' ? 'page' : undefined}
      >
        Needs Action
      </Link>
      {historyEnabled && (
        <Link
          href="/dashboard/reviews/history"
          className={`tab ${active === 'history' ? 'active' : ''}`}
          aria-current={active === 'history' ? 'page' : undefined}
        >
          History
        </Link>
      )}
    </nav>
  );
}
