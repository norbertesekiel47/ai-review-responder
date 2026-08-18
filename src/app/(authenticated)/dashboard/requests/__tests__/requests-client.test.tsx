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
    attempts: [],
    // Send mode off is the default posture (#629) — the read model returns
    // `null` here whenever SOLICITATION_SEND_ENABLED is off. Cases that need a
    // lane pass one through `overrides`.
    sendLane: null,
    ...overrides,
  } satisfies BatchView;
}

type BuiltView = Extract<BatchView, { state: 'built' }>;
type SendLane = NonNullable<BuiltView['sendLane']>;
type Attempt = BuiltView['attempts'][number];

function sendLaneView(overrides: Partial<SendLane> = {}): SendLane {
  return {
    batchState: 'built',
    ready: true,
    pendingRenders: 0,
    approvedAt: null,
    vetoDeadlineAt: null,
    haltedAt: null,
    haltReason: null,
    moderationWithheld: 0,
    regeneratingAskId: null,
    regenBudgets: {},
    ...overrides,
  };
}

/** One live, owner-readable attempt. `attemptNo` is the field the panel
 *  compares across a refetch to tell a landed regeneration from one that
 *  settled without changing anything, so every fixture states it. */
function renderedAttempt(
  suffix: string,
  contactName: string,
  overrides: Partial<Extract<Attempt, { redacted: false }>> = {},
): Attempt {
  return {
    outreachId: `a1b2c3d4-0000-7000-8000-00000000000${suffix}`,
    askId: `ask-${suffix}`,
    contactId: `contact-${suffix}`,
    contactName,
    attemptNo: 1,
    deliveryStatus: 'rendered',
    dispositionReason: null,
    renderedAt: '2026-07-25 11:00:00+00',
    redacted: false,
    subject: `Quick favour, ${contactName}?`,
    body: `Hi ${contactName}, would you leave us a review?`,
    lintClasses: [],
    moderationStatus: 'clean',
    moderationDetail: {},
    interpolationInputs: null,
    ...overrides,
  };
}

function approvableView(
  batchId: string,
  overrides: { attempts?: Attempt[]; sendLane?: SendLane } = {},
): BatchView {
  const attempts = overrides.attempts ?? [renderedAttempt('1', 'Dana Reeve')];
  return builtView({
    batchId,
    queued: attempts.length,
    evaluated: attempts.length,
    attempts,
    sendLane: overrides.sendLane ?? sendLaneView(),
  });
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

  it('offers a retry after a failed load without claiming nothing was sent or changed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, noBatchView(3)));
    vi.stubGlobal('fetch', fetchMock);
    render(<RequestsClient />);
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
    // Absence of the CLAIM, not exact wording: honest rephrasing stays free,
    // but no tense of "nothing was sent / nothing changed" may come back on a
    // read failure (#861) — the server transaction may already have committed.
    expect(alert).not.toHaveTextContent(/nothing (?:was |has been |had been )?sent/i);
    expect(alert).not.toHaveTextContent(/nothing (?:has |had |was )?changed/i);
    expect(alert).not.toHaveTextContent(/no changes? (?:was|were) made/i);
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

// ── The approval lane's sentence in the live region ─────────────────────────

/**
 * The lane sentence and the loop's completion announcement share one live
 * region, and the lane sentence used to be neither scope-keyed nor cleared —
 * so the FIRST approve or stop silenced every later "your batch is ready" for
 * the rest of the session.
 */
describe('RequestsClient — the approval lane and the live region', () => {
  const APPROVED = {
    status: 'approved',
    approvedCount: 1,
    excludedCount: 0,
    vetoDeadlineAt: '2026-07-25 12:15:00+00',
    close: null,
  };

  /** `routedFetch`, plus the approve POST — which does NOT consume a view, so a
   *  test can still script the read sequence by index. */
  function laneFetch(views: BatchView[], approve: () => Promise<Response>) {
    const reads = routedFetch(views);
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/batch/approve')) return approve();
      return reads(url, init);
    });
  }

  const approveButton = () => screen.getByRole('button', { name: /approve and send/i });

  it('clears the lane sentence on a location switch so the next batch is still announced', async () => {
    // The counter-example the old inline comment called impossible: the loop's
    // building → built announcement CAN follow an approval — on another
    // location.
    vi.stubGlobal(
      'fetch',
      laneFetch(
        [
          buildingView(),
          approvableView('batch-1'),
          approvableView('batch-1'),
          buildingView(),
          builtView({ batchId: 'batch-2' }),
        ],
        () => Promise.resolve(jsonResponse(200, APPROVED)),
      ),
    );

    const { rerender } = render(<RequestsClient />);
    await flush();
    await advance(POLL_INTERVAL_MS);
    expect(screen.getByRole('status').textContent).toMatch(/your batch is ready/i);

    fireEvent.click(approveButton());
    await flush();
    await flush();
    expect(screen.getByRole('status').textContent).toMatch(/1 message will send/i);

    scope.current = 'loc-2';
    rerender(<RequestsClient />);
    await flush();
    expect(screen.getByRole('status').textContent).toBe('');

    // The masked announcement. Before the fix the region still held "Approved…"
    // and this transition was inaudible.
    await advance(POLL_INTERVAL_MS);
    expect(screen.getByRole('status').textContent).toMatch(/your batch is ready/i);
  });

  it('never announces an in-flight approval against the location switched to', async () => {
    // edge_cases[13]. The write was made about loc-1; it may not speak for
    // loc-2 just because it landed late.
    let settle: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      laneFetch(
        [approvableView('batch-1'), builtView({ batchId: 'batch-2' })],
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      ),
    );

    const { rerender } = render(<RequestsClient />);
    await flush();

    fireEvent.click(approveButton());
    await flush();

    scope.current = 'loc-2';
    rerender(<RequestsClient />);
    await flush();

    settle?.(jsonResponse(200, APPROVED));
    await flush();
    await flush();

    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.queryByText(/will send/i)).toBeNull();
  });

  it('shows an unconfirmed write as an alert and refetches the authoritative state', async () => {
    const fetchMock = laneFetch(
      [approvableView('batch-1'), approvableView('batch-1')],
      () => Promise.reject(new Error('network down')),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestsClient />);
    await flush();

    const readsBefore = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes('/batch/'),
    ).length;
    fireEvent.click(approveButton());
    await flush();
    await flush();

    // Visible AND announced by its own role, and it does not claim the write
    // failed — only that we do not know.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/could not confirm whether that went through/i);
    expect(alert.textContent).not.toMatch(/nothing changed/i);
    // Not repeated into the polite region as well.
    expect(screen.getByRole('status').textContent).toBe('');

    // The server's own state is what answers the question.
    const readsAfter = fetchMock.mock.calls.filter(
      ([url]) => !String(url).includes('/batch/'),
    ).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });
});

