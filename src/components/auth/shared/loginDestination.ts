import type { AuthFlow } from '@/lib/shared/auth-flow';

const OWNER_ALLOWED_PREFIXES = ['/dashboard', '/settings', '/onboarding'] as const;
const ADMIN_AUTH_PAGES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'] as const;

export function resolvePostLoginDestination(
  portal: AuthFlow,
  from: string,
  defaultRoute: string,
): string {
  if (!from.startsWith('/') || from.startsWith('//')) {
    return defaultRoute;
  }
  if (portal === 'owner') {
    const allowed = OWNER_ALLOWED_PREFIXES.some((prefix) => from.startsWith(prefix));
    return allowed ? from : defaultRoute;
  }
  if (!from.startsWith('/admin')) {
    return defaultRoute;
  }
  const isAuthPage = ADMIN_AUTH_PAGES.some(
    (page) => from === page || from.startsWith(`${page}/`),
  );
  return isAuthPage ? defaultRoute : from;
}

export interface SignupStatusPayload {
  subscriptionStatus?: string;
  businessOnboarded?: boolean;
  /**
   * The funnel destination, computed by GET /api/auth/signup-status via
   * `resolveFunnelEntry`. Optional on the wire on purpose — see the absence
   * rule in `applySubscriptionGuard`.
   */
  funnelUrl?: string;
}

/**
 * Post-login override: where the server says this owner belongs, or null to let
 * `resolvePostLoginDestination` honour the requested `from`.
 *
 * This function used to re-decide the funnel client-side (`pending_payment →
 * /onboarding/pay`, `full access + !businessOnboarded → /onboarding/business`).
 * Both branches are gone: they were demo-blind — the browser cannot read
 * `ONBOARDING_DEMO_ENABLED` (invariant #13), so an invitee owed the demo lane
 * was sent straight to the paywall. `funnelUrl` is the server's answer to the
 * same question and covers both old branches plus the demo states.
 *
 * What stays here, because it is NOT the server's business:
 *   - `portal !== 'owner'` — the admin portal has no funnel.
 *   - `from.startsWith('/onboarding')` — an explicit in-funnel return path the
 *     owner asked for wins over the computed entry point.
 *
 * ABSENCE RULE: no `funnelUrl` (an older cached response, or the soft-failed
 * fetch in `useLoginSubmit`) means NO OVERRIDE — deliberately, not by accident.
 * `useLoginSubmit` already swallows a failed/non-ok signup-status fetch and
 * falls through to `resolvePostLoginDestination`; treating a missing field the
 * same way keeps one soft-fail posture instead of two. The cost is bounded: the
 * owner lands on `/dashboard`, whose own account-state screens (pending-payment
 * / active-pending-business) carry the same server-computed next action.
 */
export function applySubscriptionGuard(
  portal: AuthFlow,
  status: SignupStatusPayload | undefined,
  from = '',
): string | null {
  if (portal !== 'owner' || !status) return null;
  if (from.startsWith('/onboarding') && !from.startsWith('//')) return null;

  const funnelUrl = status.funnelUrl;
  // Same shape check `resolvePostLoginDestination` applies to `from`: the
  // result is handed to `router.push`, so only a same-origin absolute path may
  // pass, never a protocol-relative URL.
  if (typeof funnelUrl !== 'string' || !funnelUrl.startsWith('/') || funnelUrl.startsWith('//')) {
    return null;
  }
  // '/dashboard' is the helper's "nothing to do" answer. Returning it as an
  // override would clobber a legitimate `from` (e.g. /settings/voice), so it
  // maps back to "no override" — the pre-existing behaviour for a fully
  // onboarded owner.
  return funnelUrl === '/dashboard' ? null : funnelUrl;
}
