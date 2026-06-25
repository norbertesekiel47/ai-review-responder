export const AUTH_FLOWS = ['owner', 'admin'] as const;
export type AuthFlow = (typeof AUTH_FLOWS)[number];

export function isAuthFlow(v: string | null | undefined): v is AuthFlow {
  return v === 'owner' || v === 'admin';
}

export function loginUrlForFlow(flow: AuthFlow | undefined): string {
  // Default to /admin/login when flow is unset so legacy callers (proxy
  // redirects, manual URLs without ?flow=) preserve the pre-self-serve admin
  // default. Owner flows always set flow=owner explicitly — spec §3.5.
  return flow === 'owner' ? '/login' : '/admin/login';
}

export function resetPasswordPathForFlow(flow: AuthFlow): string {
  return flow === 'admin' ? '/admin/reset-password' : '/reset-password';
}

export type CallbackResolution =
  | { kind: 'redirect'; destination: string }
  | { kind: 'signout-redirect'; destination: string }
  | { kind: 'finish'; destination: string };

/**
 * Single source of truth for post-auth-callback redirect safety. Callers pass
 * the RAW `next` query param; this function sanitizes it (same-origin internal
 * paths only) and applies the role/path allowlists in the same order the
 * callback route used to inline. `destination` is always an internal path that
 * begins with a single `/` — never an absolute or protocol-relative URL — so a
 * hostile `next` can never escape origin.
 *
 *  - `finish` — Google-signup edge: a session exists but no `users` row yet and
 *    `next` is exactly `/signup/finish`. The route keeps the session.
 *  - `signout-redirect` — no `users` row (any other case) or an unsupported
 *    role. The route must call `supabase.auth.signOut()` before redirecting.
 *  - `redirect` — authenticated owner/admin routed to a role-appropriate path.
 */
export function resolveCallbackDestination(input: {
  role: string | null;
  rawNext: string;
  flow: AuthFlow | undefined;
}): CallbackResolution {
  const { role, rawNext, flow } = input;
  const loginUrl = loginUrlForFlow(flow);

  // Restrict redirect to safe internal paths (no //, no external URLs).
  const nextIsSafe = rawNext.startsWith('/') && !rawNext.startsWith('//');
  const requestedNext = nextIsSafe ? rawNext : '';

  // Google-signup branch: session exists but no users row yet → let the owner
  // finish provisioning instead of signing them out. Only when next explicitly
  // points at /signup/finish; any other "no users row" case signs out below.
  if (role === null && requestedNext === '/signup/finish') {
    return { kind: 'finish', destination: '/signup/finish' };
  }

  // "No users row" in any other flow, or an unsupported runtime role → sign out
  // + account_incomplete. Redirecting anywhere else causes a proxy-redirect loop.
  if (role === null || (role !== 'owner' && role !== 'admin')) {
    return {
      kind: 'signout-redirect',
      destination: `${loginUrl}?error=account_incomplete`,
    };
  }

  if (
    requestedNext === '/reset-password' ||
    requestedNext === '/admin/reset-password'
  ) {
    return { kind: 'redirect', destination: requestedNext };
  }

  // Role-aware destination resolution for supported runtime roles. If `next`
  // points to a role-appropriate path, honor it; otherwise fall back to the
  // role's home page.
  const nextIsAdmin = requestedNext.startsWith('/admin');
  const nextIsOwner =
    requestedNext.startsWith('/dashboard') ||
    requestedNext.startsWith('/settings') ||
    requestedNext.startsWith('/onboarding');

  const destination =
    role === 'owner'
      ? nextIsOwner
        ? requestedNext
        : '/dashboard'
      : nextIsAdmin
        ? requestedNext
        : '/admin/overview';

  return { kind: 'redirect', destination };
}
