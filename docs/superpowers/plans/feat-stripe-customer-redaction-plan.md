# Plan: Redact the Stripe Customer during purge, disclose what survives, and bound the webhook retry

_Locked via grill (Claude + Norbert), 2026-09-03. Four design decisions were put to the owner and all four recommendations were accepted. Do not re-litigate them._

Branch: `feat/stripe-customer-redaction` · Intake contract: `feat-stripe-customer-redaction-intake.json` · Fork point: `dc61f074`

Classification: `standard` · `high` · `backend` · `db_touching: true` (no migration; the flag is true only because live-DB integration suites are edited).

Plan review: Codex round 1 returned `VERDICT: REVISE` with ten findings. Eight
are folded in below (D8, D9, and the T0/T1/T2/T4 revisions); the citation
corrections are applied in place. Round-1 session id
`01a066d6-7a49-7001-b248-83f0ab4d80d4` — a verification round resumes it rather
than starting cold.

## Goal

Three outcomes, one branch.

1. A `delete_data` account purge clears the identifying fields on its Stripe Customer before the local tombstone destroys the last copy of the customer id. Invoices and charges survive untouched, so tax retention is intact.
2. The Stripe Customer object is classified as retained compliance-limited PII, and the deletion receipt and privacy policy say what survives.
3. A Stripe subscription webhook for a customer with no account throws only while the event is young enough for a genuine out-of-order delivery. Older than that, it logs and returns, so ingress replies 200 and Stripe stops retrying.

The Stripe Customer is **never deleted**. Deletion detaches its invoices and cannot be undone. Redaction gives the same privacy result and keeps the financial record.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | A shared Stripe Customer is **skipped, not redacted**. | `accounts.stripe_customer_id` has no unique constraint (`supabase/migrations/001_initial_schema.sql:91`; the index added by `034_multi_location_schema.sql:51` is non-unique), and `worker/ingress/stripe/subscription-deleted.ts:56` states the rule outright: "a Stripe customer can map to MULTIPLE accounts". Blind redaction would erase a live co-tenant's billing contact. |
| D2 | The classification lives in a **separate export in the same file**, `PROVIDER_DATA_RETENTION`. | `src/lib/account-offboarding/__tests__/table-disposition.test.ts:107-108` pins `TABLE_DISPOSITIONS` to exact set equality with the real tenant tables, and `purge-verification.ts:737` throws `missing_purge_verification_sql` for any entry with no SQL branch. A Stripe object has no SQL. One file stays the owner of both inventories. |
| D3 | Stripe failures are classified **like `stripe-invoices.ts`**. | Retryable → throw, BullMQ retries, the purge does not finalize. Permanent `resource_missing` → success, the identifiers are already gone. Every OTHER permanent type propagates. Mirrors `cancelDeleteDataSubscription`'s already-in-desired-state tolerance, whose rationale begins at `worker/jobs/account-offboarding/teardown-stripe.ts:79`. |
| D4 | The retry bound is **15 minutes**, read from the Stripe **event's** `created`. | `checkout.session.completed` normally lands in seconds. 15 minutes covers a worker restart or a brief DB outage. The Subscription object's own `created` is a different clock and must never be used. |
| D5 | The redaction stage runs **late**, immediately before the tombstone — not first. | This is a real tradeoff, decided deliberately. Running first would fail fast with nothing destroyed, but a subsequent local failure would leave a **live** account whose Stripe billing contact is wiped — the same hazard D1 exists to prevent. Running late means every local destruction has already committed, so the point of no return has passed and redaction is the last irreversible act. |
| D6 | The event-age argument is **required**, not optional with a default. | A silent default that disables the bound is the exact failure mode this change exists to fix. The compiler proves every call site supplies it. Cost: two integration test files join the edit surface. |
| D7 | The 15-minute rule has **one owner**, `worker/ingress/stripe/shared.ts`. | Two throw sites must not carry two copies of the constant. `shared.ts` already owns `AccountNotProvisionedYetError` (line 28), so it is the natural home. |
| D8 | The D1 guard is serialized by a **customer-keyed advisory lock**, not left to chance. | Plan round 1 findings 4 and 9. A count in its own `sql.begin` does not serialize against a later write binding the same customer to another account. `accounts.stripe_customer_id` has exactly two **non-null binding assignments**, `apply-subscription-state.ts:365` and `:378`, both `COALESCE(stripe_customer_id, $1)` — write-once, so a binding only lands on an account whose column is NULL. (`purge-stages.ts:741` also writes the column, to NULL; clearing is not a binding and is out of scope.) A lock keyed on the customer id, held by both the guard and those writes, closes the simultaneity window. Owner-approved 2026-09-03; the residual ordering window is D10. |
| D9 | An acked stale webhook gets **no reconciliation worker**, but it stays **reclaimable**. | Plan round 1 findings 7 and 10 proposed a deferred-reconciliation outbox topic. Rejected as scope expansion: `checkout-completed.ts:628` already reads provider-current state and rolls back on `canceled`, so the end state is `pending_payment`, which is correct for a deleted subscription, and today's code reaches it after three days of retries plus an alert storm. **Round 2 corrected the reasoning**: acking with `status='processed'` would have made recovery strictly WORSE, because `claimInboundEvent` reclaims only `failed` or stale `received` (`worker/ingress/shared.ts:42`) and returns `duplicate` for `processed` (line 50) — so an operator resending the event from Stripe would be silently deduplicated. The ack therefore writes a distinct `stale_ignored` status that `claimInboundEvent` reclaims, keeping today's replay path intact. Owner-approved 2026-09-03, corrected after round 2. |
| D10 | The D8 residual is **accepted and pinned**, not closed with a marker table. | Round 2 finding 1: the lock excludes simultaneity but not the order "redaction wins, counts zero, redacts; a writer then binds the redacted Customer to a live account". Closing that needs a durable retired-customer marker and a migration. It is not warranted, because `create-checkout-session.ts:206` passes `customer_email` and never `customer`, so Stripe mints a new Customer per session and no code path can bind an existing Customer to a second account. The premise is pinned by a test asserting the session params carry no `customer` field, so a future change that starts reusing Customers fails loudly rather than silently enabling the race. Owner-approved 2026-09-03. |

