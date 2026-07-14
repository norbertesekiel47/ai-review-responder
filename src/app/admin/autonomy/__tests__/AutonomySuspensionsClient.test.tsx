// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomySuspensionsClient } from '../AutonomySuspensionsClient';

const suspension = {
  policyId: 'policy-1',
  accountId: '11111111-1111-4111-8111-111111111111',
  accountName: 'Northstar Dental',
  locationId: null,
  locationName: null,
  scope: 'account' as const,
  suspendedReason: 'A safety review flagged a recently auto-posted reply.',
  trigger: 'judge_flag' as const,
  suspendedAt: '2026-07-13T12:00:00.000Z',
  governorRates: {
    edit: { numerator: 3, denominator: 5, rate: 0.6 },
    veto: { numerator: 1, denominator: 10, rate: 0.1 },
    judgeSignal: { numerator: 4, denominator: 10, rate: 0.4 },
  },
  recentFlagVerdicts: [{
    id: 'verdict-1',
    businessId: '33333333-3333-4333-8333-333333333333',
    reviewId: 'review-1',
    responseId: 'response-1',
    reasons: ['unsafe_or_policy_violation'],
    createdAt: '2026-07-12T09:00:00.000Z',
  }],
};

const locationSuspension = {
  ...suspension,
  policyId: 'policy-2',
  locationId: '33333333-3333-4333-8333-333333333333',
  locationName: 'West Clinic',
  scope: 'location' as const,
  recentFlagVerdicts: [],
};

function renderClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AutonomySuspensionsClient />
    </QueryClientProvider>,
  );
}

describe('AutonomySuspensionsClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders suspension scope, current rates, and recent flag evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ suspensions: [suspension, locationSuspension] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    renderClient();

    expect(await screen.findAllByText('Northstar Dental')).toHaveLength(2);
    expect(screen.getByText(/West Clinic/)).toBeInTheDocument();
    expect(screen.getAllByText(/judge flag/i)).toHaveLength(2);
    expect(screen.getAllByText(/edit 60\.0% \(3\/5\)/i)).toHaveLength(2);
    expect(screen.getByText(/unsafe or policy violation/i)).toBeInTheDocument();
    expect(screen.getByText(/response-1/i)).toBeInTheDocument();
  });

  it.each([
    { rearmed: true, toast: 'Auto-posting is armed again.' },
    { rearmed: false, toast: 'Suspension cleared; policy remains manual.' },
  ])('submits a trimmed admin note and announces the $toast outcome', async ({ rearmed, toast }) => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ rearmed }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ suspensions: [suspension] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderClient();

    const note = await screen.findByLabelText(/unsuspend note for northstar dental/i);
    const button = screen.getByRole('button', { name: /unsuspend northstar dental/i });
    expect(button).toBeDisabled();
    await user.type(note, '  Reviewed with owner.  ');
    await user.click(button);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(toast));
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/autonomy/unsuspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: suspension.accountId,
        note: 'Reviewed with owner.',
      }),
    });
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
