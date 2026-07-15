# WS8 — Copilot / Autopilot Tier Wiring Implementation Plan

> **For agentic workers:** execute task-by-task with subagent-driven development. Each task gets a focused implementation agent, a spec-compliance review, an adversarial review, and fix loops before its commit. Do not open a PR from this plan.

**Goal:** Replace the four legacy subscription tiers with the locked Copilot and Autopilot model, preserve immutable founding-for-life pricing through every billing writer, enforce Autopilot at the policy, grant, and publish seams, and ship the quiesced 077/code/078 Stripe cutover safely.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-14-ws8-tier-wiring-design.md`. The accepted WS4 spec §6 amendments own suspension/contraction semantics; the accepted WS6 spec §6 amendments own judge/governor, publisher-gate placement, and approval-lane lock order. On pricing, `docs/superpowers/inputs/2026-07-14-ws8-pricing-hardened-design.md` Rev 13 and the kickoff resolutions are locked and must not be re-decided.

**Architecture:** `accounts.price_variant` is immutable identity (`list | founding`). At write time, the tier registry resolves `(tier, variant)` into the Stripe Price and cents and every tier writer persists the complete account billing snapshot. At read time, `currentBillingSnapshot` and invoice reconciliation continue using stored cents only. `autopilotPurchasable()` gates sale and policy expansion; account tier gates auto-policy grant and is rechecked immediately before publish. Stripe remains the external source of subscription status, applied only through `applyStripeSubscriptionState`.

**Tech stack:** Next.js 16, Postgres.js, Stripe, Railway worker, Supabase/PostgreSQL migrations, Vitest, Playwright. All DB-domain helpers receive `sql`/`tx` explicitly. All Stripe mutations use the shared `getStripe()` client and stable idempotency keys.

**Branch:** `codex/ws8-tier-wiring-spec`. Never push directly to `main` and do not open a PR during execution.

## Locked commercial and rollout facts

| Tier | List base | Founding base | Extra location | Included |
|---|---:|---:|---:|---:|
| Copilot | $29/month | $19/month | $15/month | 1 |
| Autopilot | $69/month | $49/month | $20/month | 1 |

- Monthly only. There is no annual selector or annual Stripe interval in WS8.
- The founding window closes at exactly `2027-01-01T00:00:00Z`; the predicate is `now < deadline`.
- Founding pricing is an immutable account variant and spans tier changes.
- Trial remains card-up-front for 30 days when `TRIAL_ENABLED`; the owner explicitly selects a purchasable tier. No tier is preselected or inferred.
- `autopilotPurchasable() = AUTOPILOT_PURCHASABLE && autoApprovalRuntimeEnabled()`.
- Zero paying accounts means replacement, not mapping or grandfathering of legacy tiers.
- Deployment uses the quiesced path only: quiesce, provider-wide preflight to zero, 077, strict code, smoke, 078. There is no live-traffic compatibility path.
- Migration 077 normalizes through direct SQL constants, writes every snapshot field, and enqueues no jobs.

## Non-negotiable engineering rules for every task

- Read the named spec section and the relevant parent amendments before coding.
- Do not change the locked prices, deadline, monthly-only model, founding semantics, or migration sequence.
- `currentBillingSnapshot` reads stored `base_price_cents`, `locations_overage_price_cents`, and `locations_included`; never re-derive them on reads.
- Use `subscriptionGrantsFullAccess(status)` rather than raw `status === 'active'` checks.
- Checkout and tier-change routes are composition roots; domain modules take an explicit DB client.
- Status transitions from Stripe go through `worker/ingress/stripe/apply-subscription-state.ts` only.
- **Two account advisory protocols, fixed order:** `hashtext(accountId + ':tier_entitlement')` serializes every existing-account tier mutation with auto-policy grant/publish; `hashtext(accountId + ':overage_sync')` serializes tier-change, subscription-updated, activation, and overage quantity mutation. A tier-changing billing path acquires entitlement → billing → optional legacy activation lock → account row; overage-only acquires billing → account row. The grant path acquires reviews → businesses → entitlement **before the first account-FK response/child statement**; publisher acquires reviews → businesses → response → entitlement. Tier writers never acquire review locks. Resolve account ID without a row lock and never wait on either shared lock while holding the account row. Bounded lock-across-provider calls use shared client timeouts and require real concurrency tests.
- **Approval lock-order law:** `reviews → businesses → responses/child rows → agent_runs`; "first" means before **any** statement that takes an implicit FK lock. An INSERT/UPDATE of a child row can take `FOR KEY SHARE`; when the transaction later needs an exclusive parent/account lock, pre-lock it at the established point before the child write rather than performing a share→exclusive upgrade. Publisher downgrade code must call the existing review anchor before any implicit FK lock.
- Outbox state change and enqueue stay in one transaction. BullMQ IDs never contain `:`.
- SQL changed in a tenant-scoped path must keep `scripts/ci/tenant-scope-baseline.json` at **391**. Any brittle tenant/static/tripwire allowlist adjustment lands in the same commit as the code that requires it.
- Mock-SQL tests assert query and call counts. A test whose expected queue is already drained before the branch under test is vacuous and must be rejected.
- Billing math and tier gates always receive explicit positive, negative, replay, and boundary tests.
- Run task-scoped tests plus `pnpm lint` and `pnpm typecheck` before each commit. If a deliberately additive task retains temporary legacy exports for branch buildability, mark them `WS8_TRANSITION_ONLY`; Task 9 must prove none remain before the strict-code commit.

## Dependency order

```text
T1 migration 077
  └─ T2 pricing/flag foundations
       ├─ T3 account creation + checkout
       ├─ T4 tier change + billing serialization
       ├─ T5 webhook + overage + reconciliation
       ├─ T6 autonomy runtime entitlement
       └─ T7 policy editing/readiness
