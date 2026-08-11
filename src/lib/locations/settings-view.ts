// src/lib/locations/settings-view.ts
//
// Data loader for the owner's Settings → Locations tab. The page component is a
// thin shell over this module, mirroring src/lib/past-replies/load-replies.ts:
// the page gates the flag, resolves the owner, and renders; every query and
// every row→entry mapping lives here.
//
// Invariant #15: the DB client arrives as an explicit `sql: Sql` parameter —
// this module never imports `@/lib/db/server`; the page is the composition root
// that passes the singleton down.

import type { Sql } from 'postgres';
import type {
  ArchivedLocationEntry,
  LocationEntry,
} from '@/components/dashboard/settings/LocationsPanel';
import { isSubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import {
  getActiveLocationCount,
  getArchivedLocationsForAccount,
  getLocationsForAccount,
} from './repo';

/** Everything the Locations tab renders, resolved for one account. */
export interface LocationsSettingsView {
  locations: LocationEntry[];
  archivedLocations: ArchivedLocationEntry[];
  activeCount: number;
  /** Validated tier — the caller feeds it to `resolveAddLocationState`. */
  subscriptionTier: SubscriptionTierValue;
  subscriptionStatus: string;
}

/**
 * Loads the Locations tab for one account.
 *
 * SEQUENTIAL — do NOT re-introduce a `Promise.all` here (#505). Every query
 * below runs on the SAME `sql` client the page passes down (the singleton,
 * whose pool is `DB_POOL_MAX` = 3 on Vercel — NOT the larger `sqlRead`), and
 * this wave is FOUR members: the three `repo` reads plus the account
 * tier/status lookup. Fan-out (4) > pool (3), so over the Supabase Supavisor
 * TRANSACTION pooler postgres.js pipelines the excess onto an already-open
 * connection (`handler()` picks a `busy` connection rather than queueing) and
 * the pipelined response parks server-side in state=active /
 * wait_event=ClientRead forever. `statement_timeout` can never fire — in
 * ClientRead the statement is not executing — so each render permanently leaks
 * a pool slot until the pool starves.
 *
 * The two id-dependent reads that follow (Zernio status, pending-approval
 * counts) were already sequential and stay that way; they cannot be hoisted
 * into the wave regardless, since they need the resolved location ids.
 *
 * Throws `invalid_ws8_subscription_tier:<value>` when the account is missing or
 * carries a tier outside the WS8 vocabulary — same contract as
 * `loadPastRepliesPageView`.
 */
export async function loadLocationsSettingsView(
  sql: Sql,
  accountId: string,
): Promise<LocationsSettingsView> {
  const locations = await getLocationsForAccount(sql, accountId);
  const activeCount = await getActiveLocationCount(sql, accountId);
  const archivedLocations = await getArchivedLocationsForAccount(sql, accountId);
  const [account] = await sql<{ subscription_tier: string; subscription_status: string }[]>`
    SELECT subscription_tier, subscription_status
    FROM accounts
    WHERE id = ${accountId}::uuid
    LIMIT 1
  `;

  if (!account || !isSubscriptionTier(account.subscription_tier)) {
    throw new Error(
      `invalid_ws8_subscription_tier:${account?.subscription_tier ?? 'missing'}`,
    );
  }

  // Zernio connection status for every location, active AND archived — one
  // ANY(...) read rather than one per location.
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

  // VAL-LOC-067: pending approval count per location, for the archive dialog.
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

  return {
    locations: locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      displayLabel: loc.display_label,
      address: loc.google_place_address,
      isPrimary: loc.is_primary,
      googlePlaceId: loc.google_place_id,
      zernioStatus: (zernioMap.get(loc.id) ?? 'none') as LocationEntry['zernioStatus'],
      pendingApprovalCount: pendingApprovalMap.get(loc.id) ?? 0,
    })),
    // VAL-SETTINGS-038: archived locations render in a separate collapsed section.
    archivedLocations: archivedLocations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      displayLabel: loc.display_label,
      address: loc.google_place_address,
      archivedAt: loc.archived_at?.toISOString() ?? null,
    })),
    activeCount,
    subscriptionTier: account.subscription_tier,
    subscriptionStatus: account.subscription_status,
  };
}
