// @vitest-environment jsdom
//
// Every screen state of /dashboard/requests other than the happy path (#544
// Task 3). Three of these titles are contract items greped verbatim by CI:
//   · renders the ghost pipeline empty state with the contacts-on-file count when no batch exists
//   · renders the building state while built_at is null and stops polling at the ceiling
//   · renders a zero-queued funnel rather than the empty state when a built batch has no asks
//
// The third is the trap-guard: `queued: 0` is a real batch that asked for
// nobody, NOT the absence of a batch, and the two must never render alike.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { WITHHOLD_REASONS } from '@/lib/solicitation/restraint-policy';
import type { BatchView } from '@/lib/solicitation/batch-view';

const scope = vi.hoisted(() => ({ current: 'loc-1' }));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: scope.current,
    locations: [],
    isMultiLocation: false,
    selectedLabel: 'Location 1',
    setLocationScope: () => {},
    setLocations: () => {},
  }),
}));

import { RequestsClient } from '../RequestsClient';

// ── Fixtures ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = 5 * 60 * 1_000;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const NO_CONTENT = { status: 204, ok: true, json: async () => null } as Response;

function noBatchView(contactsOnFile = 1240): BatchView {
  return { state: 'no_batch', contactsOnFile };
}

function buildingView(): BatchView {
  return {
    state: 'building',
    batchId: 'batch-building',
    createdAt: '2026-07-25 11:59:00+00',
    contactsOnFile: 1240,
  };
}

function builtView(overrides: Partial<Extract<BatchView, { state: 'built' }>> = {}) {
  return {
    state: 'built',
    batchId: 'batch-1',
    builtAt: '2026-07-25 11:00:00+00',
    contactsOnFile: 1240,
    evaluated: 0,
    queued: 0,
    held: 0,
    groups: WITHHOLD_REASONS.map((reason) => ({ reason, total: 0, sample: [] })),
    ...overrides,
  } satisfies BatchView;
}

