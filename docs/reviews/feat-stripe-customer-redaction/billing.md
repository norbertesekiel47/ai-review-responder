# Review — BILLING risk axis

- **Reviewed SHA:** `00f6d56be77d77b4f1e45ff28a99b7c6bda778fe`
- **Fork point:** `b9fb96016cc025c151f17db4b39baf165cb80a13`
- **How files were read:** every production file was read via `git show 00f6d56b:<path>` and `git diff b9fb9601..00f6d56b -- <path>`, never the working tree (a sibling red-team agent is mutating source in this worktree). SDK facts were read from the installed package at `node_modules/.pnpm/stripe@22.2.0_@types+node@25.9.1/node_modules/stripe/cjs/resources/Customers.d.ts`, which is not under source control and therefore not subject to that mutation.
- **Axis:** source-of-truth amounts, idempotency, reconciliation, rounding, status transitions, retries, duplicate events.
- **Scope note:** read-only review. No file outside this report was touched.

---

## Verified clean (the axis's load-bearing claims, checked rather than assumed)

These are stated first because several of them are the premises the rest of the design rests on, and each was independently confirmed at the reviewed SHA.

1. **`customers.del` is never called, anywhere on the branch.** `git grep -n "customers\.del\|\.del(" 00f6d56b` returns no production hit. `src/lib/account-offboarding/stripe-customer-redaction.ts` declares its own narrow client (`:91-104`) exposing only `retrieve` and `update`, so the singleton's `del` is not even reachable through the injected type.

2. **All eight cleared fields exist on `CustomerUpdateParams` in the pinned SDK.** `stripe@22.2.0`, `cjs/resources/Customers.d.ts:582+`: `address?: Emptyable<AddressParam>`, `business_name?: Emptyable<string>`, `individual_name?: Emptyable<string>`, `shipping?: Emptyable<Shipping>`, and `name`/`email`/`phone`/`description` as plain `string`. `''` is therefore a legal clear for all eight, and the params object being typed `Record<string, unknown>` (`stripe-customer-redaction.ts:100`) does not hide an unknown-parameter 400.

3. **Money genuinely survives.** `CustomerUpdateParams` carries no `tax_id_data` (that param exists only on create), so `tax_ids` is unreachable exactly as `PROVIDER_DATA_RETENTION` claims (`table-disposition.ts:450-458`). Paid invoices are separate immutable objects; nothing in the update touches them.

4. **Open receivables are not stranded by clearing `email`.** Teardown voids them first: `worker/jobs/account-offboarding/teardown-stripe.ts:62-64` cancels the subscription and then calls `cleanupSubscriptionInvoices`, which finalizes drafts and voids `open`/`uncollectible` invoices (`src/lib/account-offboarding/stripe-invoices.ts:230-243`). Redaction runs strictly after teardown, so no collectible invoice loses its delivery address.

5. **The D9 rollback claim holds.** `worker/ingress/stripe/checkout-completed.ts:329` retrieves the subscription live from Stripe; at `:628-637` a transition that is not `activated` throws `CheckoutRemediationRequiredError('checkout_status_binding_failed')`, which rolls the transaction back and, in the catch at `:689-700`, cancels the unexpected subscription and marks the attempt remediated. The account is left at `pending_payment`. So an acked `customer.subscription.deleted` cannot leave an account wrongly `active`.

6. **Subscription lineage is preserved in `subscription-deleted`.** The new age branch sits entirely inside the `acctRows.length === 0` arm (`worker/ingress/stripe/subscription-deleted.ts:61-83`), strictly before the lineage resolution at `:91` (`acctRows.find((a) => a.stripe_subscription_id === subscriptionId)`). When any account row exists the control flow is byte-identical to the fork point.

