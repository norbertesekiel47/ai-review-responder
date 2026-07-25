/**
 * The location-scope query param, for the Solicitation client islands that have
 * to SEND it.
 *
 * This constant is a MIRROR, not the owner. The authoritative reader is
 * `resolveDashboardRequest` (src/app/api/dashboard/policy.ts), which parses the
 * literal `'scope'` for every dashboard route; this file exists so the
 * Solicitation clients stop re-typing that literal, and it must stay in
 * lockstep with policy.ts — changing the param name means changing both, and
 * the route tests asserting the round-trip are what catch a drift.
 *
 * Pinned because the failure it prevents is silent: policy.ts falls back to the
 * owner's default location when the param is absent or misspelled, so a client
 * that gets the name wrong reads — or writes — a different location while every
 * response still looks healthy.
 *
 * Deliberately free of server imports so client islands can use it without
 * pulling the DB client into the browser bundle.
 */

export const SOLICITATION_SCOPE_PARAM = 'scope';

/** Appends the location scope to a Solicitation API path. */
export function withSolicitationScope(path: string, locationId: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${SOLICITATION_SCOPE_PARAM}=${encodeURIComponent(locationId)}`;
}
