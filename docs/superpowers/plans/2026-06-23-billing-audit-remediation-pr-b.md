# Billing Audit Remediation — PR B (robustness + status-applier consolidation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the money-path half of the 2026-06-23 core-billing-audit remediation — consolidate the four inline Stripe status transitions into the single applier (QUALITY-OBS, auto-fixing PARITY-1/2), add an account-scoped advisory lock around the overage sync (OVERAGE-F1), harden the reconcile poller against stalls (RECONCILE-F5), add a `locations_paid` drift-observability check (RECONCILE-F1), tighten reconcile coverage/scoping (RECONCILE-F3/F6), verify drift-alert routing (CONFIG-1), and fold in the deferred NOTE-B comment.

**Architecture:** Each task is an isolated, independently-revertable change on branch `billing/audit-remediation-pr-b` (already created off `main` at `e178398d`, which contains PR A #365). The applier `worker/ingress/stripe/apply-subscription-state.ts` becomes the **single writer** of `accounts.subscription_status` for *all* transitions; the four webhook handlers shrink to resolve → call applier → post-commit best-effort. Source-of-truth spec: `docs/superpowers/specs/2026-06-23-core-billing-audit-remediation-design.md` §5.

**Tech Stack:** Next.js 16 (App Router), Fastify/BullMQ worker, Postgres.js (`postgres`), Vitest, Stripe SDK **v22.2.0**, `@sentry/node`, pnpm.

**Commit convention:** every `git commit` in this plan MUST end with the two required trailers:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NBwZTSBbBrUMv5bk87mDZr
```
Steps show `-m "<subject>"` for brevity — append the trailers via a HEREDOC (`git commit -F -` with a `<<'EOF'` body, or `-m subject -m trailer1 -m trailer2`).

---

## CRITICAL gotchas (carry these through EVERY task)

1. **Run the FULL CI gate after every task, not just `pnpm typecheck`.** PR A broke CI twice because audit-sensitive files were only typechecked. After each task run:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
   ```
   (Tasks that touch only one worker file may scope `pnpm test` to that file's suite during the red-green loop, but MUST run the full gate above before `git commit`.)

2. **The static-policy line-number allowlist WILL shift.** `scripts/ci/static-policy-audit.ts` allowlists subscription-status string literals by `file:line` in `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST`. Today it holds **8 entries** for `apply-subscription-state.ts` (lines 249/262/275/285/318/329/338/341) **and** entries for the four handlers whose inline SQL B1 deletes:
   - `checkout-completed.ts:117,123,157,165`
   - `invoice-paid.ts:46,67,69`
   - `invoice-payment-failed.ts:58,79,81`
   - `subscription-deleted.ts:97,119`
   B1 deletes those handler literals (so their entries become dead) and shifts the applier's line numbers (NOTE-B comment + any edits). **Task B1.6 re-derives the whole allowlist from the actual source — do not hand-guess line numbers.**

3. **tenant-scope SQL-snippet allowlist.** `scripts/ci/tenant-scope-allowlist.ts` matches cross-account queries by exact SQL string. B5b adds a new cross-account `SELECT` in `reconcile-account.ts`. If `pnpm ci:tenant-scope` flags it, add a snippet entry (and bump `ALLOWLIST_BASELINE` if the count changes). Task B5b covers this.

4. **PR B is money-path → it MUST ride `staging` first**, then PR to `main`. PR A could go straight to main; PR B cannot. See Task FINAL.

5. **Behavior-preserving is the bar.** The existing trial/applier/webhook suites are the safety net. Each B1 sub-task asserts the handler now *delegates* to the applier (the applier's column-clearing/COALESCE/mirror-asymmetry correctness is already covered by `apply-subscription-state.test.ts`). Do not change money-path *outcomes*; only the *writer*.

**Pre-flight (run once before Task B1.0):**
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth
git branch --show-current   # expect: billing/audit-remediation-pr-b
git log --oneline -1        # expect: e178398d billing: safety + quick wins + nits (audit PR A) (#365)
pnpm install                # ensure deps match the post-A lockfile
pnpm test worker/ingress/stripe/__tests__/apply-subscription-state.test.ts   # green baseline of the applier
```

---

## The B1 consolidation contract (read before B1.0–B1.6)

The applier already supports **both** resolution modes and a **minimal subscription-shaped input** — `invoice-payment-failed.ts:46` already synthesizes `{ id, status, trial_end, customer }`. So the "input contract risk" the spec flagged is already resolved in code; B1 *extends* the proven pattern to the non-trial transitions.

`ApplyStripeRef` (apply-subscription-state.ts:38-40):
- `{ mode: 'checkout'; accountId }` — **resolve by `accounts.id`** (caller already holds/locked the row). The name is historical; functionally it is "resolve by accountId".
- `{ mode: 'subscription'; stripeCustomerId; stripeSubscriptionId }` — resolve by `(stripe_customer_id, stripe_subscription_id)`.

`applyStripeSubscriptionState(tx, ref, stripeSub)` where `stripeSub: Pick<Stripe.Subscription, 'id' | 'status' | 'trial_end'> & { customer?: unknown }`.

**Locked decision — which mode each non-trial transition uses:**
| Handler / path | Mode | Synthesized `stripeSub` | Why this mode |
|---|---|---|---|
| `checkout-completed` paid (`pending_payment`/`past_due`→active) | `checkout` (accountId) | `{ id: subscriptionId, status: 'active', trial_end: null, customer: customerId }` | handler holds `accountId`; matches its existing trial path |
| `invoice-payment-failed` (`active`→past_due) | `checkout` (acctRow.id) | `{ id: failedSubscriptionId ?? '', status: 'past_due', trial_end: null, customer: customerId }` | handler resolved acctRow by customer + FOR UPDATE; `checkout` mode needs no subscriptionId for resolution (avoids a regression for invoices missing a sub id). PAST_DUE target writes **no** Stripe ids, so the `id` field is unused for this target. |
| `invoice-paid` (`past_due`→active recovery) | `checkout` (acct.id) | `{ id: subscriptionId ?? '', status: 'active', trial_end: null, customer: customerId }` | per-account in the recovery loop; ACTIVE target COALESCEs ids but these accounts already have them, so the synthetic id is never written. |
| `subscription-deleted` (non-cancelled→cancelled) | `subscription` (customer, sub) | the real `sub` object | this event carries the full subscription; `subscriptionId === acctRow.stripe_subscription_id` is already verified, so subscription-mode resolution is exact; unifies the trial + non-trial paths into ONE call. |

**Invariants the applier already enforces (B1 must NOT re-implement or break):** NOTE-A businesses-mirror asymmetry (trialing/active → primary only; past_due/cancelled → all), NOTE-B `incomplete_expired→PAST_DUE`, COALESCE first-writer-wins on stripe ids, `active` clears `trial_ends_at`+`past_due_at` and sets `subscription_activated_at`, monotonic transition table.

**Two intentional, spec-sanctioned behavior alignments (call them out in commit bodies):**
- `checkout-completed` paid path switches stripe-id writes from **overwrite** to **COALESCE** (invariant #3 "first-writer-wins" — the spec-desired direction). Also stops mirroring `stripe_customer_id`/`stripe_subscription_id` onto the deprecated `businesses` columns (the applier mirrors only `subscription_status`+`subscription_activated_at`; `businesses.stripe_*` is deprecated per VAL-SCHEMA-037 and the trial path already never wrote them).
- `invoice-payment-failed`/`subscription-deleted` businesses mirror moves to the applier's NOTE-A rule (past_due/cancelled → **all** businesses), which is the spec invariant.

---

## Task B1.0: Confirm the applier contract + fold in NOTE-B

**Why:** lock the contract doc the four handlers will lean on, and fold in the NOTE-B rationale comment that was pulled from PR A (it shifts this file's line numbers, which B1.6 re-derives anyway).

**Files:**
- Modify: `worker/ingress/stripe/apply-subscription-state.ts`

- [ ] **Step 1: Add the NOTE-B rationale comment in `mapStripeStatus`**

In `worker/ingress/stripe/apply-subscription-state.ts`, in `mapStripeStatus`, add a comment immediately above the `case 'past_due':` group (currently line 66):
```typescript
    // NOTE-B: incomplete_expired maps to PAST_DUE (not CANCELLED) on purpose —
    // it preserves the 7-day grace/dunning window rather than hard-cancelling.
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return SubscriptionStatus.PAST_DUE;
```

- [ ] **Step 2: Clarify the `ApplyStripeRef` mode doc (so non-checkout handlers can use `checkout`/by-accountId mode without confusion)**

Replace the `ApplyStripeRef` doc + type (currently lines 37-40):
```typescript
/**
 * How the applier resolves the target account. Two resolution strategies — the
 * caller picks whichever it can satisfy from what it already holds:
 *   - 'checkout'     → resolve by accounts.id. Used by ANY caller that has
 *                      already resolved (and FOR-UPDATE-locked) the account row;
 *                      the name is historical (the checkout handler was the first
 *                      caller). Needs no Stripe ids to resolve.
 *   - 'subscription' → resolve by (stripe_customer_id, stripe_subscription_id);
 *                      acts only on the account's CURRENT subscription.
 */
export type ApplyStripeRef =
  | { mode: 'checkout'; accountId: string }
  | { mode: 'subscription'; stripeCustomerId: string; stripeSubscriptionId: string };
```

- [ ] **Step 3: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: all green. (Static-policy: NOTE-B is a comment line — it shifts the `apply-subscription-state.ts` literal lines DOWN by the lines you added. If `ci:static-policy` now fails with "bare subscription-status string literal" at a shifted line, that's expected — B1.6 re-derives the allowlist; but to keep THIS commit green, update the 8 `apply-subscription-state.ts` entries in `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` to their new line numbers now. Re-derive with:)
```bash
grep -nE "subscription_status = '(active|trialing|past_due|cancelled|pending_payment)'" worker/ingress/stripe/apply-subscription-state.ts
```
Update each `'worker/ingress/stripe/apply-subscription-state.ts:NNN'` entry to the printed line numbers, then re-run `pnpm ci:static-policy` (expect green).
```bash
git add worker/ingress/stripe/apply-subscription-state.ts scripts/ci/static-policy-audit.ts
git commit -m "docs(billing): NOTE-B rationale + clarify applier ref-mode contract (PR B/B1.0)"
```

---

## Task B1.1: Consolidate `subscription-deleted` into one applier call

**Why:** `subscription-deleted.ts` already routes the *trial* cancel through the applier (subscription mode) but re-implements the *non-trial* cancel inline (lines 92-126). The applier's transition table maps `canceled`→CANCELLED and `enqueueLifecycleAnalytics` already emits `trial_cancelled` only when leaving a trial — so BOTH paths collapse to one applier call.

**Files:**
- Modify: `worker/ingress/stripe/subscription-deleted.ts`
- Test: `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts`

- [ ] **Step 1: Add a delegation test for the non-trial cancel (failing)**

In `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts`, add (the file already hoists `mockApplyStripeSubscriptionState` and the sqlReturnQueue helpers — reuse them; model the account-row shape on the existing trial test). Add inside the top-level `describe`:
```typescript
  it('non-trial cancel (active → cancelled) routes through the applier, not inline SQL', async () => {
    // account row: active, ids match the incoming deleted subscription
    sqlReturnQueue.push([{
      id: 'acct-1',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
      active_offboarding_subscription_id: null,
    }]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    });

    await processSubscriptionDeleted({ id: 'sub_1', customer: 'cus_1', status: 'canceled' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'subscription', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
      expect.objectContaining({ id: 'sub_1', status: 'canceled' }),
    );
    // No inline UPDATE accounts ... 'cancelled' anymore:
    const inlineCancel = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
    expect(inlineCancel).toBeUndefined();
  });
```
(If the test file does not already capture `sqlCalls`, add it to the hoisted block exactly as `apply-subscription-state.test.ts:31-39` does, and assert against it.)

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts -- -t "non-trial cancel"
```
Expected: FAIL — the inline UPDATE still runs / applier not called for the non-trial path.

- [ ] **Step 3: Collapse the trial + non-trial blocks into one applier call**

In `worker/ingress/stripe/subscription-deleted.ts`, replace the block from the `// Cancel during trial` comment (line 76) through the end of the inline non-trial block (the `} else { ... already cancelled ... }` closing at line 126) with:
```typescript
    // Single writer for ALL cancellations (QUALITY-OBS): route through the applier
    // in subscription mode. subscriptionId is guaranteed here (matched against
    // acctRow.stripe_subscription_id above). The applier maps Stripe `canceled`
    // → CANCELLED, clears trial_ends_at/past_due_at, mirrors all businesses
    // (NOTE-A), writes the audit row, and emits trial_cancelled ONLY when the
    // account was leaving a trial — so the trial and non-trial cases unify.
    await applyStripeSubscriptionState(
      tx,
      { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
      sub,
    );
```
Keep everything above it unchanged: the `SELECT … FOR UPDATE` account resolve, the `AccountNotProvisionedYetError` throw, the offboarding-snapshot/mismatch guards (lines 60-72), and the `pg_advisory_xact_lock(:status_change)` (line 74). Remove the now-unused `writeAccountAuditLog` import if lint flags it (the applier owns the audit write now); keep the `SubscriptionStatus` import only if still referenced.

- [ ] **Step 4: Run — verify PASS (whole file, incl. the existing trial tests)**

```bash
pnpm test worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: green. (`ci:static-policy` will now flag the removed inline `'cancelled'` literals as *no longer present* — that does NOT fail the audit, but it leaves dead allowlist entries for `subscription-deleted.ts:97,119`. Leave them for B1.6, which removes all dead handler entries at once.)
```bash
git add worker/ingress/stripe/subscription-deleted.ts worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts
git commit -m "refactor(billing): subscription-deleted routes all cancels through the applier (QUALITY-OBS/B1.1)"
```

---

## Task B1.2: Consolidate `invoice-paid` recovery into the applier

**Why:** `invoice-paid.ts` already routes trial-convert through the applier (post-tx, subscription mode). The `past_due`→active **recovery** loop (lines 44-78) is still inline. Route each recovered account through the applier in `checkout`/by-accountId mode.

**Files:**
- Modify: `worker/ingress/stripe/invoice-paid.ts`
- Test: `worker/ingress/stripe/__tests__/invoice-paid-trial.test.ts`

- [ ] **Step 1: Add a delegation test for past_due → active recovery (failing)**

In `worker/ingress/stripe/__tests__/invoice-paid-trial.test.ts` (reuse the hoisted `mockApplyStripeSubscriptionState` + sql helpers), add:
```typescript
  it('past_due → active recovery routes through the applier (checkout/by-accountId mode)', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'past_due' }]); // accounts FOR UPDATE
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: 'biz-1',
    });

    await processInvoicePaid({ id: 'in_1', customer: 'cus_1',
      lines: { data: [] }, subscription: 'sub_1' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: 'acct-1' },
      expect.objectContaining({ id: 'sub_1', status: 'active' }),
    );
    const inlineRecover = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(inlineRecover).toBeUndefined();
  });
