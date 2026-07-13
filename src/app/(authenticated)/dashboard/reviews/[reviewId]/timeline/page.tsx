import { TimelineContent } from '@/components/dashboard/timeline/TimelineContent';

export const dynamic = 'force-dynamic';

export default async function ReviewTimelinePage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  return <TimelineContent reviewId={reviewId} />;
}
