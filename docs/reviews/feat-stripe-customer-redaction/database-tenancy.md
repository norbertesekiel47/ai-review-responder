# Review wave — DATABASE / TENANCY axis

- **Reviewed SHA:** `00f6d56be77d77b4f1e45ff28a99b7c6bda778fe`
- **Fork point:** `b9fb96016cc025c151f17db4b39baf165cb80a13`
- **Diff:** `git diff b9fb9601..00f6d56b` (50 files, +3247/−144)
- **How files were read:** every source line quoted below was read with
  `git show 00f6d56b:<path>`, never the working tree — a sibling red-team agent
  is mutating this worktree. Line numbers are the reviewed SHA's.
- **Live DB:** the local test database (`TEST_DATABASE_POOL_URL`, port 5499,
  provisioned to migrations head) was read **read-only** — `\d inbound_events`
  and two `EXPLAIN`s under `enable_seqscan=off`. No writes, no DDL.
- **Scope:** tenant predicates, transaction boundaries, migration compatibility,
  rollback, locks, retries, partial application. Findings ≥80% confidence only;
  lower-confidence items are in the appendix.

---

## P1 — `ArchivalPoller`'s widened predicate makes `idx_ie_archival` unusable, re-opening the exact regression migration 065 exists to close

**File:** `worker/background/pollers/ArchivalPoller.ts:94-101` (reviewed SHA)
**Invariant at stake:** migration compatibility — a schema-shaped behaviour change
shipped with no migration; and the working rule that a background sweep on the
fastest-growing table must not seq-scan it.

**Evidence.** The sweep predicate was widened in place:

```sql
      WITH candidates AS (
        SELECT id FROM inbound_events
        WHERE status IN ('processed', 'stale_ignored')     -- was: status = 'processed'
          AND processed_at < NOW() - INTERVAL '30 days'
        LIMIT 5000
      ),
```

The only index that serves this sweep is partial on the *old* predicate.
`supabase/migrations/065_archival_watchdog_indexes.sql:16-19`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ie_archival
  ON inbound_events (processed_at)
  WHERE status = 'processed';
```

and 065's own header states the harm it was written to fix:

> `-- but the only status index (idx_ie_status, 001_initial_schema.sql) is`
> `-- partial WHERE status != 'processed' — it EXCLUDES exactly the rows the`
> `-- daily cleanup scans for, so cleanup seq-scans the fastest-growing table.`

`status IN ('processed','stale_ignored')` does not imply `status = 'processed'`,
so the planner cannot prove the partial-index predicate and no index path exists.
Confirmed against the live test DB at migrations head, with `enable_seqscan=off`
so a disabled seq scan shows its 1e10 penalty cost:

```
-- NEW predicate
 Limit  (cost=10000000000.00..10000000015.60 rows=1 width=16)
   ->  Seq Scan on inbound_events
         Filter: ((status = ANY ('{processed,stale_ignored}'::text[])) AND (processed_at < ...))

-- OLD predicate
 Limit  (cost=0.13..8.15 rows=1 width=16)
   ->  Index Scan using idx_ie_archival on inbound_events
         Index Cond: (processed_at < ...)
```

No migration in this branch adds an index covering the new predicate
(`git diff b9fb9601..00f6d56b -- supabase/migrations/` is empty).

**Failure scenario.** `inbound_events` is the raw-webhook table — every Stripe,
Resend, Twilio, Telegram and Zernio delivery inserts a row. The archival sweep
runs on the shared worker `sql` client whose `connection.statement_timeout` is
30 s (`src/lib/db/server.ts:66`). Once the table is large enough that a full seq
scan exceeds 30 s, the `WITH candidates … DELETE` statement is cancelled every
cycle; nothing is ever reclaimed; the table grows; the scan gets slower. The
failure compounds rather than self-limiting, and it is silent apart from a
poller error line — there is no health-alert probe on archival lag.
Secondary cost, before that threshold: the daily sweep seq-scans the largest
table while holding an admission slot (`src/lib/db/admission.ts`) for its full
duration.

**Concrete fix.** Either add a migration creating
`CREATE INDEX CONCURRENTLY idx_ie_archival_terminal ON inbound_events (processed_at) WHERE status IN ('processed','stale_ignored')`
(and retire `idx_ie_archival`), or split the sweep into two statements each
matching an existing partial predicate. The comment at `ArchivalPoller.ts:88-92`
argues against a second query on retention-policy grounds — that argument is
about the *interval*, and is fully satisfied by two statements sharing one
`INTERVAL '30 days'` constant.

---

## P2 — the redaction guard's `NOT EXISTS` arm is provably unreachable, and the state it should be excluding (`purge_scheduled`) is the one it misses

**File:** `worker/jobs/account-offboarding/purge-stages.ts:769-780`
**Invariant at stake:** #8 (tenant scope — the carve-out reads more than the
guard needs) and purge completeness.

**Evidence.**

```sql
      SELECT COUNT(*)::int AS count
      FROM accounts a
      WHERE a.stripe_customer_id = ${customerId}
        AND a.id <> ${row.account_id}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM account_offboardings ao
          WHERE ao.account_id = a.id
            AND ao.status = 'purged'
        )
