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