T3 + T4 + T5 → T8 pricing and billing UI
T3–T8 → T9 legacy-tier contraction/static guard
T1 + T9 → T10 migration 078
T1–T10 → T11 Stripe preflight/runbook/docs
T1–T11 → T12 branch verification
```

Tasks may be researched in parallel, but implementation commits follow this order because several tasks touch the same registry and test fixtures.

---

## Task 1: Migration 077 — price variant, defaults, complete direct-SQL normalization

**Spec:** migration 077 and quiesced normalization. **Files:** create `supabase/migrations/077_copilot_autopilot_expand.sql` and `src/lib/shared/__tests__/migration-077-copilot-autopilot.integration.test.ts`; modify `.claude/reference/migrations-log.md`.

- [ ] Read `.claude/reference/migrations-log.md`, migrations 054, 069, 074, 075, and 076. Confirm 076 is the current head before reserving 077.
- [ ] Add `accounts.price_variant TEXT NOT NULL DEFAULT 'list'` with an exact `CHECK (price_variant IN ('list','founding'))`.
- [ ] Add a narrowly scoped `BEFORE UPDATE OF price_variant` trigger. It raises when `NEW.price_variant IS DISTINCT FROM OLD.price_variant`, but permits updates to every other account column.
- [ ] Change every launch snapshot default to Copilot/list: `accounts.subscription_tier='copilot'`, `accounts.base_price_cents=2900`, `accounts.locations_overage_price_cents=1500`, `accounts.locations_included=1`, and the deprecated `businesses.subscription_tier='copilot'` mirror.
- [ ] Capture a `first_apply` sentinel from whether `accounts.price_variant` exists before expansion. Only when it is absent, normalize **every then-existing account row unconditionally** to `(copilot, list)` using direct SQL constants in one atomic UPDATE. The environment is quiesced and the hard Stripe preflight has proved there is no nonterminal subscription, so there is no valid pre-cutover Autopilot/founding row or Stripe overage quantity to preserve:
  - `subscription_tier = 'copilot'`
  - `price_variant = 'list'`
  - `base_price_cents = 2900`
  - `locations_overage_price_cents = 1500`
  - `locations_included = 1`
  - `locations_paid = 0`
- [ ] Normalize every existing `businesses.subscription_tier` mirror to `copilot` only on that same first apply. On reapply, repair idempotent schema/default/trigger objects but never rewrite account/business data.
- [ ] Do not call TypeScript, Stripe, Redis, or `job_outbox`; assert the migration creates zero outbox rows.
- [ ] Keep 077 transactional and re-runnable. Use named constraints/functions/triggers and existence checks matching current migration conventions.
- [ ] Add the 077 migration-log entry in this commit and advance the documented head/next values to 077/078.
- [ ] Migration tests start from the local DB at migration 076, seed at least:
  - A legacy Premium account with five included locations and three active locations; after 077 it has included `1`, paid `0`, base `2900`, overage `1500`.
  - Explicit Basic, Standard, Founders, and NULL account-tier rows; each lands on the same complete Copilot/list snapshot.
  - Active and archived locations proving 077 does not infer a live Stripe quantity from local location count.
  - A NULL/invalid mirror row.
  - A deliberately stray pre-cutover Copilot/founding-shaped row proving first-apply normalization is unconditional and lands on Copilot/list with the complete canonical launch snapshot.
  - An attempted `price_variant` mutation that fails while an unrelated account update succeeds.
  - A defaulted account/business insert proving all five account defaults plus the mirror default are correct.
  - After first apply, insert a valid founding Autopilot account/business snapshot; a second apply succeeds and preserves it byte-for-byte while leaving the originally normalized rows unchanged.
- [ ] Run the migration test against `postgresql://test:test@localhost:5499/test_ws4`, plus lint/typecheck. Commit as `feat(db): add ws8 tier expansion migration`.

## Task 2: Tier registry, immutable variant pricing, Price map, and gates

**Spec:** tier/variant registry, Price retention, founding deadline, Autopilot purchasability. **Files:** modify `src/lib/accounts/tier-config.ts`, `src/lib/payments/price-tier-map.ts`, `src/lib/config/stripe-shape.ts`, `src/lib/config/server.ts`, `.env.example`, `worker/config/startup-assert.ts`, `src/instrumentation.ts`; create `src/lib/payments/founding-window.ts`, `src/lib/payments/tier-purchasability.ts`, and focused tests.

- [ ] Add Copilot/Autopilot and `PriceVariant = list | founding` additively so this intermediate commit stays type-safe. Legacy enum/config/API members may remain only when labeled `WS8_TRANSITION_ONLY`; never create an old-tier-to-new-tier mapping. Task 9 contracts the final canonical `SubscriptionTier` union to exactly `copilot | autopilot` before strict code can deploy.
- [ ] Make the registry the only owner of launch amounts:
  - Copilot: `{ list: 2900, founding: 1900, included: 1, overageCents: 1500, multiLocAllowed: true }`.
  - Autopilot: `{ list: 6900, founding: 4900, included: 1, overageCents: 2000, multiLocAllowed: true }`.
- [ ] Add a pure, exhaustive `resolveTierSnapshot(tier, variant)` returning tier, variant, base cents, overage cents, and included count. It has no fallback and is the write-time source for runtime billing writers.
- [ ] Replace the Price map with explicit APIs such as `priceIdFor(tier, variant, kind)` and `basePriceInfoForId(id) -> { tier, variant } | null`. Overage has one Price per tier but callers still pass the account variant so no writer can accidentally omit variant context.
- [ ] Own exactly the six new variables in `STRIPE_PRICE_ENV_VARS`:
  `STRIPE_PRICE_COPILOT_LIST`, `STRIPE_PRICE_COPILOT_FOUNDING`, `STRIPE_PRICE_AUTOPILOT_LIST`, `STRIPE_PRICE_AUTOPILOT_FOUNDING`, `STRIPE_PRICE_COPILOT_OVERAGE`, `STRIPE_PRICE_AUTOPILOT_OVERAGE`.
