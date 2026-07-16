# WS8 — Copilot / Autopilot tier wiring — Design

**Date:** 2026-07-14

**Phase:** Agentic Platform Phase 1, WS8

**Depends on:** WS4 trust dial + veto window (shipped) and WS6 judge + governor
(shipped and promoted). WS7's eval gate and written Zernio cadence limits are
operational prerequisites for selling Autopilot.

**Feeds:** launch packaging and monetized autonomy.

## 0. Authority and resolved inputs

This specification reconciles, without repricing:

- `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §3.3
  and decision log #2;
- the WS8 row in
  `docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md`;
- WS4 §6 amendments, which own policy/suspension semantics and the binding
  review-lane lock order;
- WS6 §6 amendments, which own judge/governor and suspension-writer semantics;
- `docs/superpowers/inputs/2026-07-14-ws8-pricing-hardened-design.md`
  (Rev 13) and its Codex review log;
- the WS8 kickoff resolutions recorded on 2026-07-14.

The handoff referenced by the kickoff is absent and that absence is authorized.
There are no unresolved pricing decisions in this spec. The founding deadline is
locked to **`2027-01-01T00:00:00Z`**. On conflict, the WS8 kickoff resolutions win
over the older source text; WS4 §6 and WS6 §6 continue to win for the seams they
own.

Terminology correction for older inputs: WS8 does require database migrations and
normalization. “No migration” means **no legacy customer-tier mapping or price
grandfathering**, because no nonterminal Stripe subscription may cross the launch
boundary.

## 1. What WS8 ships

RepWorth remains one product and one agent substrate. The paid tier controls how
the Reply agent may act:

- **Copilot** — Reply drafts; the owner approves every public action.
- **Autopilot** — Reply may post 4–5★ unflagged replies inside the owner's policy,
  after all existing hard gates, a delivered-notice veto window, daily caps, and
  the WS6 judge/governor. Negative-review autonomy remains impossible at launch.

WS8 ships:

1. the two-tier domain model and six new immutable Stripe Prices;
2. immutable per-account `price_variant` and variant-aware price resolution;
3. founding-window assignment with a fixed, fail-closed UTC deadline;
4. variant-correct signup, trial, checkout, tier-change preview/execute, overage,
   webhook, billing-panel, and reconciliation behavior;
5. Autopilot purchasability and tier entitlement at policy-edit, grant, and
   publish time;
6. migrations 077/078 using the quiesced normalize-before-strict rollout;
7. mechanical removal of every legacy-tier reference;
8. a two-tier, monthly-only pricing page aligned with the Reply / Guardian /
   Insights positioning shipped in PR #463.

WS8 owns the **billing entitlement gates into autonomy**. WS4 continues to own
trust-dial, veto, notice, suspension, and downgrade mechanics; WS6 continues to own
the judge/governor and suspension writer.

### 1.1 Locked prices

| Tier | List base / month | Founding base / month | Extra active location / month | Included |
|---|---:|---:|---:|---:|
| Copilot | $29 | $19 | $15 | 1 |
| Autopilot | $69 | $49 | $20 | 1 |

- Monthly only. There is no annual interval, discount, selector, or annual copy.
- The four legacy tiers `basic`, `standard`, `premium`, and `founders` are deleted.
- “Founding” is a price variant, never a subscription tier.
- Founding-for-life spans tier changes: a founding Copilot account changing to
  Autopilot receives the founding Autopilot base price ($49).
- Existing rows normalize to Copilot/list. There is no old-tier-to-new-tier
  entitlement mapping and no legacy-price grandfathering.
- Former Premium **non-autonomy** powers become available to both paid tiers.
  Autonomy itself remains Autopilot-only.

### 1.2 Out of scope

- Annual billing, annual Prices, interval-aware snapshots, and annual refunds.
- Outcome/usage billing, Stripe Meters, or attribution billing.
- A third tier or Solicitation packaging.
- Changes to WS4 policy mechanics beyond the explicitly authorized WS8 settings-
  gate amendment in §4.3; negative-review autonomy, confidence routing,
  judge/governor thresholds, and owner self-service unsuspend remain out of scope.
- Revoking already-created Stripe Checkout Sessions when a runtime flag closes.
- Any live-traffic legacy compatibility window. The only authorized rollout is
  the quiesced path in §8.

## 2. Tier registry, price variant, and stored-snapshot law

### 2.1 Canonical domain types

`src/lib/accounts/tier-config.ts` becomes the only application owner of:

```ts
SubscriptionTier = { COPILOT: 'copilot', AUTOPILOT: 'autopilot' }
type PriceVariant = 'list' | 'founding'
```

Its registry contains, without fallbacks:

- Copilot: base `{ list: 2900, founding: 1900 }`, `included: 1`,
  `overageCents: 1500`, `multiLocAllowed: true`;
- Autopilot: base `{ list: 6900, founding: 4900 }`, `included: 1`,
  `overageCents: 2000`, `multiLocAllowed: true`.

Unknown tiers and variants are explicit errors. No path silently defaults an
unknown value to Copilot/list. A canonical pure snapshot resolver derives the
complete write-time tier snapshot from `(tier, variant)`; signup, tier change,
and webhook code reuse it. Migration 077 deliberately uses reviewed SQL constants
instead (§7), with tests pinning those constants to this registry.

### 2.2 Immutable account variant

Migration 077 adds:

```sql
accounts.price_variant TEXT NOT NULL DEFAULT 'list'
CHECK (price_variant IN ('list', 'founding'))
```

A `BEFORE UPDATE OF price_variant` trigger raises whenever
`NEW.price_variant IS DISTINCT FROM OLD.price_variant`. The trigger is scoped to
that column only: tier, status, snapshot, and unrelated account updates continue
to work.

The account-creation transaction explicitly stamps the variant once:

- `founding` iff the validated server time is strictly before the deadline;
- `list` at the deadline and afterward;
- `list` when the deadline configuration is absent or invalid.

Late Checkout completions and webhooks never recalculate or mutate the variant.

### 2.3 Founding deadline

`FOUNDING_DEADLINE` is server-only and set to
`2027-01-01T00:00:00Z` in every intended environment. The parser accepts a real,
full UTC timestamp ending in `Z`, rejects offsets, date-only strings, impossible
calendar/time values, empty strings, and trailing content, and verifies the value
round-trips as UTC. Eligibility is exactly:

```ts
now.getTime() < deadline.getTime()
```

Unset/malformed configuration fails closed to `list` and emits a scrubbed
operational error plus a Sentry signal. It must not crash unrelated page rendering
or expose the raw environment value.

### 2.4 Write-time versus read-time authority

This distinction is load-bearing:

- **WRITE time:** `(tier, price_variant)` selects the base Price ID and the cents
  written to `accounts.base_price_cents` and
  `accounts.locations_overage_price_cents`; tier config also writes
  `locations_included`.
- **READ time:** `currentBillingSnapshot`, invoice expectations, MRR, quota, and UI
  current-price displays use the stored account snapshot. They never re-derive an
  existing account's cents from the current registry.

Changing a registry price later affects new writes only. It cannot drift an
existing account. Tier-change preview is a proposed **write** and therefore
resolves the target tier using the account's immutable variant. BillingPanel's
current plan reads stored cents; its target-plan previews use the same resolver as
the server validation.

Cost ceilings are operational safeguards, not product-price mappings. WS8 adds
required positive-integer `DAILY_COST_LIMIT_CENTS_COPILOT` and
`DAILY_COST_LIMIT_CENTS_AUTOPILOT` configuration with no encoded default and no
Standard/Premium value mapping. Missing or malformed values fail the owning
worker/server config gate. The operator supplies both values before new code
boots; `price_variant` never changes the tier ceiling.

## 3. Stripe Price map, env shape, and checkout

### 3.1 Six-Price map retained indefinitely

`src/lib/payments/price-tier-map.ts` owns exactly these new variables:

- `STRIPE_PRICE_COPILOT_LIST`
- `STRIPE_PRICE_COPILOT_FOUNDING`
- `STRIPE_PRICE_AUTOPILOT_LIST`
- `STRIPE_PRICE_AUTOPILOT_FOUNDING`
- `STRIPE_PRICE_COPILOT_OVERAGE`
- `STRIPE_PRICE_AUTOPILOT_OVERAGE`

The public API is variant-aware:

```ts
priceIdFor(tier, variant, 'base' | 'overage'): string | null
basePriceInfoForId(id): { tier: SubscriptionTier; variant: PriceVariant } | null
```

Overage has one Price per tier; the variant argument does not create variant
overage prices. All four launch base IDs and both launch overage IDs remain in
the forward/set and reverse maps indefinitely. If a later price rotation
introduces another ID, the old ID moves into an explicit retained-history
registry rather than disappearing from reverse lookup. Closing the founding
window changes only the variant assigned to new accounts.

Every consumer migrates to this owner, including Checkout, tier change,
subscription-updated, `resolveOverageItem`, overage mutation planning,
`UpdateStripeOverageWorker`, Stripe reconciliation, and parity verification.
The overage worker loads `price_variant` with the account even though overage
cents currently do not vary; it must not reconstruct a base-price assumption.

`StripeEnvConfig`, `narrowStripeConfig`, `.env.example`, worker startup assertion,
Next instrumentation soft assertion, and their tests derive from
`STRIPE_PRICE_ENV_VARS`. The seven legacy Stripe Price variables remain in deployed
environments only through the rollback window; new code does not read them.

### 3.2 Stripe Price shape

Before env cutover, the parity script retrieves all six Prices and requires:

- currency `usd`;
- recurring interval `month`;
- active Price;
- exact unit amounts `2900`, `1900`, `6900`, `4900`, `1500`, `2000`;
- tax behavior compatible with `STRIPE_TAX_ENABLED`.

Existing Stripe Prices are never edited. Any future price change creates a new
Price and follows `.claude/reference/env-vars.md` while preserving stored account
snapshots and every still-referenced Price ID.

### 3.3 Checkout and trial

- Both self-serve entry points require an explicit submitted tier. There is no
  server or client implicit tier default. `/api/billing/checkout` must add the
  tier to its validated request rather than inferring the account's provisional
  Copilot snapshot; an absent tier creates no Session. Before direct Checkout
  creates a Session, it persists the complete selected `(tier, stored variant)`
  pending snapshot with `locations_paid=0` under the billing lock protocol. It
  may never create Autopilot Stripe items while the account remains Copilot.
- The highest available trial tier is Autopilot only while its purchasability
  gate is open; otherwise the available ceiling is Copilot. The owner still
  explicitly selects from the tiers actually offered.
- `TRIAL_ENABLED` keeps the existing card-up-front, Stripe-native 30-day trial.
  The selected tier and account variant choose the same base/overage Prices used
  after conversion.
- `trialing` receives full product access through
  `subscriptionGrantsFullAccess`; do not use raw `status === 'active'` checks.
- Checkout resolves both items from `(selectedTier, account.price_variant)`.
  Before Stripe confirms a subscription, the complete pending-payment snapshot
  stores the selected tier/cents/included count with `locations_paid=0`; the
  Checkout overage line-item quantity is calculated separately from active
  locations. Checkout completion/plan activation copies the trusted Stripe item
  quantity into `locations_paid`: paid and trial completion retrieve the provider-
  current subscription, verify its base Price against stored `(tier, variant)`,
  and use the fixed entitlement → billing → activation → account-row order.
  Subscription status still changes only through `applyStripeSubscriptionState`.
- One account-scoped authoritative pending Checkout lease stores the attempt id,
  Session id/state, tier, variant, both Price ids, complete cents/quota snapshot,
  provisional overage quantity, trial days, tax shape, customer email, and
  success/cancel URLs. The attempt id is the stable Stripe idempotency identity.
  Exact creating/open retries use this frozen create tuple without consulting
  live Price/config/email/deployment inputs and reuse the open Session. Reselection must
  resolve and expire the previous open Session before committing a replacement;
  a completed previous Session blocks replacement. A failed expiry creates no
  new attempt or Session, and an expire-versus-complete race is resolved from
  provider-current state.
- If provider Session creation succeeds but lease binding or commit fails, the
  creator resolves ambiguous commit state under the activation locks. A bound
  lease is returned unchanged; otherwise the unbound Session is expired with a
  stable idempotency key, or its subscription is canceled if completion won the
  race, and the attempt retains a remediated identity.
- Checkout completion retrieves provider-current Session line items and the
  provider-current subscription under entitlement → billing → activation,
  compares provider + lease + canonical account while the account is still
  `pending_payment`. Only provider `active`/`trialing` plus a changed+activated
  binding transition may reach the complete snapshot writer. A stale/mismatched
  attempt never changes status, tier, or snapshot; non-entitled/non-binding
  completion cancels the subscription and remediates the attempt for reselection. Completed attempt and
  Session identity is retained so successful replay remains a no-op even after
  legitimate later tier/quantity changes, while replay still retries deprecated
  tier-mirror convergence. Subscription/invoice events cannot
  activate an unleased subscription because those paths resolve only the
  account's already-bound subscription id.
- The Checkout rule above is deliberately narrower than lifecycle webhook
  variant mismatch. Initial completion lease/Price mismatch is rejected and
  remediated before status projection because allowing status would bind a
  Copilot-priced subscription to an Autopilot snapshot. After authoritative
  binding, `subscription.updated` variant mismatch follows §6.2: status-only
  through the single applier, with no tier/snapshot/variant repair.
- `allow_promotion_codes` is disabled. No other Checkout flow may re-enable it.
- `assertTierPurchasable` runs at every authoritative new tier selection or
  mutation entry point: onboarding select-plan, dashboard tier change, admin
  provisioning, and direct/stale Checkout creation. Server rejection is
  authoritative; disabled client controls are explanatory only.
- A durable Checkout attempt authorized/frozen before a gate closes may recover its creating/open
  provider Session and complete without re-reading the live gate. Runtime tier and
  safety gates still prevent auto-posting. If an Autopilot subscription activates
  while `autopilotPurchasable()` is false, the webhook emits an ops/Sentry signal
  for a deliberate downgrade/refund decision; it does not mutate the immutable
  variant. Gate closure alone does not revoke an already-open authoritative
  Session; lease expiry is used for owner plan reselection and failed-bind
  compensation.

## 4. Purchasability and policy-editing entitlement

### 4.1 One composed purchasability predicate

```ts
autopilotPurchasable()
  = AUTOPILOT_PURCHASABLE && autoApprovalRuntimeEnabled()
