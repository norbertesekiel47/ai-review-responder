'use client';

import { useContext, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY } from '@/components/dashboard/NeedsAttentionList';
import { describeActionFailure, type DraftAction } from '@/components/dashboard/reviews/action-copy';
import { ReplyEditor } from '@/components/dashboard/reviews/ReplyEditor';
import { useRefreshHold } from '@/components/dashboard/shell/refresh-hold';
import type { OpenEscalationStatus } from '@/lib/escalations/types';
import type { TriageSeverity } from '@/lib/reviews/triage-schema';

type ActionState =
  | { kind: 'idle' }
  | { kind: 'loading'; action: DraftAction }
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
 * `Failed (status)` fallback; owner-facing copy is derived by
 * `describeActionFailure`, never shown raw.
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
    <div className="mt-1 space-y-1">
      <p className="text-xs" role={role} style={{ color }}>{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="btn btn-tertiary"
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
  onRegenerateStarted,
}: {
  reviewId: string;
  responseText: string | null;
  onSuccess: () => void | Promise<void>;
  /**
   * Called once the regenerate request is accepted. The row owner swaps in its
   * "writing a new reply" state (UX audit D10); when absent, a text confirmation
   * renders here instead.
   */
  onRegenerateStarted?: () => void;
}) {
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const [editText, setEditText] = useState(responseText ?? '');
  // An owner mid-edit must never lose the textarea to the 60 s auto-refresh.
  useRefreshHold(state.kind === 'editing');

  async function runDraftAction(
    action: DraftAction,
    successMessage: string,
    init?: RequestInit,
  ) {
    setState({ kind: 'loading', action });
    try {
      await postDashboardAction(`/api/dashboard/reviews/${reviewId}/${action}`, init);
      if (action === 'regenerate' && onRegenerateStarted) {
        setState({ kind: 'idle' });
        onRegenerateStarted();
        return;
      }
      setState({ kind: 'success', message: successMessage });
      void onSuccess();
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
          message: err.body.message ?? 'Daily regenerate limit reached. You can try again tomorrow.',
        });
        return;
      }
      const failure = describeActionFailure(
        action,
        err instanceof DashboardActionError
          ? { status: err.status, code: err.body.error }
          : { status: 0 },
      );
      // A stale row (already handled elsewhere) refreshes the queue so the
      // settled state replaces the card — the same posture as EscalationActions.
      if (failure.stale) void onSuccess();
      setState({ kind: 'error', message: failure.message });
    }
  }

  if (state.kind === 'success') {
    return <p className="text-xs mt-1" role="status" style={{ color: 'var(--rw-sage-deep)' }}>{state.message}</p>;
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
        role="alert"
        dismissLabel="Try again"
        onDismiss={() => setState({ kind: 'idle' })}
      />
    );
  }

  const isLoading = state.kind === 'loading';

  if (state.kind === 'editing') {
    return (
      <div className="mt-2 space-y-2">
        <ReplyEditor
          id={`reply-editor-${reviewId}`}
          label="Edit reply text"
          value={editText}
          onChange={setEditText}
          rows={4}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => runDraftAction('edit', 'Approved with edits!', {
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
        onClick={() => runDraftAction('approve', 'Approved!')}
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
        onClick={() => runDraftAction('regenerate', 'Writing a new reply. It will appear here shortly.')}
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
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

/**
 * The one owner control for an open Guardian escalation (WS3): "Mark as
 * handled", which resolves it (resolve implies acknowledge — a direct
 * escalated → resolved transition is legal and stamps both timestamps). Two
 * unexplained buttons, Acknowledge and Resolve, used to sit here beside the
 * three draft actions (UX audit D14). Rendered by the review card for ANY card
 * with an open escalation, independent of draft state — moderation-HELD drafts
 * (response text withheld) are exactly the high-severity lane and must still
 * be actionable.
 */
export function EscalationActions({
  escalation,
  onSuccess,
}: {
  escalation: ReviewEscalation;
  onSuccess: () => void | Promise<void>;
}) {
  const [state, setState] = useState<EscalationActionState>({ kind: 'idle' });
  // Read the client optionally (not useQueryClient, which throws): the queue
  // invalidation is best-effort sync — the feed refresh via onSuccess is the
  // primary effect and must not depend on a provider being mounted.
  const queryClient = useContext(QueryClientContext);

  async function markHandled() {
    setState({ kind: 'loading' });
    try {
      await postDashboardAction(`/api/dashboard/escalations/${escalation.id}/resolve`);
      void onSuccess();
      // The needs-attention queue reads the same escalations; keep it in sync.
      void queryClient?.invalidateQueries({ queryKey: DASHBOARD_OPEN_ESCALATIONS_QUERY_KEY });
      // Back to idle, NOT a terminal success panel: the refreshed card is the
      // confirmation, and any draft actions stay independently usable.
      setState({ kind: 'idle' });
    } catch (err) {
      // A 409 means the escalation was already transitioned elsewhere (e.g. a
      // second tab) — a benign race, not a failure. Mirror the timeline
      // actions: refresh the feed so the settled state replaces the stale card.
      if (err instanceof DashboardActionError && err.status === 409) {
        void onSuccess();
        setState({ kind: 'idle' });
        return;
      }
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Marking as handled failed',
      });
    }
  }

  if (state.kind === 'error') {
    return (
      <ActionNotice
        message={state.message}
        color="var(--rw-danger)"
        role="alert"
        dismissLabel="Try again"
        onDismiss={() => setState({ kind: 'idle' })}
      />
    );
  }

  const isLoading = state.kind === 'loading';
  const helper = escalation.status === 'acknowledged'
    ? "You've seen this one. Mark it handled once you've followed up with the customer."
    : "Guardian flagged this review for you. Mark it handled once you've followed up with the customer.";

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs" style={{ color: 'var(--rw-app-text-muted)' }}>{helper}</p>
      <button
        type="button"
        onClick={() => void markHandled()}
        disabled={isLoading}
        className="btn btn-secondary"
      >
        {isLoading ? 'Marking as handled...' : 'Mark as handled'}
      </button>
    </div>
  );
}
