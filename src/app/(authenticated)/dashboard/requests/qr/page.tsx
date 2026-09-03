// src/app/(authenticated)/dashboard/requests/qr/page.tsx
//
// Review QR settings section (CONTEXT.md "Review QR"): one card per
// non-archived location. Deliberately NOT behind shouldShowLocationsSettings
// — single-location owners are the launch majority and get their QR here.
// requireOwnerAccess redirects pending_payment owners to /onboarding/pay —
// the STANDARD settings posture (intake edge case corrected in codex R1);
// the customer-facing redirect is gated independently by
// subscriptionAllowsQrRedirect.

import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { getOwnerReviewQrLocations } from '@/lib/locations/review-qr';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { RequestsTabs } from '../RequestsTabs';
import { ReviewQrClient } from './ReviewQrClient';

export default async function ReviewQrPage() {
  const access = await requireOwnerAccess(sql);
  const locations = await getOwnerReviewQrLocations(
    sql,
    access.accountId,
    process.env.NEXT_PUBLIC_APP_URL ?? '',
  );
  return (
    <>
      <TopBar
        title="Review QR"
        subtitle="Printable QR codes that send customers to your Google review page."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      {/* The routed bar is hidden on desktop, where the sidebar children carry
          navigation. Below the breakpoint it is the ONLY way to the sibling
          Requests surfaces (#1089). */}
      <RequestsTabs active="qr" />
      <ReviewQrClient locations={locations} />
    </>
  );
}
