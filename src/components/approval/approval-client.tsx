'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { LazyMotion, domAnimation, m } from 'motion/react';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { formatScheduledPostTime } from '@/lib/notifications/channels/scheduled-post-time';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { ApprovalErrorState } from './ApprovalErrorState';

// Client mirror of the server's authoritative edit cap
// (`MAX_EDIT_LENGTH` in app/api/approve/[token]/edit/validation.ts). The route
// rejects anything longer, so this is purely a UX guard (textarea maxLength +
// counter); the server validation is the real contract. Lint forbids importing
// from app/** into components, so the value is restated here, not imported.
const MAX_EDIT_LENGTH = 2000;

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
    // Scheduled-auto-post surface (WS4 §2.6): an 'approved' + 'auto_policy'
    // response with a future autoPostScheduledAt renders the veto state.
    approvalMethod?: string | null;
    autoPostScheduledAt?: string | null;
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
// A snapshot of the publishing action the owner is one tap away from confirming.
// Captured when the first tap arms the confirm step so the second tap posts
// exactly what was shown — even if `editedText` were to change in between.
interface PendingPublish {
  action: Extract<ApprovalAction, 'approve' | 'edit'>;
  editedText: string;
}

interface State {
  loading: boolean;
  data: ReviewData | null;
  error: string | null;
  editedText: string;
  isEditing: boolean;
  actionLoading: boolean;
  successMessage: string | null;
  successAction: ApprovalAction | null;
  // Non-null only while a publishing action is armed and awaiting its second
  // (confirm) tap. Posting to a public Google profile is irreversible, so both
  // "Approve" and "Save & Approve" gate behind this two-step confirm.
  pendingPublish: PendingPublish | null;
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
  pendingPublish: null,
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
  // Arms the two-step confirm for a publishing action (snapshots what will post).
  | { type: 'publishArmed'; pending: PendingPublish }
  // Backs out of the armed confirm without posting.
  | { type: 'publishCancelled' }
  | { type: 'actionStarted' }
  | { type: 'actionSucceeded'; action: ApprovalAction; message: string }
  | { type: 'actionFailed'; message: string };

// Flat one-case-per-action switch; cyclomatic count is the action vocabulary,
// not tangled logic. (Justification kept off the directive line so fallow does
// not parse the prose as bogus issue kinds.)
// fallow-ignore-next-line complexity
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
        pendingPublish: null,
      };
    case 'publishArmed':
      return { ...state, pendingPublish: action.pending, error: null };
    case 'publishCancelled':
      return { ...state, pendingPublish: null };
    case 'actionStarted':
      return { ...state, actionLoading: true, error: null };
    case 'actionSucceeded':
      return {
        ...state,
        actionLoading: false,
        successAction: action.action,
        successMessage: action.message,
        pendingPublish: null,
      };
    case 'actionFailed':
      return { ...state, actionLoading: false, error: action.message, pendingPublish: null };
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

// Maps an HTTP failure to copy a logged-out small-business owner can act on.
// The raw `json.error`/`HTTP <status>` strings (and "Session binding failed")
// leak server internals and never tell the owner what to do next — so we map by
// status family and only fall back to the server message for the unmapped 4xx
// "bad request" case (e.g. validation), never for a bare 5xx.
function friendlyErrorForStatus(status: number, serverMessage?: string): string {
  if (status === 401 || status === 403) {
    return 'There is a problem with this link or your session. Open the most recent link from your email and try again.';
  }
  if (status === 409) {
    return 'This draft has changed since the page loaded. Refresh to see the latest version before approving.';
  }
  if (status === 410) {
    return 'This link has already been used or has expired. Check your email for a newer one.';
  }
  if (status === 429) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (status >= 500) {
    return 'Something went wrong on our end. Please try again shortly.';
  }
  // Other 4xx (e.g. 400 validation): the server message is owner-safe and
  // specific; fall back to it, then to a neutral default.
  return serverMessage?.trim() || 'Something went wrong. Please try again.';
}

