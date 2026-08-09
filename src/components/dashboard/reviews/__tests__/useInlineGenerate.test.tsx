// @vitest-environment jsdom
//
// src/components/dashboard/reviews/__tests__/useInlineGenerate.test.tsx
//
// The **On-demand generation** client state machine (#678) — the `Generate`
// affordance on a never-replied row of the Reviews list.
//
// The T1 intake pinned 52 titles across the query, the routes, the row states
// and the card, but none across this hook: the state machine shipped at 0%
// covered and fallow's CRAP gate caught it (see the deviations file). These
// titles are additive.
//
// Direct precedent: edit-reply/__tests__/useEditReplyDraft.test.tsx — same
// fake-timer + mocked-fetch shape, same poll-and-settle machine. What is NOT
// shared: this hook has no optimistic-concurrency snapshot and no useRouter, so
// there is no refresh to assert (design point 2 in the hook header).

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInlineGenerate } from '@/components/dashboard/reviews/useInlineGenerate';

const REVIEW_ID = 'review-1';
const GENERATE_URL = `/api/dashboard/reviews/${REVIEW_ID}/generate`;
const STATUS_URL = `/api/dashboard/reviews/${REVIEW_ID}/draft-status`;
// Mirrors the hook's own constants; they are module-private by design.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 400);
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A response whose body is not JSON — exercises readJsonSafe's null path. */
function unparseableResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(resumeGenerating = false) {
  return renderHook(() => useInlineGenerate({ reviewId: REVIEW_ID, resumeGenerating }));
}

/**
 * Fire the one armed poll timer, settle its fetch, and let React re-run the
 * effect that arms the next one. The hook re-issues the `generating` state to
 * continue polling, so a poll costs a render — advancing one interval at a time
 * keeps each step observable.
 */
async function advanceOnePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
}

function requestMethod(call: unknown[]): string | undefined {
  return (call[1] as RequestInit | undefined)?.method;
}

// ── start: POST /generate ────────────────────────────────────────────────────

describe('useInlineGenerate — start', () => {
  it('useInlineGenerate starts idle when the server row is not already generating', () => {
    const { result } = setup();
    expect(result.current.state).toEqual({ kind: 'idle' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useInlineGenerate holds starting until POST /generate resolves, then enters generating', async () => {
    // 'starting' exists so the polling effect cannot fire before the route has
    // committed the outbox row it polls for.
    let resolvePost!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolvePost = res;
      }),
    );
    const { result } = setup();

    act(() => {
      void result.current.actions.start();
    });
    expect(result.current.state).toEqual({ kind: 'starting' });

    await act(async () => {
      resolvePost(jsonResponse({ outbox_id: 'ob-1', version: 1 }));
    });
    expect(result.current.state.kind).toBe('generating');
    expect(fetchMock.mock.calls[0]![0]).toBe(GENERATE_URL);
    expect(requestMethod(fetchMock.mock.calls[0]!)).toBe('POST');
  });

  it('useInlineGenerate surfaces a 429 rate_limited body verbatim', async () => {
    // dashboard-regen-rate-limit.ts sends `{ error: 'rate_limited' }` with no
    // message; the hook falls back to the code rather than forking the copy.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'rate_limited' }, { ok: false, status: 429 }),
    );
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.state).toEqual({ kind: 'error', message: 'rate_limited' });
  });

  it('useInlineGenerate surfaces a 429 regen_limit_reached message verbatim', async () => {
    const serverCopy = 'Daily regenerate limit reached for this review — you can try again tomorrow.';
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'regen_limit_reached', message: serverCopy, remaining: 0, limit: 3 },
        { ok: false, status: 429 },
      ),
    );
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.state).toEqual({ kind: 'error', message: serverCopy });
  });

  it('useInlineGenerate falls back to the status code when the generate body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce(unparseableResponse(500));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.state).toEqual({ kind: 'error', message: 'Generate failed (500).' });
  });

  it('useInlineGenerate maps a thrown generate fetch to the error state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.state).toEqual({ kind: 'error', message: 'network down' });
  });
});

// ── polling ─────────────────────────────────────────────────────────────────

