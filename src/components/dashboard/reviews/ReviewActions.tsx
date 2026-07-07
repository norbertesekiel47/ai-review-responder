'use client';

import { useState } from 'react';

type ActionState =
  | { kind: 'idle' }
  | { kind: 'loading'; action: 'approve' | 'edit' | 'regenerate' | 'acknowledge' | 'resolve' }
  | { kind: 'editing' }
  | { kind: 'success'; message: string }
  | { kind: 'limit'; message: string }
  | { kind: 'error'; message: string };

/** Open Guardian escalation on the review (WS3); resolved escalations never reach the client. */
export interface ReviewEscalation {
  id: string;
  status: 'escalated' | 'acknowledged';
  severity: 'low' | 'medium' | 'high';
}

export function ReviewActions({
  reviewId,
  responseText,
  escalation = null,
  onSuccess,
}: {
  reviewId: string;
  responseText: string | null;
  escalation?: ReviewEscalation | null;
  onSuccess: () => void;
}) {
  const [state, setState] = useState<ActionState>({ kind: 'idle' });
  const [editText, setEditText] = useState(responseText ?? '');

  async function handleApprove() {
    setState({ kind: 'loading', action: 'approve' });
    try {
      const res = await fetch(`/api/dashboard/reviews/${reviewId}/approve`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setState({ kind: 'success', message: 'Approved!' });
      onSuccess();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Approval failed' });
    }
  }

  async function handleSaveEdit() {
    setState({ kind: 'loading', action: 'edit' });
    try {
      const res = await fetch(`/api/dashboard/reviews/${reviewId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editedText: editText }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setState({ kind: 'success', message: 'Approved with edits!' });
      onSuccess();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Edit failed' });
    }
  }

  async function handleRegenerate() {
    setState({ kind: 'loading', action: 'regenerate' });
    try {
      const res = await fetch(`/api/dashboard/reviews/${reviewId}/regenerate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // The per-review daily cap is an expected outcome, not an error — show
        // the server's friendly message instead of a red failure (issue #335).
        if (res.status === 429 && body.error === 'regen_limit_reached') {
          setState({
            kind: 'limit',
            message: body.message ?? 'Daily regenerate limit reached — you can try again tomorrow.',
          });
          return;
        }
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setState({ kind: 'success', message: 'New draft requested — check your email' });
      onSuccess();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Regenerate failed' });
    }
  }

  async function handleEscalationTransition(action: 'acknowledge' | 'resolve') {
    if (!escalation) return;
    setState({ kind: 'loading', action });
    try {
      const res = await fetch(`/api/dashboard/escalations/${escalation.id}/${action}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setState({
        kind: 'success',
        message: action === 'acknowledge' ? 'Escalation acknowledged' : 'Escalation resolved',
      });
      onSuccess();
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error
          ? err.message
          : action === 'acknowledge' ? 'Acknowledge failed' : 'Resolve failed',
      });
    }
  }

  if (state.kind === 'success') {
    return <p className="text-xs mt-1" style={{ color: 'var(--rw-sage-deep)' }}>{state.message}</p>;
  }

  if (state.kind === 'limit') {
    return (
      <div className="mt-1">
        <p className="text-xs" role="status" style={{ color: 'var(--rw-blush-deep)' }}>{state.message}</p>
        <button
          type="button"
          onClick={() => setState({ kind: 'idle' })}
          className="text-xs mt-0.5"
          style={{ color: 'var(--rw-sage-deep)' }}
        >
          Back
        </button>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="mt-1">
        <p className="text-xs" style={{ color: 'var(--rw-danger)' }}>{state.message}</p>
        <button
          type="button"
          onClick={() => setState({ kind: 'idle' })}
          className="text-xs mt-0.5"
          style={{ color: 'var(--rw-sage-deep)' }}
        >
          Try again
        </button>
      </div>
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
            onClick={handleSaveEdit}
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
        onClick={handleApprove}
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
        onClick={handleRegenerate}
        disabled={isLoading}
        className="btn btn-tertiary"
      >
        {isLoading && state.action === 'regenerate' ? 'Regenerate...' : 'Regenerate'}
      </button>
      {escalation && escalation.status === 'escalated' && (
        <button
          type="button"
          onClick={() => handleEscalationTransition('acknowledge')}
          disabled={isLoading}
          className="btn btn-secondary"
        >
          {isLoading && state.action === 'acknowledge' ? 'Acknowledge...' : 'Acknowledge'}
        </button>
      )}
      {escalation && (
        <button
          type="button"
          onClick={() => handleEscalationTransition('resolve')}
          disabled={isLoading}
          className="btn btn-secondary"
        >
          {isLoading && state.action === 'resolve' ? 'Resolve...' : 'Resolve'}
        </button>
      )}
    </div>
  );
}
