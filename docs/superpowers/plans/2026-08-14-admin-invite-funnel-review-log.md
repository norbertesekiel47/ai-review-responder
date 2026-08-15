# Plan Review Log: Simplify admin beta onboarding — invite-only entry into the existing self-serve funnel

Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=10. Adversarial reviewer: Codex (read-only).

**These are settled decisions. Do not re-litigate them or "simplify" them away during implementation.**

## Round 1 — Codex

- Password setup cannot redirect directly into onboarding: `/api/auth/reset-password` explicitly signs the recovery session out after success, so `/onboarding/start` immediately sends the invitee back to login. Fix: preserve the current security posture and redirect through login with a funnel-aware post-login destination, or establish a fresh normal session before redirecting.
- Removing the flag from `/api/signup/place-prefill` makes a currently unauthenticated, SerpAPI-billed endpoint permanently public; its own comment confirms it has no auth or account-state check. Fix: require an authenticated owner with an eligible pending-payment account and rate-limit by account/auth identity as well as IP.
- A 100%-off Checkout Session does not inherently guarantee card collection, contradicting the "card-up-front" commitment and risking a month-four payment failure. Fix: explicitly require payment-method collection for coupon sessions and add a Stripe integration test/manual staging assertion.
- Coupon eligibility is not part of the durable checkout-attempt snapshot; `createCheckoutSession` currently reads only attempt fields and cannot safely derive `onboarded_by`. Env changes/retries can therefore produce inconsistent Sessions under the same attempt semantics. Fix: resolve and persist the coupon ID (or explicit no-coupon decision) while holding the activation lock, then create Stripe Sessions solely from that immutable snapshot.
- The "real admin business name" creates a data-consistency bug: both `/onboarding/start` and `/api/onboarding/business` update `accounts.display_name` only when it equals `(pending setup)`, so an owner rename leaves account and business names divergent. Fix: either make the admin-provided name immutable during onboarding or update the account display name transactionally with the authorized business-name edit.
- Resend-invite has no reliable local "never authenticated" state: `users.auth_id` is populated immediately on initial invitation, before acceptance, and provider-state checks plus resend can race with acceptance. Fix: use a staging-verified Supabase resend/generate-link flow, serialize it with an account lock, and reject based on authoritative provider sign-in/acceptance state.
- The plan treats Supabase's "already accepted" response as a known 409 mapping while listing its error shape as unresolved; brittle message matching can turn provider changes into incorrect retries or 500s. Fix: settle the supported provider behavior in staging first and encode a typed/error-code-based contract with tests.
- The flag re-scope is broader than its stated "auth + account-state" protection: `/onboarding/pay` does not filter `u.role = 'owner'`, and the plan does not enumerate every affected page/API guard. Fix: inventory every former gate and require owner role plus the exact allowed subscription/onboarding state at each server boundary.
- The rollout has no operational verification for coupon configuration or uptake; a wrong test/live coupon ID will surface only as checkout failures, while silent non-application can charge beta users. Fix: add startup/config validation plus structured checkout telemetry/alerting for coupon-selected, coupon-applied, and Stripe-rejected outcomes.

VERDICT: REVISE

### Claude's response

Verified every load-bearing claim against the code before acting. Accepted 8 of 9 findings, scaled down 1:

- ACCEPTED (verified in code): reset-password sign-out (handler step 10 is a deliberate teardown) → plan now routes through /login and makes the PendingPaymentScreen CTA funnel-aware instead of minting a session.
- ACCEPTED (verified): place-prefill is unauthenticated by its own comment → gains auth + role + state + per-auth-id rate limit when the flag gate is removed.
- ACCEPTED: payment_method_collection:'always' made explicit + staging card-on-file assertion.
- ACCEPTED (verified — checkout-attempt snapshot architecture is real and rigorous): coupon becomes a snapshotted checkout_attempt_coupon_id column resolved under the activation lock; new migration. This also surfaced a dependency Codex missed: checkout_attempt_* columns ship in migration 077, absent in prod until the WS8 cutover — added as an explicit sequencing constraint.
- ACCEPTED (verified — both routes guard on display_name = placeholder): predicates widened to sync during pending_payment.
- PARTIALLY ACCEPTED: resend-invite now gates on provider last_sign_in_at via auth.admin.getUserById (local auth_id confirmed useless — patched at creation), and error mapping is blocked on staging-verified error codes. REJECTED the account-lock/serialization requirement: the accept-vs-resend race's worst case is a duplicate email, not state corruption — a lock adds machinery with no failure mode to prevent.
- ACCEPTED: 409 mapping demoted from "known" to staging-verified contract, error-code based.
- ACCEPTED (verified — pay page query has no role filter; select-plan does): re-scope now mandates a full rg inventory of selfServeSignupEnabled call sites with per-route role+state replacement guards.
- ACCEPTED (scaled down): no boot-time validation (Vercel routes have no boot seam); instead structured log + durable PostHog event on coupon-applied/skipped, Sentry-mapped Stripe coupon errors, and a staging smoke covering $0-due + card-collected + month-4 pricing.

