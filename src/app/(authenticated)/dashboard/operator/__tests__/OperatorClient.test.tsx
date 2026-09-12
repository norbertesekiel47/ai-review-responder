// @vitest-environment jsdom
// The conversation state machine, against a mocked fetch and fake timers.
//
// `next/navigation` is mocked the way the nav suites mock it
// (src/components/dashboard/__tests__/MobileTabBar.test.tsx:6-12), with
// `useSearchParams` added so URL resumption can be driven. `useLocationScope`
// is MOCKED rather than provided: the scope is an input to these cases, and the
// real provider changes it through a router refresh this suite has no server for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { pathnameMock, router, replaceMock, searchParamsMock, scopeMock, setScopeMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    pathnameMock: vi.fn<() => string>(() => '/dashboard/operator'),
    // ONE object, hoisted. `useRouter: () => ({ … })` returns a NEW object on
    // every render, so `writeUrl`'s `[router]` dependency changes identity
    // each time, every effect that depends on it is torn down and re-run, and
    // a response that triggers a state update becomes an infinite read loop
    // (RB2-06). The real `useRouter` is stable; the mock must be too.
    router: { replace: replaceMock, push: vi.fn(), refresh: vi.fn() },
    replaceMock,
    searchParamsMock: { value: new URLSearchParams() },
    scopeMock: { value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string },
    setScopeMock: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => router,
  useSearchParams: () => searchParamsMock.value,
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: scopeMock.value,
    locations: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Salon', displayLabel: null, isPrimary: true },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Cafe', displayLabel: null, isPrimary: false },
    ],
    isMultiLocation: true,
    selectedLabel: 'Salon',
    setLocationScope: setScopeMock,
    setLocations: vi.fn(),
  }),
}));

import { OperatorClient } from '../OperatorClient';
import {
  LOCATION_UNAVAILABLE,
  PREPARING,
  RETRY_SEND,
  ROUTE_ERROR_WORDING,
  START_NEW_CONVERSATION,
  TURN_FAILURE_WORDING,
} from '../wording';

const SALON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAFE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TURN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROPOSAL = '99999999-9999-4999-8999-999999999999';

/** A first-time owner: RB-09's empty view, so no identity is adopted. */
const EMPTY_CONVERSATION = { conversation: null, turns: [], summary: null };

function storedTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: TURN,
    sequence: 1,
    status: 'completed',
    failureReason: null,
    locationId: SALON,
    ownerText: 'Make my replies warmer.',
    segments: [],
    proposals: [],
    unsupported: [],
    ...overrides,
  };
}

const conversationWith = (turns: unknown[]) => ({
  conversation: { id: CONVERSATION, lastTurnAt: '2026-09-12T10:00:00.000Z' },
  turns,
  summary: null,
});

function turnBody(overrides: Record<string, unknown> = {}) {
  return {
    id: TURN, status: 'accepted', failureReason: null,
    segments: [], proposals: [], unsupported: [],
    ...overrides,
  };
}

/** A fetch double routed by `METHOD url`. An unrouted call fails loudly. */
function routeFetch(handlers: Array<[RegExp, () => { status: number; body: unknown }]>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    for (const [pattern, handler] of handlers) {
      if (pattern.test(`${init?.method ?? 'GET'} ${href}`)) {
        const { status, body } = handler();
        return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
      }
    }
    throw new Error(`unrouted fetch: ${init?.method ?? 'GET'} ${href}`);
  });
}

const pollCount = (mock: ReturnType<typeof routeFetch>) =>
  mock.mock.calls.filter(([url]) => String(url).includes(`/api/operator/turns/${TURN}`)).length;

/**
 * One tick past the client's four-minute poll ceiling. Spelled here rather
 * than imported so a change to the constant shows up as a red test rather
 * than as a test that silently follows it.
 */
const POLL_DEADLINE_TEST_MS = 4 * 60 * 1_000 + 1_000;

