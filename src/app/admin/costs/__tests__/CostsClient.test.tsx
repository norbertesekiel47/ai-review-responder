// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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

function renderClient(initialData: typeof baseData | typeof noMarginData) {
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
    expect(screen.getByText('$12.50')).toBeInTheDocument();
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
