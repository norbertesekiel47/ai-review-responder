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

export function ReviewsCard({
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
      emptyText="No replies waiting on you. We'll let you know when a new draft is ready, usually within an hour of a new review."
      readOnly={readOnly}
    />
  );
}