7. **`provider_dispositions` cannot be NULL-wiped by the new `||` append.** `supabase/migrations/056_account_offboarding.sql:64-65` declares it `JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(...) = 'array')`. The new `type: 'stripe_customer_redaction'` discriminator collides with no existing reader (`job_outbox_scrub_scope`, `impersonation_session_scrub_scope`, `admin_provider_disposition`), and `verifyAccountOffboardingPurge`'s `account_offboardings` arm (`src/lib/account-offboarding/purge-verification.ts:586-601`) does not inspect the column, so the new record cannot fail purge verification.

8. **The alert class really does stop.** `checkFailedInboundEvents` counts `status = 'failed'` only (pinned in `scripts/ci/tenant-scope-allowlist.ts:387`), so `stale_ignored` is excluded, and `claimInboundEvent` reclaims it (`worker/ingress/shared.ts:64-70`) so replay is not lost to a `duplicate` short-circuit.

9. **No deadlock cycle exists today from the second advisory lock.** Traced every `acquireStripeCustomerBindingLock` holder: `applyStripeSubscriptionStateInternal` (`worker/ingress/stripe/apply-subscription-state.ts:323-326`) always runs with the account-scoped entitlement lock already held by its caller, and `runStripeCustomerRedactionPurgeStage` holds only the binding lock plus one `account_offboardings` row. The one candidate ABBA edge — checkout-completed locking an `account_offboardings` row before requesting the binding lock — does **not** exist: the `LEFT JOIN account_offboardings` at `checkout-completed.ts:509-556` carries no `FOR UPDATE` clause. See P2-2 for why this is nonetheless recorded as a latent hazard.

---

## Findings

### P1-1 — Attached PaymentMethods and `sources` survive "redaction", are deletable, and are absent from the disclosure

- **File/lines:** `src/lib/account-offboarding/stripe-customer-redaction.ts:44-54`; `src/lib/account-offboarding/table-disposition.ts:450-458`; `src/lib/notifications/email/templates/account-offboarding.ts:285-286`; `src/lib/legal/content.ts:244`
- **Contract at stake:** the `PROVIDER_DATA_RETENTION.reason` field, which by its own doc comment (`table-disposition.ts:444-449`) is the source the receipt and the privacy policy are written from — "each one names the CATEGORIES that outlive redaction".
- **Evidence.** The cleared set is closed at eight fields:

  ```ts
  // src/lib/account-offboarding/stripe-customer-redaction.ts:45-54
  const REDACTED_CUSTOMER_FIELDS = [
    'name', 'email', 'phone', 'description',
    'address', 'shipping', 'business_name', 'individual_name',
  ] as const;
  ```

  The disclosure names exactly two survivors:

  ```
  // src/lib/notifications/email/templates/account-offboarding.ts:286
  'Our payment processor keeps paid invoices, including the billing name and
   address on them, and tax identifiers, for financial record-keeping.'
  ```

  But the Stripe `Customer` object also carries `default_source: string | CustomerSource | null` (`stripe@22.2.0 cjs/resources/Customers.d.ts:182`) and `invoice_settings.default_payment_method`, and every PaymentMethod attached to the Customer holds a `billing_details` block (name, email, phone, full address) plus card `last4`, `exp_month/exp_year` and `fingerprint`. `customers.update` cannot clear any of it. A repo-wide grep at the reviewed SHA — `git grep -n "paymentMethods\|\.detach(\|invoice_settings" 00f6d56b -- src worker ':!*__tests__*'` — returns **zero** production hits, so nothing on this branch or before it detaches a payment method or clears `invoice_settings`.

- **Why this is P1 and not a nit.** Unlike a paid invoice, a PaymentMethod is *not* immutable and *not* required for tax retention: `paymentMethods.detach` exists and works on a Customer with no live subscription, which is exactly the state teardown leaves. So this is simultaneously (a) an erasure gap the purge could close and chose not to, and (b) a disclosure that under-states what is retained, in a document (`legal/content.ts`) written to satisfy a deletion request.
- **Concrete failure scenario.** An owner on the Growth tier pays by card, requests `delete_data`, and the purge completes. The receipt tells them the processor keeps paid invoices and tax identifiers. In fact the Stripe Customer still carries a PaymentMethod with `billing_details.name = "Jane Okafor"`, `billing_details.email = "jane@…"`, `billing_details.address` (full postal address) and `card.last4 = 4242`, indefinitely, and Stripe support or anyone with a restricted read key can list it off the Customer. The owner was told their customer record was redacted (`legal/content.ts:244`, "we also redact your customer record at our payment processor"); their name, email, phone and postal address are still on it.