```
(Adjust the invoice fixture `subscription`/`lines` shape to match how `invoiceSubscriptionId(invoice)` reads it — check `worker/ingress/stripe/shared.ts` for `invoiceSubscriptionId`. The existing trial-convert test in this file already builds a valid invoice fixture — copy its shape.)

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/ingress/stripe/__tests__/invoice-paid-trial.test.ts -- -t "recovery routes through the applier"
```
Expected: FAIL.

- [ ] **Step 3: Replace the inline recovery block with an applier call**

In `worker/ingress/stripe/invoice-paid.ts`:
- Near the top of `processInvoicePaid`, after `const customerId = …` resolves, compute the subscription id once (it is harmless for ACTIVE recovery — the applier COALESCEs ids and these accounts already have them):
```typescript
  const recoverySubscriptionId = invoiceSubscriptionId(invoice);
```
- Replace the inline recovery body (the per-`acct` block, currently lines 42-78: the `pg_advisory_xact_lock`, the `UPDATE accounts … 'active'`, the `writeAccountAuditLog`, the businesses UPDATE, the `enqueueStripeOverageRecompute`, and `recovered.push(acct)`) with:
```typescript
      await tx`SELECT pg_advisory_xact_lock(hashtext(${acct.id + ':status_change'}))`;

      // Single writer for the recovery transition (QUALITY-OBS): the applier
      // flips past_due→active, clears past_due_at, writes the audit row,
      // mirrors businesses, and enqueues the overage recompute — all in this tx.
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: acct.id },
        { id: recoverySubscriptionId ?? '', status: 'active', trial_end: null, customer: customerId },
      );
      if (transition.changed) recovered.push(acct);
```
Remove now-unused imports (`writeAccountAuditLog`, `enqueueStripeOverageRecompute`, `SubscriptionStatus` if no longer referenced) **only if lint flags them** — `SubscriptionStatus` is still used for the `=== SubscriptionStatus.TRIALING`/`.PAST_DUE` guards, so keep it. Leave the post-tx `convertTrialingAccounts(...)` and the `recovered`-driven backfill-resume loop unchanged.

- [ ] **Step 4: Run — verify PASS (whole file)**

