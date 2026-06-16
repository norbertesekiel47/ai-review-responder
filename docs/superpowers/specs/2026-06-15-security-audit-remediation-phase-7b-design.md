# Security-Audit Remediation — Phase 7b Design (CSP script-src nonce)

**Date:** 2026-06-15 (executed 2026-06-16)
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md` (F-11)
**Rollout plan it executes:** `docs/security/csp-rollout.md` steps 2–3 (+5).
**Roadmap:** Phase 7b — the highest-risk item in the whole effort; its own spec + PR + staging soak.
**Lane:** preview deploy exercises it; **staging soak before the owner-gated prod merge.**
**Status:** Design approved (owner answered the two F-11 decisions 2026-06-16).

## 1. Context

F-11: the production CSP carries `'unsafe-inline'` on **script-src** and
**style-src** (`src/lib/security/csp.mjs:31-32`), emitted as a *static* header in
`next.config.mjs headers()`. A nonce is *per-request*, so a static header can't
carry one. This phase migrates **script-src** to a per-request nonce and removes
`script-src 'unsafe-inline'`.

## 2. Owner decisions (2026-06-16)

| Decision | Choice | Why |
|---|---|---|
| Scope | **script-src nonce only** | The app has **346 inline `style={{}}` attributes across 58 components**. Per CSP3, inline style *attributes* are governed by `style-src-attr`, which only `'unsafe-inline'` (or `'unsafe-hashes'` + a hash per distinct value) permits — **nonces apply to `<style>`/`<script>` elements, never attributes**. Dropping `style-src 'unsafe-inline'` would break styling app-wide. `style-src` stays unchanged; its half of F-11 is documented as accepted/deferred. Script injection is the real XSS risk; style-src `'unsafe-inline'` is low-impact (no user-controlled style injection point exists). |
| Rollout | **Enforce + soak before prod** | Ship the enforcing nonce-based `script-src` (drops `'unsafe-inline'` immediately). Validate on the Vercel preview deploy + a staging soak **before** the owner-gated prod merge. Research found **no** inline `<script>` / `dangerouslySetInnerHTML` script vectors — only Next's own bootstrap (Next auto-nonces it) and the host-allowlisted Google Maps loader. Low breakage risk. |

## 3. Scope

**One finding: F-11 (script-src half).**

- `script-src`: `'self' 'unsafe-inline' https://maps.googleapis.com`
  → `'self' 'nonce-<per-request>' https://maps.googleapis.com` (drop `'unsafe-inline'`).
- `style-src`, `img-src`, `font-src`, `connect-src`, `default-src`,
  `frame-ancestors`, `base-uri`, `form-action`: **unchanged.**
- CSP generation **moves** from the static `next.config.mjs headers()` to
  per-request generation in `src/proxy.ts` (middleware) so each response carries a
  fresh nonce.

**Explicitly NOT in 7b:** any change to `style-src` (the 346 inline-style problem),
`'strict-dynamic'` (see §4.5), a CSP report endpoint (owner chose enforce-only, not
the report-endpoint variant), any refactor beyond what the nonce migration needs.

## 4. Architecture

### 4.1 The static-vs-per-request tension & the double-CSP trap

CSP is currently one **static** header on `/(.*)` in `next.config.mjs`. A nonce is
per-request, so it must be generated in middleware. **Critical:** two
`Content-Security-Policy` headers on one response are enforced as their
*intersection* (logical AND). A leftover static `script-src` without the nonce
would therefore **block** the very inline bootstrap scripts the middleware nonce
is meant to allow. So the static CSP header is **removed from `next.config.mjs`
entirely**; CSP is emitted **only** from middleware. Static assets under
`/_next/static`, `/_next/image`, `favicon.ico` are excluded by the middleware
matcher and get no CSP — standard and safe (they're not HTML documents; they load
external `src` scripts = `'self'`, no inline).

### 4.2 `src/lib/security/csp.mjs` — accept an optional nonce

