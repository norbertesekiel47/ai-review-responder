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
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { RequestsTabs } from '../RequestsTabs';
import { ReviewQrClient } from './ReviewQrClient';
// `ReviewQrClient` is built from `SettingsShell` + the `.set-section`
// primitives, which live in settings.css — imported by `settings/layout.tsx`
// and by NOBODY else. `(authenticated)/layout.tsx` loads tokens + console.css
// only, so moving this page out of `settings/` stripped its stylesheet and it
// rendered unstyled. No gate row catches that: jsdom loads no CSS and the
// build does not care. Same fix as `dashboard/add-location/page.tsx:22`.
import '@/app/(authenticated)/_styles/settings.css';

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
          Requests surfaces (#1089).

          Gated because this page is NOT gated. Review QR is visible to every
          owner (CONTEXT.md), while `/dashboard/requests` and its contacts child
          both `notFound()` with watch-mode off — so an ungated bar would offer
          two dead pills. */}
      {solicitationWatchEnabled() && <RequestsTabs active="qr" />}
      <ReviewQrClient locations={locations} />
    </>
  );
}
