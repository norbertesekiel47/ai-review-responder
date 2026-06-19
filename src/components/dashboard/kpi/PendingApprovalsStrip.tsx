'use client';

import Link from 'next/link';
import { Icon } from '@/components/dashboard/shell/Icon';

interface Props {
  count: number;
}

const REVIEWS_HREF = '/dashboard/reviews';

function ReviewsCta({ label, variant }: { label: string; variant: 'primary' | 'ghost' }) {
  return (
    <Link href={REVIEWS_HREF} className={`btn btn-${variant}`}>
      {label}
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </Link>
  );
}

/**
 * Action strip under the dashboard hero. Always a doorway to the Reviews page —
 * "Review now" when drafts are waiting, "View all reviews" when caught up. The
 * arrow link is present in BOTH states (PLAN.md 2026-06-19 restructure).
 */
export function PendingApprovalsStrip({ count }: Props) {
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
        <ReviewsCta label="View all reviews" variant="ghost" />
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
          Approve or edit {count === 1 ? 'it' : 'them'} on the Reviews page. Usually under a minute.
        </div>
      </div>
      <ReviewsCta label="Review now" variant="primary" />
    </div>
  );
}
