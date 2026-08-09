// useInlineGenerate — the client state machine behind the Reviews list's
// **On-demand generation** lane (`Generate` on a never-replied review, #678).
//
// A NEW hook rather than an extension of `useEditReplyDraft`: that machine
// requires an optimistic-concurrency snapshot AND an existing posted reply
// (`row.review_content_hash` + `row.version`, sent on every mutating call), and
// a never-replied review has neither. It does follow the same poll-and-settle
// shape, and the same "never let the poller fire without its key" discipline.
//
// API contract (see the route headers under
// src/app/api/dashboard/reviews/[reviewId]/):
//   POST /api/dashboard/reviews/:id/generate      → { outbox_id, version }
//        429 { error: 'rate_limited' }
//        429 { error: 'regen_limit_reached', message, remaining, limit }
//        409 { error: 'already_answered' | 'draft_already_exists' |
//                     'regenerate_in_progress' }
//   GET  /api/dashboard/reviews/:id/draft-status  →
//        { status: 'generating' } | { status: 'failed', error } |
//        { status: 'ready', response_id, response_text } | { status: 'idle' }
//   POST /api/dashboard/reviews/:id/approve       → { success, message }
//   POST /api/dashboard/reviews/:id/edit          → { success, message }
//
// Two deliberate design points:
//
//  1. **Polling is keyed on `reviewId`, not on an `outbox_id` the client is
//     holding** (D-C). That is what lets `Generating…` survive a page refresh:
//     the row arrives from the server already carrying `row_action:'generating'`,
//     this hook starts in the polling state, and no client-side id is needed.
//
//  2. **No `useRouter`.** Settling a single row must not `router.refresh()` the
//     whole list — that would re-render every other card and throw away the
//     owner's scroll position and any other expanded row. The panel shows its
//     own terminal state; the server row reconciles on the next navigation.
//
// Error copy is surfaced VERBATIM from the server body (`message`, else
// `error`), mirroring `useEditReplyDraft.handleHttpError`: the 429 strings are
// owned by `src/lib/shared/dashboard-regen-rate-limit.ts`, and re-spelling them
// here would fork the copy.

'use client';

