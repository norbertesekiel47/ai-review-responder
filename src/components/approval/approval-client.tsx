'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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

// Loaded review data + every piece of UI state that the load, the inline edit
// flow, and the action lifecycle all read or mutate. Kept in one reducer so the
// "inline alert vs full error island" branch (error set while data is still
// present) and the success view stay a single coherent transition.
interface State {
  loading: boolean;
  data: ReviewData | null;
  error: string | null;
  editedText: string;
  isEditing: boolean;
  actionLoading: boolean;
  successMessage: string | null;
  successAction: ApprovalAction | null;
}

const initialState: State = {
  loading: true,
  data: null,
  error: null,
  editedText: '',
  isEditing: false,
  actionLoading: false,
  successMessage: null,
  successAction: null,
};

type Action =
  // Emitted from the load effect the instant the review GET resolves — BEFORE
  // the session-bind POST. This is what keeps `data` set even if the bind then
  // fails, driving the inline-alert (not full-island) branch.
  | { type: 'loadSucceeded'; data: ReviewData }
  // Load failed (review GET or session bind). The reducer only records the
  // message; whether `data` is present decides the render branch.
  | { type: 'loadFailed'; message: string }
  // GET + bind handshake has settled (success or failure). Drops the spinner.
  | { type: 'loadSettled' }
  | { type: 'editTextChanged'; value: string }
  | { type: 'editStarted' }
  | { type: 'editCancelled' }
  | { type: 'actionStarted' }
  | { type: 'actionSucceeded'; action: ApprovalAction; message: string }
  | { type: 'actionFailed'; message: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loadSucceeded':
      return {
        ...state,
        data: action.data,
        editedText: action.data.response.responseText,
      };
    case 'loadFailed':
      return { ...state, error: action.message };
    case 'loadSettled':
      return { ...state, loading: false };
    case 'editTextChanged':
      return { ...state, editedText: action.value };
    case 'editStarted':
      return { ...state, isEditing: true };
    case 'editCancelled':
      return {
        ...state,
        isEditing: false,
        editedText: state.data?.response.responseText ?? state.editedText,
      };
    case 'actionStarted':
      return { ...state, actionLoading: true, error: null };
    case 'actionSucceeded':
      return {
        ...state,
        actionLoading: false,
        successAction: action.action,
        successMessage: action.message,
      };
    case 'actionFailed':
      return { ...state, actionLoading: false, error: action.message };
    default:
      return state;
  }
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

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="size-8 animate-spin rounded-full border-4 border-[#97B3AE] border-t-transparent" />
    </div>
  );
}

function SuccessView({
  successAction,
  successMessage,
}: {
  successAction: ApprovalAction | null;
  successMessage: string;
}) {
  const heading =
    successAction === 'regenerate' ? 'New draft on the way' : 'Response approved!';
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

function LocationChip({
  locationLabel,
  isArchived,
}: {
  locationLabel: string;
  isArchived: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex max-w-[180px] items-center gap-1 truncate whitespace-nowrap rounded-full bg-[#97B3AE]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[#5e7d77]">
        <LocationPin />
        {locationLabel}
      </span>
      {isArchived && (
        <span className="inline-flex items-center rounded-full bg-[#D6CBBF]/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#6a6a6a]">
          Archived
        </span>
      )}
    </div>
  );
}

function ReviewCard({ review }: { review: ReviewData['review'] }) {
  return (
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
  );
}

function ResponseCard({
  response,
  isEditing,
  editedText,
  onEditTextChange,
}: {
  response: ReviewData['response'];
  isEditing: boolean;
  editedText: string;
  onEditTextChange: (value: string) => void;
}) {
  return (
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
            onChange={(e) => onEditTextChange(e.target.value)}
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
  );
}

function ActionBar({
  isEditing,
  editedText,
  actionLoading,
  isArchived,
  onAction,
  onStartEdit,
  onCancelEdit,
}: {
  isEditing: boolean;
  editedText: string;
  actionLoading: boolean;
  isArchived: boolean;
  onAction: (action: ApprovalAction) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
}) {
  if (isArchived) {
    // Server rejects every mutating action for archived locations (409) —
    // don't render buttons that can only fail on submit.
    return (
      <p className="rounded-xl border border-[#97B3AE]/40 bg-[#97B3AE]/10 p-3 text-center text-sm text-[#5B7470]">
        This location has been archived — approval actions are no longer
        available for this draft.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      {isEditing ? (
        <>
          <m.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onAction('edit')}
            disabled={actionLoading || editedText.trim().length === 0}
            className={PRIMARY_BTN}
          >
            {actionLoading ? 'Saving…' : 'Save & Approve'}
          </m.button>
          <m.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onCancelEdit}
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
            onClick={() => onAction('approve')}
            disabled={actionLoading}
            className={PRIMARY_BTN}
          >
            {actionLoading ? 'Approving…' : 'Approve'}
          </m.button>
          <m.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onStartEdit}
            disabled={actionLoading}
            className={GHOST_BTN}
          >
            Edit
          </m.button>
          <m.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onAction('regenerate')}
            disabled={actionLoading}
            className={GHOST_BTN}
          >
            {actionLoading ? 'Requesting…' : 'Regenerate'}
          </m.button>
        </>
      )}
    </div>
  );
}

