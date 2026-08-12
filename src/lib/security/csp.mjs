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
  // step) loads its JS from maps.googleapis.com (script-src) but makes its
  // autocomplete + fetchFields RPCs to the NEW Places API host
  // places.googleapis.com (connect-src) — confirmed from the live blocked
  // request google.maps.places.v1.Places/AutocompletePlaces. Widget chrome
  // comes from maps.gstatic.com. Hosts per
  // https://developers.google.com/maps/gmp-domains. img-src already permits
  // https: + data:; blob: covers the web component's generated images.
  //
  // NO Google font hosts (#799). The app self-hosts all six families via
  // next/font/local (#795), so nothing of ours needs them. The Maps widget
  // still ASKS for three fonts.googleapis.com stylesheets (Google Sans Text,
  // Roboto/Google Sans, Material Symbols Outlined) and would then pull woff2
  // from fonts.gstatic.com — but blocking them costs nothing, measured against
  // the live widget: predictions render, icons render (they are SVG, not the
  // icon font), the attribution dialog renders, and gmp-select → fetchFields
  // still returns id/formattedAddress/location. Only the widget's own
  // typography falls back to the system sans. Dropping the style-src host is
  // what matters — with the stylesheets blocked no @font-face is ever parsed,
  // so fonts.gstatic.com is never contacted and needs no font-src entry.
  //
  // Expected consequence: Chrome logs three CSP errors per widget mount on the
  // pages that render PlaceAutocomplete (onboarding, add-location, admin). That
  // is the blocking working, NOT a regression — do not "fix" it by re-adding
  // the hosts. Keeping only style-src would be strictly worse than either
  // extreme: the stylesheet still loads (so the visitor's IP still reaches
  // Google, no privacy gain) while the fonts fail.
  //
  // Sentry: '*.sentry.io' already matches the ingest subdomain
  // (oNNN.ingest.sentry.io). The previous 'o*.ingest.sentry.io' was an invalid
  // CSP source (partial-label wildcards are illegal — the browser ignored it)
  // and redundant, so it is dropped.
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://maps.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://maps.gstatic.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https://maps.gstatic.com",
    "connect-src 'self' https://maps.googleapis.com https://places.googleapis.com https://*.supabase.co https://*.sentry.io",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
