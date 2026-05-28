# Design — Issue #40: Stripe `subscription-updated` audit noise + tier↔price-map consolidation

- **Date:** 2026-05-28
- **Issue:** [#40](https://github.com/RepWorth/ai-review-responder/issues/40) — "Stripe subscription-updated: noisy audit rows + unvalidated price env vars"
- **Branch:** `worktree-fix+40-stripe-price-tier-map`
- **Status:** Approved design — pending written-spec review

## 1. Problem

Two pre-existing behaviors in `worker/ingress/stripe/subscription-updated.ts`, surfaced during the PR #34 refactor:

1. **Noisy audit rows.** `auditPayload.locationsPaid` is set unconditionally (line 90), so the `Object.keys(auditPayload).length > 0` insert guard is always true. Every `customer.subscription.updated` delivery writes a `subscription_updated` audit row — even when neither tier nor `locations_paid` changed.
2. **`priceToTier` reverse map uses `?? ''` fallbacks.** `[process.env.STRIPE_PRICE_BASIC ?? '']: 'basic'` etc. If more than one base `STRIPE_PRICE_*` is unset, the `''` keys collide and the last write wins → tier misrouting.

Exploration surfaced two further facts that shape the fix:

3. **CLAUDE.md hard-rule violation.** Lines 93–101 do a raw `INSERT INTO account_audit_log`. CLAUDE.md mandates audit writes go through `writeAccountAuditLog(input, tx)` in the same transaction. The three sibling Stripe handlers (`subscription-deleted`, `invoice-paid`, `invoice-payment-failed`) already use the helper; this handler is the lone exception.
4. **The tier↔price mapping is duplicated across 5 files**, not 1. This is the root cause behind bug #2: the mapping is system knowledge with no single owner.

### The duplication (system knowledge with no owner)

| Mapping | Sites today |
|---|---|
| tier → base price ID | `create-checkout-session.ts` (`getBasePriceId`), `tier-change/route.ts` (`getBasePriceId`) |
| tier → overage price ID | `create-checkout-session.ts` (`getOveragePriceId`), `tier-change/route.ts` (`getOveragePriceId`), `UpdateStripeOverageWorker.ts` (`getOveragePriceId`) |
| base price ID → tier (reverse) | `subscription-updated.ts` (inline map — the buggy one) |
| overage-price-ID set / membership | `subscription-updated.ts` (inline `Set`), `UpdateStripeOverageWorker.ts` (inline `Set`), `stripe-overage.ts` poller (`getOveragePriceIds()`) |

Note: the poller's `getOveragePriceIds()` and the `UpdateStripeOverageWorker` set already apply `.filter(Boolean)`, so they are collision-safe today. Only the **reverse** map in `subscription-updated.ts` omits the filter — that is the actual bug. Consolidation preserves the existing safe behavior everywhere and extends it to the reverse map.

## 2. Goals / Non-goals

**Goals**
- Stop writing `subscription_updated` audit rows on no-op deliveries.
- Eliminate the `?? ''` collision in the reverse map by construction.
- Give the tier↔price mapping a single authoritative owner used by all 5 sites.
- Bring `subscription-updated.ts` into line with the `writeAccountAuditLog` convention.

**Non-goals**
- No change to `accounts`/`businesses` UPDATE behavior (the `updated_at = NOW()` bump on every delivery is pre-existing and out of scope).
- No new `startup-assert` assertion (see §5).
- No change to the poller's threaded `Set<string>` API (`findOverageItem`/`isOverageItem` keep taking the set as a parameter — good design; only the *source* of the set moves).
- No change to the `TIER_CONFIG` static config module (kept pure — no env reads).

## 3. New module — `src/lib/payments/price-tier-map.ts`

The single owner of the tier↔Stripe-price-ID mapping. Pure functions, **env read at call time** (lazy — matches the existing per-call construction and keeps tests able to stub `process.env`; building maps at import time would break per-test env stubbing).

```ts
import { type SubscriptionTierValue } from '@/lib/accounts/tier-config';

// tier → base price ID (null when unset/empty)
export function basePriceIdForTier(tier: SubscriptionTierValue): string | null;

// tier → overage price ID (null when unset/empty; `basic` is always null)
export function overagePriceIdForTier(tier: SubscriptionTierValue): string | null;

// base price ID → tier; reverse map built ONLY from non-empty IDs.
// '' / unknown → null. Kills the `?? ''` collision structurally.
export function tierForBasePriceId(priceId: string | null | undefined): SubscriptionTierValue | null;

// overage-price-ID membership test (replaces inline `.has(...)`)
export function isOveragePriceId(priceId: string | null | undefined): boolean;

// overage-price-ID set (for the poller's threaded-Set callers); == today's filtered Set
export function overagePriceIdSet(): Set<string>;
```

- Honors the `founders` → `STRIPE_PRICE_FOUNDING` env-var naming quirk documented in `tier-config.ts`.
- `tierForBasePriceId` and `overagePriceIdSet` both build from `.filter(Boolean)` entries, so `''` is never a key/member.
- Functions never throw; they return `null`/`false`/empty as appropriate. Callers keep their existing failure handling.

## 4. Per-file changes

### 4.1 `worker/ingress/stripe/subscription-updated.ts` (the issue's primary target)
- Delete the inline `priceToTier` map and `overagePriceIds` Set.
- Base item lookup → predicate `!isOveragePriceId(item.price?.id)`; tier resolve → `tierForBasePriceId(baseItem.price.id)`; overage item lookup → `isOveragePriceId(item.price?.id)`. (Unknown/empty base price still warns-and-skips exactly as today.)
- Add `locations_paid` to the `SELECT … FOR UPDATE` row.
- **Audit dedup:** set `auditPayload.fromTier`/`toTier` only when `tierChanged` (unchanged); set `auditPayload.locationsPaid` only when `acctRow.locations_paid !== locationsPaid`. The existing `Object.keys(...).length > 0` guard then correctly skips true no-ops.
- **Audit helper:** replace the raw `INSERT INTO account_audit_log` with
  `writeAccountAuditLog({ accountId: acctRow.id, eventType: 'subscription_updated', payload: auditPayload }, tx)`.
  Behavior-preserving for the columns previously set (`location_id`, `actor_user_id`, etc. were already implicitly null).

### 4.2 `src/lib/payments/create-checkout-session.ts`
- Replace local `getBasePriceId`/`getOveragePriceId` with imports of `basePriceIdForTier`/`overagePriceIdForTier`; delete the dead locals. `null`-handling (`CheckoutUnavailableError`) unchanged.

### 4.3 `src/app/api/billing/tier-change/route.ts`
- Same as 4.2 (character-identical locals removed, helper imported).

### 4.4 `worker/jobs/billing/UpdateStripeOverageWorker.ts`
- Replace local `getOveragePriceId` (lines 41–49) with `overagePriceIdForTier`; delete the local.
- Replace the inline `overagePriceIds` Set (lines ~169–172) with `overagePriceIdSet()` (or `isOveragePriceId` in the `.find` predicate). `null`/missing handling unchanged (`markOutboxFailed`).

### 4.5 `worker/background/pollers/billing-reconciliation/stripe-overage.ts` + caller
- Remove `getOveragePriceIds()` from the poller module.
- Its single caller, `StripeLocationsReconcilePoller.ts:104`, imports `overagePriceIdSet()` from the new module instead.
- `findOverageItem`/`isOverageItem` keep their `overagePriceIds: Set<string>` parameter (unchanged — they consume the set, they don't own it).

## 5. `startup-assert` — no change (decision)

`assertStripeWorkerEnv()` already requires all 7 `STRIPE_PRICE_*` vars to be non-empty at worker boot (production / non-mock). With the reverse map now collision-safe by construction, a new assertion adds nothing. A "no two price vars are equal" distinctness check was considered and **rejected** as YAGNI (an extreme misconfig, not the reported bug). The Next.js runtime has no boot hook; its call sites already fail safe at call time (`null` → `CheckoutUnavailableError`), which is preserved.

## 6. Behavior changes (intended)

| Delivery | accounts/businesses UPDATE | Audit row |
|---|---|---|
| No-op (same tier, same `locations_paid`) | still runs (idempotent, bumps `updated_at`) | **none** (was: always written) |
| Tier change only | runs | `{ fromTier, toTier }` |
| `locations_paid` change only | runs | `{ locationsPaid }` |
| Both | runs | `{ fromTier, toTier, locationsPaid }` |

All other behavior (advisory lock, legacy single-item tolerance, deprecated `businesses.subscription_tier` write) is unchanged.

## 7. Error handling / contracts

- Helper functions return `null`/`false`/empty — never throw. Worker still warns-and-skips on `null` tier; Next.js sites still throw `CheckoutUnavailableError`; overage worker still `markOutboxFailed`s on missing overage price.
- `writeAccountAuditLog` throwing inside `sql.begin` rolls the transaction back exactly as a raw INSERT failure would.

## 8. Testing plan

- **New** `src/lib/payments/__tests__/price-tier-map.test.ts`:
  - forward: all 4 tiers → base; overage for standard/premium/founders; `basic` overage → `null`.
  - reverse: all 4 base IDs → correct tier; unknown ID → `null`.
  - **collision regression:** with ≥2 base price vars unset, `tierForBasePriceId('')` and `tierForBasePriceId(undefined)` → `null` (no `''` key); `overagePriceIdSet()` excludes empties.
  - `isOveragePriceId` true/false cases.
- **Update** `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`:
  - the `subscription.updated` tx-call-order assertions change — the raw audit INSERT step is gone; assert the already-mocked `writeAccountAuditLog` is called with the deduped payload.
  - new cases: no-op delivery → `writeAccountAuditLog` NOT called; tier-only payload; locations-only payload.
  - existing reverse-map coverage (VAL-BILLING-055, ~line 1001) keeps passing through the helper.
- **Update** `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts` and `worker/background/pollers/__tests__/stripe-overage.test.ts`: re-point any `getOveragePriceId`/`getOveragePriceIds` expectations at the helper (the `getOveragePriceIds()` unit test moves to the helper's test).
- **Verify unchanged** route tests: `tier-change/__tests__/route.test.ts`, `billing/checkout` tests — behavior preserved.
- Gates: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm ci:tenant-scope` and `pnpm ci:rls-audit` (DB-touching).

## 9. CI risk to verify

Removing the raw `INSERT INTO account_audit_log` may **orphan a tenant-scope allowlist entry** (a documented lab-notes trap: moving/removing allowlisted SQL orphans its entry). During implementation, check `scripts`/audit config for an allowlist entry tied to that raw INSERT and remove it so `ci:tenant-scope` stays green. The new `writeAccountAuditLog` path is already an established, audited pattern.

## 10. Validation note (worktree)

This work happens in a worktree nested under `.claude/worktrees/`. Per CLAUDE.md, **local lint/test from a nested worktree is unreliable** (module resolution leaks into the parent `node_modules`/eslintrc). Final CI validation is via a pushed PR and the GitHub runner, not local runs.

## 11. Packaging

One cohesive PR off `main` (the helper ties all edits together). All four CI checks green before merge.
