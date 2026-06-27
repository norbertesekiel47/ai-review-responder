// src/lib/auth/get-request-scope.ts
//
// SSR scope helper: reads the 'rw_location_scope' cookie value, validates
// that the location belongs to the user's account and is not archived,
// then falls back to the primary location when validation fails.
//
// Validation contract: VAL-AUTH-024, VAL-AUTH-025, VAL-AUTH-026, VAL-AUTH-027.
//
// Cookie name: 'rw_location_scope' — set by the LocationPicker UI component
// when the owner selects a location from the switcher dropdown.

import { sql } from '@/lib/db/server';
import { asLocationId, isValidUuid } from '@/lib/shared/ids';
import type { AccountId, LocationId } from '@/lib/shared/ids';

export interface RequestScope {
  accountId: AccountId;
  currentLocationId: LocationId;
}

interface LocationRow {
  id: string;
  is_primary: boolean;
  archived_at: Date | null;
}

/**
 * Resolves the current request scope for an authenticated owner.
 *
 * 1. Fetches all locations for the account (non-archived first).
 * 2. If `cookieLocationId` is set and valid:
 *    a. Validates it belongs to this account and is not archived.
 *    b. If valid, returns it as currentLocationId.
 * 3. Falls back to the primary location (or first non-archived location).
 *
 * @param accountId  The owner's account ID (from users.account_id).
 * @param cookieLocationId  The value from the 'rw_location_scope' cookie, or null.
 * @returns { accountId, currentLocationId }
 * @throws Error when the account has no active locations at all.
 */
export async function getRequestScope(
  accountId: AccountId,
  cookieLocationId: LocationId | null,
): Promise<RequestScope> {
  // Fetch all locations for the account, ordered so primary + non-archived come first
  const locations = await sql<LocationRow[]>`
    SELECT id, is_primary, archived_at
    FROM businesses
    WHERE account_id = ${accountId}
    ORDER BY is_primary DESC, archived_at ASC, created_at ASC
  `;

  const activeLocations = locations.filter((loc) => loc.archived_at === null);

  if (activeLocations.length === 0) {
    throw new Error(`No active location found for account ${accountId}`);
  }

  // Determine primary location
  const primary = activeLocations.find((loc) => loc.is_primary)
    ?? activeLocations[0];

  // If cookie is set and is a valid UUID, validate it
  if (cookieLocationId !== null && isValidUuid(cookieLocationId)) {
    const match = activeLocations.find((loc) => loc.id === cookieLocationId);
    if (match) {
      return {
        accountId,
        currentLocationId: asLocationId(match.id),
      };
    }
    // Cookie location is either archived or not in this account → fall back
  }

  // Fall back to primary location (guaranteed to exist since activeLocations.length > 0)
  return {
    accountId,
    currentLocationId: asLocationId(primary!.id),
  };
}
