# Spec & correctness review — `admin-invite-funnel` (round 1)

Reviewer axis: **spec fidelity + correctness bugs + blast-radius semantic breaks.**
Diff under review: `git diff 2b3c872ab9229807cd7aa93259daa85ccdedd012..HEAD` (116 files, +7158/−1636).
Contract of record: `.feature/intake.json` (identical to `docs/superpowers/plans/admin-invite-funnel-intake.json`).

---

## Findings (≥80% confidence)

| # | severity | file:line | finding |
|---|---|---|---|
| F1 | major | `src/app/api/signup/place-prefill/route.ts:140` | The new pre-activation guard 403s the post-payment wizard's only prefill caller (`src/app/onboarding/business/StepLocation.tsx:79`), silently killing category/website prefill in the non-demo wizard. |
| F2 | major | `src/lib/payments/create-checkout-session.ts:384` | `CheckoutCouponConfigurationError`'s remediation advice cannot work: a wedged `creating` attempt keeps its bad coupon snapshot forever and every retry reuses it (`plan-activation.ts:255`). |
| F3 | major | `src/app/api/billing/checkout/route.ts:207` | The second `createCheckoutSession` consumer never maps `CheckoutCouponConfigurationError` — a coupon fault there still returns the generic "Unable to connect to payment provider", the exact D-16 defect. |
| F4 | major | `CONTEXT.md:126` (also `docs/launch-checklist.md:89,131`, `docs/runbooks/beta-production-standup.md:222`) | Four LIVE docs — three of them written by this branch after the fix — still assert `allow_promotion_codes` stays `false` / "no Stripe mutual-exclusion conflict", the falsified claim that caused the staging outage. |
| F5 | minor | `src/app/onboarding/pay/__tests__/page.test.tsx:58` | `tests_to_add` entry "onboarding pay page 404s for a non-owner user" asserts a redirect to `/signup`, not a 404 (D-6 item 2 asks a reviewer to decide). |

---

## F1 — place-prefill hardening breaks the post-payment wizard's prefill (blast-radius semantic break)

**What the code now does.** `GET /api/signup/place-prefill` gained
`if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) → 403`
(`route.ts:140-145`). Test `place-prefill rejects an owner whose account is not in a
pre-activation state` pins `active → 403` (`place-prefill.test.ts:112`).

**The caller nobody checked.** `rg 'place-prefill'` finds exactly two live callers:

- `src/app/onboarding/start/StartLocationClient.tsx:149` — pre-payment (`pending_payment`). ✅
- `src/app/onboarding/business/StepLocation.tsx:79` — **post-payment.** `/onboarding/business`
  requires `subscriptionGrantsFullAccess(status)` (`guard.ts:66`), so this caller is
  `active` or `trialing` by construction → **403 on every call**.

`StepLocation.triggerPrefill` swallows a non-ok response (`if (!res.ok) return;` at
`StepLocation.tsx:84`) and its `finally` clears the spinner, so the failure is *silent*:
the owner selects their business and the category/website fields simply never populate.

**When it bites.** `StepLocation` renders only in the non-demo wizard branch
(`BusinessWizardClient.tsx:234` → `:266`), which is selected by
`shouldUseDemoWizard(onboardingDemoEnabled(), row)`:

