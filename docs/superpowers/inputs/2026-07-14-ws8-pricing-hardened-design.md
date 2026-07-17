# Plan: WS8 Pricing — Copilot / Autopilot tier replacement + founding window
_Locked via grill — by Claude + Norbert (2026-07-14). Rev 13 after Codex Rounds 1–12._

## Goal
Replace RepWorth's four legacy tiers (basic/standard/premium/founders) with two autonomy-gated
tiers — **Copilot** (AI drafts, owner approves) and **Autopilot** (AI drafts + auto-posts within
owner policy) — priced from validated research, shipping billing/packaging so WS8 is unblocked.
**Zero paying accounts** → replace outright: no data migration, no grandfathering. Autonomy
*enforcement* is WS4; WS8 makes the tiers exist as billing SKUs + entitlement WS4 consumes.

## Locked pricing

| Tier | List (monthly) | Founding (window-open) | Per-location overage |
|---|---|---|---|
| **Copilot** | $29 | $19 | +$15/loc |
| **Autopilot** | $69 | $49 | +$20/loc |

- **Monthly-only at launch.** No annual selector until interval-aware Prices + snapshots ship.
- **Trial:** existing 30-day card-up-front. Pay page shows both tiers; user **explicitly selects**;
  Autopilot disabled when its gate is closed. No implicit "highest tier" default.
- **Autopilot purchasability gated** on the autonomy go-live condition (below).
- **Founding rate honored for life** via an **immutable per-account price variant**. Window is a
  **server-side deadline** (race-free), not a live account count.

## Core mechanism: immutable per-account price variant (WRITE-time) + stored snapshot (READ-time)
The distinction is load-bearing — get it wrong and you either strip founder rates or reintroduce
price drift.

- Add `accounts.price_variant TEXT NOT NULL DEFAULT 'list'`, CHECK `IN ('list','founding')`,
  **stamped once at account creation, never mutated** (a tier *change* keeps the variant).
  Enforce immutability with a **`BEFORE UPDATE OF price_variant` trigger that raises** (CHECK only
  constrains the value set, not mutation) — with migration tests proving an UPDATE is rejected.
- **WRITE time** (signup, tier-change): resolve the Stripe Price ID **and** the cents to store
  from `(tier, variant)`, then persist `base_price_cents` + `locations_overage_price_cents` on the
  account. Variant + `TIER_CONFIG` are consulted **only here**. This covers ALL THREE tier-change
  paths: the **`validateTierChange()` server-side PREVIEW** (`tier-change.ts:107` — currently
  builds from `TIER_CONFIG[tier].baseCents`, so a founder would see LIST pricing in the
  downgrade/upgrade modal), the Stripe mutation, and the DB/audit snapshot. Also the
  `subscription-updated` webhook snapshot. Add founder upgrade/downgrade **preview** tests
  alongside the execute tests.
- **READ time**: `currentBillingSnapshot` **keeps reading the STORED `base_price_cents` /
  `locations_overage_price_cents` as the sole authority** (migration-054 point-in-time — UNCHANGED).
  It must NOT re-derive cents from `(tier, variant)` config, or list-price changes would drift
  existing accounts. Variant governs which price is *written*, never how a snapshot is *read*.
- `price-tier-map.ts` → `priceIdFor(tier, variant, 'base'|'overage')`; **retains every Price ID
  (list AND founding) indefinitely**; reverse map returns `{ tier, variant }`. Founding Prices are
  never removed — active founder subs must stay tier-changeable.
- **Founding-for-life spans tier changes**: founding Copilot → Autopilot yields **founding
  Autopilot ($49)** (variant immutable, both tiers have a founding Price). *Confirm at sign-off.*

## Approach (concrete steps)

1. **Enum + config** (`tier-config.ts`): `SubscriptionTier` → `copilot/autopilot`. `TIER_CONFIG`
   gains per-variant cents: copilot `{ list:2900, founding:1900, included:1, overageCents:1500,
   multiLocAllowed:true }`, autopilot `{ list:6900, founding:4900, included:1, overageCents:2000,
   multiLocAllowed:true }`. Overage has no variant (single overage Price per tier).