```

`AUTOPILOT_PURCHASABLE` is a server-only exact boolean, false/unset by default.
`AUTO_APPROVAL_ENABLED` remains WS4's live runtime kill switch. The four flag
combinations are tested. Server config and worker startup validation reject any
configured value other than exact `true`/`false`. No `NEXT_PUBLIC_*` companion
exists.

The deploy-time authorization may be enabled only after the already-satisfied
launch checklist is documented: WS4/074 live, WS6/076 live with Judge/Governor,
WS7 eval CI green, and Zernio cadence limits recorded. The predicate itself does
not query CI, migrations, or provider documentation.

### 4.2 GET readiness contract

`getAutoApprovalSettings` remains server-owned and account-scoped. Its readiness
load adds the canonical account tier while continuing to derive subscription
access through `subscriptionGrantsFullAccess`/the existing writable-subscription
seam. It never compares status to `'active'` directly.

The response adds one stable block reason, `autopilot_unavailable`, whenever the
account is not both entitled as Autopilot and allowed by the composed
purchasability predicate. Existing reasons retain their own diagnostic detail;
for example, a runtime disable may return both `auto_approval_disabled` and
`autopilot_unavailable`. This single WS8 reason avoids exposing raw flag state or
creating separate client policy for entitlement versus rollout readiness.

Existing reasons, including `subscription_not_writable`, `policy_suspended`,
preview, moderation, and impersonation, remain. The browser receives only these
server decisions; it never reads flags or `auto_approval_policies` directly.

### 4.3 Expansion/contraction classification

WS4's asymmetry remains: **every expansion** needs standard confirmation and a
fully ready Autopilot account; **contractions remain allowed** while a gate is off,
the account is Copilot/ineligible, or the policy is suspended. Impersonation stays
mutation-blocked as WS4 already requires.

Classification compares the effective before/after policy, including inheritance:

- lowering the minimum star threshold / widening the rating band is expansion;
- raising it is contraction;
- turning a manual scope on is expansion; disabling it, setting manual, or
  narrowing it is contraction;
- shortening the veto window (30 → 15) is expansion; lengthening it is
  contraction;
- raising the daily cap is expansion;
- removing a stored cap (`cap: null`, restoring the platform default) is treated
  as expansion, per the locked WS8 resolution;
- lowering the cap is contraction;
- a location override create/delete/clear is classified from its effective
  before/after result, not merely the operation name; any broader inherited
  result is expansion;
- exact no-op writes are neither expansion nor contraction and remain auditable.

The mutation classifier becomes the single owner for threshold, veto-window, and
cap exposure. All reject gates run before writes. Audit payloads record the
before/after effective threshold, veto window, cap, exposure classification,
required confirmation, and readiness used for the decision.

WS4 §6 remains binding: suspended rows are never deleted by a clear; clears
degrade to threshold-NULL and preserve suspension/dials. New override rows seed
non-target dials from the stored account default. Invalid cap drafts never PATCH.

## 5. Runtime Autopilot entitlement

### 5.1 Grant-time gate

The early generation context may carry tier for display/diagnostics, but it is not
authoritative after the LLM call. Inside `persistResponseAndNotify`'s approval
transaction, the grant path locks review then business, acquires the account's
`:tier_entitlement` transaction advisory lock **before the first response/child
statement that can take an implicit account FK lock**, and then re-reads
`accounts.subscription_tier` with the other current state. The lock is held
through the approval/audit/outbox commit. The candidate matrix adds a hard
current `subscription_tier === 'autopilot'` prerequisite, represented by a stable
blocked-decision reason. A Copilot account cannot receive
`approval_method='auto_policy'` even if a policy row survives, all other gates
pass, and global flags are on.

All existing WS2/WS4 gates remain the non-negotiable hard floor. Moderation and
negative-review vetoes remain absolute. Subscription access continues through
the canonical publisher subscription check, which includes trialing and valid
past-due grace rather than a raw status equality.

### 5.2 Publish-time recheck and downgrade

`loadPublishResponseContext` loads `accounts.subscription_tier` only as an early
hint. The authoritative auto-policy publish path begins its outcome transaction in
the binding review → business → response order, acquires the same
`:tier_entitlement` transaction advisory lock, then re-reads tier and status. It
holds that lock through target resolution, the bounded external publish call, and
the posted-or-downgraded database outcome. Tier mutation paths acquire the same
lock before account/billing locks, so either the publish outcome linearizes first
or the publisher observes the committed downgrade and returns the row to owner
review. Immediately before external resolution/posting it rechecks:

1. current subscription remains publisher-eligible;
2. current tier is Autopilot;
3. existing runtime, notice-window, judge-health, location/connection, and review
   state gates continue to pass.

If the tier is no longer Autopilot, the queued row is downgraded to owner review,
not posted. The generalized WS4 downgrade helper gains a dedicated entitlement
reason/marker and records it in `posting_error` plus `approval_audit_log` metadata,
then enqueues the owner notification in the same transaction.

The downgrade must preserve WS4/WS6's binding lane order:

```text
reviews anchor → businesses → responses → outbox CAS/audit/outbox writes
```

Implicit foreign-key locks count. No account lock may be introduced after an
implicit account FK lock in a way that creates a share→exclusive upgrade. The
helper retains attempt-CAS idempotency and no-op behavior for stale replays.

The entitlement lock is transaction-scoped (safe through transaction-pooled
Supavisor), never session-scoped. Holding the publisher transaction across the
external call is a deliberate bounded exception using the shared provider timeout;
the mark-posted and downgrade helpers must accept the existing transaction rather
than opening a nested one. Tier writers never acquire review-lane locks, so the
fixed orders cannot form a reverse edge.

An Autopilot→Copilot tier change during the veto window therefore cannot post.
Owner-approved Copilot publishing never consults the auto-policy-only judge or
entitlement gate.

## 6. Tier changes, stored billing math, and webhook truth

### 6.1 Preview and execute use one calculation

`validateTierChange` loads the current `price_variant`, status, and active-location
count. It uses the canonical target snapshot to return:

- target base cents for the account's variant;
- included locations (`1`);
- target overage cents;
- `overageUnits = max(activeLocations - 1, 0)`;
- total monthly cents.

The dead Basic-only multi-location rejection is removed. Both new tiers allow
multi-location overage.

`applyTierChange` resolves the target base and overage Prices with the same tier
and immutable variant. Stripe mutation remains idempotency-keyed and uses
`proration_behavior: 'create_prorations'`. The DB/audit snapshot is persisted only
after the Stripe changes succeed, and writes the complete target snapshot. Trial
tier changes retain Stripe's existing trial-safe proration behavior.

Two account-scoped transaction advisory locks have one shared helper and fixed
order:

1. `hashtext(accountId + ':tier_entitlement')` serializes every existing-account
   tier mutation with auto-policy grant/publish;
2. `hashtext(accountId + ':overage_sync')` serializes tier change,
   subscription-updated, and overage synchronization.

Tier-changing billing paths acquire entitlement then billing, resolve the account
ID without a row lock, and only then freshly re-read/lock/revalidate account and
location state. Existing-account plan selection/activation then acquires its
legacy `:activation` lock after both shared locks and before the account row. The
overage-only worker needs only the billing lock. Approval-lane
grant path takes review/business, then entitlement before any account-FK child
write; the publisher takes review/business/response, then entitlement. Tier
writers never take review locks. No actor may hold the account row lock while
waiting for either advisory lock. Tier change's bounded lock across Stripe calls
uses the shared client timeout and stable idempotency keys; concurrency tests pin
both orders.

Founding preview and execute must agree exactly. Autopilot→Copilot mid-cycle uses
Copilot pricing for the same immutable variant and triggers the publish-time
entitlement protection in §5 independently of Stripe proration timing.

### 6.2 Subscription-updated webhook

`worker/ingress/stripe/subscription-updated.ts` remains idempotent and keeps its
advisory/account serialization. Reverse base-Price lookup returns
`{ tier, variant }`.

Status ownership is absolute: every allowed subscription-status transition goes
through `worker/ingress/stripe/apply-subscription-state.ts`. This handler never
raw-writes account subscription status. Trial conversion remains independent of
whether tier/variant resolution succeeds.

Canonical status paths resolve account identity without a row lock, retrieve
provider-current subscription state before the account row lock where required,
then acquire entitlement before the account row. The under-entitlement applier
is passed that exact locked account id and rechecks provider lineage on its
locked row; it never follows a changed lineage to another account. Each actual status transition
atomically enqueues `stripe_subscription_mirror_sync` with its canonical account
write and follow-up facts. A resolved no-op `subscription.updated` replay also
enqueues exactly one mirror job to repair a stale deprecated mirror without a
second status mutation. The mirror worker locks every business for the account
in `ORDER BY id`, then entitlement, reads canonical account state without an
account row lock, updates the deprecated status/activation mirror, and completes
the originating outbox entry in the same transaction. No canonical status path
updates the businesses status mirror synchronously.

After resolving account ID without a row lock, the webhook acquires entitlement
then billing advisory locks. Before locking/updating the account row it retrieves
the current Stripe subscription through `getStripe()` and uses that provider-
current object, not the possibly stale webhook item snapshot, for status, base
Price, variant, and overage quantity. It then locks and revalidates the local
account/subscription identity. A transient retrieval failure retries without a
partial status write. After that:

- **mapped tier + matching stored variant:** apply tier/`locations_paid` changes
  and, when the tier changes, write the complete target snapshot resolved with
  the stored variant; keep the businesses mirror synchronized;
- **mapped Price whose variant differs from `accounts.price_variant`:** preserve
  the immutable account variant, skip all tier/snapshot/`locations_paid` and
  businesses-mirror mutation, emit a scrubbed structured warning and Sentry alert,
  and allow only the status transition owned by `apply-subscription-state`;
- **unmapped base Price:** preserve the existing fail-safe status-only behavior;
  do not guess a tier or price, and emit a scrubbed operational alert after the
  committed status transition;
- **Autopilot activates while not purchasable:** additionally emit the ops signal
  from §3.3. It is observability, not an unsafe entitlement bypass.

Webhook retries produce no duplicate audit facts and no cumulative math. Audits
are written only for real tier or paid-location changes.

### 6.3 Overage and snapshots

`locations_paid` is the Stripe-confirmed overage quantity, not total locations.
All calculations use `max(activeLocations - locations_included, 0)`. The account's
stored overage cents remain read authority. Overage item discovery retains its
billing-role marker and stored-cents compatibility; new item creation/update uses
the new tier's overage Price.

Pending-payment account creation/plan selection stores `locations_paid=0` because
no Stripe quantity is confirmed yet. It may calculate a provisional Checkout
line-item quantity without storing it as confirmed. Plan activation, a successful
tier-change mutation, and the provider-current subscription webhook are the only
paths that promote a trusted Stripe quantity into the complete account snapshot.

## 7. Migrations 077 and 078

Read `.claude/reference/migrations-log.md` immediately before implementation;
head is currently 076. Both migrations are transactional, re-runnable, tested by
double-apply, applied staging first and production second, and added to the
migration inventory in the same change.

### 7.1 Hard preflight and quiescence

Before 077 on each environment:

1. quiesce self-serve/admin account creation, tier mutations, Checkout creation,
   and Stripe ingress;
2. independently paginate all Stripe subscriptions in the environment with
   provider status authoritative, reconcile them to local references, and block
   every status except the explicit terminal allowlist `canceled` and
   `incomplete_expired`. Thus `incomplete`, `trialing`, `active`, `past_due`,
   `paused`, and `unpaid` all block, regardless of whether the Price is legacy/new
   or the subscription ID is already projected into an account row;
3. stop if any exists and cancel it before proceeding. WS8 has zero financially
   live accounts and contains no live-subscription compatibility/mapping path;
   any future exception requires a separately approved cutover design;
4. independently paginate open Checkout Sessions, inspect their line items, and
   expire/invalidate every Session containing a legacy Price even when its local
   account projection is absent;
5. verify the blocker is zero again.

This is a hard launch blocker. There is no deferred legacy tier, compatibility
reader, or live-traffic alternative.

### 7.2 Migration 077 — expand and normalize

077 uses direct, reviewed SQL constants. It does **not** invoke TypeScript, enqueue
Stripe overage reconciliation, or insert `job_outbox` work.

It:

- adds `accounts.price_variant`, its value CHECK, and column-scoped immutable
  update trigger;
- changes defaults:
  - `accounts.subscription_tier` → `'copilot'`;
  - `accounts.base_price_cents` → `2900`;
  - `accounts.locations_overage_price_cents` → `1500`;
  - `accounts.locations_included` → `1`;
  - `businesses.subscription_tier` → `'copilot'`;
- captures whether `accounts.price_variant` existed **before** expansion. Only on
  the first apply, it normalizes every then-existing account unconditionally to
  the complete Copilot/list launch snapshot in one SQL statement. Before strict
  code deploys there is no legitimate Autopilot/founding account to preserve, and
  the hard preflight has proved there is no nonterminal Stripe quantity to mirror:
  - `price_variant='list'`;
  - `subscription_tier='copilot'`;
  - `base_price_cents=2900`;
  - `locations_overage_price_cents=1500`;
  - `locations_included=1`;
  - `locations_paid=0`;
- on that same first apply, normalizes every businesses mirror to `'copilot'`;
- leaves old and new tier values unconstrained during the short code transition;
- adds no strict new-tier CHECK yet.

No location count is computed and no asynchronous reconciliation is enqueued:
`locations_paid` is the Stripe-confirmed overage quantity, and the blocker proves
there is no live quantity to preserve. A later subscription activation/tier
writer recomputes its complete runtime snapshot before billing begins.
Reapplying 077 after the marker column exists performs only idempotent schema/
default/trigger repair; it never rewrites account data. A founding Autopilot row
created after first apply must survive the second apply byte-for-byte.

### 7.3 Strict code deploy

After 077, verify every account and business mirror is a valid new tier and every
account snapshot is complete. Only then deploy code whose `isSubscriptionTier`
recognizes exactly Copilot/Autopilot. Smoke before 078.

### 7.4 Migration 078 — contract

078 begins with NULL-safe aborting preflights:

```sql
subscription_tier IS NULL
OR subscription_tier NOT IN ('copilot', 'autopilot')
```

Zero rows is required in both tables. It then:

- adds the strict accounts tier CHECK (accounts is already NOT NULL);
- makes the deprecated businesses mirror NOT NULL and adds its hygiene CHECK;
- preserves the businesses column as write-only compatibility; account tier
  remains the sole read authority.

The old-tier CI literal ban becomes required with the strict deploy/contract and
prevents future string-typed regressions.

## 8. Environment and deployment sequence

Order is load-bearing because both old and new binaries assert their own Price
sets:

1. Create and parity-check the six Prices in staging Stripe, then production
   Stripe.
2. Set the six new Price env vars, `FOUNDING_DEADLINE`, and both required
   Copilot/Autopilot daily cost-limit values in Railway and Vercel while retaining
   all seven legacy Price vars.
3. Keep `AUTOPILOT_PURCHASABLE=false` during migration/deploy.
4. Quiesce staging, satisfy §7.1 (including the provider-wide subscription
   enumeration after quiescence), apply 077, and verify schema/data by direct
   introspection (not the Supabase migration ledger). Traffic remains quiesced
   until strict code is live.
5. Deploy strict code to staging, resume the new writers/ingress, then explicitly
   enable the staging Autopilot gate for the gate-open cases below (the required
   WS4/WS6 flags are already on in staging).
6. Smoke Copilot and Autopilot list/founding checkout, explicit trial selection,
   tier-change preview/execute, overage mutation, subscription-updated, settings
   expansion gating, grant-time denial, and publish-time downgrade.
7. Apply 078 to staging and repeat strict preflight/introspection.
8. Repeat quiesce → blocker/session cleanup → 077 → deploy → smoke → 078 in
   production.
9. In production, flip `AUTOPILOT_PURCHASABLE=true` only after 078 and the
   operational prerequisites/live safety flags are intentionally satisfied.
   Because the predicate composes `AUTO_APPROVAL_ENABLED`, an emergency runtime
   disable immediately stops new sales and policy expansions.
10. Remove legacy Price vars only after the rollback window closes. Never remove
    the six new list/founding/overage IDs from the application map while any
    subscription can reference them.

Rollback before 078 is roll-forward preferred: restore quiescence, fix/normalize,
and redeploy. After 078, old binaries are incompatible with the strict data model;
do not roll back code without first restoring a compatibility schema deliberately.

## 9. Legacy-tier removal and affected seams

Removing the old union provides one mechanical backstop. Extend
`ci:static-policy` with the second: reject old tier literals
`basic|standard|premium|founders|founding` in tier context outside historical
migrations and explicitly history-pinned tests. The guard must distinguish the
valid price-variant literal `'founding'` from a tier literal. Any allowlist change
lands in the same commit as the guarded code and is narrowly justified.

At minimum, implementation covers:

| Area | Required change |
|---|---|
| Tier owner | `tier-config.ts`: two-tier union, per-variant base cents, no fallback |
| Price owner/config | `price-tier-map.ts`, `stripe-shape.ts`, server config, startup/instrumentation assertions, `.env.example` |
| Signup/admin | `create-business.ts`, admin schema/form/component/API and `AdminBusinessTxInput`; immutable variant + complete snapshot |
| Checkout/trial | both Checkout entry points, `create-checkout-session.ts`, plan options/picker; explicit tier, variant-aware Prices, no promos |
| Tier change | preview, Stripe execute, DB/audit snapshot, route, BillingPanel; variant-correct proration |
| Stripe webhook | reverse map, status applier seam, mismatch fail-safe, complete snapshot, businesses mirror |
| Overage | `overage-item.ts`, `UpdateStripeOverageWorker`, overage sync/reconcile and tests |
| Autonomy settings | readiness types/builder, `settings.ts` unified classifier, route/client copy |
| Autonomy runtime | generation context/candidate and publisher context/downgrade reason |
| Former Premium gates | `edit-existing.ts`, past-replies loader, `ZernioBackfillWorker`: both paid tiers |
| Cost limits | worker tracker and admin cost report: required operator-supplied Copilot/Autopilot env values, no defaults or legacy-tier mapping |
| DTO/schema tail | shared schemas, response/tier DTOs, fixtures, analytics/admin serializers |
| Dead Basic logic | remove `basic_requires_single_location` and the Basic-only quota rejection path |
| Stripe preflight | parity script iterates all six `(tier, variant, kind)` cases |
| Docs/audits | env-vars reference, migration log, tier validation contracts, static-policy tests |

Typecheck must close the enum-typed tail; the CI literal ban closes string-typed
comparisons and schema literals. A clean manual grep is evidence, not the guarantee.

## 10. Pricing, picker, and billing UI

The public pricing page follows the RepWorth Island system and the
`repworth-brand-design` skill. Authenticated BillingPanel follows the Warm Editorial
Console, not the Island palette.

### 10.1 Public pricing page

- Replace four legacy cards with two: Copilot and Autopilot.
- Remove the annual toggle, 20%-off copy, annual FAQ, annual derivation helper, and
  annual E2E assumptions.
- Show exact monthly base and extra-location prices. Until the founding deadline,
  server-provided page data may truthfully present the founding rate as locked for
  the account's life, with list price as context; at/after the deadline or on
  invalid config, show list pricing only.
- Autopilot remains visible as the product distinction. When not purchasable, its
  CTA is disabled with honest readiness copy; the server route still rejects it.
- Both cards describe the same real agent team: Reply writes, Guardian holds and
  escalates negative/flagged reviews, Insights files the weekly brief.
- The differentiator is precise: Copilot requires owner approval for every public
  action; Autopilot may post only 4–5★ unflagged replies inside policy after the
  veto window and safety gates. Negative reviews are never auto-posted on either
  tier.
- Remove stale claims: 14-day/no-card trial, implicit auto-approval, fake annual
  contract terms, “95% automation,” or any unsupported ROI guarantee. Trial copy
  is 30-day card-up-front and explicit-plan-selection when `TRIAL_ENABLED` is on.
- Do not invent testimonials, customer counts, savings, logos, or autonomy claims.
- Preserve the Island wrapper, existing font stack, token-only colors, accessible
  contrast/focus, inline SVGs, truthful headings, and responsive two-card/matrix
  behavior. No raw color literals, generic AI gradients, icon libraries, or root
  `overflow-hidden`.
- The comparison table has exactly two plan columns and remains keyboard-scrollable
  where horizontal scrolling is needed. CTA/disabled states have accessible names
  and explanations.

### 10.2 Onboarding picker and BillingPanel

The pay page is server-driven:

```ts
{
  purchasable: { copilot: true, autopilot: boolean },
  prices: { copilot: accountVariantPrice, autopilot: accountVariantPrice },
  priceVariant,
  trialEnabled
}
```

It builds no tier config at module load. No tier is preselected. Disabled Autopilot
cannot be submitted through a stale client.

BillingPanel displays the account's stored current base/overage cents and variant.
Target-tier preview comes from `validateTierChange`; a founding account never sees
list cents in the confirmation modal. Both target options respect purchasability,
proration copy is accurate, and mid-trial changes retain the existing trial-safe
explanation.

## 11. Failure semantics and observability

| Failure | Required behavior |
|---|---|
| Deadline missing/malformed | Assign list, emit operational error/Sentry; no crash or founding grant |
| Autopilot flag/runtime off | No new Autopilot selection; no policy expansion; contractions still allowed; existing queued auto-policy caught by existing runtime backstop |
| Copilot policy row survives | Grant-time tier gate denies auto-policy; owner-review lane continues |
| Tier lost during veto window | Publisher downgrades atomically to owner review and re-notifies; no external post |
| Variant mismatch in Stripe webhook | Preserve account variant; status-applier only; no tier/snapshot/paid-location/mirror write; alert Sentry |
| Unmapped Stripe base Price | Status-applier path remains independent; skip tier/snapshot mutation; alert/log for operations |
| Provider-current subscription retrieval fails | Retry before any status/snapshot write; never apply a stale event snapshot |
| Stripe mutation fails during tier change | No DB snapshot/audit success; bounded/idempotent retry posture retained; error is visible |
| Migration preflight finds any nonterminal sub | Stop launch; cancel it, then rerun to a zero blocker |
| 078 finds NULL/legacy tier | Abort before adding CHECK |
| Static-policy finds old tier literal | CI fails; no broad allowlist |
| Copilot/Autopilot cost-limit config missing/malformed | Owning worker/server config gate fails before serving the affected path; never use a Standard fallback |

Logs and Sentry metadata may include account/subscription/Price identifiers needed
for diagnosis, but never secrets, tokens, raw review text, or raw response text.

## 12. Acceptance criteria

WS8 is complete only when all are true:

1. Only Copilot/Autopilot are accepted by runtime types, API schemas, DB CHECKs,
   fixtures, and UI.
2. Exact locked prices and one included location are encoded; monthly-only UI and
   Checkout contain no annual or promotion-code path.
3. `price_variant` is assigned once, enforced immutable by DB, and survives every
   tier/status/webhook transition.
4. `FOUNDING_DEADLINE=2027-01-01T00:00:00Z`; strict `now() < deadline` behavior is
   fail-closed and observable.
5. Every signup, preview, execute, and matching webhook tier write resolves cents
   from `(tier, stored variant)` and persists the complete snapshot.
6. Every billing read continues to use stored cents; changing config cannot reprice
   an existing account.
7. All six Stripe Prices are shape-verified and indefinitely resolvable; reverse
   base mapping returns tier + variant.
8. Trial tier is explicit and limited to available tiers; trialing is granted full
   access by the canonical helper. Direct Checkout cannot infer provisional
   Copilot, and pending-payment `locations_paid` remains zero until provider
   confirmation.
9. `autopilotPurchasable` composes both flags, gates every authoritative tier
   writer and settings expansion, and is represented in GET readiness.
10. The settings classifier treats threshold widening, veto shortening, cap
    raising/removal, and effective inherited widening as expansions; inverse and
    disable operations remain contractions.
11. Copilot never receives auto-policy approval. Autopilot→Copilot before publish
    atomically downgrades to owner review under the binding lock/advisory order;
    grant uses same-transaction current tier and publish is linearized against
    every existing-account tier mutation.
12. Webhook variant mismatch cannot mutate tier, snapshot, `locations_paid`, mirror,
    or variant; status remains owned solely by `apply-subscription-state`, and
    reverse event delivery converges from a provider-current subscription fetch.
13. 077 normalizes every account only on first apply with direct SQL constants,
    writes every snapshot column including `locations_paid=0`, creates no
    outbox/reconcile enqueue, and preserves post-first-apply founding/Autopilot
    rows on reapply; 078 rejects all
    residual NULL/legacy values before contracting.
14. The hard legacy-subscription/session preflight is zero before strict code in
    both environments.
15. Typecheck plus static-policy mechanically prove old-tier removal.
16. Public pricing and authenticated billing surfaces show truthful, variant-correct
    prices and the PR #463 agent-team/autonomy distinction.
17. Copilot/Autopilot cost limits are explicit required configuration with no
    legacy-tier fallback or invented default amount.

## 13. Test and verification contract

### 13.1 Unit and component tests

- tier guard/config exact values; unknown tier/variant has no fallback;
- all six forward/reverse Price cases, empty/duplicate env defenses, Price sets;
- deadline: before, exact boundary, after, leap/impossible dates, offset, date-only,
  empty/unset/malformed, and Sentry/log fail-closed behavior;
- complete snapshot resolver for both tiers × both variants × active location
  counts 0/1/2/5;
- stored billing snapshot mutation test: alter registry cents and prove reads keep
  stored values;
- four Autopilot flag combinations and every authoritative writer rejection;
- explicit picker selection, no default, trial on/off, Autopilot unavailable;
- direct Checkout request without a tier creates no Session even when the stored
  provisional snapshot is Copilot;
- settings matrix across threshold, veto 15/30, cap lower/higher/null, inheritance,
  rowless override seeding, suspension, Copilot, ineligible status, and flags;
- GET readiness reason matrix and contraction-allowed behavior;
- grant candidate: Copilot + policy + all gates otherwise passing is denied;
- publisher context/tier gate and dedicated downgrade reason;
- pricing page: two cards, monthly-only, truthful founding/list/closed-gate copy,
  accessibility, no legacy tier or stale trial/annual claims;
- BillingPanel: stored current cents and founding preview/execute display parity.

### 13.2 Billing/webhook tests

- list and founding Checkout select exact base/overage IDs; promotions disabled;
- founding Copilot↔Autopilot preview and execute preserve variant and cents;
- list equivalents and active-location overage math;
- Stripe proration parameters and idempotency keys on upgrade/downgrade;
- tier downgrade mid-cycle with a pending auto-policy response downgrades at publish;
- reverse-delivered base/overage subscription events converge to the provider-
  current subscription, including an orphaned/stale event payload;
- webhook mapped tier/variant, same-tier paid-location update, tier transition,
  replay idempotency, unmapped Price, mismatched variant, out-of-order account, stale
  subscription, active offboarding subscription, and trial conversion;
- mismatch mutation spot-check: temporarily remove the guard and prove the test
  fails because tier/snapshot/mirror writes occur;
- ops signal when a late Autopilot Checkout activates while the gate is closed;
- former Premium features accept both paid tiers and no unknown-tier fallback exists
  in worker/admin cost limits.

### 13.3 Migration/live-DB tests

Against the local test database with migrations through 076:

- 077 double-apply and 078 double-apply;
- defaults, checks, and `price_variant` update rejection while unrelated updates
  succeed;
- a legacy Premium row with five included locations and multiple active/archived
  locations normalizes to Copilot/list with `included=1` and `locations_paid=0`;
- a founding Autopilot row inserted after 077 first apply survives 077 reapply
  byte-for-byte;
- the 077 normalized tier/base/overage/included tuple equals
  `resolveTierSnapshot('copilot', 'list')`, with `locations_paid=0` asserted as
  the deliberate no-live-subscription exception;
- Standard/Basic/Founders/NULL rows normalize completely in accounts and businesses;
- no 077 `job_outbox` or reconciliation rows are created;
- 078 NULL-safe preflight aborts on one NULL and each legacy tier, then succeeds
  only after normalization;
- database rejects new old-tier and mutable-variant writes;
- current billing snapshot uses stored cents after migration.

### 13.4 Concurrency and test honesty

- publish entitlement downgrade races mark-posted/veto using the existing
  reviews→businesses→responses law; the loser returns the established retry/no-op
  outcome without deadlock or double notification;
- tier mutation versus grant/publish is tested in both advisory-acquisition orders:
  mutation-first denies/downgrades with no external call; publish-first completes
  and marks the bounded in-flight post before the tier mutation commits;
- a live grant test reproduces the WS6 implicit-FK pattern and proves entitlement
  is acquired after review/business but before the first account-FK child write;
- tier change, subscription-updated, and overage synchronization are tested in
  reverse/interleaved order under the shared entitlement/billing protocols;
- source-shape and runtime call-order tests pin the lock order where appropriate;
- mocked-SQL tests assert expected call counts and terminal queues. A drained queue
  returning `[]` must not make an early-return test vacuously pass;
- mutation spot-checks remove or invert the grant tier gate, publish early return,
  variant mismatch guard, stored-snapshot read, and expansion classifier; each
  relevant test must fail.

### 13.5 Required gates

- narrow affected Vitest suites first;
- `pnpm lint`;
- `pnpm typecheck`;
- the sequential full suite exactly as instructed by the execution plan:
  `TEST_DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 DATABASE_POOL_URL=postgresql://test:test@localhost:5499/test_ws4 pnpm vitest run --no-file-parallelism`;
