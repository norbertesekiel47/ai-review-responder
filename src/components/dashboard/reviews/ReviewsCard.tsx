'use client';

import type { Ref } from 'react';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ReviewFeedCard } from '@/components/dashboard/reviews/ReviewFeedCard';

interface Props {
  recentReviews: DashboardDataActive['recentReviews'];
  onActionSuccess: () => void;
  initialTab?: 'needs' | 'all';
  readOnly?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function ReviewsCard({
  recentReviews,
  onActionSuccess,
  initialTab = 'needs',
  readOnly = false,
  ref: scrollRef,
}: Props) {
  return (
    <ReviewFeedCard
      recentReviews={recentReviews}
      onActionSuccess={onActionSuccess}
      emptyText="No replies waiting on you. We'll email when a new draft is ready, usually within an hour of a new review."
      initialTab={initialTab}
      readOnly={readOnly}
      ref={scrollRef}
    />
  );
}
