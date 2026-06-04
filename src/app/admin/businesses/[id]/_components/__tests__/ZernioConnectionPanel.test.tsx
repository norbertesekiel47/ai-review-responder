// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZernioConnectionPanel } from '../ZernioConnectionPanel';
import type { ZernioPanelData } from '@/app/admin/businesses/[id]/types';

const BUSINESS_ID = '33333333-3333-4333-8333-333333333333';
const RESPONSE_ID = '44444444-4444-4444-8444-444444444444';

function panelData(overrides: Partial<ZernioPanelData> = {}): ZernioPanelData {
  return {
    connection: {
      status: 'active',
      connectedAt: '2026-05-01T00:00:00.000Z',
      disconnectedAt: null,
      disconnectReason: null,
      lastError: null,
      lastErrorAt: null,
      zernioAccountId: 'zacct_1',
      zernioLocationId: 'zloc_1',
    },
    awaitingOwnerConnect: [
      {
        responseId: RESPONSE_ID,
        createdAt: '2026-05-20T00:00:00.000Z',
        draftText: 'Thanks for the kind words!',
        reviewerName: 'Jane D.',
        reviewText: 'Great service',
        starRating: 5,
      },
    ],
    unresolvedIncidents: [],
    ...overrides,
  };
}

describe('ZernioConnectionPanel — reconnect-queue actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('force-drains the queue when the connection is active', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, action: 'force_drain', queued: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const onChanged = vi.fn();

    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Force drain queue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/businesses/${BUSINESS_ID}/zernio-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'force_drain' }),
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('hides the force-drain button and shows a hint when not active', () => {
    render(
      <ZernioConnectionPanel
        businessId={BUSINESS_ID}
        zernio={panelData({
          connection: { ...panelData().connection!, status: 'disconnected' },
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Force drain queue' })).toBeNull();
    expect(screen.getByText(/Drain becomes available once the owner reconnects/i)).toBeInTheDocument();
  });

  it('dismisses a queued response after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, action: 'dismiss' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const onChanged = vi.fn();

    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/businesses/${BUSINESS_ID}/zernio-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', responseId: RESPONSE_ID }),
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('does not call the API when dismiss is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders an inline error and does not refetch on failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_awaiting' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const onChanged = vi.fn();
    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByText('not_awaiting')).toBeInTheDocument());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
