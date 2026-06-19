'use client';

import { Icon } from '@/components/dashboard/shell/Icon';

interface Props {
  count: number;
  /** Scrolls to the needs-action reviews zone. Omitted in read-only states. */
  onReview?: () => void;
}

/**
 * Zone 2 (PLAN.md): a full-width strip under the hero. Shows the pending count
 * with a "Review now" CTA when there's work, or a quiet "all caught up" state
 * otherwise. Secondary to the reputation hero, never the primary focus.
 */
export function PendingApprovalsStrip({ count, onReview }: Props) {
  if (count <= 0) {
    return (
      <div className="approvals calm">
        <div className="approvals-ic">
          <Icon name="check" size={22} />
        </div>
        <div className="approvals-txt">
          <div className="approvals-title">You&apos;re all caught up</div>
          <div className="approvals-sub">
            No drafts waiting. We&apos;ll let you know the moment a new review needs you.
          </div>
        </div>
      </div>
    );
  }

  const plural = count === 1 ? '' : 's';
  return (
    <div className="approvals">
      <div className="approvals-ic">
        <Icon name="inbox" size={22} />
      </div>
      <div className="approvals-txt">
        <div className="approvals-title">
          <strong>{count} draft{plural}</strong> need{count === 1 ? 's' : ''} your approval
        </div>
        <div className="approvals-sub">
          Approve or edit {count === 1 ? 'it' : 'them'} below. Usually under a minute.
        </div>
      </div>
      {onReview && (
        <button type="button" className="btn btn-primary" onClick={onReview}>
          Review now
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
