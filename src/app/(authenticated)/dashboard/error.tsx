'use client';

import { SegmentErrorState } from '@/components/dashboard/SegmentErrorState';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SegmentErrorState
      error={error}
      reset={reset}
      title="Your dashboard hit a snag"
      description="We couldn't load your reviews and replies just now. Your data is safe — try again, or come back in a moment."
      secondaryHref="/settings"
      secondaryLabel="Go to settings"
    />
  );
}
