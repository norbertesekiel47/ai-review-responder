'use client';

import { useState } from 'react';
import { AutoApprovedBadge } from '@/components/dashboard/reviews/AutoApprovedBadge';
import { ReviewActions, type ReviewEscalation } from '@/components/dashboard/reviews/ReviewActions';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { ApprovalMethod } from '@/lib/auto-approval/types';

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

interface ReviewFeedItem {
  id: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  reviewDate: string;
  status: string;
  responseText: string | null;
  responseStatus: string | null;
  approvalMethod: ApprovalMethod | null;
  locationDisplayName?: string;
  /** Optional so the aggregate feed (WS5) can keep omitting it. */
  escalation?: ReviewEscalation | null;
}

interface ReviewFeedCardProps {
  recentReviews: readonly ReviewFeedItem[];
  onActionSuccess: () => void;
  emptyText: string;
  readOnly?: boolean;
}

export function ReviewFeedCard({
  recentReviews,
  onActionSuccess,
  emptyText,
  readOnly = false,
}: ReviewFeedCardProps) {
  // The full archive lives on the Reviews → History tab; this card renders only
  // the action queue (pending-approval drafts).
  const pending = recentReviews.filter((r) => (r.responseStatus ?? r.status) === 'pending_approval');

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Reviews</h2>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--rw-app-text-muted)' }}>{pending.length} awaiting your approval</span>
      </div>

      {pending.length === 0 ? (
        <div className="empty-caught-up">
          <div className="empty-emoji">🎉</div>
          <div className="empty-title">All caught up!</div>
          <div className="empty-sub">{emptyText}</div>
        </div>
      ) : (
        <div className="review-list">
          {pending.map((r) => (
            <ReviewFeedRow key={r.id} r={r} onSuccess={onActionSuccess} readOnly={readOnly} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewFeedRow({
  r,
  onSuccess,
  readOnly,
}: {
  r: ReviewFeedItem;
  onSuccess: () => void;
  readOnly: boolean;
}) {
  const displayStatus = r.responseStatus ?? r.status;
  const isPending = displayStatus === 'pending_approval';
  const badge = STATUS_BADGE[displayStatus] ?? STATUS_BADGE['new']!;

  return (
    <div className={`review ${isPending ? 'pending' : ''}`}>
      <ReviewFeedHeader r={r} badge={badge} />
      <ReviewText text={r.reviewText} />
      <PendingDraft
        isPending={isPending}
        readOnly={readOnly}
        reviewId={r.id}
        responseText={r.responseText}
        escalation={r.escalation ?? null}
        onSuccess={onSuccess}
      />
      <PostedResponse isPending={isPending} responseText={r.responseText} />
    </div>
  );
}

function ReviewFeedHeader({
  r,
  badge,
}: {
  r: ReviewFeedItem;
  badge: { label: string; cls: string };
}) {
  return (
    <div className="review-head">
      {r.starRating != null && (
        <span className="stars" aria-label={`${r.starRating} stars`}>
          {formatStars(r.starRating)}
        </span>
      )}
      <span className="reviewer">{r.reviewerName}</span>
      {r.locationDisplayName && (
        <span className="location-chip">
          <Icon name="location" size={10} />
          {r.locationDisplayName}
        </span>
      )}
      <span className={`badge ${badge.cls}`}>{badge.label}</span>
      {r.escalation && (
        <span
          className={`escalation-badge escalation-badge--${r.escalation.severity}`}
          title={r.escalation.status === 'acknowledged' ? 'Escalation acknowledged' : 'Escalated to you by Guardian'}
        >
          {r.escalation.status === 'acknowledged' ? '👁 Acknowledged' : '🚨 Needs attention'}
        </span>
      )}
      <AutoApprovedBadge method={r.approvalMethod} variant="compact" />
      <span className="review-meta-time">{formatRelative(r.reviewDate)}</span>
    </div>
  );
}

function ReviewText({ text }: { text: string | null }) {
  return text ? <p className="review-body">{text}</p> : null;
}

function PendingDraft({
  isPending,
  readOnly,
  reviewId,
  responseText,
  escalation,
  onSuccess,
}: {
  isPending: boolean;
  readOnly: boolean;
  reviewId: string;
  responseText: string | null;
  escalation: ReviewEscalation | null;
  onSuccess: () => void;
}) {
  if (!isPending || !responseText) return null;

  return (
    <div className="draft-block">
      <div className="draft-eyebrow">
        <Icon name="sparkle" size={12} className="sparkle-icon" />
        AI draft · sounds like you
      </div>
      <div className="draft-text">{responseText}</div>
      {readOnly ? (
        <p className="text-xs mt-2" style={{ color: 'var(--rw-app-text-muted)' }}>
          Update billing to approve, edit, or regenerate this reply.
        </p>
      ) : (
        <ReviewActions
          reviewId={reviewId}
          responseText={responseText}
          escalation={escalation}
          onSuccess={onSuccess}
        />
      )}
    </div>
  );
}

function PostedResponse({
  isPending,
  responseText,
}: {
  isPending: boolean;
  responseText: string | null;
}) {
  const [showResp, setShowResp] = useState(false);

  if (isPending || !responseText) return null;

  return (
    <>
      <button type="button" className="collapsed-toggle" onClick={() => setShowResp((s) => !s)}>
        {showResp ? 'Hide response' : 'Show response'}
      </button>
      {showResp && <p className="posted-resp">{responseText}</p>}
    </>
  );
}

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
