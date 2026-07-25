// Settings → Competitors (#546). Composition root: it owns the `sql` singleton
// and hands it to `loadRivalPickerView`, one call per active location.
//
// No feature flag and no notFound() gate — the Named rival picker is available
// to every owner.

import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { loadRivalPickerView } from '@/lib/competitors/named-rival';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { multiLocationEnabled } from '@/lib/locations/flags';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { asLocationId } from '@/lib/shared/ids';
import { CompetitorsClient } from './CompetitorsClient';

export const dynamic = 'force-dynamic';

export default async function CompetitorsSettingsPage() {
  const access = await requireOwnerAccess(sql);

  // getLocationsForAccount already excludes archived locations (archived rows
  // have their own reader) — no second filter here.
  const locations = await getLocationsForAccount(sql, access.accountId);
  const views = await Promise.all(
    locations.map((location) => loadRivalPickerView(sql, {
      accountId: access.accountId,
      businessId: asLocationId(location.id),
    })),
  );

  return (
    <>
      <TopBar
        title="Competitors"
        subtitle="Choose which local-pack rival your weekly digest reports on."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <CompetitorsClient
        views={views}
        locations={locations.map((location) => ({
          id: location.id,
          name: getDisplayLabel(location),
        }))}
        multiLocation={shouldUseMultiLocationSettings(multiLocationEnabled(), locations.length)}
      />
    </>
  );
}