// Human expiry copy. Rounding to whole hours rendered "0 hours" for any link
// with <30 min left — alarming and wrong. Under an hour, fall back to minutes
// (or "less than a minute" / "less than an hour") so the count never reads zero.
function formatExpiry(msLeft: number): string {
  if (msLeft <= 0) return 'less than a minute';
  const totalMinutes = Math.floor(msLeft / 60_000);
  if (totalMinutes < 60) {
    if (totalMinutes < 1) return 'less than a minute';
    if (totalMinutes < 30) {
      return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
    }
    return 'less than an hour';
  }
  const hours = Math.round(msLeft / 3_600_000);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
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
  'flex-1 rounded-full bg-rw-teal-strong px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-rw-teal-strong/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
const GHOST_BTN =
  'flex-1 rounded-full border border-rw-teal-strong/40 bg-white px-4 py-3 text-sm font-semibold text-rw-teal-strong transition hover:bg-rw-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
// The armed confirm step darkens further so the irreversible second tap reads
// as a deliberate, distinct action — white label stays AA on the darker fill.
const CONFIRM_BTN =
  'flex-1 rounded-full bg-rw-teal-darkest px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-rw-teal-darkest/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-darkest focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
// Destructive fill for the single cancel-auto-post action. Full-width (not
// flex-1) — it is the only button in its view, never part of a button row.
const DESTRUCTIVE_BTN =
  'w-full rounded-full bg-rw-red-600 px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-rw-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-red-600 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="size-8 animate-spin rounded-full border-4 border-rw-teal-strong border-t-transparent" />
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
  // A regenerate doesn't publish; only approve/edit start a Google post. Keep
  // the reassurance line publish-specific so it stays truthful.
  const isPublish = successAction === 'approve' || successAction === 'edit';
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
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-rw-teal-strong/15">
          <svg
            className="size-7 text-rw-teal-strong"
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
        <h2 className="text-xl font-medium text-rw-ink">{heading}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-rw-ink-soft">
          {successMessage}
        </p>
        {/* Primary affordance is a confirmation, NOT a dashboard link: most
            recipients are logged out, so /dashboard would hit a login wall. */}
        {isPublish && (
          <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-rw-teal-strong">
            You can safely close this page now.
          </p>
        )}
        {/* Dashboard is demoted to a quiet secondary link for signed-in owners. */}
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-sm text-xs font-semibold text-rw-teal-strong underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2"
        >
          Manage reviews in your dashboard →
        </Link>
      </m.div>
    </LazyMotion>
  );
}

// Quiet secondary dashboard link shared by the terminal veto/posted states —
// same demoted treatment as SuccessView (most recipients are logged out).
function QuietDashboardLink() {
  return (
    <Link
      href="/dashboard"
      className="mt-6 inline-block rounded-sm text-xs font-semibold text-rw-teal-strong underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rw-teal-strong focus-visible:ring-offset-2"
    >
      Manage reviews in your dashboard →
    </Link>
  );
}

function CheckIcon() {
  return (
    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-rw-teal-strong/15">
      <svg
        className="size-7 text-rw-teal-strong"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2.5}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    </div>
  );
}

// Terminal state for a response that already reached Google. Without this
// branch a posted response's link fell through to the actionable-looking
// approve UI, whose actions could only 409.
function PostedNoticeView() {
  return (
    <div role="status" className="text-center">
      <CheckIcon />
      <h2 className="text-xl font-medium text-rw-ink">
        This reply has already been posted
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-rw-ink-soft">
        The response is live on your public Google profile. No action is
        needed — you can safely close this page.
      </p>
      <QuietDashboardLink />
    </div>
  );
}

// Confirmation after a successful cancel — also shown for 'already_cancelled'
// (a double-tap is a success, not an error).
function VetoCancelledView() {
  return (
    <div role="status" aria-live="polite" className="text-center">
      <CheckIcon />
      <h2 className="text-xl font-medium text-rw-ink">Auto-post cancelled</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-rw-ink-soft">
        Cancelled — the draft is back in your approval queue; we&apos;ve sent
        you a fresh approval link. Nothing posts unless you approve it.
      </p>
      <QuietDashboardLink />
    </div>
  );
}