## Ordering — the load-bearing constraint

The customer id lives in exactly three columns, destroyed at three lines of
`worker/jobs/account-offboarding/purge-stages.ts`:

| Line | Column | Destroyed by |
|---|---|---|
| 714 | `businesses.stripe_customer_id` | `runParentTombstonePurgeStage` (starts line 685) |
| 741 | `accounts.stripe_customer_id` | same stage, same transaction |
| 935 | `account_offboardings.stripe_customer_id` | `scrubLifecycleReceiptInTransaction`, called from `finalizePurgeInTransaction` (line 750) |

The new stage therefore runs **after `runAuditAndCostPayloadPurgeStage`
(line 649) and before `runParentTombstonePurgeStage` (line 685)**.

Retry safety follows from the same table: `account_offboardings.stripe_customer_id`
survives until finalize, and `loadPurgeOffboarding` (declared line 61) re-reads
it, so a retry after a failed redaction still has the id.

`runRawPayloadPurgeStage` (line 459) consumes `row.stripe_customer_id` at lines
481, 489 and 533 to scrub raw payloads. It runs earlier and is unaffected: the
new stage mutates Stripe, never the local row's id.

## Tracer bullets

Each tracer is a thin vertical slice. `T0` is the eval task and is committed
before any implementation.

The intake holds **45** test titles. Ownership, which must stay in sync with it
(round 2 finding 6):

| Tracer | Titles | Count |
|---|---|---|
| T0 | the no-todo meta-check | 1 |
| T1 | `redactStripeCustomer` | 10 |
| T2 | purge stage, worker ordering, the D8 lock, the D10 pin | 13 |
| T3 | classification and disclosure | 6 |
| T4 | the webhook bound, the event context, the reclaimable status | 15 |

### T0 — eval task: the 28 promised tests, failing

Author every `tests_to_add` title from the intake as a real test body, committed
red before implementation. This is the spec in executable form; each later
tracer names the tests it turns green.

**No `.todo`, no `.skip`, no conditional skip.** Plan round 1 finding 1: `pnpm
test` is ordinary `vitest run` (`package.json:18`), and a pending test does not
make it fail. A suite of 45 `.todo` titles would exit 0 with zero feature
behaviour, so a pending test is not a promise. The last title in
`tests_to_add` is the meta-check that enforces this on the feature's own files.

Blocking edges: none. Runs alone.

### T1 — the redaction module

New file `src/lib/account-offboarding/stripe-customer-redaction.ts`, plus its
`docs/directory.md` row in the same change.