```bash
pnpm test worker/ingress/stripe/__tests__/invoice-paid-trial.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: green (dead allowlist entries for `invoice-paid.ts:46,67,69` remain until B1.6).
```bash
git add worker/ingress/stripe/invoice-paid.ts worker/ingress/stripe/__tests__/invoice-paid-trial.test.ts
git commit -m "refactor(billing): invoice-paid recovery routes through the applier (QUALITY-OBS/B1.2)"
```

---

## Task B1.3: Consolidate `invoice-payment-failed` active→past_due (preserve recent-convert net-logic)

**Why:** `invoice-payment-failed.ts` already routes the *trial* card-fail through the applier (subscription mode). The `active`→past_due path (lines 55-114) is inline AND carries the **recent-convert net-logic** (`trial_converted − trial_payment_failed`) the applier does NOT own. Route the status write through the applier; keep the recent-convert block AFTER it, guarded on `transition.changed`.

**Files:**
- Modify: `worker/ingress/stripe/invoice-payment-failed.ts`
- Test: `worker/ingress/stripe/__tests__/invoice-failed-trial.test.ts`

- [ ] **Step 1: Add delegation + net-logic-preserved tests (failing)**

In `worker/ingress/stripe/__tests__/invoice-failed-trial.test.ts` (reuse hoisted `mockApplyStripeSubscriptionState`, `mockEnqueueTrialPaymentFailed`, sql helpers):
```typescript
  it('active → past_due routes through the applier AND still emits trial_payment_failed for a recent convert', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts FOR UPDATE
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: true }]); // recentConvert EXISTS → true

    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_1', subscription: 'sub_1' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: 'acct-1' },
      expect.objectContaining({ id: expect.anything(), status: 'past_due' }),
    );
    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acct-1', stripeSubscriptionId: 'sub_1' }),
    );
    const inlinePastDue = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'past_due'"),
    );
    expect(inlinePastDue).toBeUndefined();
  });

  it('active → past_due does NOT emit trial_payment_failed when there was no recent convert', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: false }]); // recentConvert EXISTS → false

    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_1', subscription: 'sub_1' } as any);
    expect(mockEnqueueTrialPaymentFailed).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/ingress/stripe/__tests__/invoice-failed-trial.test.ts -- -t "routes through the applier"
```
Expected: FAIL.

- [ ] **Step 3: Replace the inline active→past_due block; keep recent-convert after the applier**

In `worker/ingress/stripe/invoice-payment-failed.ts`, replace the `if (acctRow.subscription_status === SubscriptionStatus.ACTIVE) { … }` block (lines 55-114) with:
```typescript
    // Idempotent: only flip active → past_due. Route the status write through the
    // applier (QUALITY-OBS) in checkout/by-accountId mode — acctRow is already
    // resolved + FOR-UPDATE-locked, so no subscription id is needed to resolve.
    // PAST_DUE writes no Stripe ids, so the synthesized `id` is unused for this
    // target. The applier clears trial_ends_at, sets past_due_at, mirrors ALL
    // businesses (NOTE-A), and writes the audit row.
    if (acctRow.subscription_status === SubscriptionStatus.ACTIVE) {
      const failedSubscriptionId = invoiceSubscriptionId(invoice);
      const transition = await applyStripeSubscriptionState(
        tx,
        { mode: 'checkout', accountId: acctRow.id },
        { id: failedSubscriptionId ?? '', status: 'past_due', trial_end: null, customer: customerId },
      );

      if (transition.changed) {
        console.log(`${LOG_PREFIX} Account ${acctRow.id} marked past_due (customer=${customerId})`);

        // Conversion-analytics accuracy (UNCHANGED net-logic, NOT owned by the
        // applier): Stripe flips a trial trialing→active BEFORE the first renewal
        // charge, so a card-decline-AT-conversion lands on an already-'active'
        // account where trial_converted already fired. Emit trial_payment_failed
        // so net conversions = trial_converted − trial_payment_failed. Idempotent
        // (keyed by account+subscription); the :status_change advisory lock above
        // serializes the convert vs fail webhooks.
        if (failedSubscriptionId) {
          const [recentConvert] = await tx<{ ok: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM analytics_events
              WHERE account_id = ${acctRow.id}::uuid
                AND event_name = 'trial_converted'
                AND created_at > NOW() - INTERVAL '3 days'
            ) AS ok
          `;
          if (recentConvert?.ok) {
            await enqueueTrialPaymentFailed(tx, {
              accountId: acctRow.id,
              stripeSubscriptionId: failedSubscriptionId,
            });
          }
        }
      }
    } else {
      console.log(`${LOG_PREFIX} Account ${acctRow.id} already ${acctRow.subscription_status} — skipping past_due transition`);
    }
```
Remove now-unused imports (`writeAccountAuditLog` — the applier owns the audit write) **only if lint flags it**. Keep `enqueueTrialPaymentFailed`, `invoiceSubscriptionId`, `SubscriptionStatus`, `applyStripeSubscriptionState`. Leave the trialing path (lines 40-52) and the customer-resolve/advisory-lock unchanged.

- [ ] **Step 4: Run — verify PASS (whole file)**

```bash
pnpm test worker/ingress/stripe/__tests__/invoice-failed-trial.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: green (dead allowlist entries for `invoice-payment-failed.ts:58,79,81` remain until B1.6).
```bash
git add worker/ingress/stripe/invoice-payment-failed.ts worker/ingress/stripe/__tests__/invoice-failed-trial.test.ts
git commit -m "refactor(billing): invoice-payment-failed past_due via applier, recent-convert preserved (QUALITY-OBS/B1.3)"
```

---

## Task B1.4: Consolidate `checkout-completed` paid activation into the applier

**Why:** `checkout-completed.ts` already routes the *trial-start* through the applier (checkout mode). The paid activation (`pending_payment`/`past_due`→active, lines 89-167) is the largest inline block. Route it through the applier in checkout mode.

**Files:**
- Modify: `worker/ingress/stripe/checkout-completed.ts`
- Test: `worker/ingress/stripe/__tests__/checkout-trial.test.ts`

- [ ] **Step 1: Add a delegation test for paid activation (failing)**

In `worker/ingress/stripe/__tests__/checkout-trial.test.ts` (reuse the hoisted `mockApplyStripeSubscriptionState` + sql helpers; the file already mocks `getStripe`/`maybeEnqueueBackfillResume`):
```typescript
  it('paid activation (pending_payment → active) routes through the applier in checkout mode', async () => {
    // account lookup by refId resolves to an account
    sqlReturnQueue.push([{ id: 'acct-1' }]); // SELECT id FROM accounts WHERE id = refId
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'pending_payment', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: 'biz-1',
    });

    await processCheckoutSessionCompleted({
      client_reference_id: 'acct-1',
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: 7900,
      customer: 'cus_1',
      subscription: 'sub_1',
    } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: 'acct-1' },
      expect.objectContaining({ id: 'sub_1', status: 'active' }),
    );
    const inlineActivate = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(inlineActivate).toBeUndefined();
  });
```
(Use a `client_reference_id` that is a valid UUID if `UUID_RE` is enforced before the account lookup — check `checkout-completed.ts:21`; the existing trial tests in this file use a valid UUID fixture. Copy that constant.)

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/ingress/stripe/__tests__/checkout-trial.test.ts -- -t "paid activation"
```
Expected: FAIL.

- [ ] **Step 3: Replace the inline paid-activation `sql.begin` block with an applier call**

In `worker/ingress/stripe/checkout-completed.ts`, after the `if (!accountId) { … }` guard (line 69) and the trial-start path (lines 71-87), add a guard then replace the inline activation `sql.begin` (lines 89-167) with:
```typescript
  // Subscription-mode sessions always carry a subscription id; without one we
  // cannot persist the identifiers every later webhook needs — skip safely.
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed for ref ${refId} has no subscription id — skipping activation`);
    return;
  }

  // Single writer for the paid activation (QUALITY-OBS). checkout/by-accountId
  // mode behind the same ':activation' advisory lock. The applier flips
  // pending_payment/past_due→active, COALESCE-fills the Stripe ids
  // (first-writer-wins, invariant #3), clears trial_ends_at/past_due_at, sets
  // subscription_activated_at, writes the audit row, mirrors the primary business
  // (NOTE-A), and enqueues the overage recompute — all in one tx.
  const transition: TransitionResult = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${accountId! + ':activation'}))`;
    return applyStripeSubscriptionState(
      tx,
      { mode: 'checkout', accountId: accountId! },
      { id: subscriptionId, status: 'active', trial_end: null, customer: customerId },
    );
  });

  // Best-effort backfill resume — only after a real activation.
  if (transition.changed && transition.activated) {
    const resumeBusinessId = businessId ?? transition.primaryBusinessId;
    if (resumeBusinessId) {
      await maybeEnqueueBackfillResume(resumeBusinessId).catch((err) => {
        console.error(`${LOG_PREFIX} maybeEnqueueBackfillResume failed for business=${resumeBusinessId}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }
