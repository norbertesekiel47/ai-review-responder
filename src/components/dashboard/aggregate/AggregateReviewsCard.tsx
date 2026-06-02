'use client';

import { useState, type Ref } from 'react';
import type { AggregateDashboardData, AggregateReviewItem } from '@/lib/dashboard/types';
import { ReviewActions } from '@/components/dashboard/ReviewActions';
import { Icon } from '@/components/dashboard/shell/Icon';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending_approval: { label: 'Pending Approval', cls: 'badge-pending' },
  posted: { label: 'Posted', cls: 'badge-posted' },
  awaiting_owner_connect: { label: 'Awaiting Manual Post', cls: 'badge-awaiting' },
  edited: { label: 'Edited', cls: 'badge-edited' },
  failed: { label: 'Failed', cls: 'badge-failed' },
  new: { label: 'New', cls: 'badge-pending' },
  generating: { label: 'Generating', cls: 'badge-pending' },
  approved: { label: 'Approved', cls: 'badge-edited' },
};

function formatStars(n: number | null): string {
  if (n == null) return '';
  const filled = Math.round(Math.max(0, Math.min(5, n)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function formatRelative(dateIso: string): string {
  const d = new Date(dateIso);
  const diffH = (Date.now() - d.getTime()) / 36e5;
  if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 48) return 'yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface Props {
  recentReviews: AggregateDashboardData['recentReviews'];
  onActionSuccess: () => void;
  readOnly?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** VAL-DASH-013: Global pending-approval feed combines all locations.
 *  VAL-DASH-014: Location chips in approval feed use display_label. */
export function AggregateReviewsCard({
  recentReviews,
  onActionSuccess,
  readOnly = false,
  ref: scrollRef,
}: Props) {
  const [tab, setTab] = useState<'needs' | 'all'>('needs');
  const pending = recentReviews.filter((r) => (r.responseStatus ?? r.status) === 'pending_approval');
  const list = tab === 'needs' ? pending : recentReviews;

  return (
    <div className="card" id="needs-action" ref={scrollRef}>
      <div className="card-h2-row">
        <h2>Reviews</h2>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: '#6B7280' }}>{pending.length} awaiting your approval</span>
      </div>

      <div className="tabs" role="tablist">
        <button
          type="button"
          className={`tab ${tab === 'needs' ? 'active' : ''}`}
          onClick={() => setTab('needs')}
          role="tab"
          aria-selected={tab === 'needs'}
        >
          Needs Action
          {pending.length > 0 && <span className="tab-badge">{pending.length}</span>}
        </button>
        <button
          type="button"
          className={`tab ${tab === 'all' ? 'active' : ''}`}
          onClick={() => setTab('all')}
          role="tab"
          aria-selected={tab === 'all'}
        >
          All Recent
        </button>
      </div>

      {list.length === 0 ? (
        <div className="empty-caught-up">
          <div className="empty-emoji">🎉</div>
          <div className="empty-title">All caught up!</div>
          <div className="empty-sub">
            No replies waiting on you across any location. We&apos;ll email when a new draft is ready.
          </div>
        </div>
      ) : (
        <div className="review-list">
          {list.map((r) => (
            <AggregateReviewRow key={r.id} r={r} onSuccess={onActionSuccess} readOnly={readOnly} />
          ))}
        </div>
      )}
    </div>
  );
}

function AggregateReviewRow({
  r,
  onSuccess,
  readOnly,
}: {
  r: AggregateReviewItem;
  onSuccess: () => void;
  readOnly: boolean;
}) {
  const displayStatus = r.responseStatus ?? r.status;
  const isPending = displayStatus === 'pending_approval';
  const badge = STATUS_BADGE[displayStatus] ?? STATUS_BADGE['new']!;
  const [showResp, setShowResp] = useState(false);

  return (
    <div className={`review ${isPending ? 'pending' : ''}`}>
      <div className="review-head">
        {r.starRating != null && (
          <span className="stars" aria-label={`${r.starRating} stars`}>
            {formatStars(r.starRating)}
          </span>
        )}
        <span className="reviewer">{r.reviewerName}</span>
        {/* VAL-DASH-014: Location chip with display_label */}
        <span className="location-chip">
          <Icon name="location" size={10} />
          {r.locationDisplayName}
        </span>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        <span className="review-meta-time">{formatRelative(r.reviewDate)}</span>
      </div>
      {r.reviewText && <p className="review-body">{r.reviewText}</p>}

      {isPending && r.responseText && (
        <div className="draft-block">
          <div className="draft-eyebrow">
            <Icon name="sparkle" size={12} className="sparkle-icon" />
            AI draft · sounds like you
          </div>
          <div className="draft-text">{r.responseText}</div>
          {readOnly ? (
            <p className="text-xs text-gray-600 mt-2">
              Update billing to approve, edit, or regenerate this reply.
            </p>
          ) : (
            <ReviewActions reviewId={r.id} responseText={r.responseText} onSuccess={onSuccess} />
          )}
        </div>
      )}

      {!isPending && r.responseText && (
        <>
          <button type="button" className="collapsed-toggle" onClick={() => setShowResp((s) => !s)}>
            {showResp ? 'Hide response' : 'Show response'}
          </button>
          {showResp && <p className="posted-resp">{r.responseText}</p>}
        </>
      )}
    </div>
  );
}