---

### P2-1 — Stripe availability and credentials are now a precondition for *completing* a data-deletion obligation

- **File/lines:** `worker/jobs/account-offboarding/PurgeWorker.ts:90-91`; `worker/jobs/account-offboarding/purge-stages.ts:791-795`; `src/lib/account-offboarding/stripe-customer-redaction.ts:234-242`
- **Invariant at stake:** D3 ("every OTHER permanent type propagates") interacting with the PurgeWorker's failure sink. Also invariant #11's spirit — Stripe is the source of truth for *subscription status*, not for whether a deletion completes.
- **Evidence.** `redactStripeCustomer` treats only `resource_missing` as success:

  ```ts
  // src/lib/account-offboarding/stripe-customer-redaction.ts:240-242
  function isResourceMissing(err: unknown): boolean {
    return stringProperty(err, 'code') === 'resource_missing';
  }
  ```

  Every other error becomes a thrown `StripeCustomerRedactionError` (`:174`, `:193`), which propagates out of `runStripeCustomerRedactionPurgeStage` into `handleAccountOffboardingPurge`'s catch (`PurgeWorker.ts:97-113`). On a non-terminal attempt it calls `markPurgeRetryableFailure` and rethrows; on the terminal attempt it calls `markPurgeTerminalFailure` + `markOutboxFailed`. In every one of those branches `finalizePurgeInTransaction` (`PurgeWorker.ts:96`) never runs, so `account_offboardings.status` never reaches `'purged'`, the lifecycle receipt is never scrubbed, and the purge-receipt email is never enqueued.

  Before this branch there was no Stripe call between `runAuditAndCostPayloadPurgeStage` and `runParentTombstonePurgeStage`; the purge could finalize with Stripe entirely down.

- **Concrete failure scenario.** The live Stripe restricted key is rotated without the `customer_write` scope. `customers.update` returns `StripePermissionError`, which is in `PERMANENT_STRIPE_ERROR_TYPES` (`src/lib/payments/stripe-error-inspect.ts:26-31`) and is not `resource_missing`, so it throws with `retryable: false`. **Every** `delete_data` purge in the queue now runs its local destruction (auth binding, content, analytics, audit payloads all committed and irreversible) and then terminally fails before the tombstone, leaving each account in `purge_scheduled` with `last_error` set, no tombstone, no receipt, and a GDPR/CCPA deletion clock still running. The failure surfaces only as `account_offboarding_purge_failed` in Sentry (`PurgeWorker.ts:121`), with the Stripe message scrubbed to a bounded string that names the operation but not the cause.
- **Secondary, same root:** `getStripe()` is evaluated unconditionally at `PurgeWorker.ts:90`, *before* the stage's own null check at `purge-stages.ts:760-761`. `getStripe()` throws `'STRIPE_SECRET_KEY is not set'` when the key is absent (`src/lib/payments/stripe-client.ts:33-34`), so an offboarding for an account that never had a Stripe customer at all now fails its purge in any environment without that key, where previously it did not need one.

---

### P2-2 — The redaction transaction holds a Postgres connection and a customer-keyed advisory lock across a Stripe round trip of up to ~60s, and the comment asserting it takes no other lock is wrong

