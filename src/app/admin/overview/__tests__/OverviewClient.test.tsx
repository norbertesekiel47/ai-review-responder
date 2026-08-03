// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewClient } from '../OverviewClient';

const baseData = {
  systemHealth: {
    pendingOutbox: 3,
    failedJobs: 0,
    todayCostUsd: 12.5,
    notificationFailures24h: 0,
    emailHealth: {
      sent24h: 40,
      delivered24h: 39,
      bounces7d: 1,
      hardBounces7d: 0,
      complaints7d: 0,
      deliveryRate24h: 98,
      redState: false,
    },
  },
  totalBusinesses: 1,
  limit: 20,
  offset: 0,
  responseMetricsWindowDays: 30,
  businesses: [
    {
      id: 'biz-1',
      name: 'Acme Coffee',
      subscriptionStatus: 'active',
      lastSyncAt: null,
      pendingApprovalCount: 0,
      pendingReconnectCount: 0,
      totalResponses: 10,
      completedResponses: 8,
      responseRate: 80,
      avgResponseTimeHours: 2.5,
      lastActivity: null,
      churnScore: { score: 5, level: 'healthy' as const, breakdown: [] },
    },
  ],
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes by URL so the overview query and the shared nav-counts query (mirroring
 * AdminSidebar) each get their own fixture, matching what the two real endpoints return. */
function stubFetch(overviewBody: typeof baseData, navCounts = { flaggedOpen: 0, failedJobs: overviewBody.systemHealth.failedJobs }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/nav-counts')) return jsonResponse(navCounts);
      return jsonResponse(overviewBody);
    }),
  );
}

function renderClient(initialData: typeof baseData, flaggedOpen = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OverviewClient initialData={initialData} flaggedOpen={flaggedOpen} />
    </QueryClientProvider>,
  );
}

describe('OverviewClient', () => {
  beforeEach(() => {
    stubFetch(baseData);
  });

  it('renders StatTiles from the fixture', () => {
    renderClient(baseData);

    expect(screen.getByText('Pending Outbox')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText("Today's API Cost")).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Email Health')).toBeInTheDocument();
    expect(screen.getByText('98%')).toBeInTheDocument();
  });

  it('shows the needs-attention strip with a failed-jobs link when failedJobs > 0', () => {
    renderClient({
      ...baseData,
      systemHealth: { ...baseData.systemHealth, failedJobs: 2 },
    });

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('2 failed job(s)')).toBeInTheDocument();
  });

  it('hides the needs-attention strip when every condition is clear', () => {
    renderClient(baseData);

    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it("renders a business row with the shared StatusBadge's status text", () => {
    renderClient(baseData);

    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('keeps the cached businesses table visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OverviewClient initialData={baseData} flaggedOpen={0} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await client.invalidateQueries({ queryKey: ['admin-overview', 0] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/overview failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
  });
});
