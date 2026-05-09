// src/lib/channels/unique-violation.ts
//
// Typed errors + Postgres 23505 detector for the multi-channel enrollment
// surface (Phase 4, migration 027 → migration 034). The shared transaction
// helpers and route handlers use `classifyEnrollmentError(err)` to convert
// raw Postgres errors into typed exceptions:
//
//   - 23505 + constraint_name matching MOBILE_CONSTRAINT_NAMES
//     (either 'channel_enrollments_one_mobile_per_biz' or
//      'channel_enrollments_one_mobile_per_scope')
//     → MultipleMobileChannelsError (route maps to 409)
//   - 23505 + ANY other constraint name → EnrollmentDatabaseError (route
//     maps to 500 with no body leakage of constraint_name)
//   - Anything else → re-thrown unchanged
//
// See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §6.1 row 13.

const PG_UNIQUE_VIOLATION = '23505';

// Migration 027 created channel_enrollments_one_mobile_per_biz (per-business).
// Migration 034 dropped it and created channel_enrollments_one_mobile_per_scope
// (per-account+scope). Both names map to MultipleMobileChannelsError so that
// the transition period — where either constraint could fire — produces 409
// instead of 500.
const MOBILE_CONSTRAINT_NAMES = new Set([
  'channel_enrollments_one_mobile_per_biz',    // pre-migration-034 (dropped)
  'channel_enrollments_one_mobile_per_scope',  // post-migration-034 (current)
]);

export class MultipleMobileChannelsError extends Error {
  constructor() {
    super('Another mobile channel is already pending or verified for this business.');
    this.name = 'MultipleMobileChannelsError';
  }
}

export class EnrollmentDatabaseError extends Error {
  constructor() {
    // Deliberately generic — never echoes the underlying Postgres message
    // (which would leak constraint_name).
    super('Database error during enrollment.');
    this.name = 'EnrollmentDatabaseError';
  }
}

interface PostgresErrorShape {
  code?: unknown;
  constraint_name?: unknown;
}

function asPostgresError(err: unknown): PostgresErrorShape | null {
  if (err === null || typeof err !== 'object') return null;
  return err as PostgresErrorShape;
}

export function isMultipleMobileChannelsError(err: unknown): boolean {
  const pg = asPostgresError(err);
  if (!pg) return false;
  return pg.code === PG_UNIQUE_VIOLATION
    && typeof pg.constraint_name === 'string'
    && MOBILE_CONSTRAINT_NAMES.has(pg.constraint_name);
}

/**
 * Inspect a thrown value, classify it, and throw a typed error in its place.
 * Always throws — never returns.
 */
export function classifyEnrollmentError(err: unknown): never {
  const pg = asPostgresError(err);
  if (pg && pg.code === PG_UNIQUE_VIOLATION) {
    if (typeof pg.constraint_name === 'string' && MOBILE_CONSTRAINT_NAMES.has(pg.constraint_name)) {
      throw new MultipleMobileChannelsError();
    }
    throw new EnrollmentDatabaseError();
  }
  throw err;
}