## Round 2 — Codex

Most prior issues are addressed, but these material gaps remain:

- The new post-reset route still skips the demo: owner login calls `/api/auth/signup-status`, and `applySubscriptionGuard` unconditionally sends every `pending_payment` owner to `/onboarding/pay`, so the proposed dashboard CTA is never reached. Fix: make post-login routing state-aware and send a demo-enabled, no-location invitee to `/onboarding/start` before the generic pending-payment override.
- The dashboard CTA cannot implement the stated "same destination logic": `PendingPaymentScreen` receives only `paymentUrl`; it has neither place state nor the server-only demo-flag decision, and `/api/dashboard` currently always supplies `/onboarding/pay`. Fix: compute and return a server-authoritative `funnelUrl` in both dashboard/settings pending-payment responses, based on owner state and `onboardingDemoEnabled()`.
- Step 6 says all funnel surfaces should allow `pending_payment`, but `/onboarding/business` is necessarily post-payment and requires `active`/`trialing`; `/onboarding/payment-success` also must remain reachable while Stripe projection is pending. Fix: add an explicit per-route state matrix rather than the blanket pending-payment rule.
- The plan calls the hardened prefill endpoint `POST`, but the actual endpoint and client call are `GET`; implementing the written plan literally either breaks the client or leaves the existing public GET unprotected. Fix: specify `GET /api/signup/place-prefill` everywhere and test anonymous GET rejection.
- The coupon migration must update `accounts_checkout_attempt_complete_check`: without including the new column in the null-at-rest branch, the database permits a cleared attempt to retain a coupon snapshot, violating the attempt-completeness invariant. Fix: replace the check to require `checkout_attempt_coupon_id IS NULL` when `checkout_attempt_state IS NULL`, with migration integration coverage.

VERDICT: REVISE

### Claude's response

All five verified in code and ACCEPTED — no rejections this round:

- Verified `loginDestination.ts:43` unconditionally routes pending_payment → /onboarding/pay, and `PendingPaymentScreen` renders only a hardcoded paymentUrl from `/api/dashboard/route.ts:127,325`. Merged findings 1+2 into one fix: a single server-side `resolveFunnelEntry(ownerState)` helper (extracted from verify-otp's logic) whose output `funnelUrl` is returned by signup-status AND the dashboard/settings pending-payment responses; loginDestination and PendingPaymentScreen both consume it. One owner for the decision instead of two patched call sites.
- Blanket pending_payment rule replaced with an explicit per-route state matrix (start/demo and pay = pending_payment; payment-success + signup-status reachable across the Stripe-projection transition; business = post-payment full-access + wizard-incomplete).
- POST→GET corrected for place-prefill; anonymous-GET rejection test mandated.
- Migration step now explicitly rewrites `accounts_checkout_attempt_complete_check` (verified the null-at-rest branch in 077 enumerates every attempt column) adding `checkout_attempt_coupon_id IS NULL` to the null branch, with migration-shape integration coverage.

## Round 3 — Codex

Most prior findings are addressed. Remaining material issues:

- `resolveFunnelEntry` omits `/onboarding/demo`: a pending owner who already captured a place and later logs in will be sent to `/onboarding/pay`, skipping the promised demo; the correct return point is `/onboarding/demo` (which already handles a cost-blocked sentinel). Fix: add the demo state to the helper matrix: pending + demo enabled + location present → `/onboarding/demo`.
- The claimed single owner of funnel routing does not include `/api/auth/verify-otp`, which currently implements its own flag-only `/onboarding/start` vs `/onboarding/pay` decision. Fix: make `verify-otp` call `resolveFunnelEntry` too, with a test covering all matrix states.
- Coupon eligibility is defined on `businesses.onboarded_by`, but `applyTierSnapshot` locks/reads at account scope and its existing query joins all account businesses; a naïve implementation can make a multi-location account's coupon decision depend on an arbitrary location. Fix: resolve eligibility from the owner's primary business (`b.is_primary = TRUE`) under the activation lock, or pass a primary-business-derived boolean into the locked snapshot transaction.
- Step 10 still calls the self-serve prefill route `POST` despite correctly identifying it as `GET` in step 6. Fix: change the remaining reference to `GET` so implementation and docs cannot harden the wrong handler.

VERDICT: REVISE

### Claude's response

All four ACCEPTED, no rejections:

- Funnel matrix gains the demo return point: pending + demo enabled + place present → /onboarding/demo.
- verify-otp added as consumer (a) of resolveFunnelEntry — its private start-vs-pay branch is deleted; matrix states unit-tested.
- Coupon eligibility now explicitly scoped to the primary business (b.is_primary = TRUE) under the activation lock — onboarded_by lives on businesses, and multi-location accounts would otherwise resolve from an arbitrary row.
- Leftover POST reference in step 10 corrected to GET.

## Round 4 — Codex

The revised plan addresses the prior blockers: it now preserves the demo return state, centralizes all funnel routing (including OTP), scopes coupon eligibility to the primary business, fixes the prefill method, and extends the checkout-attempt constraint.

VERDICT: APPROVED
