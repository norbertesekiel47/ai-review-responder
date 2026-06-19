import { ReviewsContent } from '@/components/dashboard/reviews/ReviewsContent';

export const dynamic = 'force-dynamic';

export default function ReviewsPage() {
  // Server-authoritative flag read (invariant #13): the History tab is shown only
  // when Past Replies is enabled. Passed down so the client never infers it.
  const historyEnabled = process.env.PAST_REPLIES_VIEW_ENABLED === 'true';
  return <ReviewsContent historyEnabled={historyEnabled} />;
}
