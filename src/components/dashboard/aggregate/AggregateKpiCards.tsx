'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { ValueKpiGrid } from '@/components/dashboard/kpi/ValueKpiGrid';

interface Props {
  valueSummary: AggregateDashboardData['valueSummary'];
  activeLocationCount: number;
}

export function AggregateKpiCards({ valueSummary, activeLocationCount }: Props) {
  return (
    <ValueKpiGrid
      valueSummary={valueSummary}
      reviewsHandledFoot={`across ${activeLocationCount} location${activeLocationCount !== 1 ? 's' : ''}`}
      timeSavedFoot="total across all locations"
    />
  );
}
