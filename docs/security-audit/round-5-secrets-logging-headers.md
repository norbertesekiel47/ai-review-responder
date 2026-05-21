# Round 5 — Secrets, Logging, Headers, Information Disclosure

**Audit date:** 2026-04-26
**Scope:** Secret exposure (especially client-bundle leakage), env-var hygiene, source-map handling, Sentry PII scrubbing, HTTP security headers (CSP, HSTS, COOP/COEP/CORP, Permissions-Policy, Referrer-Policy), error-detail leakage, account enumeration, cookie scoping.
**Methodology:** Whitebox review. Two parallel sub-agents (one on secrets/env/Sentry, one on HTTP headers/error-leakage). Direct verification of Critical/High claims against `next.config.mjs`, `src/lib/db/auth.ts`, and the gitignore pattern.

**Severity rubric:** Critical = secret in client bundle / committed to git / catastrophic CSP gap. High = stack traces in prod / cookie scoped to parent domain / Sentry capturing tokens. Medium = missing key header / enumeration via status codes / CSP defense-in-depth weakness. Low = hardening. Informational = note.

---

## Findings (by severity)

### [MEDIUM] M-1: CSP allows `'unsafe-inline'` for `script-src` and `style-src`

- **Location:** `next.config.mjs:30` (production CSP)
- **Description:** The production CSP is `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://*.sentry.io https://o*.ingest.sentry.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The `'unsafe-inline'` for both scripts and styles defeats CSP's primary purpose: blocking injected `<script>` tags. Today no XSS sink is reachable (Round 4 verified), but if any future regression introduces a stored-XSS surface (an unescaped email-template variable, a `dangerouslySetInnerHTML` someone forgets to remove, an SVG with embedded script, etc.), the CSP will not mitigate it.
- **Impact:** Defense-in-depth is reduced to roughly the same protection as no CSP for script execution. Only `frame-ancestors`, `connect-src`, and `form-action` retain meaningful enforcement.
- **Recommended fix:** Adopt nonce-based CSP. Next.js supports it via `next.config.experimental.cspNonce` (or middleware that generates a per-request nonce, sets it as a CSP header, and exposes it to React via headers). Inline scripts/styles get the nonce, everything else is blocked. Alternative interim: switch to `'strict-dynamic'` with hash-based allowlist for the small number of inline scripts Next.js emits (mostly hydration data). The migration is non-trivial — 1-2 day project — but the long-term value is high.

---

### [MEDIUM] M-2: Missing standard hardening headers — `Permissions-Policy`, `Referrer-Policy`, COOP/COEP/CORP

- **Location:** `next.config.mjs:11-36` (`headers()` returns only HSTS + X-Content-Type-Options + X-Frame-Options + CSP)
- **Description:**
  - **No `Permissions-Policy`** — browser will allow this origin to request camera/microphone/geolocation/USB/payment if any future code asks. Today the app doesn't use any of these, but a malicious iframe (if frame-ancestors ever got loosened) could trigger them.
  - **No `Referrer-Policy`** — defaults to `strict-origin-when-cross-origin` per modern browsers, which is OK but not explicit. If an approval URL ever ends up in a `<a target=_blank>` or external link, the full path leaks to the destination. Approval tokens are in the path component (`/approve/<token>`), so a referrer leak = token leak.
  - **No `Cross-Origin-Opener-Policy: same-origin`** — defends against tabnabbing and Spectre-class side channels. Nice-to-have for a SaaS dashboard.
  - **No `Cross-Origin-Resource-Policy: same-origin`** — defends against cross-origin script-src/img-src spoofing.
- **Impact:** Each one is small individually. Cumulative effect is "not following 2024 security-baseline guidance." Approval-token leak via referrer is the most concrete exposure.
- **Recommended fix:** Add to `next.config.mjs:headers()`:
  ```js
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), payment=()' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  ```
  Don't add `Cross-Origin-Embedder-Policy: require-corp` unless you're sure no third-party embed is broken — it's the strictest of the four.

---

### [MEDIUM] M-3: Sentry `beforeBreadcrumb` not set — approval tokens may land in Sentry breadcrumbs

