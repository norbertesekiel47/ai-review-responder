// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PastReplyRow } from '@/components/dashboard/PastReplyCard';
import { useEditReplyDraft } from '../useEditReplyDraft';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

function makeRow(overrides: Partial<PastReplyRow> = {}): PastReplyRow {
  return {
    review_id: 'rev-1',
    review_text: 'Great place',
    review_date: '2026-05-01T00:00:00Z',
    reviewer_name: 'Pat',
    star_rating: 5,
    response_id: 'resp-posted-1',
    approved_text: 'Thanks Pat!',
    posted_at: '2026-05-02T00:00:00Z',
    external_reply_ingested_at: null,
    review_content_hash: 'hash-abc',
    version: 3,
    canEdit: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 400);
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refreshMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(args?: {
  row?: PastReplyRow;
  initialFailureRecovery?: { failedResponseId: string; failedPostingError: string | null } | null;
  onClose?: () => void;
}) {
  const onClose = args?.onClose ?? vi.fn();
  const utils = renderHook(() =>
    useEditReplyDraft({
      row: args?.row ?? makeRow(),
      initialFailureRecovery: args?.initialFailureRecovery ?? null,
      onClose,
    }),
  );
  return { ...utils, onClose };
}

describe('useEditReplyDraft — initial + manual', () => {
  it('starts in initial by default', () => {
    const { result } = setup();
    expect(result.current.state).toEqual({ kind: 'initial' });
    expect(result.current.isClosePending).toBe(false);
  });

  it('initialFailureRecovery starts in recovery', () => {
    const { result } = setup({
      initialFailureRecovery: { failedResponseId: 'resp-fail-1', failedPostingError: 'post_after_delete_failed_x' },
    });
    expect(result.current.state).toEqual({
      kind: 'recovery',
      failedResponseId: 'resp-fail-1',
      failedPostingError: 'post_after_delete_failed_x',
    });
  });

  it('startManualEdit enters editing with the current reply text', () => {
    const { result } = setup({ row: makeRow({ approved_text: 'Existing reply' }) });
    act(() => result.current.actions.startManualEdit());
    expect(result.current.state).toEqual({ kind: 'editing', text: 'Existing reply', draftResponseId: null });
  });

  it('submitManual rejects empty text without fetching', async () => {
    const { result } = setup();
    await act(async () => { await result.current.actions.submitManual('   ', null); });
    expect(result.current.state).toEqual({ kind: 'error', message: 'Reply text cannot be empty.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reset returns to initial from the error state', async () => {
    const { result } = setup();
    await act(async () => { await result.current.actions.submitManual('   ', null); });
    expect(result.current.state.kind).toBe('error');
    act(() => result.current.actions.reset());
    expect(result.current.state).toEqual({ kind: 'initial' });
  });

  it('maps a thrown fetch error to the error state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = setup();
    await act(async () => { await result.current.actions.submitManual('text', null); });
    expect(result.current.state).toEqual({ kind: 'error', message: 'network down' });
  });

  it('submitManual creates a draft, publishes, succeeds, refreshes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ response_id: 'resp-new' }))
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-1' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.submitManual('New reply text', null); });
    expect(result.current.state.kind).toBe('success');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/past-replies/draft');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/dashboard/past-replies/publish');
  });

  it('submitManual with an existing draft id PATCHes then publishes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-2' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.submitManual('Edited', 'resp-existing'); });
    expect(result.current.state.kind).toBe('success');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/past-replies/draft/resp-existing');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('PATCH');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/dashboard/past-replies/publish');
  });
});

describe('useEditReplyDraft — 409 mapping', () => {
  it('maps 409 review_changed to the review_changed state', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'review_changed', current_review_text: 'updated text' }, { ok: false, status: 409 }),
    );
    const { result } = setup();
    await act(async () => { await result.current.actions.submitManual('x', null); });
    expect(result.current.state).toEqual({ kind: 'review_changed', currentText: 'updated text' });
  });

  it('maps 409 draft_already_exists to draft_conflict', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'draft_already_exists', existing: { response_id: 'd1', text: 'draft body', is_edited: true, status: 'pending_approval' } },
        { ok: false, status: 409 },
      ),
    );
    const { result } = setup();
    await act(async () => { await result.current.actions.startRegenerate(); });
    expect(result.current.state).toEqual({
      kind: 'draft_conflict',
      existing: { responseId: 'd1', text: 'draft body', isEdited: true, status: 'pending_approval' },
    });
  });
});

