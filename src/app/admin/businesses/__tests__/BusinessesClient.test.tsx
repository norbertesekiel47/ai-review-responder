// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessesClient } from '../BusinessesClient';
import { BUSINESSES_PAGE_SIZE as PAGE_SIZE } from '@/app/admin/page-sizes';

type Props = Parameters<typeof BusinessesClient>[0];
type InitialData = Props['initialData'];

const oneBusiness: InitialData = {
  businesses: [
    {
      id: 'biz-1',
      name: 'Test Cafe',
      category: 'restaurant',
      subscriptionStatus: 'past_due',
      lastSyncAt: '2026-08-01T12:30:00.000Z',
      pendingCount: 3,
    },
  ],
  total: 1,
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
    pendingCount: 0,
  })),
  total: 57,
  limit: PAGE_SIZE,
  offset: 0,
};

const emptyData: InitialData = { businesses: [], total: 0, limit: PAGE_SIZE, offset: 0 };

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

  it('renders the empty state when no businesses exist', () => {
    renderClient(emptyData);

    expect(screen.getByText('No businesses found')).toBeInTheDocument();
    expect(screen.getByText('Add one with + Add Business.')).toBeInTheDocument();
  });
});
