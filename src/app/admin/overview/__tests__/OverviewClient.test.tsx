// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverviewData } from '@/lib/admin/overview-service';
import { OverviewClient } from '../OverviewClient';

const baseData: OverviewData = {
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
  atRisk: [
    {
      id: 'biz-1',
      name: 'Acme Coffee',
      category: 'Cafe',
      subscriptionStatus: 'active',
      lastSyncAt: null,
      pendingApprovalCount: 0,
      pendingReconnectCount: 0,
      totalResponses: 10,
      completedResponses: 8,
      responseRate: 80,
      avgResponseTimeHours: 2.5,
      lastActivity: null,
      churnScore: { score: 74, level: 'at_risk', breakdown: [] },
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
function stubFetch(overviewBody: OverviewData, navCounts = { flaggedOpen: 0, failedJobs: overviewBody.systemHealth.failedJobs }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/nav-counts')) return jsonResponse(navCounts);
      return jsonResponse(overviewBody);
    }),
  );
}

function renderClient(initialData: OverviewData, flaggedOpen = 0) {
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

  it('renders an at-risk row with the shared HealthBadge, linking to the business detail page', () => {
    renderClient(baseData);

    const row = screen.getByRole('link', { name: /Acme Coffee/ });
    expect(row).toHaveAttribute('href', '/admin/businesses/biz-1');
    expect(row).toHaveTextContent('At Risk');
    expect(row).toHaveTextContent('74');
  });

  it('renders the at-risk heading with the eligible count and the total', () => {
    // N is the eligible (filtered-then-capped) count, M the unfiltered total —
    // "2 of 9", never "9 of 9" or "2 of 2".
    renderClient({
      ...baseData,
      totalBusinesses: 9,
      atRisk: [
        baseData.atRisk[0]!,
        {
          ...baseData.atRisk[0]!,
          id: 'biz-2',
          name: 'North Ave Dental',
          churnScore: { score: 55, level: 'watch', breakdown: [] },
        },
      ],
    });

    expect(screen.getByText('At risk (2 of 9)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all →' })).toHaveAttribute(
      'href',
      '/admin/businesses',
    );
  });

  it('renders the EmptyState when no business is at risk', () => {
    renderClient({ ...baseData, totalBusinesses: 12, atRisk: [] });

    expect(screen.getByText('Nothing at risk')).toBeInTheDocument();
    expect(screen.getByText('Every business is scoring healthy right now.')).toBeInTheDocument();
    // The heading still reports the unfiltered total, so "0 of 12" reads as
    // "none of your 12 businesses need a look" rather than "no businesses".
    expect(screen.getByText('At risk (0 of 12)')).toBeInTheDocument();
    expect(screen.queryByText('Acme Coffee')).not.toBeInTheDocument();
  });

  it('keeps the cached at-risk list visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
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
    await client.invalidateQueries({ queryKey: ['admin-overview'] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/overview failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
  });
});
