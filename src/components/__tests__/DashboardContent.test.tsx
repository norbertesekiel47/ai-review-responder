// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

const { mockUseDashboardData, mockRedirect } = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: null, setLocationScope: vi.fn() }),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => vi.fn(),
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

import { DashboardContent } from '@/components/dashboard/DashboardContent';

describe('DashboardContent announcements (P1 #18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      enabled: false,
      accountTimeZone: 'UTC',
      activeOffboarding: null,
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    vi.useRealTimers();
  });

  it('announces a load error assertively', async () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: 'Dashboard failed to load',
      loading: false,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    renderDashboard(<DashboardContent />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Dashboard failed to load');
  });

  it('announces the loading state politely', async () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    renderDashboard(<DashboardContent />);

    expect(await screen.findByRole('status')).toHaveTextContent('Loading your dashboard');
  });

  it('redirects to account status without mounting operational dashboard data when blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      enabled: true,
      accountTimeZone: 'UTC',
      activeOffboarding: {
        mode: 'delete_data',
        status: 'pending',
        failedStep: null,
        accessEndsAt: null,
        teardownStartedAt: null,
        purgeAfter: '2026-07-10T17:30:00.000Z',
        operationalUIBlocked: true,
      },
    })));
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    renderDashboard(<DashboardContent />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Opening account status');
    });
    expect(mockRedirect).toHaveBeenCalledWith('/account/offboarding/status');
    expect(screen.queryByText('Account deletion is in progress')).not.toBeInTheDocument();
    expect(mockUseDashboardData).not.toHaveBeenCalled();
  });

  it('clears the deferred needs-action hash scroll timer on unmount', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/dashboard#needs-action');
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    const { unmount } = renderDashboard(<DashboardContent />, {
      offboardingStatus: {
        enabled: false,
        accountTimeZone: 'UTC',
        activeOffboarding: null,
      },
    });

    expect(mockUseDashboardData).toHaveBeenCalled();
    const timerCountBeforeUnmount = vi.getTimerCount();
    expect(timerCountBeforeUnmount).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DashboardContent — redesigned 4-zone landing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      enabled: false,
      accountTimeZone: 'UTC',
      activeOffboarding: null,
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  function activeData(reputationOverrides: Record<string, unknown>) {
    return {
      business: { name: 'Bristol Bay Coffee', createdAt: '2025-01-01T00:00:00Z' },
      recentReviews: [],
      ranking: null,
      reviewVelocity: [],
      latestBrief: null,
      zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
      reputationSummary: {
        averageStarRating: { value: 4.6, delta: 0.2, priorSample: 8 },
        responseRate: { value: 92, delta: 15, priorSample: 8 },
        timeSavedMinutes: { value: 420, delta: 42, priorSample: 6 },
        ramping: false,
        pendingApprovalCount: 3,
        sentimentTrend: [
          { weekStart: '2026-05-04', averageScore: 0.4, reviewCount: 5 },
          { weekStart: '2026-05-11', averageScore: 0.6, reviewCount: 4 },
        ],
        ...reputationOverrides,
      },
    };
  }

  function mockActive(reputationOverrides: Record<string, unknown> = {}) {
    mockUseDashboardData.mockReturnValue({
      data: activeData(reputationOverrides),
      error: null,
      loading: false,
      refresh: vi.fn(),
      scopeFallback: null,
    });
  }

  it('renders the mature hero with values, typed deltas, the pending strip, and an honest trend label', async () => {
    mockActive();
    renderDashboard(<DashboardContent />, {
      offboardingStatus: { enabled: false, accountTimeZone: 'UTC', activeOffboarding: null },
    });

    expect(await screen.findByText('Your reputation')).toBeInTheDocument();
    expect(screen.getByText('4.6')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('7h')).toBeInTheDocument(); // 420 min
    // Typed, unit-correct deltas (percentage points / rating points / minutes).
    expect(screen.getByText(/0\.2 pts/)).toBeInTheDocument();
    expect(screen.getByText(/15 pts/)).toBeInTheDocument();
    expect(screen.getByText(/42 min/)).toBeInTheDocument();
    expect(screen.getAllByText(/vs last 30d/).length).toBeGreaterThan(0);
    // Pending strip reflects the authoritative SQL count.
    expect(screen.getByText(/drafts need your approval/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review now/i })).toBeInTheDocument();
    // Trend chart is labelled honestly.
    expect(screen.getByText('Reputation trend')).toBeInTheDocument();
    expect(screen.getByText(/star-equivalent/)).toBeInTheDocument();
  });

  it('renders the ramping hero compact: baseline copy, no delta arrows', async () => {
    mockActive({ ramping: true });
    renderDashboard(<DashboardContent />, {
      offboardingStatus: { enabled: false, accountTimeZone: 'UTC', activeOffboarding: null },
    });

    expect(await screen.findByText(/Still building your baseline/)).toBeInTheDocument();
    // Current values still render…
    expect(screen.getByText('4.6')).toBeInTheDocument();
    // …but no deltas while ramping.
    expect(screen.queryByText(/vs last 30d/)).not.toBeInTheDocument();
  });

  it('shows the quiet "all caught up" strip when the pending count is zero', async () => {
    mockActive({ pendingApprovalCount: 0 });
    renderDashboard(<DashboardContent />, {
      offboardingStatus: { enabled: false, accountTimeZone: 'UTC', activeOffboarding: null },
    });

    // Phrase unique to the calm strip (the reviews empty-state also says "all caught up").
    expect(await screen.findByText(/no drafts waiting on you/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review now/i })).not.toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function renderDashboard(
  ui: ReactElement,
  options: {
    offboardingStatus?: unknown;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
    },
  });
  if (options.offboardingStatus) {
    queryClient.setQueryData(['account-offboarding-status', 'dashboard-gate'], options.offboardingStatus);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}
