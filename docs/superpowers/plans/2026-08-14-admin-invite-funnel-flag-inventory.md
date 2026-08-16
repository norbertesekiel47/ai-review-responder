# `SELF_SERVE_SIGNUP_ENABLED` gate inventory — authoritative

Source: `rg -n "selfServeSignupEnabled"` at fork point `2b3c872a`. Every production call site is listed. After this change the flag means exactly one thing: **strangers may mint accounts**.

Legend — **KEEP**: the flag still gates this site. **REMOVE**: the flag check is deleted and the row's replacement guard becomes the boundary.

## Removed gates (10 production sites)

| # | Call site | Old gate | Replacement guard (auth + role + state) |
|---|---|---|---|
| 1 | `src/app/(public)/login/page.tsx:10` | `notFound()` | none needed — standard always-on auth page; rate-limited + same-origin at the API |
| 2 | `src/app/(public)/forgot-password/page.tsx:10` | `notFound()` | none needed — always-on auth page |
| 3 | `src/app/(public)/reset-password/page.tsx:10` | `notFound()` | none needed — always-on auth page; the API still requires a recovery session |
| 4 | `src/app/api/auth/forgot-password/route.ts:75` | `role === 'owner' && !flag` → 404 | authenticated-by-email lookup unchanged + existing strict rate limit + same-origin |
| 5 | `src/app/api/auth/reset-password/route.ts:122` | `isOwner && !flag` → 404 | recovery session required (existing) + `role` lookup + 5/hr strict per-authId limit; **the deliberate post-write `signOut()` and `redirectTo: '/login'` are preserved** |
| 6 | `src/app/api/auth/signup-status/route.ts:82` | `!flag` → 404 | authenticated session + SQL `u.role = 'owner'` (existing) + reachable in `pending_payment` **and** post-payment states (Stripe projection may still be pending — polling must not 403 mid-transition) |
| 7 | `src/app/api/onboarding/start/route.ts:173` | `!flag` → 404 | `onboardingDemoEnabled()` (retained) + authenticated session + `u.role = 'owner'` (existing) + `subscription_status = 'pending_payment'` (existing 409) |
| 8 | `src/app/api/onboarding/select-plan/route.ts:34` | `!flag` → 404 | authenticated session + `u.role = 'owner'` (already present) + `pending_payment` |
| 9 | `src/app/api/onboarding/business/route.ts:65` | `!flag` → 404 | authenticated session + `u.role = 'owner'` + `subscriptionGrantsFullAccess(status)` + wizard-incomplete (existing guard logic retained) |
| 10 | `src/app/api/signup/place-prefill/route.ts:37` | `!flag` → 404 (route was otherwise **unauthenticated**) | **new**: authenticated session + `role = 'owner'` + pre-activation account state + existing strict per-IP 10/min **plus** a new per-auth-id 10/min strict limit (mirrors `api/admin/businesses/prefill`) |

## Removed gates — pages (4 production sites)

| # | Call site | Old gate | Replacement guard |
|---|---|---|---|
| 11 | `src/app/onboarding/start/page.tsx:27` | `notFound()` | `onboardingDemoEnabled()` (retained) + session + `u.role = 'owner'` + `pending_payment` |
| 12 | `src/app/onboarding/pay/page.tsx:30` | `notFound()` | session (existing) + **new `AND u.role = 'owner'` filter on the page query** + `pending_payment` (existing redirects) |
| 13 | `src/app/onboarding/payment-success/page.tsx:13` | `notFound()` | session + `role = 'owner'`; reachable in `pending_payment` **and** post-payment states |
| 14 | `src/app/onboarding/business/page.tsx:22` | `notFound()` | session + `role = 'owner'` + post-payment full access + wizard-incomplete (existing `guard.ts`) |

## Kept gates

| Call site | Why it stays |
|---|---|
| `src/app/(public)/signup/page.tsx:10` | anonymous account-minting entry point |
| `src/app/(public)/signup/check-email/page.tsx:10` | signup sub-page |
| `src/app/(public)/signup/finish/page.tsx:12` | signup sub-page (OAuth finish) |
| `src/app/api/auth/signup/route.ts:21` | mints the account |
| `src/app/api/auth/finish-signup/route.ts:29` | mints the account (OAuth) |
| `src/app/api/auth/verify-otp/route.ts:43` | completes anonymous account-minting. **Its internal `onboardingDemoEnabled()` start-vs-pay branch is deleted** and replaced by `resolveFunnelEntry` (plan step 7) — the top-level flag gate itself stays |
| `src/app/api/auth/resend-confirmation/route.ts:27` | resends the signup confirmation email — part of the minting flow |
| `src/lib/payments/plan-activation.ts` — `isTrialEligible` | compound `trialEnabled() && selfServeSignupEnabled() && pending_payment && primary onboarded_by IS NULL`. Trial eligibility is a self-serve-only policy, so the re-scoped flag meaning still matches exactly. **Moved here 2026-08-15 (PF-H2)** from `src/app/api/billing/checkout/route.ts:156`: `resolveCheckoutContext` carried a second, laxer copy (first and last term only), so the funnel and the billing route answered the same question differently. Both entry points now call this one function, and the funnel's answer became the strict one |
| `src/app/(public)/{page,pricing,features,how-it-works,security,book-a-demo,help/contact}.tsx`, `src/app/(public)/demo/[slug]/{page,not-found}.tsx`, `src/components/legal/LegalPage.tsx` | marketing CTA display ("Start free" vs "Book a demo") — these advertise anonymous signup, which is precisely what the flag now means |
| `src/lib/auth/flags.ts:8` | the reader itself (doc comment updated to state the re-scoped meaning) |
| `src/lib/auth/__tests__/flags.test.ts` | reader unit test |
| `worker/background/pollers/CleanupAbandonedSignupsPoller.ts:285` | sweeps abandoned **anonymous** signups. Verified safe for invitees regardless: its candidate query requires `a.id IS NULL` (no account), and `runAdminTx` always creates the `accounts` row — an admin-invited owner can never be a candidate |
| `worker/index.ts:548` | boot-time flag-state log line |
| `scripts/ci/process-env-baseline.ts:176`, `scripts/ci/static-policy-audit.ts:926` | comment / message text only |
