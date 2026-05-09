// src/app/(authenticated)/settings/locations/page.tsx
//
// Server component for the Locations tab in Settings.
// Gated by MULTI_LOCATION_ENABLED flag — returns notFound() when disabled.
//
// VAL-SETTINGS-008: Locations tab lists all active locations.
// VAL-SETTINGS-009: Primary location is visually marked.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { LocationsClient } from './LocationsClient';
import { getLocationsForAccount, getActiveLocationCount } from '@/lib/locations/repo';

export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  // Gate by MULTI_LOCATION_ENABLED
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    notFound();
  }

  const access = await requireOwnerAccess();

  // Fetch all active locations for this account
  const [locations, activeCount] = await Promise.all([
    getLocationsForAccount(access.accountId),
    getActiveLocationCount(access.accountId),
  ]);

  // Fetch Zernio connection status for each location
  const locationIds = locations.map((l) => l.id);

  let zernioRows: { business_id: string; status: string }[] = [];
  if (locationIds.length > 0) {
    zernioRows = await sql<{ business_id: string; status: string }[]>`
      SELECT business_id, status
      FROM zernio_connections
      WHERE business_id = ANY(${locationIds}::uuid[])
    `;
  }

  const zernioMap = new Map(zernioRows.map((r) => [r.business_id, r.status]));

  const locationEntries = locations.map((loc) => ({
    id: loc.id,
    name: loc.name,
    displayLabel: loc.display_label,
    address: loc.google_place_address,
    isPrimary: loc.is_primary,
    googlePlaceId: loc.google_place_id,
    zernioStatus: (zernioMap.get(loc.id) ?? 'none') as 'none' | 'pending' | 'active' | 'disconnected',
  }));

  return (
    <>
      <TopBar
        title="Settings"
        subtitle="Locations"
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <LocationsClient
        locations={locationEntries}
        activeCount={activeCount}
        accountId={access.accountId}
      />
    </>
  );
}
