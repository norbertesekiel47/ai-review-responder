# Plan Review Log: WS8 Pricing — Copilot/Autopilot tiers + founding cohort
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=10.

## Round 1 — Codex
VERDICT: REVISE. Material findings:
1. Cohort cap not safely bounded (concurrent COUNT admits >100); signup-vs-select-plan inconsistency.
2. `basePriceIdForTier(tier)` can't preserve per-account founding — callers pass only tier.
3. "Honored for life" breaks on upgrade/downgrade — tier-change writes TIER_CONFIG list price (tier-change.ts:249).
4. Stripe webhook overwrites founder price from TIER_CONFIG on tier transition (subscription-updated.ts:179).
5. "Flip default" breaks reverse map — removing founding IDs orphans active founder subs (price-tier-map.ts:33).
6. Promo codes already bypass stored-price invariant (create-checkout-session.ts:149 allow_promotion_codes).
7. Annual undecided while advertising 20%; checkout is monthly-only (pricing-derivation.ts:11).
8. Autopilot gate incomplete — must cover all tier writers, not just picker (BillingPanel.tsx:10).
9. "Trial defaults to highest available" contradicts unconditional Copilot default (create-business.ts:353).
10. Migration touches only accounts; deprecated businesses.subscription_tier still written/defaults standard (034:31).
11. Missed production old-tier call sites: PricingContent 4 cards, dashboard 4 options, schemas.ts, edit-existing.ts:133 Premium gate.
12. Cost limits + response DTOs preserve legacy tier semantics, silently fall back (tracker.ts:34, types.ts:22).
13. Cross-tenant cohort query needs service-only boundary + tenant-audit allowlist.
14. Simpler alternative: fixed founding deadline instead of first-100, storing the price variant.

### Claude's response
Accepted 12/13 findings as material; rejected none (only nuance: promo-code disable gets a
"verify no other dependency" caveat). Adopted finding 14 (deadline over count) as an arbiter
override of the grilled cohort-cap — dissolves findings 1 and 13 — flagged for user sign-off.
Rev 2 introduces the load-bearing fix behind 2/3/4/5: an **immutable per-account price_variant**
that all price resolution (checkout, tier-change, webhook snapshot, currentBillingSnapshot)
derives from, never re-deriving from TIER_CONFIG list. price-tier-map retains all Price IDs
forever, variant-aware reverse map (5). Monthly-only launch, no annual selector (7). Centralized
assertTierPurchasable() in every tier writer (8). Explicit trial = user selection, no implicit
default (9). Migration handles both tier columns + adds CHECK backstops (10). Step-7 full
old-tier call-site inventory with entitlement mapping — premium-gated non-autonomy features →
both tiers (11, 12). Promo codes disabled on these checkouts (6).

## Round 2 — Codex
VERDICT: REVISE. Rev 2 fixed major defects (deadline, account-scoped variant, retained IDs,
variant through tier-change/webhook, promo codes off, annual removed, wider inventory).
Remaining gaps:
1. price_variant immutability: CHECK insufficient — need BEFORE UPDATE trigger + tests.
2. currentBillingSnapshot must NOT re-derive from (tier,variant) — keep stored cents as authority (quota.ts:81).
3. FOUNDING_DEADLINE needs config schema, strict UTC parse, fail-closed (server.ts:34).
4. Autopilot gate underspecified — define one autopilotPurchasable() predicate + test all combos (env-vars.md:441).
5. Picker builds plans at module load, no server availability/variant (PlanPickerClient.tsx:12).
6. Reverse-map consumers beyond writers: overage-item.ts:184, subscription-updated.ts expect tier-only.
7. TIER_CONFIG .baseCents display reads show list to founders (BillingPanel.tsx:374).
8. StripeEnvConfig/narrowStripeConfig/.env.example/startup assertions left on obsolete fields (stripe-shape.ts:19).
9. "Create six Stripe Prices" omits recurring/currency/tax matrix (create-checkout-session.ts:128).
10. Name remaining Premium gates explicitly: load-replies.ts:76, ZernioBackfillWorker.ts:188 (+ edit-existing).

