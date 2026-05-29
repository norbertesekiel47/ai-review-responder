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
      <div className="space-y-3 rounded-lg border border-[#97B3AE]/40 border-l-4 border-l-[#F2C3B9] bg-[#F0EEEA]/40 p-4">
        <p className="text-sm font-medium text-[#2a2a2a]">Google reconnect required</p>
        <p className="text-sm text-[#6a6a6a]">
          Publishing is paused because your Google Business Profile connection has
          expired. Reconnect your account in Settings and this reply will publish
          automatically.
        </p>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
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
    <div className="space-y-3 rounded-lg border border-[#97B3AE]/40 border-l-4 border-l-[#F2C3B9] bg-[#F0EEEA]/40 p-4">
      <p className="text-sm text-[#6a6a6a]">
        You have an unsaved edit in progress for this review. Resume it to
        review and publish, or discard it to start over.
      </p>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
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