Shape copied from `src/lib/account-offboarding/stripe-invoices.ts`: a pure
module taking a **narrow client interface** it declares itself
(`retrieve` + `update` only), never `getStripe()`. Domain modules receive their
clients as parameters (invariant #15); `teardown-stripe.ts` is the precedent for
the worker resolving `getStripe()` and passing it in.

`redactStripeCustomer({ stripe, customerId, offboardingId })` returns a typed
outcome: `redacted` · `already_redacted` · `customer_absent`.

1. **Retrieve first.** `customers.update` **merges** metadata, so a single call
   writing only the offboarding key would leave every existing key in place.
   The retrieve supplies the existing key set. It also detects an already
   redacted customer and a deleted one.
2. **One write.** A single `customers.update` clearing, per the version-matched
   SDK (`stripe@22.2.0`, `apiVersion 2026-05-27.dahlia`, where
   `Emptyable<T> = null | '' | T`):
   - `name`, `email`, `phone`, `description` — plain `string`, cleared with `''`
   - `address`, `shipping` — `Emptyable`, cleared with `''`
   - `business_name`, `individual_name` — `Emptyable`, cleared with `''`
   - `metadata` — every pre-existing key set to `''`, plus one new key naming
     the offboarding id
3. **Idempotency key** derived deterministically from the offboarding id,
   matching `accountOffboardingTeardownStripeIdempotencyKey`
   (`teardown-stripe.ts:16`).
4. **Error classification** via `RETRYABLE_STRIPE_ERROR_TYPES` /
   `PERMANENT_STRIPE_ERROR_TYPES` from `src/lib/payments/stripe-error-inspect.ts`,
   exactly as `stripe-invoices.ts:445-446` does. A deleted customer or
   `resource_missing` returns `customer_absent`, which is success. **Every other
   permanent type propagates** — plan round 1 finding 3: `stripe-error-inspect.ts:26`
   classifies authentication, permission, idempotency and invalid-request errors
   as permanent, and mapping all of them to `customer_absent` would finalize a
   purge whose redaction silently failed on bad parameters or credentials.

`customers.del` is never referenced. A test asserts the fake client's `del` is
never called.

**The fake client must simulate Stripe's real metadata semantics** — plan round 1
finding 2, the sharpest one. A fake that treats `metadata` as replacement makes
the test pass for an implementation that sends only the offboarding key, while
real Stripe merges and retains every prior key. So the fake merges, treats `''`
as deletion, is seeded with several pre-existing keys, and the assertion is that
the resulting remote metadata holds exactly one key.

Turns green: the ten `redactStripeCustomer` tests.

Blocking edges: T0. Runs alone — it carries the first-task enforcement spot check.

### T2 — the purge stage, its ordering, and the D8 lock

Edits `worker/jobs/account-offboarding/purge-stages.ts`,
`worker/jobs/account-offboarding/PurgeWorker.ts`,
`src/lib/accounts/billing-locks.ts` and
`worker/ingress/stripe/apply-subscription-state.ts`.

**The lock ships in this tracer, not a later one.** A guard without the
writer-side lock is a false guarantee, so the two halves must land together.

`src/lib/accounts/billing-locks.ts` is the single owner of billing advisory
locks and gains `acquireStripeCustomerBindingLock(tx, stripeCustomerId)`,
following the file's existing shape: `pg_advisory_xact_lock(hashtext(<key> +
<suffix>))` with its own dedicated suffix.

**Lock order is fixed and must not be inverted.** The writer side takes it
inside `applyStripeSubscriptionStateInternal`, so the order at every writer is
account-scoped tier entitlement lock first, customer-keyed binding lock second.
Taking it at the six call sites that open the transaction instead would touch
`checkout-completed.ts`, `invoice-paid.ts`, `invoice-payment-failed.ts`,
`subscription-updated.ts`, `subscription-deleted.ts` and
`billing-reconciliation/reconcile-account.ts` — six files for no extra safety.
The redaction stage takes ONLY the binding lock and requests no other lock, so
it cannot participate in a cycle. The comment in `billing-locks.ts` about the
account → business → entitlement → account deadlock is why this ordering is
stated rather than assumed.

**The internal function, not the `UnderEntitlementLock` wrapper** — round 2
finding 2. `apply-subscription-state.ts` exports two entry points, and both
funnel into `applyStripeSubscriptionStateInternal`: the wrapper at line 228,
and `applyStripeSubscriptionState` at line 205, which takes the entitlement
lock itself. All six current production consumers use the wrapper, but placing
the lock there would leave the other exported API outside it and make the
declared invariant false. Placing it in the shared internal path covers both,
and both entry points are tested.

New exported stage `runStripeCustomerRedactionPurgeStage(sql, stripe, row)`.
The three-argument shape has precedent in `runAuthBindingPurgeStage`
(line 111), which takes `supabaseServer`.

Inside one `sql.begin`:

1. `row.stripe_customer_id` null → return `not_applicable`, no Stripe call.
2. **Take `acquireStripeCustomerBindingLock`** before the count, and hold it for
   the whole transaction including the Stripe call. This is D8.
3. **The D1 guard.** Count `accounts` rows sharing this `stripe_customer_id`
   other than `row.account_id`, excluding accounts whose own offboarding is
   already purged. Non-zero → skip the Stripe call, append a
   `skipped_shared_customer` record, return.
4. Otherwise call `redactStripeCustomer` and append a record naming the outcome.

The record is appended to `account_offboardings.provider_dispositions` with a
**new type discriminator** distinct from `admin_provider_disposition`. This is
safe by construction: `isConcreteAdminProviderDisposition`
(`src/lib/account-offboarding/provider-disposition.ts:135`) rejects any value
whose `type` does not match, so the teardown resolution gate is unaffected. A
test pins that.

The customer id is scrubbed before it is written or logged, the same way
`scrubDispositionText` (`provider-disposition.ts:297`) handles a resource
reference.

`PurgeWorker.ts` inserts one call between `runAuditAndCostPayloadPurgeStage` and
`runParentTombstonePurgeStage`, resolving `getStripe()` at the worker boundary.

**The ordering test asserts the full three-call subsequence**, not merely
"before the tombstone" — plan round 1 finding 5. A redaction stage inserted
first would still satisfy a "before tombstone" assertion while violating D5, so
the test pins audit → redaction → tombstone by call order.

Turns green: T2's thirteen tests — the stage, the worker ordering subsequence,
the "does not finalize on a retryable error" assertion, both lock entry points,
both lock-winner orders, the live-DB concurrency test, and the D10 pin that
`buildCheckoutSessionParams` never sets a `customer` field.

Blocking edges: T1.

### T3 — classification and disclosure

Three files, text and inventory only. No control flow.

1. `src/lib/account-offboarding/table-disposition.ts` — add
   `PROVIDER_DATA_RETENTION`, a separate exported array reusing the existing
   `AccountOffboardingDisposition` union. One entry: the Stripe Customer object,
   `retain_compliance_limited_pii`, whose reason names what survives — paid
   invoices with their snapshotted billing name and address, and `tax_ids`,
   which the Customer update cannot reach. It carries no `purgeVerification`
   field and never enters `ACCOUNT_OFFBOARDING_TABLES` or
   `PURGE_VERIFICATION_TABLES`. A test asserts that separation, and a second
   test asserts `verificationQuery` still throws for an unknown table.
2. `src/lib/notifications/email/templates/account-offboarding.ts` — one added
   sentence in `buildPurgeReceiptEmailHtml` (line 165), placed beside the
   existing `formatRetainedSuppressions` sentence and written the same way:
   categories only, no counts, no identifiers. The exact wording was approved
   during grilling. It renders for `purge_receipt` only.
3. `src/lib/legal/content.ts` — sharpen the existing deletion paragraph at
   line 150 to name what survives at the payment processor. No new section.

Turns green: T3's six classification and disclosure tests.

Blocking edges: T0 only. Disjoint from T1, T2 and T4 in both production and
test files, so it may run concurrently with T2 and T4.

### T4 — the webhook retry bound

Four production files plus five test call sites.

1. `worker/ingress/stripe/shared.ts` — the single owner (D7). Add the
   constant and a pure predicate taking the event's created timestamp and
   returning whether the out-of-order retry window is still open. Strictly
   greater than 900 seconds closes it; a negative age from clock skew leaves it
   open, so skew fails toward today's behavior.
2. `worker/ingress/stripe/subscription-updated.ts:593` and
   `worker/ingress/stripe/subscription-deleted.ts:53` — each throw site becomes
   a branch. Window open → throw `AccountNotProvisionedYetError`, unchanged.
   Window closed → log, raise one Sentry **warning**, and return.
   `subscription-updated` returns its existing `ignoredOutcome` shape.

   The warning **carries the stripe customer id and the event id** (D9). It is
   the operator's handle for finding the retained `inbound_events` row and
   replaying it, so a bare "an event was acked" line would not do the job the
   rejected reconciliation worker was proposed for.

   That means the handlers receive an **event context of `{ id, created }`**,
   not a bare timestamp — round 2 finding 4. A `Stripe.Subscription` does not
   carry its enclosing event's id, so passing only `event.created` would have
   made the promised warning unbuildable.

   **Both branches are tested independently, under a frozen clock** — plan
   round 1 finding 6. One generic boundary test could exercise a single handler
   while the other used `>= 900`, and an unfrozen clock can cross a second
   mid-test and stop testing the stated boundary. So: 900 throws and 901 acks,
   proven separately for each handler, and the future-timestamp case likewise.
3. `worker/ingress/stripe.ts` — pass the event context into both handlers at
   lines 89 and 93. The existing `eventAgeSeconds` computation at line 50 and
   the 7-day `STALE_EVENT_THRESHOLD_SECONDS` guard are untouched.

4. **The reclaimable status (D9).** `worker/ingress/shared.ts` gains a
   `stale_ignored` status: `claimInboundEvent`'s reclaim predicate accepts it
   alongside `failed`, so a resent Stripe event still reprocesses, and a marker
   function records it with `processed_at` set. The dispatcher writes that
   status for this branch instead of `processed`.

   `worker/background/pollers/ArchivalPoller.ts:91-93` sweeps
   `status = 'processed' AND processed_at < NOW() - 30 days`; the predicate
   widens to include `stale_ignored` so the rows do not accumulate forever.
   `checkFailedInboundEvents` counts `status='failed'` only, so it excludes the
   new status with no change — a test pins that rather than assuming it.

   There is no CHECK constraint on `inbound_events.status`, so this is a code
   change and needs no migration. `idx_ie_status` is partial on
   `status != 'processed'`, so the new value is indexed.
5. Call-site updates for the required argument (D6):
   `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts`,
   `worker/ingress/__tests__/stripe-subscription-updated.test.ts`,
   `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`,
   `src/lib/accounts/__tests__/billing-locks.integration.test.ts`.

Why this kills the alert class: a throw makes the dispatcher write
`inbound_events.status = 'failed'` (`worker/ingress/stripe.ts:109-112`), and
`worker/background/pollers/health-alert/checks.ts` counts exactly those rows —
the `FROM` is line 276, the failed predicate line 277, and the alert key
`inbound_events_failed:<source>:<event_type>` line 284. Returning instead lets
the dispatcher write `processed` (line 101), so the alert stops.

Turns green: T4's fifteen webhook tests, including both per-handler boundary
cases, both future-timestamp cases, the enriched-warning assertion, and the four
covering the reclaimable status across `claimInboundEvent`,
`checkFailedInboundEvents` and `ArchivalPoller`.

Blocking edges: T0 only. Disjoint from T1, T2 and T3.

## Dispatch order

`T0` alone → `T1` alone, with the first-task enforcement spot check → then
`T2`, `T3` and `T4`, where `T3` and `T4` may run concurrently with `T2`.

## Domain terms to coin in `CONTEXT.md`

Two, both in the same change as the code that introduces them. `CONTEXT.md`
already uses "redaction" for **Body redaction** and "provider disposition" for
the admin-recorded record, so both new terms are named to avoid the collision.

- **Stripe Customer redaction** — the purge stage's `customers.update` that
  clears the identifying fields while leaving invoices and charges intact.
  Explicitly not a deletion. _Avoid_: customer deletion, Stripe purge.
- **Provider data retention** — the `PROVIDER_DATA_RETENTION` inventory of
  third-party objects that survive a purge, deliberately separate from
  `TABLE_DISPOSITIONS` because it has no SQL verification arm.
  _Avoid_: provider disposition, which is the admin-recorded record.

## Verification

`bash scripts/verify-gate.sh` throughout, `--review` last. `db_touching` is
true, so the gate provisions the test database and runs the two edited
integration suites; a `SKIP` row on those makes the gate not review-ready.

Beyond the repository gate: `pnpm test src/lib/account-offboarding`,
`pnpm test worker/jobs/account-offboarding`, `pnpm test worker/ingress`.

## Shipping

RISK is high, so the branch rides `staging` first. No migration, so no
lockstep step. Staging smoke: run a `delete_data` offboarding to purge against
a test-mode Stripe Customer and confirm in the Stripe dashboard that the
identifying fields are empty, the metadata holds one key, and the invoices are
still attached. Then PR to `main` and pause for explicit merge approval.

## Rollback

Revert the merge commit. No schema change, so no data rollback. A Customer
already redacted stays redacted — that is the intended erasure and it is
irreversible by design.