- [ ] Reverse maps include all four new base Price IDs and both overage IDs. Do not rotate or remove founding Price mappings when the deadline closes.
- [ ] Update Stripe config narrowing, worker hard assertion, Next instrumentation soft assertion, and their coverage tests from the single owner list.
- [ ] Add strict server-only parsing for `FOUNDING_DEADLINE`. Accept the canonical UTC form and configure `2027-01-01T00:00:00Z`; unset, malformed, non-UTC, or impossible timestamps fail closed to list pricing and emit a scrubbed operational error/best-effort Sentry signal.
- [ ] `isFoundingWindowOpen(now)` is true strictly before the deadline and false at the exact boundary. Inject the clock in tests.
- [ ] Add `AUTOPILOT_PURCHASABLE` to server-only optional boolean config, default false. Configured values must be exact `true`/`false`; malformed values fail startup/config validation rather than becoming truthy. Implement the exact composed predicate and `assertTierPurchasable(tier)`; Copilot is always purchasable, Autopilot requires both flags.
- [ ] Test every `(tier, variant)` cents tuple, every Price lookup/reverse lookup, missing/duplicate env IDs, deadline before/equal/after/malformed/unset, and all four boolean combinations of the two Autopilot inputs.
- [ ] Preserve `currentBillingSnapshot` as stored-cents authority and add a regression test showing a changed registry value cannot change an existing stored snapshot.
- [ ] Add a live-DB cross-contract test after 077: a normalized row's tier/base/overage/included values equal `resolveTierSnapshot('copilot', 'list')`; `locations_paid=0` is asserted as the deliberate no-live-subscription migration exception. This mechanically prevents SQL constants and the registry from drifting.
- [ ] Run focused account/payment/config/startup tests plus lint/typecheck. Commit as `feat(billing): add copilot autopilot pricing registry`.

## Task 3: Account creation, plan activation, Checkout, and explicit trial selection

**Spec:** immutable variant stamping, complete runtime snapshots, all tier-writer gates, trial interplay. **Files:** modify `src/lib/onboarding/create-business.ts`, `src/lib/payments/plan-activation.ts`, `src/lib/payments/create-checkout-session.ts`, `worker/ingress/stripe/checkout-completed.ts`, `src/app/api/onboarding/select-plan/route.ts`, `src/app/api/billing/checkout/route.ts`, admin provisioning schemas/routes, and associated tests. Create small explicit-DB-client snapshot/lock helpers under `src/lib/accounts/` as needed.

- [ ] Stamp `price_variant` explicitly in each account INSERT. The account-creation decision alone uses the founding-window predicate; later plan selection and webhooks never recalculate it.
- [ ] Remove fallback cents from account creation. Unknown tiers, variants, or missing Price configuration are hard errors.
- [ ] Centralize runtime complete-snapshot application in a domain helper that takes `tx`, tier, stored variant, an explicit trusted `locationsPaid`, and audit context. It writes all five billing fields atomically. The caller owns quantity authority: pending account/select-plan uses `0`; Checkout completion uses the trusted Stripe line item; successful tier change uses the quantity it just wrote to Stripe; webhook uses the provider-current item.
- [ ] Create the explicit-DB-client advisory-lock helper under `src/lib/accounts/`: entitlement lock and billing lock keys have one owner and the fixed orders above. Existing-account plan selection/activation that writes tier/snapshot/quantity acquires `:tier_entitlement` → `:overage_sync` → its existing `:activation` lock → account row; brand-new account INSERT needs no advisory lock. This ordering applies only to billing/tier activation callers—unrelated onboarding flows that use an `:activation` key but write no billing state remain out of scope.
- [ ] Admin provisioning accepts only Copilot/Autopilot and calls `assertTierPurchasable` before account INSERT. A closed Autopilot gate performs no account/business/user writes.
- [ ] Self-serve account creation may begin at the safe Copilot pending-payment snapshot, but the pay screen must still require an explicit tier choice. Do not use Autopilot as a trial or UI default.
- [ ] `applyTierSnapshot` locks the account, reads its immutable variant, resolves the complete snapshot, and keeps the deprecated business mirror synchronized. It calls the tier gate before any mutation.
- [ ] Both Checkout creation entry points require a validated explicit tier in the request, load the stored variant, and call `assertTierPurchasable` immediately before creating a new Session. `/api/billing/checkout` may not infer the provisional stored Copilot tier: it persists the complete selected `(tier, stored variant)` pending snapshot with `locations_paid=0` under entitlement → billing → activation → account-row ordering before Session creation. The select-plan route follows the same rule, so a rejected/absent tier leaves the account unchanged and creates no Session.
- [ ] Checkout line items use the variant-aware base Price and tier overage Price. Set `allow_promotion_codes: false` and retain the existing Stripe tax/trial behavior.
- [ ] Checkout completion retrieves the provider-current subscription for paid and trial paths, verifies its base Price against the stored `(tier, variant)`, derives a trusted overage quantity, and—under entitlement → billing → activation → account-row order—routes status only through `applyStripeSubscriptionState` and the complete tier/quantity snapshot through the shared writer. A mismatch is status-only plus a scrubbed ops alert; no variant repair.
- [ ] `TRIAL_ENABLED` adds the existing 30-day card-up-front trial only to the explicitly submitted, currently purchasable tier. No absent-tier fallback, query-string default, or client-side default is allowed.
- [ ] Tests cover founding/list account INSERTs, exact deadline boundary, pending snapshots with `locations_paid=0`, trusted activation quantity, no partial write on gate rejection, stale/direct Checkout rejection, both tier line-item matrices, promotion-code disablement, trial on each available tier, Autopilot unavailable, and missing tier validation. The positive direct-Autopilot case must prove the complete stored Autopilot snapshot commits before its Autopilot Session is created. Add a deterministic activation-versus-webhook/overage ordering test that fails if `:activation` is acquired before entitlement/billing. Mutation-check removal of the explicit tier field: the direct route test must fail rather than create a Copilot Session.
- [ ] Any modified tenant query keeps the tenant-scope audit at 391; update exact allowlists in this commit if required.
- [ ] Run focused onboarding/checkout/plan-activation/admin tests plus lint/typecheck. Commit as `feat(billing): wire variant aware signup and checkout`.

