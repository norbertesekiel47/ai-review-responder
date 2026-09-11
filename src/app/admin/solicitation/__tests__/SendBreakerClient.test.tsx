// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREAKER_COMPLAINT_RATE,
  BREAKER_HARD_BOUNCE_RATE,
  BREAKER_MIN_SENDS,
  BREAKER_WINDOW_DAYS,
} from '@/lib/solicitation/send-breaker';
import { SendBreakerClient } from '../SendBreakerClient';

// Unit suite for the admin Send breaker panel (#898).
//
// The component is rendered inside its own QueryClient with retries off, and
// `fetch` is stubbed per case so the network is the only seam under control.
//
// The four locked cases are about the SHAPE of the control surface, not its
// styling:
//
//  1. A clear breaker renders NO reset control at all — not a disabled one.
//     There is nothing to reset, so a control that could be clicked (or
//     re-enabled from devtools) would be a lie about what the screen can do.
//  2. A tripped breaker shows the window that tripped it, each metric against
//     the threshold it breached — the reset decision is made from those three
//     numbers, so the panel has to carry them.
//  3. A blank or whitespace-only note NEVER reaches the network. 110's
//     reset_consistency CHECK rejects a note-less reset, so a request that got
//     out would surface a 23514 as a 500 rather than a field error.
//  4. A successful reset RE-READS the state. That refetch is the only reason
//     GET /api/admin/solicitation/breaker exists — the page server-renders the
//     first paint, so without it the panel would still show the cleared trip.

const TRIPPED = {
  open: true,
  trip: {
    id: '44444444-4444-4444-8444-444444444444',
    trippedAt: '2026-08-18T09:30:00.000Z',
    tripReason: 'hard_bounce_rate' as const,
    metrics: {
      sends: 2_000,
      hardBounces: 50,
      complaints: 2,
      // 50/2000 — over the 2% bar. 2/2000 — under the 0.3% bar. One breached
      // metric and one healthy one, so the alert styling is exercised in both
      // directions from a single fixture.
      hardBounceRate: 0.025,
      complaintRate: 0.001,
    },
  },
};

const CLEAR = { open: false, trip: null };

// The panel takes its thresholds as PROPS: `send-breaker.ts` instantiates a
// worker logger at module scope, so a client component that imports a runtime
// value from it drags `node:async_hooks` into the client chunk and fails the
// route build. `page.tsx` — a server component — reads the constants and hands
// them down. This suite sources them the same way rather than restating the
// four numbers, so the literal copy asserted below ("2.00%", "7 days", "100
// minimum", "0.30%") is checked against the ENFORCED values: move a threshold
// in send-breaker.ts and these expectations fail instead of quietly drifting
// away from what the send path actually stops on.
const THRESHOLDS = {
  windowDays: BREAKER_WINDOW_DAYS,
  minSends: BREAKER_MIN_SENDS,
  hardBounceRate: BREAKER_HARD_BOUNCE_RATE,
  complaintRate: BREAKER_COMPLAINT_RATE,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPanel(initialData?: typeof TRIPPED | typeof CLEAR) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SendBreakerClient initialData={initialData} thresholds={THRESHOLDS} />
    </QueryClientProvider>,
  );
  return { client, view };
}

function resetForm(): HTMLFormElement {
  const note = screen.getByLabelText(/reset note/i);
  const form = note.closest('form');
  if (!form) throw new Error('the reset form was not rendered');
  return form;
}

