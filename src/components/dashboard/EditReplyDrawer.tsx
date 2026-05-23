// src/components/dashboard/EditReplyDrawer.tsx
//
// Right-side slide-out drawer that drives the 6-state edit-existing-reply
// flow from spec §5.2:
//
//   1. initial      — review snapshot + read-only Google reply + two CTAs
//   2. editing      — manual textarea + char count + Update / Cancel
//   3. regenerating — polling /draft-status every 1500ms (60s ceiling)
//   4. preview      — AI draft visible + Update on Google / Edit further
//   5. publishing   — submitted /publish; close on success
//   6. recovery     — for failed rows; Retry posting / Restore original
//
// The drawer captures `{ hash: row.review_content_hash, version }` at open
// time and sends it on every mutating call. Any 409 surfaces a "review was
// updated by the customer" prompt with a Refresh button.
//
// API contract (server returns these shapes — see the route comments in
// src/app/api/dashboard/past-replies/*):
//   POST   /api/dashboard/past-replies/draft       → { response_id } | { outbox_id }
//   PATCH  /api/dashboard/past-replies/draft/:id   → 204
//   DELETE /api/dashboard/past-replies/draft/:id   → 204
//   POST   /api/dashboard/past-replies/publish     → { outbox_id }
//   GET    /api/dashboard/past-replies/draft-status?outbox_id=...
//          → { status: 'generating' } | { status: 'failed', error } |
//            { response_id, status, response_text }
//   POST   /api/dashboard/past-replies/:id/retry              → { outbox_id }
//   POST   /api/dashboard/past-replies/:id/restore-original   → { response_id }

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/PastReplyCard';

const MAX_REPLY_CHARS = 2000;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

interface EditReplyDrawerProps {
  open: boolean;
  onClose: () => void;
  row: PastReplyRow;
  canEdit: boolean;
  // When set, the drawer opens directly into the recovery state for the
  // given failed response id (Retry / Restore CTAs visible immediately).
  // Used by PastReplyCard when the row carries a recoverable failed
  // sibling. See Code Review fix Critical 1 (2026-05-02).
  //
  // failedPostingError discriminates which CTAs are appropriate:
  //   - 'delete_failed_*' (sibling still alive)   → Retry only.
  //   - 'post_after_delete_failed_*' (orphan)     → Retry + Restore.
  // /restore-original returns 409 'not_in_orphan_state' for delete_failed_*,
  // so showing the button on that branch would always 409. Hiding it is
  // the right UX. See Code Review fix Round-2 M2.
  initialFailureRecovery?: {
    failedResponseId: string;
    failedPostingError: string | null;
  } | null;
}

interface Snapshot {
  hash: string;
  version: number;
}

type DrawerState =
  // 'creating_draft' is the in-flight POST /draft (regenerate) state — set
  // BEFORE the outbox_id is known so the polling effect cannot fire with an
  // empty outboxId. Renders the same loading UI as 'regenerating'.
  // See Code Review fix Medium 2 (2026-05-02).
  | { kind: 'initial' }
  | { kind: 'editing'; text: string; draftResponseId: string | null }
  | { kind: 'creating_draft' }
  | { kind: 'regenerating'; outboxId: string }
  // 'regenerate_poll_error' carries outboxId so the worker is still
  // outstanding (timeout / network error / non-OK status check). The drawer
  // refuses close in this state — the worker may yet succeed and create a
  // pending_approval row that would otherwise be invisible. The owner can
  // either Resume polling (back to 'regenerating') or wait for terminal
  // worker failure to drop us to closable 'error'. See Round-4 M.
  | { kind: 'regenerate_poll_error'; outboxId: string; message: string }
  | { kind: 'preview'; draftResponseId: string; text: string }
  | { kind: 'publishing' }
  // failedPostingError carried so RecoveryPanel can show/hide Restore based
  // on the failure mode (Round-2 M2).
  | { kind: 'recovery'; failedResponseId: string; failedPostingError: string | null }
  | { kind: 'review_changed'; currentText: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'success'; message: string };

interface ApiErrorPayload {
  error?: string;
  current_review_text?: string | null;
  current_review_hash?: string | null;
}

