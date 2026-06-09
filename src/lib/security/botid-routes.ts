// Single source of truth for Vercel BotID-protected routes and their detection
// level. BOTH the client instrumentation (`initBotId` in
// `src/instrumentation-client.ts`) and the server-side gate
// (`botIdOptionsForPath` below, called from each protected route) derive the
// `checkLevel` from THIS list.
//
// Why one list: Vercel BotID requires the client and server `checkLevel` for a
// route to be IDENTICAL. A mismatch makes verification fail and can block
// legitimate traffic. Deriving both sides from one array makes drift impossible.
// See https://vercel.com/docs/botid/advanced-configuration.
//
// This module is isomorphic — it is imported into the client bundle, so it must
// NOT import `botid/server` or any server-only code. It is plain data + one pure
// lookup function.

export type BotIdCheckLevel = 'deepAnalysis' | 'basic';

export interface BotIdProtectedRoute {
  /** Path as routed by the app, e.g. '/api/auth/signup'. */
  path: string;
  /** HTTP method to protect. All current protected routes are POST. */
  method: 'POST';
  /**
   * 'deepAnalysis' runs Kasada ML scoring (Pro/Enterprise, billed per call);
   * 'basic' validates challenge integrity only (free). Deep is reserved for the
   * highest-value unauthenticated entry points.
   */
  checkLevel: BotIdCheckLevel;
}

// Hot, abuse-prone entry points. Deep Analysis on the two that gate account
// creation + the pre-pay LLM demo (highest fraud/cost value); Basic on the rest
// (low-cost forms — challenge-integrity validation is enough).
export const BOTID_PROTECTED_ROUTES: readonly BotIdProtectedRoute[] = [
  { path: '/api/auth/signup', method: 'POST', checkLevel: 'deepAnalysis' },
  { path: '/api/onboarding/start', method: 'POST', checkLevel: 'deepAnalysis' },
  { path: '/api/auth/login-attempt', method: 'POST', checkLevel: 'basic' },
  { path: '/api/lead-intake', method: 'POST', checkLevel: 'basic' },
  { path: '/api/demo-request', method: 'POST', checkLevel: 'basic' },
  { path: '/api/contact', method: 'POST', checkLevel: 'basic' },
];

/**
 * Server-side `checkBotId()` options for a protected path, carrying the same
 * `checkLevel` the client advertises for that path.
 *
 * Throws if the path is not registered above. This is deliberate: a route that
 * calls this with an unregistered path is a programmer error (zero/mismatched
 * protection), and we want it to surface loudly in tests/dev rather than
 * silently run unprotected.
 */
export function botIdOptionsForPath(path: string): {
  advancedOptions: { checkLevel: BotIdCheckLevel };
} {
  const route = BOTID_PROTECTED_ROUTES.find((r) => r.path === path);
  if (!route) {
    throw new Error(`No BotID protection is registered for "${path}"`);
  }
  return { advancedOptions: { checkLevel: route.checkLevel } };
}
