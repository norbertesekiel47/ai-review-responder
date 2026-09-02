// @vitest-environment jsdom
// UX audit D3: a failed FIRST fetch must show the error card, not a skeleton
// that announces "Loading…" forever.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  renderDashboardStatePanel,
  resolveStatePanelBranch,
} from '@/components/dashboard/shell/DashboardStatePanel';

vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));

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

describe('renderDashboardStatePanel', () => {
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
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('returns null when the surface is ready to render its own data', () => {
    expect(renderDashboardStatePanel('reviews', { loading: false, hasData: true, error: null })).toBeNull();
  });
});