## Task 4: Tier change — founder previews, proration, idempotency, and overage serialization

**Spec:** all three tier-change paths and billing concurrency. **Files:** modify `src/lib/accounts/tier-change.ts`, `src/app/api/billing/tier-change/route.ts`, Stripe overage mutation helpers if necessary, and tier-change tests/integration tests.

- [ ] `validateTierChange` reads the account's immutable variant and returns the exact variant price. Founding Copilot → Autopilot previews `$49`, and the reverse previews `$19`; no preview reads list cents for a founder.
- [ ] Both preview and execution use `subscriptionGrantsFullAccess`, including trialing and grace behavior, and call `assertTierPurchasable(targetTier)`.
- [ ] Remove `basic_requires_single_location`; both launch tiers allow multiple locations.
- [ ] Serialize tier change by acquiring `accountId + ':tier_entitlement'` then `accountId + ':overage_sync'`, before the account row/fresh state read. Inside the locks, re-read the account, subscription IDs, immutable variant, active non-archived location count, and current tier before planning Stripe mutations.
- [ ] Plan the base Price, overage Price, and quantity from one locked snapshot. Quantity is `max(activeLocations - 1, 0)`. The target complete DB snapshot stores the same quantity.
- [ ] Keep Stripe base-price replacement proration behavior explicit (`create_prorations`) and preserve stable per-step idempotency keys across retry. Do not use an idempotency key derived from wall-clock time or attempt number.
- [ ] The existing bounded Stripe timeout applies while the fixed entitlement/billing advisory locks are held. Do not invent a third account lock protocol; Task 5 moves the webhook and overage worker onto the two shared owners.
- [ ] Persist tier, base cents, overage cents, included `1`, and locations paid atomically only after successful Stripe mutation. Write the audit in the same DB transaction. On terminal Stripe failure, the DB snapshot remains unchanged; retry after a partial Stripe success converges through the same idempotency keys.
- [ ] Do not mutate `price_variant`. Founding Copilot ↔ founding Autopilot remains founding.
- [ ] Add tests for list/founding previews and executes, upgrade/downgrade proration arguments, zero/one/many locations, stable replay keys, partial-retry convergence, gate closure between preview and execute, trialing access, and Autopilot → Copilot mid-cycle.
- [ ] Add a concurrency test or deterministic lock-order harness proving a tier change cannot interleave its base/overage plan with a same-account overage sync. The test must fail if either path reads account/location state before its required advisory sequence.
- [ ] Run focused tier-change/overage tests plus lint/typecheck. Commit as `feat(billing): make tier changes variant safe and serialized`.

## Task 5: Stripe subscription webhook, overage worker, and reconciliation

**Spec:** reverse Price mapping, fail-closed variant mismatch, status applier preservation, stored billing reads. **Files:** modify `worker/ingress/stripe/subscription-updated.ts`, `worker/ingress/stripe/apply-subscription-state.ts` only if a result type is needed, `src/lib/payments/overage-item.ts`, `worker/jobs/billing/UpdateStripeOverageWorker.ts`, billing reconciliation helpers, webhook harnesses, and tests.

- [ ] Resolve the Stripe base Price to `{ tier, variant }`. An unknown base Price follows an explicit status-only path through `applyStripeSubscriptionState`, performs no tier/snapshot/mirror mutation, and emits a scrubbed operational alert; never guess a tier or retry a committed legitimate status transition.
- [ ] Resolve account ID without `FOR UPDATE`, acquire `accountId + ':tier_entitlement'` then `accountId + ':overage_sync'`, and only then retrieve/re-read current state. The overage-only worker acquires only `:overage_sync`. Never hold the account row while waiting on either advisory lock.
- [ ] While both advisory locks are held but before the local row lock, retrieve the current subscription through `getStripe().subscriptions.retrieve(subscriptionId)`. Use that provider-current object for status, base Price/variant, and overage quantity rather than trusting the possibly stale webhook snapshot; a transient retrieval failure retries without a partial status write.
- [ ] Lock and load the account's immutable `price_variant` before applying any tier snapshot mutation.
- [ ] On a Price/account variant mismatch, fail closed:
  - Apply the Stripe subscription **status only** through `applyStripeSubscriptionState`.
  - Do not mutate `subscription_tier`, `price_variant`, base cents, overage cents, included count, or `locations_paid`.
  - Commit the legitimate status transition rather than rolling it back into a retry loop.
  - Return a typed mismatch outcome and emit a scrubbed best-effort Sentry/structured error after commit with account ID, Price ID, mapped variant, and stored variant.
  - Replaying the event repeats no account snapshot or audit mutation.
