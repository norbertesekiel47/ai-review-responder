# Security-Audit Remediation — Phase 7a Design (COOP/CORP headers)

**Date:** 2026-06-15 (executed 2026-06-16)
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md` (F-12, F-23)
**Roadmap:** Phase 7 in `…-phase-1-design.md` §1, split into 7a (this) + 7b (CSP nonce).
**Lane:** preview (UI-only `next.config.mjs` change; no worker, no migration, no billing).
**Status:** Design approved (owner answered the three header decisions on 2026-06-16).

## 1. Context

Phase 7 of the remediation is "HTTP security headers." The roadmap and handoff
split it into two PRs because the items have wildly different risk:

- **7a (this spec):** F-12 (COOP/CORP) — two static declarative headers. Low risk.
- **7b (separate spec/PR/staging soak):** F-11 (CSP `'unsafe-inline'` → nonce) —
  the highest-risk item in the whole effort. Not in scope here.

F-23 (HSTS `preload`) was *grouped* into 7a by the handoff, but the owner decided
to **hold F-23 entirely** (see §3) because submitting to the HSTS preload list is
irreversible. So Phase 7a ships **F-12 only**.

## 2. Owner decisions (2026-06-16)

| Decision | Choice | Rationale |
|---|---|---|
| F-23 `; preload` | **Hold entirely** — no token added in 7a | Preload-list submission is irreversible (HTTPS-only forced on `repworth.net` + every subdomain, baked into browser binaries). Adding the `; preload` token is itself a consent signal. Owner has not signed off on the permanent list submission. F-23 moves to the owner-gated follow-up list alongside F-3. |
| F-12 CORP value | **`same-origin`** | Investigation found no OG/social-preview images, no `openGraph` metadata, and no app-hosted `<img>` in email templates — nothing legitimately loads app resources cross-origin. Strictest value is safe. |
| F-12 COOP value | **`same-origin`** | RepWorth's OAuth (Zernio connect) and Stripe Checkout are full-page redirects, not popups; the app is already `frame-ancestors 'none'` + `X-Frame-Options: DENY`. No `window.opener`/popup flow to preserve. Strongest isolation is safe. |

## 3. Scope

**One finding: F-12.** Add two response headers to the global `/(.*)` block in
`next.config.mjs` `headers()`:

| Header | Value |
|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

Placed alongside the existing `Referrer-Policy` / `Permissions-Policy` static
headers (same declarative pattern — no logic, no env branching, so no extracted
module is warranted; CSP stays the only header with a dedicated builder because
it has host-allowlist logic). This matches the precedent set when Referrer-Policy
and Permissions-Policy were added (PR-A) and respects the repworth "no new file /
no abstraction for a single caller" rule.

**Explicitly NOT in 7a:** F-23 `; preload` (held), F-11 nonce (7b), any refactor
of the existing header block.

## 4. Design

### 4.1 Header addition (`next.config.mjs`)

Insert two entries into the `headers` array of the `/(.*)` source, after
`Permissions-Policy` and before `Content-Security-Policy`:

```js
{
  key: 'Cross-Origin-Opener-Policy',
  value: 'same-origin',
},
{
  key: 'Cross-Origin-Resource-Policy',
  value: 'same-origin',
},
```

The existing `.filter((h) => h.value !== '')` is preserved (it exists so the CSP
header is dropped in dev/test where `buildContentSecurityPolicy` returns `''`).
COOP/CORP are always non-empty, so they always emit.

### 4.2 Regression test (`src/lib/security/__tests__/next-config-headers.test.ts`, new)

Vitest can import `next.config.mjs` and invoke `headers()` directly (verified:
the `withBotId`/`withSentryConfig` wrappers don't break the call). The test:

1. Imports `next.config.mjs`, awaits `headers()`, reads `result[0].headers`.
2. Asserts `Cross-Origin-Opener-Policy === 'same-origin'`.
3. Asserts `Cross-Origin-Resource-Policy === 'same-origin'`.
4. Asserts the pre-existing security headers are still present (HSTS,
   X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy)
   — a full-block guard so a future edit can't silently drop one.
5. Asserts the HSTS header value does **not** contain `preload` — encodes the
   F-23 "held" decision so a later accidental re-add is caught and forces a
   conscious choice.

This is a genuine assertion against the real exported config, not a text scrape.
It's the same "make the header testable in isolation" philosophy the CSP module
header comment already states.

## 5. Failure modes / risk

- **CORP `same-origin` breaks a cross-origin resource load.** Mitigated: codebase
  investigation found none (no OG images, no email-hosted app images, no
  cross-origin asset embedding). Reversible in one line if a future need appears.
- **COOP `same-origin` breaks a popup OAuth flow.** Mitigated: no popup flows
  exist (OAuth + Checkout are redirects). Reversible to `same-origin-allow-popups`
  in one line.
- **Both are additive response headers** — no behavior change to existing requests
  beyond the browser-side isolation they declare. Preview-lane; no worker/DB/billing.

## 6. Verification

`pnpm lint && pnpm typecheck && pnpm test` (new test green) + `pnpm ci:fallow &&
pnpm ci:static-policy && pnpm ci:tenant-scope && pnpm ci:rls-audit` + `pnpm build`.
Then PR → watch CI to green. Owner reviews the green PR; merge is owner-gated.

## 7. Doc updates in this PR

- `docs/security-audit/2026-06-15-refresh-delta.md` F-12 row → mark fixed (COOP +
  CORP `same-origin` added); F-23 row → note **held pending owner sign-off on
  irreversible preload-list submission** (not "open/unaddressed").
- This is the authoritative status; the audit doc is the single owner of finding
  state.