// ── The regenerate lane, through the real fetch loop ────────────────────────

/**
 * #860's regenerate control, driven from HERE rather than from the panel suite.
 *
 * The panel suite renders `ApprovalPanel` directly and simulates a refetch with
 * `rerender`, which PRESERVES component state — so a panel-level test cannot
 * see whether the composition keeps the panel mounted, and every one of these
 * cases passed against a parent that unmounted it on every accepted
 * regeneration. Approve and stop are terminal, so tearing the screen down cost
 * nothing; regeneration comes back to the very panel the owner is working in,
 * and both things the panel remembers — the exclusion set and the marker that
 * says a regeneration is outstanding — die with it.
 *
 * These four cases are therefore composition tests on purpose: the real POST,
 * the real refetch, the real poll loop.
 */
describe('RequestsClient — the regenerate lane', () => {
  const ACCEPTED = { status: 'accepted' };

  /** `routedFetch`, plus the regenerate POST — which does NOT consume a view,
   *  so a test still scripts the read sequence by index. */
  function regenerateFetch(
    views: BatchView[],
    regenerate: () => Promise<Response> = () =>
      Promise.resolve(jsonResponse(202, ACCEPTED)),
  ) {
    const reads = routedFetch(views);
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/batch/regenerate')) return regenerate();
      return reads(url, init);
    });
  }

  /** By ACCESSIBLE NAME — the visible label plus the contact (WCAG 2.5.3), so
   *  the in-flight swap is visible to this query exactly as it is to a screen
   *  reader. */
  const regenButton = (name: RegExp) => screen.getByRole('button', { name });
  const liveRegion = () => screen.getByRole('status').textContent ?? '';

  it('keeps every deselection when a regeneration refetches the batch', async () => {
    const ana = renderedAttempt('1', 'Ana');
    const bo = renderedAttempt('2', 'Bo');
    vi.stubGlobal(
      'fetch',
      regenerateFetch([
        approvableView('batch-1', { attempts: [ana, bo] }),
        approvableView('batch-1', {
          attempts: [ana, bo],
          sendLane: sendLaneView({ regeneratingAskId: 'ask-1' }),
        }),
      ]),
    );

    render(<RequestsClient />);
    await flush();

    fireEvent.click(screen.getByRole('checkbox', { name: /Send to Bo/ }));
    expect(
      screen.getByRole('button', { name: 'Approve and send 1 message' }),
    ).toBeInTheDocument();

    fireEvent.click(regenButton(/^Regenerate the message to Ana$/));
    await flush();
    await flush();

    // The refetch landed and the panel is showing the server's own state —
    // this is NOT solved by refusing to re-read.
    expect(
      regenButton(/^Writing a new version… of the message to Ana$/),
    ).toBeInTheDocument();

    // …and Bo is still deselected. A remount here re-checks him and the button
    // silently goes back to sending 2 messages: the batch would send the very
    // message the owner removed.
    expect(screen.getByRole('checkbox', { name: /Send to Bo/ })).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Approve and send 1 message' }),
    ).toBeInTheDocument();
  });

  it('reports that nothing changed when a regeneration settles without a new attempt', async () => {
    const ana = renderedAttempt('1', 'Ana');
    vi.stubGlobal(
      'fetch',
      regenerateFetch([
        approvableView('batch-1', { attempts: [ana] }),
        approvableView('batch-1', {
          attempts: [ana],
          sendLane: sendLaneView({ regeneratingAskId: 'ask-1' }),
        }),
        // The flight is over and the ask still carries attempt 1: the worker
        // refused (budget race, lapsed subscription, a swap that lost its
        // re-check) and left the copy alone.
        approvableView('batch-1', { attempts: [ana] }),
      ]),
    );

    render(<RequestsClient />);
    await flush();

    fireEvent.click(regenButton(/^Regenerate the message to Ana$/));
    await flush();
    await flush();
    // The 202's own sentence: accepted, not done.
    expect(liveRegion()).toMatch(/writing a new version/i);

    await advance(POLL_INTERVAL_MS);

    // The spinner stopping over unchanged words reads as "nothing happened", so
    // the panel says it. Unreachable while the refetch unmounted the panel that
    // remembers it asked.
    expect(liveRegion()).toMatch(/could not write a new version.*unchanged/i);
  });

  it('reports a settled regeneration that completed before the first refetch', async () => {
    // The worker finished between the 202 and the first refetch, so
    // `regeneratingAskId` is NEVER observed non-null. Outcome reporting must not
    // depend on the panel having caught the in-flight state (round 1, finding
    // 10) — asserted in both directions, because a report that fires for every
    // settlement is as wrong as one that never fires.
    const ana = renderedAttempt('1', 'Ana');
    const landed = renderedAttempt('1', 'Ana', {
      outreachId: 'a1b2c3d4-0000-7000-8000-000000000009',
      attemptNo: 2,
      subject: 'A second draft for Ana',
      body: 'A completely different way of asking.',
    });

    vi.stubGlobal(
      'fetch',
      regenerateFetch([
        approvableView('batch-1', { attempts: [ana] }),
        approvableView('batch-1', { attempts: [landed] }),
      ]),
    );

    const { unmount } = render(<RequestsClient />);
    await flush();
    fireEvent.click(regenButton(/^Regenerate the message to Ana$/));
    await flush();
    await flush();

    // It LANDED: the new copy is what the owner reads, and nothing claims it
    // failed.
    expect(screen.getByText('A second draft for Ana')).toBeInTheDocument();
    expect(liveRegion()).not.toMatch(/could not write a new version/i);
    unmount();

    // The same shape, refused: settled just as fast, attempt still 1.
    vi.stubGlobal(
      'fetch',
      regenerateFetch([
        approvableView('batch-2', { attempts: [ana] }),
        approvableView('batch-2', { attempts: [ana] }),
      ]),
    );

    render(<RequestsClient />);
    await flush();
    fireEvent.click(regenButton(/^Regenerate the message to Ana$/));
    await flush();
    await flush();

    expect(liveRegion()).toMatch(/could not write a new version.*unchanged/i);
  });

  it('keeps a built batch approvable when polling gives up on a regeneration', async () => {
    // #860 widened the poll predicate to a BUILT batch with a regeneration in
    // flight, which made the ceiling — and its `stalled` phase — reachable for a
    // batch that is built and approvable.
    const fetchMock = regenerateFetch([
      approvableView('batch-1', {
        attempts: [renderedAttempt('1', 'Ana')],
        sendLane: sendLaneView({ regeneratingAskId: 'ask-1' }),
      }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestsClient />);
    await flush();
    await advance(POLL_CEILING_MS + 10_000);

    // A built batch is not building. The ghost said it was, and took the
    // approval panel — and every message the owner was reading — with it.
    expect(screen.queryByText(/still processing/i)).toBeNull();
    expect(screen.queryByText(/building your batch/i)).toBeNull();
    expect(screen.getByText('Quick favour, Ana?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve and send/i })).toBeInTheDocument();

    // …and the stalled arm still owes the owner a way to ask again.
    expect(screen.getByText(/stopped checking for updates/i)).toBeInTheDocument();
    const readsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await flush();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(readsBefore);
    // Checking again must not cost the owner their place either.
    expect(screen.getByText('Quick favour, Ana?')).toBeInTheDocument();
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
