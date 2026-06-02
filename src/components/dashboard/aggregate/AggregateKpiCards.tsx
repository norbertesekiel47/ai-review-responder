'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { ValueKpiGrid } from '@/components/dashboard/kpi/ValueKpiGrid';

interface Props {
  valueSummary: AggregateDashboardData['valueSummary'];
  pendingCount: number;
  activeLocationCount: number;
  onScrollToReviews: () => void;
}

export function AggregateKpiCards({
  valueSummary,
  pendingCount,
  activeLocationCount,
  onScrollToReviews,
}: Props) {
  return (
    <ValueKpiGrid
      valueSummary={valueSummary}
      pendingCount={pendingCount}
      reviewsHandledFoot={`across ${activeLocationCount} location${activeLocationCount !== 1 ? 's' : ''}`}
      timeSavedFoot="total across all locations"
      onScrollToReviews={onScrollToReviews}
    />
  );
}
