// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OffboardingsClient, needsDisposition } from '../OffboardingsClient';
import { OFFBOARDINGS_PAGE_SIZE as PAGE_SIZE } from '@/app/admin/page-sizes';

type Props = Parameters<typeof OffboardingsClient>[0];
type InitialData = Props['initialData'];
type Offboarding = InitialData['offboardings'][number];

function offboarding(overrides: Partial<Offboarding> = {}): Offboarding {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    accountId: '11111111-1111-4111-8111-111111111111',
    accountName: 'Acme Dental',
    subscriptionStatus: 'cancelled',
    mode: 'delete_data',
    status: 'scheduled',
    failedStep: null,
    lastError: null,
    requestedAt: '2026-06-01T12:00:00.000Z',
    accessEndsAt: '2026-06-08T12:00:00.000Z',
    teardownStartedAt: null,
    teardownCompletedAt: null,
    purgeAfter: null,
    purgeStartedAt: null,
    purgeCancelledAt: null,
    purgedAt: null,
    terminalAt: null,
    retryCount: 0,
    isStuck: false,
    providerSteps: {
      stripe: 'success',
      zernioAccounts: 'not_applicable',
      zernioProfiles: 'not_applicable',
      locationArchival: 'success',
      jobTerminalization: 'success',
    },
    providerDispositions: [],
    ...overrides,
  };
}

function dataFor(offboardings: Offboarding[], total = offboardings.length): InitialData {
  return { offboardings, total, limit: PAGE_SIZE, offset: 0 };
}

function renderClient(initialData: InitialData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OffboardingsClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

describe('OffboardingsClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(dataFor([offboarding()])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  it('renders a card with the account name, its mode/status/subscription through StatusBadge, and the stuck tone', () => {
    renderClient(dataFor([offboarding({ isStuck: true })]));

    expect(screen.getByText('Acme Dental')).toBeInTheDocument();
    // X8: mode, status and subscription come from the shared vocabularies —
    // humanized labels, never `delete_data` / `scheduled` / `cancelled` raw.
    expect(screen.getByText('Delete data')).toHaveAttribute('data-vocab', 'offboardingMode');
    expect(screen.getByText('Scheduled')).toHaveAttribute('data-vocab', 'offboarding');
    expect(screen.getByText('Cancelled')).toHaveAttribute('data-vocab', 'subscription');
    expect(screen.queryByText('delete data')).not.toBeInTheDocument();
    expect(screen.queryByText(/Subscription cancelled/)).not.toBeInTheDocument();
    // `stuck` is a derived flag with no stored value: still a tone badge.
    expect(screen.getByText('stuck')).toBeInTheDocument();
  });

  // X22: the disposition form is a manual cleanup record, not something every
  // healthy lifecycle needs on screen.
  it('hides the disposition form behind a button on a healthy lifecycle and reveals it on click', async () => {
    const user = userEvent.setup();
    renderClient(dataFor([offboarding()]));

    expect(screen.queryByText('Record Provider Disposition')).not.toBeInTheDocument();
    const reveal = screen.getByRole('button', { name: 'Record disposition…' });
    expect(reveal).toHaveAttribute('aria-expanded', 'false');

    await user.click(reveal);

    expect(screen.getByText('Record Provider Disposition')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Record Provider Disposition')).not.toBeInTheDocument();
  });

  it.each([
    ['stuck', offboarding({ isStuck: true })],
    ['failed', offboarding({ status: 'failed', failedStep: 'teardown' })],
  ])('opens the disposition form by default for a %s lifecycle', (_label, item) => {
    expect(needsDisposition(item)).toBe(true);
    renderClient(dataFor([item]));

    expect(screen.getByText('Record Provider Disposition')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record disposition…' })).not.toBeInTheDocument();
  });

  it('needsDisposition is false for a scheduled, unstuck lifecycle', () => {
    expect(needsDisposition(offboarding())).toBe(false);
  });

  it('renders a failed offboarding with its danger badges and scrubbed last error', () => {
    renderClient(
      dataFor([
        offboarding({
          status: 'failed',
          failedStep: 'teardown',
          lastError: 'zernio rejected: Bearer [redacted]',
        }),
      ]),
    );

    expect(screen.getByText('Failed')).toHaveAttribute('data-vocab', 'offboarding');
    expect(screen.getByText('failed: teardown')).toBeInTheDocument();
    expect(screen.getByText(/zernio rejected: Bearer \[redacted\]/)).toBeInTheDocument();
  });

  it('renders the shared pagination footer for a multi-page result', () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) =>
      offboarding({ id: `off-${i}`, accountName: `Account ${i}` }),
    );

    renderClient(dataFor(rows, 120));

    expect(screen.getByText(`Showing 1–${PAGE_SIZE} of 120`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('renders the empty state when nothing is offboarding', () => {
    renderClient(dataFor([]));

    expect(screen.getByText('No active offboardings')).toBeInTheDocument();
  });
});