```js
export function buildContentSecurityPolicy(nodeEnv, nonce) {
  if (nodeEnv !== 'production') return '';      // dev/test: HMR needs inline eval
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' https://maps.googleapis.com`
    : `script-src 'self' https://maps.googleapis.com`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maps.gstatic.com",
    // …all other directives unchanged…
  ].join('; ');
}
```

- The **no-nonce production fallback** (`script-src 'self' …` with no
  `'unsafe-inline'`, no nonce) is a defensive default. In the real request path the
  middleware **always** passes a nonce in production, so the fallback is only a
  belt-and-suspenders for any caller that builds the policy without one — and it is
  *fail-closed* (omits `'unsafe-inline'`), never fail-open.
- Update the module header comment: nonce migration for script-src is now **done**;
  `style-src 'unsafe-inline'` remains intentionally (inline style attributes).

### 4.3 `src/proxy.ts` — generate the nonce, thread it, emit CSP

Single cross-cutting concern applied with **one** entry/exit wrapper so none of the
~12 existing return points is missed (invariant #12: entry point orchestrates).

1. **Generate** a nonce at the top of `proxy()` — production only; `undefined`
   otherwise (preserves the dev/test empty-CSP/HMR behavior):
   ```ts
   const nonce = process.env.NODE_ENV === 'production' ? generateCspNonce() : undefined;
   const cspValue = buildContentSecurityPolicy(process.env.NODE_ENV, nonce);
   ```
   `generateCspNonce()` (new helper, see §4.4) uses Web Crypto (Edge-runtime-safe).

2. **Thread to the renderer.** In `createDownstreamRequest()`, when a nonce exists,
   set on the forwarded **request** headers:
   ```ts
   downstreamHeaders.set('x-nonce', nonce);
   downstreamHeaders.set('content-security-policy', cspValue);
   ```
   Next.js reads the nonce out of the **request** `Content-Security-Policy` header
   and auto-applies it to its own `<script>` bootstrap/hydration tags. `x-nonce` is
   for any Server Component that needs to nonce its own inline content via
   `headers().get('x-nonce')` (none today, but it's the documented seam).

3. **Emit on every response.** Wrap the existing routing/auth body in an inner
   function and apply the response header once on the way out, so **all** return
   paths (public early-return, redirects, JSON 401/403, final `response`) carry the
   CSP:
   ```ts
   export async function proxy(request: NextRequest) {
     const nonce = …; const cspValue = …;
     const response = await routeRequest(request, nonce, cspValue);
     if (cspValue) response.headers.set('Content-Security-Policy', cspValue);
     return response;
   }
   ```
   The existing closures (`createDownstreamRequest`, `readSelf`, `getAalGate`,
   `withSupabaseCookies`, `redirectToMfaChallenge`) move inside `routeRequest`,
   which receives `nonce`/`cspValue`. **Auth/routing logic is byte-for-byte
   unchanged** — only the request-header threading and the single response-header
   application are added. The nonce on a redirect/JSON response is inert (no
   scripts) but harmless; keeping CSP on every response matches the prior static
   `/(.*)` coverage (defense-in-depth).

### 4.4 `generateCspNonce()` — Edge-runtime-safe nonce

New helper exported from `src/lib/security/csp.mjs` (keeps all CSP concerns in one
module — the single source of truth the file header already claims; `csp.test.ts`
already imports from there). Must run in the middleware (Edge) runtime → use Web
Crypto globals, not Node `Buffer`/`crypto` module:

```ts
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64 (spec-conformant nonce value); btoa is available in Edge + Node.
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
```

16 random bytes → 128 bits of entropy, base64-encoded. Per-request, unguessable.

### 4.5 Deliberately NOT using `'strict-dynamic'`

Next's docs example uses `'strict-dynamic'`. With it, host-source allowlists in
`script-src` are **ignored** by supporting browsers (trust propagates only via the
nonce). That would drop `https://maps.googleapis.com`, and the Google Maps loader
(`@googlemaps/js-api-loader` injects a `<script src=…>`) relies on the host
allowlist. Keeping the **host allowlist + nonce** (no `'strict-dynamic'`) is the
lower-risk path: Next's inline scripts pass via nonce; the Maps loader passes via
the host source; everything else inline is blocked. This is a conscious deviation
from the Next sample, recorded here.

### 4.6 `next.config.mjs` — remove the static CSP header

Delete the `Content-Security-Policy` entry from `headers()` and the now-unused
`buildContentSecurityPolicy` import. The `.filter((h) => h.value !== '')` stays
(harmless; the remaining headers are always non-empty). COOP/CORP/HSTS/XCTO/XFO/
Referrer/Permissions (incl. the Phase 7a additions) are untouched — they're static
and correctly belong in `next.config.mjs`.