- **Location:** `src/instrumentation.ts` / `src/instrumentation-client.ts` / `worker/index.ts` Sentry init (only `beforeSend` hook is configured)
- **Description:** `beforeSend` scrubs the request body, headers, and `extra` of captured exceptions. But Sentry SDKs automatically capture *breadcrumbs* — navigation events, fetch URLs, console logs, and so on — and attach them to every captured event. URLs like `https://app.repworth.net/approve/<raw-token>` and `/api/approve/<raw-token>/session` land in breadcrumbs in plaintext when the user navigates to the approval page. If any error fires while the user is on that page (a Sentry capture from a different unrelated page action), the breadcrumb history with the token is exfiltrated to Sentry.
- **Impact:** Anyone with read access to the Sentry project can see live + recently-used approval tokens. Combined with Round 2 H-1 (edit endpoint accepts arbitrary text) and the 48h token lifetime, a Sentry-account compromise becomes a "publish forged response on any pending review" exploit. Sentry retention of error events is typically 30-90 days, so the token window matters even though the exploit window is 48h.
- **Recommended fix:** Add a `beforeBreadcrumb` hook that scrubs URLs matching `/approve/[^/]+` and `/api/approve/[^/]+`. Same hook should scrub query params on `/api/auth/callback` (`code`, `token_hash`). Pseudo-code:
  ```ts
  beforeBreadcrumb(breadcrumb) {
    if (breadcrumb.data?.url) {
      breadcrumb.data.url = breadcrumb.data.url
        .replace(/\/approve\/[^/?]+/, '/approve/[REDACTED]')
        .replace(/\/api\/approve\/[^/?]+/, '/api/approve/[REDACTED]')
        .replace(/[?&](code|token_hash|token)=[^&]+/g, '$1=[REDACTED]');
    }
    return breadcrumb;
  }
  ```

---

### [MEDIUM] M-4: CSP `connect-src` does not whitelist Google Maps Places API — likely a production functional bug

- **Location:** `next.config.mjs:30` — `connect-src 'self' https://*.supabase.co https://*.sentry.io https://o*.ingest.sentry.io`
- **Description:** `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is required for the onboarding `PlaceAutocomplete` element (R1 inventory). The Google Maps Places API and the Maps JS loader connect to `https://maps.googleapis.com`, `https://maps.gstatic.com`, and possibly `https://www.googleapis.com`. None of these origins are in `connect-src`, and the Maps loader script needs them in `script-src` too. Either (a) production is currently broken for the place autocomplete on the onboarding wizard (likely visible as console errors + autocomplete not working), or (b) the production deployment hasn't been live-tested with the strict CSP yet (production-only conditional applies the CSP only when `NODE_ENV === 'production'`).
- **Impact:** Functional — onboarding wizard's place autocomplete fails in prod, or hasn't been tested in prod. Not a security finding per se (the gap is *over-restrictive*, not permissive), but the kind of misconfig that gets "fixed" by an operator opening the CSP wider than necessary.
- **Recommended fix:** Test the production CSP in a staging environment with NEXT_PUBLIC_GOOGLE_MAPS_API_KEY set. Add the required Google Maps origins explicitly: `script-src ... https://maps.googleapis.com https://maps.gstatic.com; connect-src ... https://maps.googleapis.com https://*.googleapis.com; img-src ... https://maps.gstatic.com https://maps.googleapis.com`. Same applies for any third-party script that runs client-side.

---

### [LOW] L-1: `.gitignore` pattern `.env*.local` doesn't catch `.env.production` / `.env.staging`

- **Location:** `.gitignore` contains `.env*.local`
- **Description:** The current pattern matches `.env.local`, `.env.production.local`, `.env.staging.local` — files explicitly named with `.local` suffix. It does NOT match `.env.production`, `.env.staging`, or plain `.env`. If anyone accidentally creates one of those (e.g., copying production secrets locally for debugging), it'd be tracked by git on the next `add -A`.
- **Impact:** Latent. The convention in the repo is `.local` suffix, so today no one has created a non-`.local` env file. The day someone does, the protection fails silently.
- **Recommended fix:** Replace `.env*.local` with the pattern from Next.js's own template:
  ```
  .env*
  !.env.example
  ```
  Catches every `.env*` file and explicitly allows `.env.example` (the only env file that should be committed).