describe('SendBreakerClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('the send breaker panel renders no reset control when no trip is open', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(CLEAR));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel(CLEAR);

    expect(await screen.findByText('Breaker not tripped')).toBeInTheDocument();
    // ABSENT, not disabled: with no open trip there is nothing a reset could
    // act on, so the control does not exist on the screen at all.
    expect(screen.queryByRole('button', { name: /reset breaker/i })).toBeNull();
    expect(screen.queryByLabelText(/reset note/i)).toBeNull();
    expect(screen.queryByText('Tripped')).toBeNull();
  });

  it('the send breaker panel renders the tripping metric snapshot when a trip is open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TRIPPED)));

    renderPanel(TRIPPED);

    expect(await screen.findByText('Tripped')).toBeInTheDocument();
    // The reason names the breached metric, its threshold and the window.
    expect(
      screen.getByText(/Hard bounces exceeded 2\.00% of sends over the last 7 days/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Tripped Aug 18, 2026, 09:30 UTC')).toBeInTheDocument();

    // Sends, hard-bounce rate and complaint rate, each against its threshold.
    expect(screen.getByText('Sends · last 7 days')).toBeInTheDocument();
    expect(screen.getByText('2,000')).toBeInTheDocument();
    expect(screen.getByText('100 minimum before any rate is judged')).toBeInTheDocument();

    expect(screen.getByText('Hard bounce rate')).toBeInTheDocument();
    expect(screen.getByText('2.50%')).toBeInTheDocument();
    expect(screen.getByText('50 hard bounces · trips above 2.00%')).toBeInTheDocument();

    expect(screen.getByText('Complaint rate')).toBeInTheDocument();
    expect(screen.getByText('0.10%')).toBeInTheDocument();
    expect(screen.getByText('2 complaints · trips above 0.30%')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /reset breaker/i })).toBeInTheDocument();
  });

  it('the send breaker panel requires a note before it will submit a reset', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse(TRIPPED));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel(TRIPPED);

    const button = await screen.findByRole('button', { name: /reset breaker/i });
    expect(button).toBeDisabled();

    // Whitespace is not a note. The trimmed value is what both the button's
    // enablement and the submit handler read, so a spaces-only field stays
    // exactly as inert as an empty one.
    await user.type(screen.getByLabelText(/reset note/i), '   ');
    expect(button).toBeDisabled();

    // Submit the form directly — a disabled button cannot be clicked, and the
    // guard being tested is the handler's, not the button's.
    fireEvent.submit(resetForm());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the send breaker panel refetches the breaker state after a successful reset', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ reset: true, tripId: TRIPPED.trip.id });
      // The state AFTER the reset: the refetch is the only thing that can
      // replace the server-rendered trip with the cleared panel.
      return jsonResponse(CLEAR);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel(TRIPPED);

    await user.type(screen.getByLabelText(/reset note/i), '  ramp stage rolled back  ');
    await user.click(screen.getByRole('button', { name: /reset breaker/i }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Breaker reset.'),
    );
    // Only the trimmed note travels — the actor is fixed by the session and
    // the route rejects a body that names one.
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/solicitation/breaker/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'ramp stage rolled back' }),
    });
    // The re-read, and the cleared panel it produces.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/solicitation/breaker'),
    );
    expect(await screen.findByText('Breaker not tripped')).toBeInTheDocument();
  });

  it('surfaces a rejected reset inline and leaves the trip panel on screen', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse({ error: 'not_tripped' }, 409)
          : jsonResponse(TRIPPED),
      ),
    );

    renderPanel(TRIPPED);

    await user.type(screen.getByLabelText(/reset note/i), 'list suppressed');
    await user.click(screen.getByRole('button', { name: /reset breaker/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not_tripped'));
    expect(screen.getByText('Tripped')).toBeInTheDocument();
  });

  it('shows the loading skeleton and then a full error state when the first read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    // No initialData: the panel has nothing cached, so a failed first read is
    // a blank screen rather than a stale one — the blocking ErrorState.
    renderPanel();

    expect(await screen.findByText("Couldn't load the send breaker")).toBeInTheDocument();
    expect(
      screen.getByText('GET /api/admin/solicitation/breaker failed'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('keeps the cached panel visible and adds a last-refresh-failed notice when a background refetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TRIPPED)));
    const { client } = renderPanel(TRIPPED);

    expect(await screen.findByText('Tripped')).toBeInTheDocument();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await client.invalidateQueries({ queryKey: ['admin-send-breaker'] });

    await waitFor(() => expect(screen.getByText('Last refresh failed')).toBeInTheDocument());
    expect(
      screen.getByText(
        'GET /api/admin/solicitation/breaker failed — showing the last loaded data.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Tripped')).toBeInTheDocument();
  });
});
