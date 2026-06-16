# CSP Rollout Plan

Status: script-src nonce ENFORCED (Phase 7b, F-11); style-src `'unsafe-inline'` retained.
Owner: founder/operator
Last updated: 2026-06-16

## Current State

CSP is generated **per-request in `src/proxy.ts` middleware** (no longer a static
`next.config.mjs` header). `script-src` carries a per-request `'nonce-…'` and no
longer allows `'unsafe-inline'` (the Google Maps loader stays via the host
allowlist; `'strict-dynamic'` is intentionally not used). `style-src` still carries
`'unsafe-inline'` — see step 4.

## Rollout

1. ~~Add a report-only CSP endpoint~~ — **skipped.** Owner chose enforce-with-soak
   (validate on the preview deploy + staging before the prod merge) over a
   report-only soak, given research found no inline-script vectors. A report
   endpoint can still be added later for ongoing monitoring.
2. ✅ **Done (Phase 7b).** CSP generation moved from static `headers()` to Next.js
   middleware so each request gets a nonce.
3. ✅ **Done (Phase 7b).** `script-src 'unsafe-inline'` removed → per-request nonce.
   Validate signup, approval, dashboard, legal, and onboarding (Maps) flows on the
   preview deploy + staging soak before the prod merge.
4. **OPEN follow-up.** Removing `style-src 'unsafe-inline'` requires eliminating the
   ~346 inline `style={{}}` attributes (or `'unsafe-hashes'` + per-value hashes):
   CSP nonces cannot cover inline style ATTRIBUTES, only `<style>` elements. Audit
   inline styles + component-library injections first. Low-priority — no
   user-controlled style-injection point exists.
5. Enforcement of the script-src nonce is the merge itself; the style-src step (4)
   remains gated on the inline-style audit.

## Regression Checks

- `pnpm build`
- Approval token page smoke test
- Owner dashboard smoke test
- Legal pages render under `/legal/*`
- ZAP passive scan against production or preview URL
