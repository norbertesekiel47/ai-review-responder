import { ReviewsContent } from '@/components/dashboard/reviews/ReviewsContent';
import { pastRepliesViewEnabled } from '@/lib/past-replies/flags';

export const dynamic = 'force-dynamic';

export default function ReviewsPage() {
  // Server-authoritative flag read (invariant #13): the History tab is shown only
  // when Past Replies is enabled. Passed down so the client never infers it.
  return <ReviewsContent historyEnabled={pastRepliesViewEnabled()} />;
}
