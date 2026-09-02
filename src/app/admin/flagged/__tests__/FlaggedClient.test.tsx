// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlaggedClient } from '../FlaggedClient';
import { FLAGGED_PAGE_SIZE as PAGE_SIZE } from '@/app/admin/page-sizes';

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

/** Two cards, so a per-card assertion has a neighbour to compare against. */
const twoCardData = {
  ...baseData,
  flagged: [
    baseData.flagged[0]!,
    { ...baseData.flagged[0]!, id: 'flag-2', businessName: 'Cafe Nero', responseText: 'Second draft.' },
  ],
  total: 2,
};

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderClient(initialData: typeof baseData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FlaggedClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

/** The card element that carries a given business name. */
function cardFor(businessName: string): HTMLElement {
  const card = screen.getByText(businessName).closest('div.rounded-lg');
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${businessName}`);
  return card;
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
  );
}

describe('FlaggedClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(baseData)));
  });

  it('renders a flagged card from the fixture', () => {
    renderClient(baseData);

    expect(screen.getByText('Bella Italia')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('Here is a full refund.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss as false positive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('renders the live-data provenance line with a refresh control (X6)', () => {
    renderClient(baseData);
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('renders the empty state when there are no open flags', () => {
    renderClient(emptyData);

    expect(screen.getByText('No open flagged responses')).toBeInTheDocument();
    expect(screen.getByText('Every held draft has been dispositioned.')).toBeInTheDocument();
  });

  it('gives Approve the primary treatment and the two held-draft actions the secondary one (X1)', () => {
    renderClient(baseData);
    expect(screen.getByRole('button', { name: 'Approve' }).className).toContain('bg-gray-900');
    expect(screen.getByRole('button', { name: 'Dismiss as false positive' }).className).toContain(
      'border-gray-300',
    );
    expect(screen.getByRole('button', { name: 'Regenerate' }).className).toContain('border-gray-300');
  });

  it('Approve states the consequence inline and needs a reason before the request can leave (X1)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseData));
    vi.stubGlobal('fetch', fetchMock);
    renderClient(baseData);

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(screen.getByText(/Sends the owner a notification with this draft/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Approve and notify owner' });
    expect(confirm).toBeDisabled();
    expect(postCalls(fetchMock)).toHaveLength(0);

    await userEvent.type(screen.getByLabelText(/Reason \(one line, required\)/), 'Verified with owner');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    const [url, init] = postCalls(fetchMock)[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/flagged');
    // The route's schema is `{flaggedId, action}` today; the reason is a
    // client-side gate and is deliberately NOT sent into a schema that strips it.
    expect(JSON.parse(init.body as string)).toEqual({
      flaggedId: 'flag-1',
      action: 'approved_for_owner_review',
    });
  });

  it('Dismiss and Regenerate confirm inline without a reason, and Cancel disarms without a request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(baseData));
    vi.stubGlobal('fetch', fetchMock);
    renderClient(baseData);

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(screen.getByText(/Discards this draft and generates a new one/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard and regenerate' })).toBeEnabled();
    expect(screen.queryByLabelText(/Reason/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Discard and regenerate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(postCalls(fetchMock)).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss as false positive' }));
    expect(screen.getByText(/Closes this flag without releasing the draft/)).toBeInTheDocument();
  });

  it('marks only the acted card and leaves its neighbour interactive while the POST is in flight (X2)', async () => {
    // The POST never settles, so the optimistic mark is what stays on screen.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>(() => {});
      return jsonResponse(twoCardData);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderClient(twoCardData);

    const first = cardFor('Bella Italia');
    await userEvent.click(within(first).getByRole('button', { name: 'Dismiss as false positive' }));
    await userEvent.click(within(first).getByRole('button', { name: 'Dismiss flag' }));

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    expect(within(first).getByText('Dismissed — flag closed.')).toBeInTheDocument();
    expect(within(first).queryAllByRole('button')).toHaveLength(0);
    expect(first).toHaveAttribute('aria-busy', 'true');

    const second = cardFor('Cafe Nero');
    expect(within(second).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(second).not.toHaveAttribute('aria-busy');
  });

  it('rolls the optimistic mark back onto the failed card and shows the server error there (X2)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ error: 'not_open' }, 409);
      return jsonResponse(twoCardData);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderClient(twoCardData);

    const first = cardFor('Bella Italia');
    await userEvent.click(within(first).getByRole('button', { name: 'Regenerate' }));
    await userEvent.click(within(first).getByRole('button', { name: 'Discard and regenerate' }));

    await waitFor(() => expect(within(first).getByRole('alert')).toHaveTextContent('not_open'));
    expect(within(first).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(within(cardFor('Cafe Nero')).queryByRole('alert')).toBeNull();
  });

  it('renders the shared pagination footer for a multi-page queue', () => {
    renderClient(fullPageData);

    expect(screen.getByText('Showing 1–50 of 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('keeps the footer reachable on an empty later page (dead-end guard)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ...baseData, flagged: [], total: 120, offset: PAGE_SIZE }),
    );
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
