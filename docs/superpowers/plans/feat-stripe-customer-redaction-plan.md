# Plan: Redact the Stripe Customer during purge, disclose what survives, and bound the webhook retry

_Locked via grill (Claude + Norbert), 2026-09-03. Four design decisions were put to the owner and all four recommendations were accepted. Do not re-litigate them._

Branch: `feat/stripe-customer-redaction` · Intake contract: `feat-stripe-customer-redaction-intake.json` · Fork point: `dc61f074`

Classification: `standard` · `high` · `backend` · `db_touching: true` (no migration; the flag is true only because two live-DB integration suites are edited).

## Goal

Three outcomes, one branch.

1. A `delete_data` account purge clears the identifying fields on its Stripe Customer before the local tombstone destroys the last copy of the customer id. Invoices and charges survive untouched, so tax retention is intact.
2. The Stripe Customer object is classified as retained compliance-limited PII, and the deletion receipt and privacy policy say what survives.
3. A Stripe subscription webhook for a customer with no account throws only while the event is young enough for a genuine out-of-order delivery. Older than that, it logs and returns, so ingress replies 200 and Stripe stops retrying.

The Stripe Customer is **never deleted**. Deletion detaches its invoices and cannot be undone. Redaction gives the same privacy result and keeps the financial record.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | A shared Stripe Customer is **skipped, not redacted**. | `accounts.stripe_customer_id` has no unique constraint (`supabase/migrations/001_initial_schema.sql:91`), and `worker/ingress/stripe/subscription-deleted.ts:55` states the rule outright: "a Stripe customer can map to MULTIPLE accounts". Blind redaction would erase a live co-tenant's billing contact. |
| D2 | The classification lives in a **separate export in the same file**, `PROVIDER_DATA_RETENTION`. | `src/lib/account-offboarding/__tests__/table-disposition.test.ts:104` pins `TABLE_DISPOSITIONS` to exact set equality with the real tenant tables, and `purge-verification.ts:737` throws `missing_purge_verification_sql` for any entry with no SQL branch. A Stripe object has no SQL. One file stays the owner of both inventories. |
| D3 | Stripe failures are classified **like `stripe-invoices.ts`**. | Retryable → throw, BullMQ retries, the purge does not finalize. Permanent `resource_missing` → success, the identifiers are already gone. Mirrors `cancelDeleteDataSubscription`'s existing already-in-desired-state tolerance (`worker/jobs/account-offboarding/teardown-stripe.ts:87`). |
| D4 | The retry bound is **15 minutes**, read from the Stripe **event's** `created`. | `checkout.session.completed` normally lands in seconds. 15 minutes covers a worker restart or a brief DB outage. The Subscription object's own `created` is a different clock and must never be used. |
| D5 | The redaction stage runs **late**, immediately before the tombstone — not first. | This is a real tradeoff, decided deliberately. Running first would fail fast with nothing destroyed, but a subsequent local failure would leave a **live** account whose Stripe billing contact is wiped — the same hazard D1 exists to prevent. Running late means every local destruction has already committed, so the point of no return has passed and redaction is the last irreversible act. |
| D6 | The event-age argument is **required**, not optional with a default. | A silent default that disables the bound is the exact failure mode this change exists to fix. The compiler proves every call site supplies it. Cost: two integration test files join the edit surface. |
| D7 | The 15-minute rule has **one owner**, `worker/ingress/stripe/shared.ts`. | Two throw sites must not carry two copies of the constant. `shared.ts` already owns `AccountNotProvisionedYetError` (line 28), so it is the natural home. |

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
survives until finalize, and `loadPurgeOffboarding` (line 60) re-reads it, so a
retry after a failed redaction still has the id.

`runRawPayloadPurgeStage` (line 459) consumes `row.stripe_customer_id` at lines
481, 489 and 533 to scrub raw payloads. It runs earlier and is unaffected: the
new stage mutates Stripe, never the local row's id.

## Tracer bullets

Each tracer is a thin vertical slice. `T0` is the eval task and is committed
before any implementation.

### T0 — eval task: the 28 promised tests, failing

Author every `tests_to_add` title from the intake as a real test body, committed
red before implementation. Slices not yet buildable use `.todo`. This is the
spec in executable form; each later tracer names the tests it turns green.

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
   `resource_missing` returns `customer_absent`, which is success.

`customers.del` is never referenced. A test asserts the fake client's `del` is
never called.

Turns green: the eight `redactStripeCustomer` tests.

Blocking edges: T0. Runs alone — it carries the first-task enforcement spot check.

### T2 — the purge stage and its ordering

Edits `worker/jobs/account-offboarding/purge-stages.ts` and
`worker/jobs/account-offboarding/PurgeWorker.ts`.

New exported stage `runStripeCustomerRedactionPurgeStage(sql, stripe, row)`.
The three-argument shape has precedent in `runAuthBindingPurgeStage`
(line 111), which takes `supabaseServer`.

Inside one `sql.begin`:

1. `row.stripe_customer_id` null → return `not_applicable`, no Stripe call.
2. **The D1 guard.** Count `accounts` rows sharing this `stripe_customer_id`
   other than `row.account_id`, excluding accounts whose own offboarding is
   already purged. Non-zero → skip the Stripe call, append a
   `skipped_shared_customer` record, return.
3. Otherwise call `redactStripeCustomer` and append a record naming the outcome.

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

Turns green: the six stage and worker tests, including the ordering assertion
and the "does not finalize on a retryable error" assertion.

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

Turns green: the five classification and disclosure tests.

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
   Window closed → log, raise one Sentry **warning** so the case stays visible
   after `HealthAlertPoller` stops counting it, and return. `subscription-updated`
   returns its existing `ignoredOutcome` shape.
3. `worker/ingress/stripe.ts` — pass `event.created` into both handlers at
   lines 89 and 93. The existing `eventAgeSeconds` computation at line 50 and
   the 7-day `STALE_EVENT_THRESHOLD_SECONDS` guard are untouched.
4. Call-site updates for the required argument (D6):
   `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts`,
   `worker/ingress/__tests__/stripe-subscription-updated.test.ts`,
   `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`,
   `src/lib/accounts/__tests__/billing-locks.integration.test.ts`.

Why this kills the alert class: a throw makes the dispatcher write
`inbound_events.status = 'failed'` (`worker/ingress/stripe.ts:107`), and
`worker/background/pollers/health-alert/checks.ts:276` counts exactly those rows
as `inbound_events_failed:stripe:<event_type>`. Returning instead writes
`processed`, so the alert stops.

Turns green: the seven webhook tests, including both boundary cases and the
future-timestamp case.

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
