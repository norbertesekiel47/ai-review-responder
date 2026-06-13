'use client';

import { SegmentErrorState } from '@/components/dashboard/SegmentErrorState';

export default function SettingsError({
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
      title="Settings didn't load"
      description="We couldn't load this settings page. Nothing was changed — try again, or head back to your dashboard."
      secondaryHref="/dashboard"
      secondaryLabel="Back to dashboard"
    />
  );
}