- **File/lines:** `worker/jobs/account-offboarding/purge-stages.ts:752-753` (the claim), `:763-803` (the transaction), `:811-817` (the second lock it does take); `src/lib/payments/stripe-client.ts:16-20`
- **Invariant at stake:** the CLAUDE.md gotcha "postgres.js has NO admission control — the #773 chokepoint … The gate trades latency for never wedging", and the in-repo convention stated at `worker/ingress/stripe/checkout-completed.ts:575-578`: *"Throwing rolls this transaction back and releases the account row plus advisory locks. The outer handler performs the bounded provider call only after those locks are gone."*
- **Evidence.** The doc comment claims a closed lock set:

  ```
  // worker/jobs/account-offboarding/purge-stages.ts:752-753
  * same lock on the writer side. This stage requests no other lock, so it
  * cannot participate in a deadlock cycle.
  ```

  It does request another lock. `appendStripeCustomerRedactionRecord` (`:805-818`) issues `UPDATE account_offboardings … WHERE id = … AND terminal_at IS NULL` inside the same transaction, which takes an exclusive row lock on that `account_offboardings` row while the binding advisory lock is still held. The stated reason the stage "cannot participate in a deadlock cycle" is therefore not the reason that is true; what is actually true is the narrower fact in *Verified clean #9* — that no current holder of an `account_offboardings` row lock goes on to request the binding lock. That is a property of unrelated code (`checkout-completed.ts:509-556` happening to omit `FOR UPDATE`), not of this stage, and nothing pins it.

  Separately, the Stripe call sits inside `sql.begin` at `:791-795`, and the client is configured `timeout: 20_000, maxNetworkRetries: 2` (`stripe-client.ts:16-20`) — worst case roughly three 20-second attempts plus backoff, all while the transaction is open and idle-in-transaction on a pooled connection.

- **Concrete failure scenario (deadlock).** Someone later adds a `FOR UPDATE` to the offboarding read in `checkout-completed.ts` — a natural hardening, and the file already locks the account row — for an account that is mid-purge. T1 (checkout.session.completed) holds entitlement(A) + the `account_offboardings` row and requests binding(C) inside `applyStripeSubscriptionStateInternal`. T2 (the redaction stage) holds binding(C) and requests that same `account_offboardings` row. Postgres raises `40P01`; the purge job fails with a deadlock error, and the comment at `:752-753` says that cannot happen, so nobody looks there.
- **Concrete failure scenario (contention).** Stripe has a partial outage. Ten concurrent `delete_data` purges each hold a pooled connection idle-in-transaction for ~60s, in a worker whose pool is capped by `DB_POOL_MAX` and fronted by an admission gate that has no visibility into JS-side awaits. Subscription webhooks for those same customers block on binding(C) inside their own transactions for the same duration, and each of those also holds entitlement(A) — so a *billing* status write for a live account queues behind an offboarding's Stripe timeout.

---

### P2-3 — The operator replay path D9 was designed to preserve is capped at 7 days by a pre-existing guard, not the 30 days the retention implies

- **File/lines:** `worker/ingress/stripe.ts:27`, `:58-65`, `:71`; `worker/background/pollers/ArchivalPoller.ts:88-101`; `worker/ingress/stripe/shared.ts:100-121`
- **Contract at stake:** D9's stated purpose — the warning "is the operator's handle for finding the retained `inbound_events` row and replaying it" — and the `stale_ignored` status that exists solely so `claimInboundEvent` can reclaim it.
- **Evidence.** The dispatcher short-circuits stale events **before** the row is ever claimed or written:

  ```ts
  // worker/ingress/stripe.ts:58-65
  const eventAgeSeconds = Math.floor(Date.now() / 1000) - event.created;
  if (eventAgeSeconds > STALE_EVENT_THRESHOLD_SECONDS) {   // :27 → 7 days
    console.warn(`${LOG_PREFIX} Rejecting stale event ${event.id} …`);
    reply.status(200).send({ received: true, stale: true });
    return;
  }
  const claim = await claimInboundEvent('stripe', event.id, event.type, event);  // :71
  ```

  A Stripe dashboard **Resend** redelivers the original event with its original `created`. So a resend of an event acked at, say, day 3 will hit this guard from day 7 onward and be dropped with a 200 before `claimInboundEvent` runs — the reclaimable `stale_ignored` row is never touched. Meanwhile `ArchivalPoller` deliberately retains the row for 30 days precisely so the replay path stays open (`ArchivalPoller.ts:88-93`: *"retained so an operator resend can still be reclaimed by claimInboundEvent"*).
