// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostsClient } from '../CostsClient';

const baseData = {
  days: 30,
  totalBusinesses: 1,
  limit: 20,
  offset: 0,
  byProvider: [{ provider: 'openai', totalUsd: 12.5, callCount: 40 }],
  byBusiness: [
    {
      businessId: 'biz-1',
      businessName: 'Acme Coffee',
      subscriptionTier: 'copilot' as const,
      totalUsd: 12.5,
      callCount: 40,
      todayUsd: 1.25,
      dailyLimitUsd: 10,
      pctOfDailyLimit: 13,
    },
  ],
  byDay: [{ day: '2026-08-01', totalUsd: 12.5, callCount: 40 }],
  todayTotalUsd: 1.25,
  globalDailyLimitUsd: 100,
  margin: {
    windowDays: 30,
    platform: {
      totalRevenueUsd: 5000,
      variableApiCogsUsd: 1000,
      grossMarginPct: 80,
      riskLevel: 'none' as const,
      note: 'API/LLM COGS only.',
    },
    topAccountsByCost: [
      {
        accountId: 'acct-1',
        displayName: 'Acme HQ',
        subscriptionTier: 'copilot' as const,
        subscriptionStatus: 'active',
        mrrUsd: 99,
        variableApiCostUsd: 8.75,
        costPctOfMrr: 8.8,
        riskLevel: 'none' as const,
        responseCount: 40,
        avgCostPerResponseUsd: 0.3125,
        openaiCount: 40,
        anthropicCount: 0,
        fallbackRatePct: 0,
        flaggedCount: 0,
        flaggedRatePct: 0,
      },
    ],
    thresholds: {
      accountWarningPct: 25,
      accountActionPct: 40,
      platformWarningPct: 70,
      platformActionPct: 60,
    },
  },
};

const noMarginData = { ...baseData, margin: null };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type InitialData = Parameters<typeof CostsClient>[0]['initialData'];

function renderClient(initialData: InitialData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CostsClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

describe('CostsClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(baseData)));
  });

  it('renders period totals and a business row from the fixture', () => {
    renderClient(baseData);

    expect(screen.getByText("Today's Platform Spend")).toBeInTheDocument();
    expect(screen.getByText('$1.25 / $100.00')).toBeInTheDocument();
    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
    // X20: ONE precision on the page. The provider and day tables used to say
    // $12.5000 beside the business table's $12.50 — three cells, one number.
    expect(screen.getAllByText('$12.50')).toHaveLength(3);
    expect(screen.queryByText(/\$\d+\.\d{4}/)).not.toBeInTheDocument();
  });

  // X20: the day column is a UTC date through the shared formatter, labelled in the header.
  it('formats By Day dates through formatAdminDate with the zone on the header', () => {
    renderClient(baseData);

    expect(screen.getByRole('columnheader', { name: 'Date (UTC)' })).toBeInTheDocument();
    expect(screen.getByText('Aug 1, 2026')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-01')).not.toBeInTheDocument();
  });

  // X9: risk and tier render through the shared StatusBadge vocabularies.
  it('renders risk and tier through StatusBadge', () => {
    renderClient(baseData);

    const risks = screen.getAllByText('OK');
    expect(risks).toHaveLength(2); // platform card + the account row
    for (const badge of risks) expect(badge).toHaveAttribute('data-vocab', 'marginRisk');
    const tiers = screen.getAllByText('Copilot');
    expect(tiers).toHaveLength(2); // business row + account row
    for (const badge of tiers) expect(badge).toHaveAttribute('data-vocab', 'tier');
  });

  // X19: no row tint, and the three ratio columns wait behind a toggle.
  it('drops the risk row tint and keeps the ratio columns behind "Show ratios"', async () => {
    const user = userEvent.setup();
    renderClient({
      ...baseData,
      margin: {
        ...baseData.margin,
        topAccountsByCost: [{ ...baseData.margin.topAccountsByCost[0]!, riskLevel: 'action' as const, costPctOfMrr: 44 }],
      },
    });

    const row = screen.getByText('Acme HQ').closest('tr')!;
    expect(row.className).not.toMatch(/bg-red-50|bg-yellow-50/);
    // The Risk badge carries the verdict on its own.
    expect(within(row).getByText('Action')).toHaveAttribute('data-vocab', 'marginRisk');

    expect(screen.queryByRole('columnheader', { name: '$/Response' })).not.toBeInTheDocument();
    expect(screen.queryByText('$0.31')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show ratios' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide ratios' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('columnheader', { name: '$/Response' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Fallback %' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Flagged %' })).toBeInTheDocument();
    // Same cents precision as everything else on the page (X20).
    expect(within(row).getByText('$0.31')).toBeInTheDocument();
  });

  it('renders without the margin section and without crashing when margin is null', () => {
    renderClient(noMarginData);

    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
    expect(screen.queryByText('Margin & Gross-Margin Risk')).not.toBeInTheDocument();
    expect(screen.queryByText('Top Accounts by API Cost')).not.toBeInTheDocument();
  });

  it('keeps the cached table visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CostsClient initialData={baseData} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await client.invalidateQueries({ queryKey: ['admin-costs', 30, 0] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/costs?days=30 failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme Coffee')).toBeInTheDocument();
  });
});
