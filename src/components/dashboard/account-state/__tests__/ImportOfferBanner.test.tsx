// @vitest-environment jsdom
//
// src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx
//
// T0 EVAL suite for #677 — titles 49–54 and 68 of the intake's 69, authored
// VERBATIM before implementation and filled in by T5.
//
// RTL, following src/components/dashboard/__tests__/ConnectGoogleBanner.test.tsx —
// the banner this one sits beside in the same dashboard slot.
//
// THE EVAL BAR FOR A UI SLICE (plan §3 T0, bar item 4): a banner test that only
// asserts rendered copy passes against a DEAD component. So these titles drive
// the buttons and assert the POST BODY and the POST-RESPONSE state, not the
// markup. Title 51 is the specific trap: an optimistic flip to `importing` before
// the request succeeds would satisfy a naive "shows importing after click"
// assertion while silently telling the owner an import started that never did.
//
// Copy is LOCKED verbatim (owner decision 6, plan T5), including the 7-day
// disclosure and the mandatory reassurance line. The reassurance exists so that
// declining does not read as "reviews stop being handled": new reviews are still
// handled automatically either way.
//
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportOfferBanner, type ImportOfferState } from '../ImportOfferBanner';

const LOCATION_ID = '22222222-2222-4222-8222-222222222222';

let fetchMock: ReturnType<typeof vi.fn>;

/** Queue of GET responses; the last one repeats so polling has something to read. */
function mockGetSequence(states: ImportOfferState[]): void {
  let i = 0;
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    const state = states[Math.min(i, states.length - 1)]!;
    i += 1;
    return { ok: true, json: async () => state } as Response;
  });
}

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportOfferBanner locationId={LOCATION_ID} />
    </QueryClientProvider>,
  );
}

function postCalls(): RequestInit[] {
  return fetchMock.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => c[1] as RequestInit);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImportOfferBanner', () => {
  it('ImportOfferBanner renders the one-time import wording and the automatic-handling reassurance', async () => {
    mockGetSequence([{ state: 'offer', expiresAt: '2026-08-14T00:00:00.000Z' }]);

    renderBanner();

    expect(await screen.findByText('Import your recent reviews?')).toBeInTheDocument();
    expect(
      screen.getByText(/100 most recent Google reviews from the past year/i),
    ).toBeInTheDocument();
    // "Nothing gets posted" is the promise that makes the offer safe to accept.
    expect(screen.getByText(/Nothing gets posted/i)).toBeInTheDocument();
    // The 7-day disclosure and the MANDATORY reassurance line, both locked copy.
    expect(screen.getByText(/one-time import, available for the next 7 days/i)).toBeInTheDocument();
    expect(
      screen.getByText(/New reviews will still be handled automatically either way/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import my reviews/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no thanks/i })).toBeInTheDocument();
  });

  it('ImportOfferBanner renders nothing when no import offer is pending', async () => {
    mockGetSequence([{ state: 'none' }]);

    const { container } = renderBanner();

    // Self-nulls, exactly like ConnectGoogleBanner. Wait for the query to settle
    // so this cannot pass merely because the first paint is empty.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.banner')).toBeNull());
  });

  it('ImportOfferBanner posts the accept decision and only shows importing after the request succeeds', async () => {
    // THE OPTIMISTIC-FLIP TRAP. The GET keeps returning `offer` until the POST
    // resolves, so a component that flipped state locally on click would show
    // `importing` while the server still says `offer` — and this asserts it does
    // NOT, by checking the offer copy survives right up to the POST.
    let resolvePost: (() => void) | undefined;
    const postGate = new Promise<void>((r) => { resolvePost = r; });
    let posted = false;

    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await postGate;
        posted = true;
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return {
        ok: true,
        json: async (): Promise<ImportOfferState> =>
          posted ? { state: 'importing' } : { state: 'offer', expiresAt: '2026-08-14T00:00:00.000Z' },
      } as Response;
    });

    renderBanner();
    const accept = await screen.findByRole('button', { name: /import my reviews/i });
    await userEvent.click(accept);

    // Request in flight: still the offer, NOT importing.
    expect(screen.getByText('Import your recent reviews?')).toBeInTheDocument();
    expect(screen.queryByText(/Importing your reviews/i)).not.toBeInTheDocument();

    resolvePost!();

    expect(await screen.findByText(/Importing your reviews/i)).toBeInTheDocument();

    // And the POST body carried the decision — the assertion that a dead button
    // cannot satisfy.
    expect(postCalls()).toHaveLength(1);
    expect(JSON.parse(postCalls()[0]!.body as string)).toEqual({ decision: 'accepted' });
  });

  it('ImportOfferBanner posts the decline decision and stops rendering', async () => {
    let posted = false;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted = true;
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return {
        ok: true,
        json: async (): Promise<ImportOfferState> =>
          posted ? { state: 'none' } : { state: 'offer', expiresAt: '2026-08-14T00:00:00.000Z' },
      } as Response;
    });

    const { container } = renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /no thanks/i }));

    expect(JSON.parse(postCalls()[0]!.body as string)).toEqual({ decision: 'declined' });
    // Declining is terminal: the banner is gone, not switched to another message.
    await waitFor(() => expect(container.querySelector('.banner')).toBeNull());
  });

  it('ImportOfferBanner renders the empty outcome copy rather than an imported count of zero', async () => {
    mockGetSequence([{ state: 'empty' }]);

    renderBanner();

    // `selector` disambiguates the VISIBLE title from the LiveRegion mirror of
    // the same sentence. Both are intentional: the visible node is for sighted
    // users, the live region announces the transition.
    expect(
      await screen.findByText('No recent reviews found — nothing to import.', {
        selector: '.b-title',
      }),
    ).toBeInTheDocument();
    // A distinct OUTCOME, not a count of zero — "Imported 0 reviews" reads as a
    // bug to an owner (owner decision 4).
    expect(screen.queryByText(/Imported 0 reviews/i)).not.toBeInTheDocument();
  });

  it('ImportOfferBanner stops polling and renders the failed state when the import terminates', async () => {
    vi.useFakeTimers();
    try {
      mockGetSequence([{ state: 'failed' }]);
      renderBanner();

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const callsAfterFirstLoad = fetchMock.mock.calls.length;

      // `refetchInterval` is active ONLY while state === 'importing'. Advancing
      // well past the poll interval on a terminal state must add no GETs — a
      // permanent interval would poll a dead state forever for every owner.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad);
    } finally {
      vi.useRealTimers();
    }

    // And the failed copy is neutral, with support contact and NO retry button:
    // retry belongs to the worker via the `completed_at IS NULL` sentinel (spec
    // §5.1); an owner-facing retry would enqueue a second job.
    expect(
      await screen.findByText(/We couldn't finish importing your reviews/i, {
        selector: '.b-title',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/support@repworth\.net/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|try again/i })).not.toBeInTheDocument();
  });

  it('ImportOfferBanner renders the imported count and announces the terminal transition through LiveRegion', async () => {
    mockGetSequence([{ state: 'imported', count: 37 }]);

    renderBanner();

    expect(
      await screen.findByText("Imported 37 reviews. They're in your reviews list.", {
        selector: '.b-title',
      }),
    ).toBeInTheDocument();

    // Title 68 (round-2): the `imported` happy path had no rendering assertion at
    // all, and the accessibility announcement was folded into the polling title
    // where it was invisible. Round 2 withdrew that merge; both are named here.
    const live = document.querySelector('[aria-live]');
    expect(live).not.toBeNull();
    expect(live!.textContent).toContain('Imported 37 reviews');
  });
});