- **Concrete failure scenario.** An orphaned `customer.subscription.deleted` for customer `cus_X` is acked as `stale_ignored` on day 0. On day 12 an operator, following the Sentry warning `stripe_subscription_event_acked_for_age` (`stripe/shared.ts:100-121`), fixes the account's `stripe_customer_id` binding by hand and resends the event to make the cancellation apply. Stripe reports a 200; nothing happens; the account stays on whatever status it had (e.g. `active`, with entitlement still granted) and the operator has no signal that the resend was discarded. The only surviving remedy is the billing-reconciliation poller, which D9 did not cite and which is not what the warning tells them to do.

---

### P3-1 — The receipt and privacy policy assert a redaction that two code paths do not perform

- **File/lines:** `worker/jobs/account-offboarding/purge-stages.ts:760-761`, `:783-789`; `src/lib/legal/content.ts:244`; `src/lib/notifications/email/templates/account-offboarding.ts:182`
- **Contract at stake:** the disclosure's own doc comment — *"Unconditional on the receipt — what survives at the processor is a property of its API, not of any local count"* (`account-offboarding.ts:278-284`).
- **Evidence.** Two branches leave the Stripe Customer completely untouched:

  ```ts
  // worker/jobs/account-offboarding/purge-stages.ts:760-761
  const customerId = row.stripe_customer_id?.trim();
  if (!customerId) return;                       // no record written at all
  ```
  ```ts
  // :783-789
  if ((sharing?.count ?? 0) > 0) {
    await appendStripeCustomerRedactionRecord(tx, row,
      stripeCustomerRedactionRecord(customerId, 'skipped_shared_customer'));
    return;                                      // Stripe never called
  }
  ```

  The receipt paragraph at `:182` and the policy sentence at `content.ts:244` ("When we delete your data we also redact your customer record at our payment processor") render unconditionally in both cases.
- **Concrete failure scenario.** An account shares a Stripe Customer with a live co-tenant. The purge records `skipped_shared_customer`, sends the receipt, and the tombstone then NULLs `accounts.stripe_customer_id` (`purge-stages.ts:876`) and `account_offboardings.stripe_customer_id` (`purge-stages.ts:1067-1080`). The owner has been told in writing that their processor record was redacted; their name, email, phone and address are still live on that Customer, and the only local trace is a sha256 hash (`purge-stages.ts:706-723`) from which no operator can recover the customer id to fix it. Probability is low because D10's premise (`buildCheckoutSessionParams` passes `customer_email`, never `customer`) means Stripe mints a fresh Customer per session — but the disclosure is unconditional while the act is not.

---

### P3-2 — Two accounts genuinely sharing a customer each skip on account of the other, so the customer is never redacted by anyone

