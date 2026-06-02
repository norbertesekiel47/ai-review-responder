// useEditReplyDraft — the edit-existing-reply state machine behind EditReplyDrawer.
//
// Drives the flow from spec §5.2. The six user-facing states:
//   1. initial      — review snapshot + read-only Google reply + two CTAs
//   2. editing      — manual textarea + char count + Update / Cancel
//   3. regenerating — polling /draft-status every 1500ms (60s ceiling)
//   4. preview      — AI draft visible + Update on Google / Edit further
//   5. publishing   — submitted /publish; close on success
//   6. recovery     — for failed rows; Retry posting / Restore original
//
// Plus the transient/branch states the machine needs (see the DrawerState union
// below): creating_draft (in-flight POST /draft before the outbox_id is known),
// regenerate_poll_error (polling stalled but the worker is still outstanding —
// close stays blocked), review_changed (409 from a concurrent customer edit),
// draft_conflict (a prior draft already exists), error, and success.
//
// The snapshot `{ hash: row.review_content_hash, version }` is captured once at
// mount and sent on every mutating call; any 409 surfaces the matching prompt.
//
// API contract (server response shapes — see the route comments in
// src/app/api/dashboard/past-replies/*):
//   POST   /api/dashboard/past-replies/draft       → { response_id } | { outbox_id }
//   PATCH  /api/dashboard/past-replies/draft/:id   → 204
//   DELETE /api/dashboard/past-replies/draft/:id   → 204
//   POST   /api/dashboard/past-replies/publish     → { outbox_id }
//   GET    /api/dashboard/past-replies/draft-status?outbox_id=...
//          → { status: 'generating' } | { status: 'failed', error } |
//            { response_id, status, response_text }
//   POST   /api/dashboard/past-replies/:id/retry              → { outbox_id }
//   POST   /api/dashboard/past-replies/:id/restore-original   → { response_id, outbox_id }
//          (terminal: republishes the original directly; drawer shows success)

'use client';

import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/PastReplyCard';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

// The poll's queryFn returns one of these markers per tick. The state machine
// transition is applied via setState inside the queryFn (the poll's "tick"
// hook); this marker is what `refetchInterval` inspects to decide whether to
// keep ticking. 'pending' = worker still generating, keep polling. Every other
// value is terminal for this poll cycle: setState has already moved the drawer
// out of 'regenerating', so refetchInterval returns false.
type PollOutcome = 'pending' | 'done';

interface Snapshot {
  hash: string;
  version: number;
}

export type DrawerState =
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
  // A prior draft (reload / crash / failed-publish) already exists for this
  // review. Rather than dead-ending on 409 'draft_already_exists', offer to
  // Resume it (publish/edit the existing draft) or Discard it and start over.
  // `status` discriminates which actions are available:
  //   - 'pending_approval' → Resume + Discard are valid.
  //   - 'approved' | 'edited' → publish already queued; inform only.
  //   - 'awaiting_owner_connect' → parked until Google reconnect; inform + link.
  | { kind: 'draft_conflict'; existing: { responseId: string; text: string; isEdited: boolean; status: string } }
  | { kind: 'error'; message: string }
  | { kind: 'success'; message: string };

interface ApiErrorPayload {
  error?: string;
  current_review_text?: string | null;
  current_review_hash?: string | null;
  existing?: {
    response_id: string;
    text: string | null;
    is_edited: boolean;
    status: string;
  };
}

async function readJsonSafe(res: Response): Promise<ApiErrorPayload | null> {
  try {
    return (await res.json()) as ApiErrorPayload;
  } catch {
    return null;
  }
}

export interface UseEditReplyDraftParams {
  row: PastReplyRow;
  initialFailureRecovery: { failedResponseId: string; failedPostingError: string | null } | null;
  onClose: () => void;
}

