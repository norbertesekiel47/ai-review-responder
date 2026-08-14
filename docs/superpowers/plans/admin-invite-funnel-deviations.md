# Deviations — `admin-invite-funnel`

Entries the plan did not anticipate. Each gets a triage verdict (ACCEPT / RE-PLAN) at step 6 before review.

---

## D-1 — 2026-08-14 — Surface amendment #1 (auto-applied, orchestrator)

**What.** `allowed_edit_surface` widened in both intake copies:
- `supabase/migrations/105_checkout_attempt_coupon.sql` → `supabase/migrations/**`
- added `src/lib/config/**`

**Why.** Two facts the plan did not know:

1. **A second migration is mechanically required.** The plan's step 11 asks for a durable PostHog event on the coupon decision. New `analytics_events.event_name` values are gated by a DB CHECK (`analytics_events_event_name_check`), which migrations 058 / 069 / 089 / 094 / 097 / 102 each REPLACE with a widened list — registering a name only in `ANALYTICS_EVENT_NAMES` raises `23514` at insert (102's header documents this exact lesson). So the coupon-decision event needs its own constraint-widening migration (**106**), following 102's shape.

2. **`BETA_COMP_COUPON_ID` cannot be a raw `process.env` read.** `ci:process-env` fails any NEW env reader outside `src/lib/config/` + a frozen allowlist. The var must be declared in `src/lib/config/server.ts` and read via `getServerConfig()` inside a function. Precedent: `SOLICITATION_UNSUBSCRIBE_MAILTO` (collapsing `optionalVar`, so a blank value correctly reads as unset — exactly the semantics the coupon kill switch needs).

**Amendment budget.** This is amendment **1 of 2** (step-5 abort criteria). Both items are inside directory trees the surface morally already covered (`supabase/migrations/`, `src/lib/`) and neither adds new behavior — they are the mechanical cost of two existing CI audits.

**Triage verdict:** _(pending step 6)_

---

## D-2 — 2026-08-14 — `tests_to_add` retitle (not an amendment)

`checkoutAttemptMatchesRequest rejects an attempt whose coupon snapshot changed`
→ `checkoutAttemptMatchesRequest rejects a blank coupon snapshot`

**Why.** The original title describes a comparison that cannot exist: `checkoutAttemptMatchesRequest(attempt, tier, variant, attemptId)` has no request-side coupon to compare against — the coupon is a pure snapshot with no caller input, which is the whole point of plan step 2. What the validator *can* enforce, in the same spirit as its sibling `Boolean(attempt.checkout_attempt_base_price_id?.trim())` checks, is that the snapshot is well-formed: either an explicit `NULL` (the no-coupon decision) or a non-blank string. A blank/whitespace coupon id would otherwise reach Stripe and fail session creation.

Per step-5 abort criteria, a `tests_to_add` retitle is a deviations-file entry, **not** a surface amendment — the amendment budget is untouched.

**Triage verdict:** _(pending step 6)_

---

## D-3 — 2026-08-14 — T3: the coupon decision log is SPLIT across two sites (not an amendment)

Plan step 11 / the T3 brief asks for "a structured log on every **checkout-session
creation** recording the coupon decision and its reason (`applied` /
`skipped:not_invited` / `skipped:env_unset`)". Shipped as **two** log lines
instead of one, because the reason does not exist at session-creation time:

1. **`[checkout-attempt] Beta comp coupon decision`** — emitted in
   `applyTierSnapshot` where the decision is TAKEN, carrying `decision`,
   `reason`, and `coupon_applied` in the exact requested vocabulary. This is the
   only place the reason is knowable: eligibility (`primary_onboarded_by`) and
   the env var are both read there, and only the resulting coupon **id** is
   snapshotted — migration 105 persists no reason column.
2. **`[checkout-session] Creating Checkout Session`** — emitted in
   `createCheckoutSession` on every Stripe session creation (including retries
   that reuse an older attempt), carrying `coupon_applied` and the resolved
   `payment_method_collection` read from the SNAPSHOT.