const postBodies = (mock: ReturnType<typeof routeFetch>) =>
  mock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  searchParamsMock.value = new URLSearchParams();
  scopeMock.value = SALON;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OperatorClient', () => {
  it('operator screen posts a turn with the stored location, shows Preparing your plan and resumes the same turn from URL state after a reload', async () => {
    let turnStatus = 'accepted';
    // The transcript BEFORE the send is a first-time owner's; afterwards it
    // carries the accepted turn, exactly as the route would answer it.
    let accepted = false;
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200,
        body: accepted
          ? conversationWith([storedTurn({ status: turnStatus })])
          : EMPTY_CONVERSATION,
      })],
      [/^POST .*\/api\/operator\/turns$/, () => {
        accepted = true;
        return { status: 200, body: { conversationId: CONVERSATION, turnId: TURN } };
      }],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody({ status: turnStatus }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<OperatorClient />);

    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Make my replies warmer.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(1));
    const [body] = postBodies(fetchMock);
    expect(body.locationId).toBe(SALON);
    expect(body.text).toBe('Make my replies warmer.');
    expect(typeof body.conversationId).toBe('string');
    expect(typeof body.clientTurnKey).toBe('string');

    expect(await screen.findByText(PREPARING)).toBeInTheDocument();

    // THE OWNER'S OWN WORDS, on screen while it prepares. The composer empties
    // on send and there is no optimistic bubble, so the accepted turn has to
    // come back from the transcript — which for every message after the first
    // only happens because the POST asks for the refetch (S3).
    expect(await screen.findByText('Make my replies warmer.')).toBeInTheDocument();

    await waitFor(() => {
      const url = String(replaceMock.mock.calls.at(-1)![0]);
      expect(url).toContain(`conversationId=${CONVERSATION}`);
      expect(url).toContain(`turnId=${TURN}`);
    });

    // THE RELOAD: unmount, put the ids in the URL, mount again. No second POST.
    unmount();
    fetchMock.mockClear();
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });
    render(<OperatorClient />);

    expect(await screen.findByText(PREPARING)).toBeInTheDocument();
    await waitFor(() => expect(pollCount(fetchMock)).toBeGreaterThan(0));
    expect(postBodies(fetchMock)).toHaveLength(0);

    turnStatus = 'completed';
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await waitFor(() => expect(screen.queryByText(PREPARING)).not.toBeInTheDocument());
  });

  it('operator screen backs off polling and shows the timeout notice with Start a new conversation after four minutes', async () => {
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody() })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });

    render(<OperatorClient />);
    await screen.findByText(PREPARING);

    // 0–30 s at 2 s.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const fast = pollCount(fetchMock);
    expect(fast).toBeGreaterThanOrEqual(13);
    expect(fast).toBeLessThanOrEqual(18);

    // 30–90 s at 5 s: roughly 12 more, not roughly 30.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const slow = pollCount(fetchMock) - fast;
    expect(slow).toBeGreaterThanOrEqual(9);
    expect(slow).toBeLessThanOrEqual(15);

    await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
    expect(await screen.findByText(/taking longer than it should/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep waiting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: START_NEW_CONVERSATION })).toBeInTheDocument();

    const atDeadline = pollCount(fetchMock);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(pollCount(fetchMock)).toBe(atDeadline);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: /keep waiting/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(pollCount(fetchMock)).toBeGreaterThan(atDeadline);
  });

  it('operator times out while a poll request remains unresolved', async () => {
    // THE CASE A RESOLVING FETCH CANNOT REACH. If `fetch` never settles, the
    // in-loop clock check never runs again and no next tick is ever scheduled,
    // so a deadline that lives inside `poll()` can never fire. Only an
    // INDEPENDENT timer ends this, and only an abort frees the request.
    let aborted = false;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        return { ok: true, status: 200, json: async () => EMPTY_CONVERSATION } as Response;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });

    render(<OperatorClient />);
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();

    // One poll is in flight and will NEVER resolve.
    await waitFor(() => expect(pollCount(fetchMock as never)).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(pollCount(fetchMock as never)).toBe(1);
    expect(screen.queryByText(/taking longer than it should/i)).not.toBeInTheDocument();

    // At four minutes the independent timer fires regardless.
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
    expect(aborted).toBe(true);
    expect(await screen.findByText(/taking longer than it should/i)).toBeInTheDocument();
    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();

    // And both recovery actions WORK, not merely render.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: START_NEW_CONVERSATION }));
    expect(String(replaceMock.mock.calls.at(-1)![0])).toBe('/dashboard/operator');
    expect(screen.queryByText(/taking longer than it should/i)).not.toBeInTheDocument();
  });

  it('operator screen renders each failure reason with its wording and stops polling on 404 operator_disabled', async () => {
    for (const [reason, sentence] of Object.entries(TURN_FAILURE_WORDING)) {
      // The failure is read from the DURABLE transcript, which is where it
      // still is after a reload — not from the in-flight poll (RB-07).
      const fetchMock = routeFetch([
        [/^GET .*\/api\/operator\/conversation/, () => ({
          status: 200,
          body: conversationWith([storedTurn({ status: 'failed', failureReason: reason })]),
        })],
      ]);
      vi.stubGlobal('fetch', fetchMock);
      searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

      const { unmount } = render(<OperatorClient />);
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      const offers = reason === 'predecessor_stalled' || reason === 'exhausted';
      expect(screen.queryByRole('button', { name: START_NEW_CONVERSATION }) !== null).toBe(offers);
      unmount();
    }

    // A 404 `operator_disabled` from ANY route: the not-available notice, and
    // the loop stops rather than hammering a surface that does not exist (D3).
    const disabled = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 404, body: { error: 'operator_disabled' } })],
    ]);
    vi.stubGlobal('fetch', disabled);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });
    render(<OperatorClient />);

    expect(await screen.findByText(/not available right now/i)).toBeInTheDocument();
    const stopped = disabled.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(disabled.mock.calls.length).toBe(stopped);
    expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
  });

  it('operator screen disables the composer under All locations and enables it once a location is chosen', async () => {
    scopeMock.value = 'all';
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(<OperatorClient />);

    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    expect(screen.getByText(/pick one location/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('locationId='))).toBe(true);

    const chooser = screen.getByRole('group', { name: /choose a location/i });
    await user.click(within(chooser).getByRole('button', { name: 'Salon' }));
    expect(setScopeMock).toHaveBeenCalledWith(SALON);

    scopeMock.value = SALON;
    rerender(<OperatorClient />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /message/i })).toBeEnabled());
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`locationId=${SALON}`))).toBe(true);
    });
  });

  it('retry after a lost POST response resumes the original turn', async () => {
    // The server COMMITS and the response is lost. A retry that allocated a
    // new clientTurnKey would create a second turn, a second conversation and
    // a second model charge; the unique constraint deduplicates only on the
    // SAME key and payload (src/lib/agents/operator/turns.ts:47-54).
    let attempt = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        return { ok: true, status: 200, json: async () => EMPTY_CONVERSATION } as Response;
      }
      if (init?.method === 'POST') {
        attempt += 1;
        if (attempt === 1) throw new TypeError('network error');
        return { ok: true, status: 200, json: async () => ({ conversationId: CONVERSATION, turnId: TURN }) } as Response;
      }
      return { ok: true, status: 200, json: async () => turnBody() } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Make my replies warmer.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    const retryButton = await screen.findByRole('button', { name: RETRY_SEND });
    await user.click(retryButton);

    await waitFor(() => expect(postBodies(fetchMock as never)).toHaveLength(2));
    const [first, second] = postBodies(fetchMock as never);
    // IDENTICAL, field for field — including the key the server deduplicates on.
    expect(second).toEqual(first);
    expect(second.clientTurnKey).toBe(first.clientTurnKey);
    expect(second.conversationId).toBe(first.conversationId);

    // The successful retry clears the retry affordance and starts polling.
    await waitFor(() => expect(screen.queryByRole('button', { name: RETRY_SEND })).not.toBeInTheDocument());
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();

    // A NEW message allocates a new key.
    await user.clear(screen.getByRole('textbox', { name: /message/i }));
  });

  it('a POST that never settles releases the composer and offers the same retry', async () => {
    // THE CASE BEFORE ACCEPTANCE IS KNOWN. The poll loop's four-minute ceiling
    // only arms once a turn id exists; a submission that never settles left
    // `sending` true forever — no turn, no poll, no timeout notice and no
    // retry, which is an indefinite wait with no way out (C2).
    let posts = 0;
    let aborted = false;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        return { ok: true, status: 200, json: async () => EMPTY_CONVERSATION } as Response;
      }
      if (init?.method === 'POST') {
        posts += 1;
        if (posts === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }
        return {
          ok: true, status: 200,
          json: async () => ({ conversationId: CONVERSATION, turnId: TURN }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => turnBody() } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Make my replies warmer.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(postBodies(fetchMock as never)).toHaveLength(1));

    // Still in flight: the composer is busy and there is nothing to recover
    // with yet.
    expect(screen.getByRole('textbox', { name: /message/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: RETRY_SEND })).not.toBeInTheDocument();

    // The thirty-second deadline fires. The request is freed, the composer is
    // released, and the submission is treated as LOST — not as a failure the
    // owner has to retype.
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(aborted).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /message/i })).toBeEnabled();
    });
    const retryButton = await screen.findByRole('button', { name: RETRY_SEND });

    // And the retry sends the IDENTICAL payload, so a first attempt that
    // committed before the response was lost returns its original ids.
    await user.click(retryButton);
    await waitFor(() => expect(postBodies(fetchMock as never)).toHaveLength(2));
    const [first, second] = postBodies(fetchMock as never);
    expect(second).toEqual(first);
    expect(second.clientTurnKey).toBe(first.clientTurnKey);
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();
  });

  it('a refusal the server answered offers no retry and an unusable location says so', async () => {
    // TWO NON-RETRYABLE ANSWERS. `unauthorized` is a refusal the server
    // actually made: re-POSTing reaches the same refusal, so the retry
    // affordance would invite the owner to fail twice (S6). And an unusable
    // `?locationId=` is its own sentence, not the silent empty screen
    // `conversation_not_found` earns (S7).
    const refused = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: EMPTY_CONVERSATION })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 403, body: { error: 'unauthorized' } })],
    ]);
    vi.stubGlobal('fetch', refused);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const refusedRender = render(<OperatorClient />);

    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Make my replies warmer.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText(ROUTE_ERROR_WORDING.unauthorized!)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETRY_SEND })).not.toBeInTheDocument();
    refusedRender.unmount();

    // The archived or foreign location: a notice, and the wait ends — the
    // screen must not sit on "Preparing your plan" against a location that is
    // gone, nor keep asking about its turn.
    const gone = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 404, body: { error: 'location_not_found' },
      })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody() })],
    ]);
    vi.stubGlobal('fetch', gone);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION, turnId: TURN });
    render(<OperatorClient />);

    expect(await screen.findByText(LOCATION_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(PREPARING)).not.toBeInTheDocument();
    // At most the one read already in flight when the 404 landed, and then
    // nothing: the loop is torn down rather than backing off.
    const stopped = pollCount(gone);
    expect(stopped).toBeLessThanOrEqual(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(pollCount(gone)).toBe(stopped);
  });

  it('operator renders every stored segment kind in order', async () => {
    const proposal = {
      id: PROPOSAL, turnId: TURN, operation: 'set_tone', contractVersion: 1,
      labelKind: 'fact', locationId: SALON, status: 'pending',
      rationale: 'You asked for warmer replies.', input: { tone: 'warm and brief' },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      describe: 'Set the reply tone to "warm and brief"',
      preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
      receipt: null, appliedAt: null, failureReason: null,
    };
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200,
        body: conversationWith([storedTurn({
          proposals: [proposal],
          segments: [
            { type: 'text', text: 'Here is where things stand.' },
            // FROZEN at completion — a value, a period and an instant.
            { type: 'status', metric: 'pending_count', value: 3, reportingPeriodDays: 7, asOf: '2026-09-12T10:00:00.000Z' },
            { type: 'notice', text: '[review text removed]' },
            { type: 'scope_check', locationId: CAFE, locationName: 'Cafe' },
            { type: 'proposal', proposalId: PROPOSAL },
            { type: 'question', text: 'Shall I keep 4 and 5 stars the same?' },
          ],
        })]),
      })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    expect(await screen.findByText('Here is where things stand.')).toBeInTheDocument();
    // The STORED count and the STORED instant, not a live read.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/replies are waiting for you/i)).toBeInTheDocument();
    expect(screen.getByText(/as of/i).querySelector('time'))
      .toHaveAttribute('datetime', '2026-09-12T10:00:00.000Z');
    expect(screen.getByText('[review text removed]')).toBeInTheDocument();
    expect(screen.getByText('Shall I keep 4 and 5 stars the same?')).toBeInTheDocument();

    // The scope_check gives the owner a CHOOSER, not a sentence.
    const scopeGroup = screen.getByRole('group', { name: /which location/i });
    await user.click(within(scopeGroup).getByRole('button', { name: 'Cafe' }));
    expect(setScopeMock).toHaveBeenCalledWith(CAFE);

    // ORDER: the card sits where its `proposal` segment referenced it —
    // after the scope check and BEFORE the question.
    const article = screen.getByText('Make my replies warmer.').closest('article')!;
    const texts = Array.from(article.querySelectorAll('p, section'))
      .map((node) => node.textContent ?? '');
    const cardAt = texts.findIndex((t) => t.includes('Set the reply tone'));
    const questionAt = texts.findIndex((t) => t.includes('Shall I keep 4 and 5 stars'));
    expect(cardAt).toBeGreaterThan(-1);
    expect(cardAt).toBeLessThan(questionAt);
  });

  it('terminal failures and requested capabilities survive reload and subsequent turns', async () => {
    // Both are DURABLE rows. A screen that rendered them from the in-flight
    // poll lost them the moment the URL's turnId was cleared (RB-07).
    const failed = storedTurn({
      id: TURN, sequence: 1, status: 'failed', failureReason: 'exhausted',
    });
    const withCapability = storedTurn({
      id: '11111111-1111-4111-8111-111111111111',
      sequence: 2,
      ownerText: 'Stop replying on weekends.',
      unsupported: [{ id: 'u1', request: 'Stop replying on weekends', context: '' }],
    });
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200, body: conversationWith([failed, withCapability]),
      })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody({ status: 'completed' }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    // NO turnId in the URL — this is the state after a reload.
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    // `!`: the map is `Record<string, string>` and `noUncheckedIndexedAccess`
    // widens every read to `| undefined`. The key is one of the seven.
    expect(await screen.findByText(TURN_FAILURE_WORDING.exhausted!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: START_NEW_CONVERSATION })).toBeInTheDocument();
    expect(screen.getByText('Stop replying on weekends')).toBeInTheDocument();
    expect(screen.getByText(/cannot do this yet/i)).toBeInTheDocument();

    // Send ANOTHER turn: the earlier cards stay.
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'And make them shorter.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(screen.getByText(TURN_FAILURE_WORDING.exhausted!)).toBeInTheDocument();
    expect(screen.getByText('Stop replying on weekends')).toBeInTheDocument();
  });

  it('loaded conversations retain identity and starting over stays empty', async () => {
    // The bare GET returns the actor's LATEST conversation (src/lib/agents/operator/reads.ts:149-175).
    // Without adopting its id, the screen shows that transcript while the next
    // send opens a different conversation (RB-08).
    const unfinished = storedTurn({ status: 'running', ownerText: 'Make my replies warmer.' });
    let conversationBody: unknown = conversationWith([unfinished]);
    const fetchMock = routeFetch([
      [/^GET .*\/api\/operator\/conversation/, () => ({ status: 200, body: conversationBody })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody({ status: 'running' }) })],
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);

    // Identity adopted into state AND the URL…
    await waitFor(() => {
      expect(String(replaceMock.mock.calls.at(-1)![0])).toContain(`conversationId=${CONVERSATION}`);
    });
    // …and the unfinished turn is POLLED, not left hanging.
    expect(await screen.findByText(PREPARING)).toBeInTheDocument();
    await waitFor(() => expect(pollCount(fetchMock)).toBeGreaterThan(0));

    // STARTING OVER. The button is an offer the screen only makes once it has
    // something to recover FROM — the four-minute timeout, or a failed turn —
    // so the deadline is driven first rather than assumed (RB2-05).
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DEADLINE_TEST_MS); });
    expect(await screen.findByText(/taking longer than it should/i)).toBeInTheDocument();

    // …and now the screen empties and STAYS empty: the bare GET must not
    // immediately re-adopt the conversation just left.
    await user.click(screen.getByRole('button', { name: START_NEW_CONVERSATION }));
    expect(String(replaceMock.mock.calls.at(-1)![0])).toBe('/dashboard/operator');
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.queryByText('Make my replies warmer.')).not.toBeInTheDocument();

    // And the next send opens a NEW conversation, not the old one.
    conversationBody = EMPTY_CONVERSATION;
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Start fresh, please.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(postBodies(fetchMock).length).toBeGreaterThan(0));
    expect(postBodies(fetchMock)[0].conversationId).not.toBe(CONVERSATION);
  });

  it('a delayed conversation response never replaces a newly submitted turn', async () => {
    // THE RACE. The conversation GET is issued on mount and is slow. The owner
    // sends turn B; the POST resolves first. When the GET finally answers it
    // carries the OLDER unfinished turn A, and a callback that read the
    // `turnId` captured by its own render still sees `null` — so it would
    // adopt A, rewrite the URL to A, and cancel B's polling. The owner waits
    // forever for a reply that is no longer being polled (RB3-01).
    const TURN_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const TURN_B = TURN;
    let releaseConversation: (() => void) | null = null;
    const conversationBody = conversationWith([
      storedTurn({ id: TURN_A, status: 'running', ownerText: 'An older question.' }),
    ]);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/api/operator/conversation')) {
        // HELD. Resolved by hand, after the POST.
        await new Promise<void>((resolve) => { releaseConversation = resolve; });
        return { ok: true, status: 200, json: async () => conversationBody } as Response;
      }
      if (init?.method === 'POST') {
        return {
          ok: true, status: 200,
          json: async () => ({ conversationId: CONVERSATION, turnId: TURN_B }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => turnBody({ id: TURN_B, status: 'running' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OperatorClient />);
    await waitFor(() => expect(releaseConversation).not.toBeNull());

    // Turn B is submitted and accepted while the read is still outstanding.
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'A newer question.');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(postBodies(fetchMock as never)).toHaveLength(1));
    await waitFor(() => {
      expect(String(replaceMock.mock.calls.at(-1)![0])).toContain(`turnId=${TURN_B}`);
    });
    const pollsForB = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes(`/api/operator/turns/${TURN_B}`)).length;
    await waitFor(() => expect(pollsForB()).toBeGreaterThan(0));
    const before = pollsForB();

    // NOW the stale answer arrives, naming the older unfinished turn A.
    releaseConversation!();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    // B still owns the URL, and A was never adopted.
    expect(String(replaceMock.mock.calls.at(-1)![0])).toContain(`turnId=${TURN_B}`);
    expect(String(replaceMock.mock.calls.at(-1)![0])).not.toContain(TURN_A);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes(`/api/operator/turns/${TURN_A}`)),
    ).toBe(false);

    // …and B is STILL being polled, not cancelled.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(pollsForB()).toBeGreaterThan(before);
    expect(screen.getByText(PREPARING)).toBeInTheDocument();
  });

  // Round-1 addition RB-03, converted by T4 (it wires Refresh plan).
  it('Refresh plan preserves the original instruction and location after scope changes', async () => {
    // A STALE plan prepared for the Salon, while the browser now points at the
    // Cafe. Reading the composer scope here would prepare the replacement for
    // the wrong location, and `createTurn` would accept it without complaint —
    // it validates only that the location is an active member of the account
    // (src/lib/agents/operator/turns.ts:122-129).
    const stale = {
      id: PROPOSAL, turnId: TURN, operation: 'set_tone', contractVersion: 1,
      labelKind: 'fact', locationId: SALON, status: 'stale',
      rationale: 'You asked for warmer replies.', input: { tone: 'warm and brief' },
      before: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      after: { tone: 'warm and brief', productsServices: null, avoidFacts: [], highlightFacts: [], sampleResponses: [] },
      describe: 'Set the reply tone to "warm and brief"',
      preparedVersionToken: { businessId: SALON, updatedAt: '2026-09-12 09:00:00.111111+00' },
      receipt: null, appliedAt: null, failureReason: 'version_mismatch',
    };
    const staleConversation = (): Array<[RegExp, () => { status: number; body: unknown }]> => [
      [/^GET .*\/api\/operator\/conversation/, () => ({
        status: 200,
        body: conversationWith([storedTurn({ proposals: [stale] })]),
      })],
      [/^POST .*\/api\/operator\/turns$/, () => ({ status: 200, body: { conversationId: CONVERSATION, turnId: TURN } })],
      [/^GET .*\/api\/operator\/turns\//, () => ({ status: 200, body: turnBody() })],
    ];

    const fetchMock = routeFetch(staleConversation());
    vi.stubGlobal('fetch', fetchMock);
    searchParamsMock.value = new URLSearchParams({ conversationId: CONVERSATION });

    // THE SELECTOR HAS MOVED to the Cafe.
    scopeMock.value = CAFE;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const moved = render(<OperatorClient />);

    await user.click(await screen.findByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(1));
    const [refreshed] = postBodies(fetchMock);
    // The ORIGINAL instruction and the ORIGINAL location, verbatim.
    expect(refreshed.text).toBe('Make my replies warmer.');
    expect(refreshed.locationId).toBe(SALON);
    // A NEW key: this is a new turn, not a replay of the old one.
    expect(refreshed.clientTurnKey).not.toBe(stale.preparedVersionToken.updatedAt);
    expect(typeof refreshed.clientTurnKey).toBe('string');
    moved.unmount();

    // AND UNDER `All locations`. The composer is disabled there, but the plan
    // already names its location — refusing to refresh it would leave the
    // owner with a dead card and no way back except changing a selector the
    // card does not use.
    const underAll = routeFetch(staleConversation());
    vi.stubGlobal('fetch', underAll);
    scopeMock.value = 'all';
    render(<OperatorClient />);

    const button = await screen.findByRole('button', { name: 'Refresh plan' });
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(postBodies(underAll)).toHaveLength(1));
    expect(postBodies(underAll)[0].locationId).toBe(SALON);
  });
});
