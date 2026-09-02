'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReviewTimeline, ReviewTimelineResponse } from '@/lib/agents/read';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { RunTimeline } from './RunTimeline';
import { TimelineEscalationActions } from './TimelineEscalationActions';
import { formatDeadline, formatIdentifier } from './format';

const REVIEW_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Where the owner came from, so the back link returns there (UX audit D21).
 * A closed allowlist keyed by a short token — `?from=` is URL input, so it is
 * never used as an href. Anything unknown falls back to the queue.
 */
const BACK_LINKS = {
  reviews: { href: '/dashboard/reviews', label: 'Back to reviews' },
  history: { href: '/dashboard/reviews/history', label: 'Back to all reviews' },
  dashboard: { href: '/dashboard', label: 'Back to dashboard' },
} as const;

export type TimelineOrigin = keyof typeof BACK_LINKS;

export function resolveBackLink(from: string | null | undefined): (typeof BACK_LINKS)[TimelineOrigin] {
  return from !== null && from !== undefined && Object.hasOwn(BACK_LINKS, from)
    ? BACK_LINKS[from as TimelineOrigin]
    : BACK_LINKS.reviews;
}

const SUBTITLE = 'A record of how your agent team handled this review.';

/**
 * The frame every state of this page shares — TopBar and the back link — so
 * the owner can always leave, including from the loading and error states
 * that used to strand them (D21).
 */
function TimelineFrame({
  backLink,
  children,
}: {
  backLink: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <>
      <TopBar title="Review timeline" subtitle={SUBTITLE} />
      <div className="content content--timeline">
        <Link className="timeline-back-link" href={backLink.href}>
          <BackIcon />
          {backLink.label}
        </Link>
        {children}
      </div>
    </>
  );
}

export function TimelineContent({ reviewId, from }: { reviewId: string; from?: string | null }) {
  const timelineQuery = useQuery({
    queryKey: ['review-timeline', reviewId],
    queryFn: () => fetchReviewTimeline(reviewId),
    retry: false,
  });
  const clockNowMs = useAutoPostClock(timelineQuery.data?.response ?? null);
  const backLink = resolveBackLink(from);

  if (timelineQuery.isLoading) {
    return (
      <TimelineFrame backLink={backLink}>
        <LiveRegion message="Loading review timeline…" />
        <div className="timeline-skeleton" aria-hidden="true">
          <div className="skeleton-card" />
          <div className="skeleton-card-lg" />
        </div>
      </TimelineFrame>
    );
  }

  if (timelineQuery.error || !timelineQuery.data) {
    const message = timelineQuery.error instanceof Error
      ? timelineQuery.error.message
      : 'Unable to load review timeline';
    return (
      <TimelineFrame backLink={backLink}>
        <LiveRegion message={message} level="assertive" />
        <section className="card timeline-error">
          <h2>Unable to load this timeline</h2>
          <p>{message}</p>
          <button
            type="button"
            className="btn btn-secondary timeline-error__retry"
            onClick={() => void timelineQuery.refetch()}
          >
            Try again
          </button>
        </section>
      </TimelineFrame>
    );
  }

  const timeline = timelineQuery.data;
  const reviewerName = timeline.review.reviewerName ?? 'Anonymous reviewer';
  const autoPostDeadlineMs = getAutoPostDeadlineMs(timeline.response);
  const autoPostDeadlineLabel =
    clockNowMs !== null && autoPostDeadlineMs !== null && autoPostDeadlineMs > clockNowMs
      ? formatDeadline(autoPostDeadlineMs, new Date(clockNowMs))
      : null;

  return (
    <TimelineFrame backLink={backLink}>
        <section className="card timeline-review" aria-labelledby="timeline-review-heading">
          <div className="timeline-review__primary">
            <div>
              <p className="timeline-review__eyebrow">Review</p>
              <h2 id="timeline-review-heading">{reviewerName}</h2>
            </div>
            <ReviewRating rating={timeline.review.rating} />
          </div>
          <dl className="timeline-review__facts">
            <div><dt>Submitted</dt><dd>{formatDate(timeline.review.submittedAt)}</dd></div>
            <div><dt>Review status</dt><dd>{formatIdentifier(timeline.review.status)}</dd></div>
            {timeline.response && (
              <>
                <div><dt>Reply status</dt><dd>{formatIdentifier(timeline.response.status)}</dd></div>
                {timeline.response.postedAt && (
                  <div><dt>Posted at</dt><dd>{formatDate(timeline.response.postedAt)}</dd></div>
                )}
              </>
            )}
          </dl>
          {autoPostDeadlineLabel !== null && (
            <div className="timeline-scheduled" role="status">
              <p className="timeline-scheduled__title">
                Scheduled to auto-post at {autoPostDeadlineLabel}
              </p>
              <p className="timeline-scheduled__hint">
                To cancel, use Cancel auto-post in the notification we sent you.
              </p>
            </div>
          )}
          {timeline.response && (
            <div className="timeline-review__response">
              <span>Current reply</span>
              <p>{timeline.response.responseText}</p>
            </div>
          )}
        </section>

        {timeline.escalation && (
          <section className={`timeline-escalation timeline-escalation--${timeline.escalation.severity}`}>
            <div className="timeline-escalation__icon" aria-hidden="true"><ShieldIcon /></div>
            <div className="timeline-escalation__content">
              <p className="timeline-escalation__persona">Guardian</p>
              <h2>{timeline.escalation.status === 'resolved' ? 'Escalation resolved' : 'This review needs attention'}</h2>
              <dl className="timeline-escalation__facts">
                <div><dt>Severity</dt><dd>{formatIdentifier(timeline.escalation.severity)}</dd></div>
                <div><dt>Suggested action</dt><dd>{formatIdentifier(timeline.escalation.suggestedAction)}</dd></div>
              </dl>
            </div>
            {timeline.escalation.status !== 'resolved' && (
              <TimelineEscalationActions
                escalation={timeline.escalation}
                onRefresh={() => timelineQuery.refetch()}
              />
            )}
          </section>
        )}

        {timeline.runs.length === 0 ? (
          <section className="card timeline-empty">
            <div className="timeline-empty__icon" aria-hidden="true"><ClockIcon /></div>
            <h2>This review predates the agent timeline</h2>
            <p>Its review and reply are still shown above, but there are no recorded agent steps for it.</p>
          </section>
        ) : (
          <section className="timeline-runs" aria-label="Agent runs">
            {timeline.runs.map((run, index) => (
              <RunTimeline key={run.id} run={run} ordinal={index + 1} />
            ))}
          </section>
        )}
    </TimelineFrame>
  );
}