- **File/lines:** `worker/jobs/account-offboarding/purge-stages.ts:769-789`, `:876`
- **Contract at stake:** D1 (skip, don't redact) as a *terminal* decision with no follow-up sink.
- **Evidence.** The guard excludes only accounts whose offboarding has already reached `status = 'purged'`:

  ```sql
  -- worker/jobs/account-offboarding/purge-stages.ts:769-779
  SELECT COUNT(*)::int AS count FROM accounts a
  WHERE a.stripe_customer_id = ${customerId}
    AND a.id <> ${row.account_id}::uuid
    AND NOT EXISTS (SELECT 1 FROM account_offboardings ao
                    WHERE ao.account_id = a.id AND ao.status = 'purged')
  ```

  `status` only becomes `'purged'` in `finalizePurgeInTransaction`, and `accounts.stripe_customer_id` is only NULLed at the tombstone (`:876`) — both strictly *after* this stage. So when accounts A and B share customer C and both purge in the same window, A sees B as unpurged and skips; B then sees A as unpurged (A's row is purged by then, so this one resolves) — but if the two purges interleave before either finalizes, both skip and neither ever retries: the local customer id is destroyed by each tombstone regardless of the skip.
- **Concrete failure scenario.** Two accounts under one Stripe Customer both request `delete_data` on the same day; the purge jobs run within the same hour. Both record `skipped_shared_customer`; both tombstones NULL their `stripe_customer_id`. The Customer retains both owners' billing name, email, phone and address permanently, with no local handle and no alert — `skipped_shared_customer` is written to `provider_dispositions` but nothing reads it and nothing pages on it.

---

### P3-3 — The idempotency-key guarantee in the module doc is narrower than stated, and the file next door already documents the exact reason

- **File/lines:** `src/lib/account-offboarding/stripe-customer-redaction.ts:154-162`; `worker/jobs/account-offboarding/teardown-stripe.ts:80-84`
- **Contract at stake:** the retry-safety claim the stage's D5 late-ordering rests on.
- **Evidence.**

  ```
  // src/lib/account-offboarding/stripe-customer-redaction.ts:154-158
  * Deterministic per offboarding, so a BullMQ retry re-sends the SAME key and
  * Stripe replays its own answer rather than issuing a second write.
  ```

  Stripe idempotency keys are only honoured for 24 hours. The sibling module states this outright for the same class of retry: *"or on a teardown retry past the ~24h idempotency-key window. Re-cancelling then raises a permanent error"* (`teardown-stripe.ts:80-84`). Past 24h the redaction key is a fresh request, and Stripe issues a real second write.
- **Why it is only P3 here.** The consequence is benign because `isAlreadyRedacted` (`:221-228`) short-circuits before the update when the marker matches and all eight fields read empty. So the *behaviour* is safe; the *stated* guarantee is what is wrong, and the outbox watchdog can re-dispatch a purge far past 24h, so the >24h path is reachable in production.

---

## Appendix — below the 80% confidence bar

**A1. Same idempotency key with divergent params → permanent `StripeIdempotencyError` → wedged purge.** `buildRedactionParams` (`stripe-customer-redaction.ts:203-219`) derives the `metadata` unset-list from the *retrieved* Customer, so the params are a function of remote state, while the idempotency key is a function of the offboarding id alone. If the Customer's metadata or any of the eight fields changes between two purge attempts inside the 24-hour window, attempt 2 sends the same key with different params, Stripe returns `idempotency_error`, `StripeIdempotencyError` is in `PERMANENT_STRIPE_ERROR_TYPES` (`stripe-error-inspect.ts:26-31`), it is not `resource_missing`, and it throws — wedging the purge until the key expires. I could not establish a writer that would mutate the Customer in that window: no other `customers.update` exists in the repo, and the Billing Portal is unreachable for a tombstoned account. Reachability is plausible (a Stripe-side write, a manual dashboard edit during an incident) but unproven, so this is not filed as a finding.

**A2. False `already_redacted` from fields the API version does not return.** `isEmptyField` treats `undefined` as cleared (`stripe-customer-redaction.ts:230-232`), and `isAlreadyRedacted` requires all eight to be empty. If a future `apiVersion` bump stops returning `business_name`/`individual_name` on the Customer object while still accepting them on update, a Customer whose marker matches would read as fully redacted even though those two fields were never cleared. Today both are present, so this is a forward-looking fragility rather than a live defect.

**A3. `invoice_settings.custom_fields` and `preferred_locales` survive.** Both are on `CustomerUpdateParams` (`cjs/resources/Customers.d.ts:582+`, lines 49 and 69 of that interface) and neither is cleared. `custom_fields` is an owner-editable `[{name, value}]` list that can carry free text. Lower confidence than P1-1 because I could find no code path in this repo that ever populates them, so in practice they are likely empty.