async function readJsonSafe(res: Response): Promise<ApiErrorPayload | null> {
  try {
    return (await res.json()) as ApiErrorPayload;
  } catch {
    return null;
  }
}

export function EditReplyDrawer({
  open,
  onClose,
  row,
  canEdit,
  initialFailureRecovery = null,
}: EditReplyDrawerProps) {
  const router = useRouter();

  // Snapshot is captured once at open time and never re-derived. The server
  // uses (hash, version) to detect concurrent customer edits between /draft
  // and /publish. version is null in the orphan-only state (no posted row);
  // the recovery routes don't run validateOptimisticConcurrency so the
  // snapshot is unused there.
  const snapshotRef = useRef<Snapshot>({
    hash: row.review_content_hash ?? '',
    version: row.version ?? 0,
  });

  // If the card opened the drawer in recovery mode (failed_response_id set),
  // start in 'recovery' instead of 'initial'. Carry the posting_error prefix
  // so RecoveryPanel can hide Restore when only Retry is appropriate.
  const [state, setState] = useState<DrawerState>(
    initialFailureRecovery
      ? {
          kind: 'recovery',
          failedResponseId: initialFailureRecovery.failedResponseId,
          failedPostingError: initialFailureRecovery.failedPostingError,
        }
      : { kind: 'initial' },
  );
  const currentReplyText = row.approved_text ?? '';

  // Esc to close. Only handled when the drawer is mounted. Uses a ref to the
  // current tryClose so the keydown binding doesn't re-attach on every state
  // transition; tryClose itself is defined below and references state.
  const tryCloseRef = useRef<() => void>(onClose);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') tryCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Polling effect for the regenerating state.
  //
  // Three transient failure paths preserve outboxId in 'regenerate_poll_error'
  // so close stays blocked while the worker is still outstanding (Round-4 M):
  //   - 60s polling-budget timeout (worker may finish later).
  //   - non-OK /draft-status response (transient network / proxy / 5xx).
  //   - thrown network error during fetch.
  // Resume-polling re-enters 'regenerating' with the same outboxId and the
  // 60s window restarts.
  //
  // Two terminal paths drop to plain closable 'error':
  //   - body.status === 'failed' (worker reported terminal failure;
  //     ResponseGeneratorWorker markOutboxFailed without inserting a row,
  //     so no pending_approval will materialize — safe to close).
  //   - Unknown response shape (treated as worker-finished-with-junk;
  //     also closable. If we routed unknown shape to poll-error, an
  //     ambiguous server response would trap the owner forever).
  useEffect(() => {
    if (state.kind !== 'regenerating') return;
    const outboxId = state.outboxId;
    const startedAt = Date.now();
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: 'Generation is taking longer than expected. The draft may still arrive.',
        });
        return;
      }
      try {
        const res = await fetch(
          `/api/dashboard/past-replies/draft-status?outbox_id=${encodeURIComponent(outboxId)}`,
          { credentials: 'same-origin' },
        );
        const body = (await res.json().catch(() => null)) as
          | { status?: string; error?: string; response_id?: string; response_text?: string | null }
          | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          setState({
            kind: 'regenerate_poll_error',
            outboxId,
            message: body?.error ?? `Status check failed (${res.status}). The worker may still finish.`,
          });
          return;
        }
        if (body.status === 'generating') {
          setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        if (body.status === 'failed') {
          // Terminal worker failure — ResponseGeneratorWorker did NOT insert
          // a response row (markOutboxFailed before persistResponseAndNotify).
          // Safe to close; no orphan can materialize.
          setState({
            kind: 'error',
            message: body.error ?? 'Generation failed. Try again.',
          });
          return;
        }
        if (body.response_id) {
          setState({
            kind: 'preview',
            draftResponseId: body.response_id,
            text: body.response_text ?? '',
          });
          return;
        }
        // Unknown shape — surface generically. Closable on the assumption
        // that an ambiguous server response shouldn't trap the owner.
        setState({ kind: 'error', message: 'Unexpected response from server.' });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: err instanceof Error ? err.message : 'Network error while polling.',
        });
      }
    };

    setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
    };
  }, [state]);

  const handleHttpError = useCallback(
    async (res: Response, fallback: string): Promise<void> => {
      const body = await readJsonSafe(res);
      if (res.status === 409 && body?.error === 'review_changed') {
        setState({
          kind: 'review_changed',
          currentText: body.current_review_text ?? null,
        });
        return;
      }
      setState({ kind: 'error', message: body?.error ?? fallback });
    },
    [],
  );

  // ──────────────────────────────────────────────────────────────────
  // Actions
  // ──────────────────────────────────────────────────────────────────

  const startManualEdit = useCallback(() => {
    setState({ kind: 'editing', text: currentReplyText, draftResponseId: null });
  }, [currentReplyText]);

  const startRegenerate = useCallback(async () => {
    // Enter 'creating_draft' (NOT 'regenerating') so the polling effect does
    // not fire with an empty outboxId. Only transition to 'regenerating'
    // AFTER the POST returns the real outbox_id.
    setState({ kind: 'creating_draft' });
    try {
      const res = await fetch('/api/dashboard/past-replies/draft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'regenerate',
          review_id: row.review_id,
          snapshot: snapshotRef.current,
        }),
      });
      if (!res.ok) {
        await handleHttpError(res, `Regenerate failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { outbox_id?: string };
      if (!body.outbox_id) {
        setState({ kind: 'error', message: 'Server did not return an outbox id.' });
        return;
      }
      setState({ kind: 'regenerating', outboxId: body.outbox_id });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Regenerate failed.',
      });
    }
  }, [row.review_id, handleHttpError]);

  const submitManual = useCallback(
    async (text: string, existingDraftId: string | null) => {
      if (!text.trim()) {
        setState({ kind: 'error', message: 'Reply text cannot be empty.' });
        return;
      }
      setState({ kind: 'publishing' });
      try {
        let responseId = existingDraftId;
        if (!responseId) {
          // Create a new manual draft.
          const res = await fetch('/api/dashboard/past-replies/draft', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'manual',
              review_id: row.review_id,
              new_text: text,
              snapshot: snapshotRef.current,
            }),
          });
          if (!res.ok) {
            await handleHttpError(res, `Draft failed (${res.status})`);
            return;
          }
          const body = (await res.json()) as { response_id?: string };
          if (!body.response_id) {
            setState({ kind: 'error', message: 'Server did not return a response id.' });
            return;
          }
          responseId = body.response_id;
        } else {
          // PATCH the existing draft (e.g. user came back via "Edit further").
          const res = await fetch(
            `/api/dashboard/past-replies/draft/${encodeURIComponent(responseId)}`,
            {
              method: 'PATCH',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                new_text: text,
                snapshot: snapshotRef.current,
              }),
            },
          );
          if (!res.ok) {
            await handleHttpError(res, `Patch failed (${res.status})`);
            return;
          }
        }

        // Publish.
        const pubRes = await fetch('/api/dashboard/past-replies/publish', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_id: responseId,
            snapshot: snapshotRef.current,
          }),
        });
        if (!pubRes.ok) {
          await handleHttpError(pubRes, `Publish failed (${pubRes.status})`);
          return;
        }
        setState({
          kind: 'success',
          message: 'Update queued for Google. The new reply will appear shortly.',
        });
        // Refresh the underlying server data so the card reflects the new
        // posted reply once the publisher finishes.
        router.refresh();
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Publish failed.',
        });
      }
    },
    [row.review_id, handleHttpError, router],
  );

  const cancelDraft = useCallback(
    async (draftResponseId: string | null) => {
      // If we have a server-side draft, DELETE it (idempotent — safe even if
      // the row is already gone). If not, just close.
      if (draftResponseId) {
        try {
          await fetch(
            `/api/dashboard/past-replies/draft/${encodeURIComponent(draftResponseId)}`,
            { method: 'DELETE', credentials: 'same-origin' },
          );
        } catch {
          // Best-effort; cancel always closes the drawer.
        }
      }
      onClose();
    },
    [onClose],
  );

  // Wraps onClose with a "discard the in-flight draft if one exists" step.
  // Used by the close paths (Esc / backdrop / X) to prevent leaving a hidden
  // pending_approval row that would block future drafts with
  // 409 'draft_already_exists'. See Code Review fix Medium 2 (2026-05-02).
  //
  // Two regenerate-window phases both need close-refusal:
  //
  //   1. 'creating_draft' (Round-2 M3): in-flight POST /draft. No draft id
  //      yet; if drawer unmounts, POST still resolves server-side and an
  //      orphan outbox row is created. Window is sub-second (POST just
  //      enqueues, no LLM).
  //
  //   2. 'regenerating' (Round-3 M): outbox enqueued + worker generating
  //      via LLM. Same orphan-class problem: if drawer unmounts during
  //      this window, the worker eventually creates a pending_approval
  //      response row that's invisible to the owner — next drawer-open
  //      hits 409 'draft_already_exists'. The window is large (5-30s for
  //      LLM generation). cancelDraft can't help here either because the
  //      response row doesn't exist yet.
  //
  // Both refuse close in tryClose AND visually disable the X button via the
  // header below. Backdrop / Esc no-op silently. Once state transitions to
  // 'preview' (worker finished, response row exists), cancelDraft works.
  // See Code Review fix Round-3 M (2026-05-02).
  const tryClose = useCallback(() => {
    // 'creating_draft' / 'regenerating' / 'regenerate_poll_error' all keep
    // the worker outstanding. Refusing close prevents an invisible
    // pending_approval row from materializing after unmount and blocking
    // the next edit with 409 'draft_already_exists'. See Round-3 M (the
    // first two) and Round-4 M (the poll-error case — outboxId still
    // present, worker may yet succeed).
    if (
      state.kind === 'creating_draft' ||
      state.kind === 'regenerating' ||
      state.kind === 'regenerate_poll_error'
    ) {
      return;
    }
    if (state.kind === 'editing' && state.draftResponseId) {
      void cancelDraft(state.draftResponseId);
      return;
    }
    if (state.kind === 'preview') {
      void cancelDraft(state.draftResponseId);
      return;
    }
    onClose();
  }, [state, cancelDraft, onClose]);

  // Keep the Esc-handler ref in sync with the latest tryClose.
  useEffect(() => {
    tryCloseRef.current = tryClose;
  }, [tryClose]);

  const retryPosting = useCallback(async (failedResponseId: string) => {
    setState({ kind: 'publishing' });
    try {
      const res = await fetch(
        `/api/dashboard/past-replies/${encodeURIComponent(failedResponseId)}/retry`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!res.ok) {
        await handleHttpError(res, `Retry failed (${res.status})`);
        return;
      }
      setState({
        kind: 'success',
        message: 'Retry queued. The reply will reappear once posted.',
      });
      router.refresh();
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Retry failed.',
      });
    }
  }, [handleHttpError, router]);

  const restoreOriginal = useCallback(async (failedResponseId: string) => {
    setState({ kind: 'publishing' });
    try {
      const res = await fetch(
        `/api/dashboard/past-replies/${encodeURIComponent(failedResponseId)}/restore-original`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!res.ok) {
        await handleHttpError(res, `Restore failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { response_id?: string; response_text?: string | null };
      if (!body.response_id) {
        setState({ kind: 'error', message: 'Restore returned no draft id.' });
        return;
      }
      // Restore created a NEW pending_approval row pre-filled with the
      // original text — show it in preview so the owner can publish it.
      // Use the route's returned response_text rather than currentReplyText:
      // for failed-only orphan rows row.approved_text is null (no posted
      // sibling), so currentReplyText would be empty and the publish click
      // would hit the empty-text guard. See Code Review fix Round-2 M1.
      setState({
        kind: 'preview',
        draftResponseId: body.response_id,
        text: body.response_text ?? currentReplyText,
      });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Restore failed.',
      });
    }
  }, [handleHttpError, currentReplyText]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-reply-drawer-title"
    >
      {/* Backdrop — uses tryClose to discard an in-flight draft before
          closing. See Code Review fix Medium 2 (2026-05-02). */}
      <button
        type="button"
        aria-label="Close drawer"
        className="flex-1 bg-black/30"
        onClick={tryClose}
      />

      {/* Panel */}
      <aside className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
          <h2
            id="edit-reply-drawer-title"
            className="text-lg font-semibold text-[#2a2a2a]"
          >
            Edit reply
          </h2>
          <button
            type="button"
            onClick={tryClose}
            disabled={
              state.kind === 'creating_draft' ||
              state.kind === 'regenerating' ||
              state.kind === 'regenerate_poll_error'
            }
            className="rounded-md px-2 py-1 text-sm text-[#6a6a6a] hover:bg-gray-50 hover:text-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            aria-label={
              state.kind === 'creating_draft' ||
              state.kind === 'regenerating' ||
              state.kind === 'regenerate_poll_error'
                ? 'Close (disabled while draft is being created)'
                : 'Close'
            }
            title={
              state.kind === 'creating_draft'
                ? 'Wait — finishing your draft request…'
                : state.kind === 'regenerating'
                  ? 'Wait — generating your draft. This usually takes 5–15 seconds.'
                  : state.kind === 'regenerate_poll_error'
                    ? 'The worker is still running. Resume polling or wait — close is disabled while a draft may still arrive.'
                    : undefined
            }
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-5 px-6 py-5">
          {/* Review snapshot — always shown */}
          <section className="rounded-lg border border-gray-100 bg-[#F0EEEA]/40 p-3">
            <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
              Customer review
            </div>
            <div className="flex items-center gap-2">
              {row.star_rating != null && (
                <span className="text-sm text-yellow-500" aria-label={`${row.star_rating} stars`}>
                  {'★'.repeat(Math.round(row.star_rating))}
                  {'☆'.repeat(Math.max(0, 5 - Math.round(row.star_rating)))}
                </span>
              )}
              <span className="text-sm font-medium text-[#2a2a2a]">
                {row.reviewer_name ?? 'Anonymous'}
              </span>
            </div>
            <p className="mt-1 text-sm text-[#2a2a2a]">
              {row.review_text ?? <em className="text-[#6a6a6a]">No review text — rating only.</em>}
            </p>
          </section>

          {/* Current Google reply — always shown */}
          <section>
            <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
              Current Google reply
            </div>
            <p className="rounded-md bg-[#F0EEEA]/60 p-3 text-sm text-[#2a2a2a]">
              {currentReplyText || <em className="text-[#6a6a6a]">(empty)</em>}
            </p>
          </section>

          {/* State-specific UI */}
          {state.kind === 'initial' && canEdit && (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={startManualEdit}
                className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
              >
                Edit manually
              </button>
              <button
                type="button"
                onClick={startRegenerate}
                className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
              >
                Regenerate with AI
              </button>
            </div>
          )}

          {state.kind === 'editing' && (
            <ManualEditor
              initialText={state.text}
              onCancel={() => cancelDraft(state.draftResponseId)}
              onSubmit={(text) => submitManual(text, state.draftResponseId)}
            />
          )}

          {(state.kind === 'creating_draft' || state.kind === 'regenerating') && (
            <div className="rounded-lg border border-gray-100 bg-[#F0EEEA]/30 p-4 text-sm text-[#6a6a6a]">
              <div className="flex items-center gap-3">
                <Spinner />
                <span>Generating a fresh draft using your current brand voice…</span>
              </div>
            </div>
          )}

          {state.kind === 'regenerate_poll_error' && (
            // Polling failed transiently. Outbox + worker are still running;
            // close is blocked (Round-4 M). Resume polling re-enters
            // 'regenerating' with the same outboxId so the polling effect
            // reattaches and the 60s window restarts.
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-900">{state.message}</p>
              <p className="text-xs text-amber-800">
                Close is paused until the draft arrives or the worker reports failure — otherwise the
                draft would be created in the background and block your next attempt.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setState({ kind: 'regenerating', outboxId: state.outboxId })
                  }
                  className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
                >
                  Resume polling
                </button>
              </div>
            </div>
          )}

          {state.kind === 'preview' && (
            <PreviewPanel
              text={state.text}
              onPublish={() => submitManual(state.text, state.draftResponseId)}
              onEditFurther={() =>
                setState({
                  kind: 'editing',
                  text: state.text,
                  draftResponseId: state.draftResponseId,
                })
              }
              onCancel={() => cancelDraft(state.draftResponseId)}
            />
          )}

          {state.kind === 'publishing' && (
            <div className="rounded-lg border border-gray-100 bg-[#F0EEEA]/30 p-4 text-sm text-[#6a6a6a]">
              <div className="flex items-center gap-3">
                <Spinner />
                <span>Posting to Google…</span>
              </div>
            </div>
          )}

          {state.kind === 'recovery' && (
            <RecoveryPanel
              onRetry={() => retryPosting(state.failedResponseId)}
              onRestore={() => restoreOriginal(state.failedResponseId)}
              // Restore is only valid for orphan-state failures
              // (post_after_delete_failed_*). For delete_failed_* the live
              // posted reply is still on Google — there's nothing to
              // restore. /restore-original would 409 not_in_orphan_state;
              // hide the button instead. See Round-2 M2.
              restoreAvailable={
                state.failedPostingError !== null &&
                state.failedPostingError.startsWith('post_after_delete_failed_')
              }
            />
          )}

          {state.kind === 'review_changed' && (
            <ReviewChangedPanel
              currentText={state.currentText}
              onRefresh={() => router.refresh()}
              onClose={onClose}
            />
          )}

          {state.kind === 'error' && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm text-red-800">{state.message}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setState({ kind: 'initial' })}
                  className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-3 py-1 text-xs font-medium text-[#6a6a6a] hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {state.kind === 'success' && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm text-green-800">{state.message}</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#97B3AE]/30 border-t-[#97B3AE]"
    />
  );
}