describe('useInlineGenerate — polling', () => {
  it('useInlineGenerate polls draft-status through generating and settles on ready with the draft text', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-9', version: 1 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'generating' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'ready', response_id: 'resp-ai', response_text: 'AI draft' }),
      );
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.state.kind).toBe('generating');

    await advanceOnePoll();
    expect(result.current.state.kind).toBe('generating');

    await advanceOnePoll();
    expect(result.current.state).toEqual({
      kind: 'ready',
      responseId: 'resp-ai',
      text: 'AI draft',
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(STATUS_URL);
    // Settled: nothing is armed, so no further spend can be triggered by the poll.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('useInlineGenerate treats a ready draft with a null response_text as empty rather than undefined', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-null' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'ready', response_id: 'resp-empty', response_text: null }),
      );
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    await advanceOnePoll();
    expect(result.current.state).toEqual({ kind: 'ready', responseId: 'resp-empty', text: '' });
  });

  it('useInlineGenerate carries the server message when the poll reports failed', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-f' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'LLM exploded' }));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    await advanceOnePoll();
    expect(result.current.state).toEqual({ kind: 'error', message: 'LLM exploded' });
  });

  it('useInlineGenerate returns to idle and stops polling when the poll reports idle', async () => {
    // Invariant #4: a moderation-HELD draft lands here — the poller never returns
    // held text. The row must fall back to the `Generate` affordance without a
    // draft, and must NOT keep polling for text it will never be given.
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-held' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'idle' }));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    await advanceOnePoll();

    expect(result.current.state).toEqual({ kind: 'idle' });
    expect(vi.getTimerCount()).toBe(0);

    const callsAfterSettle = fetchMock.mock.calls.length;
    await advanceOnePoll();
    expect(fetchMock.mock.calls.length).toBe(callsAfterSettle);
  });

  it('useInlineGenerate reports a non-OK poll with the status code', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-n' }))
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503 }));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    await advanceOnePoll();
    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Status check failed (503).',
    });
  });

  it('useInlineGenerate maps a thrown poll fetch to the network error state', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-throw' }))
      .mockRejectedValueOnce(new Error('connection reset'));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    await advanceOnePoll();
    expect(result.current.state).toEqual({ kind: 'error', message: 'connection reset' });
  });

  it('useInlineGenerate gives up after the poll timeout budget', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-t' }));
    fetchMock.mockResolvedValue(jsonResponse({ status: 'generating' }));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    // One extra interval past the budget: the deadline is checked when the timer
    // fires, so the poll that crosses POLL_TIMEOUT_MS is the one that gives up.
    const polls = Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS) + 2;
    for (let i = 0; i < polls; i += 1) {
      await advanceOnePoll();
    }

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Generation is taking longer than expected. Refresh to check again.',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── D-C: refresh survival ───────────────────────────────────────────────────

describe('useInlineGenerate — resumeGenerating', () => {
  it('useInlineGenerate mounted with resumeGenerating polls immediately without a second generate POST', async () => {
    // D-C. The server row arrives already carrying row_action 'generating', so a
    // refresh must resume the poll rather than re-offer `Generate` and burn a
    // rate-limit token to learn it 409s.
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'ready', response_id: 'resp-resumed', response_text: 'Resumed draft' }),
    );
    const { result } = setup(true);

    expect(result.current.state.kind).toBe('generating');
    expect(vi.getTimerCount()).toBe(1);

    await advanceOnePoll();

    expect(result.current.state).toEqual({
      kind: 'ready',
      responseId: 'resp-resumed',
      text: 'Resumed draft',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(STATUS_URL);
    expect(fetchMock.mock.calls.every((call) => call[0] !== GENERATE_URL)).toBe(true);
  });

  it('useInlineGenerate clears the armed poll timer on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = setup(true);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useInlineGenerate does not re-arm or settle when unmounted mid-poll', async () => {
    // The `cancelled` guard after the awaits is what makes the cleanup total: a
    // response that lands after unmount must neither settle the machine nor arm
    // another timer.
    vi.useFakeTimers();
    let resolvePoll!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolvePoll = res;
      }),
    );
    const { result, unmount } = setup(true);

    await advanceOnePoll();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolvePoll(jsonResponse({ status: 'generating' }));
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.kind).toBe('generating');
  });
});

