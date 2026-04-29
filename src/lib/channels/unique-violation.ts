// src/lib/channels/unique-violation.ts
//
// Typed errors + Postgres 23505 detector for the multi-channel enrollment
// surface (Phase 4, migration 027). The shared transaction helpers and route
// handlers use `classifyEnrollmentError(err)` to convert raw Postgres errors
// into typed exceptions:
//
//   - 23505 + constraint_name='channel_enrollments_one_mobile_per_biz'
//     → MultipleMobileChannelsError (route maps to 409)
//   - 23505 + ANY other constraint name → EnrollmentDatabaseError (route
//     maps to 500 with no body leakage of constraint_name)
//   - Anything else → re-thrown unchanged
//
// See docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md §6.1 row 13.

const PG_UNIQUE_VIOLATION = '23505';
const ONE_MOBILE_CONSTRAINT = 'channel_enrollments_one_mobile_per_biz';

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
  return pg.code === PG_UNIQUE_VIOLATION && pg.constraint_name === ONE_MOBILE_CONSTRAINT;
}

/**
 * Inspect a thrown value, classify it, and throw a typed error in its place.
 * Always throws — never returns.
 */
export function classifyEnrollmentError(err: unknown): never {
  const pg = asPostgresError(err);
  if (pg && pg.code === PG_UNIQUE_VIOLATION) {
    if (pg.constraint_name === ONE_MOBILE_CONSTRAINT) {
      throw new MultipleMobileChannelsError();
    }
    throw new EnrollmentDatabaseError();
  }
  throw err;
}
