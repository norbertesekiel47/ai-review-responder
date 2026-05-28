# EditReplyDrawer Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `src/components/dashboard/EditReplyDrawer.tsx` (1275 LOC) into a ~300-LOC composing shell plus an `edit-reply/` feature folder (`useEditReplyDraft` hook, `useFocusTrap` hook, 5 panel files) with a new hook test suite — preserving every behavior and the public contract.

**Architecture:** Pure structural refactor. Extract the 11-state draft machine (state + 9 async actions + 60s polling) into `useEditReplyDraft`; extract focus-trap/Esc/restore into `useFocusTrap`; extract the 5 substantial panels each to a file. The shell calls the two hooks and switches on `state.kind`. All moves are **verbatim** (copy bodies unchanged, adjust only imports/exports) to prevent transcription drift. The existing `PastRepliesClient.test.tsx` (22 tests) is the continuous behavioral backstop; a new `useEditReplyDraft` characterization suite locks the extracted contract.

**Tech Stack:** React 19 + Next.js 16 (App Router, client component), TypeScript strict, Vitest 4 + `@testing-library/react` v16 (`renderHook`) + jsdom, pnpm.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-28-edit-reply-drawer-modularization-design.md`
- Candidate rationale: `docs/modular-requirement.md` (Tier 1)
- Precedent feature folder: `src/components/auth/auth-island/`

**Working location:** isolated worktree `~/.config/superpowers/worktrees/RepWorth/edit-reply-drawer-modularization` on branch `refactor/edit-reply-drawer-modularization` (off `main`). Run all commands from there. Deps installed; baseline green (typecheck + 22/22 `PastRepliesClient`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/dashboard/EditReplyDrawer.tsx` | MODIFIED → composing shell: props, two hook calls, `if (!open) return null`, the state-switch render JSX, local `Spinner`. Same path + export. |
| `src/components/dashboard/edit-reply/useEditReplyDraft.ts` | NEW → draft state machine: `DrawerState` type, snapshot, 9 async actions, `handleHttpError`, polling effect, `tryClose`, 3 declarative transitions, `isClosePending`. Owns `POLL_*`. |
| `src/components/dashboard/edit-reply/useFocusTrap.ts` | NEW → focus capture / Tab-trap / Esc / focus-restore. Returns `panelRef`. |
| `src/components/dashboard/edit-reply/ManualEditor.tsx` | NEW → moved verbatim; owns `MAX_REPLY_CHARS`. |
| `src/components/dashboard/edit-reply/PreviewPanel.tsx` | NEW → moved verbatim. |
| `src/components/dashboard/edit-reply/RecoveryPanel.tsx` | NEW → moved verbatim. |
| `src/components/dashboard/edit-reply/DraftConflictPanel.tsx` | NEW → moved verbatim (keeps `next/link`). |
| `src/components/dashboard/edit-reply/ReviewChangedPanel.tsx` | NEW → moved verbatim. |
| `src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx` | NEW → characterization suite for the hook. |

**Line-range map of the current file** (source of all verbatim moves — read the current file before moving):
- `POLL_INTERVAL_MS`, `POLL_TIMEOUT_MS`: lines 39–40 → hook
- `MAX_REPLY_CHARS`: line 38 → stays until Task 3, then → `ManualEditor.tsx`
- `Snapshot`: 64–67 → hook · `DrawerState`: 69–100 → hook (exported) · `ApiErrorPayload`: 102–112 → hook · `readJsonSafe`: 114–120 → hook
- `snapshotRef`: 136–139 · initial `useState`: 144–152 · `currentReplyText`: 153 → hook
- focus `useEffect`: 167–222 → `useFocusTrap` (Task 2) · polling `useEffect`: 241–313 → hook
- `handleHttpError`: 315–344 · `startManualEdit`: 350–352 · `startRegenerate`: 354–386 · `submitManual`: 388–469 · `publishExisting`: 478–508 · `cancelDraft`: 510–527 · `tryClose`: 553–576 · `tryCloseRef` sync `useEffect`: 578–581 → `useFocusTrap` (Task 2) · `retryPosting`: 583–609 · `resumeExistingDraft`: 614–623 · `discardExistingDraft`: 627–637 · `restoreOriginal`: 639–677 → hook
- render JSX: 681–938 → stays (with swaps) · `Spinner`: 945–952 → stays · panels: 954–1275 → Task 3

