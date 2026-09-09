import Link from 'next/link';

interface Props {
  /** Which routed tab is the current page. */
  active: 'metrics' | 'restraint';
}

/**
 * Routed tab bar for the Analytics surface: `Metrics` (the reputation, volume
 * and local-ranking grid at `/dashboard/analytics`) and `Restraint` (the
 * **Restraint tab** — what we chose not to do in the window, and why).
 *
 * A **route** tab bar, not a view switch (`docs/brand-asset-library/design-systems/console/DESIGN.md`
 * § Tabs): a `<nav>` of plain `next/link` links carrying `aria-current="page"`,
 * never `role="tab"`. Not `useState` — each route keeps its own server-rendered
 * data model, exactly as `ReviewsTabs` does, and `active` is a literal at each
 * call site rather than a `usePathname()` read.
 *
 * `CardViewTabs` is deliberately NOT the precedent here; its own comment says
 * route-level switches are `ReviewsTabs`. Styling is the shared canvas
 * `.tabs`/`.tab` pill pair (raised, because it sits on the canvas rather than
 * on a card).
 */
export function AnalyticsTabs({ active }: Props) {
  return (
    <nav className="tabs tabs--routed" aria-label="Analytics views">
      <Link
        href="/dashboard/analytics"
        className={`tab ${active === 'metrics' ? 'active' : ''}`}
        aria-current={active === 'metrics' ? 'page' : undefined}
      >
        Metrics
      </Link>
      <Link
        href="/dashboard/analytics/restraint"
        className={`tab ${active === 'restraint' ? 'active' : ''}`}
        aria-current={active === 'restraint' ? 'page' : undefined}
      >
        Restraint
      </Link>
    </nav>
  );
}
