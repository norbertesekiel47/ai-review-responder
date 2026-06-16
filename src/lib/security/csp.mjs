// Single source of truth for the app's Content-Security-Policy.
//
// Imported by src/proxy.ts (middleware), which generates a per-request nonce and
// emits the policy as a per-request response header so script-src can carry a
// nonce instead of 'unsafe-inline'. (Until Phase 7b the policy was a STATIC
// header in next.config.mjs; a static header can't carry a per-request nonce, so
// CSP generation moved to middleware — see docs/security/csp-rollout.md.) The
// policy stays testable in isolation (see __tests__/csp.test.ts). Dev/test return
// '' on purpose — local HMR and React refresh rely on inline eval the production
// policy forbids, and the policy is only ever exercised in production (staging +
// prod), which is where the Google Maps gap below was first caught.
//
// NOTE (intentional, see docs/security/csp-rollout.md): script-src is nonce-based
// as of Phase 7b (F-11). style-src STILL carries 'unsafe-inline' because the app
// has ~346 inline `style={{}}` attributes and CSP nonces cannot cover inline style
// ATTRIBUTES (only <style>/<script> elements) — dropping it would break styling
// app-wide. The style-src half of F-11 is an accepted/deferred follow-up.

export function buildContentSecurityPolicy(nodeEnv, nonce) {
  if (nodeEnv !== 'production') return '';
  // script-src carries the per-request nonce when middleware supplies one. The
  // no-nonce branch fails CLOSED (no nonce AND no 'unsafe-inline') so a caller
  // that builds the policy without a nonce can never silently re-open inline
  // script execution. No 'strict-dynamic': the Google Maps loader injects a
  // <script src> that relies on the host allowlist below, which 'strict-dynamic'
  // would cause browsers to ignore.
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' https://maps.googleapis.com`
    : "script-src 'self' https://maps.googleapis.com";
  // Google Maps Places (PlaceAutocompleteElement on the onboarding location
  // step) loads its JS from maps.googleapis.com (script-src) but makes its
  // autocomplete + fetchFields RPCs to the NEW Places API host
  // places.googleapis.com (connect-src) — confirmed from the live blocked
  // request google.maps.places.v1.Places/AutocompletePlaces. Fonts/widget
  // chrome come from fonts/maps gstatic. Hosts per
  // https://developers.google.com/maps/gmp-domains. img-src already permits
  // https: + data:; blob: covers the web component's generated images.
  //
  // Sentry: '*.sentry.io' already matches the ingest subdomain
  // (oNNN.ingest.sentry.io). The previous 'o*.ingest.sentry.io' was an invalid
  // CSP source (partial-label wildcards are illegal — the browser ignored it)
  // and redundant, so it is dropped.
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maps.gstatic.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https://fonts.gstatic.com https://maps.gstatic.com",
    "connect-src 'self' https://maps.googleapis.com https://places.googleapis.com https://*.supabase.co https://*.sentry.io",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

// Per-request CSP nonce for script-src. Runs in the middleware (Edge) runtime, so
// it uses Web Crypto globals (crypto.getRandomValues + btoa) rather than the Node
// `crypto`/`Buffer` APIs, which are not guaranteed there. 16 random bytes = 128
// bits of entropy, base64-encoded into a spec-conformant nonce value.
export function generateCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