- [ ] On a matching variant and tier change, apply the complete target snapshot from the canonical runtime resolver. On a same-tier replay, preserve stored cents/included values and synchronize only trusted Stripe quantity/status so webhook replay cannot drift grandfathered snapshots.
- [ ] Every subscription state transition, including mismatch and trial conversion, continues through `applyStripeSubscriptionState`; do not add a second status writer.
- [ ] If a matching Autopilot subscription activates while `autopilotPurchasable()` is false, preserve valid Stripe/status/tier state but emit the specified ops signal. Runtime enforcement in Tasks 6–7 remains the safety boundary.
- [ ] Update `resolveSubscriptionBilling` and every reverse-map consumer for `{tier, variant}`. Ensure both founding and list base IDs resolve even after the founding deadline closes.
- [ ] Move the overage worker's account/tier/variant read and active-location count inside the shared advisory lock. Resolve the overage ID through `priceIdFor(tier, variant, 'overage')`; both variants intentionally resolve the same per-tier overage Price.
- [ ] Keep `subscriptionGrantsFullAccess` semantics in the worker. Remove the Basic no-overage branch.
- [ ] Billing reconciliation and expected-invoice math continue using stored base/overage/included cents. Add an assertion against accidental registry re-derivation.
- [ ] Test matching list/founding events, unmapped-Price status-only behavior, mismatch status-only behavior, Sentry payload scrubbing, replay idempotency, trialing events, same-tier stored-cents preservation, tier-change complete snapshots, Autopilot gate-off activation alert, all overage Price variants, and common-lock ordering.
- [ ] Add a deterministic three-actor ordering test for tier change, subscription-updated, and overage synchronization. It must fail if any actor reads mutable billing/location state before the applicable advisory locks or waits on a lock while holding the account row. Add reverse-delivery tests for base-change and overage-change webhook events; both must converge to the retrieved provider-current subscription.
- [ ] Mutation spot-check: remove the mismatch early return and prove the test fails because a snapshot UPDATE appears.
- [ ] Run focused webhook/overage/reconciliation suites plus lint/typecheck. Commit as `feat(stripe): apply tier updates with immutable variants`.

## Task 6: Enforce Autopilot at grant and publish time

**Spec:** monetized autonomy runtime seam; WS4 §6 and WS6 §6 lock/gate amendments. **Files:** modify `worker/jobs/response-generation/load-context.ts`, `worker/jobs/response-generation/auto-approval.ts`, `worker/jobs/publisher/load-context.ts`, publisher gate/worker modules, `worker/jobs/publisher/auto-policy-downgrade.ts`, approval audit constants, and tests.

- [ ] Thread canonical subscription tier through `AutoApprovalCandidateInput` without raw casts or legacy fallbacks, but treat the pre-LLM generation context as diagnostic only.
- [ ] In `persistResponseAndNotify`, acquire the required review then business locks, then `accountId + ':tier_entitlement'` **before the first response/child write that can take an implicit account FK lock**. Extend `loadAutoApprovalRuntimeState` to re-read tier inside that transaction and hold entitlement through grant/audit/outbox commit. Never grant from the pre-LLM context value.
- [ ] Auto-policy grant requires both full-access subscription status and `subscription_tier === 'autopilot'`. Copilot with a valid policy, global flag, passing moderation, judge, and governor still remains owner review.
- [ ] Add tier to publisher context only as an early hint. For `approval_method='auto_policy'`, begin the outcome transaction in review → business → response order, acquire `accountId + ':tier_entitlement'`, and authoritatively re-read tier/status before target resolution, reply lookup, or any external publish call.
- [ ] Hold that transaction-scoped entitlement lock through the bounded external publish and the posted-or-downgraded database outcome; refactor mark-posted/downgrade helpers to accept the existing `tx` rather than nest transactions. Tier mutation paths take the same lock before billing/account locks, establishing a linearization point without session advisory locks (unsafe behind transaction-pooled Supavisor).
- [ ] Extend the existing transactional downgrade helper with a tier-entitlement-loss reason and audit action. Do not build a second downgrade transaction.
- [ ] Preserve its lock order: review anchor first, then business, response/child rows, outbox CAS, downgrade/audit/notification. Audit/outbox INSERTs cannot precede the anchor because their FKs acquire implicit locks.
- [ ] On Autopilot → Copilot while queued or inside the veto window, atomically return the response to owner review and notify through the existing owner-review path. Never post first and repair later.
- [ ] Runtime flag-off downgrade behavior remains unchanged. The tier gate is additive and has a distinct bounded reason for audit/ops.
- [ ] Tests cover Copilot grant denial, Autopilot grant success, invalid status for both tiers, a tier change during the LLM call, publisher mid-cycle downgrade, replay/idempotency, outbox CAS loss, and exact gate placement. Add a live regression for the WS6 implicit-FK deadlock: grant holds review/business, tier mutation holds entitlement/account, and the corrected grant must never take an account FK share before waiting on entitlement.
- [ ] Add live concurrency cases in both orders: (a) tier mutation holds entitlement first, so publisher waits then downgrades with zero external calls; (b) publisher holds entitlement first, so the bounded post/mark linearizes before the tier mutation commits. Repeat the downgrade-first case through subscription-updated, not only the dashboard tier-change path.
- [ ] Mock-SQL publisher tests assert the number and order of SQL calls. Add a mutation spot-check proving deletion of the tier early return reaches the mocked publisher and fails.
- [ ] Run auto-approval and complete publisher test directories plus lint/typecheck. Commit as `feat(autonomy): enforce autopilot tier at grant and publish`.

## Task 7: Gate policy editing and expose readiness

**Spec:** policy editing asymmetry and GET readiness block reason; WS4 suspension semantics. **Files:** modify `src/lib/auto-approval/settings.ts`, readiness/types modules, `/api/settings/auto-approval` route/view model, owner settings UI only as needed for the block reason, and tests.

- [ ] Add the single WS8 readiness block reason `autopilot_unavailable` for missing Autopilot purchasing/entitlement readiness. Preserve deterministic order with existing runtime-disabled, moderation, preview, impersonation, subscription, and suspension reasons.
- [ ] Read tier and subscription status under the existing account lock. Use `subscriptionGrantsFullAccess`; never compare raw status to `active`.
- [ ] An account may expand policy only when it is on Autopilot and `autopilotPurchasable()` is true. The route remains authoritative even if the browser has stale readiness.
- [ ] Classify each dial dimension explicitly:
  - Threshold: enabling from NULL or lowering the minimum star expands; raising it or disabling to NULL contracts.
  - Veto window: shortening expands; lengthening contracts.
  - Daily cap: raising or removing expands; lowering or adding a finite cap contracts.
