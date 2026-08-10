// src/app/(authenticated)/dashboard/add-location/page.tsx
//
// Server component for the 4-step Add-location wizard.
// Gated by MULTI_LOCATION_ENABLED — returns notFound() when disabled.
//
// The wizard:
//   Step 1: Place autocomplete + display_label input
//   Step 2: Zernio connection (optional, can skip)
//   Step 3: Voice config (ToneChipPicker + ListEditor + copy-from-existing)
//   Step 4: Confirm-and-pay with proration preview
//
// Validation contract: VAL-LOC-041, VAL-LOC-073, VAL-SETTINGS-043,
// VAL-SETTINGS-044.

import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { currentBillingSnapshot } from '@/lib/accounts/quota';
import { getActiveLocationCount } from '@/lib/locations/repo';
import { multiLocationEnabled } from '@/lib/locations/flags';
import { AddLocationWizard } from './AddLocationWizard';
import '@/app/(authenticated)/_styles/settings.css';
import '@/app/(authenticated)/_styles/wizard.css';

export const dynamic = 'force-dynamic';

export default async function AddLocationPage() {
  // VAL-LOC-041: Gate by MULTI_LOCATION_ENABLED flag
  if (!multiLocationEnabled()) {
    notFound();
  }

  const access = await requireOwnerAccess(sql);

  // Fetch billing snapshot for the confirm-and-pay step
  const [billingSnapshot, activeLocationCount] = await Promise.all([
    currentBillingSnapshot(sql, access.accountId),
    getActiveLocationCount(sql, access.accountId),
  ]);

  return (
    <AddLocationWizard
      accountId={access.accountId}
      billingSnapshot={billingSnapshot}
      activeLocationCount={activeLocationCount}
    />
  );
}
