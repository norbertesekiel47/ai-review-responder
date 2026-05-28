# StripeLocationsReconcilePoller Modularization — Design

_Date: 2026-05-27 · Branch: `refactor/stripe-locations-reconcile-modularization` (off `main`)_

## Goal

Modularize `worker/background/pollers/StripeLocationsReconcilePoller.ts` (617 LOC)
per `docs/modular-requirement.md` Tier 1. The debt is **one giant function**:
`runOnce` is ~330 lines, interleaving outbound Stripe I/O with overage-item math,
flag parsing, and drift alerting. Splitting it makes the per-account
outbound-Stripe **failure path** a named, testable unit.

**Hard constraint: behavior must be preserved byte-for-byte.** The existing
`__tests__/StripeLocationsReconcilePoller.test.ts` (~40 tests, run through the
public surface) is the characterization safety net and must stay 100% green and
**untouched**.

## Public surface (must not change)

- `runOnce(): Promise<ReconcileResult>` — imported by the test.
- `startStripeLocationsReconcilePoller(): void` — imported by `worker/index.ts`.
- `stopStripeLocationsReconcilePoller(): void` — imported by `worker/index.ts`.

All moved helpers are currently module-private and imported nowhere else, so
relocating them is safe.

## Current file anatomy

| Cluster | Lines | Concern |
|---|---|---|
| Lazy Stripe singleton (`getStripe`, `stripeInstance`) | 41–50 | config/lifecycle |
| Pure Stripe-item helpers (`getOveragePriceIds`, `extractStripeCustomerId`, `isMissingStripeSubscriptionError`, `activeStripeSubscriptions`, `findOverageItem`, `isOverageItem`) | 52–146 | pure math/predicates |
| Flag parsing (`parseAccountFlags`, `isPilotAccount`) | 92–110 | account-flags |
| `runOnce` per-account reconcile loop | 172–500 (~330) | **the debt** |
| `emitDriftAlert` + `DriftAlertPayload` | 502–562 | alert sink |
| `start`/`stop` lifecycle | 567–617 | lifecycle |

## Target module layout

Extends the existing `billing-reconciliation/` pattern (single-concern modules:
`types.ts`, `drift.ts`, `expected-invoice.ts`).

```
worker/background/pollers/
  StripeLocationsReconcilePoller.ts   ← orchestrator + lifecycle  (~120 LOC, was 617)
  billing-reconciliation/
    types.ts             (existing; + add AccountWithLocations)
    drift.ts             (existing; unchanged)
    expected-invoice.ts  (existing; unchanged)
    stripe-overage.ts    ← NEW: pure Stripe-item helpers
    account-flags.ts     ← NEW: parseAccountFlags, isPilotAccount
    drift-alert.ts       ← NEW: emitDriftAlert + DriftAlertPayload
    reconcile-account.ts ← NEW: reconcileAccount (per-account step)
  __tests__/
    StripeLocationsReconcilePoller.test.ts (existing; untouched, stays green)
    stripe-overage.test.ts    ← NEW unit tests
    reconcile-account.test.ts ← NEW unit tests
```

### Module responsibilities

- **`stripe-overage.ts`** — `getOveragePriceIds`, `extractStripeCustomerId`,
  `isMissingStripeSubscriptionError`, `activeStripeSubscriptions`,
  `findOverageItem`, `isOverageItem`. Pure functions / env reads, no I/O.
- **`account-flags.ts`** — `parseAccountFlags`, `isPilotAccount`. Deliberate
  concern-split from stripe-overage (the requirement doc bundled them, but flag
  parsing is a distinct concern and matches the single-concern style of the
  existing sibling files).
- **`drift-alert.ts`** — owns `DriftAlertPayload` and `emitDriftAlert` (the
  Sentry-vs-`console.warn` sink). The alert mechanism lives in one place.
- **`reconcile-account.ts`** — the deep module. `reconcileAccount(stripe,
  account, overagePriceIds)` runs one account's full reconcile, makes the
  outbound Stripe calls with **explicit per-call failure handling**, and returns
  an outcome. This is what makes the failure path visible and independently
  testable.
- **`StripeLocationsReconcilePoller.ts`** — orchestrator + lifecycle. Owns module
  state (`timer`, `inProgress`, `stripeInstance`), `getStripe()` lazy singleton,
  the `runOnce` orchestration (single-flight guard → SQL query → loop → emit →
  tally → log), and `start`/`stop`. Keeps `ReconcileResult`.

## Key contract — `reconcileAccount`

```ts
export interface AccountReconcileOutcome {
  accountsChecked: 0 | 1;
  drifts: DriftAlertPayload[]; // in original emission order
  errors: number;              // internally-handled errors (dup-list, invoice-preview)
}

export async function reconcileAccount(
  stripe: Stripe,
  account: AccountWithLocations,
  overagePriceIds: Set<string>,
): Promise<AccountReconcileOutcome>;
```

