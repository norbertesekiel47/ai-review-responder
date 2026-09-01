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
// THE CAST IS TEMPORARY AND TASK 6 DELETES IT. `renderDashboardStatePanel`
// today takes three parameters and its `DashboardSurface` union has two members,
// so the call below does not typecheck against the current signature. Casting to
// the TARGET signature keeps `pnpm typecheck` green at the RED phase while the
// assertion still fails at run time — the panel throws on an unknown surface.
// Once Task 6 widens the union and adds the fourth parameter, the cast comes out
// and the call stands on its own.

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

import { renderDashboardStatePanel } from '@/components/dashboard/shell/DashboardStatePanel';

interface FetchState {
  loading: boolean;
  hasData: boolean;
  error: string | null;
}

/** The signature Task 6 ships. See the note above on why this cast exists. */
type TargetPanel = (
  surface: 'analytics' | 'reviews' | 'restraint',
  state: FetchState,
  topBarActions?: ReactNode,
  beforeContent?: ReactNode,
) => ReactNode | null;

const renderPanel = renderDashboardStatePanel as unknown as TargetPanel;

describe('renderDashboardStatePanel', () => {
  it('renderDashboardStatePanel renders the restraint surface with its before-content slot', () => {
    render(
      <>
        {renderPanel(
          'restraint',
          { loading: true, hasData: false, error: null },
          undefined,
          <nav aria-label="Analytics views">tabs</nav>,
        )}
      </>,
    );

    expect(screen.getByRole('navigation', { name: 'Analytics views' })).toBeInTheDocument();
    expect(screen.getByText('Loading what we held back…')).toBeInTheDocument();
  });
});
