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
  useLocationScope: () => ({
    currentScope: '11111111-1111-4111-8111-111111111111',
    setLocationScope: vi.fn(),
  }),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => vi.fn(),
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

// Glance-stack zones (kept) vs relocated charts (must be absent). Each is mocked
// with an identifiable marker so the composition test fails loudly if a chart is
// ever re-added to the dashboard.
vi.mock('@/components/dashboard/kpi/ReputationHeroBand', () => ({
  ReputationHeroBand: () => <div data-testid="hero" />,
}));
vi.mock('@/components/dashboard/kpi/IntelligenceBriefCard', () => ({
  IntelligenceBriefCard: () => <div data-testid="brief" />,
}));
vi.mock('@/components/dashboard/kpi/PendingApprovalsStrip', () => ({
  PendingApprovalsStrip: () => <div data-testid="strip" />,
}));
vi.mock('@/components/dashboard/AgentTeamStrip', () => ({
  AgentTeamStrip: ({ scope }: { scope: string }) => (
    <div data-testid="agent-team" data-scope={scope} />
  ),
}));
vi.mock('@/components/dashboard/NeedsAttentionList', () => ({
  NeedsAttentionList: () => <div data-testid="needs-attention" />,
}));
vi.mock('@/components/dashboard/account-state/ConnectGoogleBanner', () => ({
  ConnectGoogleBanner: () => null,
}));
vi.mock('@/components/dashboard/kpi/ReputationTrendChart', () => ({
  ReputationTrendChart: () => <div data-testid="trend" />,
}));
vi.mock('@/components/dashboard/kpi/VelocityCard', () => ({
  VelocityCard: () => <div data-testid="velocity" />,
}));
vi.mock('@/components/dashboard/kpi/RankingCard', () => ({
  RankingCard: () => <div data-testid="ranking" />,
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

});

describe('DashboardContent glance composition (charts relocated to Analytics)', () => {
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

  const activeData = {
    business: { name: 'Bristol Bay Coffee', createdAt: '2026-01-01' },
    valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 60, currentResponseRate: 90, baselineResponseRate: null },
    reputationSummary: {
      averageStar: { current: 4.5, delta: 0.1, priorSampleSize: 5 },
      responseRate: { current: 90, delta: 5, priorSampleSize: 5 },
      timeSavedMinutes: { current: 60, delta: 10, priorSampleSize: 5 },
      pendingApprovalCount: 2,
      trend: [{ weekStart: '2026-04-01', starEquivalent: 4.5, reviewCount: 4 }],
      isRamping: false,
    },
    reviewVelocity: [{ weekStart: '2026-04-01', count: 3 }],
    ranking: [{ keyword: 'cafe', snapshots: [{ date: '2026-05-01', position: 3 }] }],
    recentReviews: [],
    latestBrief: { text: 'Monthly brief', type: 'monthly', periodLabel: 'April' },
    zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
  };

  it('mounts the scoped agent team and account-wide attention queue between hero and approvals', async () => {
    mockUseDashboardData.mockReturnValue({
      data: activeData,
      error: null,
      loading: false,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    renderDashboard(<DashboardContent />);

    expect(await screen.findByTestId('hero')).toBeInTheDocument();
    expect(screen.getByTestId('agent-team')).toHaveAttribute(
      'data-scope',
      '11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByTestId('needs-attention')).toBeInTheDocument();
    expect(screen.getByTestId('strip')).toBeInTheDocument();
    const hero = screen.getByTestId('hero');
    const team = screen.getByTestId('agent-team');
    const attention = screen.getByTestId('needs-attention');
    const strip = screen.getByTestId('strip');
    expect(hero.compareDocumentPosition(team) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(team.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attention.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: /view analytics/i })).toHaveAttribute('href', '/dashboard/analytics');
    expect(screen.queryByTestId('brief')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trend')).not.toBeInTheDocument();
    expect(screen.queryByTestId('velocity')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ranking')).not.toBeInTheDocument();
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