async function fetchReviewTimeline(reviewId: string): Promise<ReviewTimeline> {
  const result = await fetch(`/api/dashboard/reviews/${reviewId}/timeline`);
  if (!result.ok) {
    const body: unknown = await result.json().catch(() => null);
    const error = body != null && typeof body === 'object' ? Reflect.get(body, 'error') : null;
    throw new Error(typeof error === 'string' ? error : `Unable to load review timeline (${result.status})`);
  }
  return result.json() as Promise<ReviewTimeline>;
}

function ReviewRating({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="timeline-review__no-rating">No rating</span>;
  const rounded = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="timeline-review__rating" aria-label={`${rating} out of 5 stars`}>
      <span aria-hidden="true">{'★'.repeat(rounded)}{'☆'.repeat(5 - rounded)}</span>
    </span>
  );
}

function formatDate(value: string | null): string {
  if (!value) return 'Not recorded';
  return REVIEW_DATE_FORMATTER.format(new Date(value));
}

// Mirrors ReviewFeedCard's scheduled-post gate: only an approved auto-policy
// reply carries a deadline, and only a future one (vs the client clock) earns
// the banner.
function getAutoPostDeadlineMs(response: ReviewTimelineResponse | null): number | null {
  if (response === null || response.status !== 'approved') return null;
  if (response.approvalMethod !== 'auto_policy' || response.autoPostScheduledAt == null) {
    return null;
  }
  const deadlineMs = new Date(response.autoPostScheduledAt).getTime();
  return Number.isFinite(deadlineMs) ? deadlineMs : null;
}

// Client clock, same subscription shape as ReviewFeedCard's useReviewFeedClock:
// starts null (SSR-safe), ticks via a timeout callback, and re-arms to just
// past the deadline so the banner retires live instead of on the next fetch.
function useAutoPostClock(response: ReviewTimelineResponse | null): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let timeoutId: number;
    const refresh = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      const deadline = getAutoPostDeadlineMs(response);
      if (deadline !== null && deadline > currentTime) {
        timeoutId = window.setTimeout(
          refresh,
          Math.min(deadline - currentTime + 1, 2_147_483_647),
        );
      }
    };
    timeoutId = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(timeoutId);
  }, [response]);

  return now;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="m12.5 5-5 5 5 5M8 10h7" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12 3.5 19 6v5.2c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V6l7-2.5Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
