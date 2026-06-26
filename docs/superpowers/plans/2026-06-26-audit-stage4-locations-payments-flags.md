# Stage 4 — the locations / payments / onboarding / moderation feature-flag cluster

_Branch `refactor/audit-stage4-locations-payments-flags`. Builds on 4a's `readFlag`
primitive (`src/lib/config/flags.ts`). Routes six feature flags through four new
`<feature>/flags.ts` accessors. Zero behavior change._

## The accessors — four new `flags.ts` modules
Each export is a one-line wrapper over the shared `readFlag` primitive
(byte-for-byte `process.env[name] === 'true'`). Server-authoritative (invariant #13:
never a `NEXT_PUBLIC_*` companion; the browser learns state through API responses /
props).

- **`src/lib/locations/flags.ts`**
  - `multiLocationEnabled()` → `readFlag('MULTI_LOCATION_ENABLED')`
- **`src/lib/payments/flags.ts`**
  - `trialEnabled()` → `readFlag('TRIAL_ENABLED')`
  - `stripeTaxEnabled()` → `readFlag('STRIPE_TAX_ENABLED')`
  - `stripeLocationsReconcileDisabled()` → `readFlag('STRIPE_LOCATIONS_RECONCILE_DISABLED')`
    (the `*_DISABLED` name encodes the meaning; the call site still reads it as
    `=== 'true'` — true ⇒ the reconcile poller does not start).
- **`src/lib/onboarding/flags.ts`**
  - `onboardingDemoEnabled()` → `readFlag('ONBOARDING_DEMO_ENABLED')`
- **`src/lib/moderation/flags.ts`**
  - `openaiModerationEnabled()` → `readFlag('OPENAI_MODERATION_ENABLED')`

`OPENAI_MODERATION_ENABLED` now has two named accessors for two distinct feature
gates — `moderation/flags.ts` `openaiModerationEnabled()` (the inline `moderate.ts`
path) and `auto-approval/flags.ts` `providerModerationEnabled()` (the auto-approval
moderation gate, untouched here). Both route through `readFlag`; that is intentional,
not duplication to collapse.

None of the four modules reads `process.env` directly → none enters the process-env
baseline (they read via the allowlisted `src/lib/config/flags.ts`).

## Migrated reads — swapped expression-for-expression
Each inline read was swapped preserving the exact boolean: `=== 'true'` → `accessor()`;
`!== 'true'` → `!accessor()`; `X === 'true' ? a : b` → `accessor() ? a : b`. Comment
lines, JSDoc, log strings, and VAL-* annotations that merely mention a flag name were
left untouched. All reader files are server-side (no `'use client'`), so importing the
server accessor is safe in every lane (Server Components, route handlers, worker poller).

### MULTI_LOCATION_ENABLED — 9 reads
- `src/lib/channels/override.ts` — `const featureEnabled = multiLocationEnabled();`. DROPPED.
- `src/lib/locations/owner-route.ts` — `if (!multiLocationEnabled())`. DROPPED.
- `src/app/(authenticated)/layout.tsx` — `const multiLocationEnabled = isMultiLocationEnabled();`†
- `src/app/(authenticated)/settings/channels/page.tsx` — `const featureEnabled = isMultiLocationEnabled();`†
- `src/app/(authenticated)/dashboard/add-location/page.tsx` — `if (!multiLocationEnabled())`.
- `src/app/(authenticated)/settings/locations/page.tsx` — `const featureEnabled = multiLocationEnabled();`
- `src/app/api/dashboard/route.ts` — `const multiLocationEnabled = isMultiLocationEnabled();`†
- `src/app/api/dashboard/kpis/route.ts` — `const multiLocationEnabled = isMultiLocationEnabled();`†
- `src/app/api/locations/existing-place-ids/route.ts` — `if (!multiLocationEnabled())`.

† **Alias `multiLocationEnabled as isMultiLocationEnabled`** in four files where a
local identifier `multiLocationEnabled` already exists (the flag value itself, or the
multi-location *mode* in `settings/channels`). Aliasing avoids a redeclaration collision
and keeps every downstream usage of the local binding byte-for-byte. Behavior identical.

The `api/locations/{add,promote-primary,archive,reactivate}` routes and the two
`'use client'` files (`AuthenticatedProviders.tsx`, `settings/voice/VoiceClient.tsx`)
only **mention** the flag in comments — no env read — so they were not touched. The
location-mutation routes gate via `readOwnerForMultiLocationRoute` (owner-route.ts),
which now calls the accessor.