The `stripe` client is **injected** — the orchestrator owns the lazy singleton
(`getStripe()`) and passes it down. This preserves the test's Stripe mock and
keeps `reconcileAccount` independently testable.

`AccountWithLocations` moves to `types.ts` so both the orchestrator (produces the
SQL row) and `reconcileAccount` (consumes it) can import it.

## Orchestrator (`runOnce`) shape

Single-flight guard (`inProgress`) → SQL query (unchanged) → loop:

```ts
for (const account of accounts) {
  try {
    const outcome = await reconcileAccount(stripe, account, overagePriceIds);
    accountsChecked += outcome.accountsChecked;
    errors += outcome.errors;
    for (const payload of outcome.drifts) {
      emitDriftAlert(account.id, payload);
      driftsFound++;
    }
  } catch (err) {
    errors++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Error reconciling account ${account.id}: ${message}`);
  }
}
```

Final summary logging and `ReconcileResult` return are unchanged.

## Behavior-preservation map (the hard requirement)

| Original control flow in `runOnce` loop | Where it lives now | Net effect |
|---|---|---|
| unknown tier → `console.error`, `errors++`, `continue` | `reconcileAccount` → `{checked:0, drifts:[], errors:1}` after logging | identical |
| missing `stripe_subscription_id` → emit, checked++, continue | `reconcileAccount` → `{checked:1, drifts:[missing_subscription], errors:0}` | identical |
| retrieve throws **missing** error → emit, checked++, continue | `reconcileAccount` internal catch → `{checked:1, drifts:[missing_subscription]}` | identical |
| retrieve throws **non-missing** → `throw` → outer catch `errors++` (no checked) | `reconcileAccount` re-throws → orchestrator catch `errors++` | identical |
| duplicate-list throws → `errors++`, log (no loop-continue) | `reconcileAccount` internal try/catch `errors++` | identical |
| status / base-price / overage-price / quantity drifts | collected into `drifts[]` in order | identical totals |
| `accountsChecked++` (line 434) | `reconcileAccount` returns `accountsChecked:1` | identical |
| invoice-preview throws → `errors++`, log | `reconcileAccount` internal try/catch `errors++` | identical |
| outer catch-all → `errors++`, log | orchestrator try/catch | identical |

### One deliberate, test-verified-safe deviation

Drift **emission** moves from interleaved-during-processing to
collect-then-emit-after-`reconcileAccount`-returns. Final counts
(`accountsChecked` / `driftsFound` / `errors`) and every `emitDriftAlert`
argument are unchanged; only the interleaving of `console.warn` (drift) vs
`console.error` (handled error) calls **within a single account** can flip.

- No existing test asserts cross-spy call ordering (all use order-independent
  `toHaveBeenCalledWith` / `not.toHaveBeenCalled`).
- No production behavior depends on alert ordering — independent Sentry messages
  and integer counters.

## Testing plan

- **Existing `StripeLocationsReconcilePoller.test.ts`** — the characterization
  net. Untouched. Run after **every** extraction step; must stay 100% green.
- **NEW `stripe-overage.test.ts`** — unit tests for `findOverageItem` /
  `isOverageItem` (price-id match, descriptor-regex match, unit-amount fallback
  with `itemCount > 1`), `isMissingStripeSubscriptionError` (each branch),
  `activeStripeSubscriptions` (status filter), `extractStripeCustomerId`.
- **NEW `reconcile-account.test.ts`** — unit tests asserting the
  `AccountReconcileOutcome` for key branches: clean account (checked:1, no
  drifts), missing-sub-id, missing-in-stripe (handled), non-missing retrieve
  error (re-throws), duplicate-list error (errors:1, still checked), and
  invoice-preview error (errors:1, quantity drift still reported).

## Execution order (TDD-refactor, suite green between each)

1. Extract `stripe-overage.ts` + `account-flags.ts`; import into poller → run suite.
2. Extract `drift-alert.ts` (move `emitDriftAlert` + `DriftAlertPayload`) → run suite.
3. Move `AccountWithLocations` to `types.ts`; extract `reconcile-account.ts`;
   slim `runOnce` to the orchestrator loop → run suite.
4. Add the two new unit-test files → run them.
5. Full gate: `pnpm lint && pnpm typecheck && pnpm test`.

## Out of scope (deferred, documented)

`src/lib/shared/past-due-recovery.ts` defines its **own** `parseAccountFlags` — a
pre-existing duplication (two owners for one fact). Unifying it is **not** part of
this behavior-preserving refactor; the correct shared home would be under
`src/lib`, not `worker/`. Tracked as a follow-up, not addressed here.

## Success criteria

- Poller drops from **617 → ~120 LOC**; `runOnce` from ~330 → ~40 lines.
- Per-account outbound-Stripe failure path is a named module with focused tests
  (honors CLAUDE.md invariant #12).
- Public surface (`runOnce`, `start`, `stop`) unchanged; `worker/index.ts`
  import path unchanged.
- `pnpm lint && pnpm typecheck && pnpm test` all green.
- Lands as its own PR off `main`, independent of the edit-publish branch.