---

## Task 1: Extract `useEditReplyDraft` (test-first)

**Files:**
- Create: `src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx`
- Create: `src/components/dashboard/edit-reply/useEditReplyDraft.ts`
- Modify: `src/components/dashboard/EditReplyDrawer.tsx`

- [ ] **Step 1: Write the failing hook test suite**

Create `src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx`:

```tsx
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
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
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

  it('cancelDraft with no draft id closes without fetching', () => {
    const onClose = vi.fn();
    const { result } = setup({ onClose });
    act(() => result.current.actions.cancelDraft(null));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx`
Expected: FAIL — `Failed to resolve import "../useEditReplyDraft"` (the hook module does not exist yet).

- [ ] **Step 3: Create the hook by moving the state machine verbatim**

Create `src/components/dashboard/edit-reply/useEditReplyDraft.ts`. Move the bodies **verbatim** from `EditReplyDrawer.tsx` at the line ranges in the File Structure map — do not retype or "improve" them; copy exactly and only adjust the wrapper. Structure:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/PastReplyCard';

const POLL_INTERVAL_MS = 1500; // verbatim from line 39
const POLL_TIMEOUT_MS = 60_000; // verbatim from line 40

interface Snapshot { /* MOVE verbatim: lines 64–67 */ }

export type DrawerState = /* MOVE verbatim: lines 69–100 (export added) */;

interface ApiErrorPayload { /* MOVE verbatim: lines 102–112 */ }

async function readJsonSafe(res: Response): Promise<ApiErrorPayload | null> {
  /* MOVE verbatim: lines 115–119 body */
}

export interface UseEditReplyDraftParams {
  row: PastReplyRow;
  initialFailureRecovery: { failedResponseId: string; failedPostingError: string | null } | null;
  onClose: () => void;
}

