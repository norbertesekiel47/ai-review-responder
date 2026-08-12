# CSP Rollout Plan

Status: nonce migration DEFERRED (F-11, 2026-06-16) — see the deferral note below.
Google font hosts DROPPED (#799, 2026-08-11) — see that note below.
Owner: founder/operator
Last updated: 2026-08-11

## Current State

`next.config.mjs` still emits a static CSP with `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`. That is intentional for Wave 1 so launch hardening does not break current pages or third-party-injected styles while legal/security artifacts are being completed.

## Deferral note — F-11 script-src nonce (2026-06-16, owner-decided)

Phase 7b built the script-src nonce migration (CSP generation moved to `src/proxy.ts`
middleware, per-request nonce, `'unsafe-inline'` dropped) and **soak-tested it in real
production mode**. Findings that drove the deferral:

- **Nonce ⊥ static generation.** A per-request nonce can't be baked into build-time
  static HTML. Enforcing `script-src 'self' 'nonce-X'` (no `'unsafe-inline'`) **blocks
  the inline RSC hydration scripts on 39 statically-prerendered routes** (`/login`,
  `/signup`, `/admin/*`, `/mfa/challenge`, all `/legal/*`, `/pricing`, …) → those pages
  render but never hydrate. CI cannot catch this (it doesn't render pages); only a
  real-render soak does.
- **Validated fix:** `export const dynamic = 'force-dynamic'` in the root layout makes
  every page render per-request so the nonce applies (confirmed: `/login` then serves
  nonced scripts). Cost: loses static/CDN prerendering on all 39 routes incl. the
  marketing/SEO surface. Not worth it now for a MEDIUM defense-in-depth item.
- **style-src can't be nonced either:** ~346 inline `style={{}}` attributes; CSP nonces
  don't cover inline style *attributes* (only `<style>`/`<script>` elements).

The middleware plumbing (per-request nonce, `csp.mjs` nonce param, `generateCspNonce`,
`src/proxy.ts` threading) is correct and reusable if F-11 is revisited with force-dynamic
or a future Next static-nonce capability. Full detail: PR #332 close comment.

## Google font hosts dropped (#799, 2026-08-11, owner-decided)

#795 self-hosted all six families via `next/font/local`, so nothing of ours requests
Google's font CDN. `fonts.googleapis.com` (style-src) and `fonts.gstatic.com` (font-src)
were nevertheless still allowlisted, kept because the Maps Places widget was believed to
need them. Both are now removed.

**Measured, not reasoned** — the live `PlaceAutocompleteElement` (real key, `v=weekly`,
`localhost:3000`, the only non-staging origin on the key's referrer allowlist) driven
through a harness that mirrors `src/components/places/PlaceAutocomplete.tsx`:

- The widget **does** still request the hosts: three `fonts.googleapis.com` stylesheets
  (Google Sans Text; Roboto/Google Sans; Material Symbols Outlined) and three
  `fonts.gstatic.com` woff2 files. The "maybe Maps self-hosts now" hypothesis is false.
- Blocking them **breaks nothing**. Predictions render, icons render (SVG, not the icon
  font), the Google Maps attribution dialog renders, and `gmp-select` → `fetchFields`
  still resolves `id` / `formattedAddress` / `location`. Only the widget's own typography
  falls back to the system sans; screenshots are otherwise indistinguishable.
- Dropping the **style-src** host is what does the work: with the stylesheets blocked no
  `@font-face` is ever parsed, so `fonts.gstatic.com` is never contacted and needs no
  `font-src` entry.

**Expected consequence, not a regression:** Chrome logs three CSP errors per widget mount
on the pages that render PlaceAutocomplete (onboarding, add-location, admin). That is the
block working. Do not re-add the hosts to silence them. These violations are not reported
anywhere today — rollout item 1 below (report-only endpoint → Sentry) is still unstarted.

Rejected: keeping `style-src https://fonts.googleapis.com` while dropping only the
`font-src` host. Strictly worse than either extreme — the stylesheet still loads, so the
visitor's IP still reaches Google (no privacy gain), while the fonts fail to render.

`maps.gstatic.com` stays in both directives. It is widget chrome, not a Google font host,
and dropping it *would* visibly break the widget.

## Rollout

1. Add a report-only CSP endpoint and route CSP violation reports to Sentry with raw URLs and tokens scrubbed.
2. Move CSP generation from static `headers()` to Next.js middleware so each request can receive a nonce.
3. Remove `script-src 'unsafe-inline'` first and verify signup, approval, dashboard, legal, and onboarding flows in report-only mode.
4. Audit inline styles and component-library injections before attempting to remove `style-src 'unsafe-inline'`.
5. Enforce only after seven days with no launch-blocking violations in report-only telemetry.

## Regression Checks

- `pnpm build`
- Approval token page smoke test
- Owner dashboard smoke test
- Legal pages render under `/legal/*`
- ZAP passive scan against production or preview URL