### Claude's response
Accepted all 10; rejected none. Finding 2 was Codex catching a correctness error I introduced in
Rev 2 (over-eager "derive everywhere from variant") — Rev 3 makes the WRITE-time (variant+config
→ store) vs READ-time (stored cents authority, migration-054 unchanged) distinction explicit and
load-bearing. Added: BEFORE UPDATE trigger for price_variant immutability + tests (1); fail-closed
UTC FOUNDING_DEADLINE parser (3); single autopilotPurchasable() predicate with enumerated inputs +
combo tests (4); server-provided picker view model, route authoritative (5); update all reverse-map
consumers to {tier,variant} (6); variant-aware display helper for .baseCents reads (7); rewrite
StripeEnvConfig/narrowStripeConfig/.env.example/startup+instrumentation assertions + tests (8);
Stripe Price setup matrix — USD monthly recurring, active, amounts, tax-compatible, preflight (9);
all three Premium gates named + mapped to both paid tiers with tests (10). Verified all named files
exist and consumers are as Codex described.

## Round 3 — Codex
VERDICT: REVISE. Rev 3 addresses nearly all prior findings. Remaining:
1. Missed UpdateStripeOverageWorker.ts:25 — calls old overagePriceIdForTier directly.
2. Autopilot predicate still not concrete — CI/eval/Zernio are ops prerequisites, not runtime inputs; name one deploy-time flag.
3. "Zero rows" wrong — only zero PAYING; pending/cancelled/staging rows would fail the new CHECK. Preflight both tables.
4. Migration number 07x → repo next is 077 (head 076).
5. Factual: Past Replies reads accounts.subscription_tier, not businesses; identify real deprecated-column users.

### Claude's response
Accepted all 5; rejected none. Verified against the tree: migrations 072-076 (WS2-WS6) now exist,
so next is 077 (4) and the autopilot gate can reference real flags. Confirmed load-replies reads
a.subscription_tier via JOIN (5) — businesses.subscription_tier is a WRITE-only mirror
(plan-activation.ts:107); corrected the rationale, change its default + optional hygiene CHECK.
Rev 4: added UpdateStripeOverageWorker to price-map consumers (1); autopilot gate = single
deploy-time AUTOPILOT_PURCHASABLE flag, with WS4/WS6/WS7/Zernio as an ops prerequisite CHECKLIST
not a runtime predicate (2); migration preflights BOTH accounts+businesses for any non-new tier
value and aborts/resets before adding CHECKs — zero-paying ≠ zero-rows (3); reserved 077 with a
re-check note (4); corrected premium-gate column rationale + "any paid tier" replacement (5).

## Round 4 — Codex
VERDICT: REVISE. Rev 4 addresses prior implementation gaps. Two remaining:
1. AUTOPILOT_PURCHASABLE can stay true after AUTO_APPROVAL_ENABLED emergency-disabled → sells Autopilot, delivers Copilot.
2. No safe env/code rollout order — worker boot assertion derives Stripe keys from the price map (startup-assert.ts:8); wrong order crashes boot.

### Claude's response
Accepted both; rejected none. Rev 5: autopilotPurchasable() = AUTOPILOT_PURCHASABLE &&
autoApprovalRuntimeEnabled() — deploy-time authorization AND live safety backstop; test all 4
combos (1). Added step 12: documented+tested env/code rollout sequence (create Prices → add new
vars retaining legacy → migrate staging → deploy → smoke → prod → remove legacy after rollback
window), with a boot-assertion test (2).

## Round 5 — Codex
VERDICT: REVISE. Rev 5 resolves the live safety backstop + Stripe-env transition. Two remaining:
1. validateTierChange() preview builds from TIER_CONFIG[tier].baseCents (tier-change.ts:107) → founders see list pricing in the modal.
2. Preflight `NOT IN (...)` misses NULL, and CHECK `IN (...)` accepts NULL — esp. the nullable businesses mirror.

### Claude's response
Accepted both; rejected none. Rev 6: WRITE-time rule now explicitly covers all three tier-change
paths incl. validateTierChange() PREVIEW + founder preview tests (1); preflight predicate is
NULL-safe (`IS NULL OR NOT IN`), accounts is already NOT NULL, and the businesses mirror must be
made NOT NULL before/with any CHECK or the constraint is meaningless (2).

## Round 6 — Codex
VERDICT: REVISE. Rev 6 addresses prior preview + NULL-safe checks. One remaining:
1. Autopilot purchasable but NOT enforced at runtime — auto-approval candidate (auto-approval.ts:302)
   + publisher context (load-context.ts:56) load status not tier; a Copilot account with a policy
   could auto-post once AUTO_APPROVAL_ENABLED is on, incl. after Autopilot→Copilot downgrade mid-veto.

