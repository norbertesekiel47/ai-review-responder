# RepWorth — Core Billing Audit Remediation (Design Spec)

**Date:** 2026-06-23
**Source audit:** [`docs/audits/2026-06-23-core-billing-audit.md`](../../audits/2026-06-23-core-billing-audit.md)
**Scope decision:** full sweep — every P2 + P3 + the one QUALITY-OBS refactor.
**Delivery:** two PRs split by risk (PR A low-risk; PR B money-path / refactor).
**Status:** design approved 2026-06-23. Pending implementation plan.

---

## 1. Context & goal

The 2026-06-23 core-revenue billing audit found **zero P0/P1 correctness bugs**; money
paths were live-verified on staging. What remains is **robustness, observability, one
consolidation refactor, and a confirmed env-safety P1**. This spec turns that findings
register into actionable, code-grounded work. It does **not** re-litigate the audit's
GO verdict on the trial flip — that is gated by mechanical runbook steps (Part C), not
code, and is out of scope here (§8).

Every finding below was re-verified against source by three parallel read-only agents
before this spec was written (the audit is static analysis and had already mis-predicted
RECONCILE-F2). Where verification changed the audit's framing, that is called out in §2.

---

## 2. Verification corrections (code-grounded — these supersede the audit's framing)

| Audit item | Audit said | Code says | Decision |
|---|---|---|---|
| **FIND-001** | "Fix the account-vs-business resolution, or delete if dead" | **Orphaned.** Real Checkout `success_url` is `/onboarding/payment-success` (`create-checkout-session.ts:116`); nothing routes to `/admin/payment-success` except a hand-typed URL, which then 404s on the id mismatch. Owner self-serve flow is unaffected (polls `/api/auth/signup-status`). | **Delete** the route + page + allowlist entry + docs ref. |
| **OVERAGE-F5** | "`/archive` missing the offboarding gate (inconsistent)" | Gate genuinely absent — **but correctly so**. The gate freezes billing-**expanding** mutations (`add`/`reactivate`); archive is billing-**contracting** (decrements overage). Gating it would block an offboarding customer from *reducing* spend. | **Document** the intentional exemption; do **not** add the gate. |
| **STATUS-1.1** | "Raw `=== ACTIVE` gate leaks entitlement copy" | **No entitlement leak.** The real add-location gate is `canAddLocationForAccount` → `subscriptionGrantsFullAccess` (correct). The raw `=== ACTIVE` at `page.tsx:54` only selects *which locked copy* to render, so a trialing-Basic owner sees "subscription must be active" instead of "Upgrade to add locations." | Copy-only fix; same one-line change. |

All other findings (QUALITY-OBS, OVERAGE-F1/F2, RECONCILE-F1/F5, CONFIG-1, and the P3
nits) were **confirmed** with line-level evidence.

---

## 3. Decisions locked

1. **Dev-DB target (FIND-ENV):** repoint local `.env.local` at a **local Supabase stack
   (`supabase start`)** — fully isolated, zero cloud risk. (Not a dedicated cloud project; not staging.)
2. **Delivery:** two PRs, split by risk. PR A merges first; PR B rebases on A.
3. **RECONCILE-F1:** option (a) — add a lightweight `locations_paid` drift-observability
   check now. Retiring the (vestigial) column is a **tracked follow-up**, not in this sweep.
4. **CONFIG-1:** option (a) — verify the Sentry→Discord rule routes `warning +
   feature:stripe_reconciliation`. Only bump revenue-affecting drift to `level:'error'`
   (option b) if routing cannot carry `warning`.

---

## 4. PR A — `billing: safety + quick wins + nits` (low risk)

No money-path logic changes. Lands first; staging fast-forwards after merge.

### A1 · FIND-ENV (🔴 confirmed P1 — safety)
- **Problem:** local `.env.local` points `DATABASE_URL`, `DATABASE_POOL_URL`, and
  `NEXT_PUBLIC_SUPABASE_URL` at **prod** (`udeyaqnvpojbwgoaxwdg`) with
  `MOCK_EXTERNAL_APIS=false` → any unmocked local run reads/writes prod. Violates
  deployment-guide §1.3.
- **Change:** repoint all DB + Supabase vars at a local stack (`supabase start`). Add a
  short "local dev DB must never be prod" note to `deployment-guide.md` §1.3 and
  `.claude/reference/env-vars.md`.
- **Mitigant context:** prod backend is not deployed yet (Vercel frontend only), so prod
  is effectively empty today — fix lands before real data exists.
- **Acceptance:** `pnpm dev` / `pnpm worker` connect to the local stack; no env var
  resolves to `udeyaqnvpojbwgoaxwdg`. The **only committed artifact** is the doc note
  (`deployment-guide.md` §1.3 + `env-vars.md`) — `.env.local` is gitignored and edited locally.

