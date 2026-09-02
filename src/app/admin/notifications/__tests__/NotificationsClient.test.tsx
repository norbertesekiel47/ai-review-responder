// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_IDS } from '@/lib/notifications/channels/types';
import { NotificationsClient, BUSINESS_PICKER_COMBOBOX_THRESHOLD } from '../NotificationsClient';

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

function fetchUrls(): string[] {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
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

  it('renders the humanized delivered badge for a delivered row', () => {
    renderClient(baseData);

    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    // Scoped to the table: the Status filter's <option>s echo the same labels.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Delivered')).toHaveAttribute('data-vocab', 'delivery');
    expect(table.queryByText('delivered')).not.toBeInTheDocument();
  });

  // X18: visible, not a hover title.
  it("renders a failed row's failure reason as a visible secondary line", () => {
    renderClient(baseData);

    expect(within(screen.getByRole('table')).getByText('Failed')).toBeInTheDocument();
    const reason = screen.getByText('mailbox full');
    expect(reason).toBeVisible();
    expect(reason.className).toContain('text-red-700');
    expect(document.querySelector('span[title="mailbox full"]')).toBeNull();
  });

  // X17: the channel filter is derived from the single owner, not a hand list.
  it('offers every channel from CHANNEL_IDS and forwards the chosen one', async () => {
    const user = userEvent.setup();
    renderClient(baseData);

    const channel = screen.getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement;
    expect(Array.from(channel.options).map((o) => o.value)).toEqual(['', ...CHANNEL_IDS]);
    expect(Array.from(channel.options).map((o) => o.textContent)).toEqual([
      'All Channels',
      'Email',
      'Telegram',
      'WhatsApp',
    ]);

    await user.selectOptions(channel, 'telegram');
    await waitFor(() => {
      expect(fetchUrls().some((url) => url.includes('channel=telegram'))).toBe(true);
    });
  });

  it('uses a plain select for the business filter up to the threshold', async () => {
    const user = userEvent.setup();
    renderClient(baseData);

    const picker = screen.getByRole('combobox', { name: 'Business' });
    expect(picker.tagName).toBe('SELECT');
    await user.selectOptions(picker, 'loc-2');
    await waitFor(() => {
      expect(fetchUrls().some((url) => url.includes('business_id=loc-2'))).toBe(true);
    });
  });

  it('switches to a type-to-search combobox above the threshold, resolving a name to its id', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: BUSINESS_PICKER_COMBOBOX_THRESHOLD + 1 }, (_, i) => ({
      id: `loc-${i}`,
      name: `Business ${i}`,
    }));
    renderClient({ ...baseData, businesses: many });

    const picker = screen.getByRole('combobox', { name: 'Business' });
    expect(picker.tagName).toBe('INPUT');
    expect(picker).toHaveAttribute('list');
    expect(document.querySelectorAll('datalist option')).toHaveLength(many.length);

    await user.type(picker, 'Business 7');
    await waitFor(() => {
      expect(fetchUrls().some((url) => url.includes('business_id=loc-7'))).toBe(true);
    });

    // Reset clears the typed text too.
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('combobox', { name: 'Business' })).toHaveValue('');
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