```

An account can only reach `account_offboardings.status = 'purged'` by way of
`finalizePurgeInTransaction` (`purge-stages.ts:928-947`), and the tombstone that
runs immediately before it unconditionally nulls the column the outer predicate
matches on — `purge-stages.ts:873-881`:

```sql
      UPDATE accounts
      SET display_name = ${SENTINELS.accountName},
          stripe_customer_id = NULL,
```

`verifyAccountOffboardingPurge` then *asserts* that state before the transition
is allowed (`src/lib/account-offboarding/purge-verification.ts:99`,
`OR stripe_customer_id IS NOT NULL` counts as a violation). Therefore no row can
simultaneously satisfy `a.stripe_customer_id = ${customerId}` and have a
`'purged'` offboarding: **the `NOT EXISTS` arm can never eliminate a row.** It is
dead, and it is what buys the second of the two new
`tenant-scope-allowlist.ts` entries (`ALLOWLIST_BASELINE` 373 → 375) — a
cross-account read of `account_offboardings` that changes no result.

The offboarding statuses, enumerated from `supabase/migrations/056_account_offboarding.sql:27-28`
and its `account_offboardings_mode_status_check` (lines 85-93):

| status | mode reachable | still holds `accounts.stripe_customer_id`? | should block redaction? | blocked today? |
|---|---|---|---|---|
| `pending` | both | yes | **yes** (live co-tenant) | yes (via outer predicate) |
| `scheduled` | cancel_only | yes | **yes** | yes |
| `tearing_down` | both | yes | **yes** | yes |
| `purge_scheduled` | delete_data | **yes** — tombstone has not run | **no** — it is mid-purge, not live | **yes (wrongly)** |
| `purged` | delete_data | no (nulled by tombstone) | n/a | arm is dead |
| `churned` | both | yes | **yes** (cancel_only kept its data) | yes |
| `reactivated` | cancel_only | yes | **yes** | yes |
| `failed` | both | yes | judgement call | yes |

The one status the arm *should* have named is `purge_scheduled`, and it does not.

**Failure scenario (mutual skip).** Accounts A and B share `cus_X`; both are
`delete_data` / `purge_scheduled`. A's redaction stage takes the binding lock,
counts B (still holding `cus_X`, status `purge_scheduled`, no `'purged'` row) →
count 1 → writes `skipped_shared_customer` and returns without touching Stripe.
Its lock releases at commit. B's redaction stage then takes the lock, counts A —
A's tombstone transaction (`purge-stages.ts:820`) has not committed yet, so
`accounts.stripe_customer_id` for A is still `cus_X` and A's status is still
`purge_scheduled` → count 1 → B also skips. Both purges then complete, both
tombstones null the local ids, and `cus_X` keeps its `name`, `email`, `phone`,
`address` and `shipping` at Stripe **forever, with no local handle left to
retry from**. The purge receipt tells both owners their data was deleted.

**Why it does not fire today, and why that is fragile.** The purge worker is
registered with bare `workerOpts` (`worker/index.ts:480-487`), so BullMQ
concurrency is the default 1, and the worker is single-replica by invariant
(`CLAUDE.md` gotcha "Single-replica worker"). Serial execution makes A finish
its tombstone before B starts, and B then sees `stripe_customer_id IS NULL` for
A. The guard's correctness therefore rests on a property the branch never states
and `docs/audits/2026-06-17-worker-scaling-hardening-backlog.md` exists to
relax. The customer-keyed advisory lock serializes the two stages against each
other but does **not** rescue this: serialization is exactly what produces the
mutual skip, because the lock is released at each stage's commit, long before
the sibling's tombstone.

**Concrete fix.** Replace the dead `'purged'` arm with the state that matters —
exclude siblings whose own `delete_data` purge is in flight
(`ao.status IN ('purge_scheduled','purged') AND ao.mode = 'delete_data'`) — which
also makes the `account_offboardings` allowlist entry earn its place. If instead
the intent is "only the last sibling out redacts", the guard has to be a
last-writer election, not a point-in-time count.

---

## P2 — the binding advisory lock and a pooled connection are held across up to ~2 minutes of Stripe network I/O, on a key every subscription webhook for that customer must take

**Files:** `worker/jobs/account-offboarding/purge-stages.ts:763-805`,
`src/lib/accounts/billing-locks.ts:104-113`,
`worker/ingress/stripe/apply-subscription-state.ts:323-326`
**Invariant at stake:** the `#773` admission chokepoint's premise (in-flight
work per process never exceeds the pool) and the PgBouncer transaction-pooling
gotcha.

