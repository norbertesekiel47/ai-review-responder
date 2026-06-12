'use client';

import { SegmentErrorState } from '@/components/dashboard/SegmentErrorState';

export default function AuthenticatedError({
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
      title="Something went wrong"
      description="We couldn't load this page. This one's on us, try again, or head back to your dashboard."
      secondaryHref="/dashboard"
      secondaryLabel="Back to dashboard"
    />
  );
}