- [ ] Classify location override create/delete/clear from effective inherited before/after projections. Deleting a restrictive override that reveals a more permissive account default is an expansion and must be blocked for Copilot/gate-off just like a scalar widening.
- [ ] Contractions and complete disablement remain allowed for Copilot, gate-off, suspended, or otherwise non-ready accounts, subject to existing auth/offboarding invariants. Never trap an owner in a more permissive policy.
- [ ] Preserve WS4 rules: a rowless dial patch does not imply threshold expansion; clearing a suspended row degrades it to threshold NULL rather than deleting it; fresh location overrides seed non-target dials from stored account defaults.
- [ ] GET readiness reports the new block reason without exposing server feature flags directly. The settings UI consumes server readiness rather than `NEXT_PUBLIC_*` variables.
- [ ] Tests form a complete old→new table for threshold, veto, and cap, including equal/no-op values, Copilot contraction, Autopilot expansion, gate closure, `trialing`, past-due grace, suspension, rowless policies, and permissive/restrictive inherited override create/delete/clear. Preserve the existing one-operation discriminated PATCH contract; do not invent a composite patch shape.
- [ ] Add an explicit regression proving impersonation remains mutation-blocked even for a contraction.
- [ ] Mutation spot-check: invert the veto/cap comparison or replace effective override projection with operation-name classification; prove the appropriate expansion test fails.
- [ ] Keep tenant-scope baseline 391; same-commit allowlist adjustment if the account SELECT text changes.
- [ ] Run all auto-approval settings/readiness/API/UI tests plus lint/typecheck. Commit as `feat(autonomy): gate policy expansion to autopilot`.

## Task 8: Pricing, onboarding, and billing UI

**Spec:** two-tier packaging, explicit selection, server-authoritative availability, PR #463 agent-team positioning. Invoke `repworth-brand-design` before editing UI and `react-doctor` after the React work; React Doctor is advisory if its known environment failure recurs and is not a release gate. **Files:** modify public pricing components/styles/tests, onboarding pay plan options/client/page, authenticated `BillingPanel`, and related view-model tests; remove dead annual derivation code/tests.

- [ ] Replace the four-card pricing surface with exactly Copilot and Autopilot. Show locked monthly base and extra-location amounts; no annual toggle, annual calculation, yearly savings claim, or interval selector remains.
- [ ] Remove and negatively assert every stale claim: `14-day free trial`, `No credit card`, and `95% automation`. Positive trial copy, when enabled, is exactly the truthful 30-day card-up-front, explicit-plan-selection posture.
- [ ] Align copy with the shipped agent-team positioning from PR #463 and the landing/dashboard surfaces:
  - Copilot: the agent team drafts and routes work for owner approval.
  - Autopilot: the same team may act inside owner-set rules, veto window, moderation, judge, and governor safeguards.
  - Do not imply negative-review autonomy or guarantee outcomes.
- [ ] Use RepWorth brand tokens/components and preserve responsive, keyboard, contrast, and reduced-motion behavior. Do not introduce an unrelated visual system.
- [ ] Public pricing may show the founding offer through the configured deadline, but authenticated plan and billing amounts come from a server-produced view model using the account's stored variant. A founding account never sees list pricing in its change modal.
- [ ] The onboarding pay page receives `{ purchasable, prices }` from the server. Remove module-load plan construction from `plan-options.ts`.
- [ ] Start with no selected tier. Autopilot appears disabled with useful server-derived explanation when unavailable; Copilot remains selectable. Submitting without a selection is rejected.
- [ ] `BillingPanel` lists only Copilot/Autopilot and displays the stored/account-variant amounts used by preview. No UI client reads `FOUNDING_DEADLINE`, `AUTOPILOT_PURCHASABLE`, or `AUTO_APPROVAL_ENABLED` directly.
- [ ] Update/remove `pricing-derivation.ts`, annual-toggle E2E coverage, and four-tier snapshots. Add component tests for exact amounts, founding/list views, no annual controls, explicit selection, unavailable Autopilot, and founder tier-change display.
- [ ] Run focused React tests, pricing/onboarding Playwright coverage where available, lint/typecheck, and React Doctor as advisory. Commit as `feat(ui): present copilot and autopilot plans`.

## Task 9: Contract legacy tiers out mechanically

**Spec:** complete replacement and mechanical old-tier proof. **Files:** all remaining tier call sites and fixtures; `scripts/ci/static-policy-audit.ts`, its tests, config/cost/admin modules, and same-commit allowlists.

- [ ] Remove all `WS8_TRANSITION_ONLY` exports, old enum members, configs, Price helpers, and runtime acceptance of `basic`, `standard`, `premium`, or `founders` as subscription tiers.
- [ ] Convert every schema, DTO, fixture, route, worker, dashboard display, analytics payload, and test to the canonical new type. `pnpm typecheck` is the first mechanical backstop.
- [ ] Convert former Premium non-autonomy features to both paid launch tiers, with tests:
  - edit-existing response flow;
  - past replies;
  - Zernio backfill.
