import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { editRepliesEnabled, pastRepliesViewEnabled } from '@/lib/past-replies/flags';
import { loadPastRepliesPageView } from '@/lib/past-replies/load-replies';
import { parsePageParam } from '@/lib/past-replies/replies-view';
import { PastRepliesClient } from './PastRepliesClient';

export const dynamic = 'force-dynamic';

export default async function PastRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  if (!pastRepliesViewEnabled()) notFound();

  const owner = await requireOwnerAccess(sql);
  const { page } = await searchParams;
  const view = await loadPastRepliesPageView({
    accountId: owner.accountId,
    locationId: owner.currentLocationId,
    page: parsePageParam(page),
  });
  if (!view) notFound();

  return (
    <>
      <TopBar
        title="Past Replies"
        subtitle={`Every reply posted to Google for ${view.locationDisplayName} — including replies you made before connecting RepWorth.`}
      />
      <div className="reviews-subnav">
        <ReviewsTabs active="history" historyEnabled />
        {/* History is single-location by construction (every query is
            business_id-scoped). In aggregate scope this shows the current/primary
            location only; switch it via the sidebar LocationPicker. */}
        <span className="reviews-showing" title="Switch locations from the picker in the sidebar.">
          Showing: <strong>{view.locationDisplayName}</strong> <span aria-hidden="true">▾</span>
        </span>
      </div>
      <PastRepliesClient
        gapRows={view.gapRows}
        histRows={view.histRows}
        gapTotal={view.gapTotal}
        histTotal={view.histTotal}
        hasHistoricalSection={view.hasHistoricalSection}
        hasGapOrphans={view.hasGapOrphans}
        avgStarRating={view.avgStarRating}
        isPremium={view.isPremium}
        page={view.page}
        totalPages={view.totalPages}
        editRepliesEnabled={editRepliesEnabled()}
      />
    </>
  );
}