---

### [LOW] L-2: HSTS missing `preload` directive; not submitted to preload list

- **Location:** `next.config.mjs:17` — `'max-age=63072000; includeSubDomains'`
- **Description:** Two-year `max-age` and `includeSubDomains` are correct. Missing `preload` means browsers that haven't seen the site yet will allow a one-time HTTPS-stripping MITM on the very first connection. With preload, the browser ships the HSTS expectation built in.
- **Impact:** Tiny — the first-connection MITM scenario is rare and requires an active on-path attacker. Worth fixing for production hardening posture.
- **Recommended fix:** (a) Add `; preload` to the value. (b) Submit the apex domain at https://hstspreload.org/ once you're ready to commit (preload removal takes weeks/months).

---

### [LOW] L-3: `signup-status` differentiates 401 (no session) vs 404 (no users row)

- **Location:** `src/app/api/auth/signup-status/route.ts:35, 70` (already noted in R1 as M-2 informational)
- **Description:** R1 listed this. Same finding here for completeness — Sentry-level enumeration of "did this auth_id finish provisioning" via the 401-vs-404 distinction.
- **Recommended fix:** Unify to `200 { state: 'unauthenticated' | 'incomplete' | 'complete' }` per R1 M-2.

---

### [INFORMATIONAL] I-1: All secrets are server-only — no client-bundle leakage

- **Location:** Sub-agent verification across `src/lib/db/server.ts`, `src/lib/notifications/email/client.ts`, `src/lib/approval/cookies.ts`, `src/lib/shared/feedback-hmac.ts`, `src/lib/notifications/channels/telegram-client.ts` (all server-side, none referenced from a `'use client'` file)
- **Description:** Auditors verified no `'use client'` file imports any module that uses a secret env var. `SUPABASE_SERVICE_KEY` is used only in `src/lib/db/server.ts`. `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_APP_URL` are all intentionally public and verified-safe for browser exposure.
- **Action:** None. Add a CI lint rule (`grep` for `process.env\.[A-Z_]+` inside any file with `'use client'`) to prevent future regressions.

---

### [INFORMATIONAL] I-2: No source maps shipped to production

- **Location:** `next.config.mjs` — no `productionBrowserSourceMaps: true` (defaults to false)
- **Description:** Default Next.js behavior is to strip source maps in production builds. Sentry's webpack plugin uploads them to Sentry but doesn't ship them as public assets. Verified.
- **Action:** None.

---

### [INFORMATIONAL] I-3: AuthError messages are generic — no information leakage

- **Location:** `src/lib/db/auth.ts:71, 85` — literal `'Unauthorized'` and `'Forbidden'` strings
- **Description:** Sub-agent flagged a HIGH "AuthError.message leakage" claiming messages like "User with auth_id X not found". Verified directly — the messages are short fixed strings. The agent hallucinated specifics. No fix needed.
- **Action:** None.

---

### [INFORMATIONAL] I-4: `.env.example` contains only placeholders, no real secrets

- **Location:** `.env.example`
- **Description:** Sub-agent verified all values are placeholders (`YOUR_PASSWORD`, `eyJ...` JWT skeleton, etc.). Tracked in git (intentional). No leak.
- **Action:** None.

---

### [INFORMATIONAL] I-5: Sentry `beforeSend` does scrub object keys matching `/key|secret|token|password|authorization/i`

- **Location:** `src/instrumentation.ts` + `worker/index.ts`
- **Description:** The `beforeSend` hook iterates `event.request?.headers`, `event.request?.data`, and `event.extra`, redacting any property whose key matches the regex. Reasonable defense-in-depth for object-shaped data. The gap is that *URL strings* (in breadcrumbs and `event.request?.url`) are not regex-matched against the same patterns — that's M-3.
- **Action:** Pair with M-3's `beforeBreadcrumb` fix.