export function useEditReplyDraft({ row, initialFailureRecovery, onClose }: UseEditReplyDraftParams) {
  const router = useRouter();

  // MOVE verbatim, in source order:
  //   snapshotRef            (lines 136–139)
  //   const [state, setState] = useState<DrawerState>( … )  (lines 144–152)
  //   const currentReplyText = row.approved_text ?? '';      (line 153)
  //   polling useEffect      (lines 241–313)
  //   handleHttpError        (lines 315–344)
  //   startManualEdit        (lines 350–352)
  //   startRegenerate        (lines 354–386)
  //   submitManual           (lines 388–469)
  //   publishExisting        (lines 478–508)
  //   cancelDraft            (lines 510–527)
  //   tryClose               (lines 553–576)
  //   retryPosting           (lines 583–609)
  //   resumeExistingDraft    (lines 614–623)
  //   discardExistingDraft   (lines 627–637)
  //   restoreOriginal        (lines 639–677)
  // NOTE: the focus useEffect (167–222) and tryCloseRef sync (578–581) do NOT
  // move here — they go to useFocusTrap in Task 2. tryClose still MOVES here now.

  // ─── NEW: declarative transitions (replace the 3 inline setState calls in JSX) ───
  const resumePolling = useCallback(() => {
    setState((prev) =>
      prev.kind === 'regenerate_poll_error' ? { kind: 'regenerating', outboxId: prev.outboxId } : prev,
    );
  }, []);

  const editFurther = useCallback(() => {
    setState((prev) =>
      prev.kind === 'preview' ? { kind: 'editing', text: prev.text, draftResponseId: prev.draftResponseId } : prev,
    );
  }, []);

  const reset = useCallback(() => {
    setState({ kind: 'initial' });
  }, []);

  const isClosePending =
    state.kind === 'creating_draft' || state.kind === 'regenerating' || state.kind === 'regenerate_poll_error';

  return {
    state,
    isClosePending,
    tryClose,
    actions: {
      startManualEdit,
      startRegenerate,
      submitManual,
      publishExisting,
      cancelDraft,
      retryPosting,
      resumeExistingDraft,
      discardExistingDraft,
      restoreOriginal,
      resumePolling,
      editFurther,
      reset,
    },
  };
}
```

- [ ] **Step 4: Rewire the shell to consume the hook**

Edit `src/components/dashboard/EditReplyDrawer.tsx`:

1. Replace the React import (it no longer needs `useState`/`useCallback`; it still needs `useEffect`/`useRef` for the focus trap that stays until Task 2):
   ```ts
   import { useEffect, useRef } from 'react';
   ```
2. Remove the now-moved definitions from the file: `POLL_INTERVAL_MS`/`POLL_TIMEOUT_MS` (39–40), `Snapshot` (64–67), `DrawerState` (69–100), `ApiErrorPayload` (102–112), `readJsonSafe` (114–120), and inside the component the `snapshotRef`, the initial `useState`, `currentReplyText`, the polling `useEffect`, `handleHttpError`, and all nine action callbacks + `tryClose`. Keep `MAX_REPLY_CHARS` (line 38) and `AI_DRAFT_DISCLOSURE` import (used by the inline `initial` block + panels).
3. Add the hook import and call at the top of the component body (replacing the removed declarations), keeping the focus refs/effect for now:
   ```ts
   import { useEditReplyDraft } from '@/components/dashboard/edit-reply/useEditReplyDraft';
   // …
   export function EditReplyDrawer({ open, onClose, row, canEdit, initialFailureRecovery = null }: EditReplyDrawerProps) {
     const router = useRouter();
     const { state, isClosePending, tryClose, actions } = useEditReplyDraft({ row, initialFailureRecovery, onClose });

     const panelRef = useRef<HTMLElement | null>(null);   // stays until Task 2
     const openerRef = useRef<HTMLElement | null>(null);  // stays until Task 2
     const tryCloseRef = useRef<() => void>(onClose);      // stays until Task 2
     // focus useEffect (lines 167–222) stays here, unchanged
     // tryCloseRef sync useEffect (lines 578–581) stays here, unchanged — it reads `tryClose` from the hook
     // …
   ```
   `router` stays in the shell because the `ReviewChangedPanel`/`DraftConflictPanel` `onRefresh` handlers call `router.refresh()`.
4. Swap the render-body references (search-and-replace, exact):
   - `startManualEdit` → `actions.startManualEdit`
   - `startRegenerate` → `actions.startRegenerate`
   - `() => cancelDraft(state.draftResponseId)` → `() => actions.cancelDraft(state.draftResponseId)` (both occurrences: editing onCancel ~796, preview onCancel ~850)
   - `(text) => submitManual(text, state.draftResponseId)` → `(text) => actions.submitManual(text, state.draftResponseId)`
   - `() => publishExisting(state.draftResponseId)` → `() => actions.publishExisting(state.draftResponseId)`
   - `() => retryPosting(state.failedResponseId)` → `() => actions.retryPosting(state.failedResponseId)`
   - `() => restoreOriginal(state.failedResponseId)` → `() => actions.restoreOriginal(state.failedResponseId)`
   - `() => resumeExistingDraft(state.existing)` → `() => actions.resumeExistingDraft(state.existing)`
   - `() => discardExistingDraft(state.existing.responseId)` → `() => actions.discardExistingDraft(state.existing.responseId)`
   - The three inline `setState` calls become actions:
     - `() => setState({ kind: 'regenerating', outboxId: state.outboxId })` → `actions.resumePolling`
     - `onEditFurther={() => setState({ kind: 'editing', text: state.text, draftResponseId: state.draftResponseId })}` → `onEditFurther={actions.editFurther}`
     - `onClick={() => setState({ kind: 'initial' })}` → `onClick={actions.reset}`
   - The three repeated close-pending booleans (header `disabled`, `aria-label`, and the backdrop/X conditionals at lines ~710–713, ~716–719) — replace the `state.kind === 'creating_draft' || state.kind === 'regenerating' || state.kind === 'regenerate_poll_error'` expression with `isClosePending`. Leave the per-kind `title=` switch (lines ~722–730) untouched (it reads `state.kind`).

- [ ] **Step 5: Verify the hook tests pass, the integration backstop stays green, and types check**

Run: `pnpm exec vitest run src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx "src/app/(authenticated)/dashboard/past-replies"`
Expected: PASS — new hook suite (22 tests) + `PastRepliesClient` (22 tests) all green.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd "$HOME/.config/superpowers/worktrees/RepWorth/edit-reply-drawer-modularization"
git add src/components/dashboard/edit-reply/useEditReplyDraft.ts \
        src/components/dashboard/edit-reply/__tests__/useEditReplyDraft.test.tsx \
        src/components/dashboard/EditReplyDrawer.tsx
git commit -m "refactor(drawer): extract useEditReplyDraft state machine + tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `useFocusTrap`

**Files:**
- Create: `src/components/dashboard/edit-reply/useFocusTrap.ts`
- Modify: `src/components/dashboard/EditReplyDrawer.tsx`

Behavioral guard: the verbatim-move discipline + `pnpm typecheck` + the `PastRepliesClient` suite + a manual Esc/focus smoke. No new unit test (DOM focus is covered by the integration suite; per the spec, only `useEditReplyDraft` gets a dedicated suite).

- [ ] **Step 1: Create the focus-trap hook (verbatim move)**

Create `src/components/dashboard/edit-reply/useFocusTrap.ts`. Move the focus `useEffect` (lines 167–222) and the `tryCloseRef` sync `useEffect` (578–581) verbatim; the hook owns `panelRef`/`openerRef`/`tryCloseRef` internally and exposes `panelRef`:

```ts
'use client';

import { useEffect, useRef } from 'react';

export function useFocusTrap(open: boolean, onEscape: () => void) {
  const panelRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);

  // Keep the latest onEscape without re-attaching the keydown listener.
  // (Replaces the shell's tryCloseRef sync useEffect, lines 578–581.)
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  // Focus capture / move-in / Tab-trap / Esc / restore.
  // MOVE verbatim the body of lines 167–222, with two mechanical substitutions:
  //   - the `if (e.key === 'Escape') { tryCloseRef.current(); … }` call becomes
  //     `onEscapeRef.current();`
  //   - everything else (tabbableSelector, first/last wrap, restore on cleanup) is unchanged.
  useEffect(() => {
    if (!open) return;
    // … verbatim 170–221 with the Escape line using onEscapeRef.current() …
  }, [open]);

  return { panelRef };
}
```

- [ ] **Step 2: Rewire the shell**

Edit `EditReplyDrawer.tsx`:
1. Remove `panelRef`/`openerRef`/`tryCloseRef`, the focus `useEffect` (167–222), and the `tryCloseRef` sync `useEffect` (578–581).
2. Remove the now-unused `import { useEffect, useRef } from 'react'` line entirely (the shell no longer calls any React hook directly).
3. Add the hook and call it with `tryClose` as the Esc handler:
   ```ts
   import { useFocusTrap } from '@/components/dashboard/edit-reply/useFocusTrap';
   // …
   const { state, isClosePending, tryClose, actions } = useEditReplyDraft({ row, initialFailureRecovery, onClose });
   const { panelRef } = useFocusTrap(open, tryClose);
   ```
   `panelRef` stays attached to the `<aside ref={panelRef} …>`.

- [ ] **Step 3: Verify types + integration backstop**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm exec vitest run "src/app/(authenticated)/dashboard/past-replies"`
Expected: PASS (22 tests).