- [ ] Remove Basic single-location behavior from quota and location flows; both launch tiers use one included location plus paid overage.
- [ ] Replace old cost-limit maps in tracker and admin cost reporting with explicit required `DAILY_COST_LIMIT_CENTS_COPILOT` and `DAILY_COST_LIMIT_CENTS_AUTOPILOT` positive-integer configuration. Do not encode a Standard→Copilot or Premium→Autopilot value mapping and do not invent default amounts: missing/malformed values fail the owning worker/server config gate. Price variant does not alter a tier's cost ceiling. The rollout runbook records both env values as operator-supplied deployment inputs before new code boots.
- [ ] Update admin provisioning UI/schema/API, shared schemas, response DTOs, fixtures, analytics, and Stripe webhook harnesses.
- [ ] Extend `ci:static-policy` with an AST/context-aware legacy-tier literal ban. It must catch old strings in subscription-tier comparisons, SQL values, schema enums, fixtures, and tier maps while allowing:
  - `price_variant = 'founding'` and the `PriceVariant` domain;
  - non-tier English/technical meanings such as standard confirmation, Basic auth, or standard library;
  - historical migrations and explicitly history-pinned migration tests.
- [ ] Add positive and negative audit fixtures for all five confusing strings (`basic`, `standard`, `premium`, `founders`, and singular `founding`). Do not implement a repository-wide raw-text ban.
- [ ] Land static-policy allowlists/exclusions in this same commit. Keep tenant-scope baseline exactly 391.
- [ ] Run `rg` as an inventory aid, then prove completeness with typecheck and `pnpm ci:static-policy`. No runtime old-tier literal may remain outside documented history exclusions.
- [ ] Run all affected suites plus lint/typecheck and every CI audit touched by the contraction. Commit as `refactor(billing): remove legacy subscription tiers`.

## Task 10: Migration 078 — strict tier constraints

**Spec:** contract migration after strict code. **Files:** create `supabase/migrations/078_copilot_autopilot_contract.sql` and `src/lib/shared/__tests__/migration-078-copilot-autopilot.integration.test.ts`; modify `.claude/reference/migrations-log.md`.

- [ ] Start from a DB with 077 applied. Add a NULL-safe aborting preflight for both tables:
  `subscription_tier IS NULL OR subscription_tier NOT IN ('copilot','autopilot')`.
- [ ] Abort before constraint changes if either table contains an invalid row. Tests must prove NULL and each legacy value block the migration.
- [ ] Add the strict named CHECK on `accounts.subscription_tier`, retaining its existing NOT NULL contract.
- [ ] Make `businesses.subscription_tier` NOT NULL and add the matching CHECK because it remains a deprecated write-only mirror.
- [ ] Keep migration 078 transactional and re-runnable with exact constraint-name checks.
- [ ] Add the 078 migration-log entry in this commit and advance the documented head/next values to 078/079.
- [ ] Test valid Copilot/Autopilot rows, invalid/NULL preflight failures, mirror NOT NULL behavior, and second apply.
- [ ] Apply 077 then 078 twice to the local test DB and run both migration suites. Commit as `feat(db): contract tiers to copilot and autopilot`.

## Task 11: Stripe preflight, parity verifier, rollout runbook, and references

**Spec:** six immutable Prices and quiesced deployment only. **Files:** modify `scripts/verify-stripe-price-parity.ts`, create a WS8 cutover preflight script and tests, create `docs/runbooks/ws8-tier-cutover.md`, update `.claude/reference/env-vars.md`, verify `.claude/reference/migrations-log.md`, update `docs/directory.md`, and related script tests.

- [ ] Rewrite the parity verifier to retrieve and validate all six new Stripe Prices: exact amount, USD currency, monthly recurring interval, active state, and tax behavior compatible with `STRIPE_TAX_ENABLED`. Duplicate Price IDs are a hard failure; WS8 does not invent an unspecified metadata schema.
- [ ] Add a dry-run-by-default Stripe-aware preflight that:
  - Independently paginates every Stripe subscription in the environment (`status=all`), treats Stripe's status as authoritative, and reconciles each subscription to local customer/account references. Orphaned/unprojected subscriptions are blockers, not omissions. It also reports DB/Stripe status disagreement rather than trusting a stale DB terminal status.
  - Uses an explicit terminal allowlist: only Stripe `canceled` and `incomplete_expired` pass. `incomplete`, `trialing`, `active`, `past_due`, `paused`, and `unpaid` all block regardless of legacy/new Price. WS8 has no live-subscription compatibility path.
  - Lists open Checkout Sessions and retrieves line items. Legacy Price membership blocks independently; `client_reference_id` is reconciliation metadata only, never a prerequisite for detection.
  - Supports an explicit `--expire-legacy-sessions` apply mode using Stripe's Session-expire API; logs IDs and counts but no customer PII.
  - Exits nonzero until every nonterminal subscription is cancelled and every legacy Session is expired.
- [ ] Do not make migration 077 call Stripe or depend on the preflight script. The operator runs it before 077 while ingress is quiesced.
- [ ] Write one rollout path only:
  1. Create six immutable Prices in staging, then production.
  2. Set six new Stripe env vars in Railway and Vercel while retaining seven legacy vars; also set operator-approved positive values for `DAILY_COST_LIMIT_CENTS_COPILOT` and `DAILY_COST_LIMIT_CENTS_AUTOPILOT` before new code boots.
  3. Set `FOUNDING_DEADLINE=2027-01-01T00:00:00Z`; initially keep `AUTOPILOT_PURCHASABLE=false`.
  4. Quiesce self-serve/admin account creation, tier mutations, Checkout creation, and Stripe ingress using documented platform controls; record start time and owner.
  5. Run parity plus the provider-wide dry-run preflight only after quiescence.
  6. Cancel every nonterminal subscription and expire every legacy Session; rerun the provider-wide blocker until zero while quiescence remains in force. Any future live-account migration requires a separately approved cutover design and is not part of WS8.
  7. Apply 077, verify complete account snapshots and zero outbox side effects.
  8. Deploy strict code, then resume only enough traffic for controlled Checkout, tier-change, trial, webhook, settings, grant, and publisher smoke tests.
  9. Apply 078 only after smoke and NULL-safe preflight pass.
  10. Fully resume traffic.
  11. Repeat staging-first sequence in production.
  12. Remove legacy env vars only after the rollback window closes; never edit a Stripe Price amount.
