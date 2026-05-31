// Single source of truth for the app's Content-Security-Policy.
//
// Imported by next.config.mjs as a global response header so the policy is
// testable in isolation (see __tests__/csp.test.ts) rather than buried as an
// inline string in the Next config. Dev/test return '' on purpose — local HMR
// and React refresh rely on inline eval the production policy forbids, and the
// policy is only ever exercised in production (staging + prod), which is where
// the Google Maps gap below was first caught.
//
// NOTE (intentional, see docs/security/csp-rollout.md): script-src/style-src
// still carry 'unsafe-inline'. The nonce migration is a later, separate step;
// this module only completes the static host allowlist.

export function buildContentSecurityPolicy(nodeEnv) {
  if (nodeEnv !== 'production') return '';
  // Google Maps Places (PlaceAutocompleteElement on the onboarding location
  // step) loads its JS from maps.googleapis.com, fetches place fields from the
  // same host, and pulls Roboto + widget chrome from fonts/maps gstatic.
  // Hosts per https://developers.google.com/maps/gmp-domains. img-src already
  // permits https: + data:; blob: covers the web component's generated images.
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://maps.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maps.gstatic.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https://fonts.gstatic.com https://maps.gstatic.com",
    "connect-src 'self' https://maps.googleapis.com https://*.supabase.co https://*.sentry.io https://o*.ingest.sentry.io",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