// ── terminal actions ────────────────────────────────────────────────────────

describe('useInlineGenerate — approve, edit, reset', () => {
  async function settleReady() {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-r' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'ready', response_id: 'resp-1', response_text: 'Thanks!' }),
      );
    const utils = setup();
    await act(async () => {
      await utils.result.current.actions.start();
    });
    await advanceOnePoll();
    return utils;
  }

  it('useInlineGenerate approve posts to the approve route and lands on posted', async () => {
    const { result } = await settleReady();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'Reply queued.' }));

    await act(async () => {
      await result.current.actions.approve();
    });

    expect(result.current.state).toEqual({ kind: 'posted', message: 'Reply queued.' });
    const approveCall = fetchMock.mock.calls.at(-1)!;
    expect(approveCall[0]).toBe(`/api/dashboard/reviews/${REVIEW_ID}/approve`);
    expect(requestMethod(approveCall)).toBe('POST');
    expect((approveCall[1] as RequestInit).body).toBeUndefined();
  });

  it('useInlineGenerate holds publishing while the approve request is in flight', async () => {
    const { result } = await settleReady();
    let resolvePost!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolvePost = res;
      }),
    );

    act(() => {
      void result.current.actions.approve();
    });
    expect(result.current.state).toEqual({ kind: 'publishing' });

    await act(async () => {
      resolvePost(jsonResponse({ success: true }));
    });
    expect(result.current.state).toEqual({ kind: 'posted', message: 'Reply queued for Google.' });
  });

  it('useInlineGenerate surfaces a failed approve with the server message', async () => {
    const { result } = await settleReady();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'already_answered' }, { ok: false, status: 409 }),
    );

    await act(async () => {
      await result.current.actions.approve();
    });
    expect(result.current.state).toEqual({ kind: 'error', message: 'already_answered' });
  });

  it('useInlineGenerate maps a thrown approve fetch to the error state', async () => {
    const { result } = await settleReady();
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));

    await act(async () => {
      await result.current.actions.approve();
    });
    expect(result.current.state).toEqual({ kind: 'error', message: 'socket hang up' });
  });

  it('useInlineGenerate moves ready → editing → ready without losing the draft text', async () => {
    const { result } = await settleReady();

    act(() => result.current.actions.startEdit());
    expect(result.current.state).toEqual({
      kind: 'editing',
      responseId: 'resp-1',
      text: 'Thanks!',
    });

    act(() => result.current.actions.changeEditText('Thanks so much!'));
    expect(result.current.state).toEqual({
      kind: 'editing',
      responseId: 'resp-1',
      text: 'Thanks so much!',
    });

    act(() => result.current.actions.cancelEdit());
    expect(result.current.state).toEqual({
      kind: 'ready',
      responseId: 'resp-1',
      text: 'Thanks so much!',
    });
  });

  it('useInlineGenerate ignores edit transitions from a non-ready state', async () => {
    const { result } = setup();

    act(() => result.current.actions.startEdit());
    expect(result.current.state).toEqual({ kind: 'idle' });

    act(() => result.current.actions.changeEditText('nope'));
    expect(result.current.state).toEqual({ kind: 'idle' });

    act(() => result.current.actions.cancelEdit());
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('useInlineGenerate saveEdit posts the edited text to the edit route', async () => {
    const { result } = await settleReady();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'Edited reply queued.' }));

    await act(async () => {
      await result.current.actions.saveEdit('My own words');
    });

    expect(result.current.state).toEqual({ kind: 'posted', message: 'Edited reply queued.' });
    const editCall = fetchMock.mock.calls.at(-1)!;
    expect(editCall[0]).toBe(`/api/dashboard/reviews/${REVIEW_ID}/edit`);
    expect(JSON.parse((editCall[1] as RequestInit).body as string)).toEqual({
      editedText: 'My own words',
    });
  });

  it('useInlineGenerate reset returns to idle from the error state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();

    await act(async () => {
      await result.current.actions.start();
    });
    expect(result.current.state.kind).toBe('error');

    act(() => result.current.actions.reset());
    expect(result.current.state).toEqual({ kind: 'idle' });
  });
});