```
Delete the now-unused `import { v7 as uuidv7 } from 'uuid';` and the `jsonb` import **if** lint flags them (the inline raw audit INSERT that used them is gone). Remove the standalone `enqueueStripeOverageRecompute` import **if** no longer referenced (the applier owns the enqueue now). Keep `extractCustomerId`, `extractSubscriptionId`, `UUID_RE`, `maybeEnqueueBackfillResume`, `getStripe`, `applyStripeSubscriptionState`, `TransitionResult`.

- [ ] **Step 4: Run — verify PASS (whole file, incl. the trial-start tests)**

```bash
pnpm test worker/ingress/stripe/__tests__/checkout-trial.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
Expected: green (dead allowlist entries for `checkout-completed.ts:117,123,157,165` remain until B1.6).
```bash
git add worker/ingress/stripe/checkout-completed.ts worker/ingress/stripe/__tests__/checkout-trial.test.ts
git commit -m "refactor(billing): checkout paid activation routes through the applier (QUALITY-OBS/B1.4)"
```

---

## Task B1.5: Add per-transition applier coverage for PARITY-1/2 (if gaps exist)

**Why:** the spec's B1 acceptance asks for tests that each transition clears the right columns (PARITY-1) and COALESCEs ids (PARITY-2), plus mirror asymmetry. `apply-subscription-state.test.ts` is already comprehensive — add only the assertions it lacks.

**Files:**
- Test: `worker/ingress/stripe/__tests__/apply-subscription-state.test.ts`

- [ ] **Step 1: Audit existing coverage, add only missing assertions**

Read `worker/ingress/stripe/__tests__/apply-subscription-state.test.ts`. Confirm there are tests asserting, for each target:
- `active` UPDATE includes `trial_ends_at = NULL`, `past_due_at = NULL`, `subscription_activated_at = COALESCE`, and `stripe_customer_id = COALESCE` / `stripe_subscription_id = COALESCE` (PARITY-1 + PARITY-2).
- `past_due` UPDATE sets `past_due_at = NOW()` and `trial_ends_at = NULL`.
- `cancelled` UPDATE sets `cancelled_at = NOW()`, `trial_ends_at = NULL`, `past_due_at = NULL`.
- businesses mirror asymmetry: trialing/active update **primary only** (`is_primary = TRUE`); past_due/cancelled update **all** (no `is_primary` clause).

For any of the above NOT already asserted, add a focused test mirroring the existing style (`queueAccountRow(<from>)`, call `applyStripeSubscriptionState(mockSql, <ref>, <sub>)`, find the relevant `sqlCalls` entry, assert its `.text`). Example (only add if missing):
```typescript
  it('past_due mirror updates ALL businesses (no is_primary clause) — NOTE-A asymmetry', async () => {
    queueAccountRow('active');
    await applyStripeSubscriptionState(mockSql, subRef, { id: SUB_ID, customer: CUSTOMER_ID, status: 'past_due', trial_end: null });
    const bizUpdate = sqlCalls.find(
      (c) => /\bUPDATE\s+businesses\b/.test(c.text) && c.text.includes("'past_due'"),
    );
    expect(bizUpdate).toBeDefined();
    expect(bizUpdate!.text).not.toMatch(/is_primary/i);
  });
```

- [ ] **Step 2: Run — verify PASS**

```bash
pnpm test worker/ingress/stripe/__tests__/apply-subscription-state.test.ts
```
Expected: PASS.

- [ ] **Step 3: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add worker/ingress/stripe/__tests__/apply-subscription-state.test.ts
git commit -m "test(billing): per-transition column-clear/COALESCE/mirror coverage (PARITY-1/2, B1.5)"
```
(If Step 1 finds full coverage already exists, skip this task and note it in the PR body.)

---

## Task B1.6: Re-derive the static-policy literal allowlist (remove dead handler entries)

**Why:** B1.1-B1.4 deleted the inline `subscription_status = '<literal>'` SQL in the four handlers, so their `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` entries are now dead (repworth.md: "dangling refs and stale ticks are bugs"). The `apply-subscription-state.ts` entries also shifted (NOTE-B + B1.5 edits don't touch it, but B1.0 added the NOTE-B comment).

**Files:**
- Modify: `scripts/ci/static-policy-audit.ts`

- [ ] **Step 1: Re-derive the actual literal sites across the four handlers + the applier**

```bash
for f in checkout-completed invoice-paid invoice-payment-failed subscription-deleted apply-subscription-state; do
  echo "== worker/ingress/stripe/$f.ts =="
  grep -nE "subscription[_]?[Ss]tatus" worker/ingress/stripe/$f.ts \
    | grep -vE "^\s*[0-9]+:\s*(//|\*)" \
    | grep -E "'(active|trialing|past_due|cancelled|pending_payment)'"
done
```
This prints exactly the non-comment lines that still pair a `subscription_status` field with a bare status literal — i.e., the lines that MUST stay allowlisted. After B1 the four handlers should print **nothing** (all such SQL is gone); `apply-subscription-state.ts` should print its 8 SQL-predicate lines at their current numbers.

- [ ] **Step 2: Update `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST`**

In `scripts/ci/static-policy-audit.ts`:
- **Delete** the 12 dead handler entries: `checkout-completed.ts:117,123,157,165`, `invoice-paid.ts:46,67,69`, `invoice-payment-failed.ts:58,79,81`, `subscription-deleted.ts:97,119`.
- **Update** the 8 `apply-subscription-state.ts:NNN` entries to the line numbers printed in Step 1 (only if changed by B1.0).
- Leave all other entries (SQL predicates in pollers/schedulers, the dashboard view-model union) untouched.

- [ ] **Step 3: Verify the audit passes AND has no dead entries**

```bash
pnpm ci:static-policy
```
Expected: `static-policy-audit: passed`. Then confirm no allowlisted file:line is stale by re-running Step 1 — every remaining `apply-subscription-state.ts` entry must correspond to a printed line, and no handler entries remain. (An unused allowlist entry does not fail CI, but this PR removes them deliberately.)

- [ ] **Step 4: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add scripts/ci/static-policy-audit.ts
git commit -m "chore(ci): re-derive subscription-status literal allowlist after applier consolidation (B1.6)"
```

---

## Task B2: OVERAGE-F1 — account-scoped advisory lock around the overage sync

**Why:** the Stripe idempotency key is per-outbox-row (`overage-sync.ts:43-50`), not per-`(account, qty)`. No-double-bill rests on `concurrency:1` + a single Railway replica (boot-asserted at `worker/index.ts:184`). A second replica or redeploy-overlap could double-`create` an overage item → double-bill. An account-scoped `pg_advisory_xact_lock` held across the resolve→mutate serializes concurrent syncs and is the hard gate before any worker scale-out.