**Evidence.** The stage opens a transaction, takes the lock, and only then makes
two Stripe HTTP round-trips before committing:

```ts
  await sql.begin(async (tx) => {
    await acquireStripeCustomerBindingLock(tx, customerId);   // :767
    const [sharing] = await tx<{ count: number }[]>`…`;       // :769
    const { outcome } = await redactStripeCustomer({ … });    // :791  ← network
    await appendStripeCustomerRedactionRecord(tx, row, …);    // :797
  });
```

`redactStripeCustomer` issues `customers.retrieve` then `customers.update`
(`src/lib/account-offboarding/stripe-customer-redaction.ts:171,186`) on the
shared client, whose policy is `timeout: 20_000, maxNetworkRetries: 2`
(`src/lib/payments/stripe-client.ts:16-20`). Worst case ≈ 3 × 20 s + 3 × 20 s ≈
**120 s** with the Postgres transaction open the whole time.

Nothing bounds that. The backend is `idle in transaction`, not running a
statement, so the client's `statement_timeout: 30_000`
(`src/lib/db/server.ts:66`) cannot fire on it — this is the same wait-state blind
spot the `#773` lab note records (`wait_event='ClientRead'` … "`statement_timeout`
never fires on it"). `rg -n "idle_in_transaction" src worker supabase` returns
nothing, so no server-side backstop exists either.

The writer half takes the same lock on the ingress hot path, inside the request
transaction (`apply-subscription-state.ts:323-326`):

```ts
  const bindingCustomerId = extractStripeCustomerId(stripeSub.customer, ref);
  if (bindingCustomerId) {
    await acquireStripeCustomerBindingLock(tx, bindingCustomerId);
  }
```

**Failure scenario.** A purge redacts `cus_X` while Stripe is degraded — the
retrieve retries for 60 s. During that window every `customer.subscription.*`,
`invoice.paid`, `invoice.payment_failed` and `checkout.session.completed` event
for `cus_X` blocks in `pg_advisory_xact_lock`, each already inside `sql.begin`
and therefore each **holding its own pool slot and its own admission slot**
(`src/lib/db/admission.ts`). Stripe's webhook timeout is ~10 s, so each blocked
delivery is abandoned and redelivered, and each redelivery takes another slot;
the `inbound_events` row stays `'received'` and is not reclaimable for 10 minutes
(`RECLAIM_AFTER_MINUTES = 10`, `worker/ingress/shared.ts:15`). With the worker
pool at `DB_POOL_MAX ?? 10`, a handful of concurrent stacked deliveries plus the
30 s admission queue deadline (`DB_SLOT_QUEUE_TIMEOUT_MS`) starts returning
`DbSlotTimeoutError` to *unrelated* worker callers — the wedge shape #773 was
built to prevent, reached by a legitimate caller rather than a stuck one.

**Concrete fix.** Split the transaction: take the lock, run the count, record
the decision, **commit**; then make the Stripe call outside any transaction;
then append the outcome record in a second short transaction. The lock's stated
job (`billing-locks.ts:94-97`) is to stop a binding landing *between the count
and the Stripe call* — if that window genuinely must be covered, cover it with a
durable marker row rather than by holding a pooled connection across the
internet. At minimum, cap the exposure with a per-call
`{ maxNetworkRetries: 0, timeout: 5_000 }` request option on the two
`customers.*` calls (the injected client interface at
`stripe-customer-redaction.ts:91-104` already accepts `maxNetworkRetries` on
both) and set `idle_in_transaction_session_timeout` on the worker client.

---

## P2 — `hashtext` is `int4`, so the "cannot join the deadlock cycle" proof rests on key distinctness the function does not provide

**File:** `src/lib/accounts/billing-locks.ts:99-113`
**Invariant at stake:** the documented account → business → entitlement →
account deadlock avoidance (`billing-locks.ts:41-45`).

**Evidence.** The comment asserts:

> `* Lock ORDER is fixed and must not be inverted: an account-scoped tier`
> `* entitlement lock first, this customer-keyed lock second. The redaction guard`
> `* takes ONLY this lock and requests no other, so it cannot join the account ->`
> `* business -> entitlement -> account cycle the comment above describes.`

The *ordering* half of that is sound and I verified it exhaustively. Every
acquisition site (`rg` over `worker/` + `src/`, excluding tests):

| site | order |
|---|---|
| `checkout-completed.ts:268,308` → `apply-subscription-state.ts:325` | entitlement → billing → activation → **binding** |
| `subscription-updated.ts:486` → `:520` | entitlement → billing → **binding** |
| `subscription-deleted.ts:109` → `:110` | entitlement → **binding** |
| `invoice-paid.ts:34`, `invoice-payment-failed.ts:77` | entitlement → **binding** |
| `reconcile-account.ts:190` | entitlement → **binding** |
| `apply-subscription-state.ts:218` | entitlement → **binding** |
| `purge-stages.ts:767` | **binding** only |

Binding is always last and nothing is ever taken after it, so no lock-order cycle
exists **given distinct keys**. That proviso is the gap: all five suffixes
(`:tier_entitlement`, `:overage_sync`, `:activation`, `:location_lifecycle`,
`:stripe_customer_binding`) hash into one namespace via `hashtext`, and
`hashtext` returns `integer` — verified on the live test DB:

```
     h1     |     h2     | pg_typeof
------------+------------+-----------
 -220408301 | -600858148 | integer
```

2^32 keys shared by every lock family. At n distinct live keys the probability
that *some* pair collides is ≈ 1 − e^(−n²/2^33); n = 50 000 (10 k accounts × 5
families) gives ≈ 25 %.

**Failure scenario.** If `hashtext(cus_X + ':stripe_customer_binding')` collides
with `hashtext(acct_B + ':tier_entitlement')`, then while the redaction stage
holds that integer for up to two minutes (previous finding), **account B's
entitlement lane is fully blocked** — every subscription webhook, overage sync
and Autopilot grant for an account with no relationship to the purge. Worse, a
cross-family ABBA becomes constructible: writer W1 holds `L(A:entitlement)` and
waits on `L(C1:binding)`; writer W2 holds `L(B:entitlement)` and waits on
`L(C2:binding)`; if `hash(C1:binding) = hash(B:entitlement)` and
`hash(C2:binding) = hash(A:entitlement)` the two deadlock and Postgres kills one
webhook transaction. The collision risk is pre-existing for the four
account-keyed families, but this branch introduces the first family keyed on a
**different dimension** (a Stripe customer, not an account) and the first lock
held across network I/O — which turns a millisecond-scale collision cost into a
minutes-scale one.

**Concrete fix.** Move to the two-argument form,
`pg_advisory_xact_lock(<family constant>, hashtext(<key>))`, which gives each
family its own 2^32 space and makes the "cannot join the cycle" claim structural
rather than probabilistic. Either way, downgrade the comment's claim from "cannot"
to "does not, given distinct hash keys".

---

## P3 — the disposition append is neither idempotent nor fail-loud

**File:** `worker/jobs/account-offboarding/purge-stages.ts:806-818`
**Invariant at stake:** "Every BullMQ handler is idempotent"; no silent catches.

**Evidence.**

```sql
    UPDATE account_offboardings
    SET provider_dispositions = provider_dispositions || ${tx.json([record] as never)},
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
```

Two issues. (a) There is no dedup predicate, so every re-attempt of the purge
job appends **another** `stripe_customer_redaction` element. `handleAccountOffboardingPurge`
re-runs the whole stage list from `runAuthBindingPurgeStage` on each retry
(`PurgeWorker.ts:79-96`), so a purge that fails at the tombstone and retries N
times leaves N records with N different `recorded_at` values and possibly
different `outcome`s (`redacted` on the first, `already_redacted` afterwards).
The `type` is deliberately not `admin_provider_disposition`, so eligibility is
unaffected — but the compliance record and the admin reconciliation view read
this array. (b) The `UPDATE` has no rowCount assertion: if the `WHERE` misses,
the Stripe redaction still happened and **nothing is recorded, with no error**.
`terminal_at` is NULL at this point in practice, so (b) is latent rather than
live, but the pattern is the one the codebase elsewhere guards against
(`finalizePurgeInTransaction:949-951` throws when its `RETURNING` is empty).

**Fix.** Add `AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(provider_dispositions) e WHERE e->>'type' = 'stripe_customer_redaction')`,
or `RETURNING id` and throw when empty.

---

## P3 — the D5 ordering rationale is not true of the tombstone

**File:** `worker/jobs/account-offboarding/purge-stages.ts:719-731`
**Invariant at stake:** partial application / rollback accuracy.

**Evidence.** The stage's own docblock:

> `* Running late means every local destruction has committed, the point of no`
> `* return has passed, and redaction is the last irreversible act.`

But `runParentTombstonePurgeStage` is a **separate** `sql.begin`
(`purge-stages.ts:820-882`) that runs *after* the redaction stage
(`PurgeWorker.ts:90-91`), and it is the tombstone — not the earlier stages —
that scrubs `users.name`/`email`, `businesses.owner_email`, and
`accounts.display_name`. So at the moment the Stripe write commits, the local
copies of the owner's name and email are still intact and the account is not yet
tombstoned. If the tombstone then fails on its terminal attempt
(`PurgeWorker.ts:111-112` → `markPurgeTerminalFailure`, status `'failed'`,
`terminal_at` stays NULL per `account_offboardings_terminal_status_check`), the
resulting state is: Stripe Customer redacted, local PII still present, purge
parked for an operator. That is recoverable — a re-drive re-runs the stage and
`isAlreadyRedacted` (`stripe-customer-redaction.ts:221-228`) returns
`already_redacted` — but the comment's claim is stronger than the code.

I checked the adjacent worry and it is **closed**: an owner cannot cancel into
this window, because `applyKeepMyData` requires `purge_started_at IS NULL`
(`src/lib/account-offboarding/keep-my-data.ts:197`).

**Fix.** Reword to "every local *content* destruction has committed; the parent
tombstone is the one stage that follows", or move the stage after the tombstone
and before finalize (the customer id survives on `account_offboardings` until
finalize, as the docblock's RETRY SAFETY note already establishes).

---

## P3 — a BullMQ job handler is allowlisted under `background-global-scan`

**File:** `scripts/ci/tenant-scope-allowlist.ts:2826-2841`

Both new entries carry `category: 'background-global-scan'`, whose path rule is
`allowedPrefixes: ['worker/']` (`tenant-scope-allowlist.ts:305-306`), so CI
passes. But `purge-stages.ts` is a job-handler helper, not a poller or scheduler,
and the category's own comment describes "domain scans invoked by registered
pollers/schedulers". This is the first entry to use the category for a queue
handler; the prefix rule is wide enough that it will not stop the next one. Low
severity, but it erodes a category that is doing real classification work.

---

## Verified clean (interrogated, no finding)

- **The count leaks no tenant data.** `SELECT COUNT(*)::int AS count`
  (`purge-stages.ts:770`) projects one integer; no row, id or column value from
  another account crosses the boundary. The `NOT EXISTS` subquery is existence-only
  and correlated on `ao.account_id = a.id`. The cross-account read is genuinely
  irreducible — scoping it to the purging account returns 0 by construction.
- **`inbound_events.status` has no CHECK constraint** — verified by introspecting
  the live test DB at migrations head, not by trusting the code comment:
  `\d inbound_events` lists five indexes and *no* check constraints; `status` is
  `text NOT NULL DEFAULT 'received'`. Adding `'stale_ignored'` with no migration
  is safe.
- **`stale_ignored` falls inside `idx_ie_status`** —
  `btree (status) WHERE status <> 'processed'::text`, confirmed by
  introspection. `claimInboundEvent`'s reclaim predicate
  (`worker/ingress/shared.ts:64-69`) and `checkFailedInboundEvents`
  (`health-alert/checks.ts:274-280`) both sit inside that partial index.
  (The archival query is the one that does *not* — see P1.)
- **`accounts.stripe_customer_id` has exactly one live writer, and it is under
  the lock.** `rg` over non-test sources finds only
  `apply-subscription-state.ts:389` and `:402`, both
  `stripe_customer_id = COALESCE(stripe_customer_id, ${stripeCustomerId})`
  (write-once), both downstream of the binding lock at `:325`. The account
  `INSERT`s in `src/lib/onboarding/create-business.ts:251,377` do not set the
  column. The doc comment at `worker/ingress/stripe/shared.ts:18-19` calling
  checkout-completed "the ONLY writer" is stale phrasing — checkout-completed
  reaches the write through `applyStripeSubscriptionStateUnderEntitlementLock`
  — but the lock placement is correct.
- **`provider_dispositions` concatenation is well-typed.** The column is
  `JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(...) = 'array')`
  (`056_account_offboarding.sql:64-65`), so `||` is array concatenation and can
  never hit the object-||-array error or the `NULL || x = NULL` trap. The new
  site uses `tx.json(...)` per invariant #15 / the Postgres.js JSONB rule, and
  matches the two pre-existing append sites at `:563` and `:673` verbatim.
- **No new `SELECT … FOR UPDATE` outside `sql.begin()`.** The redaction stage
  adds a plain `SELECT COUNT(*)` inside `sql.begin`; the diff adds no `FOR UPDATE`
  anywhere.
- **`PROVIDER_DATA_RETENTION` stays out of both table inventories.** It is a
  separate `as const satisfies readonly ProviderDataRetention[]`
  (`table-disposition.ts:445-456`); `ACCOUNT_OFFBOARDING_TABLES` (`:418-420`) and
  `PURGE_VERIFICATION_TABLES` (`:426-428`) both derive from `TABLE_DISPOSITIONS`
  only. If a provider entry ever leaked into `TABLE_DISPOSITIONS`,
  `verificationQuery`'s exhaustive switch would throw
  `missing_purge_verification_sql` at purge time and terminalize the purge —
  which is what the docblock claims, and it is accurate.
- **Purge cancellation cannot race the redaction.** `applyKeepMyData`'s guard
  includes `purge_started_at IS NULL` (`keep-my-data.ts:197`), so no owner action
  can restore an account whose Stripe Customer has just been redacted.
- **The redaction stage cannot deadlock against a row lock.** It takes one
  advisory lock and then touches exactly one row (`account_offboardings` for the
  purging offboarding); no ingress path locks `account_offboardings` before
  waiting on the binding key.

---

## Appendix — below the confidence bar

1. **Re-binding a customer to a previously-purged account.** The unique index
   `account_offboardings_one_active_per_account` is partial on
   `terminal_at IS NULL`, so a purged account can acquire a *new* offboarding row,
   and `accounts` rows survive the purge as tombstones. If a tombstoned account
   could ever be re-bound to a Stripe customer, the dead `NOT EXISTS` arm from the
   P2 finding would become live *and wrong* (it would classify a re-activated
   account as not-a-live-co-tenant). I could not construct that path — onboarding
   creates new `accounts` rows and `resolveAccountReference` looks up by a column
   the tombstone nulled — so I am below 80 % that it is reachable. Flagging it
   because it is the one scenario where the arm is worse than dead.

2. **Monitoring visibility change for orphaned customers.** Before this branch, a
   subscription event with no resolvable account marked `inbound_events` `'failed'`
   on every one of Stripe's ~3 days of retries, so
   `checkFailedInboundEvents` (`health-alert/checks.ts:273`, filtering
   `status = 'failed'`) would page after `failedThreshold`. Now, after 900 s the
   row closes as `'stale_ignored'` and that probe never sees it; the only signal is
   the Sentry `captureMessage` at `worker/ingress/stripe/shared.ts:107`. That looks
   deliberate (the warning is described as "the operator's only handle"), but I
   have no evidence anyone decided to give up the health-alert path, and Sentry
   warnings are not paging. Raising it for the observability axis rather than
   claiming it as a database finding.

3. **`DB_POOL_MAX` on Railway.** The P2 pool-exhaustion arithmetic assumes the
   worker runs at the `readPoolMax()` default of 10 (`src/lib/db/server.ts:62`).
   I did not read the Railway variable, so the concurrency at which
   `DbSlotTimeoutError` starts firing is an estimate, not a measurement. The
   unbounded-hold mechanism itself is not in doubt.
