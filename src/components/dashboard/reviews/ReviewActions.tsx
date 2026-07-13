'use client';

import { useContext, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY } from '@/components/dashboard/NeedsAttentionList';
import type { OpenEscalationStatus } from '@/lib/escalations/types';
import type { TriageSeverity } from '@/lib/reviews/triage-schema';

type ActionState =
  | { kind: 'idle' }
  | { kind: 'loading'; action: 'approve' | 'edit' | 'regenerate' }
  | { kind: 'editing' }
  | { kind: 'success'; message: string }
  | { kind: 'limit'; message: string }
  | { kind: 'error'; message: string };

/** Open Guardian escalation on the review (WS3); resolved escalations never reach the client. */
export interface ReviewEscalation {
  id: string;
  status: OpenEscalationStatus;
  severity: TriageSeverity;
}

/**
 * Failed dashboard POST — carries the HTTP status + parsed error body so
 * callers can distinguish expected outcomes (e.g. the regenerate daily cap)
 * from real failures. `message` is the server's error code or a generic
 * `Failed (status)` fallback, matching what the error panel should show.
 */
class DashboardActionError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string },
  ) {
    super(body.error ?? `Failed (${status})`);
  }
}

/** POST a dashboard action; throws DashboardActionError on a non-OK response. */
async function postDashboardAction(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, { method: 'POST', ...init });
  if (!res.ok) {
    const body: { error?: string; message?: string } = await res.json().catch(() => ({}));
    throw new DashboardActionError(res.status, body);
  }
}

/** Dismissible message panel shared by the limit and error states. */
function ActionNotice({
  message,
  color,
  role,
  dismissLabel,
  onDismiss,
}: {
  message: string;
  color: string;
  role?: string;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-1">
      <p className="text-xs" role={role} style={{ color }}>{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs mt-0.5"
        style={{ color: 'var(--rw-sage-deep)' }}
      >
        {dismissLabel}
      </button>
    </div>
  );
}

export function ReviewActions({
  reviewId,
  responseText,
  onSuccess,
}: {
  reviewId: string;
  responseText: string | null;
  onSuccess: () => void;
}) {
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const [editText, setEditText] = useState(responseText ?? '');

  async function runDraftAction(
    action: 'approve' | 'edit' | 'regenerate',
    successMessage: string,
    failureMessage: string,
    init?: RequestInit,
  ) {
    setState({ kind: 'loading', action });
    try {
      await postDashboardAction(`/api/dashboard/reviews/${reviewId}/${action}`, init);
      setState({ kind: 'success', message: successMessage });
      onSuccess();
    } catch (err) {
      // The per-review daily cap is an expected outcome, not an error — show
      // the server's friendly message instead of a red failure (issue #335).
      // Only the regenerate endpoint emits this code.
      if (
        err instanceof DashboardActionError &&
        err.status === 429 &&
        err.body.error === 'regen_limit_reached'
      ) {
        setState({
          kind: 'limit',
          message: err.body.message ?? 'Daily regenerate limit reached — you can try again tomorrow.',
        });
        return;
      }
      setState({ kind: 'error', message: err instanceof Error ? err.message : failureMessage });
    }
  }

  if (state.kind === 'success') {
    return <p className="text-xs mt-1" style={{ color: 'var(--rw-sage-deep)' }}>{state.message}</p>;
  }

  if (state.kind === 'limit') {
    return (
      <ActionNotice
        message={state.message}
        color="var(--rw-blush-deep)"
        role="status"
        dismissLabel="Back"
        onDismiss={() => setState({ kind: 'idle' })}
      />
    );
  }

  if (state.kind === 'error') {
    return (
      <ActionNotice
        message={state.message}
        color="var(--rw-danger)"
        dismissLabel="Try again"
        onDismiss={() => setState({ kind: 'idle' })}
      />
    );
  }

  const isLoading = state.kind === 'loading';

  if (state.kind === 'editing') {
    return (
      <div className="mt-2 space-y-2">
        <textarea
          aria-label="Edit reply text"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          maxLength={2000}
          rows={4}
          className="textarea"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => runDraftAction('edit', 'Approved with edits!', 'Edit failed', {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editedText: editText }),
            })}
            className="btn btn-primary"
          >
            Save &amp; Approve
          </button>
          <button
            type="button"
            onClick={() => { setState({ kind: 'idle' }); setEditText(responseText ?? ''); }}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => runDraftAction('approve', 'Approved!', 'Approval failed')}
        disabled={isLoading}
        className="btn btn-primary"
      >
        {isLoading && state.action === 'approve' ? 'Approve...' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={() => setState({ kind: 'editing' })}
        disabled={isLoading}
        className="btn btn-secondary"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={() => runDraftAction('regenerate', 'New draft requested — check your email', 'Regenerate failed')}
        disabled={isLoading}
        className="btn btn-tertiary"
      >
        {isLoading && state.action === 'regenerate' ? 'Regenerate...' : 'Regenerate'}
      </button>
    </div>
  );
}