### A2 · OVERAGE-F2 — alert on the ambiguous overage dead-letter
- **Where:** `UpdateStripeOverageWorker.ts:151-157` (the `ambiguous` branch terminal-fails
  with `logger.error` + `markOutboxFailed`; Sentry is not imported/called).
- **Change:** add `Sentry.captureMessage(...)` (level `error`, tags
  `feature:'stripe_overage'`, `account_id`, `drift:'ambiguous_overage_item'`) before
  `markOutboxFailed`. Keep the existing log + outbox-fail + return.
- **Acceptance:** unit test asserts Sentry is called on the ambiguous path; happy path does not.

### A3 · STATUS-1.1 — trialing-Basic locked-copy
- **Where:** `src/app/(authenticated)/settings/locations/page.tsx:54`.
- **Change:** replace `account?.subscription_status === SubscriptionStatus.ACTIVE` with
  `subscriptionGrantsFullAccess(account?.subscription_status)` so trialing + active Basic
  owners both get the "Upgrade to add locations" copy (`:59`), not "subscription must be active" (`:67`).
- **Acceptance:** render test — trialing-Basic shows the upgrade copy; cancelled/past_due
  still show the "unavailable" copy. No change to the actual enable gate.

### A4 · FIND-001 — delete the orphaned admin payment-success route+page
- **Delete:** `src/app/api/admin/payment-success/route.ts`, `src/app/admin/payment-success/page.tsx`.
- **Clean up refs:** remove the allowlist entry at `scripts/ci/tenant-scope-allowlist.ts:2696`,
  the `docs/directory.md:173` line, and the path-check branch in `AdminNav.tsx:25`.
- **Acceptance:** `pnpm ci:tenant-scope` green; `pnpm build` emits no route for the deleted
  page; repo grep for `admin/payment-success` returns only this spec/audit.

### A5 · OVERAGE-F5 — document intentional exemption
- **Where:** `src/app/api/locations/archive/route.ts` (~`:58`).
- **Change:** one comment explaining archive is intentionally **not** offboarding-gated
  because it is a billing-**contracting** mutation (the gate exists to freeze billing
  expansion). No logic change.

### A6 · Safe P3 nits
| Nit | Where | Change |
|---|---|---|
| RECONCILE-F4 | `reconcile-account.ts:155-170` | Capture the `applyStripeSubscriptionState` result; only `logger.warn('Corrected stuck trialing row')` when `result.changed === true`. |
| OVERAGE-F4 | `src/lib/shared/outbox.ts:116-126` (caller `UpdateStripeOverageWorker.ts:139`) | Thread `attempt` into `recordOutboxTransientError`; guard the UPDATE so a stale retry can't overwrite a newer `last_error`. |
| SELECTPLAN-1 | `select-plan` route snapshot | Remove the dead `?? 1 / ?? 2500 / ?? 7900` tier fallbacks (tier is schema-validated upstream). |

### A7 · Comment/test-only (no logic change)
| Item | Where | Action |
|---|---|---|
| OVERAGE-F3 | `src/lib/payments/overage-item.ts:99` | Comment: the `billing_role` stamp is the primary defense; the `originalCount > 1` unit-amount guard is intentionally conservative. |
| OVERAGE-F6 | `UpdateStripeOverageWorker.ts:79-87` | Already documented inline; capture the "$0 until trial_end" assumption as a staging integration-test TODO (Stripe test-mode), not a code change. |
| NOTE-B | `apply-subscription-state.ts:66-70` | Confirm `incomplete_expired → PAST_DUE` is intended (preserves the 7-day grace window); add a one-line rationale comment. |

---

## 5. PR B — `billing: robustness + status-applier consolidation` (money-path)

Rebases on PR A. Longer staging soak against real Stripe test-mode webhooks before main.
Trial/applier test suites (the best-tested surface) are the safety net.

### B1 · QUALITY-OBS ⭐ — consolidate status transitions into the applier
- **Problem (confirmed):** the applier `applyStripeSubscriptionState(tx, ref, stripeSub)`
  (`worker/ingress/stripe/apply-subscription-state.ts`) already encodes the full monotonic
  transition table for all 4 statuses, **but is only invoked from trial branches.** Four
  handlers re-implement non-trial transitions inline:
  - `checkout-completed.ts:114-124` (mirror `:154-166`) — `pending_payment`/`past_due` → **active**
  - `invoice-payment-failed.ts:56-62` (mirror `:77-82`) — `active` → **past_due**
  - `invoice-paid.ts:44-50` (mirror `:65-70`) — `past_due` → **active**
  - `subscription-deleted.ts:95-102` (mirror `:117-121`) — non-cancelled → **cancelled**
  This duplication is the root of the PARITY-1/2 drift.