export function useEditReplyDraft({ row, initialFailureRecovery, onClose }: UseEditReplyDraftParams) {
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

  // Polling for the regenerating state, driven by useQuery's refetchInterval
  // instead of a hand-rolled setTimeout chain (kills react-doctor
  // no-fetch-in-effect — the fetch lives in queryFn, not a useEffect).
  //
  // The poll is `enabled` only while the drawer is in 'regenerating'. Each tick
  // (queryFn) checks the 60s budget, fetches /draft-status, and applies the
  // matching state-machine transition via setState — queryFn is the natural
  // per-tick hook, so the transitions live there and the returned PollOutcome
  // tells refetchInterval whether to keep ticking. Unmount stops the query, so
  // no setState fires after teardown.
  //
  // Three transient failure paths preserve outboxId in 'regenerate_poll_error'
  // so close stays blocked while the worker is still outstanding (Round-4 M):
  //   - 60s polling-budget timeout (worker may finish later).
  //   - non-OK /draft-status response (transient network / proxy / 5xx).
  //   - thrown network error during fetch.
  // Resume-polling re-enters 'regenerating' with the same outboxId and the
  // 60s window restarts (the budget ref is re-stamped on each fresh cycle).
  //
  // Two terminal paths drop to plain closable 'error':
  //   - body.status === 'failed' (worker reported terminal failure;
  //     ResponseGeneratorWorker markOutboxFailed without inserting a row,
  //     so no pending_approval will materialize — safe to close).
  //   - Unknown response shape (treated as worker-finished-with-junk;
  //     also closable. If we routed unknown shape to poll-error, an
  //     ambiguous server response would trap the owner forever).
  const isRegenerating = state.kind === 'regenerating';
  const pollOutboxId = isRegenerating ? state.outboxId : null;

  // Per-cycle 60s budget. Stamped at the start of each regenerating cycle and
  // re-stamped whenever a new cycle begins (fresh outboxId, or Resume polling
  // re-enters 'regenerating' with the same id). Mirrors the old effect's
  // `startedAt = Date.now()` captured on each effect (re)run.
  const pollBudgetRef = useRef<{ outboxId: string; startedAt: number } | null>(null);
  if (isRegenerating && pollBudgetRef.current?.outboxId !== pollOutboxId) {
    pollBudgetRef.current = { outboxId: state.outboxId, startedAt: Date.now() };
  } else if (!isRegenerating && pollBudgetRef.current !== null) {
    pollBudgetRef.current = null;
  }

  useQuery<PollOutcome>({
    queryKey: ['edit-reply-draft-status', pollOutboxId],
    enabled: isRegenerating,
    gcTime: 0,
    // Seed 'pending' + freeze staleness so the query does NOT fetch on mount;
    // the first real poll fires via refetchInterval at +1500ms, matching the
    // old setTimeout(tick, 1500) cadence (no immediate t=0 poll). refetchInterval
    // fires regardless of staleTime, so the cadence is unaffected by the freeze.
    initialData: 'pending',
    staleTime: Infinity,
    // We never read the query's data for render — the state machine owns it.
    // refetchOnWindowFocus off so a tab refocus can't fire an off-cadence poll.
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data === 'pending' ? POLL_INTERVAL_MS : false),
    queryFn: async () => {
      const outboxId = pollOutboxId;
      // enabled gates this, so outboxId is non-null here; guard for type safety.
      if (outboxId === null) return 'done';
      const startedAt = pollBudgetRef.current?.startedAt ?? Date.now();
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: 'Generation is taking longer than expected. The draft may still arrive.',
        });
        return 'done';
      }
      try {
        const res = await fetch(
          `/api/dashboard/past-replies/draft-status?outbox_id=${encodeURIComponent(outboxId)}`,
          { credentials: 'same-origin' },
        );
        const body = (await res.json().catch(() => null)) as
          | { status?: string; error?: string; response_id?: string; response_text?: string | null }
          | null;
        if (!res.ok || !body) {
          setState({
            kind: 'regenerate_poll_error',
            outboxId,
            message: body?.error ?? `Status check failed (${res.status}). The worker may still finish.`,
          });
          return 'done';
        }
        if (body.status === 'generating') {
          // Still working — keep polling on the refetchInterval cadence.
          return 'pending';
        }
        if (body.status === 'failed') {
          // Terminal worker failure — ResponseGeneratorWorker did NOT insert
          // a response row (markOutboxFailed before persistResponseAndNotify).
          // Safe to close; no orphan can materialize.
          setState({
            kind: 'error',
            message: body.error ?? 'Generation failed. Try again.',
          });
          return 'done';
        }
        if (body.response_id) {
          setState({
            kind: 'preview',
            draftResponseId: body.response_id,
            text: body.response_text ?? '',
          });
          return 'done';
        }
        // Unknown shape — surface generically. Closable on the assumption
        // that an ambiguous server response shouldn't trap the owner.
        setState({ kind: 'error', message: 'Unexpected response from server.' });
        return 'done';
      } catch (err) {
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: err instanceof Error ? err.message : 'Network error while polling.',
        });
        return 'done';
      }
    },
  });

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
      // A prior in-progress draft exists. The available actions depend on its
      // status — only pending_approval supports Resume/Discard; the other
      // non-terminal statuses (approved, edited, awaiting_owner_connect) are
      // informational-only states where no further client action is needed.
      if (res.status === 409 && body?.error === 'draft_already_exists' && body.existing) {
        setState({
          kind: 'draft_conflict',
          existing: {
            responseId: body.existing.response_id,
            text: body.existing.text ?? '',
            isEdited: body.existing.is_edited,
            status: body.existing.status,
          },
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

  // Publish an EXISTING draft as-is, WITHOUT a PATCH. Used by the
  // regenerate-preview "accept as-is" path: the worker-inserted draft has
  // llm_provider set and edited_text NULL, so /publish records it as
  // 'regenerate_as_is'. PATCHing first (as submitManual does) would force
  // edited_text and mis-record it as 'regenerate_edited'. The posted row
  // still exists at this point, so /publish's validateOptimisticConcurrency
  // passes.
  const publishExisting = useCallback(
    async (draftResponseId: string) => {
      setState({ kind: 'publishing' });
      try {
        const pubRes = await fetch('/api/dashboard/past-replies/publish', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_id: draftResponseId,
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
        router.refresh();
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Publish failed.',
        });
      }
    },
    [handleHttpError, router],
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

  // Resume a stranded draft: drop into the preview state so the owner can
  // publish it as-is (publishExisting — no PATCH) or "Edit further". Reuses
  // the regenerate-preview machinery; the draft already exists server-side.
  const resumeExistingDraft = useCallback(
    (existing: { responseId: string; text: string }) => {
      setState({
        kind: 'preview',
        draftResponseId: existing.responseId,
        text: existing.text,
      });
    },
    [],
  );

  // Discard a stranded draft (idempotent DELETE), then return to the initial
  // CTAs so the owner can start a fresh edit.
  const discardExistingDraft = useCallback(async (responseId: string) => {
    try {
      await fetch(
        `/api/dashboard/past-replies/draft/${encodeURIComponent(responseId)}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
    } catch {
      // Best-effort; DELETE is idempotent. Fall through to the initial state.
    }
    setState({ kind: 'initial' });
  }, []);

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
      const body = (await res.json()) as { response_id?: string; outbox_id?: string };
      if (!body.response_id) {
        setState({ kind: 'error', message: 'Restore returned no response id.' });
        return;
      }
      // Restore is TERMINAL recovery: the route already approved the restored
      // row and enqueued a publish_response outbox, so the original is being
      // republished directly (like /retry). The drawer does NOT route through
      // the preview→submitManual path — that path PATCHes + /publishes and
      // both run validateOptimisticConcurrency, which requires a live `posted`
      // row that an orphan state does not have (it would 409). Transition to a
      // success/closing state instead.
      setState({
        kind: 'success',
        message: 'Original reply is being republished. It will reappear on Google shortly.',
      });
      router.refresh();
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Restore failed.',
      });
    }
  }, [handleHttpError, router]);

  // NEW declarative transitions (these replace three inline setState calls that
  // currently live in the component's JSX; implemented as guarded functional updates):
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
  // Hard reset to the initial CTAs. Intentionally unguarded (unlike resumePolling
  // and editFurther) — it mirrors the original "Try again" button, which was an
  // inline setState({ kind: 'initial' }), and is only wired to the error panel
  // where resetting from any state is the desired escape hatch.
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
      startManualEdit, startRegenerate, submitManual, publishExisting, cancelDraft,
      retryPosting, resumeExistingDraft, discardExistingDraft, restoreOriginal,
      resumePolling, editFurther, reset,
    },
  };
}
