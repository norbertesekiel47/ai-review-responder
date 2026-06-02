// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { AggregateDashboardContent } from '@/components/dashboard/aggregate/AggregateDashboardContent';

vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/dashboard/PendingCountContext', () => ({
  useSetPendingCount: () => vi.fn(),
}));

const aggregateData: AggregateDashboardData = {
  scope: 'aggregate',
  valueSummary: {
    totalReviewsHandled: 0,
    totalTimeSavedMinutes: 0,
    currentResponseRate: 0,
    baselineResponseRate: null,
  },
  reviewVelocity: [],
  perLocationVelocity: [],
  ranking: null,
  perLocationRanking: [],
  recentReviews: [],
  perLocationBriefs: [],
  locationKpis: [],
  activeLocationCount: 2,
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

describe('AggregateDashboardContent', () => {
  it('clears the deferred needs-action hash scroll timer on unmount', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/dashboard#needs-action');

    const { unmount } = render(
      <AggregateDashboardContent data={aggregateData} refresh={vi.fn()} />,
    );

    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
