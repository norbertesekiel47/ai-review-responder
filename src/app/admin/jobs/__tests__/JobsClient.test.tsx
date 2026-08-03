// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsClient } from '../JobsClient';

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
    },
  ],
  failedTotal: 1,
  limit: 20,
  offset: 0,
  queueHealth: { unavailable: true as const },
  pool: null,
};

const emptyData = {
  ...baseData,
  failedJobs: [],
  failedTotal: 0,
};

function renderClient(initialData: typeof baseData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JobsClient initialData={initialData} />
    </QueryClientProvider>,
  );
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

    expect(screen.getByText('send_notification')).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
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

    expect(screen.getByText('send_notification')).toBeInTheDocument();

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await client.invalidateQueries({ queryKey: ['admin-jobs', 0] });

    await waitFor(() => {
      expect(screen.getByText('Last refresh failed')).toBeInTheDocument();
    });
    expect(
      screen.getByText('GET /api/admin/jobs failed — showing the last loaded data.'),
    ).toBeInTheDocument();
    expect(screen.getByText('send_notification')).toBeInTheDocument();
  });
});