The alternative — re-deriving the reason at session-creation time from a live
`BETA_COMP_COUPON_ID` read — was rejected: the env may have flipped since the
attempt was frozen, so the line could report a reason the attempt was never
given, which is worse than omitting it. Together the two lines answer the
question step 11 exists to answer ("was the comp silently skipped, and why")
without inventing a fact.

No surface amendment: both files are already in T3's `allowed_edit_surface`.

**Triage verdict:** _(pending step 6)_

---

## D-4 — 2026-08-14 — T3: one-line edit to `src/lib/analytics/__tests__/events.test.ts`

**What.** Added `'checkout_coupon_decision'` to the exact-list assertion in
`src/lib/analytics/__tests__/events.test.ts` — a file outside T3's
`allowed_edit_surface` (which names `src/lib/analytics/events.ts` only).

**Why.** That test is a LOCK on `ANALYTICS_EVENT_NAMES`: it asserts the array
deep-equals a hardcoded literal. Registering the event name — which T3 is
mandated to do — necessarily fails it. The lock exists precisely to force this
acknowledgement in the same change, so the edit is the lock working, not a scope
creep: no behavior changes, only the mirrored list plus a provenance comment
matching the `#679 T1` comment already above it. Leaving it red would have
handed the next ticket a failing suite.

**Amendment budget.** ~~Recorded as amendment **2 of 2**~~ — **orchestrator correction: this is NOT an amendment.** The T3 agent compared the edit against its *ticket* file list, but the budget counts changes to the intake's `allowed_edit_surface`, which already contains `src/lib/analytics/**`. No intake file was changed, the edit-surface guard allowed it, and the amendment budget is untouched.

**Triage verdict:** _(pending step 6)_

---

## D-5 — 2026-08-14 — T4: three files the ticket's file list did not name (not an amendment)

All three are already inside the intake's `allowed_edit_surface`; each is a
mechanical consequence of a change T4 explicitly asks for.

1. **`src/app/onboarding/start/StartLocationClient.tsx`** — T4 requires
   `/onboarding/start`'s page to prefill the business-name input from
   `businesses.name` "as a server-rendered prop". A prop has to be accepted
   somewhere: the client component gained one optional `initialBusinessName`
   prop (default `''`) seeding the reducer. No other ticket touches this file.
2. **`scripts/ci/static-policy-audit.ts`** — the widened `display_name` sync
   predicates put a bare `'pending_payment'` literal inside two postgres.js
   templates. The `-- enum: SubscriptionStatus.PENDING_PAYMENT` comment T4
   prescribes is only the documentation half of the convention; the audit ALSO
   requires an explicit `file:line` entry in
   `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` (its own failure message says so).
   Two entries added.
3. **`scripts/ci/tenant-scope-allowlist.ts`** — the allowlist keys on exact
   normalized SQL text, so the `/onboarding/pay` query (gained
   `AND u.role = 'owner'`) and the `/onboarding/start` query (gained `b.name`)
   invalidated four existing entries, and `place-prefill`'s new owner/state
   lookup needs one. Four snippets refreshed, one entry added,
   `ALLOWLIST_BASELINE` 398 → 399.

**Test-title placement.** `signup page 404s when SELF_SERVE_SIGNUP_ENABLED is
off` has no home under T4's own `__tests__` dirs — `src/app/(public)/signup/**`
and `src/app/(public)/__tests__/**` are both outside the allowed surface (the
edit-surface guard blocks them). The four page-scope titles are cohesive anyway:
they assert the *relationship* between gated and un-gated surfaces, not a
property of any one page. They live together in
`src/__tests__/self-serve-signup-flag-scope.test.tsx` (`src/__tests__/**` IS
allowed).

**Triage verdict:** _(pending step 6)_

---

## D-6 — 2026-08-14 — T4: two spots where the ticket's letter and its intent diverge

