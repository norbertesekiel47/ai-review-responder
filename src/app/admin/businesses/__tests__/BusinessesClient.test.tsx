// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessesClient } from '../BusinessesClient';
import { BUSINESSES_PAGE_SIZE as PAGE_SIZE } from '@/app/admin/page-sizes';

type Props = Parameters<typeof BusinessesClient>[0];
type InitialData = Props['initialData'];

/**
 * The metric half of the BusinessSummary DTO the page receives (single owner:
 * src/lib/admin/business-summary.ts). Neutral values shared by the fixtures
 * that are not about the metric columns; `metricBusiness` below carries the
 * distinctive ones.
 */
const summaryMetrics = {
  pendingReconnectCount: 0,
  totalResponses: 0,
  completedResponses: 0,
  responseRate: 0,
  avgResponseTimeHours: null,
  lastActivity: null,
  churnScore: { score: 2, level: 'healthy' as const, breakdown: [] },
};

const oneBusiness: InitialData = {
  businesses: [
    {
      id: 'biz-1',
      name: 'Test Cafe',
      category: 'restaurant',
      subscriptionStatus: 'past_due',
      lastSyncAt: '2026-08-01T12:30:00.000Z',
      pendingApprovalCount: 3,
      ...summaryMetrics,
    },
  ],
  total: 1,
  responseMetricsWindowDays: 30,
  limit: PAGE_SIZE,
  offset: 0,
};

const multiPage: InitialData = {
  businesses: Array.from({ length: PAGE_SIZE }, (_, i) => ({
    id: `biz-${i}`,
    name: `Business ${i}`,
    category: null,
    subscriptionStatus: 'active',
    lastSyncAt: null,
    pendingApprovalCount: 0,
    ...summaryMetrics,
  })),
  total: 57,
  responseMetricsWindowDays: 30,
  limit: PAGE_SIZE,
  offset: 0,
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/**
 * The metric columns absorbed from Overview (spec §5.4). Three rows walk the
 * reconnect badge ladder (>= 3 red / > 0 grey / 0 em-dash) and both null
 * branches of Avg time and Last activity. Every asserted value is unique
 * across the whole table, so a getByText hit can only have come from the
 * column under test — except the em-dash, which is counted instead.
 *
 * `responseMetricsWindowDays` is deliberately NOT 30: the two window-labelled
 * headers must derive their N from the DTO, so a hardcoded `30` fails here.
 */
const metricBusinesses: InitialData = {
  businesses: [
    {
      id: 'biz-red',
      name: 'Metric Cafe',
      category: 'bakery',
      subscriptionStatus: 'active',
      lastSyncAt: '2026-08-01T12:30:00.000Z',
      pendingApprovalCount: 2,
      pendingReconnectCount: 4, // >= 3 → red
      totalResponses: 50,
      completedResponses: 41,
      responseRate: 82,
      avgResponseTimeHours: 6,
      lastActivity: minutesAgo(180),
      churnScore: { score: 71, level: 'at_risk' as const, breakdown: [] },
    },
    {
      id: 'biz-grey',
      name: 'Ladder Diner',
      category: 'diner',
      subscriptionStatus: 'active',
      lastSyncAt: '2026-08-02T12:30:00.000Z',
      pendingApprovalCount: 5,
      pendingReconnectCount: 1, // > 0 → grey
      totalResponses: 20,
      completedResponses: 11,
      responseRate: 55,
      avgResponseTimeHours: 12,
      lastActivity: minutesAgo(45),
      churnScore: { score: 33, level: 'watch' as const, breakdown: [] },
    },
    {
      id: 'biz-none',
      name: 'Quiet Bar',
      category: 'bar',
      subscriptionStatus: 'active',
      lastSyncAt: '2026-08-03T12:30:00.000Z',
      pendingApprovalCount: 0,
      pendingReconnectCount: 0, // 0 → em-dash
      totalResponses: 4,
      completedResponses: 4,
      responseRate: 100,
      avgResponseTimeHours: null, // → em-dash
      lastActivity: null, // → em-dash
      churnScore: { score: 3, level: 'healthy' as const, breakdown: [] },
    },
  ],
  total: 3,
  responseMetricsWindowDays: 14,
  limit: PAGE_SIZE,
  offset: 0,
};

const emptyData: InitialData = {
  businesses: [],
  total: 0,
  responseMetricsWindowDays: 30,
  limit: PAGE_SIZE,
  offset: 0,
};

function renderClient(initialData: InitialData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BusinessesClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

describe('BusinessesClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(oneBusiness), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  it("renders a business row with its name and the shared status badge's raw status", () => {
    renderClient(oneBusiness);

    expect(screen.getByText('Test Cafe')).toBeInTheDocument();
    // Shared StatusBadge renders the raw status (not the old "past due" label).
    expect(screen.getByText('past_due')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders the shared pagination footer for a multi-page result', () => {
    renderClient(multiPage);

    expect(screen.getByText('Showing 1–20 of 57')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('renders the metric columns absorbed from Overview', () => {
    renderClient(metricBusinesses);

    // Reconnect ladder: >= 3 is red, > 0 is grey, 0 is an em-dash.
    expect(screen.getByText('4').className).toContain('bg-red-100');
    expect(screen.getByText('1').className).toContain('bg-gray-100');
    // Three em-dashes total: the 0-reconnect cell plus Quiet Bar's null
    // Avg time and null Last activity. Every category here is non-null, so
    // nothing else contributes one.
    expect(screen.getAllByText('—')).toHaveLength(3);

    // Response rate.
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();

    // Avg time.
    expect(screen.getByText('6h')).toBeInTheDocument();
    expect(screen.getByText('12h')).toBeInTheDocument();

    // Last activity, relative.
    expect(screen.getByText('3h ago')).toBeInTheDocument();
    expect(screen.getByText('45m ago')).toBeInTheDocument();

    // Health renders through the shared HealthBadge (label + score).
    expect(screen.getByText('At Risk')).toBeInTheDocument();
    expect(screen.getByText('71')).toBeInTheDocument();
    expect(screen.getByText('Watch')).toBeInTheDocument();
    expect(screen.getByText('33')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();

    // Both window-labelled headers come from responseMetricsWindowDays, never
    // a literal 30.
    expect(screen.getByText('Response rate (14d)')).toBeInTheDocument();
    expect(screen.getByText('Avg time (14d)')).toBeInTheDocument();
    expect(screen.queryByText('Response rate (30d)')).not.toBeInTheDocument();
    expect(screen.queryByText('Avg time (30d)')).not.toBeInTheDocument();
  });

  it('renders the empty state when no businesses exist', () => {
    renderClient(emptyData);

    expect(screen.getByText('No businesses found')).toBeInTheDocument();
    expect(screen.getByText('Add one with + Add Business.')).toBeInTheDocument();
  });
});