/** Flushes pending promises without moving the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  scope.current = 'loc-1';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Contract tests ──────────────────────────────────────────────────────────

describe('RequestsClient — batch absent and building', () => {
  it('renders the ghost pipeline empty state with the contacts-on-file count when no batch exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, noBatchView(1240))));
    render(<RequestsClient />);
    await flush();

    // The restraint story is the product, so the six gates are taught before
    // any data exists.
    for (const reason of WITHHOLD_REASONS) {
      expect(screen.getByText(reason)).toBeInTheDocument();
    }
    // Exactly one extra line when contacts already exist. The count is its own
    // element, so the sentence is asserted on the paragraph that carries it.
    const fact = screen.getByText(/1,240 contacts on file/i).closest('p');
    expect(fact?.textContent).toMatch(
      /^1,240 contacts on file — upload a new file to build your first batch\.$/i,
    );
    expect(screen.getByRole('link', { name: /upload/i })).toHaveAttribute(
      'href',
      '/dashboard/requests/contacts',
    );
    // "No batch yet" and "uploaded before watch-mode was on" render alike by
    // design — the remedy is identical, so no flag is ever explained.
    expect(screen.queryByText(/feature flag|watch-mode was (off|on|enabled)/i)).toBeNull();
    // An empty screen does not poll.
    expect(screen.queryByText(/building your batch/i)).toBeNull();
  });

  it('omits the contacts-on-file line when the location has no contacts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, noBatchView(0))));
    render(<RequestsClient />);
    await flush();

    expect(screen.queryByText(/contacts on file/i)).toBeNull();
    expect(screen.getByRole('link', { name: /upload/i })).toBeInTheDocument();
  });

  it('renders the building state while built_at is null and stops polling at the ceiling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, buildingView()));
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    const building = screen.getByText(/building your batch/i);
    expect(building.closest('[aria-busy="true"]')).not.toBeNull();

    await advance(POLL_CEILING_MS - 10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);

    await advance(20_000);
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    // aria-busy is dropped with the polling: nothing is in flight any more.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();

    const afterCeiling = fetchMock.mock.calls.length;
    await advance(60_000);
    expect(fetchMock.mock.calls.length).toBe(afterCeiling);
  });

  it('renders a zero-queued funnel rather than the empty state when a built batch has no asks', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, builtView()))
        .mockResolvedValue(NO_CONTENT),
    );
    render(<RequestsClient />);
    await flush();

    const funnel = screen.getByRole('list', { name: /batch funnel/i });
    expect(within(funnel).getAllByText('0')).toHaveLength(3);
    // The trap: a real batch that asked for nobody must never read as "no batch".
    expect(screen.queryByRole('link', { name: /upload a contacts csv/i })).toBeNull();
    expect(screen.queryByText(/build your first batch/i)).toBeNull();
  });
});

// ── Non-contract states ─────────────────────────────────────────────────────

describe('RequestsClient — loading, scope, failure', () => {
  it('renders a busy loading state while the first fetch is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    render(<RequestsClient />);

    const loading = screen.getByText(/loading the latest batch/i);
    expect(loading.closest('[aria-busy="true"]')).not.toBeNull();
  });

  it('issues zero fetches in aggregate location scope', async () => {
    scope.current = 'all';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    // The API 400s on aggregate scope, so the client must not ask at all.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/choose a location/i)).toBeInTheDocument();
  });

  it('offers a retry that actually re-fetches after a failed load', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, noBatchView(3)));
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/3 contacts on file/i)).toBeInTheDocument();
  });

  it('answers a 404 with cause-neutral copy that never blames the feature flag', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, {})));
    render(<RequestsClient />);
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/isn't available right now/i);
    // A 404 is ALSO an unresolvable location (archived, or a stale
    // rw_location_scope cookie), so copy naming the flag would be wrong half the
    // time — and distinguishing the two would leak flag state (invariant #13).
    expect(alert.textContent).not.toMatch(/switched off|turned off|disabled|feature/i);
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves a 401 to the dashboard auth redirect instead of showing an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/loading the latest batch/i)).toBeInTheDocument();
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards a stale response and aborts the request when the location changes mid-poll', async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(jsonResponse(200, noBatchView(7)));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<RequestsClient />);
    await flush();

    scope.current = 'loc-2';
    rerender(<RequestsClient />);
    await flush();

    const firstInit = fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(firstInit.signal.aborted).toBe(true);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('scope=loc-2');

    // The superseded location answers late — it must never overwrite loc-2.
    resolveFirst?.(jsonResponse(200, noBatchView(9999)));
    await flush();

    expect(screen.getByText(/7 contacts on file/i)).toBeInTheDocument();
    expect(screen.queryByText(/9,999 contacts on file/i)).toBeNull();
  });

  it('hits the polling ceiling even when the very first fetch never resolves', async () => {
    // The precedent's inFlight-first guard would wedge here forever: inFlight
    // stays true, so no later tick ever reaches the deadline check.
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    await advance(POLL_CEILING_MS + 5_000);
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── Header affordance and live region ───────────────────────────────────────

/** Answers batch reads from `views` in order (clamped at the last), and every
 *  reviewed ping with 204, so a test can script a phase sequence by URL rather
 *  than by call index. */
function routedFetch(views: BatchView[]) {
  let index = 0;
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/batch/reviewed')) return Promise.resolve(NO_CONTENT);
    const view = views[Math.min(index, views.length - 1)] as BatchView;
    index += 1;
    return Promise.resolve(jsonResponse(200, view));
  });
}

describe('RequestsClient — contacts reachable from the header', () => {
  // user_visible_behavior #11: the upload surface is reachable "from the
  // Requests header and the empty-state CTA". The CTA only exists on no_batch,
  // so without the header link the building / stalled / error / 404 / aggregate
  // screens — including the one an owner sits on right after uploading — have
  // no path to it at all.
  const states: Array<[string, () => void]> = [
    ['no batch', () => vi.stubGlobal('fetch', routedFetch([noBatchView(0)]))],
    ['building', () => vi.stubGlobal('fetch', routedFetch([buildingView()]))],
    ['built', () => vi.stubGlobal('fetch', routedFetch([builtView()]))],
    ['error', () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})))],
    ['unavailable', () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, {})))],
    [
      'aggregate scope',
      () => {
        scope.current = 'all';
        vi.stubGlobal('fetch', vi.fn());
      },
    ],
  ];

  for (const [label, stubFetch] of states) {
    it(`links to the contacts upload surface from the header in the ${label} state`, async () => {
      stubFetch();
      render(<RequestsClient />);
      await flush();

      expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute(
        'href',
        '/dashboard/requests/contacts',
      );
    });
  }
});

