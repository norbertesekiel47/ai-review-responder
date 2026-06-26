# Stage 4 BATCH 4b — the auth feature-flag cluster (self-serve signup + MFA)

_Branch `refactor/audit-stage4-auth-flags`. Builds on 4a's `readFlag` primitive
(`src/lib/config/flags.ts`). Routes the two auth feature flags through a new
`src/lib/auth/flags.ts` accessor. Zero behavior change._

## The accessor — `src/lib/auth/flags.ts`
Two named exports, each a one-line wrapper over the shared `readFlag` primitive
(byte-for-byte `process.env[name] === 'true'`):

- **`selfServeSignupEnabled()`** → `readFlag('SELF_SERVE_SIGNUP_ENABLED')`. Gates the
  entire public signup/onboarding flow (invariant #13: server-authoritative, never
  `NEXT_PUBLIC`).
- **`mfaEnforcementEnabled()`** → `readFlag('MFA_ENFORCEMENT_ENABLED')`. The MFA
  enforcement gate read by the proxy/middleware.

No direct `process.env` in this module → it never enters the process-env baseline
(the audit only flags files that read `process.env` themselves; this one reads via
the allowlisted `src/lib/config/flags.ts`).

## Migrated reads — 31 `src/app` files + 3 non-app + the MFA proxy read
Each inline read was swapped expression-for-expression, preserving the exact boolean:
`=== 'true'` → `selfServeSignupEnabled()`; `!== 'true'` → `!selfServeSignupEnabled()`.
All reader files are server-side (no `'use client'`), so importing the server
accessor is safe in every lane (Server Components, route handlers, proxy, worker).

### app pages (Server Components) — 19
`onboarding/payment-success/page.tsx`, `(public)/book-a-demo/page.tsx`,
`(public)/help/contact/page.tsx`, `onboarding/start/page.tsx`,
`(public)/demo/[slug]/not-found.tsx`, `(public)/login/page.tsx`,
`(public)/features/page.tsx`, `(public)/signup/page.tsx`, `onboarding/pay/page.tsx`,
`onboarding/business/page.tsx`, `(public)/demo/[slug]/page.tsx`,
`(public)/pricing/page.tsx`, `(public)/signup/finish/page.tsx`,
`(public)/signup/check-email/page.tsx`, `(public)/forgot-password/page.tsx`,
`(public)/security/page.tsx`, `(public)/page.tsx`, `(public)/reset-password/page.tsx`,
`(public)/how-it-works/page.tsx`.

### app route handlers — 12
`api/onboarding/start/route.ts`, `api/onboarding/business/route.ts`,
`api/onboarding/select-plan/route.ts`, `api/signup/place-prefill/route.ts`,
`api/auth/signup-status/route.ts`, `api/auth/forgot-password/route.ts`
(`role === 'owner' && !selfServeSignupEnabled()`), `api/auth/finish-signup/route.ts`,
`api/billing/checkout/route.ts` (`selfServeSignupEnabled() && …`, inside a multi-line
condition), `api/auth/reset-password/route.ts` (`isOwner && !selfServeSignupEnabled()`),
`api/auth/signup/route.ts`, `api/auth/resend-confirmation/route.ts`,
`api/auth/verify-otp/route.ts`.

### components — 1
`src/components/legal/LegalPage.tsx` (`const selfServeEnabled = selfServeSignupEnabled()`).

### worker — 2
- `worker/index.ts` — the startup feature-flag log line (`SelfServeSignup=…`).
  STAYS in the process-env baseline: it still reads the not-yet-migrated
  `CHANNELS_*_ENABLED` / `ZERNIO_PUBLISHING_ENABLED` / `NOTIFICATION_FAILOVER_DISABLED`
  flags inline.
- `worker/background/pollers/CleanupAbandonedSignupsPoller.ts` — the start-guard
  (`if (!selfServeSignupEnabled())`). `SELF_SERVE_SIGNUP_ENABLED` was its ONLY
  `process.env` read → it now reads none → REMOVED from the baseline.

### proxy / middleware — 1 (the MFA read)
`src/proxy.ts` — `getAalGate()` now `if (!mfaEnforcementEnabled())`. Next 16 runs the
proxy file **on the Node.js runtime always** (`get-page-static-info.ts`: "Proxy always
runs on Node.js runtime"), so the dynamic `process.env[name]` inside `readFlag` resolves
at runtime exactly like the old static `process.env.MFA_ENFORCEMENT_ENABLED` access —
no Edge build-time inlining gap.

## EXEMPT — `worker/config/startup-assert.ts` left inline
`assertSelfServeSignupEnv()` reads `process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true'`
to decide whether to VALIDATE the flag's required companion env. It is the boot-assert
that owns flag/env presence and stays a sanctioned direct read (already in
`ALLOWLIST_FILES`; the eventual Stage-4 `ci:static-policy` inline-flag ban will exempt
`startup-assert.ts` + the `flags.ts` modules). Not migrated.

## Baseline
`process-env` baseline **29 → 28** — `CleanupAbandonedSignupsPoller.ts` dropped (no
remaining `process.env` read). `worker/index.ts` stays (other inline flags). The 31
`src/app` files are out of audit scope (`src/lib/**` + `worker/**` only), so they never
affected the baseline. `src/lib/auth/flags.ts` reads no `process.env` directly →
not added.

## Tests — no conversions needed
`readFlag` is NOT memoized, so every existing test that sets
`process.env.SELF_SERVE_SIGNUP_ENABLED='true'` (or MFA) before exercising a migrated
file still works — the accessor reads live. No test was changed. Added a focused
`src/lib/auth/__tests__/flags.test.ts` locking both accessors to exact-`'true'`-only
(true for `'true'`; false for unset / `''` / `'false'` / `'TRUE'` / `'1'`).

## Behavior preservation
`selfServeSignupEnabled()` / `mfaEnforcementEnabled()` are byte-for-byte
`process.env.X === 'true'` — exactly what each inline read did. Every call site kept
its exact boolean (`=== 'true'` → accessor; `!== 'true'` → `!accessor`).

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green.
