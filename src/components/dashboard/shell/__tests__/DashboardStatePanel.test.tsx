// @vitest-environment jsdom
//
// `renderDashboardStatePanel` — shared scaffold eval (#1014 T1, RED).
//
// Title 56, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// THIS IS THE ONE T1 TITLE THAT IS A REAL FAILING TEST, NOT AN `it.todo`. The
// rule is the module, not the behaviour: every other promised title names a
// module that does not exist yet, so a named import would fail the whole file
// at collection. `DashboardStatePanel.tsx` DOES exist — it is the shared
// scaffold `/dashboard/analytics` and `/dashboard/reviews` already use. What
// does not exist is the `'restraint'` surface and the before-content slot, so
// this runs and fails, which is what the RED phase is for.
//
// WHY THE SLOT LIVES HERE AND NOT IN `RestraintContent`. Carry-forward finding
// ST-2: the Analytics tab bar vanishes during load and error on
// `/dashboard/analytics` but persists on `/dashboard/analytics/restraint`,
// because the parked branch re-implemented the scaffold in its own component.
// Fixing it only in the new component inverts the defect rather than removing
// it. The scaffold owns the slot; both routes pass their bar into it.
//
// The temporary cast T1 needed is GONE: Task 6 widened the union and added the
// fourth parameter, so the call stands on its own signature.
//
// THE SECOND CASE IS NOT #1014's. `DashboardStatePanel.tsx:61` gated `showError`
// on `hasData`, so a FIRST-load failure fell through to the skeleton branch and
// the owner watched a loading animation that never resolved. The fix reaches
// `/dashboard/analytics` and `/dashboard/reviews` as well, which is outside this
// ticket — taken anyway, and recorded as deviation D5, because the Restraint tab
// cannot satisfy its own promised error-state behaviour while it stands.

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'loc-1' }),
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title, children }: { title: string; children?: ReactNode }) => (
    <>
      <h1>{title}</h1>
      {children}
    </>
  ),
}));

import {
  renderDashboardStatePanel,
  resolveStatePanelBranch,
} from '@/components/dashboard/shell/DashboardStatePanel';

describe('renderDashboardStatePanel', () => {
  it('renderDashboardStatePanel renders the restraint surface with its before-content slot', () => {
    render(
      <>
        {renderDashboardStatePanel(
          'restraint',
          { loading: true, hasData: false, error: null },
          undefined,
          <nav aria-label="Analytics views">tabs</nav>,
        )}
      </>,
    );

    expect(screen.getByRole('navigation', { name: 'Analytics views' })).toBeInTheDocument();
    expect(screen.getByText('Loading what we held back…')).toBeInTheDocument();
    // The TopBar names the SURFACE; the tab bar names the sub-route. Two
    // headings competing for the same fact is what this slot removes.
    expect(screen.getByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
  });

  it('shows the error card on a first-load failure instead of an endless skeleton', () => {
    const { container } = render(
      <>
        {renderDashboardStatePanel(
          'restraint',
          // The FIRST-load failure: not loading, an error, and no data yet —
          // `hasData` is false precisely BECAUSE the fetch failed.
          { loading: false, hasData: false, error: 'Failed to fetch refusals' },
          undefined,
          <nav aria-label="Analytics views">tabs</nav>,
        )}
      </>,
    );

    expect(screen.getByText('Unable to load your restraint record')).toBeInTheDocument();
    // The message reaches BOTH sinks: the visible card and the assertive live
    // region, which is what makes the failure perceivable rather than merely
    // rendered.
    expect(container.querySelector('.card')?.textContent).toContain('Failed to fetch refusals');
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch refusals');
    expect(container.querySelector('.dashboard-skeleton')).toBeNull();
    // The slot survives the error branch too, so the owner can still leave.
    expect(screen.getByRole('navigation', { name: 'Analytics views' })).toBeInTheDocument();
  });

  it('keeps showing the skeleton while a request is in flight, even with a stale error', () => {
    const { container } = render(
      <>
        {renderDashboardStatePanel(
          'analytics',
          { loading: true, hasData: false, error: 'stale' },
        )}
      </>,
    );

    // Loading still takes precedence — that half of the old comment was right,
    // and the first conjunct is what enforces it.
    expect(container.querySelector('.dashboard-skeleton')).not.toBeNull();
    expect(screen.queryByText('Unable to load analytics')).toBeNull();
  });
});

// UX audit D3: the branch rule is exported so a failed FIRST fetch showing the
// error card (not an endless skeleton) is testable on its own.

describe('resolveStatePanelBranch', () => {
  it('shows the error when the fetch settled with an error and nothing is on screen', () => {
    expect(resolveStatePanelBranch({ loading: false, hasData: false, error: 'Request failed (500)' }))
      .toBe('error');
  });

  it('shows the error when the fetch settled with an error over stale data', () => {
    expect(resolveStatePanelBranch({ loading: false, hasData: true, error: 'boom' })).toBe('error');
  });

  it('keeps loading ahead of a stale error while a fetch is in flight', () => {
    expect(resolveStatePanelBranch({ loading: true, hasData: false, error: 'old' })).toBe('loading');
  });

  it('is ready only with data, no error and no load in flight', () => {
    expect(resolveStatePanelBranch({ loading: false, hasData: true, error: null })).toBe('ready');
    expect(resolveStatePanelBranch({ loading: false, hasData: false, error: null })).toBe('loading');
  });
});

describe('renderDashboardStatePanel (UX audit D3 cases)', () => {
  it('renders the reviews error card for a failed first fetch', () => {
    render(<>{renderDashboardStatePanel('reviews', { loading: false, hasData: false, error: 'Request failed (500)' })}</>);
    expect(screen.getByRole('heading', { name: 'Unable to load reviews' })).toBeInTheDocument();
    // The message renders in the card AND in the assertive live region.
    expect(screen.getByText('Request failed (500)', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByText('Loading your reviews…')).not.toBeInTheDocument();
  });

  it('renders the skeleton while loading', () => {
    render(<>{renderDashboardStatePanel('analytics', { loading: true, hasData: false, error: null })}</>);
    expect(screen.getByText('Loading your analytics…')).toBeInTheDocument();
    expect(screen.queryByText('Unable to load analytics')).toBeNull();
  });

  it('returns null when the surface is ready to render its own data', () => {
    expect(renderDashboardStatePanel('reviews', { loading: false, hasData: true, error: null })).toBeNull();
  });
});
