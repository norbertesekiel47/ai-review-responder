'use client';

import { useState } from 'react';

type ActionState =
  | { kind: 'idle' }
  | { kind: 'loading'; action: 'approve' | 'edit' | 'regenerate' }
  | { kind: 'editing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

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
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setState({ kind: 'success', message: 'New draft requested — check your email' });
      onSuccess();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Regenerate failed' });
    }
  }

  if (state.kind === 'success') {
    return <p className="text-green-600 text-xs mt-1">{state.message}</p>;
  }

  if (state.kind === 'error') {
    return (
      <div className="mt-1">
        <p className="text-red-600 text-xs">{state.message}</p>
        <button
          type="button"
          onClick={() => setState({ kind: 'idle' })}
          className="text-xs text-blue-600 hover:text-blue-800 mt-0.5"
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
          className="w-full rounded border border-gray-300 p-2 text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveEdit}
            className="rounded px-3 py-1 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
          >
            Save &amp; Approve
          </button>
          <button
            type="button"
            onClick={() => { setState({ kind: 'idle' }); setEditText(responseText ?? ''); }}
            className="rounded px-3 py-1 text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
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
        className="rounded px-3 py-1 text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
      >
        {isLoading && state.action === 'approve' ? 'Approve...' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={() => setState({ kind: 'editing' })}
        disabled={isLoading}
        className="rounded px-3 py-1 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={handleRegenerate}
        disabled={isLoading}
        className="rounded px-3 py-1 text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {isLoading && state.action === 'regenerate' ? 'Regenerate...' : 'Regenerate'}
      </button>
    </div>
  );
}
