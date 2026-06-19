'use client';
import Link from 'next/link';

export function DraftConflictPanel({
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
      <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-recess)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--rw-app-text)' }}>Edit already approved</p>
        <p className="text-sm" style={{ color: 'var(--rw-app-text-muted)' }}>
          This reply has been approved and is being published to Google. No further
          action is needed; check back shortly and the updated reply will appear.
        </p>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
            {isEdited ? 'Approved edited draft' : 'Approved draft'}
          </div>
          <p className="rounded-md p-3 text-sm" style={{ border: '1px solid var(--rw-hair)', background: 'var(--rw-card)', color: 'var(--rw-app-text)' }}>
            {draftText || <em style={{ color: 'var(--rw-app-text-muted)' }}>(empty)</em>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="btn btn-primary"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
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
      <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', boxShadow: 'inset 4px 0 0 var(--rw-blush)', background: 'var(--rw-recess)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--rw-app-text)' }}>Google reconnect required</p>
        <p className="text-sm" style={{ color: 'var(--rw-app-text-muted)' }}>
          Publishing is paused because your Google Business Profile connection has
          expired. Reconnect your account in Settings and this reply will publish
          automatically.
        </p>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
            {isEdited ? 'Your edited draft' : 'Draft reply'}
          </div>
          <p className="rounded-md p-3 text-sm" style={{ background: 'var(--rw-card)', color: 'var(--rw-app-text)' }}>
            {draftText || <em style={{ color: 'var(--rw-app-text-muted)' }}>(empty)</em>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/connect"
            className="btn btn-primary inline-flex items-center"
          >
            Reconnect Google
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
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
    <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', boxShadow: 'inset 4px 0 0 var(--rw-blush)', background: 'var(--rw-recess)' }}>
      <p className="text-sm" style={{ color: 'var(--rw-app-text-muted)' }}>
        You have an unsaved edit in progress for this review. Resume it to
        review and publish, or discard it to start over.
      </p>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
          {isEdited ? 'Your edited draft' : 'Draft reply'}
        </div>
        <p className="rounded-md p-3 text-sm" style={{ background: 'var(--rw-card)', color: 'var(--rw-app-text)' }}>
          {draftText || <em style={{ color: 'var(--rw-app-text-muted)' }}>(empty)</em>}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onResume}
          className="btn btn-primary"
        >
          Resume
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="btn btn-secondary"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