Both implemented as the ticket's *behavioural* instruction says, with the
verbatim test title kept. Flagged rather than silently reconciled.

1. **`onboarding business syncs accounts.display_name while pending_payment`
   asserts a predicate that cannot fire at runtime.** T4 says to widen *both*
   display_name predicates to
   `(subscription_status = 'pending_payment' OR display_name = PLACEHOLDER)`.
   But `/api/onboarding/business` already refuses anything that is not
   `subscriptionGrantsFullAccess(status)` (its step 4, unchanged), so its
   `pending_payment` branch is unreachable — only `/api/onboarding/start` can
   actually take it. Widened anyway, deliberately: the two sites now spell one
   rule identically, and divergent spellings of one rule are how the rule rots.
   The test asserts the emitted predicate text; a code comment marks the branch
   defensive.
2. **`onboarding pay page 404s for a non-owner user` asserts a redirect, not a
   404.** T4's behavioural instruction is "make a non-owner session get the same
   treatment a missing row gets", and the missing-row treatment on that page is
   `redirect('/signup')` (inventory row 12 likewise says "existing redirects").
   The page is therefore never served to a non-owner — and `/signup` itself 404s
   while `SELF_SERVE_SIGNUP_ENABLED` is off, which is the beta posture this
   ticket targets, making "404s" true of the journey but not of the mechanism.
   Behaviour follows the instruction; the title is kept verbatim and the test
   body documents the gap.

**Triage verdict:** _(pending step 6)_

---

## D-7 — 2026-08-14 — T4: `/onboarding/start` page also closes a `past_due` fall-through (in scope)

T4 says each de-flagged surface must enforce "the route's own allowed-state
set", which for `/onboarding/start` is exactly `pending_payment`. The page's
guard was a chain of negative checks (full-access → `/dashboard`, `cancelled` →
`/dashboard`), so `past_due` fell through all of them and rendered a form whose
POST answers 409 (`/api/onboarding/start` has always required
`pending_payment`). Replaced the two negative checks with one positive
`!== PENDING_PAYMENT → /dashboard`. Same destination for every status that was
already handled; only `past_due` changes, and it changes to match the API it
submits to.

**Triage verdict:** _(pending step 6)_

---

## D-8 — 2026-08-14 — Surface amendment #2 (orchestrator) + a real T3 regression it fixes

**The regression.** T3 verified with `pnpm vitest run src/lib/payments` and reported green, but `createCheckoutSession`'s other consumer lives under `src/app/api/billing/`. Running it found **5 real failures**: `POST /api/billing/checkout` answered `409` instead of `200` for every attempt.

**Root cause.** T3's new `isWellFormedCouponSnapshot` check in `checkoutAttemptMatchesRequest` accepts exactly `null` or a non-blank string. The fixture in `src/app/api/billing/__tests__/checkout-params.test.ts` builds an attempt row without `checkout_attempt_coupon_id` at all, so the value was `undefined` — neither branch — and every attempt was treated as superseded.

**Resolution: the fixture was wrong, not the check.** `createCheckoutSession` always names the column in its `SELECT`, so postgres.js returns `null` for a NULL column and never `undefined`. Loosening the production check to accept `undefined` would be branching around a state the driver cannot produce (CLAUDE.md: assert impossible states, don't branch around them). Added `checkout_attempt_coupon_id: null` to the fixture with a comment; suite back to **73/73**.

**Amendment.** `src/app/api/billing/**` added to `allowed_edit_surface` in both intake copies. This is amendment **2 of 2** — the step-5 budget is now **at its cap**. A third widening trips the abort criteria and requires a post-mortem + re-plan rather than another patch.

**Lesson for the remaining tickets** (promote at step 8): a change to a shared `src/lib/**` seam must be verified against **every** consumer directory, not just the seam's own suite. `rg -l "createCheckoutSession"` would have found this in one command.

**Triage verdict:** _(pending step 6)_
