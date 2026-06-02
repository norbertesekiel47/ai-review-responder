'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { LazyMotion, domAnimation, m } from 'motion/react';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { ApprovalErrorState } from './ApprovalErrorState';

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

type ApprovalAction = 'approve' | 'edit' | 'regenerate';

interface ActionResponse {
  success?: boolean;
  message?: string;
  error?: string;
}

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)__csrf=([^;]*)/);
  return match?.[1] ?? '';
}

function formatStars(rating: number): string {
  // Clamp to an integer in [0, 5] — '★'.repeat() throws RangeError on a
  // negative count, so malformed (negative, non-finite, or > 5) ratings must
  // not reach repeat(). Matches the defensive helpers in the dashboard cards.
  const filled = Math.round(Math.max(0, Math.min(5, Number.isFinite(rating) ? rating : 0)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
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

function LocationPin() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

const PRIMARY_BTN =
  'flex-1 rounded-full bg-[#97B3AE] px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-[#97B3AE]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
const GHOST_BTN =
  'flex-1 rounded-full border border-[#97B3AE]/30 bg-white px-4 py-3 text-sm font-semibold text-[#97B3AE] transition hover:bg-[#F0EEEA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

export default function ApprovalClient({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editedText, setEditedText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [successAction, setSuccessAction] = useState<ApprovalAction | null>(null);
  // Guard against same-tick double-click: setActionLoading(true) queues a
  // re-render, so between the first click and the button becoming disabled
  // a second click can fire. The ref reads synchronously and closes that gap.
  const actionLockRef = useRef(false);

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
    async (action: ApprovalAction) => {
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

        const json: ActionResponse = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }

        setSuccessAction(action);
        // Treat empty/whitespace messages as missing — the success view gates on
        // successMessage truthiness, and `??` would let '' through and render nothing.
        setSuccessMessage(
          json.message?.trim() ? json.message : 'Your request has been processed.',
        );
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
        <div className="size-8 animate-spin rounded-full border-4 border-[#97B3AE] border-t-transparent" />
      </div>
    );
  }

  if (successMessage) {
    const heading =
      successAction === 'regenerate'
        ? 'New draft on the way'
        : 'Response approved!';
    return (
      <LazyMotion features={domAnimation}>
        <m.div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-[#97B3AE]/15">
            <svg
              className="size-7 text-[#97B3AE]"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 12.75l6 6 9-13.5"
              />
            </svg>
          </div>
          <h2 className="text-xl font-medium text-[#2a2a2a]">{heading}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[#6a6a6a]">
            {successMessage}
          </p>
          <Link
            href="/dashboard"
            className="mt-6 inline-block rounded-sm text-sm font-semibold text-[#97B3AE] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2"
          >
            View your reviews →
          </Link>
        </m.div>
      </LazyMotion>
    );
  }

  if (error && !data) {
    return <ApprovalErrorState message={error} />;
  }

  if (!data) return null;

  const { review, response } = data;
  const timeLeft = new Date(data.expiresAt).getTime() - Date.now();
  const hoursLeft = Math.max(0, Math.round(timeLeft / 3_600_000));

  return (
    <LazyMotion features={domAnimation}>
      <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-[#dc2626]/30 bg-[#dc2626]/5 p-3 text-sm text-[#b91c1c]"
        >
          {error}
        </div>
      )}

      {/* Location context chip — VAL-APPROVAL-001/004 */}
      <div className="flex items-center gap-2">
        <span className="inline-flex max-w-[180px] items-center gap-1 truncate whitespace-nowrap rounded-full bg-[#97B3AE]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[#5e7d77]">
          <LocationPin />
          {data.locationLabel}
        </span>
        {data.isArchived && (
          <span className="inline-flex items-center rounded-full bg-[#D6CBBF]/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#6a6a6a]">
            Archived
          </span>
        )}
      </div>

      {/* Review card */}
      <div className="rounded-2xl border border-[#97B3AE]/15 bg-[#F0EEEA]/60 p-4">
        <div className="text-lg tracking-wider text-[#97B3AE]" aria-hidden="true">
          {formatStars(review.starRating)}
        </div>
        <span className="sr-only">{review.starRating} out of 5 stars</span>
        <p className="mt-1 text-sm font-semibold text-[#2a2a2a]">
          {review.reviewerName} &middot; {formatDate(review.reviewDate)}
        </p>
        {review.reviewText ? (
          <p className="mt-2 text-sm leading-relaxed text-[#6a6a6a]">
            {review.reviewText}
          </p>
        ) : (
          <p className="mt-2 text-sm italic text-[#6a6a6a]/70">
            Rating only, no written review
          </p>
        )}
      </div>

      {/* Response */}
      <div className="rounded-2xl border border-[#97B3AE]/30 bg-white p-4">
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-[#97B3AE]/30 bg-[#D2E0D3]/40 px-3 py-2 text-xs leading-relaxed text-[#6a6a6a]">
          <svg
            className="mt-0.5 size-3.5 flex-shrink-0 text-[#97B3AE]"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" d="M12 8h.01M11 12h1v4h1" />
          </svg>
          <span>{AI_DRAFT_DISCLOSURE}</span>
        </div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#97B3AE]">
          Draft response (v{response.version})
        </p>
        {isEditing ? (
          <div>
            <label
              htmlFor="approval-edit"
              className="mb-1 block text-xs font-medium text-[#2a2a2a]"
            >
              Edit your response
            </label>
            <textarea
              id="approval-edit"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              className="w-full rounded-lg border border-[#97B3AE]/30 p-3 text-sm leading-relaxed text-[#2a2a2a] focus:border-[#97B3AE] focus:outline-none focus:ring-2 focus:ring-[#97B3AE]/30"
              rows={5}
            />
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-[#2a2a2a]">
            {response.responseText}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {isEditing ? (
          <>
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleAction('edit')}
              disabled={actionLoading || editedText.trim().length === 0}
              className={PRIMARY_BTN}
            >
              {actionLoading ? 'Saving…' : 'Save & Approve'}
            </m.button>
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                setIsEditing(false);
                setEditedText(response.responseText);
              }}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              Cancel
            </m.button>
          </>
        ) : (
          <>
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleAction('approve')}
              disabled={actionLoading}
              className={PRIMARY_BTN}
            >
              {actionLoading ? 'Approving…' : 'Approve'}
            </m.button>
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setIsEditing(true)}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              Edit
            </m.button>
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleAction('regenerate')}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              {actionLoading ? 'Requesting…' : 'Regenerate'}
            </m.button>
          </>
        )}
      </div>

      <p className="text-center text-xs italic text-[#97B3AE]">
        This link expires in {hoursLeft} hour{hoursLeft !== 1 ? 's' : ''}
      </p>
      </div>
    </LazyMotion>
  );
}
