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

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { PastReplyRow } from '@/components/dashboard/reviews/PastReplyCard';
// Used by the inline 'initial'-state CTA block below — the one state not
// extracted to a panel (it has no stateful logic to isolate).
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { useEditReplyDraft } from '@/components/dashboard/reviews/edit-reply/useEditReplyDraft';
import { useFocusTrap } from '@/components/dashboard/reviews/edit-reply/useFocusTrap';
import { ManualEditor } from '@/components/dashboard/reviews/edit-reply/ManualEditor';
import { PreviewPanel } from '@/components/dashboard/reviews/edit-reply/PreviewPanel';
import { RecoveryPanel } from '@/components/dashboard/reviews/edit-reply/RecoveryPanel';
import { DraftConflictPanel } from '@/components/dashboard/reviews/edit-reply/DraftConflictPanel';
import { ReviewChangedPanel } from '@/components/dashboard/reviews/edit-reply/ReviewChangedPanel';

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
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Mounted only while open, so this opens the native dialog on mount.
  // showModal() promotes it to the top layer and exposes the dialog role.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-0 flex size-full max-h-none max-w-none border-0 bg-transparent p-0"
      aria-labelledby="edit-reply-drawer-title"
      // Escape is owned by useFocusTrap (routes through tryClose, the in-flight
      // draft guard). preventDefault suppresses the native dialog's own ESC
      // auto-close so close never bypasses that guard.
      onCancel={(event) => event.preventDefault()}
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
      <aside ref={panelRef} tabIndex={-1} className="flex h-full w-full max-w-xl flex-col overflow-y-auto shadow-2xl" style={{ background: 'var(--rw-card)' }}>
        <header className="sticky top-0 z-10 flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--rw-hair)', background: 'var(--rw-card)' }}>
          <h2
            id="edit-reply-drawer-title"
            className="text-lg font-semibold"
            style={{ color: 'var(--rw-app-text)' }}
          >
            Edit reply
          </h2>
          <button
            type="button"
            onClick={tryClose}
            disabled={isClosePending}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-sm hover:bg-[var(--rw-recess)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            style={{ color: 'var(--rw-app-text-muted)' }}
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
          <section className="rounded-lg p-3" style={{ border: '1px solid var(--rw-hair)', background: 'var(--rw-recess)' }}>
            <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
              Customer review
            </div>
            <div className="flex items-center gap-2">
              {row.star_rating != null && (
                <span className="text-sm" style={{ color: 'var(--rw-star)' }} aria-label={`${row.star_rating} stars`}>
                  {'★'.repeat(Math.round(row.star_rating))}
                  {'☆'.repeat(Math.max(0, 5 - Math.round(row.star_rating)))}
                </span>
              )}
              <span className="text-sm font-medium" style={{ color: 'var(--rw-app-text)' }}>
                {row.reviewer_name ?? 'Anonymous'}
              </span>
            </div>
            <p className="mt-1 text-sm" style={{ color: 'var(--rw-app-text)' }}>
              {row.review_text ?? <em style={{ color: 'var(--rw-app-text-muted)' }}>No review text, rating only.</em>}
            </p>
          </section>

          {/* Current Google reply — always shown */}
          <section>
            <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
              Current Google reply
            </div>
            <p className="rounded-md p-3 text-sm" style={{ background: 'var(--rw-recess)', color: 'var(--rw-app-text)' }}>
              {(row.approved_text ?? '') || <em style={{ color: 'var(--rw-app-text-muted)' }}>(empty)</em>}
            </p>
          </section>

          {/* State-specific UI */}
          {state.kind === 'initial' && canEdit && (
            <div className="space-y-3">
              <div className="rounded-md px-3 py-2 text-xs" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-sage-soft)', color: 'var(--rw-app-text-muted)' }}>
                {AI_DRAFT_DISCLOSURE}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={actions.startManualEdit}
                  className="btn btn-primary"
                >
                  Edit manually
                </button>
                <button
                  type="button"
                  onClick={actions.startRegenerate}
                  className="btn btn-secondary"
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
            <div className="rounded-lg p-4 text-sm" style={{ border: '1px solid var(--rw-hair)', background: 'var(--rw-recess)', color: 'var(--rw-app-text-muted)' }}>
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
            <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', boxShadow: 'inset 4px 0 0 var(--rw-blush)', background: 'var(--rw-recess)' }}>
              <p className="text-sm" style={{ color: 'var(--rw-app-text-muted)' }}>{state.message}</p>
              <p className="text-xs" style={{ color: 'var(--rw-app-text-muted)' }}>
                Close is paused until the draft arrives or the worker reports failure; otherwise the
                draft would be created in the background and block your next attempt.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={actions.resumePolling}
                  className="btn btn-primary"
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
            <div className="rounded-lg p-4 text-sm" style={{ border: '1px solid var(--rw-hair)', background: 'var(--rw-recess)', color: 'var(--rw-app-text-muted)' }}>
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
            <div className="rounded-lg p-4" style={{ border: '1px solid var(--rw-danger)', background: 'var(--rw-danger-soft)' }}>
              <p className="text-sm" style={{ color: 'var(--rw-danger)' }}>{state.message}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={actions.reset}
                  className="rounded-md px-3 py-1 text-xs font-medium"
                  style={{ border: '1px solid var(--rw-danger)', color: 'var(--rw-danger)' }}
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-3 py-1 text-xs font-medium hover:bg-[var(--rw-recess)]"
                  style={{ color: 'var(--rw-app-text-muted)' }}
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {state.kind === 'success' && (
            <div className="rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-sage-soft)' }}>
              <p className="text-sm" style={{ color: 'var(--rw-sage-deep)' }}>{state.message}</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn btn-primary"
                >
                  Close editor
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </dialog>
  );
}

// ────────────────────────────────────────────────────────────────────
// Subcomponents
// ────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 animate-spin rounded-full border-2"
      style={{ borderColor: 'var(--rw-sage-line)', borderTopColor: 'var(--rw-sage-deep)' }}
    />
  );
}