2. **Variant-aware price map** (`price-tier-map.ts`): `priceIdFor(tier, variant, kind)`; reverse
   `basePriceInfoForId(id) → { tier, variant } | null`, retained forever. Env vars →
   `STRIPE_PRICE_COPILOT_LIST|COPILOT_FOUNDING|AUTOPILOT_LIST|AUTOPILOT_FOUNDING|COPILOT_OVERAGE|
   AUTOPILOT_OVERAGE`. **Update every reverse-map consumer** to `{tier,variant}`:
   `worker/ingress/stripe/subscription-updated.ts:40,43`,
   `src/lib/payments/overage-item.ts:187`, and **`worker/jobs/billing/UpdateStripeOverageWorker.ts:25`**
   (calls the old `overagePriceIdForTier` directly — load `price_variant` with the account and
   resolve its overage ID via the new map, or post-checkout location-overage updates break) —
   with founder/list resolution tests.
3. **Stripe config shape + assertions** (same change): rewrite `src/lib/config/stripe-shape.ts`
   `StripeEnvConfig` (7 obsolete fields → new 6) + `narrowStripeConfig`; update `.env.example`,
   `worker/config/startup-assert.ts`, the Next.js instrumentation soft-assert, and all their
   tests. `STRIPE_PRICE_ENV_VARS` is the single owner; everything derives from it.
4. **Founding-window predicate** (`src/lib/payments/founding-window.ts`, server-only):
   `isFoundingWindowOpen()` = `now() < FOUNDING_DEADLINE`. Add `FOUNDING_DEADLINE` to the
   server-only config (`src/lib/config/server.ts`) with a **strict UTC timestamp parser**;
   **fail closed** — unset/malformed ⇒ window CLOSED (variant='list') + an operational error
   log/Sentry. Account creation stamps `price_variant='founding'` iff open at creation; late
   webhooks never retroactively change it.
5. **Autopilot purchasability** — `autopilotPurchasable() = AUTOPILOT_PURCHASABLE &&
   autoApprovalRuntimeEnabled()`. Two composed inputs: `AUTOPILOT_PURCHASABLE` (server-only
   boolean, fail-closed default false) is the **deploy-time launch authorization** ops flips
   ONCE after the prerequisite checklist below; `autoApprovalRuntimeEnabled()` (reads
   `AUTO_APPROVAL_ENABLED`) is the **live safety backstop** — if autonomy is emergency-disabled,
   Autopilot instantly stops being sold, so we never sell Autopilot while delivering Copilot.
   The prerequisite checklist for flipping `AUTOPILOT_PURCHASABLE` (an **ops action**, NOT a
   runtime computation): WS4 trust dial live [migration 074], WS6 judge/governor live [076], WS7
   eval-CI green, Zernio cadence limits documented. Test all four combinations of the two flags.
   `assertTierPurchasable(tier)` wraps the predicate and is invoked in **every** tier writer:
   select-plan, dashboard tier-change, admin-created accounts, direct/stale checkout.
5b. **Tier entitlement enforcement in the autonomy runtime** (the billing↔autonomy seam — without
   it the Autopilot tier is cosmetic and no one would pay for it). The auto-approval candidate
   path and publisher context currently load subscription *status* but not *tier*, so a Copilot
   account with a policy could auto-post once `AUTO_APPROVAL_ENABLED` is on. Two enforcement points:
   - **Grant time** (`worker/jobs/response-generation/auto-approval.ts:302`): make
     `subscription_tier === 'autopilot'` a hard prerequisite for granting
     `approval_method='auto_policy'`. A Copilot account never receives auto-policy approval even
     with a policy row + the global flag on.
   - **Publish time** (`ResponsePublisherWorker` / `worker/jobs/publisher/load-context.ts:56`):
     re-check tier entitlement before posting an auto-policy response; if the account is no longer
     Autopilot (e.g. downgraded during the veto window), **downgrade the queued auto-policy row
     back to owner review instead of posting** — mirroring the existing invariant-#3
     `AUTO_APPROVAL_ENABLED`-off downgrade path. Load `subscription_tier` into both contexts. Test:
     Copilot+policy never auto-posts; Autopilot→Copilot mid-veto downgrades to owner review.
