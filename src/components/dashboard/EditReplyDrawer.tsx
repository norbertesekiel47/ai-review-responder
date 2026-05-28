// src/components/dashboard/EditReplyDrawer.tsx
//
// Right-side slide-out drawer that drives the 6-state edit-existing-reply
// flow from spec §5.2:
//
//   1. initial      — review snapshot + read-only Google reply + two CTAs
//   2. editing      — manual textarea + char count + Update / Cancel
//   3. regenerating — polling /draft-status every 1500ms (60s ceiling)
//   4. preview      — AI draft visible + Update on Google / Edit further
//   5. publishing   — submitted /publish; close on success
//   6. recovery     — for failed rows; Retry posting / Restore original
//
// The drawer captures `{ hash: row.review_content_hash, version }` at open
// time and sends it on every mutating call. Any 409 surfaces a "review was
// updated by the customer" prompt with a Refresh button.
//
// API contract (server returns these shapes — see the route comments in
// src/app/api/dashboard/past-replies/*):
//   POST   /api/dashboard/past-replies/draft       → { response_id } | { outbox_id }
//   PATCH  /api/dashboard/past-replies/draft/:id   → 204
//   DELETE /api/dashboard/past-replies/draft/:id   → 204
//   POST   /api/dashboard/past-replies/publish     → { outbox_id }
//   GET    /api/dashboard/past-replies/draft-status?outbox_id=...
//          → { status: 'generating' } | { status: 'failed', error } |
//            { response_id, status, response_text }
//   POST   /api/dashboard/past-replies/:id/retry              → { outbox_id }
//   POST   /api/dashboard/past-replies/:id/restore-original   → { response_id, outbox_id }
//          (terminal: republishes the original directly; drawer shows success)

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/PastReplyCard';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { useEditReplyDraft } from '@/components/dashboard/edit-reply/useEditReplyDraft';

const MAX_REPLY_CHARS = 2000;

interface EditReplyDrawerProps {
  open: boolean;
  onClose: () => void;
  row: PastReplyRow;
  canEdit: boolean;
  // When set, the drawer opens directly into the recovery state for the
  // given failed response id (Retry / Restore CTAs visible immediately).
  // Used by PastReplyCard when the row carries a recoverable failed
  // sibling. See Code Review fix Critical 1 (2026-05-02).
  //
  // failedPostingError discriminates which CTAs are appropriate:
  //   - 'delete_failed_*' (sibling still alive)   → Retry only.
  //   - 'post_after_delete_failed_*' (orphan)     → Retry + Restore.
  // /restore-original returns 409 'not_in_orphan_state' for delete_failed_*,
  // so showing the button on that branch would always 409. Hiding it is
  // the right UX. See Code Review fix Round-2 M2.
  initialFailureRecovery?: {
    failedResponseId: string;
    failedPostingError: string | null;
  } | null;
}