## 5. Failure modes, soak & rollback

- **Primary risk:** Next's inline bootstrap scripts get blocked if the nonce
  isn't propagated correctly → white screen / broken hydration. **Caught before
  prod** by the preview-deploy + staging soak (§6). Rollback = revert the PR (one
  commit); CSP returns to the prior static `'unsafe-inline'` policy.
- **Maps PlaceAutocomplete:** unaffected — its loader is host-allowlisted
  (`script-src https://maps.googleapis.com` kept) and its injected `<style>` +
  shadow styles ride `style-src 'unsafe-inline'` (kept).
- **Sentry/BotID/PostHog/Stripe:** no inline-script injection (research-confirmed);
  Sentry/BotID are bundled or header-based; PostHog is server-only; Stripe is a
  redirect. No nonce wiring needed.
- **Dev/test:** `buildContentSecurityPolicy` returns `''` outside production →
  middleware sets no nonce/CSP → HMR + React Refresh keep working unchanged.
- **No double-CSP** (§4.1): static header removed; only the middleware emits CSP.

## 6. Validation / soak plan (before the owner-gated prod merge)

1. **Local:** the full verification gate (§7) incl. the new proxy/csp tests + `pnpm build`.
2. **Preview deploy (auto on PR):** with a forced production CSP, confirm on the
   preview URL: (a) response carries `Content-Security-Policy` with `'nonce-…'` in
   `script-src` and **no** `script-src 'unsafe-inline'`; (b) pages render and
   hydrate (landing, login, dashboard, **onboarding location step w/ Maps**,
   `/approve/<token>`, legal); (c) **zero CSP violations** in the browser console.
   Use chrome-devtools MCP / curl against the preview URL.
3. **Staging soak:** push to `staging` (operator-gated) and let it run; re-check the
   same flows + browser console on `staging.repworth.net`. Per `csp-rollout.md`,
   give it a short soak before prod.
4. **Prod merge:** owner-gated; merge only after the soak is clean.

## 7. Verification gate (before PR)

`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm ci:fallow` ·
`pnpm ci:static-policy` · `pnpm ci:tenant-scope` · `pnpm ci:rls-audit` ·
`pnpm build`. Then PR → watch CI to green → run the preview-deploy checks (§6.2).

## 8. Tests

- **`csp.test.ts` (extend):**
  - production + nonce → `script-src` contains `'nonce-<value>'`, does **not**
    contain `'unsafe-inline'`; `style-src` **still** contains `'unsafe-inline'`.
  - production no-nonce fallback → `script-src` has neither nonce nor
    `'unsafe-inline'` (fail-closed).
  - dev/test (with or without nonce) → `''` (unchanged).
  - existing Maps/Supabase/Sentry/lockdown assertions still pass.
- **`csp.test.ts` / nonce helper:** `generateCspNonce()` returns a non-empty base64
  string and two calls differ (uniqueness).
- **`proxy.test.ts` (extend):** with `vi.stubEnv('NODE_ENV','production')`:
  - a public-route request → response has `Content-Security-Policy` with `'nonce-'`
    in `script-src`; the forwarded request got `x-nonce` + a CSP request header.
  - a protected/authed page request → same CSP on the response.
  - without the production stub (test env) → **no** `Content-Security-Policy` header
    (dev/test behavior preserved).
  - all existing auth-gating tests still pass (the wrapper must not alter routing).
- **`next-config-headers.test.ts` (from 7a):** unaffected (it never asserted CSP);
  optionally add an assertion that `next.config.mjs` no longer emits a CSP header
  (it now comes from middleware).

## 9. Review & docs

- **Full two-stage review** (security-sensitive): spec-compliance reviewer +
  adversarial code-quality/security reviewer; apply verified fixes.
- `docs/security-audit/2026-06-15-refresh-delta.md` F-11 → mark **FIXED (script-src
  half; Phase 7b)** with a note that `style-src 'unsafe-inline'` is intentionally
  retained (inline style attributes) and tracked as accepted.
- `docs/security/csp-rollout.md` → mark steps 2–3 done; note style-src (step 4)
  remains the open follow-up.