import { useCallback, useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

// Module-private: the hook's return type carries it by inference and
// InlineGeneratePanel switches on `state.kind` without naming the union, so
// exporting it would publish a symbol with no consumer.
type InlineGenerateState =
  // Nothing in flight and no draft — the `Generate` button is the only affordance.
  | { kind: 'idle' }
  // In-flight POST /generate. Distinct from 'generating' so the polling effect
  // cannot fire before the server has committed the outbox row (the
  // 'creating_draft' precedent in useEditReplyDraft).
  | { kind: 'starting' }
  // `startedAt` anchors the POLL_TIMEOUT_MS budget. It lives ON the state rather
  // than in an effect-local `let` because continuing the poll re-issues this
  // state (see the polling effect), and the budget must span every re-issue.
  | { kind: 'generating'; startedAt: number }
  | { kind: 'ready'; responseId: string; text: string }
  | { kind: 'editing'; responseId: string; text: string }
  | { kind: 'publishing' }
  | { kind: 'posted'; message: string }
  | { kind: 'error'; message: string };

interface ApiBody {
  status?: string;
  error?: string;
  message?: string;
  response_id?: string;
  response_text?: string | null;
}

async function readJsonSafe(res: Response): Promise<ApiBody | null> {
  try {
    return (await res.json()) as ApiBody;
  } catch {
    return null;
  }
}

/** Server copy wins; `error` is the code the routes return without a message. */
function serverMessage(body: ApiBody | null, fallback: string): string {
  return body?.message ?? body?.error ?? fallback;
}

export interface UseInlineGenerateParams {
  reviewId: string;
  /**
   * True when the SERVER-rendered row state is already `generating` — an outbox
   * row was in flight when the page was rendered. The hook then mounts straight
   * into the polling state instead of showing `Generate` again, which is what
   * makes the state survive a refresh (D-C). Without it a refresh would re-offer
   * `Generate` and burn a rate-limit token to learn it 409s.
   */
  resumeGenerating: boolean;
}

export function useInlineGenerate({ reviewId, resumeGenerating }: UseInlineGenerateParams) {
  const [state, setState] = useState<InlineGenerateState>(() =>
    resumeGenerating ? { kind: 'generating', startedAt: Date.now() } : { kind: 'idle' },
  );

  // Poll while a generation is outstanding.
  //
  // The effect arms EXACTLY ONE timer per run, `const`-bound so its `clearTimeout`
  // is statically paired with it. Continuing the poll re-issues the `generating`
  // state — same `startedAt`, fresh object identity — which re-runs this effect
  // and arms the next timer. The earlier shape re-assigned an effect-local
  // `timerId` from inside the async callback: correct, but only provably so by
  // tracing the `cancelled` guard across two awaits, which neither a reader nor a
  // static analyzer can do at a glance (react-doctor/effect-needs-cleanup).
  useEffect(() => {
    if (state.kind !== 'generating') return;
    const { startedAt } = state;
    let cancelled = false;

    const timerId = setTimeout(async () => {
      // No `cancelled` check before the first await: the cleanup's clearTimeout
      // below runs synchronously, so a cancelled timer never enters this body.
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setState({
          kind: 'error',
          message: 'Generation is taking longer than expected. Refresh to check again.',
        });
        return;
      }
      try {
        const res = await fetch(
          `/api/dashboard/reviews/${encodeURIComponent(reviewId)}/draft-status`,
          { credentials: 'same-origin' },
        );
        const body = await readJsonSafe(res);
        if (cancelled) return;
        if (!res.ok || !body) {
          setState({
            kind: 'error',
            message: serverMessage(body, `Status check failed (${res.status}).`),
          });
          return;
        }
        if (body.status === 'generating') {
          setState({ kind: 'generating', startedAt });
          return;
        }
        if (body.status === 'ready' && body.response_id) {
          setState({ kind: 'ready', responseId: body.response_id, text: body.response_text ?? '' });
          return;
        }
        if (body.status === 'failed') {
          setState({ kind: 'error', message: body.error ?? 'Generation failed. Try again.' });
          return;
        }
        // 'idle' — nothing in flight and no draft the owner may act on. The
        // moderation-held case lands here by design (invariant #4: the poller
        // never returns held text), and the row re-renders as `held` from the
        // server on the next load. Stop polling; do not offer a second spend.
        setState({ kind: 'idle' });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Network error while checking status.',
        });
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [state, reviewId]);

  const start = useCallback(async () => {
    // 'starting' first (never 'generating') so the polling effect cannot run
    // before the route has committed the outbox row it polls for.
    setState({ kind: 'starting' });
    try {
      const res = await fetch(`/api/dashboard/reviews/${encodeURIComponent(reviewId)}/generate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await readJsonSafe(res);
      if (!res.ok) {
        // 429 `rate_limited` / `regen_limit_reached` bodies are surfaced
        // verbatim — dashboard-regen-rate-limit.ts owns that copy.
        setState({ kind: 'error', message: serverMessage(body, `Generate failed (${res.status}).`) });
        return;
      }
      setState({ kind: 'generating', startedAt: Date.now() });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Generate failed.' });
    }
  }, [reviewId]);

  /** Shared POST → terminal-state path for `Approve & post` and `Save & post`. */
  const submit = useCallback(
    async (path: 'approve' | 'edit', payload?: { editedText: string }) => {
      setState({ kind: 'publishing' });
      try {
        const res = await fetch(
          `/api/dashboard/reviews/${encodeURIComponent(reviewId)}/${path}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            ...(payload ? { body: JSON.stringify(payload) } : {}),
          },
        );
        const body = await readJsonSafe(res);
        if (!res.ok) {
          setState({ kind: 'error', message: serverMessage(body, `Posting failed (${res.status}).`) });
          return;
        }
        setState({
          kind: 'posted',
          message: body?.message ?? 'Reply queued for Google.',
        });
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Posting failed.' });
      }
    },
    [reviewId],
  );

  const approve = useCallback(() => submit('approve'), [submit]);
  const saveEdit = useCallback(
    (editedText: string) => submit('edit', { editedText }),
    [submit],
  );

  const startEdit = useCallback(() => {
    setState((prev) =>
      prev.kind === 'ready' ? { kind: 'editing', responseId: prev.responseId, text: prev.text } : prev,
    );
  }, []);
  const changeEditText = useCallback((text: string) => {
    setState((prev) => (prev.kind === 'editing' ? { ...prev, text } : prev));
  }, []);
  const cancelEdit = useCallback(() => {
    setState((prev) =>
      prev.kind === 'editing' ? { kind: 'ready', responseId: prev.responseId, text: prev.text } : prev,
    );
  }, []);
  // Escape hatch from the error panel back to the `Generate` affordance. The
  // draft (if the worker did land one) is still the row's, so the next attempt
  // 409s rather than double-spending.
  const reset = useCallback(() => setState({ kind: 'idle' }), []);

  return {
    state,
    actions: { start, approve, startEdit, changeEditText, cancelEdit, saveEdit, reset },
  };
}