describe('RequestsClient — completion announcement', () => {
  it('re-announces a second building → built transition instead of going silent', async () => {
    // A live region only announces a CHANGE. Setting the identical string a
    // second time is a React bail-out and screen-reader users hear nothing, so
    // the message has to be cleared between transitions.
    vi.stubGlobal(
      'fetch',
      routedFetch([buildingView(), builtView({ batchId: 'batch-1' }), buildingView(), builtView({ batchId: 'batch-2' })]),
    );

    const { rerender } = render(<RequestsClient />);
    await flush();
    const liveRegion = screen.getByRole('status');
    expect(liveRegion.textContent).toBe('');

    await advance(POLL_INTERVAL_MS);
    expect(liveRegion.textContent).toMatch(/your batch is ready/i);

    // Switching location clears the announcement AND the wasBuilding latch —
    // this is the assertion the old code failed, and the reason the second
    // transition below is audible at all.
    scope.current = 'loc-2';
    rerender(<RequestsClient />);
    await flush();
    expect(screen.getByRole('status').textContent).toBe('');

    await advance(POLL_INTERVAL_MS);
    expect(screen.getByRole('status').textContent).toMatch(/your batch is ready/i);
  });

  it('stays silent for a batch that was already built when the screen opened', async () => {
    vi.stubGlobal('fetch', routedFetch([builtView()]));
    render(<RequestsClient />);
    await flush();

    expect(screen.getByRole('status').textContent).toBe('');
  });
});

// ── reviewed_at ping ────────────────────────────────────────────────────────

describe('RequestsClient — reviewed_at ping', () => {
  function reviewedCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes('/batch/reviewed'));
  }

  it('pings reviewed once per batch, carrying the same location scope as the read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, builtView()))
      .mockResolvedValue(NO_CONTENT);
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<RequestsClient />);
    await flush();

    const pings = reviewedCalls(fetchMock);
    expect(pings).toHaveLength(1);
    // Without ?scope= the server falls back to the default location, the
    // three-key UPDATE matches zero rows, and it still answers 204.
    expect(String(pings[0]?.[0])).toBe(
      '/api/dashboard/solicitation/batch/reviewed?scope=loc-1',
    );
    expect(JSON.parse(String((pings[0]?.[1] as RequestInit).body))).toEqual({
      batchId: 'batch-1',
    });

    rerender(<RequestsClient />);
    await flush();
    expect(reviewedCalls(fetchMock)).toHaveLength(1);
  });

  it('pings the second batch after a location switch (the guard is keyed by batch, not a flag)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, builtView({ batchId: 'batch-1' })))
      .mockResolvedValueOnce(NO_CONTENT)
      .mockResolvedValueOnce(jsonResponse(200, builtView({ batchId: 'batch-2' })))
      .mockResolvedValue(NO_CONTENT);
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<RequestsClient />);
    await flush();

    scope.current = 'loc-2';
    rerender(<RequestsClient />);
    await flush();

    const pings = reviewedCalls(fetchMock);
    expect(pings).toHaveLength(2);
    expect(String(pings[1]?.[0])).toContain('scope=loc-2');
  });

  it('defers the ping until the tab is visible, so it means a human looked', async () => {
    const visibility = { value: 'hidden' as DocumentVisibilityState };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.value,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, builtView()))
      .mockResolvedValue(NO_CONTENT);
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    expect(reviewedCalls(fetchMock)).toHaveLength(0);

    visibility.value = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reviewedCalls(fetchMock)).toHaveLength(1);
  });

  it('reports a failed ping instead of swallowing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, builtView()))
      .mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    // "not opened" must stay distinguishable from "the write failed".
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('reviewed ping failed'),
    );
  });
});