- **Change:** make the applier the single writer for **all** status transitions. Each
  handler shrinks to: resolve account → call applier → post-commit best-effort
  (analytics/notification). Fixing this **auto-resolves PARITY-1 and PARITY-2.**
- **Invariants that MUST be preserved (verified, not incidental):**
  1. **NOTE-A** businesses-mirror asymmetry: `trialing`/`active` update the **primary**
     business only; `past_due`/`cancelled` update **all** businesses for the account.
  2. **NOTE-B** mapping: `incomplete_expired → PAST_DUE` (not CANCELLED).
  3. `COALESCE` semantics on `stripe_customer_id`/`stripe_subscription_id` (first-writer-wins).
  4. `active` clears `past_due_at` **and** `trial_ends_at`; `active` sets `subscription_activated_at`.
  5. The monotonic transition table (no illegal backward transitions).
- **Central refactor risk (flag for the plan):** the applier's input is a Stripe
  **subscription** object, but `checkout-completed` handles a `checkout.session.completed`
  event (it has a session + ids, not necessarily a full subscription). The plan must
  reconcile the applier's input contract across all 4 callers — either widen the applier
  to accept a normalized `{status, customerId, subscriptionId, ...}` shape, or have
  `checkout-completed` retrieve/synthesize the subscription. This is the main reason the
  refactor is "deliberate, test-backed," not a quick edit.
- **Acceptance:** all existing webhook + applier + trial test suites green; new tests
  assert each of the 4 transitions now clears the right columns (PARITY-1) and COALESCEs
  ids (PARITY-2); businesses-mirror asymmetry covered by test.

### B2 · OVERAGE-F1 — account-scoped advisory lock around the overage sync
- **Problem (confirmed):** the Stripe idempotency key is derived from the **outbox-row id**
  (`overage-sync.ts:43-50` via `operationScope = outbox:<id>:...`), not `(account, qty)`.
  No-double-bill rests entirely on `concurrency:1` + **single Railway replica** (boot-asserted
  at `worker/index.ts:180-183`). A second replica or a redeploy-overlap window could
  double-`create` an overage item → double-bill.
- **Change:** wrap the resolve→mutate overage sync in a tx holding
  `pg_advisory_xact_lock(<stable bigint from account_id>)`, so concurrent overage syncs for
  the same account serialize. Keep `concurrency:1` + single-replica as defense-in-depth;
  the lock closes the overlap window and is the **hard gate before any worker scale-out.**
- **Production-rule tension (flag for the plan):** `production.md` warns against holding
  locks across slow remote calls, and a `pg_advisory_xact_lock` held across the Stripe call
  ties up a pooled connection (`max:10`). Acceptable here because contention is ~zero
  (single consumer, infrequent overage events) and the lock's purpose is the future-scale /
  overlap case — **but** the plan must keep the Stripe call's timeout tight (existing
  `getStripe()` bounded timeout) so a stuck call can't hold lock+connection indefinitely.
- **Acceptance:** test simulating two concurrent overage syncs for one account creates the
  item exactly once; `concurrency:1` boot-assert still present.

### B3 · RECONCILE-F5 — release PG connections on a timed-out reconcile cycle
- **Problem (confirmed, with caveat):** `withTimeout` (`src/lib/shared/with-timeout.ts:24-39`)
  races a timeout but does **not** cancel the underlying work (no `AbortSignal`). Single-flight
  **is** present (`StripeLocationsReconcilePoller.ts:77-81`), bounding it to one detached
  cycle at a time — but that cycle still holds a Postgres pool connection (the trial-correction
  `sql.begin` at `reconcile-account.ts:156`) until it settles.
- **Change:** thread an `AbortController` from the poller into `reconcileAccount` and pass
  `{ signal }` to the Stripe calls (`reconcile-account.ts:86,113,295`); on timeout, abort so
  the cycle releases its connection. **Plan must confirm the Stripe Node SDK accepts a
  `signal`;** if not, fall back to ensuring the per-account Stripe reads complete *before*
  opening the correction tx (so a stalled read never holds a tx) + documenting single-flight
  as the bound.
- **Acceptance:** under a simulated Stripe stall, pool connections are released within
  `timeout + ε`; reconcile does not accumulate detached open transactions.

### B4 · RECONCILE-F1 — lightweight `locations_paid` drift check
- **Problem (confirmed):** `locations_paid` is a near-vestigial mirror — written **from**
  Stripe (`subscription-updated.ts:183`), read only for a dashboard "billing pending" badge
  (`aggregate-service.ts:62-63`) + display strings. No billing math reads it
  (`quota.ts` derives overage from a live `COUNT`). Reconcile never compares it.
