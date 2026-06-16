# Phase 7b Implementation Plan — F-11 CSP script-src nonce

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-7b-design.md`
**Branch:** `security/audit-remediation-phase-7b` off `main@d9fbb63a`
**Lane:** preview deploy + staging soak before owner-gated prod merge.

## Task 1 — `csp.mjs`: nonce param + `generateCspNonce` (TDD)

**Red (`csp.test.ts`):**
- `buildContentSecurityPolicy('production', 'NONCEABC')` → `script-src` contains
  `'nonce-NONCEABC'`, NOT `'unsafe-inline'`; `style-src` STILL has `'unsafe-inline'`.
- `buildContentSecurityPolicy('production')` (no nonce) → `script-src` has neither
  nonce nor `'unsafe-inline'` (fail-closed fallback).
- dev/test → `''` regardless of nonce (unchanged).
- `generateCspNonce()` → non-empty string; two calls differ.

**Green:** add the `nonce` param to `buildContentSecurityPolicy` (build `scriptSrc`
conditionally); add `generateCspNonce()` (Web Crypto, base64). Keep style-src and
all other directives unchanged. Update the module header comment.

## Task 2 — `src/proxy.ts`: thread nonce + emit per-request CSP (TDD)

**Red (`proxy.test.ts`):** with `vi.stubEnv('NODE_ENV','production')` —
- public-route request → response has `Content-Security-Policy` with `'nonce-'` in
  `script-src`; forwarded request headers include `x-nonce` + a CSP header.
- protected/authed page → same CSP on response.
- no production stub → NO `Content-Security-Policy` header (dev/test preserved).
- existing auth-gating tests unchanged + green.

**Green:** extract the routing/auth body into inner `routeRequest(request, nonce,
cspValue)`; `proxy()` generates nonce (prod only) + `cspValue`, calls
`routeRequest`, sets the response CSP header once, returns. `createDownstreamRequest`
sets `x-nonce` + `content-security-policy` on forwarded request when nonce exists.
Auth/routing logic byte-identical.

## Task 3 — `next.config.mjs`: remove static CSP header

Delete the `Content-Security-Policy` header entry + the `buildContentSecurityPolicy`
import. Keep COOP/CORP/HSTS/etc. The 7a `next-config-headers.test.ts` is unaffected;
optionally assert CSP is no longer present in next.config output.

## Task 4 — docs

- audit doc F-11 → FIXED (script-src half, Phase 7b); style-src `'unsafe-inline'`
  intentionally retained (inline style attrs), tracked accepted.
- `csp-rollout.md` → steps 2–3 done; step 4 (style-src) is the open follow-up.

## Review (full two-stage — security-sensitive)

Spec-compliance reviewer + adversarial code-quality/security reviewer (parallel);
apply verified fixes; re-review if behavior changed.

## Verification gate

lint · typecheck · test · ci:fallow · ci:static-policy · ci:tenant-scope ·
ci:rls-audit · build. Then PR → CI green → preview-deploy CSP/render checks (spec §6).

## Out of scope

style-src nonce (346 inline attrs), `'strict-dynamic'`, CSP report endpoint.
