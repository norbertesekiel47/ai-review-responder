# Follow-up: simplify the Stripe status-applier contract

**Source:** thermo-nuclear code-quality review of PR B (`billing/audit-remediation-pr-b`), findings #1 + #3.
**Status:** tracked, not scheduled. **Deliberately deferred out of PR B** (money-path PR mid staging-soak; this is an orthogonal refactor).

## The smell (real)

`worker/ingress/stripe/apply-subscription-state.ts` exposes a two-mode resolver:
```ts
export type ApplyStripeRef =
  | { mode: 'checkout'; accountId: string }                                   // resolve by accounts.id
  | { mode: 'subscription'; stripeCustomerId: string; stripeSubscriptionId: string }; // resolve by (customer, sub)
```
and takes a `Pick<Stripe.Subscription,'id'|'status'|'trial_end'> & { customer?: unknown }`.

Two coupled issues:
1. **Fabricated Stripe objects.** The "status-known" callers (checkout paid, invoice-paid recovery, invoice-payment-failed active) don't *project* a retrieved Stripe state — they *assert* one, yet must dress it up as a partial `Stripe.Subscription` (`{ id, status, trial_end, customer }`), which then needs the ref-aware `extractStripeCustomerId(customer, ref)` unwrapper to dig back out. The applier's real input is a normalized 4-tuple `{ status, customerId, subscriptionId, trialEnd }`.
2. **Mode asymmetry.** The two `mode`s reflect "which ids the caller happened to hold," not a domain distinction. Sharpest example: `invoice-payment-failed` SELECT-FOR-UPDATEs the row by `(customer, sub)`, then for the ACTIVE branch passes `mode:'checkout'` (re-resolve by id) but for the TRIALING branch passes `mode:'subscription'` (re-resolve the same locked row by customer+sub) — same handler, same row, two modes, no behavioral reason.

## Why deferred (not a no-op decision)

- **The premise that "the internal resolve is always redundant" is only partly true.** `checkout-completed` and `reconcile-account` do NOT pre-lock the row — the applier's `resolveAccount` provides their `FOR UPDATE` lock **and** the `primary_business_id` (used for backfill-resume). So the refactor *relocates* resolution to those callers, it doesn't purely delete it. Worth doing, but it's real work, not a free win.
- It rewrites the most heavily-tested money-path surface (the applier + `apply-subscription-state.test.ts`) and **all 6 call sites**. Bolting that onto PR B — which is mid staging-soak and exists to remediate a billing audit — risks the soak and muddies the PR's purpose.

## Proposed shape (for the follow-up PR)

```ts
export async function applyStripeSubscriptionState(
  tx: TxSql,
  accountId: string,               // caller resolves + FOR-UPDATE-locks the row (incl. primary_business_id)
  target: { status: SubscriptionStatusValue | null; customerId: string | null;
            subscriptionId: string; trialEnd: number | null },
): Promise<TransitionResult>
```
- Delete the `ApplyStripeRef` union, the two near-identical `resolveAccount` queries, and the ref-aware `extractStripeCustomerId`.
- Callers that hold a genuine retrieved subscription (`subscription-deleted`, the trial-convert paths, reconcile) map it once at the call site via `mapStripeStatus(sub.status)` / `sub.trial_end`.
- `checkout-completed` + `reconcile-account` do their own `SELECT … FOR UPDATE` (incl. `primary_business_id`) and pass `accountId` + the normalized target.

**Bundle finding #3 here too:**
- Dedup the customer-id extractor: `worker/background/pollers/billing-reconciliation/stripe-overage.ts`'s `extractStripeCustomerId` is behaviorally identical to `worker/ingress/stripe/shared.ts`'s `extractCustomerId` — import the canonical one (the poller already imports from `ingress/stripe`).
- Trim `TransitionResult` to the fields callers actually consume (`changed`, `activated`, `primaryBusinessId`); `accountResolved`/`fromStatus`/`toStatus` are test-only observability today.

**Behavior-preservation:** the applier already only uses `ref` for (i) which WHERE resolves the row and (ii) which customer id to persist (COALESCE first-writer-wins). Every caller resolves the same row by the same identifiers immediately prior, so resolving by `accountId` returns the identical row; the persisted customer id is unchanged.

**Payoff:** the applier stops being "project a Stripe object" and becomes "apply this status to this account" — a deeper module with a narrower, honest interface; two queries, one union, one unwrapper, and three fake-object literals disappear.
