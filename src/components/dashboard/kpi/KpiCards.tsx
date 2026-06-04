'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ValueKpiGrid } from '@/components/dashboard/kpi/ValueKpiGrid';

interface Props {
  valueSummary: DashboardDataActive['valueSummary'];
  pendingCount: number;
  onScrollToReviews: () => void;
}

export function KpiCards({ valueSummary, pendingCount, onScrollToReviews }: Props) {
  return (
    <ValueKpiGrid
      valueSummary={valueSummary}
      pendingCount={pendingCount}
      reviewsHandledFoot="since joining RepWorth"
      timeSavedFoot="≈ 4 hours per week back in your day"
      onScrollToReviews={onScrollToReviews}
    />
  );
}
