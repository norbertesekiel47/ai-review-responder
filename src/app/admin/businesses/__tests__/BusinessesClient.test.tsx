// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  accountId: 'acct-1',
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
 * `responseMetricsWindowDays` is deliberately NOT 30: the window-labelled
 * header must derive its N from the DTO, so a hardcoded `30` fails here.
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
      accountId: 'acct-red',
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
      accountId: 'acct-grey',
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
      accountId: 'acct-none',
      pendingReconnectCount: 0, // 0 → em-dash
      totalResponses: 4,
      completedResponses: 4,
      responseRate: 100,
      avgResponseTimeHours: null, // → no sub-line
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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderClient(initialData: InitialData, initialFilters?: Props['initialFilters']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BusinessesClient initialData={initialData} initialFilters={initialFilters} />
    </QueryClientProvider>,
  );
}

function fetchUrls(): string[] {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
}

describe('BusinessesClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(oneBusiness)));
  });

  it('renders a business row with its name and the humanized status badge (X8)', () => {
    renderClient(oneBusiness);

    expect(screen.getByText('Test Cafe')).toBeInTheDocument();
    // The shared StatusBadge vocabulary, never the raw token. Scoped to the
    // table: the Status filter's <option>s echo the same labels above it.
    const table = within(screen.getByRole('table'));
    const badge = table.getByText('Past due');
    expect(badge).toHaveAttribute('data-vocab', 'subscription');
    expect(badge).not.toHaveAttribute('data-unmapped');
    expect(table.queryByText('past_due')).not.toBeInTheDocument();
    expect(table.getByText('3')).toBeInTheDocument();
  });

  it('renders the shared pagination footer for a multi-page result', () => {
    renderClient(multiPage);

    expect(screen.getByText('Showing 1–20 of 57')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('renders the metric columns, with Category and Avg time folded under their neighbours (X5)', () => {
    renderClient(metricBusinesses);

    // Reconnect ladder: >= 3 is red, > 0 is grey, 0 is an em-dash.
    expect(screen.getByText('4').className).toContain('bg-red-100');
    expect(screen.getByText('1').className).toContain('bg-gray-100');
    // Two em-dashes: the 0-reconnect cell and Quiet Bar's null Last activity.
    // A null Avg time renders NO sub-line rather than a dash.
    expect(screen.getAllByText('—')).toHaveLength(2);

    // Response rate, with the average folded underneath it.
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('avg 6h to reply')).toBeInTheDocument();
    expect(screen.getByText('avg 12h to reply')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();

    // Category rides under the name — still readable, no longer a column.
    expect(screen.getByText('bakery')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Category' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Avg time/ })).not.toBeInTheDocument();

    // Last activity, relative (RelativeTime captures now after mount — X29).
    expect(screen.getByText('3h ago')).toBeInTheDocument();
    expect(screen.getByText('45m ago')).toBeInTheDocument();

    // Health renders through the shared HealthBadge (label + score). Scoped to
    // the table because the Health filter's <option>s carry the same labels.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('At Risk')).toBeInTheDocument();
    expect(table.getByText('71')).toBeInTheDocument();
    expect(table.getByText('Watch')).toBeInTheDocument();
    expect(table.getByText('33')).toBeInTheDocument();
    expect(table.getByText('Healthy')).toBeInTheDocument();

    // The window-labelled header comes from responseMetricsWindowDays, never a
    // literal 30.
    expect(screen.getByText('Response rate (14d)')).toBeInTheDocument();
    expect(screen.queryByText('Response rate (30d)')).not.toBeInTheDocument();

    // Eight data columns (+ the View column).
    expect(screen.getAllByRole('columnheader')).toHaveLength(9);
  });

  // X30: the sticky header only sticks once something bounds the scroll body.
  it('bounds the table so its sticky header pins', () => {
    renderClient(oneBusiness);
    expect(screen.getByTestId('data-table-scroll')).toHaveStyle({ maxHeight: '70vh' });
  });

  it('renders the empty state when no businesses exist', () => {
    renderClient(emptyData);

    expect(screen.getByText('No businesses found')).toBeInTheDocument();
    expect(screen.getByText('Add one with + Add Business.')).toBeInTheDocument();
  });

  // ── X5: search + filter chips ────────────────────────────────────────

  it('debounces the name search into a server `q` param and shows the total noun', async () => {
    const user = userEvent.setup();
    renderClient(oneBusiness);
    expect(screen.getByText('1 businesses')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search businesses by name' }), 'Nor');

    await waitFor(() => {
      expect(fetchUrls().some((url) => url.includes('q=Nor'))).toBe(true);
    });
    // One request for the settled value, not one per keystroke.
    expect(fetchUrls().filter((url) => url.includes('q='))).toEqual([
      `/api/admin/businesses?limit=${PAGE_SIZE}&offset=0&q=Nor`,
    ]);
  });

  it('filters by status through a select, echoes it as a removable chip, and clears it', async () => {
    const user = userEvent.setup();
    renderClient(oneBusiness);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'past_due');

    await waitFor(() => {
      expect(fetchUrls().some((url) => url.includes('status=past_due'))).toBe(true);
    });
    expect(screen.getByText('Status: Past due')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove filter Status: Past due' }));
    expect(screen.queryByText('Status: Past due')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
  });

  it('filters by health level with the HealthBadge vocabulary', async () => {
    const user = userEvent.setup();
    renderClient(oneBusiness);

    const health = screen.getByRole('combobox', { name: 'Health' });
    expect(Array.from((health as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      'All health levels',
      'Healthy',
      'Watch',
      'At Risk',
    ]);
    await user.selectOptions(health, 'at_risk');

    await waitFor(() => {
      expect(fetchUrls().some((url) => url.includes('health=at_risk'))).toBe(true);
    });
    expect(screen.getByText('Health: At Risk')).toBeInTheDocument();
  });

  it('starts from the server-rendered filters without refetching (deep links)', () => {
    renderClient(oneBusiness, { search: 'Test', status: 'past_due' });

    expect(screen.getByRole('searchbox', { name: 'Search businesses by name' })).toHaveValue('Test');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('past_due');
    expect(screen.getByText('Status: Past due')).toBeInTheDocument();
    expect(screen.getByText('Test Cafe')).toBeInTheDocument();
    // initialData matched the filters, so nothing was fetched on mount.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says "no match" rather than "no businesses" when a filter is active', () => {
    renderClient(emptyData, { search: 'zzz' });

    expect(screen.getByText('No businesses match')).toBeInTheDocument();
    expect(screen.queryByText('No businesses found')).not.toBeInTheDocument();
  });
});
