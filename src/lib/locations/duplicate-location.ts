// src/lib/locations/duplicate-location.ts
//
// Single owner of the "is this a duplicate active google_place_id?" predicate
// (migration 062's businesses_account_place_uniq partial unique index). Both
// add-location-tx and archive-location-tx (reactivate) catch the same Postgres
// 23505 here and re-throw the typed 'duplicate_location' error, which the
// location routes map to HTTP 409 via LOCATION_DENIAL_STATUS.

/** Constraint guarded against — see migration 062. Module-private: the predicate
 * below is the only consumer, so it stays unexported (no dead public export). */
const DUPLICATE_LOCATION_CONSTRAINT = 'businesses_account_place_uniq';

/**
 * True only for a Postgres unique violation (23505) on the active-duplicate
 * place-id index. Guarding on the CONSTRAINT name keeps any unrelated 23505
 * (e.g. a primary-key or primary-uniqueness violation) from being swallowed.
 */
export function isDuplicateLocationViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === '23505' &&
    typeof e.constraint_name === 'string' &&
    e.constraint_name === DUPLICATE_LOCATION_CONSTRAINT
  );
}

/**
 * Single owner of the 23505 -> typed-error remap. Transaction modules call
 * this from their catch so the 'duplicate_location' literal exists in exactly
 * one place; everything else (routes via LOCATION_DENIAL_STATUS, CSV report)
 * matches on the typed message.
 */
export function rethrowAsDuplicateLocation(err: unknown): never {
  if (isDuplicateLocationViolation(err)) throw new Error('duplicate_location');
  throw err;
}

/** Owner-facing copy for the duplicate_location denial (wizard + panel). */
export const DUPLICATE_LOCATION_MESSAGE =
  'This Google location is already on your account.';
