// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlaggedClient, PAGE_SIZE } from '../FlaggedClient';

const baseData = {
  flagged: [
    {
      id: 'flag-1',
      responseId: 'resp-1',
      businessId: 'biz-1',
      accountId: 'acct-1',
      reviewId: 'rev-1',
      source: 'local_regex',
      reason: 'refund_discount',
      severity: 'high',
      status: 'open',
      createdAt: '2026-05-26T00:00:00.000Z',
      responseText: 'Here is a full refund.',
      version: 1,
      reviewerName: 'Jane',
      starRating: 2,
      businessName: 'Bella Italia',
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

const emptyData = { ...baseData, flagged: [], total: 0 };

/** A full first page of a 120-row queue — exercises the shared pagination footer. */
const fullPageData = {
  ...baseData,
  flagged: Array.from({ length: PAGE_SIZE }, (_, i) => ({
    ...baseData.flagged[0]!,
    id: `flag-${i + 1}`,
    businessName: `Business ${i + 1}`,
  })),
  total: 120,
};

function renderClient(initialData: typeof baseData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FlaggedClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

describe('FlaggedClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(baseData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );
  });

  it('renders a flagged card from the fixture', () => {
    renderClient(baseData);

    expect(screen.getByText('Bella Italia')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('Here is a full refund.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve (notify owner)' })).toBeInTheDocument();
  });

  it('renders the empty state when there are no open flags', () => {
    renderClient(emptyData);

    expect(screen.getByText('No open flagged responses')).toBeInTheDocument();
    expect(screen.getByText('Every held draft has been dispositioned.')).toBeInTheDocument();
  });

  it('renders the shared pagination footer for a multi-page queue', () => {
    renderClient(fullPageData);

    expect(screen.getByText('Showing 1–50 of 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('keeps the footer reachable on an empty later page (dead-end guard)', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ...baseData, flagged: [], total: 120, offset: PAGE_SIZE }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    renderClient(fullPageData);

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      expect(screen.getByText('No rows on this page (120 total)')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    // Guards the offset⇄page conversion at the footer boundary: page 1 must
    // request offset=PAGE_SIZE. An off-by-one is otherwise invisible here,
    // because the stubbed fetch answers every URL identically.
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/flagged?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}`,
    );
  });

  it('keeps the cached cards visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <FlaggedClient initialData={baseData} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Bella Italia')).toBeInTheDocument();

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await client.invalidateQueries({ queryKey: ['admin-flagged', 0] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/flagged failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Bella Italia')).toBeInTheDocument();
  });
});
