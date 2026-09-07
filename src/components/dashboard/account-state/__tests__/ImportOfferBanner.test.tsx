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
import { ImportOfferBanner } from '../ImportOfferBanner';
// The wire contract's ONE owner (round-1 A10) — the same module the banner
// type-imports, so a change to the union breaks this suite too.
import type { ImportOfferView } from '@/lib/reviews/import-offer-view';

const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const OFFER: ImportOfferView = { state: 'offer', expiresAt: '2026-08-14T00:00:00.000Z' };

let fetchMock: ReturnType<typeof vi.fn>;

/** Queue of GET responses; the last one repeats so polling has something to read. */
function mockGetSequence(states: ImportOfferView[]): void {
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

/**
 * A live offer whose decision POST is REJECTED — the route's 409/404 vocabulary
 * (`route.ts:116-125`). The refetch that follows reports `none`, because every
 * rejection means the offer is gone; that is precisely why the banner cannot
 * simply re-read state and return null.
 */
function mockRejectedDecision(status: number, error: string): void {
  let answered = false;
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      answered = true;
      return { ok: false, status, json: async () => ({ error }) } as Response;
    }
    return {
      ok: true,
      json: async (): Promise<ImportOfferView> => (answered ? { state: 'none' } : OFFER),
    } as Response;
  });
}

function getCallCount(): number {
  return fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'POST')
    .length;
}