// The cancel window closed before (or while) the owner acted. Deliberately
// non-committal: a too-late veto can mean the reply posted / is posting
// momentarily, OR that the draft went back to the queue by another path
// (e.g. the auto-approval kill switch) — this page cannot tell which.
function VetoWindowClosedView() {
  return (
    <div role="status" className="text-center">
      <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-rw-teal-strong/12">
        <svg
          className="size-7 text-rw-teal-strong"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path strokeLinecap="round" d="M12 7v5l3 3" />
        </svg>
      </div>
      <h2 className="text-xl font-medium text-rw-ink">
        This link can no longer cancel the post
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-rw-ink-soft">
        The cancel window has closed — the reply may already be posted or
        posting momentarily, or the draft may have returned to your approval
        queue another way. Check your dashboard for the current status.
      </p>
      <QuietDashboardLink />
    </div>
  );
}

type VetoPhase = 'idle' | 'busy' | 'cancelled' | 'too_late';

// Scheduled-auto-post surface (WS4 §2.6): read-only draft + the posting time
// + ONE destructive cancel action POSTing to the veto route. Self-contained
// useState machine — deliberately NOT merged into the pending-approval
// reducer, whose edit/arm/confirm vocabulary does not apply here.
function ScheduledAutoPostView({
  token,
  data,
  scheduledAt,
  nowMs,
  loadError,
}: {
  token: string;
  data: ReviewData;
  scheduledAt: string;
  nowMs: number;
  loadError: string | null;
}) {
  const [phase, setPhase] = useState<VetoPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  if (phase === 'cancelled') return <VetoCancelledView />;
  // Window already over when the page loaded, or the server said too late.
  if (phase === 'too_late' || new Date(scheduledAt).getTime() <= nowMs) {
    return <VetoWindowClosedView />;
  }

  const busy = phase === 'busy';
  const { phrase } = formatScheduledPostTime(new Date(scheduledAt), new Date(nowMs));

  const handleCancel = async () => {
    if (busy) return;
    setPhase('busy');
    setError(null);
    try {
      const res = await fetch(`/api/approve/${token}/veto`, {
        method: 'POST',
        headers: { 'x-csrf-token': getCsrfToken() },
      });
      const json: { result?: string; error?: string } = await res
        .json()
        .catch(() => ({}));
      // 'already_cancelled' is a success: someone (or an earlier tap) already
      // returned the draft to the queue — show the same confirmation.
      if (res.ok && (json.result === 'cancelled' || json.result === 'already_cancelled')) {
        setPhase('cancelled');
        return;
      }
      if (res.status === 409 && json.result === 'too_late') {
        setPhase('too_late');
        return;
      }
      setError(friendlyErrorForStatus(res.status, json.error));
      setPhase('idle');
    } catch {
      setError('Something went wrong on our end. Please try again shortly.');
      setPhase('idle');
    }
  };

  return (
    <LazyMotion features={domAnimation}>
      <div className="space-y-4">
        <div className="sr-only" role="status" aria-live="polite">
          {busy ? 'Cancelling the scheduled post…' : ''}
        </div>

        {(error ?? loadError) && (
          <div
            role="alert"
            className="rounded-xl border border-rw-red-600/30 bg-rw-red-600/5 p-3 text-sm text-rw-red-700"
          >
            {error ?? loadError}
          </div>
        )}

        <LocationChip
          locationLabel={data.locationLabel}
          isArchived={data.isArchived}
        />

        <ReviewCard review={data.review} />

        <ResponseCard
          response={data.response}
          isEditing={false}
          editedText=""
          onEditTextChange={() => {}}
        />

        <div className="rounded-xl border border-rw-teal/40 bg-rw-teal/10 p-3 text-center text-sm leading-relaxed text-rw-teal-darkest">
          Posting automatically at {phrase}. If you&apos;re happy with this
          reply, no action is needed.
        </div>

        <m.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => void handleCancel()}
          disabled={busy}
          aria-busy={busy}
          className={DESTRUCTIVE_BTN}
        >
          {busy ? 'Cancelling…' : 'Cancel auto-post'}
        </m.button>
        <p className="text-center text-xs leading-relaxed text-rw-teal-strong">
          Cancelling returns the draft to your approval queue — nothing posts
          until you approve it yourself.
        </p>
      </div>
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
      <span className="inline-flex max-w-[180px] items-center gap-1 truncate whitespace-nowrap rounded-full bg-rw-teal/15 px-2.5 py-0.5 text-[11px] font-semibold text-rw-sage-text">
        <LocationPin />
        {locationLabel}
      </span>
      {isArchived && (
        <span className="inline-flex items-center rounded-full bg-rw-beige/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rw-ink-soft">
          Archived
        </span>
      )}
    </div>
  );
}

