// src/lib/locations/duplicate-location.ts
//
// Single owner of the "is this a duplicate active google_place_id?" predicate
// (migration 062's businesses_account_place_uniq partial unique index). Both
// add-location-tx and archive-location-tx (reactivate) catch the same Postgres
// 23505 here and re-throw the typed 'duplicate_location' error, which the
// location routes map to HTTP 409 via LOCATION_DENIAL_STATUS.

/** Constraint guarded against — see migration 062. */
export const DUPLICATE_LOCATION_CONSTRAINT = 'businesses_account_place_uniq';

/**
 * True only for a Postgres unique violation (23505) on the active-duplicate
 * place-id index. Guarding on the CONSTRAINT name keeps any unrelated 23505
 * (e.g. a primary-key or primary-uniqueness violation) from being swallowed.
 */
export function isDuplicateLocationViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === '23505' && e?.constraint_name === DUPLICATE_LOCATION_CONSTRAINT;
}
