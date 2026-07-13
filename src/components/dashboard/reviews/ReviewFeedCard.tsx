'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  EscalationActions,
  ReviewActions,
  type ReviewEscalation,
} from '@/components/dashboard/reviews/ReviewActions';
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
  autoPostScheduledAt: Date | string | null;
  locationDisplayName?: string;
  escalation: ReviewEscalation | null;
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
  const now = useReviewFeedClock(recentReviews);
  const pendingCount = recentReviews.filter(
    (review) => (review.responseStatus ?? review.status) === 'pending_approval',
  ).length;
  const isClockPending = now === null
    && pendingCount === 0
    && recentReviews.some((review) => getScheduledPost(review) !== null);
  // History owns settled replies. The one post-approval exception is a live
  // auto-post deadline: owners must be able to see and reach its veto context.
  const visibleReviews = recentReviews.flatMap((review) => {
    const scheduledPostAt = now === null ? null : getFutureScheduledPost(review, now);
    return (review.responseStatus ?? review.status) === 'pending_approval' || scheduledPostAt !== null
      ? [{ review, scheduledPostAt }]
      : [];
  });

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Reviews</h2>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--rw-app-text-muted)' }}>{pendingCount} awaiting your approval</span>
      </div>

      {isClockPending ? (
        <ScheduledClockPendingState />
      ) : visibleReviews.length === 0 ? (
        <div className="empty-caught-up">
          <div className="empty-emoji" aria-hidden="true"><Icon name="check" size={40} /></div>
          <div className="empty-title">All caught up!</div>
          <div className="empty-sub">{emptyText}</div>
        </div>
      ) : (
        <div className="review-list">
          {visibleReviews.map(({ review, scheduledPostAt }) => (
            <ReviewFeedRow
              key={review.id}
              r={review}
              scheduledPostAt={scheduledPostAt}
              now={now}
              onSuccess={onActionSuccess}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduledClockPendingState() {
  return (
    <output className="empty-caught-up" aria-live="polite">
      <div className="empty-emoji" aria-hidden="true"><Icon name="clock" size={40} /></div>
      <div className="empty-title">Checking scheduled posts…</div>
      <div className="empty-sub">Confirming the latest posting window.</div>
    </output>
  );
}

function ReviewFeedRow({
  r,
  scheduledPostAt,
  now,
  onSuccess,
  readOnly,
}: {
  r: ReviewFeedItem;
  scheduledPostAt: number | null;
  now: number | null;
  onSuccess: () => void;
  readOnly: boolean;
}) {
  const displayStatus = r.responseStatus ?? r.status;
  const isPending = displayStatus === 'pending_approval';
  const badge = STATUS_BADGE[displayStatus] ?? STATUS_BADGE['new']!;

  return (
    <div className={`review ${isPending ? 'pending' : ''}`}>
      <ReviewFeedHeader r={r} badge={badge} scheduledPostAt={scheduledPostAt} now={now} />
      <ReviewText text={r.reviewText} />
      <PendingDraft
        isPending={isPending}
        readOnly={readOnly}
        reviewId={r.id}
        responseText={r.responseText}
        onSuccess={onSuccess}
      />
      {/* Escalation actions live OUTSIDE the draft gate: moderation-held
          drafts (responseText null) are exactly the high-severity lane and
          must still be acknowledgeable. readOnly (billing) still hides them —
          the escalation routes reject non-writable subscriptions anyway. */}
      {r.escalation && !readOnly && (
        <EscalationActions escalation={r.escalation} onSuccess={onSuccess} />
      )}
      <PostedResponse isPending={isPending} responseText={r.responseText} />
      <Link
        href={`/dashboard/reviews/${r.id}/timeline`}
        className="review-timeline-link"
        aria-label={`View agent timeline for ${r.reviewerName}`}
      >
        <Icon name="clock" size={12} aria-hidden="true" />
        Timeline
      </Link>
    </div>
  );
}

function ReviewFeedHeader({
  r,
  badge,
  scheduledPostAt,
  now,
}: {
  r: ReviewFeedItem;
  badge: { label: string; cls: string };
  scheduledPostAt: number | null;
  now: number | null;
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
      <PersonaBadges review={r} />
      <ScheduledPostChip reviewId={r.id} scheduledPostAt={scheduledPostAt} now={now} />
      <span className="review-meta-time">{formatRelative(r.reviewDate)}</span>
    </div>
  );
}

function PersonaBadges({ review }: { review: ReviewFeedItem }) {
  const replyLabel = review.approvalMethod === 'auto_policy' ? 'Reply · Auto' : 'Reply';
  const guardianLabel = review.escalation?.status === 'acknowledged' ? 'Acknowledged' : 'Needs attention';

  return (
    <>
      {review.responseText !== null && (
        <span className={`badge persona-badge ${review.approvalMethod === 'auto_policy' ? 'badge-auto' : 'persona-badge--reply'}`}>
          <Icon name="sparkle" size={10} aria-hidden="true" />
          {replyLabel}
        </span>
      )}
      {review.escalation && (
        <span
          className={`badge persona-badge escalation-badge escalation-badge--${review.escalation.severity}`}
          title={review.escalation.status === 'acknowledged' ? 'Escalation acknowledged' : 'Escalated to you by Guardian'}
        >
          <Icon name="shield" size={10} aria-hidden="true" />
          <span>Guardian</span>
          <span aria-hidden="true">·</span>
          <span>{guardianLabel}</span>
        </span>
      )}
    </>
  );
}

function ScheduledPostChip({
  reviewId,
  scheduledPostAt,
  now,
}: {
  reviewId: string;
  scheduledPostAt: number | null;
  now: number | null;
}) {
  if (scheduledPostAt === null || now === null) return null;
  return (
    <Link
      href={`/dashboard/reviews/${reviewId}/timeline`}
      className="scheduled-post-chip"
    >
      <Icon name="clock" size={10} aria-hidden="true" />
      Scheduled — posts at {formatScheduledChipTime(scheduledPostAt, now)}
    </Link>
  );
}

/**
 * Viewer-local chip time for the dashboard, where the browser clock IS the
 * owner's timezone — unlike formatScheduledPostTime, whose UTC output serves
 * notification channels where the viewer's zone is unknown. Adds month/day
 * when the deadline falls outside "today" in the viewer's zone. `timeZone`
 * exists so tests can pin a zone; production callers omit it.
 */
export function formatScheduledChipTime(
  scheduledPostAt: number,
  now: number,
  timeZone?: string,
): string {
  const isDeadlineToday = formatLocalDayKey(scheduledPostAt, timeZone) === formatLocalDayKey(now, timeZone);
  return new Intl.DateTimeFormat('en-US', {
    ...(isDeadlineToday ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(scheduledPostAt);
}

function formatLocalDayKey(timestamp: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }).format(timestamp);
}

function ReviewText({ text }: { text: string | null }) {
  return text ? <p className="review-body">{text}</p> : null;
}

function PendingDraft({
  isPending,
  readOnly,
  reviewId,
  responseText,
  onSuccess,
}: {
  isPending: boolean;
  readOnly: boolean;
  reviewId: string;
  responseText: string | null;
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

function getFutureScheduledPost(review: ReviewFeedItem, now: number): number | null {
  const scheduledPostAt = getScheduledPost(review);
  return scheduledPostAt !== null && scheduledPostAt > now ? scheduledPostAt : null;
}

function getScheduledPost(review: ReviewFeedItem): number | null {
  if ((review.responseStatus ?? review.status) !== 'approved') return null;
  if (review.approvalMethod !== 'auto_policy' || review.autoPostScheduledAt == null) return null;
  const scheduledPostAt = new Date(review.autoPostScheduledAt).getTime();
  return Number.isFinite(scheduledPostAt) ? scheduledPostAt : null;
}

function useReviewFeedClock(reviews: readonly ReviewFeedItem[]): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let timeoutId: number;
    const refresh = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const nextDeadline = reviews.reduce<number | null>((earliest, review) => {
        const deadline = getScheduledPost(review);
        if (deadline === null || deadline <= currentTime) return earliest;
        return earliest === null ? deadline : Math.min(earliest, deadline);
      }, null);
      if (nextDeadline !== null) {
        timeoutId = window.setTimeout(refresh, Math.min(nextDeadline - currentTime + 1, 2_147_483_647));
      }
    };
    timeoutId = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(timeoutId);
  }, [reviews]);

  return now;
}