- **Change (option a):** add a drift-observability comparison in reconcile —
  `locations_paid` vs Stripe overage quantity (and/or `locations_included + live overage`);
  on mismatch emit at `warning` with `feature:'stripe_reconciliation'`,
  `drift_type:'locations_paid_mirror'`. No auto-correction (it doesn't bill).
- **Tracked follow-up (not this sweep):** retire the column entirely and rederive the
  dashboard badge from the live count ("one owner per fact"). Capture in
  `docs/future-plans/`.
- **Acceptance:** test asserts a seeded `locations_paid` mismatch emits the drift signal;
  matching state stays quiet.

### B5 · RECONCILE-F3 / F6 — coverage + scoping
| Item | Where | Change |
|---|---|---|
| RECONCILE-F3 | `StripeLocationsReconcilePoller.ts:125` (`WHERE status IN (ACTIVE,PAST_DUE,TRIALING)`) | Confirm the missed-activation backstop (`StripeCheckoutReconcileWorker`) owns `pending_payment`; if a gap is confirmed, add bounded reconcile coverage. Document the backstop either way. |
| RECONCILE-F6 | `reconcile-account.ts:113-132` | Scope the duplicate-subscription scan to the account's own subscription lineage (exclude subs mapped to other accounts) before flagging `duplicate_subscription`, so one Stripe customer ↔ many accounts doesn't false-positive. |

### B6 · CONFIG-1 — confirm drift-alert routing
- **Where:** `worker/.../billing-reconciliation/drift-alert.ts:46-53` (`captureMessage`,
  `level:'warning'`, tag `feature:'stripe_reconciliation'`).
- **Change:** verify the Sentry→Discord/pager rule routes `warning + feature:stripe_reconciliation`
  (ops verification, no code). Only if routing cannot carry `warning`, bump revenue-affecting
  drift types (quantity/price/upcoming-invoice) to `level:'error'`, keeping benign windows at `warning`.

---

## 6. Testing & verification strategy

- **Per-item acceptance tests** as listed above. Net-new tests for: OVERAGE-F2 alert,
  STATUS-1.1 copy, the 4 consolidated transitions (PARITY-1/2), OVERAGE-F1 concurrent-sync,
  RECONCILE-F1 drift, RECONCILE-F5 connection-release.
- **Gates (both PRs):** `pnpm lint && pnpm typecheck && pnpm test`, plus
  `pnpm ci:tenant-scope`, `pnpm ci:rls-audit`, `pnpm ci:analytics-events`,
  `pnpm ci:static-policy`, and `pnpm verify:stripe-prices`.
- **Staging soak (PR B):** exercise convert / decline / cancel / overage ↑↓ against the
  deployed staging worker via Stripe test clocks (the audit's Phase B method) before promoting to main.

---

## 7. Sequencing & promotion

1. **PR A** → CI green → merge to `main` → `git merge --ff-only main` onto `staging`.
2. **PR B** rebases on `main`, rides **staging first** (worker/webhook/billing changes per
   the promotion rule), soaks, then PR to `main`.
3. Files touched by both PRs (`UpdateStripeOverageWorker.ts`, reconcile files): PR B rebases
   after A merges — expect a trivial rebase, not parallel edits to the same lines.

---

## 8. Out of scope

- The trial-flip **Part C** mechanical steps (migration 069 → prod, 6 prod webhook events +
  endpoint API-version, `TRIAL_ENABLED`/`TRIAL_PERIOD_DAYS`/`SELF_SERVE` on both runtimes,
  Stripe trial-end email, prod tax parity) — runbook ops, not code.
- Actual worker horizontal scaling (OVERAGE-F1 is the *gate*; scaling itself is separate).
- LLM cost-guard / COGS, admin margin, onboarding-demo cost lane, Stripe Tax deep-dive
  (explicitly out of the audit's scope).
- Retiring `locations_paid` (tracked follow-up per §5/B4).

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| QUALITY-OBS refactor breaks a money-path transition | Med | Existing trial/applier/webhook suites + new per-transition tests; staging soak; preserve the 5 invariants in B1. |
| Applier input-contract mismatch for the checkout path | Med | Plan reconciles the contract across all 4 callers before any handler is changed (B1). |
| OVERAGE-F1 lock held across Stripe call ties a connection | Low | Single consumer + infrequent events + bounded Stripe timeout; lock is for the scale/overlap case. |
| Stripe SDK lacks `AbortSignal` support (RECONCILE-F5) | Low–Med | Fallback: reads-before-tx + single-flight as the documented bound. |
| FIND-001 deletion removes a still-wanted page | Low | Verified orphaned (no `success_url` / link / redirect reaches it); `ci:tenant-scope` + build confirm. |
