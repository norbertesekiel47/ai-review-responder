// Edit-existing-reply state machine behind EditReplyDrawer.
//
// User-facing states: initial -> editing or regenerating -> preview ->
// publishing, plus failed-post recovery. Transient states keep server work and
// conflict handling explicit: creating_draft, regenerate_poll_error,
// review_changed, draft_conflict, error, and success.
//
// The optimistic-concurrency snapshot is captured once at mount and sent on
// every draft/publish mutation. API contract:
//   POST /draft -> { response_id } | { outbox_id }
//   PATCH|DELETE /draft/:id -> 204; POST /publish -> { outbox_id }
//   GET /draft-status -> generating | failed | { response_id, response_text }
//   POST /:id/retry -> { outbox_id }
//   POST /:id/restore-original -> { response_id, outbox_id } (terminal)

'use client';

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
import {
  readJsonSafe,
  REPLY_POLL_INTERVAL_MS,
  REPLY_POLL_TIMEOUT_MS,
} from '@/components/dashboard/reviews/client-helpers';

interface Snapshot {
  hash: string;
  version: number;
}

type DrawerState =
  // Set before POST /draft resolves so polling cannot start without an outbox id.
  | { kind: 'initial' }
  | { kind: 'editing'; text: string; draftResponseId: string | null }
  | { kind: 'creating_draft' }
  | { kind: 'regenerating'; outboxId: string }
  // The worker may still create a hidden draft after a transient polling error;
  // retain outboxId and refuse close until polling resumes or finishes.
  | { kind: 'regenerate_poll_error'; outboxId: string; message: string }
  | { kind: 'preview'; draftResponseId: string; text: string }
  | { kind: 'publishing' }
  // failedPostingError controls whether Restore is safe for this failure mode.
  | { kind: 'recovery'; failedResponseId: string; failedPostingError: string | null }
  | { kind: 'review_changed'; currentText: string | null }
  // pending_approval => Resume/Discard; approved/edited/awaiting_owner_connect
  // are informational because their server-side workflow is already in flight.
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

interface DraftStatusPayload {
  status?: string;
  error?: string;
  response_id?: string;
  response_text?: string | null;
}

async function post(url: string, payload?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function postJson<T>(url: string, payload?: unknown): Promise<{ response: Response; body: T | null }> {
  const response = await post(url, payload);
  return { response, body: await readJsonSafe<T>(response) };
}

// Preserve the original actions' contract: malformed successful JSON throws,
// while error bodies remain best-effort so their HTTP fallback still renders.
async function postJsonRequired<T>(url: string, payload?: unknown): Promise<{ response: Response; body: T | null }> {
  const response = await post(url, payload);
  const body = response.ok ? await response.json() as T : await readJsonSafe<T>(response);
  return { response, body };
}

async function runAction(
  action: () => Promise<void>,
  onError: (message: string) => void,
  fallback: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    onError(error instanceof Error ? error.message : fallback);
  }
}

type SetDrawerState = Dispatch<SetStateAction<DrawerState>>;

/** Poll an outstanding regeneration without allowing an orphaned draft. */
function useRegenerationPolling(state: DrawerState, setState: SetDrawerState): void {
  useEffect(() => {
    if (state.kind !== 'regenerating') return;
    const outboxId = state.outboxId;
    const startedAt = Date.now();
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    // One stateful chain is intentional: it preserves one timeout budget and
    // one mutable timer handle without rendering on every 1.5-second poll.
    // fallow-ignore-next-line complexity
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > REPLY_POLL_TIMEOUT_MS) {
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: 'Generation is taking longer than expected. The draft may still arrive.',
        });
        return;
      }
      try {
        const response = await fetch(
          `/api/dashboard/past-replies/draft-status?outbox_id=${encodeURIComponent(outboxId)}`,
          { credentials: 'same-origin' },
        );
        const body = await readJsonSafe<DraftStatusPayload>(response);
        if (cancelled) return;
        if (!response.ok || !body) {
          setState({
            kind: 'regenerate_poll_error',
            outboxId,
            message: body?.error ?? `Status check failed (${response.status}). The worker may still finish.`,
          });
          return;
        }
        if (body.status === 'generating') {
          // Self-schedule without a state write: polling must not render per tick.
          timerId = setTimeout(tick, REPLY_POLL_INTERVAL_MS);
          return;
        }
        if (body.status === 'failed') {
          // Terminal worker failure inserts no response row, so close is safe.
          setState({ kind: 'error', message: body.error ?? 'Generation failed. Try again.' });
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
        // Unknown terminal-shaped data is closable; treating it as transient
        // would trap the owner behind a permanently non-closable drawer.
        setState({ kind: 'error', message: 'Unexpected response from server.' });
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: 'regenerate_poll_error',
          outboxId,
          message: error instanceof Error ? error.message : 'Network error while polling.',
        });
      }
    };

    timerId = setTimeout(tick, REPLY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [state, setState]);
}

