// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsClient } from '../JobsClient';

const LONG_ERROR = `ZernioError: publish rejected — ${'x'.repeat(120)} (status 502)`;

const baseData = {
  outbox: { pending: 3, dispatching: 1, dispatched: 12, failed: 2, completedToday: 40 },
  failedJobs: [
    {
      id: 'job-1',
      topic: 'send_notification',
      lastError: 'boom',
      attempts: 2,
      maxAttempts: 5,
      createdAt: '2026-08-01T00:00:00.000Z',
      businessId: 'biz-1',
      businessName: 'Downtown Cafe',
    },
    {
      id: 'job-2',
      topic: 'publish_response',
      lastError: LONG_ERROR,
      attempts: 5,
      maxAttempts: 5,
      createdAt: '2026-08-02T00:00:00.000Z',
      businessId: null,
      businessName: null,
    },
  ],
  failedTotal: 2,
  failedTopics: ['publish_response', 'send_notification'],
  limit: 20,
  offset: 0,
  queueHealth: { unavailable: true as const },
  pool: null,
};

const emptyData = {
  ...baseData,
  failedJobs: [],
  failedTotal: 0,
  failedTopics: [],
};

function renderClient(initialData: typeof baseData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JobsClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

function fetchUrls(): string[] {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
}

describe('JobsClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(baseData), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
  });

  it('renders the five outbox StatTiles with their values', () => {
    renderClient(baseData);

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Dispatching')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Dispatched')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Completed Today')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it("renders a failed job's topic without showing paged footer math for a single short page", () => {
    renderClient(baseData);

    // Scoped to the table: the topic filter's <option> spells the same token.
    expect(within(screen.getByRole('table')).getByText('send_notification')).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  // ── X15 ──────────────────────────────────────────────────────────────

  it('links a failed job to its business and dashes a platform-wide one', () => {
    renderClient(baseData);

    expect(screen.getByRole('link', { name: 'Downtown Cafe' })).toHaveAttribute('href', '/admin/businesses/biz-1');
    // job-2 has no business: an em-dash in the Business column, not a broken link.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[1]).toHaveTextContent('—');
  });

  it('renders a short error in full and collapses a long one behind a disclosure with the full text', async () => {
    const user = userEvent.setup();
    renderClient(baseData);

    expect(screen.getByText('boom')).toBeInTheDocument();
    const summary = screen.getByText('show full error').closest('summary')!;
    expect(summary).toBeInTheDocument();
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText(LONG_ERROR)).toBeInTheDocument();
  });

  it('filters by topic through a select that lists the distinct failed topics, resetting to page 0', async () => {
    const user = userEvent.setup();
    renderClient(baseData);

    const select = screen.getByRole('combobox', { name: 'Filter failed jobs by topic' });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      '',
      'publish_response',
      'send_notification',
    ]);

    await user.selectOptions(select, 'publish_response');
    await waitFor(() => {
      expect(fetchUrls()).toContain('/api/admin/jobs?limit=20&offset=0&topic=publish_response');
    });
  });

  it('says retry is CLI-only and points at the runbook', () => {
    renderClient(baseData);
    expect(screen.getByText(/Retrying is CLI-only/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'runbook' })).toHaveAttribute('href', '/admin/runbook');
  });

  it('bounds the failed-jobs table so its header sticks', () => {
    renderClient(baseData);
    expect(screen.getByTestId('data-table-scroll')).toHaveStyle({ maxHeight: '70vh' });
  });

  // ── X16 ──────────────────────────────────────────────────────────────

  it('shows only non-zero queue states, keeping failed and delayed visible even at zero', () => {
    renderClient({
      ...baseData,
      queueHealth: {
        'response-generation': { waiting: 0, active: 2, delayed: 0, failed: 0, completed: 0, paused: 0 },
        publisher: { waiting: 4, active: 0, delayed: 1, failed: 3, completed: 900, paused: 0 },
      },
    } as unknown as typeof baseData);

    const generation = screen.getByText('response-generation').closest('div')!;
    const generationStates = Array.from(generation.querySelectorAll('li')).map((li) => li.textContent);
    expect(generationStates).toEqual(['active2', 'delayed0', 'failed0']);

    const publisher = screen.getByText('publisher').closest('div')!;
    const publisherStates = Array.from(publisher.querySelectorAll('li')).map((li) => li.textContent);
    expect(publisherStates).toEqual(['waiting4', 'delayed1', 'failed3', 'completed900']);
    // Failed and delayed carry colour; completed does not.
    const failedPill = Array.from(publisher.querySelectorAll('li')).find((li) => li.textContent === 'failed3')!;
    expect(failedPill.className).toContain('bg-red-50');
    expect(failedPill.className).toContain('font-semibold');
    const completedPill = Array.from(publisher.querySelectorAll('li')).find((li) => li.textContent === 'completed900')!;
    expect(completedPill.className).not.toMatch(/red|yellow/);
  });

  it('renders the empty state when there are no failed jobs', () => {
    renderClient(emptyData);

    expect(screen.getByText('No failed jobs')).toBeInTheDocument();
    expect(screen.getByText('Nothing is stuck right now.')).toBeInTheDocument();
  });

  it('keeps the cached failed-jobs table visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <JobsClient initialData={baseData} />
      </QueryClientProvider>,
    );

    expect(within(screen.getByRole('table')).getByText('send_notification')).toBeInTheDocument();

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await client.invalidateQueries({ queryKey: ['admin-jobs', 0, ''] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/jobs failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('send_notification')).toBeInTheDocument();
  });
});
