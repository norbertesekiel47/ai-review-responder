# Spec & Correctness Review — fix-p8-tier-change-stripe-timeouts

Reviewer: Spec & Correctness (review-only)
Diff base: `main...HEAD` (merge-base `880435ba`)
Verdict: **PASS — no findings at >=80% confidence.**

## Scope reviewed

Production: `src/lib/accounts/tier-change.ts`
Tests: `src/lib/accounts/__tests__/tier-change.test.ts`, `src/lib/accounts/__tests__/tier-change-stripe-timeout.test.ts`
Contract: `.feature/intake.json`; plan `docs/superpowers/plans/fix-p8-tier-change-stripe-timeouts-plan.md`.

`npx vitest run` on both test files: **47 passed**.

## Invariants — field by field

1. **All 3 under-lock Stripe calls carry `timeout=8000` & `maxNetworkRetries=0`** — UPHELD.
   - `subscriptions.retrieve` (tier-change.ts:631-635): passes `STRIPE_UNDER_LOCK_REQUEST_OPTIONS` as the 3rd (options) arg, with `{}` params in the middle slot. Correct 3-arg overload.
   - base `subscriptionItems.update` (line 401-412): options via `stripeOptions('base')`, which spreads `STRIPE_UNDER_LOCK_REQUEST_OPTIONS`.
   - overage update/create/del (lines 416/426/436): all via `stripeOptions(...)`. `del` uses correct `(id, {}, options)` 3-arg form.

2. **Per-step idempotency keys unchanged** — UPHELD. `stripeOptions` (line 384-389) still emits `tier-change:${accountId}:${operationKey}:${step}`. Spread order is `...STRIPE_UNDER_LOCK_REQUEST_OPTIONS` **then** `idempotencyKey` — the bound constant contains only `timeout`/`maxNetworkRetries`, so it cannot clobber `idempotencyKey`. Verified live by tests at tier-change-stripe-timeout.test.ts:252-257, 274, 297.

3. **Single authoritative owner of the bound** — UPHELD. Sole definition is `STRIPE_UNDER_LOCK_REQUEST_OPTIONS` (line 382). `rg "8000|8_000|maxNetworkRetries|timeout"` over the prod file finds the literal only on that line (other hits are comment prose). No repeated literals per call site.

4. **Failure rolls back the tx** — UPHELD. No structural change: Stripe calls remain inside `sql.begin((tx) => applyTierChangeInTx(...))` (line 739). A throw/timeout still aborts the transaction before `writeResolvedTierSnapshot`/`ensureTierChangeAudit`. `applyTierChange`'s catch maps to `tier_change_failed`. No partial commit path introduced.

5. **`getStripe()` sole client** — UPHELD. Both `mutateStripe` (line 400) and `buildTierChangeProviderPlan` (line 631) call `getStripe()`. No `new Stripe()`; no second/bounded client on the factory (matches non-goal).

## allowed_edit_surface

Diff touches only: `src/lib/accounts/tier-change.ts`, the two allowed `__tests__` files, plus `.feature/*` and `docs/*` (exempt scratch surfaces). **No out-of-surface production file touched.** `src/app/api/billing/tier-change/route.ts` and `STRIPE_CLIENT_CONFIG` are untouched (matches non-goals).

## user_visible_behavior

No new behavior. Success path unchanged — same billing outcome, snapshot, and audit; the property test asserts `result.ok === true` across arbitrary shapes. Only change is failure timing (bounded), as specified.

## tests_to_add

All promised tests present and meaningful:
- 4 overage-kind example tests (update/create/delete/none) asserting base + overage carry the bound — lines 139/159/177/201.
- `subscriptions.retrieve` bounded + no idempotencyKey — line 219.
- 3 idempotency-key-preservation tests (base+create, overage-update, overage-delete) — lines 240/260/279.
- fast-check property test — lines 303-355.

**Property test is genuine, not hollow.** It drives the real `applyTierChange` (line 324) over `fc.integer(0..50)` active-location counts × `fc.boolean()` overage-item presence, asserts `result.ok === true`, then harvests the last arg of every recorded call across all four Stripe mocks and asserts `timeout===8000 && maxNetworkRetries===0`, with `optionArgs.length >= 2` guarding against a vacuous pass. numRuns 25. It exercises production code and would fail if any under-lock call dropped the bound.

## edge_cases

- overage kind `none` → no overage call: covered (line 201, asserts create/del not called).
- Idempotent-replay early return before any Stripe call: pre-existing `loadCommittedTierChange`/`committedOutcome` path (lines 680-687) is unchanged by this diff — not regressed. (Covered by existing `tier-change.test.ts` replay cases; the new timeout suite does not need to duplicate it.)
- retrieve bounded despite previously passing no options arg: covered (line 219).
- Timeout-after-Stripe-processed → tx rollback + caller/webhook recovery: pre-existing behavior, unchanged.

## Known-accepted item (not a finding)

stripe-node 22.2.0 permits one ECONNRESET/EPIPE retry despite `maxNetworkRetries:0`. Documented in the code comment (lines 375-381) and `docs/reviews/.../adversarial-review.md`. Neither code nor tests contradict it: tests assert only the `maxNetworkRetries: 0` value is passed, not a strict single-attempt guarantee.

## Low-confidence appendix (NOT findings — informational only)

- The new suite does not add a first-draft/replay early-return regression test in the timeout file; relying on the existing suite is reasonable and within contract, so not flagged.
- `subscriptions.retrieve` params `{}` is inert for a GET; harmless and matches the documented single-overload rationale.