function useHttpErrorHandler(setState: SetDrawerState) {
  return useCallback(
    async (
      response: Response,
      fallback: string,
      parsedBody?: ApiErrorPayload | null,
    ): Promise<void> => {
      const body = parsedBody === undefined
        ? await readJsonSafe<ApiErrorPayload>(response)
        : parsedBody;
      if (response.status === 409 && body?.error === 'review_changed') {
        setState({ kind: 'review_changed', currentText: body.current_review_text ?? null });
        return;
      }
      if (response.status === 409 && body?.error === 'draft_already_exists' && body.existing) {
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
    [setState],
  );
}

export interface UseEditReplyDraftParams {
  row: PastReplyRow;
  initialFailureRecovery: { failedResponseId: string; failedPostingError: string | null } | null;
  onClose: () => void;
}

export function useEditReplyDraft({ row, initialFailureRecovery, onClose }: UseEditReplyDraftParams) {
  const router = useRouter();

  // Never re-derive while open: the server compares this mount-time snapshot
  // across /draft and /publish to detect a concurrent customer edit.
  const snapshotRef = useRef<Snapshot>({
    hash: row.review_content_hash ?? '',
    version: row.version ?? 0,
  });

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

  useRegenerationPolling(state, setState);
  const handleHttpError = useHttpErrorHandler(setState);

  const startManualEdit = useCallback(() => {
    setState({ kind: 'editing', text: currentReplyText, draftResponseId: null });
  }, [currentReplyText]);

  const startRegenerate = useCallback(async () => {
    setState({ kind: 'creating_draft' });
    await runAction(
      async () => {
        const { response, body } = await postJsonRequired<ApiErrorPayload & { outbox_id?: string }>(
          '/api/dashboard/past-replies/draft',
          {
            mode: 'regenerate',
            review_id: row.review_id,
            snapshot: snapshotRef.current,
          },
        );
        if (!response.ok) {
          await handleHttpError(response, `Regenerate failed (${response.status})`, body);
          return;
        }
        if (!body?.outbox_id) {
          setState({ kind: 'error', message: 'Server did not return an outbox id.' });
          return;
        }
        setState({ kind: 'regenerating', outboxId: body.outbox_id });
      },
      (message) => setState({ kind: 'error', message }),
      'Regenerate failed.',
    );
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
          const { response, body } = await postJsonRequired<ApiErrorPayload & { response_id?: string }>(
            '/api/dashboard/past-replies/draft',
            {
              mode: 'manual',
              review_id: row.review_id,
              new_text: text,
              snapshot: snapshotRef.current,
            },
          );
          if (!response.ok) {
            await handleHttpError(response, `Draft failed (${response.status})`, body);
            return;
          }
          if (!body?.response_id) {
            setState({ kind: 'error', message: 'Server did not return a response id.' });
            return;
          }
          responseId = body.response_id;
        } else {
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

        const { response: pubRes, body: pubBody } = await postJson<ApiErrorPayload>(
          '/api/dashboard/past-replies/publish',
          {
            response_id: responseId,
            snapshot: snapshotRef.current,
          },
        );
        if (!pubRes.ok) {
          await handleHttpError(pubRes, `Publish failed (${pubRes.status})`, pubBody);
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
    [row.review_id, handleHttpError, router],
  );

  // Publish a generated draft without PATCHing it: PATCH sets edited_text and
  // would misclassify regenerate_as_is as regenerate_edited.
  const publishExisting = useCallback(
    async (draftResponseId: string) => {
      setState({ kind: 'publishing' });
      await runAction(
        async () => {
          const { response, body } = await postJson<ApiErrorPayload>(
            '/api/dashboard/past-replies/publish',
            {
              response_id: draftResponseId,
              snapshot: snapshotRef.current,
            },
          );
          if (!response.ok) {
            await handleHttpError(response, `Publish failed (${response.status})`, body);
            return;
          }
          setState({
            kind: 'success',
            message: 'Update queued for Google. The new reply will appear shortly.',
          });
          router.refresh();
        },
        (message) => setState({ kind: 'error', message }),
        'Publish failed.',
      );
    },
    [handleHttpError, router],
  );

  const cancelDraft = useCallback(
    async (draftResponseId: string | null) => {
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

  // Refuse close in every window where a worker can still create a hidden
  // pending_approval row. Once preview exists, cancelDraft can delete the row.
  const tryClose = useCallback(() => {
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

  // Retry and Restore share HTTP mechanics but have different terminal contracts;
  // keeping them explicit avoids a flag-driven action with restore-only validation.
  // fallow-ignore-next-line code-duplication
  const retryPosting = useCallback(
    async (failedResponseId: string) => {
      setState({ kind: 'publishing' });
      await runAction(
        async () => {
          const { response, body } = await postJson<ApiErrorPayload>(
            `/api/dashboard/past-replies/${encodeURIComponent(failedResponseId)}/retry`,
          );
          if (!response.ok) {
            await handleHttpError(response, `Retry failed (${response.status})`, body);
            return;
          }
          setState({ kind: 'success', message: 'Retry queued. The reply will reappear once posted.' });
          router.refresh();
        },
        (message) => setState({ kind: 'error', message }),
        'Retry failed.',
      );
    },
    [handleHttpError, router],
  );

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

  // Restore is terminal: the route approves the replacement and enqueues its
  // publish itself. Preview/PATCH/publish would require a live posted row and
  // fail optimistic concurrency for the orphan-recovery state.
  const restoreOriginal = useCallback(
    async (failedResponseId: string) => {
      setState({ kind: 'publishing' });
      await runAction(
        async () => {
          const { response, body } = await postJsonRequired<ApiErrorPayload & { response_id?: string }>(
            `/api/dashboard/past-replies/${encodeURIComponent(failedResponseId)}/restore-original`,
          );
          if (!response.ok) {
            await handleHttpError(response, `Restore failed (${response.status})`, body);
            return;
          }
          if (!body?.response_id) {
            setState({ kind: 'error', message: 'Restore returned no response id.' });
            return;
          }
          setState({
            kind: 'success',
            message: 'Original reply is being republished. It will reappear on Google shortly.',
          });
          router.refresh();
        },
        (message) => setState({ kind: 'error', message }),
        'Restore failed.',
      );
    },
    [handleHttpError, router],
  );

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
  // Unguarded by design: the error panel's Try again is an escape hatch from
  // any terminal error, unlike the state-specific transitions above.
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