---

## Verified safe (claims investigated, no finding)

| # | Claim | Status | Reason |
|---|---|---|---|
| 1 | Hardcoded secrets in source | **Safe** | No matches for `sk_live_`, `whsec_`, `re_`, `sk-ant-api`, etc. |
| 2 | `NEXT_PUBLIC_*` actually contains a secret | **Safe** | All four (`SUPABASE_ANON_KEY`, `GOOGLE_MAPS_API_KEY`, `SENTRY_DSN`, `APP_URL`) are intentionally public values. |
| 3 | `.env*` files committed to git | **Safe** | `git ls-files` returns only `.env.example`. Pattern gap is L-1. |
| 4 | `SUPABASE_SERVICE_KEY` exposed in Edge middleware | **Safe** | Used only in `src/lib/db/server.ts:47`. Middleware comment at `src/middleware.ts:5-9` documents this was intentionally moved out. |
| 5 | CORS wildcard | **Safe** | No `Access-Control-Allow-Origin: *` headers anywhere. Default same-origin. |
| 6 | Image domain wildcard | **Safe** | No `images.remotePatterns` configured; `img-src 'self' data: https:` permits any HTTPS image but blocks `http:`. The HTTPS-wildcard is broad but bounded — could tighten to `data: https://*.supabase.co https://maps.gstatic.com` once the M-4 functional CSP fix lands. |
| 7 | HSTS `max-age` | **Safe** | 2 years (63072000). Exceeds 1-year baseline. Missing `preload` is L-2. |
| 8 | `frame-ancestors` set | **Safe** | `frame-ancestors 'none'` + `X-Frame-Options: DENY` (defense-in-depth). |
| 9 | `base-uri` and `form-action` set | **Safe** | Both `'self'` — prevents `<base href>` injection and rogue form-action. |
| 10 | Cookie `Domain` scoped to subdomain or apex | **Safe** | `__device` and `__csrf` set without `Domain`, defaulting to exact host. No cross-subdomain readability. |
| 11 | Account enumeration via signup / forgot-password | **Safe** | Both return uniform responses regardless of email known/unknown. R1 verified disambiguation of `account_exists` vs `over_email_send_rate_limit`. |
| 12 | Rate-limit error reveals "Redis" | **Safe** | Returns `503 'rate_limit_unavailable'` with user-facing copy ("Signup is temporarily unavailable"). No internal detail leaked. |
| 13 | Stack traces in production responses | **Safe** | Sampled error-handler patterns return generic strings; no `err.stack` interpolation found. |
| 14 | AuthError leaks user/auth-id details | **Safe (FALSE POSITIVE)** | I-3. Messages are literally `'Unauthorized'` / `'Forbidden'`. |

---

## Recommended Round-5 fix priority

1. **M-3** — Add `beforeBreadcrumb` URL scrubbing to Sentry instrumentation. Highest concrete-exposure-per-effort ratio in this round.
2. **M-2** — Add the four missing security headers (`Permissions-Policy`, `Referrer-Policy`, COOP, CORP) to `next.config.mjs:headers()`. Five-line change.
3. **M-4** — Verify production CSP with Maps API enabled. Either it's already broken (functional bug to file) or it works via a path I don't see; either way, document the required CSP allowlist.
4. **M-1** — Plan the migration to nonce-based CSP. Larger lift; track separately.
5. **L-1, L-2, L-3** — Easy hardening; bundle into a "small fixes" PR.

---

## Coverage notes

- I directly read `next.config.mjs`, `src/lib/db/auth.ts`. The remaining secret-bundling and Sentry findings rely on the sub-agent's grep + read passes — accurate enough for a static review but a follow-up `pnpm build` + bundle-analyzer pass would close the loop with byte-level confidence.
- Did not explicitly verify every `'use client'` file's import graph (sub-agent did this and reported 66 client files, none with secret imports).
- A separate Supabase RLS-policy audit (per-table, beyond `users_self_select`) is out of scope for this round — recommended as a follow-up engagement after the app-layer audit lands its fixes.
