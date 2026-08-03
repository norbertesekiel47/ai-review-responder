// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsClient } from '../NotificationsClient';

const baseData = {
  notifications: [
    {
      id: 'nd-1',
      businessName: 'Downtown',
      channel: 'email',
      recipient: 'owner@example.com',
      template: 'approval_request',
      sentAt: '2026-08-01T00:00:00.000Z',
      deliveredAt: '2026-08-01T00:01:00.000Z',
      failedAt: null,
      failureReason: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    {
      id: 'nd-2',
      businessName: 'Uptown',
      channel: 'email',
      recipient: 'owner2@example.com',
      template: 'weekly_digest',
      sentAt: '2026-08-01T00:00:00.000Z',
      deliveredAt: null,
      failedAt: '2026-08-01T00:02:00.000Z',
      failureReason: 'mailbox full',
      createdAt: '2026-08-01T00:00:00.000Z',
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
  businesses: [
    { id: 'loc-1', name: 'Downtown' },
    { id: 'loc-2', name: 'Uptown' },
  ],
};

function renderClient(initialData: typeof baseData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationsClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

describe('NotificationsClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(baseData), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  it('renders the delivered badge for a delivered row', () => {
    renderClient(baseData);

    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('delivered')).toBeInTheDocument();
  });

  it("renders the failed row's status cell with a title carrying the failure reason", () => {
    renderClient(baseData);

    const failedBadge = screen.getByText('failed');
    expect(failedBadge.closest('span[title]')).toHaveAttribute('title', 'mailbox full');
  });

  it('keeps the cached table visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NotificationsClient initialData={baseData} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('owner@example.com')).toBeInTheDocument();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await client.invalidateQueries({ queryKey: ['admin-notifications', 0, '', '', ''] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/notifications failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
  });
});
