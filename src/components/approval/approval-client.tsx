'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from '@/components/dashboard/Icon';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';

interface ReviewData {
  review: {
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
    reviewDate: string;
  };
  response: {
    responseText: string;
    version: number;
    status: string;
  };
  businessName: string;
  locationLabel: string;
  isArchived: boolean;
  expiresAt: string;
}

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)__csrf=([^;]*)/);
  return match?.[1] ?? '';
}

function renderStars(rating: number): string {
  return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function ApprovalClient({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editedText, setEditedText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Guard against same-tick double-click: setActionLoading(true) queues a
  // re-render, so between the first click and the button becoming disabled
  // a second click can fire. The ref reads synchronously and closes that gap.
  const actionLockRef = useRef(false);

  // Fetch data and bind session on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const res = await fetch(`/api/approve/${token}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json: ReviewData = await res.json();
        if (cancelled) return;
        setData(json);
        setEditedText(json.response.responseText);

        // Bind device session — fail the page if binding fails
        const csrf = getCsrfToken();
        const sessionRes = await fetch(`/api/approve/${token}/session`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrf },
        });
        if (!sessionRes.ok) {
          const sessionBody = await sessionRes.json().catch(() => ({}));
          throw new Error(sessionBody.error ?? 'Session binding failed');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAction = useCallback(
    async (action: 'approve' | 'edit' | 'regenerate') => {
      if (actionLockRef.current) return;
      actionLockRef.current = true;
      setActionLoading(true);
      setError(null);

      try {
        const csrf = getCsrfToken();
        const url = `/api/approve/${token}/${action}`;
        const body =
          action === 'edit' ? JSON.stringify({ editedText }) : undefined;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'x-csrf-token': csrf,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body,
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }

        setSuccessMessage(json.message);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setActionLoading(false);
        actionLockRef.current = false;
      }
    },
    [token, editedText],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (successMessage) {
    return (
      <div className="rounded-lg bg-green-50 p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
          <svg
            className="h-5 w-5 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="2"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 12.75l6 6 9-13.5"
            />
          </svg>
        </div>
        <p className="text-sm font-medium text-green-800">{successMessage}</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data) return null;

  const { review, response } = data;
  const timeLeft = new Date(data.expiresAt).getTime() - Date.now();
  const hoursLeft = Math.max(0, Math.round(timeLeft / 3_600_000));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Location context chip — VAL-APPROVAL-001/004 */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full whitespace-nowrap max-w-[160px] truncate">
          <Icon name="location" size={10} />
          {data.locationLabel}
        </span>
        {data.isArchived && (
          <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
            Archived
          </span>
        )}
      </div>

      {/* Review card */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-xl tracking-wider text-yellow-500">
          {renderStars(review.starRating)}
        </div>
        <p className="mt-1 text-sm font-semibold text-gray-800">
          {review.reviewerName} &middot; {formatDate(review.reviewDate)}
        </p>
        {review.reviewText ? (
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            {review.reviewText}
          </p>
        ) : (
          <p className="mt-2 text-sm italic text-gray-400">
            Rating only — no written review
          </p>
        )}
      </div>

      {/* Response */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {AI_DRAFT_DISCLOSURE}
        </div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-blue-600">
          Draft response (v{response.version})
        </p>
        {isEditing ? (
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            className="w-full rounded-md border border-gray-300 p-3 text-sm leading-relaxed focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={5}
          />
        ) : (
          <p className="text-sm leading-relaxed text-gray-700">
            {response.responseText}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {isEditing ? (
          <>
            <button
              onClick={() => handleAction('edit')}
              disabled={actionLoading || editedText.trim().length === 0}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {actionLoading ? 'Saving...' : 'Save & Approve'}
            </button>
            <button
              onClick={() => {
                setIsEditing(false);
                setEditedText(response.responseText);
              }}
              disabled={actionLoading}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => handleAction('approve')}
              disabled={actionLoading}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {actionLoading ? 'Approving...' : 'Approve'}
            </button>
            <button
              onClick={() => setIsEditing(true)}
              disabled={actionLoading}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Edit
            </button>
            <button
              onClick={() => handleAction('regenerate')}
              disabled={actionLoading}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {actionLoading ? 'Requesting...' : 'Regenerate'}
            </button>
          </>
        )}
      </div>

      <p className="text-center text-xs text-gray-400">
        This link expires in {hoursLeft} hour{hoursLeft !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