### Claude's response
Accepted; rejected none. This is the load-bearing billing↔autonomy seam — without it the tier is
cosmetic. Rev 7 adds step 5b: tier entitlement enforced at grant time (subscription_tier==='autopilot'
prerequisite for auto_policy approval) AND publish time (re-check; downgrade queued auto-policy rows
to owner review on entitlement loss, mirroring the invariant-#3 flag-off downgrade). Sharpened the
scope note: WS8 owns the entitlement GATE into the autonomy runtime; WS4 owns the mechanics.

## Round 6 — Codex
VERDICT: REVISE. One finding: Autopilot purchasable but NOT enforced at runtime (auto-approval.ts:302,
load-context.ts:56 load status not tier — a Copilot account could auto-post; downgrade mid-veto still posts).

### Claude's response
Accepted; the billing↔autonomy seam. Rev 7 step 5b: grant-time (subscription_tier==='autopilot'
prerequisite) + publish-time re-check with downgrade-to-owner-review on entitlement loss (mirrors
invariant-#3 flag-off downgrade). Scope note: WS8 owns the entitlement GATE; WS4 owns mechanics.

## Round 7 — Codex
VERDICT: REVISE. Two findings:
1. Migration rollout backward-incompatible — strict CHECK applied before new code deploys, but old
   binaries still write 'standard' (create-business.ts:144, plan-activation.ts:96) → live writes fail.
2. Autopilot kill-switch doesn't cover already-open Checkout Sessions (create-checkout-session.ts:131).

### Claude's response
Accepted both. #1 fully: split into expand (077, no strict CHECK) → deploy code → contract (078,
adds CHECK after old writers gone); pre-launch quiesce noted as alternative. #2 with the simpler of
Codex's two offered options: gate blocks only NEW session creation; in-flight completion is not a
safety hole (step-5b runtime blocks auto-post while flag off); residual billing edge handled by a
webhook-time ops flag (offer downgrade/refund), NOT session-persistence infra (over-engineering).

## Round 8 — Codex
VERDICT: REVISE. One finding: strict code deployed before legacy rows normalized — new
isSubscriptionTier() recognizes only copilot/autopilot, so pending/cancelled legacy rows fail
reads/checkout/reconciliation immediately after deploy; open legacy Checkout Sessions complete with
unmapped Prices. Normalize data + invalidate legacy sessions BEFORE strict deploy.

### Claude's response
Accepted. Rev 9: made normalize-before-strict-deploy explicit. Default path (proportionate given
zero paying accounts, pre-launch prod): quiesce → 077 (add price_variant/trigger/defaults + normalize
EVERY legacy row + invalidate open legacy Checkout Sessions, no strict CHECK) → deploy strict code
(all rows already valid) → 078 (NULL-safe preflight + CHECK). Documented true expand/contract
(normalize + retain legacy Price IDs in reverse map for the window) as the live-traffic alternative.
Updated the step-12 rollout runbook to match.

## Round 9 — Codex
VERDICT: REVISE. Three more old-tier sites (same class as Round 2/3 tail):
1. Admin provisioning schema.ts:23 accepts only founders|standard, defaults founders → rejects admin-created accounts.
2. Admin cost-report-service.ts:76 retains old tier map, silent Standard fallback for new tiers.
3. verify-stripe-price-parity.ts:17 calls removed APIs, validates one base price/tier not both variants.

### Claude's response
Accepted all three, but stopped the whack-a-mole: rather than keep enumerating sites Codex greps one
per round, Rev 10 makes completeness MECHANICAL — Backstop A (typecheck catches every enum-typed ref
once the union loses its old members) + Backstop B (extend ci:static-policy to fail on any old-tier
string literal in tier context, which is how string-typed `=== 'premium'` comparisons — admin schema,
cost-report, premium gates — slipped past manual review). CI now answers "are there more?", not the
next reviewer. Named the 3 new sites explicitly under the guards.

## Round 10 — Codex (MAX_ROUNDS cap)
VERDICT: REVISE. One finding: "zero PAYING" ≠ "zero financially-live" — a trialing account has a
real Stripe subscription on a legacy Price that charges at trial end (create-checkout-session.ts:140);
resetting its tier + dropping the legacy reverse-Price mapping breaks stored-price-vs-charge and
leaves stale 7900/2500 snapshot cents (subscription-updated.ts:40 depends on the reverse map).

### Claude's response
Accepted. Rev 11: preflight now catches ANY nonterminal Stripe subscription (trialing/active/past_due),
not just paying. Found ones: cancel on staging (test data), or for a genuine one retain its legacy
Price in the reverse map + DEFER its tier/snapshot rewrite until it ends. Only no-live-subscription
accounts are normalized here; normalization rewrites subscription_tier AND all snapshot cents
atomically (never tier alone). Deploy strict code only once no un-normalized/un-deferred legacy row
remains.

## Resolution — MAX_ROUNDS (10) reached, converging (not deadlocked)
Findings per round: 13 → 10 → 5 → 2 → 2 → 1 → 2 → 1 → 3 → 1. Every finding accepted and incorporated;
zero rejected; no Claude↔Codex disagreement (not a deadlock — a large surface thoroughly swept). The
Round-10 fix is in but not yet Codex-reconfirmed because the round cap was hit. Handed to user: sign
off now, or authorize one confirmation round.

## Round 11 — Codex (user-authorized confirmation round)
VERDICT: REVISE. Rev 11's deferred-account branch is internally inconsistent: a deferred genuine
legacy sub stays subscription_tier='standard', which strict code doesn't recognize and 078's CHECK
rejects; retaining only the legacy Price reverse mapping doesn't make strict reads/quota/contract safe.
Fix: make any genuine legacy subscription a hard launch blocker (cancel/migrate), OR ship a
compatibility tier/read path and postpone 078 + literal ban until every deferred sub ends.

### Claude's response
Accepted; took option (a) — hard launch blocker — which SIMPLIFIES the plan by removing the
inconsistent deferral branch. Rev 12: any nonterminal legacy Stripe subscription (incl. trialing)
must be cancelled/migrated BEFORE strict deploy; no defer-with-legacy-tier branch. Pre-launch the set
is expected empty; staging test subs cancelled. Normalization then unconditional; 078 CHECK + literal
ban safe. Returned to user (single authorized confirmation round returned REVISE, not APPROVED).

## Round 12 — Codex (2nd user-authorized confirmation round)
VERDICT: REVISE. One finding: normalization named base_price_cents + locations_overage_price_cents
but omitted locations_included (+ locations_paid mirror). Resetting a legacy Premium row to Copilot
while keeping locations_included=5 grants 5 free locations + wrong overage math (quota.ts:65).

### Claude's response
Accepted; fixed structurally (mirroring the old-tier literal-ban lesson): normalization now
re-derives the COMPLETE snapshot via the canonical signup snapshot-writer for (copilot, list) —
subscription_tier, base_price_cents→2900, locations_overage_price_cents→1500, locations_included→1,
locations_paid recomputed from active locations — NOT a hand-picked column UPDATE. Completeness is
by-construction, not enumeration. Added a legacy-Premium (5-loc) normalization test. Returned to user.

## Post-review owner-authorized amendment — 2026-07-15

The owner authorized a narrow reversal of Round 7's rejection of Checkout Session persistence.
The old decision considered only gate closure on one already-open Autopilot Session. It was unsafe
under plan reselection: Copilot and Autopilot Sessions could coexist, the older Copilot Session could
complete after the account snapshot had been overwritten to Autopilot, and the status-only mismatch
path could activate $69-tier autonomy while Stripe charged the $29 Copilot Price (with a second
subscription also able to bill).

The amendment adds exactly one account-scoped authoritative pending Checkout attempt/Session lease
with the full tier/variant/Price/cents/quota snapshot, stable provider idempotency, prior-open expiry
on reselection, failed-bind compensation, stale-completion remediation, and retained completed
identity for safe replay. It does not change pricing, founding-for-life, trial, purchasability, or the
quiesced 077 → strict code → 078 rollout. Initial Checkout lease/Price mismatch is the narrow security
exception that rejects/remediates before status projection; later `subscription.updated` variant
mismatch remains status-only through the single applier and never mutates immutable variant or the
billing snapshot.

The adversarial implementation follow-up tightened that amendment without changing its commercial
scope. The lease now freezes every Stripe-create input (including Price ids, quantity, trial days,
tax shape, customer email, and success/cancel URLs); exact creating/open retries never consult live
configuration under the stable idempotency key. Initial completion accepts only provider
`active`/`trialing` plus a changed+activated binding transition. Other provider states or a
non-binding result are canceled/remediated for explicit reselection. A retained completed replay
continues to skip status/snapshot/cancellation but retries deprecated tier-mirror convergence.
The final follow-up locates the purchasability decision at new durable-attempt authorization: exact
`creating` recovery and open-Session reuse remain authorized after gate drift and use only their
frozen provider parameters. Checkout completion always retrieves provider-current Session state;
stale/missing event subscription fields are not authoritative, and a provider-current completed
Session without a subscription identity remains retryable because no safe bind/cancel decision is
possible. Migration 077's full-lease CHECK rejects NULL explicitly for every required field.