function renderBanner(props: { readOnly?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportOfferBanner locationId={LOCATION_ID} readOnly={props.readOnly} />
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
        json: async (): Promise<ImportOfferView> =>
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
        json: async (): Promise<ImportOfferView> =>
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
      await screen.findByText('No recent reviews found, so there is nothing to import.', {
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
    // Title 68 (round-2): the `imported` happy path had no rendering assertion at
    // all, and the accessibility announcement was folded into the polling title
    // where it was invisible. Round 2 withdrew that merge; both are named here.
    //
    // THE TRANSITION, NOT THE DESTINATION (round-1 A6c). A live region mounted in
    // the same commit as its message announces nothing, and a DOM-presence
    // assertion on the terminal state alone passes either way. So this drives
    // importing → imported and pins BOTH halves of LiveRegion's contract: the
    // region already exists while the import runs, and the node that carries the
    // message is the SAME node — not a fresh one that arrived with its text.
    vi.useFakeTimers();
    let live: Element;
    try {
      mockGetSequence([{ state: 'importing' }, { state: 'imported', count: 37 }]);
      renderBanner();

      await vi.waitFor(() => expect(document.querySelector('[aria-live]')).not.toBeNull());
      live = document.querySelector('[aria-live]')!;
      expect(live.textContent).toBe('');

      // `refetchInterval` is 4s while importing.
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(live.textContent).toContain('Imported 37 reviews'));
    } finally {
      vi.useRealTimers();
    }

    expect(document.querySelector('[aria-live]')).toBe(live);
    expect(
      screen.getByText("Imported 37 reviews. They're in your reviews list.", {
        selector: '.b-title',
      }),
    ).toBeInTheDocument();
  });

  it('ImportOfferBanner retires the completion notice instead of leaving it on screen', async () => {
    // The defect this pins: `completed_at` is permanent, so `imported` used to
    // render on every dashboard load, forever. The notice is a notice — it says
    // its piece and goes.
    //
    // This is the CLIENT half. The server half is `IMPORT_NOTICE_WINDOW_MS`,
    // which stops the state being reported at all after a while; without both,
    // either the banner sits there for the whole visit or it returns on every
    // reload.
    vi.useFakeTimers();
    try {
      mockGetSequence([{ state: 'imported', count: 37 }]);
      renderBanner();

      await vi.waitFor(() =>
        expect(
          screen.getByText("Imported 37 reviews. They're in your reviews list.", {
            selector: '.b-title',
          }),
        ).toBeInTheDocument(),
      );

      // Still there just before the visible window closes — the notice must
      // actually be readable, not flash.
      // Scoped to `.b-title` throughout: the message is deliberately in TWO
      // places — the visible banner and BannerShell's live region — so an
      // unscoped query matches both and cannot tell them apart.
      await vi.advanceTimersByTimeAsync(7000);
      expect(
        screen.queryByText(/Imported 37 reviews/, { selector: '.b-title' }),
      ).not.toBeNull();

      // Visible window (8s) plus the leave (320ms).
      await vi.advanceTimersByTimeAsync(1500);
      await vi.waitFor(() =>
        expect(screen.queryByText(/Imported 37 reviews/, { selector: '.b-title' })).toBeNull(),
      );
      // The WHOLE banner goes, wrapper included — a surviving `section-enter`
      // wrapper would leave an empty flex item that doubles the section gap,
      // which is the trap this file's header calls out.
      expect(document.querySelector('[aria-live]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ImportOfferBanner keeps the failed state on screen — a failure is not a notice', async () => {
    // The counterpart to the title above, and the reason the retire is scoped to
    // the two terminal SUCCESS states: an unresolved failure is something the
    // owner may still need to act on, so it must not time out.
    vi.useFakeTimers();
    try {
      mockGetSequence([{ state: 'failed' }]);
      renderBanner();

      await vi.waitFor(() =>
        expect(
          screen.queryByText(/couldn't finish importing your reviews/i, { selector: '.b-title' }),
        ).not.toBeNull(),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        screen.queryByText(/couldn't finish importing your reviews/i, { selector: '.b-title' }),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ImportOfferBanner explains an expired offer instead of leaving the buttons live', async () => {
    // The late click is the ORDINARY case: expiry is derived and nothing fires at
    // the deadline (#670), so a banner rendered at T+6d59m is still on screen,
    // with live buttons, after the offer expires (round-1 A3).
    mockRejectedDecision(409, 'offer_expired');

    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /import my reviews/i }));

    expect(
      await screen.findByText('This import offer has expired', { selector: '.b-title' }),
    ).toBeInTheDocument();
    // The offer is gone, so the buttons are too — not left live to be rejected again.
    expect(screen.queryByRole('button', { name: /import my reviews/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /no thanks/i })).not.toBeInTheDocument();
    // And it settled: the rejection refetches rather than sitting on stale state.
    await waitFor(() => expect(getCallCount()).toBeGreaterThan(1));
    // The refetch reports `none`; the explanation must survive it.
    expect(screen.getByText('This import offer has expired')).toBeInTheDocument();
    expect(document.querySelector('[aria-live]')!.textContent).toContain(
      'This import offer has expired',
    );
  });

  it('ImportOfferBanner tells an already-answered offer apart from an expired one', async () => {
    // Same 409, different body code, different words — the whole reason the route
    // spends two error codes on one status.
    mockRejectedDecision(409, 'already_answered');

    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /no thanks/i }));

    expect(
      await screen.findByText('This offer was already answered', { selector: '.b-title' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('This import offer has expired')).not.toBeInTheDocument();
  });

  it('ImportOfferBanner lets a running import outrank the already-answered rejection', async () => {
    // Two tabs: the other one accepted, so this POST is rejected while an import
    // is genuinely in flight. "Your earlier choice stands" would be a worse
    // answer than the import itself, so the refetched outcome wins.
    let answered = false;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        answered = true;
        return { ok: false, status: 409, json: async () => ({ error: 'already_answered' }) } as Response;
      }
      return {
        ok: true,
        json: async (): Promise<ImportOfferView> =>
          answered ? { state: 'importing' } : OFFER,
      } as Response;
    });

    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /import my reviews/i }));

    expect(await screen.findByText(/Importing your reviews/i)).toBeInTheDocument();
    expect(screen.queryByText('This offer was already answered')).not.toBeInTheDocument();
  });

  it('ImportOfferBanner explains a 404 no-offer decision', async () => {
    mockRejectedDecision(404, 'no_offer');

    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /import my reviews/i }));

    expect(
      await screen.findByText('There is no import offer to answer', { selector: '.b-title' }),
    ).toBeInTheDocument();
  });

  it('ImportOfferBanner keeps the offer answerable when the decision could not be recorded', async () => {
    // A 500 is NOT terminal: the offer still stands, so the banner says so and
    // leaves the buttons live rather than replacing itself with a dead end.
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return { ok: false, status: 500, json: async () => ({ error: 'internal_error' }) } as Response;
      }
      return { ok: true, json: async (): Promise<ImportOfferView> => OFFER } as Response;
    });

    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /import my reviews/i }));

    expect(
      await screen.findByText(/couldn't record your choice/i, { selector: '.b-sub' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import my reviews/i })).toBeEnabled();
    expect(screen.getByText('Import your recent reviews?')).toBeInTheDocument();
  });

  it('ImportOfferBanner shows the read-only notice instead of decision buttons for a past-due owner', async () => {
    // Precedent, not invention: ConnectGoogleBanner suppresses the CTA the same
    // way for the same owner (round-1 A6). A read-only POST answers 402.
    mockGetSequence([OFFER]);

    renderBanner({ readOnly: true });

    expect(await screen.findByText('Import your recent reviews?')).toBeInTheDocument();
    expect(screen.getByText('Update billing to import your reviews.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import my reviews/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /no thanks/i })).not.toBeInTheDocument();
  });

  // ---------- #1087: the arrangement ----------
  //
  // jsdom applies no stylesheet, so none of these assert a computed position.
  // They assert the STRUCTURE the stylesheet acts on, which is the half that
  // regresses silently: a future edit that reinstates an inline style or drops
  // the slot class would still render the right words and still pass every test
  // above it.

  it('ImportOfferBanner — the offer state still renders the 7-day disclosure and the reassurance line verbatim', async () => {
    // The regex assertions above survive a reworded sentence that still contains
    // the fragment. These do not. The 7-day disclosure and the automatic-handling
    // reassurance are locked verbatim (owner decision 6) and #1087 was a layout
    // ticket — the standing temptation is to shorten the copy to fit.
    mockGetSequence([OFFER]);

    renderBanner();

    expect(
      await screen.findByText(
        'We can pull in your 100 most recent Google reviews from the past year so you can generate replies for them. Nothing gets posted, and you choose what to reply to.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'This is a one-time import, available for the next 7 days. New reviews will still be handled automatically either way.',
      ),
    ).toBeInTheDocument();
  });

  it('ImportOfferBanner — the offer actions sit in the banner action slot rather than inline styles', async () => {
    // RETITLED FROM "are right-aligned" (#1087 review F4). jsdom applies no
    // stylesheet, so alignment is not a computed position here and the old title
    // promised what the body cannot prove — which mattered, because review F2
    // showed alignment was exactly the half that regressed. Alignment is proven
    // by measurement instead, in the real `.content--dash` container across
    // 360–1440px. What this pins is the STRUCTURE that stylesheet acts on: the
    // element carrying `margin-left: auto` exists, the actions are inside it, and
    // neither action carries an inline style.
    mockGetSequence([OFFER]);

    const { container } = renderBanner();
    await screen.findByRole('button', { name: /import my reviews/i });

    // The slot, not a raw div with an inline flex. `margin-left: auto` belongs to
    // the group; it is the element the stylesheet positions.
    const actions = container.querySelector('.banner-actions');
    expect(actions).not.toBeNull();
    expect(
      Array.from(actions!.querySelectorAll('button')).map((b) => b.textContent),
    ).toEqual(['Import my reviews', 'No thanks']);

    // The banner opts in to top alignment; `.banner` itself keeps centring, so
    // every other banner in this slot is unaffected.
    expect(container.querySelector('.banner')?.classList.contains('banner--top')).toBe(true);
    expect(container.querySelector('.banner-copy')).not.toBeNull();

    // Secondary through a class. An inline `style` on either action is the
    // regression this asserts against.
    for (const button of actions!.querySelectorAll('button')) {
      expect(button.getAttribute('style')).toBeNull();
    }
    expect(
      screen.getByRole('button', { name: /no thanks/i }).classList.contains('banner-cta--ghost'),
    ).toBe(true);
  });

  it('ImportOfferBanner — a read-only owner gets the notice in the actions slot, not the buttons', async () => {
    mockGetSequence([OFFER]);

    const { container } = renderBanner({ readOnly: true });
    await screen.findByText('Update billing to import your reviews.');

    const actions = container.querySelector('.banner-actions');
    expect(actions).not.toBeNull();
    expect(actions!.textContent).toBe('Update billing to import your reviews.');
  });

  it('ImportOfferBanner — BannerShell occupies the same tree position across importing and imported', async () => {
    // The intake invariant #1087 could have broken silently: `OfferPrompt`
    // renders the inner `.banner` ONLY, never its own shell. Wrapping it — the
    // obvious move when rearranging a layout — would nest a second live region,
    // and the terminal announcement would be read from a node that is no longer
    // the outermost one.
    //
    // Walks offer → importing → imported and pins the shell's SHAPE at each,
    // then node identity across importing → imported, which is the transition
    // the A6c contract is actually about.
    //
    // NOT identity across offer → importing: the parent returns `BannerShell`
    // for `offer` and `ImportStatusBanner` for `importing`, so React replaces
    // that subtree by design. Benign — the offer state's announcement is the
    // empty string, so nothing is lost on the way in (deviation D2).
    const assertShellShape = (container: HTMLElement) => {
      const shell = container.firstElementChild!;
      expect(shell.className).toBe('section-enter section-enter-2');
      // Exactly one region, and it is the shell's own first child — not one
      // nested inside a banner.
      expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
      expect(shell.firstElementChild!.getAttribute('aria-live')).not.toBeNull();
      // The banner is the shell's content, never its wrapper.
      expect(container.querySelectorAll('.section-enter-2')).toHaveLength(1);
      expect(shell.querySelector('.banner')!.parentElement).toBe(shell);
    };

    vi.useFakeTimers();
    try {
      mockGetSequence([OFFER, { state: 'importing' }, { state: 'imported', count: 12 }]);

      const { container } = renderBanner();
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: /import my reviews/i })).toBeInTheDocument(),
      );
      assertShellShape(container);

      // `userEvent` drives real timers; advance the mutation by hand instead.
      screen.getByRole('button', { name: /import my reviews/i }).click();
      await vi.waitFor(() =>
        expect(
          screen.getByText('Importing your reviews… this usually takes a minute.', {
            selector: '.b-title',
          }),
        ).toBeInTheDocument(),
      );
      assertShellShape(container);
      const shellDuringImport = container.firstElementChild;

      // `refetchInterval` is 4s while importing.
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() =>
        expect(
          screen.getByText("Imported 12 reviews. They're in your reviews list.", {
            selector: '.b-title',
          }),
        ).toBeInTheDocument(),
      );
      assertShellShape(container);

      // Node IDENTITY across the transition the contract is about. A remount
      // produces a different node that every `querySelector` would still find.
      expect(container.firstElementChild).toBe(shellDuringImport);
    } finally {
      vi.useRealTimers();
    }
  });
  it('ImportOfferBanner announces the failed outcome through the live region it was already using', async () => {
    // Review F3. `failed` used to return `FailedBanner` from an early return
    // where its sibling returned `BannerShell`, so React saw a type change,
    // remounted the live region, and the region's FIRST PAINT already carried the
    // failure text — which announces nothing. This is the ordinary path: the
    // `importing` poll returns `failed` when the worker gives up, and it is the
    // message an owner most needs read to them.
    //
    // Node identity is the assertion. A DOM-presence check on the terminal state
    // passes either way, which is how this survived the original suite.
    vi.useFakeTimers();
    try {
      mockGetSequence([{ state: 'importing' }, { state: 'failed' }]);
      renderBanner();

      await vi.waitFor(() => expect(document.querySelector('[aria-live]')).not.toBeNull());
      const live = document.querySelector('[aria-live]')!;
      expect(live.textContent).toBe('');

      // `refetchInterval` is 4s while importing.
      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() =>
        expect(live.textContent).toBe("We couldn't finish importing your reviews."),
      );

      // The SAME node carried the message, so it was an update and not a mount.
      expect(document.querySelector('[aria-live]')).toBe(live);
      // And there is still exactly ONE region (#1087 round 2, N3). Identity alone
      // passes for a `FailedBanner` that nests a SECOND shell inside the shared
      // one: the outer node survives, so the assertion above is satisfied while
      // the file's stated "renders the inner `.banner` only" contract is broken.
      expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
      expect(document.querySelectorAll('.section-enter-2')).toHaveLength(1);
      // The urgent channel and the visible copy are unchanged by the restructure.
      expect(document.querySelector('.banner-attn')?.getAttribute('role')).toBe('alert');
      expect(
        screen.getByText("We couldn't finish importing your reviews", { selector: '.b-title' }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
