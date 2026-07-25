/**
 * The location-scope query param for the Solicitation dashboard routes.
 *
 * Pinned in one place because the failure it prevents is silent:
 * `resolveDashboardRequest` (src/app/api/dashboard/policy.ts) falls back to the
 * owner's default location when the param is absent or misspelled, so a client
 * that gets the name wrong reads — or writes — a different location while every
 * response still looks healthy. Client fetches build their URLs with
 * `withSolicitationScope`; the route tests assert the round-trip, which is what
 * ties this constant to policy.ts's reader.
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
