'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ReviewFeedCard } from '@/components/dashboard/reviews/ReviewFeedCard';

interface Props {
  recentReviews: DashboardDataActive['recentReviews'];
  onActionSuccess: () => void;
  readOnly?: boolean;
}

export function ReviewsCard({
  recentReviews,
  onActionSuccess,
  readOnly = false,
}: Props) {
  return (
    <ReviewFeedCard
      recentReviews={recentReviews}
      onActionSuccess={onActionSuccess}
      emptyText="No replies waiting on you. We'll email when a new draft is ready, usually within an hour of a new review."
      readOnly={readOnly}
    />
  );
}
