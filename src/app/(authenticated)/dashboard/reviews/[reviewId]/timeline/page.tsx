import { TimelineContent } from '@/components/dashboard/timeline/TimelineContent';

export const dynamic = 'force-dynamic';

/**
 * `?from=` names the surface the owner arrived from (`dashboard`, `history`,
 * `reviews`) so the back link returns there (UX audit D21). Resolved against a
 * closed allowlist in `TimelineContent` — the raw value is never an href.
 */
export default async function ReviewTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { reviewId } = await params;
  const { from } = await searchParams;
  return <TimelineContent reviewId={reviewId} from={from ?? null} />;
}