export function EditReplyDrawer({
  open,
  onClose,
  row,
  canEdit,
  initialFailureRecovery = null,
}: EditReplyDrawerProps) {
  const router = useRouter();
  const { state, isClosePending, tryClose, actions } = useEditReplyDraft({ row, initialFailureRecovery, onClose });

  // Esc to close. Only handled when the drawer is mounted. Uses a ref to the
  // current tryClose so the keydown binding doesn't re-attach on every state
  // transition; tryClose itself is defined below and references state.
  // Refs for focus management.
  // panelRef: the aside panel element used to scope focus-trap queries.
  // openerRef: the element that had focus when the drawer opened — restored on close.
  const panelRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const tryCloseRef = useRef<() => void>(onClose);

  // Focus management: capture opener, move focus in, trap Tab, restore on close.
  useEffect(() => {
    if (!open) return;

    // Capture the element that triggered the open BEFORE moving focus.
    openerRef.current = document.activeElement as HTMLElement | null;

    // Move focus into the panel.
    const panel = panelRef.current;
    if (panel) {
      const tabbableSelector =
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const firstTabbable = panel.querySelector<HTMLElement>(tabbableSelector);
      if (firstTabbable) {
        firstTabbable.focus();
      } else {
        panel.focus();
      }
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        tryCloseRef.current();
        return;
      }

      if (e.key === 'Tab' && panel) {
        const tabbableSelector =
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const tabbable = Array.from(panel.querySelectorAll<HTMLElement>(tabbableSelector));
        if (tabbable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = tabbable[0]!;
        const last = tabbable[tabbable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      // Restore focus to the element that opened the drawer.
      openerRef.current?.focus();
    };
  }, [open]);


  // Keep the Esc-handler ref in sync with the latest tryClose.
  useEffect(() => {
    tryCloseRef.current = tryClose;
  }, [tryClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-reply-drawer-title"
    >
      {/* Backdrop — uses tryClose to discard an in-flight draft before
          closing. See Code Review fix Medium 2 (2026-05-02). */}
      <button
        type="button"
        aria-label="Close drawer"
        className="flex-1 bg-black/30"
        onClick={tryClose}
      />

      {/* Panel */}
      <aside ref={panelRef} tabIndex={-1} className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
          <h2
            id="edit-reply-drawer-title"
            className="text-lg font-semibold text-[#2a2a2a]"
          >
            Edit reply
          </h2>
          <button
            type="button"
            onClick={tryClose}
            disabled={isClosePending}
            className="rounded-md px-2 py-1 text-sm text-[#6a6a6a] hover:bg-gray-50 hover:text-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            aria-label={
              isClosePending
                ? 'Close (disabled while draft is being created)'
                : 'Close'
            }
            title={
              state.kind === 'creating_draft'
                ? 'Wait — finishing your draft request…'
                : state.kind === 'regenerating'
                  ? 'Wait — generating your draft. This usually takes 5–15 seconds.'
                  : state.kind === 'regenerate_poll_error'
                    ? 'The worker is still running. Resume polling or wait — close is disabled while a draft may still arrive.'
                    : undefined
            }
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-5 px-6 py-5">
          {/* Review snapshot — always shown */}
          <section className="rounded-lg border border-gray-100 bg-[#F0EEEA]/40 p-3">
            <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
              Customer review
            </div>
            <div className="flex items-center gap-2">
              {row.star_rating != null && (
                <span className="text-sm text-yellow-500" aria-label={`${row.star_rating} stars`}>
                  {'★'.repeat(Math.round(row.star_rating))}
                  {'☆'.repeat(Math.max(0, 5 - Math.round(row.star_rating)))}
                </span>
              )}
              <span className="text-sm font-medium text-[#2a2a2a]">
                {row.reviewer_name ?? 'Anonymous'}
              </span>
            </div>
            <p className="mt-1 text-sm text-[#2a2a2a]">
              {row.review_text ?? <em className="text-[#6a6a6a]">No review text — rating only.</em>}
            </p>
          </section>

          {/* Current Google reply — always shown */}
          <section>
            <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
              Current Google reply
            </div>
            <p className="rounded-md bg-[#F0EEEA]/60 p-3 text-sm text-[#2a2a2a]">
              {(row.approved_text ?? '') || <em className="text-[#6a6a6a]">(empty)</em>}
            </p>
          </section>

          {/* State-specific UI */}
          {state.kind === 'initial' && canEdit && (
            <div className="space-y-3">
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {AI_DRAFT_DISCLOSURE}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={actions.startManualEdit}
                  className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
                >
                  Edit manually
                </button>
                <button
                  type="button"
                  onClick={actions.startRegenerate}
                  className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
                >
                  Regenerate with AI
                </button>
              </div>
            </div>
          )}

          {state.kind === 'editing' && (
            <ManualEditor
              initialText={state.text}
              onCancel={() => actions.cancelDraft(state.draftResponseId)}
              onSubmit={(text) => actions.submitManual(text, state.draftResponseId)}
            />
          )}

          {(state.kind === 'creating_draft' || state.kind === 'regenerating') && (
            <div className="rounded-lg border border-gray-100 bg-[#F0EEEA]/30 p-4 text-sm text-[#6a6a6a]">
              <div className="flex items-center gap-3">
                <Spinner />
                <span>Generating a fresh draft using your current brand voice…</span>
              </div>
            </div>
          )}

          {state.kind === 'regenerate_poll_error' && (
            // Polling failed transiently. Outbox + worker are still running;
            // close is blocked (Round-4 M). Resume polling re-enters
            // 'regenerating' with the same outboxId so the polling effect
            // reattaches and the 60s window restarts.
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-900">{state.message}</p>
              <p className="text-xs text-amber-800">
                Close is paused until the draft arrives or the worker reports failure — otherwise the
                draft would be created in the background and block your next attempt.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={actions.resumePolling}
                  className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
                >
                  Resume polling
                </button>
              </div>
            </div>
          )}

          {state.kind === 'preview' && (
            <PreviewPanel
              text={state.text}
              // Accept-as-is publishes the worker draft WITHOUT a PATCH so it
              // records as 'regenerate_as_is'. "Edit further" routes to the
              // editing state, whose submit PATCHes then publishes →
              // 'regenerate_edited'.
              onPublish={() => actions.publishExisting(state.draftResponseId)}
              onEditFurther={actions.editFurther}
              onCancel={() => actions.cancelDraft(state.draftResponseId)}
            />
          )}

          {state.kind === 'publishing' && (
            <div className="rounded-lg border border-gray-100 bg-[#F0EEEA]/30 p-4 text-sm text-[#6a6a6a]">
              <div className="flex items-center gap-3">
                <Spinner />
                <span>Posting to Google…</span>
              </div>
            </div>
          )}

          {state.kind === 'recovery' && (
            <RecoveryPanel
              onRetry={() => actions.retryPosting(state.failedResponseId)}
              onRestore={() => actions.restoreOriginal(state.failedResponseId)}
              // Restore is only valid for orphan-state failures
              // (post_after_delete_failed_*). For delete_failed_* the live
              // posted reply is still on Google — there's nothing to
              // restore. /restore-original would 409 not_in_orphan_state;
              // hide the button instead. See Round-2 M2.
              restoreAvailable={
                state.failedPostingError !== null &&
                state.failedPostingError.startsWith('post_after_delete_failed_')
              }
            />
          )}

          {state.kind === 'review_changed' && (
            <ReviewChangedPanel
              currentText={state.currentText}
              onRefresh={() => router.refresh()}
              onClose={onClose}
            />
          )}

          {state.kind === 'draft_conflict' && (
            <DraftConflictPanel
              draftText={state.existing.text}
              isEdited={state.existing.isEdited}
              status={state.existing.status}
              onResume={() => actions.resumeExistingDraft(state.existing)}
              onDiscard={() => actions.discardExistingDraft(state.existing.responseId)}
              onClose={onClose}
              onRefresh={() => router.refresh()}
            />
          )}

          {state.kind === 'error' && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm text-red-800">{state.message}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={actions.reset}
                  className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-3 py-1 text-xs font-medium text-[#6a6a6a] hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {state.kind === 'success' && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm text-green-800">{state.message}</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#97B3AE]/30 border-t-[#97B3AE]"
    />
  );
}

function ManualEditor({
  initialText,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const remaining = MAX_REPLY_CHARS - text.length;
  const overLimit = remaining < 0;

  return (
    <div className="space-y-2">
      <label
        htmlFor="reply-textarea"
        className="text-xs uppercase tracking-wider text-[#97B3AE]"
      >
        New reply
      </label>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {AI_DRAFT_DISCLOSURE}
      </div>
      <textarea
        id="reply-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_REPLY_CHARS}
        rows={8}
        className="w-full rounded-md border border-gray-300 p-3 text-sm text-[#2a2a2a] focus:border-[#97B3AE] focus:outline-none focus:ring-1 focus:ring-[#97B3AE]"
      />
      <div className="flex items-center justify-between">
        <span
          className={`text-xs ${
            overLimit ? 'text-red-600' : 'text-[#6a6a6a]'
          }`}
        >
          {text.length} / {MAX_REPLY_CHARS}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(text)}
            disabled={!text.trim() || overLimit}
            className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update on Google
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewPanel({
  text,
  onPublish,
  onEditFurther,
  onCancel,
}: {
  text: string;
  onPublish: () => void;
  onEditFurther: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
          Proposed reply
        </div>
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {AI_DRAFT_DISCLOSURE}
        </div>
        <p className="rounded-md border border-gray-200 bg-white p-3 text-sm text-[#2a2a2a]">
          {text}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onEditFurther}
          className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
        >
          Edit further
        </button>
        <button
          type="button"
          onClick={onPublish}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Update on Google
        </button>
      </div>
    </div>
  );
}

function RecoveryPanel({
  onRetry,
  onRestore,
  restoreAvailable,
}: {
  onRetry: () => void;
  onRestore: () => void;
  restoreAvailable: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        {restoreAvailable
          ? 'The previous edit didn’t complete and your old reply is no longer on Google. Retry the edit, or restore the original reply.'
          : 'The previous edit didn’t complete. The original reply is still live on Google. Retry to re-attempt the edit.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Retry posting
        </button>
        {restoreAvailable && (
          <button
            type="button"
            onClick={onRestore}
            className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
          >
            Restore original
          </button>
        )}
      </div>
    </div>
  );
}

function DraftConflictPanel({
  draftText,
  isEdited,
  status,
  onResume,
  onDiscard,
  onClose,
  onRefresh,
}: {
  draftText: string;
  isEdited: boolean;
  status: string;
  onResume: () => void;
  onDiscard: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  // approved / edited: the reply is already approved and the publish outbox
  // is in flight. Resume/Discard cannot help — inform and offer Close/Refresh.
  if (status === 'approved' || status === 'edited') {
    return (
      <div className="space-y-3 rounded-lg border border-[#97B3AE]/40 bg-[#F0EEEA]/40 p-4">
        <p className="text-sm font-medium text-[#2a2a2a]">Edit already approved</p>
        <p className="text-sm text-[#6a6a6a]">
          This reply has been approved and is being published to Google. No further
          action is needed — check back shortly and the updated reply will appear.
        </p>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
            {isEdited ? 'Approved edited draft' : 'Approved draft'}
          </div>
          <p className="rounded-md border border-gray-200 bg-white p-3 text-sm text-[#2a2a2a]">
            {draftText || <em className="text-[#6a6a6a]">(empty)</em>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // awaiting_owner_connect: publishing is paused until the Google account is
  // reconnected. Resume/Discard cannot resolve this — inform and link to settings.
  if (status === 'awaiting_owner_connect') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">Google reconnect required</p>
        <p className="text-sm text-amber-800">
          Publishing is paused because your Google Business Profile connection has
          expired. Reconnect your account in Settings and this reply will publish
          automatically.
        </p>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">
            {isEdited ? 'Your edited draft' : 'Draft reply'}
          </div>
          <p className="rounded-md bg-white p-3 text-sm text-[#2a2a2a]">
            {draftText || <em className="text-[#6a6a6a]">(empty)</em>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/connect"
            className="inline-flex items-center rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
          >
            Reconnect Google
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // pending_approval: Resume (→ preview, can publish/edit) + Discard (DELETE).
  // This is the only status where both actions are safe and meaningful.
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        You have an unsaved edit in progress for this review. Resume it to
        review and publish, or discard it to start over.
      </p>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">
          {isEdited ? 'Your edited draft' : 'Draft reply'}
        </div>
        <p className="rounded-md bg-white p-3 text-sm text-[#2a2a2a]">
          {draftText || <em className="text-[#6a6a6a]">(empty)</em>}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onResume}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Resume
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function ReviewChangedPanel({
  currentText,
  onRefresh,
  onClose,
}: {
  currentText: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        The customer updated this review. Refresh to see the latest version
        before editing again.
      </p>
      {currentText && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">
            Updated review text
          </div>
          <p className="rounded-md bg-white p-3 text-sm text-[#2a2a2a]">{currentText}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Close
        </button>
      </div>
    </div>
  );
}
