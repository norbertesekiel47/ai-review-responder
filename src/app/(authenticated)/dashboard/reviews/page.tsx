import { ReviewsContent } from '@/components/dashboard/reviews/ReviewsContent';

export const dynamic = 'force-dynamic';

export default function ReviewsPage() {
  // Both Reviews tabs render unconditionally as of #678 — PAST_REPLIES_VIEW_ENABLED
  // is retired, so there is no flag read left to pass down.
  return <ReviewsContent />;
}