type EscalationActionState =
  | { kind: 'idle' }
  | { kind: 'loading'; action: 'acknowledge' | 'resolve' }
  | { kind: 'error'; message: string };

/**
 * Acknowledge/Resolve for an open Guardian escalation (WS3). Rendered by the
 * review card for ANY card with an open escalation, independent of draft
 * state — moderation-HELD drafts (response text withheld) are exactly the
 * high-severity lane and must still be actionable.
 */
export function EscalationActions({
  escalation,
  onSuccess,
}: {
  escalation: ReviewEscalation;
  onSuccess: () => void;
}) {
  const [state, setState] = useState<EscalationActionState>({ kind: 'idle' });
  // Read the client optionally (not useQueryClient, which throws): the queue
  // invalidation is best-effort sync — the feed refresh via onSuccess is the
  // primary effect and must not depend on a provider being mounted.
  const queryClient = useContext(QueryClientContext);

  async function handleTransition(action: 'acknowledge' | 'resolve') {
    setState({ kind: 'loading', action });
    try {
      await postDashboardAction(`/api/dashboard/escalations/${escalation.id}/${action}`);
      onSuccess();
      // The needs-attention queue reads the same escalations; keep it in sync.
      void queryClient?.invalidateQueries({ queryKey: DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY });
      // Back to idle, NOT a terminal success panel: the refreshed escalation
      // badge is the confirmation, and Resolve must stay reachable after an
      // Acknowledge (and any draft actions stay independently usable).
      setState({ kind: 'idle' });
    } catch (err) {
      // A 409 means the escalation was already transitioned elsewhere (e.g. a
      // second tab) — a benign race, not a failure. Mirror the timeline
      // actions: refresh the feed so the settled state replaces the stale card.
      if (err instanceof DashboardActionError && err.status === 409) {
        onSuccess();
        setState({ kind: 'idle' });
        return;
      }
      setState({
        kind: 'error',
        message: err instanceof Error
          ? err.message
          : action === 'acknowledge' ? 'Acknowledge failed' : 'Resolve failed',
      });
    }
  }

  if (state.kind === 'error') {
    return (
      <ActionNotice
        message={state.message}
        color="var(--rw-danger)"
        dismissLabel="Try again"
        onDismiss={() => setState({ kind: 'idle' })}
      />
    );
  }

  const isLoading = state.kind === 'loading';

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {escalation.status === 'escalated' && (
        <button
          type="button"
          onClick={() => handleTransition('acknowledge')}
          disabled={isLoading}
          className="btn btn-secondary"
        >
          {isLoading && state.action === 'acknowledge' ? 'Acknowledge...' : 'Acknowledge'}
        </button>
      )}
      <button
        type="button"
        onClick={() => handleTransition('resolve')}
        disabled={isLoading}
        className="btn btn-secondary"
      >
        {isLoading && state.action === 'resolve' ? 'Resolve...' : 'Resolve'}
      </button>
    </div>
  );
}