6. **Migrations 077 + 078** — the new strict code's `isSubscriptionTier()` recognizes ONLY
   copilot/autopilot, so it does **not** tolerate legacy rows: any `'standard'` row present when
   strict code deploys fails reads/checkout/reconciliation. Therefore **data normalization must
   precede the strict-code deploy**, not follow it (staging-first both projects; head is 076 —
   re-check the directory before reserving numbers).
   - **DEFAULT PATH (proportionate — prod is pre-launch, zero accounts, no live signup traffic):**
     briefly **quiesce signup + Stripe ingestion**, then **077**: add `accounts.price_variant TEXT
     NOT NULL DEFAULT 'list'` + value CHECK + **BEFORE UPDATE trigger** (that column only); change
     DEFAULTs (`accounts.subscription_tier` `'standard'`→`'copilot'`, `accounts.base_price_cents`
     `7900`→`2900`, `businesses.subscription_tier` `'standard'`→`'copilot'`); **normalize EVERY
     existing row** (`accounts` + `businesses`) whose tier ∉ {copilot,autopilot} by **re-deriving
     the COMPLETE account snapshot through the same canonical signup snapshot-writer** for
     `(copilot, list)` — NOT a hand-picked column UPDATE (that is exactly how `locations_included`
     got missed). The writer owns every snapshot column atomically: `subscription_tier`,
     `base_price_cents` (→2900), `locations_overage_price_cents` (→1500), **`locations_included`
     (→1 — a legacy Premium row's 5 must not survive, or it grants 5 free locations + wrong overage
     math; `quota.ts:65` reads it from the snapshot)**, and **`locations_paid` recomputed from
     active locations** (or enqueue the normal overage reconciliation). Completeness is
     by-construction (same writer as signup), not by enumeration. Add a **legacy-Premium (5-loc)
     normalization test** asserting all snapshot columns land correctly. **Preflight for financially-live subscriptions, not just "paying":** "zero paying"
     ≠ "zero live" — a **`trialing`** account has a real Stripe subscription on a legacy Price that
     WILL charge at trial end (`create-checkout-session.ts:140`), and the webhook reverse map
     (`subscription-updated.ts:40`) must still resolve it. So query for **any nonterminal Stripe
     subscription** (`trialing`/`active`/`past_due`) on a legacy Price. **This is a HARD LAUNCH
     BLOCKER, not a deferral:** every such subscription must be **cancelled or deliberately
     migrated to a new Price BEFORE the strict deploy**. There is NO "defer with legacy tier"
     branch — a row left at `subscription_tier='standard'` is unreadable by strict code AND
     rejected by 078's CHECK, so deferral is self-contradictory. On staging these are disposable
     test subs → cancel. In prod the set is expected empty (zero paying, pre-launch); any genuine
     one is a founder/test trial → resolve it deliberately before launch. Once the blocker
     preflight returns zero, **normalization is unconditional** (every remaining row rewritten,
     tier + snapshot cents, atomically). Also **invalidate any open legacy Checkout Session**.
     Deploy strict code only once the blocker preflight is zero and every row is a valid new tier. **078:** NULL-safe preflight (`subscription_tier IS NULL OR NOT IN
     ('copilot','autopilot')` — bare `NOT IN` skips NULLs) → **abort unless zero** → add CHECK
     `IN ('copilot','autopilot')` on `accounts.subscription_tier` (already `NOT NULL`). For the
     deprecated write-only mirror `businesses.subscription_tier` (WRITTEN by `plan-activation.ts:107`,
     VAL-SCHEMA-037; no reader depends on it — all tier readers use `accounts.subscription_tier`):
     if kept synchronized, make it **`NOT NULL` before/with** its (hygiene) CHECK, since a bare
     `CHECK … IN (…)` accepts NULL.
   - **LIVE-TRAFFIC ALTERNATIVE (if a future environment can't quiesce):** true expand/contract —
     077 normalizes data + keeps BOTH old and new tier values legal + **retains legacy Price IDs
     in the reverse map** for the window (so a late legacy session still resolves); deploy strict
     code; 078 adds the CHECK and drops the legacy-Price reverse entries once no session can
     reference them. Not needed for launch (nothing live), documented so the seam is known.
7. **Old-tier call-site replacement — completeness enforced MECHANICALLY, not by hand-enumeration**
   (an enum-wide swap has a long tail; the named sites below are found-so-far, but the guarantee
   comes from two backstops, because Codex surfaced a new site every round):
   - **Backstop A — typecheck**: `SubscriptionTier` is a union; removing `basic|standard|premium|
     founders` turns every *enum-typed* reference into a compile error. `pnpm typecheck` must be
     clean → all typed references found.
   - **Backstop B — CI literal-ban guard** (extend `ci:static-policy`): fail CI on any
     `'basic'|'standard'|'premium'|'founders'|'founding'` **string literal in tier context**
     anywhere outside historical migrations + history-pinned tests. This is the real net for
     `subscription_tier === 'premium'`-style comparisons where the column is typed `string`, so
     typecheck can NOT catch them (this is exactly how the admin/cost-report/premium-gate sites
     slipped past manual review). CI now answers "are there more?" — not the next reviewer.
   - Named sites to fix (non-exhaustive; the guards above close the tail):
     - Display: `PricingContent.tsx` (4 cards→2), `BillingPanel.tsx:374` (4 options + `.baseCents`
       reads → variant-aware display helper so founders never see list pricing),
       `plan-options.ts`/`PlanPickerClient.tsx`.
     - Admin schemas: `src/lib/shared/schemas.ts:190`; **admin provisioning
       `src/app/admin/businesses/new/schema.ts:23` (accepts only founders|standard, defaults
       founders → would reject every admin-created account)** — migrate the form, component, API
       schema, and `AdminBusinessTxInput` to copilot/autopilot and apply `assertTierPurchasable`.
     - **Three Premium gates → any paid tier** (power features, not autonomy), each tested — all
       read `accounts.subscription_tier === 'premium'`: `edit-existing.ts:133` (`PremiumRequiredError`),
       `past-replies/load-replies.ts:76`, `ZernioBackfillWorker.ts:188`.
     - Cost: `src/lib/costs/tracker.ts:34` AND **admin `src/lib/admin/cost-report-service.ts:76`**
       (both retain the old tier→`DAILY_COST_LIMIT_*` map with a silent Standard fallback) →
       explicit copilot/autopilot cost-limit config, fallback removed.
     - Stripe parity preflight `scripts/verify-stripe-price-parity.ts:17` (calls removed price-map
       APIs, checks one base price/tier) → iterate `(tier, variant, kind)`, verify **all six** new
       Prices before env cutover.
     - DTOs: `src/lib/responses/types.ts:22` + any tier-carrying DTO → canonical new type.
     - `src/lib/onboarding/create-business.ts` hardcoded `'standard'`→`'copilot'`.
8. **Picker view model**: the server pay page passes a validated
   `{ purchasable: {copilot,autopilot}, price: accountVariantPrices }` view model to
   `PlanPickerClient.tsx:12` (which currently builds plans at module load with no server data);
   the select-plan route stays the authoritative rejector.
9. **Checkout**: resolve base+overage Price IDs via `priceIdFor(tier, variant, …)`;
   **disable `allow_promotion_codes`** (coupons would push charge below stored price — verify no
   other flow depends on them first). **Authorized post-review amendment (2026-07-15): persist one
   authoritative pending Checkout attempt/Session lease per account.** The lease carries the
   attempt id, Session id/state, tier, immutable variant, both Price ids, cents, included/paid
   quotas, provisional overage quantity, trial days, tax shape, customer email, and success/cancel
   URLs. It is created under entitlement → billing →
   activation ordering before Stripe creation; the stable attempt id owns provider idempotency.
   Exact creating/open retries use only that frozen tuple and never re-resolve the live Price map,
   flags, email, or deployment URL under the same idempotency key. A new selection must provider-resolve and
   expire the prior open Session before replacing the lease; a completed prior Session blocks a
   replacement. If Session creation succeeds but lease binding/commit fails, compensate with a
   stable Session-expiry idempotency key (or cancel the subscription when completion wins that
   race), retaining a remediated identity. Completion retrieves provider-current Session line
   items and subscription, validates them against the full lease and canonical pending account,
   and only then applies status/snapshot. Completion accepts only provider `active`/`trialing`
   state and requires a changed+activated binding transition; every other state/result is canceled
   and remediated so the owner may reselect. Stale completions never apply status/tier/snapshot and
   remediate their provider subscription. A retained completed identity makes replay a no-op and
   prevents cancellation of the bound subscription after legitimate later tier changes, while
   replay still converges the deprecated tier mirror after a prior post-commit mirror failure.
   `assertTierPurchasable` authorizes and freezes only a *new durable Checkout attempt*. Exact
   `creating` recovery and an already-open Session remain authorized after gate closure and never
   re-read the live gate under their stable idempotency key, with runtime enforcement
   preventing auto-posting and the webhook emitting the existing ops downgrade/refund signal.
   This initial-completion rejection is a narrow security exception to the later lifecycle
   webhook mismatch rule: a Checkout lease/Price mismatch is rejected and remediated **before**
   status projection so a Copilot charge cannot activate an Autopilot snapshot. Once a
   subscription is authoritatively bound, `subscription.updated` variant mismatch still preserves
   the immutable variant, skips tier/snapshot mutation, and applies legitimate provider status
   only through the single status applier.

   Canonical Stripe status paths resolve account identity without a row lock, retrieve provider-
   current state before the account row lock where required, then acquire entitlement before the
   account row. The under-entitlement applier is anchored to that exact account id and rechecks
   provider lineage on the locked row; it never re-resolves a different account after taking the
   lock. Every real status transition atomically writes its audit/follow-up work and a
   `stripe_subscription_mirror_sync` outbox row. A resolved no-op `subscription.updated` replay
   also enqueues one mirror job so a prior mirror failure converges without a second status write.
   The mirror worker locks all account businesses in
   deterministic id order, then entitlement, reads canonical account state without a row lock,
   updates the deprecated status/activation mirror, and completes its originating outbox entry in
   the same transaction. No canonical Stripe status path updates that business mirror synchronously.
10. **Kill dead basic coupling**: remove `basic_requires_single_location` (`tier-change.ts`) and
    the VAL-LOC-001 "rejects basic" path (`quota.ts`).
11. **Stripe Price setup matrix** (checked runbook, staging + prod): all six Prices = USD,
    **monthly recurring**, correct unit amounts (2900/1900/6900/4900/1500/2000), `active`, and a
    tax_behavior compatible with `STRIPE_TAX_ENABLED`. A test/preflight asserts each retrieved
    Price matches shape before flipping env vars.
12. **Env/code rollout sequence** (documented + tested runbook — the worker boot assertion in
    `worker/config/startup-assert.ts:8` derives required Stripe keys from `STRIPE_PRICE_ENV_VARS`,
    so order is load-bearing: deploying the new map before the new vars exist crashes worker boot;
    removing legacy vars before the new map deploys breaks the old worker). Ordered steps:
    (a) create the six Stripe Prices (staging then prod); (b) set the six new env vars in Railway
    + Vercel **while retaining the seven legacy vars** (both present = neither old nor new boot
    assertion fails); (c) **quiesce signup + Stripe ingestion**, apply **077** to staging (adds
    price_variant/trigger/defaults **and normalizes every legacy row** + invalidates open legacy
    Checkout Sessions — no strict CHECK yet); (d) deploy new code (its map now asserts the six new
    vars, which are present; every row is already a valid new tier); (e) smoke-test checkout +
    tier-change + webhook on staging; (f) apply **078** to staging (preflight → strict CHECK, now
    that data is normalized and only new code writes); (g) repeat quiesce→077→deploy→078 on prod;
    (h) remove the seven legacy vars only **after** the rollback window closes. A test asserts the
    boot assertion passes with the new var set.
13. **Tests + audits**: rewrite every old-tier fixture/test; migration tests for the immutability
    trigger + defaults + preflight; `pnpm lint typecheck test ci:tenant-scope ci:rls-audit
    ci:static-policy`.

## Key decisions & tradeoffs
- **Variant governs WRITE-time price; stored cents are READ-time authority.** The one rule that
  both preserves founding-for-life AND keeps migration-054's drift-proof snapshot.
- **Founding window = server-side, fail-closed deadline.** Race-free, no cross-tenant query.
- **All Price IDs retained forever**, reverse map `{tier,variant}`; window close only changes the
  *default variant for new accounts*.
- **Monthly-only launch.** **WS8 owns the tier-entitlement GATE into the autonomy runtime**
  (grant-time prerequisite + publish-time re-check + downgrade-on-loss); WS4 owns the autonomy
  *mechanics*. The tier is only real if the runtime enforces it (step 5b).
- **Former Premium (non-autonomy) entitlements → both paid tiers**; autonomy behavior → Autopilot.

## Risks / open questions
- Promo-code disable: confirm no intentional dependency.
- Overage item swap (3→2 Prices): verify `resolveOverageItem`/`overageItemMutationParams`; no
  in-flight sub references a removed overage Price.
- `price_variant` trigger must still allow the row's other columns (tier) to UPDATE — scope the
  trigger to the column only.
- **Business rule to confirm at sign-off**: founding-for-life spans tier upgrades (founding
  Copilot → founding Autopilot $49). If it should be per-original-tier, narrow the variant rule.
- **Founding window mechanism changed from grilled cohort-cap (first 100) to deadline** — confirm.

## Out of scope
- Autonomy enforcement / trust dial / veto / judge / governor (WS2–WS6).
- Outcome/usage billing. Real annual-interval Stripe billing (scoped fast-follow).
- The reserved third tier.
