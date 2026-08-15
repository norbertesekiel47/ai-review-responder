# Plan: Simplify admin beta onboarding — invite-only entry into the existing self-serve funnel

_Locked via grill (Claude + Norbert). Adversarially reviewed by Codex over 4 rounds — **VERDICT: APPROVED** (round 4). Review rationale: `2026-08-14-admin-invite-funnel-review-log.md` (same directory). Do not re-litigate settled decisions or "simplify" them away._

Branch: `admin-invite-funnel` · Intake contract: `admin-invite-funnel-intake.json`

Repo: Next.js 16 on Vercel (UI-only) + Railway worker + Supabase/Postgres + Stripe. Beta posture: admin-invited testers only; live launch later flips to public self-serve signup.

## Goal

Collapse the two onboarding journeys into one. Today the admin fills a 4-section form (business info + place, owner info, voice & context, tier) at `/admin/businesses/new`, and the invited owner then lands on a dead-end `PendingAdminHandoffScreen` in `pending_payment` with no activation mechanism at all (runbook says "message Norbert"), later re-entering the same voice fields at `/settings/voice`. After this change, the admin enters only **owner email, owner name, business name**; the invited owner walks the **existing self-serve funnel end-to-end** — set password → place capture → AI demo → Stripe checkout (100%-off 3-month beta coupon auto-applied, $0 due today, card still collected) → wizard (Profile → Voice → Connect Google) → dashboard. Activation happens through the real Stripe checkout so `worker/ingress/stripe/apply-subscription-state.ts` remains the single status applier and launch day is a rehearsal of the same rails.

## Sequencing dependency (prod)

The checkout-attempt machinery (`checkout_attempt_*` columns) ships in migration **077**. This plan **lands on `staging` now but goes live in prod only at/after the WS8 cutover**. The new migration is **105** (head at fork was 104), staging first, prod in the normal lockstep.

