'use client';

import { ReviewFeedCard, type ReviewFeedItem } from '@/components/dashboard/reviews/ReviewFeedCard';

interface Props {
  items: readonly ReviewFeedItem[];
  pendingTotal: number;
  total: number;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
  onActionSuccess: () => void | Promise<void>;
  readOnly?: boolean;
}

/** VAL-DASH-013: Global pending-approval feed combines all locations.
 *  VAL-DASH-014: Location chips in approval feed use display_label. */
export function AggregateReviewsCard({
  items,
  pendingTotal,
  total,
  hasMore,
  loadingMore = false,
  onLoadMore,
  onActionSuccess,
  readOnly = false,
}: Props) {
  return (
    <ReviewFeedCard
      items={items}
      pendingTotal={pendingTotal}
      total={total}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      onActionSuccess={onActionSuccess}
      emptyText="No replies waiting on you across any location. We'll let you know when a new draft is ready."
      readOnly={readOnly}
    />
  );
}
