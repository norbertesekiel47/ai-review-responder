// Settings → Competitors (#546). Composition root: it owns the `sql` singleton
// and hands it to `loadRivalPickerViews`, which loads every active location's
// view SEQUENTIALLY — the page does not fan out (#773).
//
// No feature flag and no notFound() gate — the Named rival picker is available
// to every owner.

import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { loadRivalPickerViews } from '@/lib/competitors/named-rival';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { asLocationId } from '@/lib/shared/ids';
import { CompetitorsClient } from './CompetitorsClient';

export const dynamic = 'force-dynamic';

export default async function CompetitorsSettingsPage() {
  const access = await requireOwnerAccess(sql);

  // getLocationsForAccount already excludes archived locations (archived rows
  // have their own reader) — no second filter here.
  const locations = await getLocationsForAccount(sql, access.accountId);
  const views = await loadRivalPickerViews(sql, {
    accountId: access.accountId,
    businessIds: locations.map((location) => asLocationId(location.id)),
  });

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
      />
    </>
  );
}