- [ ] **Step 4: Commit**

```bash
cd "$HOME/.config/superpowers/worktrees/RepWorth/edit-reply-drawer-modularization"
git add src/components/dashboard/edit-reply/useFocusTrap.ts src/components/dashboard/EditReplyDrawer.tsx
git commit -m "refactor(drawer): extract useFocusTrap from EditReplyDrawer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract the 5 panels

**Files:**
- Create: `edit-reply/ManualEditor.tsx`, `PreviewPanel.tsx`, `RecoveryPanel.tsx`, `DraftConflictPanel.tsx`, `ReviewChangedPanel.tsx`
- Modify: `src/components/dashboard/EditReplyDrawer.tsx`

Each panel is a self-contained presentational component already defined in the file. Move each **verbatim** (its `function …{}` body unchanged), add the imports it needs, and export it. `Spinner` (945–952) stays in the shell.

- [ ] **Step 1: Move `ManualEditor`**

Create `edit-reply/ManualEditor.tsx`: move `ManualEditor` (lines 954–1014) verbatim. It uses `MAX_REPLY_CHARS` and `AI_DRAFT_DISCLOSURE` and `useState`:
```ts
'use client';
import { useState } from 'react';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';

const MAX_REPLY_CHARS = 2000; // moved from EditReplyDrawer.tsx line 38

