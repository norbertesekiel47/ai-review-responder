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
import { getLocationsForAccount, getActiveLocationCount, getArchivedLocationsForAccount } from '@/lib/locations/repo';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';

export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  // Gate by MULTI_LOCATION_ENABLED
  if (process.env.MULTI_LOCATION_ENABLED !== 'true') {
    notFound();
  }

  const access = await requireOwnerAccess();

  // Fetch all active and archived locations for this account
  const [locations, activeCount, archivedLocations] = await Promise.all([
    getLocationsForAccount(access.accountId),
    getActiveLocationCount(access.accountId),
    getArchivedLocationsForAccount(access.accountId),
  ]);

  if (!shouldUseMultiLocationSettings(true, activeCount)) {
    notFound();
  }

  // Fetch Zernio connection status for each location (active + archived)
  const allLocationIds = [...locations, ...archivedLocations].map((l) => l.id);

  let zernioRows: { business_id: string; status: string }[] = [];
  if (allLocationIds.length > 0) {
    zernioRows = await sql<{ business_id: string; status: string }[]>`
      SELECT business_id, status
      FROM zernio_connections
      WHERE business_id = ANY(${allLocationIds}::uuid[])
    `;
  }

  const zernioMap = new Map(zernioRows.map((r) => [r.business_id, r.status]));

  // VAL-LOC-067: Fetch pending approval count per location for archive dialog
  let pendingApprovalRows: { business_id: string; count: number }[] = [];
  if (allLocationIds.length > 0) {
    pendingApprovalRows = await sql<{ business_id: string; count: number }[]>`
      SELECT business_id, COUNT(*)::int AS count
      FROM responses
      WHERE business_id = ANY(${allLocationIds}::uuid[])
        AND status = 'pending_approval'
      GROUP BY business_id
    `;
  }
  const pendingApprovalMap = new Map(pendingApprovalRows.map((r) => [r.business_id, r.count]));

  const locationEntries = locations.map((loc) => ({
    id: loc.id,
    name: loc.name,
    displayLabel: loc.display_label,
    address: loc.google_place_address,
    isPrimary: loc.is_primary,
    googlePlaceId: loc.google_place_id,
    zernioStatus: (zernioMap.get(loc.id) ?? 'none') as 'none' | 'pending' | 'active' | 'disconnected',
    pendingApprovalCount: pendingApprovalMap.get(loc.id) ?? 0,
  }));

  // VAL-SETTINGS-038: Archived locations shown in separate collapsed section
  const archivedEntries = archivedLocations.map((loc) => ({
    id: loc.id,
    name: loc.name,
    displayLabel: loc.display_label,
    address: loc.google_place_address,
    archivedAt: loc.archived_at?.toISOString() ?? null,
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
        archivedLocations={archivedEntries}
        activeCount={activeCount}
        accountId={access.accountId}
      />
    </>
  );
}
