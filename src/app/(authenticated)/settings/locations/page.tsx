// src/app/(authenticated)/settings/locations/page.tsx
//
// Server component for the Locations tab in Settings.
// Gated by MULTI_LOCATION_ENABLED flag — returns notFound() when disabled.
//
// VAL-SETTINGS-008: Locations tab lists all active locations.
// VAL-SETTINGS-009: Primary location is visually marked.

import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LocationsClient } from './LocationsClient';
import type { AddLocationState } from '@/components/dashboard/settings/LocationsPanel';
import { loadLocationsSettingsView } from '@/lib/locations/settings-view';
import { multiLocationEnabled } from '@/lib/locations/flags';
import {
  resolveAddLocationState,
  shouldShowLocationsSettings,
} from '@/lib/locations/multi-location-mode';

export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  const featureEnabled = multiLocationEnabled();
  if (!shouldShowLocationsSettings(featureEnabled)) {
    notFound();
  }

  const access = await requireOwnerAccess(sql);

  // Every query for this page lives in the loader, and runs SEQUENTIALLY on the
  // singleton `sql` (pool = DB_POOL_MAX = 3 on Vercel) — see #505 and the
  // loader's doc comment. Do NOT hoist reads back up here as a Promise.all.
  const view = await loadLocationsSettingsView(sql, access.accountId);

  const voiceHref = '/settings/voice';

  const addLocationStateKind = resolveAddLocationState(
    featureEnabled,
    view.subscriptionTier,
    view.subscriptionStatus,
  );
  const addLocationState: AddLocationState =
    addLocationStateKind === 'enabled'
      ? { kind: 'enabled' }
      : {
          kind: 'locked',
          title: 'Location additions unavailable',
          description: 'Your subscription must be active before adding another location.',
          ctaHref: '/settings/billing',
          ctaLabel: 'Review billing',
        };

  return (
    <>
      <TopBar
        title="Settings"
        subtitle="Locations"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <LocationsClient
        locations={view.locations}
        archivedLocations={view.archivedLocations}
        activeCount={view.activeCount}
        accountId={access.accountId}
        addLocationState={addLocationState}
        voiceHref={voiceHref}
      />
    </>
  );
}
