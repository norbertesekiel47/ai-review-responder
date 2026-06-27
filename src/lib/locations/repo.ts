// src/lib/locations/repo.ts
//
// Data access layer for location (businesses) queries.
// Every piece of code that needs to query locations must use this module —
// never write ad-hoc location SQL outside this file (per AGENTS.md).
//
// Exports:
//   getActiveLocationCount(accountId) — count non-archived locations
//   getLocationsForAccount(accountId) — ordered list (primary first, then created_at)
//   getLocationById(locationId) — single location lookup
//
// Validation contract: indirectly covers location query assertions in
// VAL-LOC-001 through VAL-LOC-012 (quota checks depend on accurate counts).

import { sql } from '@/lib/db/server';

// ── Location row type ──────────────────────────────────────────────────────

export interface LocationRow {
  id: string;
  account_id: string;
  name: string;
  display_label: string | null;
  is_primary: boolean;
  archived_at: Date | null;
  google_place_id: string | null;
  google_place_address: string | null;
  created_at: Date;
}

// ── getActiveLocationCount ─────────────────────────────────────────────────

/**
 * Returns the count of active (non-archived) locations for the given account.
 * Excludes locations where archived_at IS NOT NULL.
 *
 * Used by assertCanAddLocation for quota checks and by billing snapshot
 * computation.
 */
export async function getActiveLocationCount(
  accountId: string,
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
  `;

  return Number(row?.count ?? 0);
}

// ── getLocationsForAccount ──────────────────────────────────────────────────

/**
 * Returns all active (non-archived) locations for an account, ordered by:
 *   1. is_primary DESC (primary first)
 *   2. created_at ASC (oldest secondary first)
 *
 * Used by the location switcher, settings page, and dashboard aggregate view.
 */
export async function getLocationsForAccount(
  accountId: string,
): Promise<LocationRow[]> {
  const rows = await sql<LocationRow[]>`
    SELECT
      id,
      account_id,
      name,
      display_label,
      is_primary,
      archived_at,
      google_place_id,
      google_place_address,
      created_at
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NULL
    ORDER BY is_primary DESC, created_at ASC
  `;

  return rows;
}

// ── getArchivedLocationsForAccount ──────────────────────────────────────────

/**
 * Returns all archived locations for an account, ordered by archived_at DESC
 * (most recently archived first).
 *
 * Used by the Settings → Locations tab to display the "Archived" section.
 */
export async function getArchivedLocationsForAccount(
  accountId: string,
): Promise<LocationRow[]> {
  const rows = await sql<LocationRow[]>`
    SELECT
      id,
      account_id,
      name,
      display_label,
      is_primary,
      archived_at,
      google_place_id,
      google_place_address,
      created_at
    FROM businesses
    WHERE account_id = ${accountId}::uuid
      AND archived_at IS NOT NULL
    ORDER BY archived_at DESC
  `;

  return rows;
}

// ── getAllLocationsForAccount ──────────────────────────────────────────────

/**
 * Returns ALL locations for an account — active AND archived — in one query,
 * ordered primary-first then created_at ASC. Callers that need both
 * populations at once (e.g. label resolution for channel overrides) should
 * use this instead of getLocationsForAccount + getArchivedLocationsForAccount.
 */
export async function getAllLocationsForAccount(
  accountId: string,
): Promise<LocationRow[]> {
  const rows = await sql<LocationRow[]>`
    SELECT
      id,
      account_id,
      name,
      display_label,
      is_primary,
      archived_at,
      google_place_id,
      google_place_address,
      created_at
    FROM businesses
    WHERE account_id = ${accountId}::uuid
    ORDER BY is_primary DESC, created_at ASC
  `;

  return rows;
}

// ── getLocationById ────────────────────────────────────────────────────────

/**
 * Returns a single location by ID. Returns null if the location does not exist.
 * Does NOT filter by archived_at — archived locations are still accessible
 * (for admin views, audit trails, and approval link resolution).
 *
 * Used by getLocationContext, approval flow, and admin detail pages.
 */
export async function getLocationById(
  locationId: string,
): Promise<LocationRow | null> {
  const [row] = await sql<LocationRow[]>`
    SELECT
      id,
      account_id,
      name,
      display_label,
      is_primary,
      archived_at,
      google_place_id,
      google_place_address,
      created_at
    FROM businesses
    WHERE id = ${locationId}::uuid
  `;

  return row ?? null;
}