**Production-rule tension (production.md):** the lock is held across the Stripe call, tying a pooled connection (`max:10`). Acceptable: single consumer + infrequent events + bounded `getStripe()` timeout (a stuck call can't hold lock+connection indefinitely). Keep `concurrency:1` as defense-in-depth.

**Files:**
- Modify: `worker/jobs/billing/UpdateStripeOverageWorker.ts`
- Test: `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`

- [ ] **Step 1: Write the failing test — the sync runs inside a tx holding an advisory lock**

In `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`, the `mockSql` is hoisted. Add `sql.begin` support to the mock if not present, and capture the lock call. Add to the hoisted `mockSql` setup (mirror `apply-subscription-state.test.ts`'s tx-capable mock):
```typescript
  // make mockSql.begin run the callback with a tx that records its calls
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
```
Then add a test asserting the advisory lock is taken before the Stripe mutation. The simplest robust assertion: spy that a `pg_advisory_xact_lock` SQL call happens and `syncStripeOverageItem` runs inside `sql.begin`:
```typescript
  it('serializes the overage sync under an account-scoped advisory xact lock (OVERAGE-F1)', async () => {
    // arrange a happy-path account that reaches the sync (standard tier, active, has subscription)
    // … set up sqlReturnQueue for: account row, location count … (copy the happy-path test's setup)
    mockStripeSubscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [] } });

    await handleUpdateStripeOverage(makeJob({ account_id: 'acct-1' }));

    expect(mockSql.begin).toHaveBeenCalled();
    const lockCall = sqlCalls.find((c) => /pg_advisory_xact_lock/.test(c.text));
    expect(lockCall).toBeDefined();
    expect(lockCall!.text).toMatch(/hashtext/i);
  });
```
(Match the existing happy-path test's `sqlReturnQueue`/`makeJob` helpers in this file — reuse them; only add the `mockSql.begin` capture + the lock assertion.)

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts -- -t "advisory xact lock"
```
Expected: FAIL — `sql.begin` not called / no lock.

- [ ] **Step 3: Wrap the sync in a tx holding the advisory lock**

In `worker/jobs/billing/UpdateStripeOverageWorker.ts`, replace the `let outcome … try { outcome = await syncStripeOverageItem(getStripe(), { … }); } catch (err) { … }` block (lines 123-150) so the sync runs inside `sql.begin` under the lock. Keep the transient/terminal classification exactly as-is:
```typescript
  let outcome: OverageSyncOutcome;
  try {
    // OVERAGE-F1: serialize concurrent overage syncs for THIS account. The
    // per-outbox idempotency key (overage-sync.ts) does NOT dedup two DISTINCT
    // recompute rows for the same account, so a second replica or redeploy
    // overlap could double-`create` an overage item. The account-scoped
    // advisory lock (held across the Stripe resolve→mutate) closes that window
    // and is the hard gate before any worker scale-out. concurrency:1 +
    // single-replica remain as defense-in-depth (boot-asserted in index.ts).
    // The lock is held across the Stripe call; this is bounded by getStripe()'s
    // request timeout (single consumer + infrequent events → ~zero contention).
    outcome = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${account_id + ':overage_sync'}))`;
      return syncStripeOverageItem(getStripe(), {
        accountId: account_id,
        subscriptionId: account.stripe_subscription_id!,
        storedOveragePriceCents: account.locations_overage_price_cents,
        overagePriceId,
        newQuantity,
        operationScope,
      }, logger);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (classifyStripeOverageError(err) === 'transient') {
      await recordOutboxTransientError(outboxId, message, outboxAttempt);
      logger.error(`Transient Stripe overage error for account ${account_id} (will retry): ${message}`);
      throw err;
    }
    logger.error(`Terminal Stripe overage error for account ${account_id}: ${message}`);
    await markOutboxFailed(outboxId, message, outboxAttempt);
    throw new UnrecoverableError(message);
  }
```
**Note for the classifier:** a Postgres transport error raised while acquiring the lock now flows into `classifyStripeOverageError`. That classifier returns `terminal` for unknown errors — but a PG blip should retry. Verify `classifyStripeOverageError` (read `worker/jobs/billing/stripe-overage-error.ts`): it keys on Stripe `type`/`statusCode`/`code`. A raw PG error has none of those → it currently returns `terminal`. To preserve "transient infra retries" (CLAUDE.md cost-guard note), add a narrow guard at the TOP of the try's catch BEFORE classification: if the error is NOT a recognizable Stripe error (no `type` and no numeric `statusCode`) AND `syncStripeOverageItem` had not yet been entered, treat as transient. **Simpler and safer:** keep the lock acquisition's failure transient by checking for a Postgres error shape. Implement this only if a test proves it's needed; otherwise document the residual (a PG blip during lock acquisition fails the row, but the 1h outbox watchdog re-dispatches). **Decision for this task:** add a regression test asserting a thrown non-Stripe error from `sql.begin` is treated as transient (re-thrown, no `markOutboxFailed`); if it fails, add the guard. Keep it minimal.

- [ ] **Step 4: Add the PG-blip-is-transient regression test**

```typescript
  it('a Postgres error during lock acquisition is transient (no markOutboxFailed)', async () => {
    // … happy-path setup so we reach the sync …
    mockSql.begin = vi.fn(async () => { throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }); });

    await expect(handleUpdateStripeOverage(makeJob({ account_id: 'acct-1' }))).rejects.toThrow();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockRecordOutboxTransientError).toHaveBeenCalled();
  });
```
If this fails (because `classifyStripeOverageError` returns terminal for `ECONNRESET`), check whether `RETRYABLE_NETWORK_ERROR_CODES` in `src/lib/payments/stripe-error-inspect.ts` already includes `ECONNRESET` (it likely does — `classifyStripeOverageError` line 49 handles network codes). If it does, the test passes as-is. If a PG error shape slips through to terminal, add to the catch, before `classifyStripeOverageError`:
```typescript
    // A non-Stripe (e.g. Postgres pool/transport) error from the lock tx is infra,
    // not a deterministic Stripe failure — retry it (the watchdog re-dispatches).
    const looksLikeStripeError =
      typeof (err as { type?: unknown }).type === 'string'
      || typeof (err as { statusCode?: unknown }).statusCode === 'number';
    if (!looksLikeStripeError) {
      await recordOutboxTransientError(outboxId, message, outboxAttempt);
      logger.error(`Transient infra error during overage sync for account ${account_id} (will retry): ${message}`);
      throw err;
    }
```

- [ ] **Step 5: Run — verify PASS (whole file)**

```bash
pnpm test worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
```
Expected: PASS.

- [ ] **Step 6: Confirm the concurrency:1 boot-assert is untouched**

```bash
grep -n "assertSingleConcurrencyWorker" worker/index.ts
```
Expected: still present at ~line 184 (do NOT remove it).

- [ ] **Step 7: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add worker/jobs/billing/UpdateStripeOverageWorker.ts worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
git commit -m "fix(billing): account-scoped advisory lock around the overage sync (OVERAGE-F1/B2)"
```

---

## Task B3: RECONCILE-F5 — release resources on a timed-out reconcile cycle

**Why:** `withTimeout` (`src/lib/shared/with-timeout.ts`) races a deadline but does NOT cancel the work. On a cycle timeout, `runOnce` releases `inProgress` and the next tick runs — while the detached old cycle keeps iterating accounts, competing for the shared Postgres pool (`max:10`).

**SDK constraint (verified):** Stripe Node **v22.2.0** `RequestOptions` has **no `signal`/AbortSignal** field, so the spec's primary plan (pass `{ signal }` to the Stripe calls) is not available. Use the spec's authorized fallback, enhanced with SDK-independent loop control:
1. Thread an `AbortController` from `runOnce` into `reconcileCycle`; abort it when `withTimeout` rejects. The cycle's per-account loop checks `signal.aborted` and stops launching new account work (bounds a detached cycle to ≤1 in-flight account instead of the whole list). This needs no SDK support.
2. Pass an explicit per-request `{ timeout }` to the three Stripe reads in `reconcile-account.ts` so an in-flight call self-terminates within the account budget (the SDK `timeout` option aborts the socket and rejects), releasing its connection.
3. The trial-correction `sql.begin` (`reconcile-account.ts:156`) already runs **after** the Stripe reads resolve and contains **no** Stripe call — document this read-before-tx invariant + single-flight as the bound.

**Files:**
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts`
- Modify: `worker/background/pollers/billing-reconciliation/reconcile-account.ts`
- Test: `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
- Test: `worker/background/pollers/__tests__/reconcile-account.test.ts`

- [ ] **Step 1: Failing test — an aborted cycle stops iterating accounts**

In `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`, add a test that a cycle which exceeds `CYCLE_TIMEOUT_MS` does not keep processing accounts after the abort. The cleanest deterministic assertion: with a tiny `CYCLE_TIMEOUT_MS` override and N accounts where each `reconcileAccount` is slow, assert `reconcileAccount` is invoked fewer than N times once the controller aborts. If the test harness makes timing flaky, instead unit-test the loop's abort check directly (Step 1 alt):
```typescript
  it('stops launching new per-account reconciles once the cycle is aborted', async () => {
    // mock reconcileAccount to resolve, count invocations; mock sql to return 3 accounts;
    // drive runOnce with CYCLE_TIMEOUT_MS forced small enough that the controller aborts mid-loop.
    // Assert reconcileAccount call count < 3 (the loop bailed on signal.aborted).
  });
```
Prefer a **direct unit test of `reconcileCycle(signal)`**: pass an already-aborted `AbortSignal` and assert it processes zero accounts and returns `{accountsChecked:0,...}`.

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts -- -t "aborted"
```
Expected: FAIL (signal not yet threaded).

- [ ] **Step 3: Thread the AbortController through the poller**

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`:
- In `runOnce`, create a controller and abort it when the cycle times out:
```typescript
  inProgress = true;
  const controller = new AbortController();
  try {
    return await withTimeout(reconcileCycle(controller.signal), CYCLE_TIMEOUT_MS, 'reconcile cycle');
  } catch (err) {
    // The detached cycle promise may still settle later. Abort so it stops
    // launching NEW per-account work (the in-flight account finishes under its
    // own bounded Stripe timeout, then the cycle unwinds and frees its pool
    // connection). SDK v22 has no AbortSignal on Stripe requests, so we cannot
    // cancel the in-flight HTTP call — the per-request timeout bounds it instead.
    controller.abort();
    logger.error(
      err instanceof TimeoutError
        ? 'Reconcile cycle exceeded its deadline — releasing the run so the next tick proceeds'
        : 'Reconcile cycle failed — releasing the run so the next tick proceeds',
      err,
    );
    return { accountsChecked: 0, driftsFound: 0, errors: 1 };
  } finally {
    inProgress = false;
  }
```
- Change `reconcileCycle` to accept the signal and check it before each account:
```typescript
async function reconcileCycle(signal: AbortSignal): Promise<ReconcileResult> {
  // … unchanged accounts query …
  for (const account of accounts) {
    if (signal.aborted) {
      logger.log('Cycle aborted (deadline exceeded) — stopping before remaining accounts');
      break;
    }
    try {
      const outcome = await withTimeout(
        reconcileAccount(stripe, account),
        ACCOUNT_TIMEOUT_MS,
        `reconcile account ${account.id}`,
      );
      // … unchanged tally …
```

- [ ] **Step 4: Add bounded per-request timeout to the three Stripe reads**

In `worker/background/pollers/billing-reconciliation/reconcile-account.ts`, pass an options object with `timeout` (use a module constant just under the account budget) to each read. Add near the top:
```typescript
// Per-request Stripe timeout — just under the orchestrator's per-account budget
// (ACCOUNT_TIMEOUT_MS=60s) so an in-flight read self-terminates and frees its
// connection rather than hanging on the SDK's default. SDK v22 has no
// AbortSignal, so this request timeout is the cancellation mechanism.
const STRIPE_READ_TIMEOUT_MS = 20_000;
```
Then:
- `subscription = await stripe.subscriptions.retrieve(account.stripe_subscription_id, { timeout: STRIPE_READ_TIMEOUT_MS });` (line 86-88)
- `const customerSubscriptions = await stripe.subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 100 }, { timeout: STRIPE_READ_TIMEOUT_MS });` (line 113-117)
- `const upcoming = await stripe.invoices.createPreview({ customer: stripeCustomerId, subscription: account.stripe_subscription_id }, { timeout: STRIPE_READ_TIMEOUT_MS });` (line 297-300)
- Add a one-line comment above the trial-correction `sql.begin` (line 156) documenting the invariant: `// Read-before-tx invariant: all Stripe reads above have resolved; this tx holds a pool connection only for fast DB writes, never across a Stripe call.`

The `reconcile-account.test.ts` fake Stripe accepts a second arg already (mocked fns ignore extra args), so existing tests stay green; add one asserting the timeout is passed if desired:
```typescript
  it('passes a bounded per-request timeout to subscriptions.retrieve', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2) });
    await reconcileAccount(stripe, makeAccount());
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123', expect.objectContaining({ timeout: expect.any(Number) }));
  });
```

- [ ] **Step 5: Run — verify PASS**

```bash
pnpm test worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
pnpm test worker/background/pollers/__tests__/reconcile-account.test.ts
```
Expected: PASS.

- [ ] **Step 6: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add worker/background/pollers/StripeLocationsReconcilePoller.ts worker/background/pollers/billing-reconciliation/reconcile-account.ts worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts worker/background/pollers/__tests__/reconcile-account.test.ts
git commit -m "fix(billing): abort-on-deadline + bounded Stripe read timeouts in reconcile (RECONCILE-F5/B3)"
```

---

## Task B4: RECONCILE-F1 — lightweight `locations_paid` drift-observability check

**Why:** `accounts.locations_paid` is written from Stripe (`subscription-updated.ts:183`) and read only for the dashboard "billing pending" badge (`aggregate-service.ts:56`). Billing math derives overage from a live `COUNT` (`quota.ts`), never `locations_paid`. Reconcile never compares it. Add a read-only drift signal (no auto-correction).

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/types.ts` (add `locations_paid` to `AccountWithLocations` + `locations_paid_mirror` to `DriftFinding['type']`)
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts` (select `locations_paid`)
- Modify: `worker/background/pollers/billing-reconciliation/reconcile-account.ts` (the comparison)
- Test: `worker/background/pollers/__tests__/reconcile-account.test.ts`

- [ ] **Step 1: Failing test — a seeded mismatch emits a `locations_paid_mirror` drift; a match stays quiet**

In `worker/background/pollers/__tests__/reconcile-account.test.ts`, extend `makeAccount` to allow `locations_paid` (add `locations_paid: 0` to the default object), then:
```typescript
  it('emits a locations_paid_mirror drift when the DB mirror disagrees with Stripe overage qty', async () => {
    // Stripe overage quantity = 2, but the DB mirror says 5 → drift.
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    const outcome = await reconcileAccount(stripe, makeAccount({ locations_paid: 5, active_location_count: 3 }));
    expect(outcome.drifts.some((d) => d.driftType === 'locations_paid_mirror')).toBe(true);
  });

  it('does NOT emit a locations_paid_mirror drift when the mirror matches Stripe overage qty', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    const outcome = await reconcileAccount(stripe, makeAccount({ locations_paid: 2, active_location_count: 3 }));
    expect(outcome.drifts.some((d) => d.driftType === 'locations_paid_mirror')).toBe(false);
  });
```

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/background/pollers/__tests__/reconcile-account.test.ts -- -t "locations_paid_mirror"
```
Expected: FAIL (type missing / no comparison).

- [ ] **Step 3: Add the type + column + comparison**

- In `worker/background/pollers/billing-reconciliation/types.ts`:
  - Add `locations_paid: number;` to `AccountWithLocations` (after `locations_included`, line 7).
  - Add `| 'locations_paid_mirror'` to the `DriftFinding['type']` union (after `'unknown_stripe_state'`, line 46).
- In `worker/background/pollers/StripeLocationsReconcilePoller.ts`, add `a.locations_paid,` to the SELECT (after `a.locations_included,`, line ~117) **and** to the `GROUP BY` (after `a.locations_included,`, line ~131).
- In `worker/background/pollers/billing-reconciliation/reconcile-account.ts`, after `stripeOverageQuantity` is computed (line 210), add the comparison:
```typescript
  // RECONCILE-F1: observability-only check on the near-vestigial locations_paid
  // mirror (written from Stripe in subscription-updated, read only for the
  // dashboard "billing pending" badge — no billing math reads it). A mismatch
  // vs the live Stripe overage quantity means a missed subscription.updated
  // webhook. Surfaced at warning; NOT auto-corrected (it doesn't bill).
  if (account.locations_paid !== stripeOverageQuantity) {
    drifts.push({
      driftType: 'locations_paid_mirror',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `accounts.locations_paid mirror (${account.locations_paid}) differs from Stripe overage quantity (${stripeOverageQuantity}) for account ${account.id}`,
    });
  }
```
`emitDriftAlert` already emits any `driftType` at `level:'warning'` with `feature:'stripe_reconciliation'` (drift-alert.ts:46-53) — no change needed there.

- [ ] **Step 4: Run — verify PASS**

```bash
pnpm test worker/background/pollers/__tests__/reconcile-account.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add worker/background/pollers/billing-reconciliation/types.ts worker/background/pollers/StripeLocationsReconcilePoller.ts worker/background/pollers/billing-reconciliation/reconcile-account.ts worker/background/pollers/__tests__/reconcile-account.test.ts
git commit -m "feat(billing): locations_paid mirror drift-observability check (RECONCILE-F1/B4)"
```

---

## Task B5a: RECONCILE-F3 — document the pending_payment backstop

**Why:** the reconcile query excludes `pending_payment` (`StripeLocationsReconcilePoller.ts:125` selects only ACTIVE/PAST_DUE/TRIALING). Verified: `StripeCheckoutReconcileWorker` (`worker/jobs/billing/StripeCheckoutReconcileWorker.ts`) owns missed-activation by retrieving the Checkout Session and re-running `processCheckoutSessionCompleted`. This is a P3 nit — document the backstop; no logic change.

**Files:**
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts`

- [ ] **Step 1: Verify the backstop is registered**

```bash
grep -n "StripeCheckoutReconcile\|STRIPE_CHECKOUT_RECONCILE" worker/index.ts worker/queues.ts | head
```
Expected: the worker is registered against `QUEUE_NAMES.STRIPE_CHECKOUT_RECONCILE`. If it is NOT registered/scheduled anywhere, STOP and flag a real coverage gap (the spec then requires adding bounded `pending_payment` reconcile coverage — out of this doc-only task).

- [ ] **Step 2: Add the explanatory comment to the reconcile query**

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`, immediately above the `WHERE a.subscription_status IN (…)` line (line 125), add:
```typescript
    -- RECONCILE-F3: pending_payment is intentionally excluded. Missed activation
    -- is owned by StripeCheckoutReconcileWorker (worker/jobs/billing/), which
    -- re-retrieves the Checkout Session and re-runs processCheckoutSessionCompleted.
    -- This poller reconciles only entitled/billable states.
```
(SQL line comments are fine inside a postgres.js `sql\`\`` template.)

- [ ] **Step 3: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add worker/background/pollers/StripeLocationsReconcilePoller.ts
git commit -m "docs(billing): document StripeCheckoutReconcileWorker as the pending_payment backstop (RECONCILE-F3/B5a)"
```

---

## Task B5b: RECONCILE-F6 — scope the duplicate-subscription scan to the account's own lineage

**Why:** the duplicate scan lists ALL active subs for the customer and flags if `>1` (`reconcile-account.ts:113-134`), assuming one Stripe customer ↔ one account. If a customer maps to multiple RepWorth accounts, subs owned by *other* accounts false-positive. Exclude subs mapped to a different account before flagging.

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/reconcile-account.ts`
- Test: `worker/background/pollers/__tests__/reconcile-account.test.ts`
- Possibly modify: `scripts/ci/tenant-scope-allowlist.ts`

- [ ] **Step 1: Failing test — a sibling-account sub does not trigger duplicate_subscription**

The duplicate scan needs a way to know which sub ids belong to OTHER accounts. The test must control that lookup. Since `reconcile-account.ts` imports `sql` directly, mock it in this test file (the file currently uses NO `sql` mock — add a minimal hoisted `sql` mock that returns a controllable queue), OR inject. Add a hoisted `sql` mock to `reconcile-account.test.ts`:
```typescript
const { mockSql, sqlReturnQueue } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn(() => {
    const q = sqlReturnQueue.shift();
    return Promise.resolve(q ?? Object.assign([], { count: 0 }));
  });
  mockSql.begin = vi.fn(async (cb: any) => cb(mockSql));
  return { mockSql, sqlReturnQueue };
});
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
```
Then:
```typescript
  it('does NOT flag duplicate_subscription when the extra active sub belongs to another account', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2),
      list: { data: [
        { id: 'sub_123', status: 'active' },   // this account's
        { id: 'sub_other', status: 'active' },  // a sibling account's
      ] },
      createPreview: makePreview(2),
    });
    // the lineage query reports sub_other belongs to a DIFFERENT account
    sqlReturnQueue.push([{ stripe_subscription_id: 'sub_other' }]);
    const outcome = await reconcileAccount(stripe, makeAccount());
    expect(outcome.drifts.some((d) => d.driftType === 'duplicate_subscription')).toBe(false);
  });

  it('DOES flag duplicate_subscription when 2+ active subs belong to THIS account lineage', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2),
      list: { data: [
        { id: 'sub_123', status: 'active' },
        { id: 'sub_dupe', status: 'active' },
      ] },
      createPreview: makePreview(2),
    });
    sqlReturnQueue.push([]); // neither sub maps to another account
    const outcome = await reconcileAccount(stripe, makeAccount());
    expect(outcome.drifts.some((d) => d.driftType === 'duplicate_subscription')).toBe(true);
  });
```
**Caution:** adding a `sql` mock changes how the EXISTING trial-correction tests in this file behave (they previously hit the real `sql.begin`? — no, reconcile-account imports `sql` and the existing tests don't exercise the trial-correction path, but verify). Run the whole file after wiring the mock and fix any test that now needs a queued return.

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test worker/background/pollers/__tests__/reconcile-account.test.ts -- -t "duplicate_subscription"
```
Expected: FAIL (sibling sub still flags).

- [ ] **Step 3: Scope the scan to the account's lineage**

In `worker/background/pollers/billing-reconciliation/reconcile-account.ts`, after `const activeSubscriptions = activeStripeSubscriptions(customerSubscriptions);` (line 118), insert:
```typescript
      // RECONCILE-F6: a Stripe customer can map to MORE THAN ONE RepWorth account.
      // Only active subs NOT owned by a DIFFERENT account count toward THIS
      // account's duplicate check (this account's own sub + any unmapped orphan).
      let ownLineageSubs = activeSubscriptions;
      if (activeSubscriptions.length > 1) {
        const activeIds = activeSubscriptions.map((s) => s.id);
        const otherAccountSubs = await sql<{ stripe_subscription_id: string }[]>`
          SELECT stripe_subscription_id
          FROM accounts
          WHERE stripe_customer_id = ${stripeCustomerId}
            AND id <> ${account.id}::uuid
            AND stripe_subscription_id = ANY(${activeIds})
        `;
        const otherIds = new Set(otherAccountSubs.map((r) => r.stripe_subscription_id));
        ownLineageSubs = activeSubscriptions.filter((s) => !otherIds.has(s.id));
      }
      if (ownLineageSubs.length > 1) {
```
and change the existing `if (activeSubscriptions.length > 1) {` (line 119) to use `ownLineageSubs` in the drift message too:
```typescript
          driftMessage: `Duplicate active Stripe subscriptions for account ${account.id}: ${ownLineageSubs.map((sub) => sub.id).join(',')}`,
```
(i.e., replace the old `if (activeSubscriptions.length > 1)` guard with the `if (ownLineageSubs.length > 1)` computed above; keep the drift payload otherwise unchanged.)

- [ ] **Step 4: Run — verify PASS (whole file)**

```bash
pnpm test worker/background/pollers/__tests__/reconcile-account.test.ts
```
Expected: PASS.

- [ ] **Step 5: tenant-scope audit — allowlist the new cross-account query if flagged**

```bash
pnpm ci:tenant-scope
```
If it flags the new `SELECT … FROM accounts WHERE stripe_customer_id = … AND id <> …` in `reconcile-account.ts` (cross-account read), add a snippet entry to `scripts/ci/tenant-scope-allowlist.ts` (reconcile is an intentional cross-account consumer, like margin-service). Copy the exact SQL snippet the audit prints, add a `{ file: 'worker/background/pollers/billing-reconciliation/reconcile-account.ts', … }` entry with a justification comment, and bump `ALLOWLIST_BASELINE` if the count changed. Re-run `pnpm ci:tenant-scope` → green.

- [ ] **Step 6: Full gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```
```bash
git add worker/background/pollers/billing-reconciliation/reconcile-account.ts worker/background/pollers/__tests__/reconcile-account.test.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "fix(billing): scope duplicate-subscription scan to the account's own lineage (RECONCILE-F6/B5b)"
```

---

## Task B6: CONFIG-1 — verify drift-alert routing (ops; code only if routing can't carry warning)

**Why:** `drift-alert.ts:46-53` emits drift at Sentry `level:'warning'` with tag `feature:'stripe_reconciliation'`. Confirm the Sentry→Discord/pager rule routes that (else drift is captured-but-not-paged). Spec decision = verify first; only bump revenue-affecting drift to `level:'error'` if routing can't carry `warning`.

**Files:**
- Verify only (default). Conditional modify: `worker/background/pollers/billing-reconciliation/drift-alert.ts`, `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
- Modify (always): `docs/runbooks/beta-launch-alerting.md` (record the verification)

- [ ] **Step 1: Verify the Sentry alert rule routes warning + feature:stripe_reconciliation**

Use the Sentry MCP (load tool schemas via ToolSearch: `mcp__sentry__find_projects`, `mcp__sentry__search_sentry_tools`/`mcp__sentry__execute_sentry_tool` for alert rules) against the `repworth-nv` org / worker project. Confirm an issue-alert/metric-alert rule fires on `level:warning` (or any level ≥ warning) for events tagged `feature:stripe_reconciliation` and routes to the Discord/pager integration configured in Sentry Step 2 (see memory S1164/S1165). Cross-reference `docs/runbooks/beta-launch-alerting.md`.

- [ ] **Step 2a: If routing carries warning → document, no code change**

Add a dated note to `docs/runbooks/beta-launch-alerting.md` under the drift-alert section:
```markdown
> **CONFIG-1 verified (2026-06-2x):** the Sentry→Discord rule routes
> `level:warning` events tagged `feature:stripe_reconciliation` (drift alerts
> from `drift-alert.ts`). No level bump needed — billing reconcile drift pages.
```
Commit:
```bash
git add docs/runbooks/beta-launch-alerting.md
git commit -m "docs(billing): verify Sentry routes reconcile drift at warning (CONFIG-1/B6)"
```

- [ ] **Step 2b: ONLY if routing CANNOT carry warning → bump revenue-affecting drift to error**

Make the Sentry level conditional on `driftType` in `emitDriftAlert` (`drift-alert.ts`): revenue-affecting types (`quantity_mismatch`, `price_mismatch`, `upcoming_invoice_mismatch`, `missing_subscription`, `duplicate_subscription`) → `level:'error'`; benign/observability types (`status_mismatch`, `locations_paid_mirror`) → `level:'warning'`. Add a test in `StripeLocationsReconcilePoller.test.ts` asserting the level per driftType. Then document the change in `beta-launch-alerting.md`. Commit:
```bash
git add worker/background/pollers/billing-reconciliation/drift-alert.ts worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts docs/runbooks/beta-launch-alerting.md
git commit -m "fix(billing): page revenue-affecting reconcile drift at error level (CONFIG-1/B6)"
```

- [ ] **Step 3: Full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
```

---

## Task B7: Capture the `locations_paid` retirement as a tracked follow-up

**Why:** spec §5/B4 — retiring the vestigial `locations_paid` column (and rederiving the dashboard badge from the live count, "one owner per fact") is explicitly a tracked follow-up, NOT this sweep.

**Files:**
- Create: `docs/future-plans/2026-06-23-retire-locations-paid-mirror.md`

- [ ] **Step 1: Write the follow-up note**

```bash
mkdir -p docs/future-plans
```
Create `docs/future-plans/2026-06-23-retire-locations-paid-mirror.md`:
```markdown
# Follow-up: retire the `accounts.locations_paid` mirror

**Source:** 2026-06-23 core-billing-audit RECONCILE-F1; deferred from PR B (spec §5/B4).

`locations_paid` is written from Stripe (`subscription-updated.ts`) and read ONLY
for the dashboard "billing pending" badge (`aggregate-service.ts`). No billing
math reads it (`quota.ts` derives overage from a live `COUNT`). PR B added a
drift-observability check (`locations_paid_mirror`) but did NOT remove the column.

**To retire ("one owner per fact"):**
1. Rederive the dashboard "billing pending" badge from the live active-location
   count vs Stripe overage quantity (or `locations_included` + live overage),
   removing the `locations_paid` read in `aggregate-service.ts`.
2. Drop the write in `subscription-updated.ts` + the `locations_paid_mirror`
   drift check in `reconcile-account.ts` (no longer meaningful).
3. Migration: drop `accounts.locations_paid` (+ any audit references).
4. Update `.claude/reference/migrations-log.md` and `docs/directory.md`.

Tracked, not scheduled.
```

- [ ] **Step 2: Commit**

```bash
git add docs/future-plans/2026-06-23-retire-locations-paid-mirror.md
git commit -m "docs(billing): track locations_paid mirror retirement as a follow-up (RECONCILE-F1)"
```

---

## Task FINAL: Full gate, staging soak, then PR to main

**Files:** none (verification + promotion).

- [ ] **Step 1: Full local gate (same as CI) on the whole branch**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:analytics-events && pnpm ci:static-policy
pnpm verify:stripe-prices
```
Expected: all green. (`verify:stripe-prices` per spec §6 gates.)

- [ ] **Step 2: Confirm no dead allowlist entries / dangling refs**

```bash
# the four handlers must no longer carry inline status-literal SQL:
grep -nE "subscription_status = '(active|trialing|past_due|cancelled|pending_payment)'" \
  worker/ingress/stripe/checkout-completed.ts worker/ingress/stripe/invoice-paid.ts \
  worker/ingress/stripe/invoice-payment-failed.ts worker/ingress/stripe/subscription-deleted.ts \
  && echo "STILL HAS INLINE LITERALS (must be empty)" || echo "CLEAN"
```
Expected: `CLEAN`. And every `apply-subscription-state.ts:NNN` entry in the allowlist maps to a real literal line (re-run B1.6 Step 1's grep).

- [ ] **Step 3: Push the branch to `staging` for the soak (PR B is money-path)**

PR B touches the worker, webhooks, and billing → it MUST soak on `staging` before main. **`staging` is independently diverged from `main`** (can't ff). Coordinate the deploy with the owner — do NOT force-merge `main` into `staging` here. Options to surface to the owner:
- (a) Open the PR to `main` first (gets CI green + review), then deploy this branch's worker to the Railway **staging** service for the soak (per `docs/runbooks/deployment-guide.md` Phase 3), OR
- (b) Merge this branch into `staging` (a normal merge, not ff) to auto-deploy the full staging stack, soak, then open the PR to `main`.

```bash
git push -u origin billing/audit-remediation-pr-b
```

- [ ] **Step 4: Staging soak — exercise the money paths with Stripe test clocks**

Per spec §6 / the audit's Phase B method, against the deployed staging worker:
- **convert** (trial → active): trial checkout, advance a test clock past `trial_end`, confirm `subscription_status=active`, `trial_ends_at=NULL`, `subscription_activated_at` set, `trial_converted` analytics.
- **decline** (active card-fail at conversion): confirm `past_due` + `trial_payment_failed` net-logic still fires.
- **cancel**: `customer.subscription.deleted` → `cancelled`, all businesses mirrored, `trial_cancelled` only if from trial.
- **overage ↑↓**: add/archive a location, confirm exactly one Stripe overage item mutation (B2 lock holds; no double-create).
- **reconcile**: seed a `locations_paid` mismatch and a stuck-trialing row; confirm the drift signal + the trial auto-correction; confirm a cycle that overruns releases its connection (B3).
Record results in the PR body.

- [ ] **Step 5: Open PR B → `main`**

```bash
gh pr create --base main --head billing/audit-remediation-pr-b \
  --title "billing: robustness + status-applier consolidation (audit PR B)" \
  --body "$(cat <<'EOF'
PR B of the 2026-06-23 core-billing-audit remediation (money-path half). Spec:
docs/superpowers/specs/2026-06-23-core-billing-audit-remediation-design.md §5

- B1 QUALITY-OBS: consolidate the 4 inline status transitions into the single
  applier (apply-subscription-state.ts). Auto-fixes PARITY-1 (column clears) and
  PARITY-2 (id COALESCE). Preserves NOTE-A mirror asymmetry, NOTE-B mapping,
  invoice-payment-failed's trial_converted−trial_payment_failed net-logic.
- B2 OVERAGE-F1: account-scoped pg_advisory_xact_lock around the overage sync;
  concurrency:1 boot-assert kept.
- B3 RECONCILE-F5: abort-on-deadline loop control + bounded per-request Stripe
  read timeouts (SDK v22 has no AbortSignal); read-before-tx invariant documented.
- B4 RECONCILE-F1: locations_paid mirror drift-observability check (no auto-fix).
- B5a RECONCILE-F3: document StripeCheckoutReconcileWorker as the pending_payment backstop.
- B5b RECONCILE-F6: scope the duplicate-subscription scan to the account's lineage.
- B6 CONFIG-1: verify (or fix) Sentry routing for reconcile drift.
- NOTE-B comment folded in. locations_paid retirement tracked in docs/future-plans/.

Money-path: soaked on staging with Stripe test clocks (convert/decline/cancel/
overage↑↓/reconcile) before this PR. Full gate green (lint/typecheck/test/build +
tenant-scope/rls-audit/analytics-events/static-policy + verify:stripe-prices).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opens; the 4 CI checks start.

- [ ] **Step 6: After CI green + staging soak clean + merge**

Per CLAUDE.md, keep `staging` from drifting after promotion where possible (`git merge --ff-only main` onto `staging` if it can ff; otherwise reconcile the diverged `staging` as a separate ops task — do not block PR B on it).

---

## Self-review notes (author)

- **Spec §5 coverage:** B1 QUALITY-OBS → B1.0-B1.6 (contract + 4 handlers + applier tests + allowlist); B2 OVERAGE-F1 → B2; B3 RECONCILE-F5 → B3; B4 RECONCILE-F1 → B4 (+ retirement follow-up B7); B5 RECONCILE-F3/F6 → B5a/B5b; B6 CONFIG-1 → B6; NOTE-B → folded into B1.0. All §5 items have a task.
- **SDK reality:** Stripe v22.2.0 has no `RequestOptions.signal` (verified in `node_modules/stripe/esm/lib.d.ts`), so B3 uses the spec's authorized fallback (reads-before-tx + bounded per-request `timeout`) + an SDK-independent AbortController for loop control. Documented in B3.
- **Behavior-preservation:** every B1 sub-task asserts delegation to the applier and that the inline SQL is gone; the applier's correctness (column clears, COALESCE, NOTE-A asymmetry) is covered by `apply-subscription-state.test.ts` (B1.5 fills gaps). Two intentional alignments (checkout COALESCE + deprecated businesses.stripe_* no longer written; past_due/cancelled mirror all businesses) are spec invariants, flagged in commit bodies.
- **CI traps handled:** B1.6 re-derives the static-policy literal allowlist (removes 12 dead handler entries, updates 8 applier entries); B5b adds a tenant-scope allowlist entry if the new cross-account query trips the audit. The FULL gate runs after every task.
- **Type/name consistency:** `applyStripeSubscriptionState(tx, ApplyStripeRef, Pick<Subscription>)` used identically across B1.1-B1.4; `TransitionResult.changed`/`.activated`/`.primaryBusinessId` used in checkout/invoice-paid; `locations_paid_mirror` driftType added to the `DriftFinding['type']` union AND used in `reconcile-account.ts`; `locations_paid` added to `AccountWithLocations` AND selected in the poller query AND read in reconcile.
- **Promotion:** money-path → staging soak first (Task FINAL), then PR to main; staging divergence is an ops task, not a PR-B blocker (handoff gotcha #3).
- **Open verification at execution time:** B5b changes how `reconcile-account.test.ts` mocks `sql` — re-run the whole file and fix any pre-existing test that newly needs a queued return; B2's PG-blip-transient guard is added only if the regression test proves `classifyStripeOverageError` mislabels it terminal.