export function ManualEditor({ /* …verbatim props… */ }) { /* …verbatim body… */ }
```
In `EditReplyDrawer.tsx`: delete the `ManualEditor` function and `MAX_REPLY_CHARS` (line 38), and add `import { ManualEditor } from '@/components/dashboard/edit-reply/ManualEditor';`.

- [ ] **Step 2: Move `PreviewPanel`**

Create `edit-reply/PreviewPanel.tsx`: move `PreviewPanel` (1016–1065) verbatim. Imports:
```ts
'use client';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
export function PreviewPanel({ /* … */ }) { /* … */ }
```
In the shell: delete the function, add `import { PreviewPanel } from '@/components/dashboard/edit-reply/PreviewPanel';`.

- [ ] **Step 3: Move `RecoveryPanel`**

Create `edit-reply/RecoveryPanel.tsx`: move `RecoveryPanel` (1067–1103) verbatim. No extra imports beyond React/JSX (no hooks, no Link):
```ts
'use client';
export function RecoveryPanel({ /* … */ }) { /* … */ }
```
In the shell: delete the function, add `import { RecoveryPanel } from '@/components/dashboard/edit-reply/RecoveryPanel';`.

- [ ] **Step 4: Move `DraftConflictPanel`**

Create `edit-reply/DraftConflictPanel.tsx`: move `DraftConflictPanel` (1105–1232) verbatim. It uses `next/link`:
```ts
'use client';
import Link from 'next/link';
export function DraftConflictPanel({ /* … */ }) { /* … */ }
```
In the shell: delete the function, add `import { DraftConflictPanel } from '@/components/dashboard/edit-reply/DraftConflictPanel';`. After this, check whether `Link` is still used in the shell — if not, remove `import Link from 'next/link';` from `EditReplyDrawer.tsx`.

- [ ] **Step 5: Move `ReviewChangedPanel`**

Create `edit-reply/ReviewChangedPanel.tsx`: move `ReviewChangedPanel` (1234–1275) verbatim:
```ts
'use client';
export function ReviewChangedPanel({ /* … */ }) { /* … */ }
```
In the shell: delete the function, add `import { ReviewChangedPanel } from '@/components/dashboard/edit-reply/ReviewChangedPanel';`.

- [ ] **Step 6: Verify types + integration backstop**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm exec vitest run "src/app/(authenticated)/dashboard/past-replies"`
Expected: PASS (22 tests).

- [ ] **Step 7: Commit**