function ReviewCard({ review }: { review: ReviewData['review'] }) {
  return (
    <div className="rounded-2xl border border-rw-teal/15 bg-rw-cream/60 p-4">
      <div className="text-lg tracking-wider text-rw-teal" aria-hidden="true">
        {formatStars(review.starRating)}
      </div>
      <span className="sr-only">{review.starRating} out of 5 stars</span>
      <p className="mt-1 text-sm font-semibold text-rw-ink">
        {review.reviewerName} &middot; {formatDate(review.reviewDate)}
      </p>
      {review.reviewText ? (
        <p className="mt-2 text-sm leading-relaxed text-rw-ink-soft">
          {review.reviewText}
        </p>
      ) : (
        <p className="mt-2 text-sm italic text-rw-ink-soft/70">
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
  editLocked = false,
  onEditTextChange,
}: {
  response: ReviewData['response'];
  isEditing: boolean;
  editedText: string;
  // Once an edit-publish is armed, lock the textarea so what's shown is exactly
  // what gets posted (the confirm posts the arm-time snapshot).
  editLocked?: boolean;
  onEditTextChange: (value: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-rw-teal/30 bg-white p-4">
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-rw-teal/30 bg-rw-sage/40 px-3 py-2 text-xs leading-relaxed text-rw-ink-soft">
        <svg
          className="mt-0.5 size-3.5 flex-shrink-0 text-rw-teal-strong"
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
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-rw-teal-strong">
        Draft response (v{response.version})
      </p>
      {isEditing ? (
        <div>
          <label
            htmlFor="approval-edit"
            className="mb-1 block text-xs font-medium text-rw-ink"
          >
            Edit your response
          </label>
          <textarea
            id="approval-edit"
            value={editedText}
            onChange={(e) => onEditTextChange(e.target.value)}
            readOnly={editLocked}
            aria-describedby={editLocked ? 'approval-edit-locked' : undefined}
            maxLength={MAX_EDIT_LENGTH}
            className={`w-full rounded-lg border border-rw-teal-strong/40 p-3 text-sm leading-relaxed text-rw-ink focus:border-rw-teal-strong focus:outline-none focus:ring-2 focus:ring-rw-teal-strong/30 ${editLocked ? 'cursor-not-allowed bg-rw-cream/60' : ''}`}
            rows={5}
          />
          {editLocked && (
            <p id="approval-edit-locked" className="mt-1 text-[11px] text-rw-teal-strong">
              Locked while confirming — tap “Cancel” to keep editing.
            </p>
          )}
          <p className="mt-1 text-right text-[11px] text-rw-teal-strong" aria-hidden="true">
            {editedText.length} / {MAX_EDIT_LENGTH}
          </p>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-rw-ink">
          {response.responseText}
        </p>
      )}
    </div>
  );
}

// The publishing pill that gates behind a two-step confirm. First tap arms
// (label morphs to "Tap again to post to Google"); second tap posts. Posting to
// a public Google profile is irreversible, so this guard wraps BOTH "Approve"
// and "Save & Approve".
function PublishButton({
  action,
  editedText,
  armed,
  actionLoading,
  disabled,
  onArm,
  onConfirm,
}: {
  action: Extract<ApprovalAction, 'approve' | 'edit'>;
  editedText: string;
  armed: boolean;
  actionLoading: boolean;
  disabled: boolean;
  onArm: (pending: PendingPublish) => void;
  onConfirm: () => void;
}) {
  const restingLabel =
    action === 'edit' ? 'Save & post to Google' : 'Approve & post to Google';
  const loadingLabel = action === 'edit' ? 'Saving…' : 'Approving…';

  if (actionLoading) {
    return (
      <m.button disabled aria-busy="true" className={PRIMARY_BTN}>
        {loadingLabel}
      </m.button>
    );
  }

  if (armed) {
    return (
      <m.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={onConfirm}
        disabled={disabled}
        aria-busy="false"
        className={CONFIRM_BTN}
      >
        Tap again to post to Google
      </m.button>
    );
  }

  return (
    <m.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onArm({ action, editedText })}
      disabled={disabled}
      aria-busy="false"
      className={PRIMARY_BTN}
    >
      {restingLabel}
    </m.button>
  );
}

// Render-only: branches are independent UI states (edit / confirm-publish /
// resting / loading), not tangled logic.
// fallow-ignore-next-line complexity
function ActionBar({
  isEditing,
  editedText,
  actionLoading,
  isArchived,
  pendingPublish,
  onAction,
  onArmPublish,
  onConfirmPublish,
  onCancelPublish,
  onStartEdit,
  onCancelEdit,
}: {
  isEditing: boolean;
  editedText: string;
  actionLoading: boolean;
  isArchived: boolean;
  pendingPublish: PendingPublish | null;
  onAction: (action: ApprovalAction) => void;
  onArmPublish: (pending: PendingPublish) => void;
  onConfirmPublish: () => void;
  onCancelPublish: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
}) {
  if (isArchived) {
    // Server rejects every mutating action for archived locations (409) —
    // don't render buttons that can only fail on submit.
    return (
      <p className="rounded-xl border border-rw-teal/40 bg-rw-teal/10 p-3 text-center text-sm text-rw-teal-darkest">
        This location has been archived — approval actions are no longer
        available for this draft.
      </p>
    );
  }

  const publishAction: Extract<ApprovalAction, 'approve' | 'edit'> = isEditing
    ? 'edit'
    : 'approve';
  const armed = pendingPublish?.action === publishAction;
  const publishDisabled =
    actionLoading || (isEditing && editedText.trim().length === 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        {isEditing ? (
          <>
            <PublishButton
              action="edit"
              editedText={editedText}
              armed={armed}
              actionLoading={actionLoading}
              disabled={publishDisabled}
              onArm={onArmPublish}
              onConfirm={onConfirmPublish}
            />
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={armed ? onCancelPublish : onCancelEdit}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              Cancel
            </m.button>
          </>
        ) : (
          <>
            <PublishButton
              action="approve"
              editedText={editedText}
              armed={armed}
              actionLoading={actionLoading}
              disabled={publishDisabled}
              onArm={onArmPublish}
              onConfirm={onConfirmPublish}
            />
            <m.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={armed ? onCancelPublish : onStartEdit}
              disabled={actionLoading}
              className={GHOST_BTN}
            >
              {armed ? 'Cancel' : 'Edit'}
            </m.button>
            {!armed && (
              <m.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onAction('regenerate')}
                disabled={actionLoading}
                aria-busy={actionLoading}
                className={GHOST_BTN}
              >
                {actionLoading ? 'Requesting…' : 'Regenerate'}
              </m.button>
            )}
          </>
        )}
      </div>
      {armed ? (
        <p className="text-center text-xs leading-relaxed text-rw-teal-strong">
          This posts your reply to your public Google profile. Tap the button
          again to confirm.
        </p>
      ) : (
        <p className="text-center text-xs leading-relaxed text-rw-teal-strong">
          Close this page — nothing posts unless you approve.
        </p>
      )}
    </div>
  );
}

// Top-level approval screen: branches are independent UI states (loading /
// error island / success / edit / confirm-publish), not tangled logic.
// fallow-ignore-next-line complexity
export default function ApprovalClient({ token }: { token: string }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const {
    loading,
    data,
    error,
    editedText,
    isEditing,
    actionLoading,
    successMessage,
    successAction,
    pendingPublish,
  } = state;

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
          // Map the raw server status to owner-friendly copy — never surface
          // "HTTP 500" or a leaked internal error string.
          throw new Error(friendlyErrorForStatus(res.status, body.error));
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
          // "Session binding failed" is an internal phrase — map by status too.
          throw new Error(friendlyErrorForStatus(sessionRes.status, sessionBody.error));
        }
      } catch (err) {
        if (cancelled) return;
        dispatch({
          type: 'loadFailed',
          message:
            err instanceof Error
              ? err.message
              : 'Something went wrong. Please try again shortly.',
        });
      } finally {
        if (!cancelled) dispatch({ type: 'loadSettled' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // `editTextOverride` lets the confirm step post the exact text snapshotted
  // when the action was armed, not whatever `editedText` is at confirm time.
  const handleAction = useCallback(
    async (action: ApprovalAction, editTextOverride?: string) => {
      if (actionLockRef.current) return;
      actionLockRef.current = true;
      dispatch({ type: 'actionStarted' });

      try {
        const csrf = getCsrfToken();
        const url = `/api/approve/${token}/${action}`;
        const body =
          action === 'edit'
            ? JSON.stringify({ editedText: editTextOverride ?? editedText })
            : undefined;

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
          // Map status → owner-friendly copy; never surface "HTTP 500".
          throw new Error(friendlyErrorForStatus(res.status, json.error));
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

  const handleConfirmPublish = useCallback(() => {
    if (!pendingPublish) return;
    void handleAction(pendingPublish.action, pendingPublish.editedText);
  }, [handleAction, pendingPublish]);

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

  // Terminal: the reply already reached Google — never render actionable UI.
  if (data.response.status === 'posted') {
    return <PostedNoticeView />;
  }

  // Scheduled auto-post (WS4 §2.6): approved by policy, not yet published —
  // the only action is the veto. A missing scheduled time in this state means
  // the window bookkeeping is gone (legacy/edge row) — treat as closed.
  if (
    data.response.status === 'approved' &&
    data.response.approvalMethod === APPROVAL_METHOD.AUTO_POLICY
  ) {
    const scheduledAt = data.response.autoPostScheduledAt;
    if (!scheduledAt) return <VetoWindowClosedView />;
    return (
      <ScheduledAutoPostView
        token={token}
        data={data}
        scheduledAt={scheduledAt}
        nowMs={nowMs}
        loadError={error}
      />
    );
  }

  const { review, response } = data;
  const timeLeft = new Date(data.expiresAt).getTime() - nowMs;
  const expiryLabel = formatExpiry(timeLeft);
  // Drives the polite status region while an action is in flight — screen
  // readers announce "Approving…/Saving…" without moving focus.
  const busyLabel = actionLoading
    ? isEditing
      ? 'Saving your response…'
      : 'Approving your response…'
    : '';

  return (
    <LazyMotion features={domAnimation}>
      <div className="space-y-4">
        {/* Polite live region: announces in-flight progress for assistive tech. */}
        <div className="sr-only" role="status" aria-live="polite">
          {busyLabel}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rw-red-600/30 bg-rw-red-600/5 p-3 text-sm text-rw-red-700"
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
          editLocked={pendingPublish?.action === 'edit'}
          onEditTextChange={(value) =>
            dispatch({ type: 'editTextChanged', value })
          }
        />

        <ActionBar
          isEditing={isEditing}
          editedText={editedText}
          actionLoading={actionLoading}
          isArchived={data.isArchived}
          pendingPublish={pendingPublish}
          onAction={handleAction}
          onArmPublish={(pending) =>
            dispatch({ type: 'publishArmed', pending })
          }
          onConfirmPublish={handleConfirmPublish}
          onCancelPublish={() => dispatch({ type: 'publishCancelled' })}
          onStartEdit={() => dispatch({ type: 'editStarted' })}
          onCancelEdit={() => dispatch({ type: 'editCancelled' })}
        />

        <p className="text-center text-xs italic text-rw-teal-strong">
          This link expires in {expiryLabel}
        </p>
      </div>
    </LazyMotion>
  );
}