function ManualEditor({
  initialText,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const remaining = MAX_REPLY_CHARS - text.length;
  const overLimit = remaining < 0;

  return (
    <div className="space-y-2">
      <label
        htmlFor="reply-textarea"
        className="text-xs uppercase tracking-wider text-[#97B3AE]"
      >
        New reply
      </label>
      <textarea
        id="reply-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_REPLY_CHARS}
        rows={8}
        className="w-full rounded-md border border-gray-300 p-3 text-sm text-[#2a2a2a] focus:border-[#97B3AE] focus:outline-none focus:ring-1 focus:ring-[#97B3AE]"
      />
      <div className="flex items-center justify-between">
        <span
          className={`text-xs ${
            overLimit ? 'text-red-600' : 'text-[#6a6a6a]'
          }`}
        >
          {text.length} / {MAX_REPLY_CHARS}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(text)}
            disabled={!text.trim() || overLimit}
            className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update on Google
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewPanel({
  text,
  onPublish,
  onEditFurther,
  onCancel,
}: {
  text: string;
  onPublish: () => void;
  onEditFurther: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
          Proposed reply
        </div>
        <p className="rounded-md border border-gray-200 bg-white p-3 text-sm text-[#2a2a2a]">
          {text}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onEditFurther}
          className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
        >
          Edit further
        </button>
        <button
          type="button"
          onClick={onPublish}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Update on Google
        </button>
      </div>
    </div>
  );
}

function RecoveryPanel({
  onRetry,
  onRestore,
  restoreAvailable,
}: {
  onRetry: () => void;
  onRestore: () => void;
  restoreAvailable: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        {restoreAvailable
          ? 'The previous edit didn’t complete and your old reply is no longer on Google. Retry the edit, or restore the original reply.'
          : 'The previous edit didn’t complete. The original reply is still live on Google. Retry to re-attempt the edit.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Retry posting
        </button>
        {restoreAvailable && (
          <button
            type="button"
            onClick={onRestore}
            className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
          >
            Restore original
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewChangedPanel({
  currentText,
  onRefresh,
  onClose,
}: {
  currentText: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        The customer updated this review. Refresh to see the latest version
        before editing again.
      </p>
      {currentText && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">
            Updated review text
          </div>
          <p className="rounded-md bg-white p-3 text-sm text-[#2a2a2a]">{currentText}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Close
        </button>
      </div>
    </div>
  );
}