- `ONBOARDING_DEMO_ENABLED` off — the production posture today per
  `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md` ("`ONBOARDING_DEMO_ENABLED`
  is still empty (off) on preview/production") → **every** production owner's wizard is the
  non-demo one.
- Demo on, but the owner arrived without a location (card-up-front trial) → also the
  non-demo wizard.

The break is masked in prod *today* only because the pre-diff gate
(`SELF_SERVE_SIGNUP_ENABLED`) is also off in prod, so the route 404'd there already. It
becomes a real, permanent regression the moment that flag is turned on at launch — and it
is masked on staging only because staging runs the demo flag on.

**Contract angle.** `user_visible_behavior` names only "GET /api/signup/place-prefill
rejects anonymous callers". The plan/inventory row 10 says "pre-activation account state".
Neither anticipated a post-payment consumer. No test exercises the post-payment caller.

**Fix shape (not prescriptive).** Either widen the state set to the states in which the
wizard can legitimately run (`pending_payment` ∪ `subscriptionGrantsFullAccess`, still
role-filtered and double-rate-limited), or give the wizard its own owner-scoped prefill
boundary. Whichever is chosen, `StepLocation` should stop soft-swallowing a 403 that means
"this endpoint is not for you".

---

## F2 — a bad coupon wedges the attempt permanently, and the error message's own remedy cannot clear it

**Mechanism.**

1. `POST /api/onboarding/select-plan` → `applyTierSnapshot` commits a durable attempt with
   `checkout_attempt_state = 'creating'` and `checkout_attempt_coupon_id = <configured id>`
   (`plan-activation.ts:500-529`). This transaction **commits** before Stripe is called.
2. `createCheckoutSession` calls Stripe; a bad coupon id → `mapCouponRejection` →
   `CheckoutCouponConfigurationError` → 502 `checkout_coupon_misconfigured`. The Session was
   never created, so the attempt stays `creating` (and `checkout_session_id` stays NULL).
3. Retry: `prepareCheckoutAttempt` sees `checkout_attempt_id && state === 'creating' &&
   isSameAttemptSelection(...)` and returns `{ kind: 'reuse' }` with the **same attemptId**
   (`plan-activation.ts:255-269`). `createCheckoutSession` rebuilds params from the snapshot →
   the same bad coupon → the same 502. Forever.
4. Switching tier does not escape it either: `state === 'creating'` with a different selection
   throws `CheckoutAttemptConflictError('The previous Checkout attempt is still being created;
   retry that selection')` (`plan-activation.ts:271-275`).
5. Nothing clears a stale `creating` attempt. `rg checkout_attempt_state` over `src` + `worker`
   shows only `src/lib/payments/**` and `worker/ingress/stripe/checkout-completed.ts`, and the
   latter only transitions `open → completed|remediated`. There is no reaper, no TTL, no admin
   action.

**Why it is a defect introduced here, not just inherited.** The wedge shape is pre-existing
(a bad snapshotted price id behaves identically), but this branch adds an **ops-flippable**
input to the snapshot and then tells the operator, in the error text the branch introduces:

```
Verify BETA_COMP_COUPON_ID names a live, unexpired coupon in THIS Stripe mode,
or unset it to sell at full price.
```

Both suggested actions are no-ops for every owner who has already clicked, because the
coupon is frozen into their attempt — which is the branch's own documented idempotency
contract (`.claude/reference/env-vars.md` → "Unsetting it is the kill switch — for NEW
attempts only"; `CONTEXT.md:126` same). So the message hands an operator a remedy the
architecture guarantees will not help the affected customer, with no documented alternative.

**Concrete scenario.** A test-mode coupon id is deployed to live (the exact failure mode
`env-vars.md` warns about). Every invited beta tester who clicks a plan is 502'd. Ops fixes
or unsets the env var. Every one of those testers is *still* 502'd, permanently, until
someone manually NULLs 19 `checkout_attempt_*` columns per account.

**Fix shape.** Either treat a coupon-configuration rejection as a reason to release the
`creating` lease (clear the attempt columns in a compensating transaction so the next click
re-snapshots), or document the manual clear procedure and correct the error text. The
current text is actively misleading.

---

## F3 — `CheckoutCouponConfigurationError` is mapped at one of its two call sites

`src/lib/payments/create-checkout-session.ts` is consumed by two routes (its own header says
so, lines 3-5): `/api/onboarding/select-plan` and `/api/billing/checkout`.

D-16 fixed only the first. `src/app/api/billing/checkout/route.ts:207-236` maps
`TierNotPurchasableError`, `CheckoutUnavailableError`, `CheckoutOffboardingBlockedError`,
`CheckoutAttemptConflictError` — and then falls through to:

```ts
reportCaughtError('billing/checkout', err, { reason: 'stripe_error', accountId });
return NextResponse.json(
  { error: 'stripe_error', detail: 'Unable to connect to payment provider. Please try again later.' },
  { status: 502, headers: NO_STORE },
);
```

That is verbatim the response D-16 called "wrong in both halves: nothing was unreachable, and
retrying could never help", and the second `reportCaughtError` files the coupon fault in Sentry
under `reason: 'stripe_error'` rather than as a configuration problem.

**Reachability with a coupon.** The route accepts `pending_payment` accounts
(`route.ts:129-140` rejects only `active`/`trialing`/`past_due`), reads `onboarded_by` from the
primary business itself (`route.ts:100-105`), and calls the same `applyTierSnapshot` →
`createCheckoutSession` pair (`route.ts:164`, `:193`). An admin-invited pending_payment owner
therefore gets a coupon-carrying attempt on this route too. It is also the documented recovery
path for cancel-only reactivation (`src/lib/account-offboarding/reactivate.ts:604`).

**Contract angle.** `intake.observability[3]`: "Stripe invalid-coupon errors mapped to a named
error and reported to Sentry via `reportCaughtError` rather than a generic checkout failure."
Half-shipped. It is also a second instance of D-8's own promoted lesson ("a change to a shared
`src/lib/**` seam must be verified against **every** consumer directory") and of D-16's lesson 3
("a named error class is worthless until a route maps it") — both violated in the same file
those lessons were written about.

---

## F4 — the falsified `allow_promotion_codes` claim survives in four live docs

`rg allow_promotion_codes` over `CONTEXT.md`, `docs`, `.claude`:

| Location | Text | Status |
|---|---|---|
| `CONTEXT.md:126` (locked glossary, **Beta comp coupon**) | "It is a *server-selected coupon*, not a promotion code: `allow_promotion_codes` stays `false` and no owner ever types anything." | **stale** |
| `docs/launch-checklist.md:89` (inside the *"Mechanics note — superseded 2026-08-14 (`admin-invite-funnel`)"* rewrite) | "`allow_promotion_codes` stays `false` — no conflict, since a server-selected coupon is not a promotion code." | **stale** |
| `docs/launch-checklist.md:131` | "…for admin-onboarded accounts (`allow_promotion_codes` stays `false`)." | **stale** |
| `docs/runbooks/beta-production-standup.md:222` (the branch's own **F1 shipped 2026-08-14** entry) | "`allow_promotion_codes` stays `false` (a server-selected coupon is not a promotion code, so there is no Stripe mutual-exclusion conflict)." | **stale** |

The code does the opposite on the coupon path — `buildCheckoutSessionParams` **omits** the key
whenever `discounts` is present (`create-checkout-session.ts:196-201`), with a 12-line comment
explaining why, and a regression test (`never sends allow_promotion_codes together with
discounts`).

Three of the four locations were **written or rewritten by this branch**, i.e. after D-16 was
diagnosed and fixed. `CONTEXT.md` is the checked-in durable authority per CLAUDE.md
("Checked-in docs … are the durable, authoritative layer"), and the branch's own working rule
requires cleaning every cross-reference in the same change.

**Failure scenario.** Exactly D-16's, replayed. A future contributor reads the locked glossary
or the standup entry, sees a claim that the parameter "stays `false`", "restores" it beside
`discounts` (or adds it to a second checkout path), and every invited tester's checkout 500s
again. The claim also still carries the false justification ("so there is no Stripe
mutual-exclusion conflict") that D-16's lesson 2 warned about.

There is a fifth, harmless-but-adjacent instance in code: the doc comment at
`create-checkout-session.ts:377` says "`allow_promotion_codes` is false" while reasoning about
coupon-id safety; on the coupon path it is *absent*. Functionally equivalent, textually stale.

---

## F5 — one `tests_to_add` title does not match its assertion

`tests_to_add` contains `onboarding pay page 404s for a non-owner user`. The test at
`src/app/onboarding/pay/__tests__/page.test.tsx:58` asserts
`expect(mockRedirect).toHaveBeenCalledWith('/signup')` — a redirect, never a 404.

D-6 item 2 records this deliberately and says "the title is imprecise and a reviewer should
decide whether to keep it". My call: the *behaviour* is right (a non-owner gets the missing-row
treatment, which is what T4 asked for), but the title asserts a mechanism the test does not
exercise, and the "and /signup itself 404s" reasoning is contingent on a flag value the test
does not set. Retitle to what it proves (e.g. "onboarding pay page refuses a non-owner user")
or add the second hop.

All other 50 `tests_to_add` entries exist verbatim and assert their claim non-vacuously
(spot-verified: coupon snapshot tests read the actual bound value of
`checkout_attempt_coupon_id` off the recorded `UPDATE`; migration-105 tests assert
`pg_get_constraintdef` **and** behaviourally probe both CHECK branches; the admin-onboarding
"rejects contraband" test asserts at the persistence boundary per D-9; `place-prefill`,
`resend-invite`, `funnelUrl` and flag-scope suites all assert real outputs).

---

## Verified clean (no finding)

Everything below was checked field-by-field against the code, not from memory.

### `allowed_edit_surface`
`pnpm ci:feature-surface` → **passed (116 changed files within the declared surface)**. The three
surface amendments (D-1, D-8, D-11) are present in both intake copies and the two copies are
byte-identical on every key.

### `invariants` (9)
- **#3 no unapproved posting** — no publishing path touched. ✔
- **#9 accounts = billing parent** — coupon eligibility is a scalar subquery over
  `pb.is_primary = TRUE AND pb.archived_at IS NULL` (`plan-activation.ts:394-399`), deliberately
  *not* a predicate on the `active_locations` join; the multi-location test proves the overage
  count survives (`plan-activation.test.ts:626` asserts 2 overage seats at 3 locations). No
  subscription column added to `businesses`. ✔
- **#11 Stripe is the source of truth** — no new `subscription_status` writer;
  `resolveFunnelEntry` gates on `subscriptionGrantsFullAccess`, never `=== 'active'`. ✔
- **#13 server-authoritative flags** — `pnpm ci:static-policy` passed; no new `NEXT_PUBLIC_*`;
  `funnelUrl` is the only thing crossing the wire. ✔
- **#15 explicit DB client** — `funnel-entry.ts` imports no DB at all; `resend-invite.ts` takes
  `sql` + `supabase`; `pnpm ci:db-imports` passed strict. ✔
- **Checkout-attempt immutability** — `buildCheckoutSessionParams` reads only the snapshot row;
  the "emits discounts from the attempt snapshot" test stubs `BETA_COMP_COUPON_ID=''` to prove
  no live read leaks in, and its mirror stubs the env *set* against a NULL snapshot. ✔
- **CHECK null-at-rest exhaustiveness** — migration 105 reproduces 077's active branch verbatim
  and adds exactly one `AND checkout_attempt_coupon_id IS NULL` to the null branch; the shape
  suite asserts exactly one mention and one `IS NULL`, then probes both branches behaviourally. ✔
- **Tenant isolation** — `pnpm ci:tenant-scope` passed at baseline 400 (398→399→400, both growths
  justified in-file); no allowlist entry was loosened, two were *tightened*
  (`/onboarding/pay` gained `AND u.role = 'owner'`). ✔
- **Every de-flagged route enforces session + role + state** — 14 removed sites match the
  inventory exactly (`git grep selfServeSignupEnabled 2b3c872a` diffed against the inventory:
  identical set). See appendix A2 for the literal-vs-intent gap on the three public auth pages.

### `edge_cases` (18)
All 18 traced. Notable confirmations:
- *Env unset at creation → NULL persisted; later flip must not change params* — the snapshot is
  the only input; `snapshottedCouponId()` reads the real bound value. ✔
- *Multi-location primary-business read* — ✔ (above).
- *Card still collected at $0* — `payment_method_collection: 'always'` emitted only alongside a
  coupon, so a full-price attempt's params stay byte-identical to pre-branch; staging evidence
  records `default_payment_method: pm_…` on the real session. ✔
- *`/onboarding/payment-success` + `GET /api/auth/signup-status` reachable across the transition*
  — both drop every state gate and keep session + `role='owner'`. ✔
- *`/onboarding/pay` gains `u.role = 'owner'`* — ✔ and allowlist-refreshed.
- *reset-password signs out and keeps `redirectTo: '/login'`* — `route.ts:189` unchanged, step 9
  teardown intact. ✔
- *Resend eligibility uses provider `last_sign_in_at`* — ✔, and a `getUserById` failure maps to
  `PROVIDER_UNAVAILABLE` (502) rather than "never signed in", with a dedicated test.
- *Unknown provider error → 502, raw code logged, never retried* — ✔ (`mapInviteProviderError`
  fallback + `expect(mockInviteUserByEmail).toHaveBeenCalledTimes(1)`).
- *Existing stuck admin pending_payment accounts self-heal* — traced end to end: demo on + place
  → `/onboarding/demo`, whose `!demo && place` branch renders the paywall with the `skipped`
  sentinel (`demo/page.tsx:87-104`) rather than ping-ponging to `/onboarding/start`; demo off →
  `/onboarding/pay`. No redirect loop exists on any funnel edge I could construct. ✔
- *`display_name` re-sync during `pending_payment`* — widened at `/api/onboarding/start`
  (reachable) and identically at `/api/onboarding/business` (unreachable branch, D-6 item 1,
  deliberate). ✔

### Blast radius
Checked the listed importers of every changed file plus the two things import-text search cannot
see: `fetch()` URL consumers (which is how F1 was found) and response-shape consumers.
- `paymentUrl` → `funnelUrl` rename: no live emitter or reader of the dashboard/settings
  `paymentUrl` remains (`rg paymentUrl` leaves only `POST /api/onboarding/select-plan`'s
  Stripe-URL field — a different meaning, read by `PlanPickerClient.tsx:101` — plus
  `CreateBusinessResult.paymentUrl`, the known-dead field D-12 deliberately kept).
- `pending_payment_admin_handoff` → no live producer or consumer; the two surviving mentions in
  `scripts/ci/static-policy-audit.ts` are regex-sample comments (D-10).
- `applySubscriptionGuard` behaviour change → single caller `useLoginSubmit.ts:128`, whose
  soft-fail posture matches the documented absence rule.
- `settingsRedirectForDashboardData` → `useSettingsForm` only.
- `AdminOnboardingResult` / `OnboardBusinessSchema` / `PlaceIdInput` shrinkage → `pnpm typecheck`
  clean; no runtime consumer outside the admin route.
- `CleanupAbandonedSignupsPoller` — inventory claim verified: candidate query requires
  `a.id IS NULL` (`CleanupAbandonedSignupsPoller.ts:109`) and `runAdminTx` always inserts the
  `accounts` row, so an invitee can never be a candidate.
- `runAdminTx`'s businesses INSERT — 21 columns, 21 values, byte-identical column order to
  `runSelfServeTx`. ✔

### Gate re-run in the worktree
`pnpm lint` clean · `pnpm typecheck` clean · targeted `vitest run` over every changed area
(**174 files / 1697 tests passed**, 2 files / 8 tests skipped = live-DB) · every `ci:*` audit
except `ci:fallow*` passed: `tenant-scope` (400/400), `rls-audit`, `analytics-events`,
`static-policy` (25 carve-outs), `response-status`, `admin-aal2`, `config-coverage`,
`process-env`, `reviews-status`, `outbox-topics`, `outbox-status`, `db-imports` (strict),
`feature-surface`, `agent-config`, `live-db-suites`, `outbox-seam`, `dropped-columns`.

### Deviation claim-vs-code spot checks
Every deviation's *claim* was checked against the code rather than accepted. All hold except:
- D-13's containment claim is imprecise — see appendix A1.
- D-16's fix is complete in `create-checkout-session.ts` and `select-plan`, incomplete in
  `/api/billing/checkout` (F3) and in the docs it left behind (F4).

---

## Appendix — low-confidence observations (deliberately NOT in the table)

**A1 — D-13's containment sentence does not match `INVITE_ERROR_CODE_MAP`.**
D-13 says: "if it instead errors, the eligible path lands in the **502 bucket** and the button
is simply useless — loud, not silently wrong." But if Supabase returns `email_exists` /
`user_already_exists` for a *still-unaccepted* invitee, the map returns **409** with
"the owner has likely already accepted the invite. Ask them to sign in or use password reset."
— an authoritative-sounding, factually wrong instruction, not a loud 502. I read GoTrue's invite
handler as only raising `email_exists` when `user.IsConfirmed()`, so the assumption is probably
correct and this probably never fires — hence appendix, not table. Worth a sentence in the
staging verification checklist: *if step 1 returns 409, the 409 copy is the bug, not the gate.*

**A2 — invariant wording vs the always-on auth pages.** `intake.invariants[8]` reads "Every route
that loses its `SELF_SERVE_SIGNUP_ENABLED` gate enforces authenticated session + `role='owner'`
+ the route's own allowed subscription-state set." Rows 1-4 of the inventory
(`/login`, `/forgot-password`, `/reset-password` pages and `POST /api/auth/forgot-password`)
enforce none of that, and cannot — they are pre-authentication surfaces. The flag inventory says
so explicitly ("none needed — standard always-on auth page"). This is an over-broad invariant
sentence, not a defect; worth narrowing the wording if the intake is ever amended.

**A3 — `funnelUrl` and `businessOnboarded` disagree when `ONBOARDING_DEMO_ENABLED` is off.**
`GET /api/auth/signup-status` computes `businessOnboarded` demo-awarely
(`route.ts:196-199`: non-demo ⇒ "has a place"), while `resolveFunnelEntry`'s post-payment row
keys purely on `onboarding_wizard_completed_at`. For a legacy post-payment account with a place
but no wizard stamp (pre-migration-064 activation, or a manually repaired row), the old
`applySubscriptionGuard` returned no override; the new one returns `/onboarding/business`, which
`resolveWizardDestination` then bounces to `/dashboard`. Net destination is the same but a
legitimate `?from=/settings/voice` gets clobbered. I could not construct a *current* account in
that state, so: appendix.

**A4 — trial vs coupon read `onboarded_by` from different rows.** `resolveCheckoutContext`
(`plan-activation.ts:651`) reads it from the *caller's* business; the coupon reads it from the
*primary*. On a hypothetical multi-location `pending_payment` account whose primary is invited
and whose caller-business is self-serve, a Session could carry both `discounts` and
`subscription_data.trial_period_days: 30`. Stripe accepts that combination, and locations are
only addable post-activation, so this is theoretical. Pre-existing locus, not introduced here.

**A5 — `paymentUrl` still lives, with a different meaning.** `CONTEXT.md`'s **Funnel entry** entry
says "`paymentUrl` is deleted, not renamed" and lists it under *_Avoid_*. `POST
/api/onboarding/select-plan` still responds `{ paymentUrl: <stripe checkout url> }`
(`select-plan/route.ts:331`), read by `PlanPickerClient.tsx:101`. Genuinely a different thing (a
Stripe URL, not a funnel step), but the glossary now forbids the word, so the surviving field
reads as a violation to anyone applying the term literally.

**A6 — `asLocationId` does not validate.** `resend-invite/route.ts:83` passes an unvalidated path
segment into `${businessId}::uuid`, so a non-UUID id yields Postgres `22P02` → generic 500 +
Sentry noise instead of 404. Consistent with the sibling `/api/admin/businesses/[id]` route, so
not a regression; admin+AAL2 gated, so not a security issue.

**A7 — `resend-invite.ts` logs via `console.error`/`console.info`** rather than
`createWorkerLogger`. Style axis, not mine; noted only because CLAUDE.md names the structured
logger as the convention.

**A8 — intake `tests_to_add` has 51 entries, not 52.** Both intake copies agree at 51; the
review brief said 52. No entry is missing relative to the contract on disk.

_(A8 is correct — my brief miscounted. The contract now holds 52 after this round
added `place-prefill serves a post-payment owner filling in the wizard`.)_

---

## Triage verdicts — round 1, 2026-08-14

Every major was verified against the code before triage; all four held.

- **[major] `place-prefill:140` 403s the post-payment wizard caller** —
  **ACCEPTED, FIXED.** The strongest finding of the round, and blast-radius is
  what surfaced it. Verified at the fork point: `StepLocation.tsx` **already**
  called this route and the route had **no** subscription-status guard, so the
  branch introduced the regression. Because the caller soft-swallows `!res.ok`,
  it failed silently — in the production wizard shape (`ONBOARDING_DEMO_ENABLED`
  off) and for every card-up-front trial. The guard now admits `pending_payment`
  **plus** full access, and `cancelled` remains rejected. Three tests added,
  including `trialing` (a raw `=== 'active'` check would have missed it). This
  also corrected the locked contract itself: the promised title
  "…is not in a pre-activation state" *specified* the too-narrow guard, so it was
  retitled in both intake copies (D-17, same rule as D-2).
- **[major] `create-checkout-session.ts:384` — a coupon fault is unrecoverable** —
  **ACCEPTED, FIXED.** Verified: `prepareCheckoutAttempt` reuses a `creating`
  attempt for the same selection, and no expiry column or reaper exists
  anywhere. So the owner 502s forever and the intake's own documented kill switch
  ("leave `BETA_COMP_COUPON_ID` unset") cannot reach them, because their next
  attempt is not a new attempt. Added `releaseCouponFaultedAttempt`, wired into
  both coupon-fault handlers, scoped to `state = 'creating'` AND the failed
  attempt id, NULLing all nineteen columns so 105's cleared branch is satisfied.
- **[major] `billing/checkout:207` never maps `CheckoutCouponConfigurationError`** —
  **ACCEPTED, FIXED.** Confirmed only `select-plan` mapped it. This is literally
  D-16's own recorded second finding, still open on the other consumer, and only
  half of `intake.observability[3]`. Now mapped to `checkout_coupon_misconfigured`
  (502) with its own Sentry reason, plus a regression test.
- **[major] four live docs still assert "`allow_promotion_codes` stays `false`"** —
  **ACCEPTED, FIXED.** The highest-leverage finding for the *next* engineer: three
  of the four were written by this branch *after* the fix, so the locked glossary
  itself instructed a reader to restore the parameter that 500'd staging. All four
  now state that the key is **omitted** on the coupon path and that Stripe rejects
  by presence, not value.
- **[minor] pay-page test title asserts a 404 it never checks** — **ACCEPTED,
  FIXED.** Retitled to what it actually pins (a `/signup` redirect); the 404
  belongs to `/signup` one hop downstream. Both intake copies updated in lockstep
  and `intakeSha256` re-synced. D-6 item 2 had explicitly deferred this to a
  reviewer.

**Net:** all five findings accepted; four fixed in code, and the fifth
(`place-prefill`) additionally required correcting the locked contract that had
specified the defect.
