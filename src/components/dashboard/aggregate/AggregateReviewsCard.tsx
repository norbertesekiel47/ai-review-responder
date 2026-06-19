'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { ReviewFeedCard } from '@/components/dashboard/reviews/ReviewFeedCard';

interface Props {
  recentReviews: AggregateDashboardData['recentReviews'];
  onActionSuccess: () => void;
  readOnly?: boolean;
}

/** VAL-DASH-013: Global pending-approval feed combines all locations.
 *  VAL-DASH-014: Location chips in approval feed use display_label. */
export function AggregateReviewsCard({
  recentReviews,
  onActionSuccess,
  readOnly = false,
}: Props) {
  return (
    <ReviewFeedCard
      recentReviews={recentReviews}
      onActionSuccess={onActionSuccess}
      emptyText="No replies waiting on you across any location. We'll email when a new draft is ready."
      readOnly={readOnly}
    />
  );
}