export default function ApprovalClient({ token }: { token: string }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { loading, data, error, editedText, isEditing, actionLoading, successMessage, successAction } =
    state;

  // Snapshot "now" once at mount so the hoursLeft display below is a pure render
  // (Date.now() during render is impure). The approval page is short-lived, so a
  // mount snapshot is the correct semantic: "hours left when you opened the link".
  const [nowMs] = useState(() => Date.now());

  // Guard against same-tick double-click: dispatching actionStarted queues a
  // re-render, so between the first click and the button becoming disabled a
  // second click can fire. The ref reads synchronously and closes that gap.
  const actionLockRef = useRef(false);

  // One-time mount load: a cacheable GET (review data) followed by a one-shot,
  // side-effecting POST (device-session bind). Both must succeed before the
  // review renders — the bound device is a security precondition. This runs
  // exactly once per mount (deps `[token]`); the `cancelled` guard suppresses
  // any state dispatch if the component unmounts mid-flight.
  //
  // `loadSucceeded` fires the moment the review GET resolves, so `data` stays
  // set even if the subsequent bind throws — that drives the inline-alert (not
  // full-island) branch. A GET failure leaves `data` null → full error island.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/approve/${token}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json: ReviewData = await res.json();
        if (cancelled) return;
        dispatch({ type: 'loadSucceeded', data: json });

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
        if (cancelled) return;
        dispatch({
          type: 'loadFailed',
          message: err instanceof Error ? err.message : 'Failed to load',
        });
      } finally {
        if (!cancelled) dispatch({ type: 'loadSettled' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAction = useCallback(
    async (action: ApprovalAction) => {
      if (actionLockRef.current) return;
      actionLockRef.current = true;
      dispatch({ type: 'actionStarted' });

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

        // Treat empty/whitespace messages as missing — the success view gates on
        // successMessage truthiness, and `??` would let '' through and render nothing.
        dispatch({
          type: 'actionSucceeded',
          action,
          message: json.message?.trim()
            ? json.message
            : 'Your request has been processed.',
        });
      } catch (err) {
        dispatch({
          type: 'actionFailed',
          message: err instanceof Error ? err.message : 'Action failed',
        });
      } finally {
        actionLockRef.current = false;
      }
    },
    [token, editedText],
  );

  if (loading) {
    return <LoadingSpinner />;
  }

  if (successMessage) {
    return (
      <SuccessView successAction={successAction} successMessage={successMessage} />
    );
  }

  if (error && !data) {
    return <ApprovalErrorState message={error} />;
  }

  if (!data) return null;

  const { review, response } = data;
  const timeLeft = new Date(data.expiresAt).getTime() - nowMs;
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
        <LocationChip
          locationLabel={data.locationLabel}
          isArchived={data.isArchived}
        />

        <ReviewCard review={review} />

        <ResponseCard
          response={response}
          isEditing={isEditing}
          editedText={editedText}
          onEditTextChange={(value) =>
            dispatch({ type: 'editTextChanged', value })
          }
        />

        <ActionBar
          isEditing={isEditing}
          editedText={editedText}
          actionLoading={actionLoading}
          isArchived={data.isArchived}
          onAction={handleAction}
          onStartEdit={() => dispatch({ type: 'editStarted' })}
          onCancelEdit={() => dispatch({ type: 'editCancelled' })}
        />

        <p className="text-center text-xs italic text-[#97B3AE]">
          This link expires in {hoursLeft} hour{hoursLeft !== 1 ? 's' : ''}
        </p>
      </div>
    </LazyMotion>
  );
}