### TRIAL_ENABLED — 3 reads
- `src/app/api/onboarding/select-plan/route.ts` — `trialEnabled() && accountRow.onboarded_by === null`.
- `src/app/api/billing/checkout/route.ts` — `trialEnabled() && selfServeSignupEnabled() && …` (compound preserved).
- `src/app/(public)/page.tsx` — `const trialEnabled = isTrialEnabled() && selfServeEnabled;` (aliased
  `trialEnabled as isTrialEnabled` — the local const is named `trialEnabled`).

### STRIPE_TAX_ENABLED — 1 read
- `src/lib/payments/create-checkout-session.ts` — `const taxParams = stripeTaxEnabled() ? {…} : {}`
  (ternary preserved). File STAYS in the baseline (still reads `NEXT_PUBLIC_APP_URL`).

### STRIPE_LOCATIONS_RECONCILE_DISABLED — 1 read
- `worker/background/pollers/StripeLocationsReconcilePoller.ts` — start-guard
  `if (stripeLocationsReconcileDisabled())`. Flag was its only counted read (the other
  read, `MOCK_EXTERNAL_APIS`, is exempt #2) → DROPPED.

### ONBOARDING_DEMO_ENABLED — 10 reads
- `src/app/onboarding/demo/page.tsx` — `if (!onboardingDemoEnabled()) notFound();`
- `src/app/onboarding/start/page.tsx` — `if (!onboardingDemoEnabled()) notFound();`
- `src/app/onboarding/business/page.tsx` — `shouldUseDemoWizard(onboardingDemoEnabled(), row)`.
- `src/app/api/onboarding/start/route.ts` — `if (!onboardingDemoEnabled())`.
- `src/app/api/onboarding/business/route.ts` — `const demoFlowEnabled = onboardingDemoEnabled();`
- `src/app/api/onboarding/demo/status/route.ts` — `if (!onboardingDemoEnabled())`.
- `src/app/api/onboarding/demo/regenerate/route.ts` — `if (!onboardingDemoEnabled())`.
- `src/app/api/auth/signup-status/route.ts` — `const demoFlowEnabled = onboardingDemoEnabled();`
- `src/app/api/auth/finish-signup/route.ts` — `onboardingDemoEnabled() ? '/onboarding/start' : '/onboarding/pay'`.
- `src/app/api/auth/verify-otp/route.ts` — `onboardingDemoEnabled() ? '/onboarding/start' : '/onboarding/pay'`.

`src/lib/shared/schemas.ts` only mentions the flag in JSDoc (no read) → not touched.

### OPENAI_MODERATION_ENABLED — 1 read
- `src/lib/moderation/moderate.ts` — the single-use local wrapper
  `function providerEnabled() { return process.env.OPENAI_MODERATION_ENABLED === 'true'; }`
  became a pure duplicate of the new accessor, so it was removed and its one call site
  (`if (!providerEnabled())`) now reads `if (!openaiModerationEnabled())`. Behavior
  identical; one shallow local wrapper deleted. Flag was its only read → DROPPED.
  `auto-approval/flags.ts` `providerModerationEnabled()` (same flag, different gate)
  left as-is.

## EXEMPT — `worker/config/startup-assert.ts` left inline
`STRIPE_TAX_ENABLED` appears in the boot-assert's required-var list; that file owns
flag/env presence validation and stays a sanctioned direct read (already in
`ALLOWLIST_FILES`). Not migrated.

## Baseline
`process-env` baseline **20 → 16** — 4 files dropped (their flag was the only non-exempt
read): `channels/override.ts`, `locations/owner-route.ts`, `moderation/moderate.ts`,
`StripeLocationsReconcilePoller.ts`. STAYS:
`payments/create-checkout-session.ts` (`NEXT_PUBLIC_APP_URL`, literal #1 — not
migratable) and `onboarding/admin-onboarding-service.ts` (`NEXT_PUBLIC_APP_URL`; its
only read is not a flag — untouched). The four new `flags.ts` modules read no
`process.env` directly → not added.

## Tests — no conversions needed
`readFlag` is NOT memoized, so every existing test that sets a flag in `process.env`
before exercising a migrated file still works — the accessor reads live. No test was
changed. Added a focused `__tests__/flags.test.ts` next to each of the four new modules,
locking every accessor to exact-`'true'`-only (true for `'true'`; false for
unset / `''` / `'false'` / `'TRUE'` / `'True'` / `'1'` / `' true '`).

## Behavior preservation
Each accessor is byte-for-byte `process.env.X === 'true'` — exactly what each inline read
did. Every call site kept its exact boolean (`=== 'true'` → accessor; `!== 'true'` →
`!accessor`; ternary → `accessor() ? a : b`; compound `&&` chains preserved). The only
non-mechanical edits are (a) four `multiLocationEnabled as isMultiLocationEnabled` /
one `trialEnabled as isTrialEnabled` import aliases to dodge local-identifier collisions,
and (b) deleting the single-use `providerEnabled()` wrapper in `moderate.ts`.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green.