> **Superseded 2026-08-14 (#825).** This section originally said 077 "is deliberately absent in prod until the WS8 tier cutover". The migration lockstep audit found 077 **already applied in prod** — it landed unrecorded after the 2026-07-17 cutover pause — and 105 was then applied there too, once its only blocker proved satisfied. **078 is now the sole migration absent in prod.** The plan's own sequencing logic is unchanged (105 still depends on 077's columns); only the claim about prod's state was wrong. Current state always: `.claude/CLAUDE.md` standing exception.

## Approach (the 12 locked steps)

1. **Stripe coupon (ops, no code).** Create a coupon `100% off, duration=repeating, duration_in_months=3` in Stripe test mode (staging) and live mode (prod). Add env var `BETA_COMP_COUPON_ID` (server-only, Vercel; staging first) holding the coupon ID. Document in `.claude/reference/env-vars.md`. Unset at launch = kill switch for *new* attempts (snapshotted attempts keep their coupon — deliberate, see step 2).

2. **Coupon rides the checkout-attempt snapshot, not a live env read.** `createCheckoutSession` (`src/lib/payments/create-checkout-session.ts`) builds Stripe params solely from the durable `checkout_attempt_*` snapshot with a per-attempt idempotency key, so a live env-var read would let an env change between attempt creation and retry produce different params under the same idempotency key. Instead:
   - New migration: nullable `checkout_attempt_coupon_id` column alongside the existing `checkout_attempt_*` columns, **including updating the `accounts_checkout_attempt_complete_check` constraint** (077 defines it with an explicit null-at-rest branch enumerating every attempt column): the null branch gains `AND checkout_attempt_coupon_id IS NULL` so a cleared attempt cannot retain a coupon snapshot; the active branch leaves it nullable (no-coupon is a valid complete attempt). Migration-shape integration coverage per the live-DB suite conventions.
   - `applyTierSnapshot` (`src/lib/payments/plan-activation.ts`) resolves the coupon **while holding the activation lock**: eligibility reads `onboarded_by` from the account's **primary business** (`b.is_primary = TRUE` — the column lives on `businesses`, and an unscoped join on a multi-location account would make the decision depend on an arbitrary row) AND `BETA_COMP_COUPON_ID` set → persist the ID; else persist NULL (an explicit no-coupon decision).
   - `checkoutAttemptMatchesRequest` validates the column like its siblings; `buildCheckoutSessionParams` emits `discounts: [{ coupon }]` from the snapshot. `allow_promotion_codes` is already `false` (verified) — no Stripe mutual-exclusion conflict.
   - **Card is still collected at $0-due:** set `payment_method_collection: 'always'` explicitly on coupon sessions (don't rely on Stripe's subscription-mode default), and assert card-on-file in the staging smoke test. No trial conflict: `onboarded_by` accounts are already never trial-eligible.

3. **Shrink the admin form to 3 fields.** `/admin/businesses/new` keeps: owner email, owner name, business name. Delete the Place capture (PlaceAutocomplete/Maps-URL toggle), Voice & Context section, and Subscription Tier section. Files: `NewBusinessClient.tsx`, `schema.ts`, `_components/{BusinessInfoSection,OwnerInfoSection,VoiceContextSection,SubscriptionTierSection}.tsx`, `_hooks/useBusinessPrefill.ts`. Shrink `OnboardBusinessSchema` (`src/lib/shared/schemas.ts`) accordingly. Also delete the dead `paymentUrl` branch in `NewBusinessClient.tsx:74-87` (server has always returned `null`).

4. **Slim the admin creation service.** `src/lib/onboarding/admin-onboarding-service.ts` + `src/lib/onboarding/create-business.ts` (`runAdminTx`): drop `resolvePlaceIdInput`, voice/context fields, and tier input (create as `copilot` default like self-serve; owner picks the real tier at `/onboarding/pay` — remove the admin-path `assertTierPurchasable` call). Business row keeps: `name` (real, from admin), owner name/email, `onboarded_by`, no place, empty voice arrays, default tone. Keep: `accounts.display_name = businessName`, `subscription_status='pending_payment'`, email `channel_enrollments` verified-at-creation, `inviteUserByEmail` + `auth_id` patch + rollback logic, founding-window price snapshot. No `validate_place_id` outbox row (the owner's `/api/onboarding/start` handles place, as it does for self-serve).

5. **Keep `accounts.display_name` in sync during onboarding.** `/api/onboarding/start` and `/api/onboarding/business` currently update `display_name` only `WHERE display_name = '(pending setup)'`, so an owner renaming the business would leave the admin-typed account name divergent. Change both predicates to update whenever `subscription_status = 'pending_payment'` OR display_name is the placeholder (pre-activation, the name is still forming; post-activation renames stay out of scope). Also prefill `/onboarding/start`'s business-name input from `businesses.name` when it isn't the placeholder.

6. **Re-scope `SELF_SERVE_SIGNUP_ENABLED` to gate only anonymous account-minting — with a full gate inventory and per-route replacement guards.** Keeps gating: `/signup`, `/signup/*` pages, `POST /api/auth/signup`, `POST /api/auth/finish-signup`, `POST /api/auth/verify-otp`. Stops gating:
   - **Always-on auth surfaces**: `/login`, `/forgot-password`, `/reset-password` pages + APIs (`/api/auth/reset-password` drops its owner flag-gate branch). Fixes the live bug: the invite email's redirect target 404s under documented beta posture, and beta owners can't self-recover passwords.
   - **Funnel surfaces — flag check replaced by explicit auth + role + state guards, route by route.** The existing SQL guards are NOT uniformly sufficient (verified: `/onboarding/pay`'s page query has no `u.role = 'owner'` filter; `/api/onboarding/select-plan` does). Implementation step: enumerate every `selfServeSignupEnabled()` call site (`rg` produces the authoritative list), and for each removed check ensure the boundary enforces authenticated user + `u.role = 'owner'` + the **route's own allowed-state set** — a per-route matrix, NOT a blanket `pending_payment` rule:

     | Surface | Allowed subscription/onboarding state |
     |---|---|
     | `/onboarding/start`, `/onboarding/demo` + their APIs | `pending_payment` (existing demo-lane gates unchanged) |
     | `/onboarding/pay`, `/api/onboarding/select-plan` | `pending_payment` |
     | `/onboarding/payment-success`, `GET /api/auth/signup-status` | reachable in `pending_payment` AND post-payment states (Stripe projection may still be pending — polling must not 403 mid-transition) |
     | `/onboarding/business` + its API | post-payment: `subscriptionGrantsFullAccess(status)`, wizard incomplete (existing guard logic retained) |

   - **`GET /api/signup/place-prefill` gains real auth** (it is a GET — verified; the hardening applies to the existing GET handler, no method change): today it is deliberately unauthenticated (flag + per-IP rate limit only) — removing the flag would make a SerpAPI-billed endpoint permanently public. Add: authenticated session required, `role='owner'`, account in a pre-activation onboarding state, keep the strict per-IP limit and add a per-auth-id limit (mirror the admin prefill route's 10/min pattern). Test anonymous GET rejection explicitly.
   - The demo lane's double gate (`onboardingDemoEnabled() AND selfServeSignupEnabled()`) becomes just `onboardingDemoEnabled()`.

7. **Post-password routing — keep the sign-out, route through login, and make the funnel destination server-authoritative in ONE place.** `POST /api/auth/reset-password` deliberately destroys the recovery session after the password write (verified, step 10 of the handler) — preserve that posture; `redirectTo` stays `/login`. But post-login routing is currently demo-blind: `loginDestination.ts:43` sends every `pending_payment` owner unconditionally to `/onboarding/pay`, and `PendingPaymentScreen` renders only a hardcoded `paymentUrl` (`/api/dashboard/route.ts:127,325`) — so without changes the invitee would skip the demo entirely. Fix, one owner for the decision: a server-side `resolveFunnelEntry(ownerState)` helper covering the full matrix — `pending_payment` + demo enabled + no place → `/onboarding/start`; `pending_payment` + demo enabled + place present → `/onboarding/demo` (the return point for an owner who captured a place then dropped off; the demo page already handles its cost-blocked sentinel); `pending_payment` otherwise → `/onboarding/pay`; post-payment + wizard incomplete → `/onboarding/business`; else `/dashboard`. Consumers — ALL of them, so the decision truly has one owner: (a) `POST /api/auth/verify-otp` replaces its own flag-only start-vs-pay branch with the helper; (b) `GET /api/auth/signup-status` returns `funnelUrl`, and `loginDestination.ts` uses it instead of its hardcoded `pending_payment → /onboarding/pay` branch (flag state stays server-side, invariant #13); (c) the dashboard + settings `pending_payment` responses return the same server-computed `funnelUrl`, which `PendingPaymentScreen`'s CTA renders. Unit tests cover every matrix state. Benefits the existing self-serve abandon-and-return path identically.

8. **Delete the admin-handoff dead end.** Remove `pending_payment_admin_handoff` special-casing from `src/app/api/dashboard/route.ts` and `src/app/api/settings/route.ts`; delete `PendingAdminHandoffScreen.tsx` and its `DashboardContent.tsx` branch. Admin-invited `pending_payment` owners get the standard self-serve treatment: `PendingPaymentScreen` → funnel → checkout (which now carries the coupon). Existing stuck accounts self-heal on this rail — their place/voice are already populated so the wizard guard (`src/app/onboarding/business/guard.ts`) routes them past steps they don't need.

9. **Resend invite.** New `POST /api/admin/businesses/[id]/resend-invite` (admin + AAL2 + same-origin, mirroring the create route's guards). Eligibility: account `pending_payment` AND provider says the owner never signed in — checked via `supabase.auth.admin.getUserById(auth_id)` → `last_sign_in_at IS NULL` (NOT via local `auth_id`, which is populated at creation time before acceptance — verified). Then `inviteUserByEmail` again with the same `redirectTo`. **Staging-first contract work**: verify Supabase's actual re-invite behavior and error shapes on an already-accepted user in staging BEFORE writing the error mapping; encode the mapping against error codes/status (not message text) with tests. No account lock: the only race (owner accepts while admin resends) is benign — worst case a duplicate email whose link is dead or re-usable, never a state corruption. Button on `/admin/businesses/[id]`.

10. **Delete the orphaned SerpAPI prefill route.** `GET /api/admin/businesses/prefill` + `useBusinessPrefill` (its only consumer was the deleted Place/voice prefill). Self-serve `GET /api/signup/place-prefill` stays (hardened per step 6).

11. **Coupon observability + config verification.** (a) Structured log + PostHog durable event on every checkout-session creation recording coupon-applied vs no-coupon (and why: not-invited / env-unset), so silent non-application of the comp is visible before a beta tester gets charged. (b) A wrong coupon ID fails the Stripe session-creation call — map that error to a clear admin-visible message and a Sentry report rather than a generic checkout failure. (c) Staging smoke (runbook addendum): create invite → checkout shows $0 due today → card collected → subscription active with discount → month-4 phase shows full price.

12. **Tests + docs.** Update: admin create route tests (3-field schema, no tier assertion), `admin-onboarding-service.test.ts`, wizard guard tests, checkout tests (coupon snapshotted at applyTierSnapshot iff `onboarded_by` + env; session params built from snapshot; `payment_method_collection:'always'` with coupon; attempt-match validation), reset-password tests (flag branch removed, redirect unchanged), flag re-scope tests per route (gated surfaces 404 without flag; un-gated surfaces enforce role+state — including the pay page's new `role='owner'` filter; place-prefill 401s anonymously), display_name sync tests, resend-invite route tests (provider-state gating, error-code mapping). Docs: rewrite `docs/runbooks/beta-onboarding-cofounder-guide.md` flow, `env-vars.md` (new var), `docs/directory.md` (deleted files), flag-posture docs (`launch-flag-readiness.md`, `rollback.md`) for the new flag semantics, `migrations-log.md` for the new column. Verify: `pnpm lint && pnpm typecheck && pnpm test`; DB-touching paths `pnpm ci:tenant-scope && pnpm ci:rls-audit`. Ship via `staging` first, then PR to `main`; prod flip waits on the WS8 cutover dependency above.

## Key decisions & tradeoffs

- **Activation = real Stripe checkout with a comped coupon**, not an admin "activate" button and not out-of-band Stripe Dashboard work. Preserves "Stripe is the source of truth" (invariant #11), deletes the dead end, rehearses launch rails. Tradeoff: beta testers must enter a card for $0-today checkout (accepted — card-up-front matches the post-beta trial model; `payment_method_collection:'always'` makes it explicit).
- **Coupon eligibility marker is `onboarded_by IS NOT NULL`**, not a new per-account comp flag. Accepted constraint: during the beta window *every* admin invitee is comped; a concierge-paid invite is the trigger to add a per-account flag. Kill switch = unset the env var (affects new attempts only; snapshotted attempts keep their decision — that's the idempotency contract, not a bug).
- **Coupon is snapshotted into the checkout attempt** (new column + migration) rather than read live at session creation. Costs a migration; buys consistency with the existing attempt architecture and immunity to env-change/retry races under Stripe idempotency keys.
- **Invited owners get the AI demo lane too** (place capture → 3 real reviews + drafted replies → paywall). Chosen for the live-call wow moment; ~3¢/demo under the existing demo cost-guard. Bonus: the invited journey is byte-for-byte the self-serve journey — zero special wizard shapes.
- **Flag re-scope over new flag or per-account carve-outs** — one flag whose meaning becomes "strangers may mint accounts". The re-scope is paired with an explicit per-route guard inventory because the pre-existing SQL guards are not uniformly role-filtered (pay page verified missing `role='owner'`).
- **Post-password routing goes through `/login`**, preserving the handler's deliberate recovery-session teardown, instead of minting a fresh session server-side for a direct funnel redirect. One extra click; zero new auth machinery; the funnel-aware CTA benefits self-serve returners too.
- **Tier selection moves entirely to the owner** at `/onboarding/pay` (Copilot-only while `AUTOPILOT_PURCHASABLE=false`). Admin loses Autopilot pre-assignment — irrelevant while all autonomy flags are OFF in prod.
- **Making `/login`/`/forgot-password`/`/reset-password` always-on** slightly widens the anonymous surface during beta. Accepted: standard auth pages, already rate-limited (5/hr strict on reset) and same-origin-guarded; beta customers need password recovery anyway.

## Risks / open questions

- **WS8 cutover dependency** (above): prod can't run this checkout path until 077/078 land there. Staging is unaffected. Confirm cutover timing before promising beta invitees the new flow in prod.
- **Prod flag-state assumption**: verify the live prod `SELF_SERVE_SIGNUP_ENABLED` value before relying on "invites were always 404" (it may have been flipped temporarily per-onboarding). Doesn't change the design.
- **Supabase re-invite semantics** are a staging-verified contract, not an assumption — step 9 blocks the error-mapping code on that check.
- **`/api/auth/verify-otp` stays signup-gated** — confirm invited owners never hit it (they use `type='invite'` via `/api/auth/callback`); if any recovery path routes owners through OTP verification, revisit that gate placement.
- Old-flow pending accounts with a **Maps-URL place** (`place_id_verified=false`) — confirm the wizard guard + checkout path treat them the same as verified-place rows (guard checks place presence, not verification).

## Out of scope

- No changes to the self-serve signup surfaces themselves (`/signup`, OTP verification, Google OAuth finish) beyond the flag re-scope.
- No changes to the demo lane mechanics, cost-guard, wizard steps, Zernio connect, or import-offer flow — invited owners consume them as-is.
- No per-account comp flag / concierge-paid invite support (deferred until a real case appears).
- No admin "activate" button or any non-Stripe status-writing path.
- No post-activation `display_name` rename sync, and no change to the `/api/settings` editable-field asymmetry (staff names / highlight facts stay admin-write-only).
- No changes to multi-location, offboarding, or solicitation flows.

---

# Ticket decomposition (tracer bullets)

Each ticket is a thin vertical slice with a disjoint file set from any ticket it runs beside. Blocking edges are explicit. Tests named here are the `tests_to_add` titles from the intake contract and must appear VERBATIM.

## T1 — Migration 105: `checkout_attempt_coupon_id` + constraint rewrite
**Blocks:** T3. **Runs alone (first — enforcement spot check).**
Files: `supabase/migrations/105_checkout_attempt_coupon.sql`, `src/lib/shared/__tests__/helpers/schema-ready.ts`, `src/lib/shared/__tests__/migration-105-checkout-attempt-coupon.integration.test.ts`, `.claude/reference/migrations-log.md`.
- Add nullable `checkout_attempt_coupon_id TEXT` to `accounts`.
- `DROP`/`ADD` `accounts_checkout_attempt_complete_check` reproducing 077's two branches byte-for-byte with ONE addition: the null-at-rest branch gains `AND checkout_attempt_coupon_id IS NULL`. The active branch does NOT constrain it (nullable = valid no-coupon attempt).
- Shape suite follows `migration-098-suppression-corrections.integration.test.ts`: `assertSchemaReady`, no run-time DDL, `acquireLiveDbLock` not required (no DDL executed).
Tests: `migration 105 adds nullable accounts.checkout_attempt_coupon_id`, `null-at-rest attempt rejects a retained coupon snapshot`, `active attempt accepts a null coupon (no-coupon is a complete attempt)`, `active attempt accepts a coupon id`.

## T2 — `resolveFunnelEntry` module (pure, no consumers yet)
**Blocks:** T6. **Parallel-safe with T3, T4, T5.**
Files: `src/lib/onboarding/funnel-entry.ts` (new), `src/lib/onboarding/__tests__/funnel-entry.test.ts` (new).
- Pure function over an explicit owner-state object: `{ subscriptionStatus, demoEnabled, hasPlace, wizardCompleted }` → funnel URL. No DB, no env read inside (the caller passes `onboardingDemoEnabled()`), so it is trivially matrix-testable and invariant #13-safe.
Tests: the five matrix titles.

## T3 — Coupon snapshot + session params + observability
**Blocked by:** T1. **Parallel-safe with T2, T4, T5.**
Files: `src/lib/payments/checkout-attempt.ts`, `src/lib/payments/plan-activation.ts`, `src/lib/payments/create-checkout-session.ts`, `src/lib/payments/flags.ts`, `src/lib/payments/__tests__/**`, `src/lib/analytics/events.ts` (event name), `.claude/reference/env-vars.md`, `.env.example`.
- `betaCompCouponId()` flag reader in `src/lib/payments/flags.ts` (server-only; NOT a `NEXT_PUBLIC_*`).
- Coupon resolution inside `applyTierSnapshot`'s transaction: the existing account SELECT gains `MAX(b.onboarded_by) FILTER (WHERE b.is_primary)`-equivalent primary-business scoping (an explicit `b.is_primary = TRUE` join predicate on the existing LEFT JOIN would break the `active_locations` COUNT — add a separate scalar subquery instead).
- Persist `checkout_attempt_coupon_id` in the same UPDATE as the rest of the snapshot.
- `checkoutAttemptMatchesRequest` validates the coupon column; `buildCheckoutSessionParams` emits `discounts` + `payment_method_collection: 'always'` when a coupon is present.
- Structured log + durable analytics event recording the coupon decision and its reason.
- Stripe invalid-coupon error → named error + `reportCaughtError`.
Tests: the coupon/session/analytics titles from the intake.

## T4 — Flag re-scope + per-route guards + place-prefill hardening + display_name sync
**Parallel-safe with T2, T3.** **Blocks:** T5.
Files: `src/app/(public)/{login,forgot-password,reset-password}/page.tsx`, `src/app/api/auth/{forgot-password,reset-password}/route.ts`, `src/app/api/onboarding/{start,business,select-plan}/route.ts`, `src/app/onboarding/{start,pay,payment-success,business}/page.tsx`, `src/app/api/signup/place-prefill/route.ts`, `src/app/api/auth/signup-status/route.ts` (flag removal only — `funnelUrl` is T5), plus their `__tests__`.
- Follow the state matrix above, route by route. `/onboarding/pay` page query gains `AND u.role = ${ownerRole}`.
- `place-prefill`: authenticated owner + pre-activation state + per-auth-id 10/min strict limit alongside the existing per-IP limit.
- `display_name` sync predicates widened to `(subscription_status = 'pending_payment' OR display_name = PLACEHOLDER_BUSINESS_NAME)`; `/onboarding/start` prefills the business-name input from `businesses.name` when it is not the placeholder.
Tests: every flag/guard/prefill/display_name title from the intake.

## T5 — Funnel-entry consumers + admin-handoff deletion
**Blocked by:** T2, T4.
Files: `src/app/api/auth/verify-otp/route.ts`, `src/app/api/auth/signup-status/route.ts`, `src/components/auth/shared/loginDestination.ts`, `src/components/auth/hooks/useLoginSubmit.ts`, `src/app/api/dashboard/route.ts`, `src/app/api/settings/route.ts`, `src/lib/dashboard/types.ts`, `src/components/dashboard/DashboardContent.tsx`, `src/components/dashboard/account-state/PendingPaymentScreen.tsx`, **delete** `src/components/dashboard/account-state/PendingAdminHandoffScreen.tsx`, `src/hooks/useSettingsForm.ts`, plus their `__tests__`.
- `funnelUrl` computed server-side and returned by signup-status + dashboard + settings pending-payment responses; `PendingPaymentScreen` CTA renders it.
- Delete `pending_payment_admin_handoff` everywhere (type, branches, screen, settings hook) and fix every cross-reference in live docs.
Tests: the consumer titles from the intake.

## T6 — Admin form shrink + service slim + prefill-route deletion
**Blocked by:** T2 (no code dependency, but keeps the admin surface serialized after the funnel module lands). **Parallel-safe with T5.**
Files: `src/app/admin/businesses/new/{NewBusinessClient.tsx,schema.ts}`, `src/app/admin/businesses/new/_components/{BusinessInfoSection,OwnerInfoSection}.tsx`, **delete** `_components/{VoiceContextSection,SubscriptionTierSection}.tsx` + `_hooks/useBusinessPrefill.ts` + `src/app/api/admin/businesses/prefill/**`, `src/lib/shared/schemas.ts`, `src/lib/onboarding/{admin-onboarding-service,create-business}.ts`, `src/app/api/admin/businesses/route.ts`, plus their `__tests__`.
Tests: the admin-onboarding titles from the intake.

## T7 — Resend invite
**Parallel-safe with T5/T6** (disjoint: `[id]` subtree only).
Files: `src/app/api/admin/businesses/[id]/resend-invite/route.ts` (new), `src/lib/onboarding/resend-invite.ts` (new, incl. the provider error mapping), `src/app/admin/businesses/[id]/BusinessDetailClient.tsx`, `src/app/admin/businesses/[id]/_hooks/useBusinessDetail.ts`, plus `__tests__`.
- Mapping module header must be marked **"staging-verify before prod"**; unknown provider error → `502` with the raw provider code logged, never an automatic retry.
Tests: the resend-invite titles from the intake.

## T8 — Docs sweep
**Blocked by:** all.
Files: `docs/runbooks/beta-onboarding-cofounder-guide.md`, `docs/directory.md`, `docs/launch-checklist.md`, flag-posture docs, `.claude/reference/env-vars.md`, `.claude/reference/migrations-log.md`, `CONTEXT.md` (new/sharpened terms).

## Flag-gate inventory (authoritative — from `rg -n "selfServeSignupEnabled"` at the fork point)

See `2026-08-14-admin-invite-funnel-flag-inventory.md` in this directory.
