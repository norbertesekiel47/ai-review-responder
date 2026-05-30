// src/components/dashboard/EditReplyDrawer.tsx
//
// Right-side slide-out drawer for the edit-existing-reply flow. This is the
// composing shell: it wires useEditReplyDraft (the state machine + every API
// call) and useFocusTrap (focus capture / Tab-trap / Esc / restore), then
// renders the review snapshot, the current Google reply, and the per-state
// panel for state.kind. The state machine, its DrawerState variants, and the
// API contract are documented in ./edit-reply/useEditReplyDraft.ts; the panels
// live in ./edit-reply/*.

'use client';

import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/PastReplyCard';
// Used by the inline 'initial'-state CTA block below — the one state not
// extracted to a panel (it has no stateful logic to isolate).
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { useEditReplyDraft } from '@/components/dashboard/edit-reply/useEditReplyDraft';
import { useFocusTrap } from '@/components/dashboard/edit-reply/useFocusTrap';
import { ManualEditor } from '@/components/dashboard/edit-reply/ManualEditor';
import { PreviewPanel } from '@/components/dashboard/edit-reply/PreviewPanel';
import { RecoveryPanel } from '@/components/dashboard/edit-reply/RecoveryPanel';
import { DraftConflictPanel } from '@/components/dashboard/edit-reply/DraftConflictPanel';
import { ReviewChangedPanel } from '@/components/dashboard/edit-reply/ReviewChangedPanel';

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
  const { panelRef } = useFocusTrap(open, tryClose);

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
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-sm text-[#6a6a6a] hover:bg-gray-50 hover:text-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
                <span className="text-sm text-[#97B3AE]" aria-label={`${row.star_rating} stars`}>
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
              <div className="rounded-md border border-[#97B3AE]/30 bg-[#F0EEEA]/60 px-3 py-2 text-xs text-[#6a6a6a]">
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
            <div className="space-y-3 rounded-lg border border-[#97B3AE]/40 border-l-4 border-l-[#F2C3B9] bg-[#F0EEEA]/40 p-4">
              <p className="text-sm text-[#6a6a6a]">{state.message}</p>
              <p className="text-xs text-[#6a6a6a]">
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