```bash
cd "$HOME/.config/superpowers/worktrees/RepWorth/edit-reply-drawer-modularization"
git add src/components/dashboard/edit-reply/ManualEditor.tsx \
        src/components/dashboard/edit-reply/PreviewPanel.tsx \
        src/components/dashboard/edit-reply/RecoveryPanel.tsx \
        src/components/dashboard/edit-reply/DraftConflictPanel.tsx \
        src/components/dashboard/edit-reply/ReviewChangedPanel.tsx \
        src/components/dashboard/EditReplyDrawer.tsx
git commit -m "refactor(drawer): extract 5 panels into edit-reply/

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Relocate the doc comment + full verification gate

**Files:**
- Modify: `src/components/dashboard/EditReplyDrawer.tsx`
- Modify: `src/components/dashboard/edit-reply/useEditReplyDraft.ts`

- [ ] **Step 1: Move the state-machine + API-contract doc to the hook**

The big header comment in `EditReplyDrawer.tsx` (lines 1–28) documents the 6/11-state flow and the API contract — knowledge that now lives in the hook. Move that block to the top of `useEditReplyDraft.ts` (above the imports). Replace the shell's header comment with a short orientation note:
```ts
// src/components/dashboard/EditReplyDrawer.tsx
//
// Right-side slide-out drawer for the edit-existing-reply flow. This is the
// composing shell: it wires useEditReplyDraft (state machine + API calls) and
// useFocusTrap (focus/Esc), then renders the review snapshot, the current
// Google reply, and the per-state panel for state.kind. Behavior + API
// contract live in ./edit-reply/useEditReplyDraft.ts.
```

- [ ] **Step 2: Full verification gate**

Run: `pnpm lint`
Expected: no errors (no new warnings introduced by the moved files).

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test`
Expected: full suite green (the new hook suite included; `PastRepliesClient` included).

- [ ] **Step 3: Manual smoke (focus + Esc, since useFocusTrap has no unit test)**

In a browser via `pnpm dev` (or reason through the rendered DOM): open the drawer, confirm focus moves into the panel, Tab wraps within it, Esc closes from a closable state and is refused during `creating_draft`/`regenerating`, and focus returns to the opener on close. Record the result in the PR description.

- [ ] **Step 4: Commit**

```bash
cd "$HOME/.config/superpowers/worktrees/RepWorth/edit-reply-drawer-modularization"
git add src/components/dashboard/EditReplyDrawer.tsx src/components/dashboard/edit-reply/useEditReplyDraft.ts
git commit -m "refactor(drawer): relocate state-machine doc to the hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author check against the spec)

- **Spec coverage:** feature folder + stable entry path (Tasks 1–4, all under `edit-reply/`, shell keeps its path) ✓; `useEditReplyDraft` with the exact return interface (Task 1) ✓; `useFocusTrap(open, onEscape) → { panelRef }` (Task 2) ✓; 5 panels extracted, `Spinner` stays inline (Task 3) ✓; hook-tests-first (Task 1 Steps 1–2 red, 3–5 green) ✓; verbatim move convention (every move step) ✓; behavior-preservation contract guarded by the new suite + `PastRepliesClient` + typecheck/lint ✓; verification gates `lint && typecheck && test` (Task 4) ✓; non-goals respected (no API/route/`PastReplyRow`/UI changes; latent single-snapshot-per-mount preserved by verbatim `useRef`/`useState` initializer move) ✓.
- **Type consistency:** the hook return shape (`state`, `isClosePending`, `tryClose`, `actions.{…}`) is identical in the test (Task 1 Step 1), the hook (Step 3), and the shell rewire (Step 4). Action names match the source callbacks plus `resumePolling`/`editFurther`/`reset`. `DrawerState` exported once from the hook.
- **Placeholders:** the `/* MOVE verbatim: lines X–Y */` markers are deliberate move instructions (anti-drift convention), not unfilled stubs — the source content is the existing, working file. All net-new code (tests, transitions, `isClosePending`, hook wrappers, doc comment) is written in full.
