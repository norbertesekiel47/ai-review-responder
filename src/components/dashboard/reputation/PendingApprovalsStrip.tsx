'use client';

interface Props {
  /** Authoritative SQL pending count (same source as the tabbar badge). */
  pendingCount: number;
  /** Scrolls to / focuses the reviews zone. */
  onReview: () => void;
}

// Full-width action strip directly under the hero. It is the strong SECONDARY
// action: the owner's primary job on this dashboard is reassurance, but the
// approval queue must stay one tap away. Shown as an action when the SQL
// pending count > 0; a quiet "all caught up" line otherwise.
export function PendingApprovalsStrip({ pendingCount, onReview }: Props) {
  if (pendingCount <= 0) {
    return (
      <div className="pending-strip pending-strip--calm" role="status">
        You&apos;re all caught up — no drafts waiting on you.
      </div>
    );
  }

  const noun = pendingCount === 1 ? 'draft needs' : 'drafts need';
  return (
    <div className="pending-strip pending-strip--action">
      <span className="pending-strip-text">
        <strong>{pendingCount}</strong> {noun} your approval
      </span>
      <button type="button" className="pending-strip-cta" onClick={onReview}>
        Review now →
      </button>
    </div>
  );
}