describe('useEditReplyDraft — regenerate + polling', () => {
  it('polls to preview on success', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-9' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'generating' }))
      .mockResolvedValueOnce(jsonResponse({ response_id: 'resp-ai', response_text: 'AI draft' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.startRegenerate(); });
    expect(result.current.state).toEqual({ kind: 'regenerating', outboxId: 'ob-9' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.state.kind).toBe('regenerating');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.state).toEqual({ kind: 'preview', draftResponseId: 'resp-ai', text: 'AI draft' });
  });

  it('transitions to regenerate_poll_error after the 60s budget', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-t' }));
    fetchMock.mockResolvedValue(jsonResponse({ status: 'generating' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.startRegenerate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(62_000); });
    expect(result.current.state.kind).toBe('regenerate_poll_error');
    if (result.current.state.kind === 'regenerate_poll_error') {
      expect(result.current.state.outboxId).toBe('ob-t');
    }
  });

  it('treats poll status=failed as closable error', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-f' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'LLM exploded' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.startRegenerate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.state).toEqual({ kind: 'error', message: 'LLM exploded' });
  });

  it('treats a non-OK poll as regenerate_poll_error', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-n' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { ok: false, status: 503 }));
    const { result } = setup();
    await act(async () => { await result.current.actions.startRegenerate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.state.kind).toBe('regenerate_poll_error');
  });

  it('resumePolling re-enters regenerating with the same outboxId', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-r' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'x' }, { ok: false, status: 500 }));
    const { result } = setup();
    await act(async () => { await result.current.actions.startRegenerate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.state.kind).toBe('regenerate_poll_error');
    act(() => result.current.actions.resumePolling());
    expect(result.current.state).toEqual({ kind: 'regenerating', outboxId: 'ob-r' });
  });
});

describe('useEditReplyDraft — preview, recovery, conflict', () => {
  it('publishExisting publishes without a PATCH and succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-p' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.publishExisting('resp-ai'); });
    expect(result.current.state.kind).toBe('success');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/past-replies/publish');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('editFurther moves preview → editing carrying text + draft id', () => {
    const { result } = setup();
    act(() => result.current.actions.resumeExistingDraft({ responseId: 'd9', text: 'draft txt' }));
    expect(result.current.state).toEqual({ kind: 'preview', draftResponseId: 'd9', text: 'draft txt' });
    act(() => result.current.actions.editFurther());
    expect(result.current.state).toEqual({ kind: 'editing', text: 'draft txt', draftResponseId: 'd9' });
  });

  it('retryPosting posts to /retry and succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outbox_id: 'ob-rt' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.retryPosting('resp-fail'); });
    expect(result.current.state.kind).toBe('success');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/past-replies/resp-fail/retry');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('restoreOriginal posts to /restore-original and succeeds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ response_id: 'resp-restored', outbox_id: 'ob-ro' }));
    const { result } = setup();
    await act(async () => { await result.current.actions.restoreOriginal('resp-fail'); });
    expect(result.current.state.kind).toBe('success');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/past-replies/resp-fail/restore-original');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('discardExistingDraft DELETEs then returns to initial', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 204 }));
    const { result } = setup();
    await act(async () => { await result.current.actions.discardExistingDraft('d-discard'); });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/past-replies/draft/d-discard');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect(result.current.state).toEqual({ kind: 'initial' });
  });
});

describe('useEditReplyDraft — tryClose / cancelDraft', () => {
  it('refuses to close while a draft is being created', async () => {
    let resolvePost!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolvePost = res; }));
    const onClose = vi.fn();
    const { result } = setup({ onClose });
    act(() => { void result.current.actions.startRegenerate(); });
    expect(result.current.state.kind).toBe('creating_draft');
    expect(result.current.isClosePending).toBe(true);
    act(() => result.current.tryClose());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { resolvePost(jsonResponse({ outbox_id: 'ob-z' })); });
  });

  it('closes directly from initial', () => {
    const onClose = vi.fn();
    const { result } = setup({ onClose });
    act(() => result.current.tryClose());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deletes the draft then closes when editing with a draft id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { status: 204 }));
    const onClose = vi.fn();
    const { result } = setup({ onClose });
    act(() => result.current.actions.resumeExistingDraft({ responseId: 'd-edit', text: 't' }));
    act(() => result.current.actions.editFurther());
    expect(result.current.state).toMatchObject({ kind: 'editing', draftResponseId: 'd-edit' });
    act(() => result.current.tryClose());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe('DELETE');
  });

  it('cancelDraft with no draft id closes without fetching', async () => {
    const onClose = vi.fn();
    const { result } = setup({ onClose });
    await act(async () => { await result.current.actions.cancelDraft(null); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
