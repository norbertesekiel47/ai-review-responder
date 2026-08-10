import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { editRepliesEnabled } from '@/lib/past-replies/flags';
import { loadPastRepliesPageView } from '@/lib/past-replies/load-replies';
import { parsePageParam } from '@/lib/past-replies/replies-view';
import { PastRepliesClient } from './PastRepliesClient';
import '@/app/(authenticated)/_styles/past-replies.css';

export const dynamic = 'force-dynamic';

/**
 * `/dashboard/reviews/history` — the **Reviews list**, the owner's single
 * inventory of every review for a location (#678).
 *
 * The `PAST_REPLIES_VIEW_ENABLED` gate is GONE: once the consented Review
 * import's only destination is this surface, a flag that 404s it would let
 * `import_decision='accepted'` coexist with the imported reviews landing on a
 * `notFound()`. `EDIT_REPLIES_ENABLED` is untouched — it gates the live-Google
 * mutation behind `Regenerate`, a different and larger risk, and is passed down
 * as a prop (invariant #13: never a `NEXT_PUBLIC_*` companion).
 */
export default async function PastRepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const owner = await requireOwnerAccess(sql);
  const { page } = await searchParams;
  const view = await loadPastRepliesPageView(sql, {
    accountId: owner.accountId,
    locationId: owner.currentLocationId,
    page: parsePageParam(page),
  });
  if (!view) notFound();

  return (
    <>
      <TopBar
        title="All Reviews"
        subtitle={`Every review for ${view.locationDisplayName} — unanswered first.`}
      />
      <div className="reviews-subnav">
        <ReviewsTabs active="history" />
        {/* The Reviews list is single-location by construction (every query is
            business_id-scoped). In aggregate scope this shows the current/primary
            location only; switch it via the sidebar LocationPicker. */}
        <span className="reviews-showing" title="Switch locations from the picker in the sidebar.">
          Showing: <strong>{view.locationDisplayName}</strong> <span aria-hidden="true">▾</span>
        </span>
      </div>
      <PastRepliesClient
        unansweredRows={view.unansweredRows}
        answeredRows={view.answeredRows}
        unansweredTotal={view.unansweredTotal}
        answeredTotal={view.answeredTotal}
        avgStarRating={view.avgStarRating}
        regenBudgets={view.regenBudgets}
        page={view.page}
        totalPages={view.totalPages}
        editRepliesEnabled={editRepliesEnabled()}
      />
    </>
  );
}