- every direct `ci:*` audit, including tenant scope (baseline 391), the old-tier
  static-policy guard, and `ci:fallow`; then a fresh DB-less `pnpm test:coverage`
  followed by `ci:fallow:coverage` to mirror its dedicated workflow;
- `pnpm eval:llm` (no prompt behavior is intended to change);
- `pnpm build` because application behavior and public UI change;
- focused browser/E2E smoke for pricing, picker, BillingPanel, and settings.

No test may point at a Supabase URL. Same-commit allowlist/baseline changes require
a narrow rationale and a test proving the guard still catches an unallowlisted
violation.

## 14. Documentation and launch evidence

The implementation updates, in the same branch:

- `.claude/reference/migrations-log.md` for 077/078 and head/next;
- `.claude/reference/env-vars.md` for the new tier registry, six Price vars,
  `FOUNDING_DEADLINE`, `AUTOPILOT_PURCHASABLE`, exact rollout, and stored-snapshot
  law;
- `.env.example`, Stripe parity/runbook material, and any validation-contract
  inventory that names old tiers;
- project progress/current docs through the normal post-feature documentation
  sweep.

Launch evidence records, for staging then production: all-six Price parity output,
legacy-subscription/session preflight zero, 077 introspection/data counts, strict
code smoke, 078 preflight/introspection, Autopilot flag state, and the exact time
the founding deadline configuration was verified.