- [ ] Document the independent ops authorization for setting `AUTOPILOT_PURCHASABLE=true`: WS4/074 live, WS6/076 live, WS7 eval green, cadence limits documented, and `AUTO_APPROVAL_ENABLED=true`. Runtime composition remains the live backstop.
- [ ] Document rollback boundaries: before 077, old code may be restored while both env sets remain; after 077, old binaries cannot parse the normalized Copilot/list rows, so stay quiesced and roll forward/fix the strict code. After 078, recovery likewise requires an explicit forward repair and may not reintroduce legacy tier data.
- [ ] Update env and migration references with 077/078 details, immutable variants, six Price variables, the exact deadline, required operator-supplied cost-limit variables, and head/next migration number. Invoke the `document-feature` skill for the normal `docs/currents.md`, progress-tracking, and reference sweep; keep those updates in this task's commit.
- [ ] Unit-test verifier/preflight dry run, duplicate/missing/wrong Price shapes, every Stripe status (including `incomplete`, `paused`, `unpaid`, `canceled`, and `incomplete_expired`), orphan Stripe subscriptions absent from DB, open legacy-Price Sessions with valid/missing/malformed `client_reference_id`, full pagination, Stripe errors, and redacted logs.
- [ ] Run script tests, parity verifier against fixtures/mocks, lint/typecheck. Commit as `docs(ops): add ws8 stripe cutover runbook`.

## Task 12: Branch-final mechanical verification and fix pass

**Spec:** whole WS8 contract. **Files:** fixes only; no scope expansion.

- [ ] Search for every tier writer and prove it either stamps the creation variant or reads the immutable stored variant before resolving price/snapshot data.
- [ ] Search every billing read and prove it uses stored cents rather than live registry cents.
- [ ] Trace both autonomy gates end-to-end: generation cannot grant Copilot auto-policy approval; publisher cannot post after mid-cycle entitlement loss.
- [ ] Trace the fixed advisory orders end-to-end: approval lane → entitlement, tier mutation entitlement → billing → account row, overage-only billing → account row. Prove no tier writer takes a review lock and no path waits on an advisory lock while holding the account row.
- [ ] Trace policy-edit asymmetry for all three dial dimensions and confirm every contraction remains available when expansion is blocked.
- [ ] Review lock order and concurrency across tier-change, overage worker, webhook, settings, grant, and publisher downgrade. Include implicit FK locks in the review.
- [ ] Perform mutation spot-checks for:
  - removing stored-variant use from founder preview;
  - changing overage quantity by one;
  - allowing snapshot mutation on webhook variant mismatch;
  - deleting the publisher entitlement early return;
  - reversing veto/cap expansion comparisons;
  - draining a mock-SQL queue before the branch under test.
- [ ] Apply the local test DB through migration 076 first using only `postgresql://test:test@localhost:5499/test_ws4`; then exercise 077/078. Never use a Supabase URL for this suite.
- [ ] Run the full Vitest suite sequentially:
  `TEST_DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 pnpm vitest run --no-file-parallelism`.
- [ ] Run `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
- [ ] Run every direct audit from `package.json`: `ci:tenant-scope`, `ci:rls-audit`, `ci:analytics-events`, `ci:static-policy`, `ci:response-status`, `ci:admin-aal2`, `ci:config-coverage`, `ci:process-env`, `ci:reviews-status`, `ci:outbox-topics`, `ci:db-imports`, and `ci:fallow`. Confirm tenant-scope baseline is 391 and no same-commit allowlist is missing.
- [ ] Satisfy the coverage-informed `ci:fallow:coverage` entry too: remove any stale `coverage/coverage-final.json`, run the workflow-equivalent DB-less `pnpm test:coverage`, then `pnpm ci:fallow:coverage` with a fresh report and `origin/main` as the base. Record that this is a second, DB-less coverage run, not a substitute for the sequential DB-backed suite.
- [ ] Run `pnpm eval:llm` offline/keyless.
- [ ] Run relevant Playwright pricing/onboarding/billing/settings smoke tests if their prerequisites are available. Record skips honestly.
- [ ] Run React Doctor as advisory only; record the known-broken result if it cannot run, but do not substitute it for lint/typecheck/build/tests.
- [ ] Fix every gate failure and rerun the complete affected gate, not a filtered assertion. Commit branch-final fixes as `fix(ws8): close branch verification findings` only when needed.
- [ ] Produce the executor report: branch, ordered commits, per-task spec/adversarial review outcomes and fix rounds, tail output for every gate, deviations from this plan, and open concerns. Stop without opening a PR.
- [ ] This task is a mechanical branch-final fix pass, **not** the reserved whole-branch integration review. Do not dispatch the four final spec/concurrency/seams/test-honesty reviewers; the integration owner performs that review after handoff.

## Expected commit sequence

1. `feat(db): add ws8 tier expansion migration`
2. `feat(billing): add copilot autopilot pricing registry`
3. `feat(billing): wire variant aware signup and checkout`
4. `feat(billing): make tier changes variant safe and serialized`
5. `feat(stripe): apply tier updates with immutable variants`
6. `feat(autonomy): enforce autopilot tier at grant and publish`
7. `feat(autonomy): gate policy expansion to autopilot`
8. `feat(ui): present copilot and autopilot plans`
9. `refactor(billing): remove legacy subscription tiers`
10. `feat(db): contract tiers to copilot and autopilot`
11. `docs(ops): add ws8 stripe cutover runbook`
12. Optional branch-final `fix(ws8): close branch verification findings`

Do not squash task commits during execution; the final integration owner needs the boundaries for review and may decide how to present them when opening the PR.
