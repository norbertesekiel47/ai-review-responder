# Review — ASYNC / OPERATIONS axis

- **Reviewed SHA:** `00f6d56be77d77b4f1e45ff28a99b7c6bda778fe`
- **Fork point:** `b9fb96016cc025c151f17db4b39baf165cb80a13`
- **How files were read:** every source line quoted below was read via
  `git show 00f6d56b:<path>` / `git diff b9fb9601..00f6d56b -- <path>` — never
  from the working tree, which a sibling red-team agent is mutating concurrently.
  Line numbers are line numbers **at 00f6d56b**.
- **Scope:** outbox atomicity, idempotency, poison work, timeout/retry bounds,
  observability, recovery, kill switches. Read-only; no file outside this report
  was touched.

Checked `docs/reviews/finding-checklists/async.md` (11 accepted entries, all from
`fix/1079-ledger-kill-switch-containment`) against this diff. The recurring class
there — **a load-bearing docblock claim that is false or unenforced at the SHA
that wrote it** — recurs here three times (A1, A3, A7). One entry generalises
directly: *"a total non-throwing predicate is possible, so the accepted gap was
avoidable"* → A6 below is the same shape (an exported vocabulary constant that
nothing consumes and no audit enforces).

---

## P1 findings

### A1 — `ArchivalPoller`'s new predicate cannot use `idx_ie_archival`, and no migration adds a replacement: the sweep seq-scans `inbound_events`

**File:** `worker/background/pollers/ArchivalPoller.ts:95-99` (at 00f6d56b)
**At stake:** recovery/retention bounded work; the branch's own claim in
`worker/ingress/shared.ts:28-31` that "the new value is indexed".

Shipped:

```sql
      SELECT id FROM inbound_events
        WHERE status IN ('processed', 'stale_ignored')
          AND processed_at < NOW() - INTERVAL '30 days'
        LIMIT 5000
```

The only index that served the old predicate is `supabase/migrations/065_archival_watchdog_indexes.sql:16-18`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ie_archival
  ON inbound_events (processed_at)
  WHERE status = 'processed';
```

and migration 065's own header explains why it exists:

> the only status index (idx_ie_status, 001_initial_schema.sql) is partial
> `WHERE status != 'processed'` — it **EXCLUDES exactly the rows the daily
> cleanup scans for, so cleanup seq-scans the fastest-growing table**.

A partial index is usable only when the query's restriction clauses **imply** the
index predicate. `status = ANY('{processed,stale_ignored}')` does not imply
`status = 'processed'`, and Postgres does not decompose a `ScalarArrayOp` into
per-element branches to match partial indexes. It equally does not imply
`idx_ie_status`'s `status != 'processed'`. **Neither partial index is usable,**
so the archival CTE falls back to a sequential scan — the precise regression 065
was written to remove. The branch ships **no migration** (`git diff --stat` shows
no `supabase/migrations/` file); it only re-pins the query text in
`scripts/ci/tenant-scope-allowlist.ts:2801`, so `ci:tenant-scope` goes green over
the change.

**Failure scenario.** `ArchivalPoller` runs its 30-day sweep. `inbound_events` is
the highest-volume table (every Stripe/Resend/Twilio/Telegram/Zernio webhook,
retained 30 days). The CTE now seq-scans the full table on every run instead of
range-scanning `idx_ie_archival`. On the single-replica Railway worker that scan
holds one of `SHARED_POOL_MAX` = 10 shared-pool connections behind the #773
admission cap, and the CTE is already the reason `statement_timeout` was raised
to 30 s — once the seq scan exceeds 30 s the DELETE aborts, the sweep stops
reclaiming, and `inbound_events` grows without bound while the poller
"succeeds"/retries forever.

**Note the docblock is right about the wrong index.** `worker/ingress/shared.ts:28-31`
says "`idx_ie_status` is partial on `status != 'processed'`, so the new value is
indexed." True in isolation, but irrelevant: `claimInboundEvent`'s reclaim keys on
the `external_event_key` UNIQUE index, and the consumer that actually needs an
index on the new value — the ArchivalPoller — is the one this reasoning does not
cover.

---

### A2 — The age-ack removes the only paging signal for a systemic checkout-completed failure, and nothing watches the ack rate

**Files:** `worker/ingress/stripe.ts:131-145`;
`worker/background/pollers/health-alert/checks.ts:274-288`;
`worker/background/pollers/health-alert/checks.ts:60-61`
**At stake:** "can this change silence a real incident?" — the axis question, and
CLAUDE.md's `beta-launch-alerting` posture (HealthAlertPoller is the pager;
Sentry warnings are not).

The alert this displaces fires at a threshold of **zero**:

```ts
    failedWindowS: num(cfg.HEALTH_ALERT_FAILED_WINDOW_S, 3600),
    failedThreshold: num(cfg.HEALTH_ALERT_FAILED_THRESHOLD, 0),
```
```sql
    FROM inbound_events
    WHERE status = 'failed'
      AND received_at > NOW() - make_interval(secs => ${cfg.failedWindowS})
```

and the branch pins it failed-only, deliberately
(`health-alert/__tests__/checks.test.ts`, new case: *"The alert class this branch
exists to kill … it must fall outside this query entirely"*).

Before this branch, an unresolvable customer produced a `failed` row that Stripe
re-delivered for ~3 days; each redelivery reclaimed the row and reset
`received_at = NOW()` (`worker/ingress/shared.ts:64-66`), so `count > 0` stayed
true in every rolling hour and the check paged continuously until a human acted.
After this branch the row is acked once the 900 s window closes, Stripe stops
redelivering, and within one `failedWindowS` the count returns to zero **permanently**.

The replacement signal is a single `Sentry.captureMessage(..., { level: 'warning' })`
(`worker/ingress/stripe/shared.ts:104-124`). Nothing aggregates it, nothing
thresholds it, and `checkFailedInboundEvents` is the only `inbound_events` probe
in `checks.ts` — I enumerated them (`git grep -n inbound_events` over
`health-alert/`): line 276 is the sole reference.

**Failure scenario.** `processCheckoutSessionCompleted` breaks for a class of
signups — a bad `ref_id`, a regression in the admin-invite/Beta-comp funnel, a
Stripe endpoint-version drift changing the session shape. `accounts.stripe_customer_id`
is never written for any new customer. Every `customer.subscription.updated` /
`.deleted` for every affected signup 500s for 15 minutes (paging), then acks
silently forever. At minute 16 the dashboard is green while **every new paying
customer is being dropped on the floor**. The retained `stale_ignored` rows are
individually replayable, but nothing tells an operator they exist, and after 30
days A1's sweep deletes them.

The one-line fix that would close it — a `checkStaleIgnoredInboundEvents` probe
keyed on `status = 'stale_ignored' AND processed_at > NOW() - window` with its own
threshold — is exactly the shape of the check being displaced, and is absent.

---

### A3 — A Stripe outage inside the redaction stage produces a **terminal half-purge**, and the D5 ordering docblock's justification for it is factually wrong

**Files:** `worker/jobs/account-offboarding/purge-stages.ts:731-737` (the claim),
`:820-884` (`runParentTombstonePurgeStage`), `worker/jobs/account-offboarding/PurgeWorker.ts:76-113`
**At stake:** "What happens on the TERMINAL BullMQ attempt? Does the purge fail
closed, and is the failure observable?"

The docblock at `purge-stages.ts:731-737`:

> ORDERING (D5). This runs LATE … Running FIRST would fail fast with nothing
> destroyed, but a later local failure would then leave a LIVE account whose
> Stripe billing contact is already wiped. **Running late means every local
> destruction has committed, the point of no return has passed, and redaction is
> the last irreversible act.**

"Every local destruction has committed" is **false at that point in the pipeline.**
`PurgeWorker.ts:78-91` orders the stages:

```
runAuthBindingPurgeStage → runDependentReferencePurgeStage → runRawPayloadPurgeStage
→ runContentPurgeStage → runAnalyticsPurgeStage → runProviderIdentifierPurgeStage
→ runAuditAndCostPayloadPurgeStage
→ runStripeCustomerRedactionPurgeStage      ← the new stage
→ runParentTombstonePurgeStage              ← where PII is ACTUALLY replaced
→ finalizePurgeInTransaction
```

The tombstone (`:820-884`) is the stage that replaces the owner's real name,
email, phone, `owner_email`, `owner_phone`, business name, address, lat/lng and
the postal-address attestation tuple with sentinels. It runs **after** the new
stage, so at the moment redaction is attempted the account's identifying PII is
still fully intact in `users`, `businesses` and `accounts`.

**Failure scenario.** Stripe has a multi-hour incident (or the key is rotated and
`STRIPE_SECRET_KEY` is stale — `isRetryableStripeError` classifies `authentication_error`
as permanent, which is worse: one attempt, then terminal). `redactStripeCustomer`
throws. `PurgeWorker.ts:105-112` retries; on `isTerminalAttempt(job)` it calls
`markPurgeTerminalFailure` + `markOutboxFailed` and **returns without re-throwing**.
The offboarding is now `failed` / terminal. Final state of that account:

- reviews, responses, approval links, notification deliveries, analytics,
  provider identifiers, audit payloads — **destroyed**;
- Supabase Auth user — **deleted** (stage 1);
- `users.name` / `.email` / `.phone`, `businesses.owner_email` / `.owner_phone` /
  address, `accounts.display_name`, `accounts.stripe_customer_id` — **all still live**;
- the Stripe Customer — **still fully identifying**;
- purge receipt — never sent; the owner is told nothing.

That is strictly worse than either alternative the docblock weighs: the account
is unusable *and* still identifying, and no automatic path re-runs it (the outbox
row is `failed`, terminal). Failing closed on Stripe is the right call; placing
the stage before the tombstone rather than after it is what turns a recoverable
retry into an unrecoverable half-purge, and the comment that authorises the
placement asserts the opposite of what the code does.

Observability of the terminal state is adequate (`alertPurgeFailure` raises a
Sentry `error` with `terminal: 'true'`, and `checkFailedOutboxJobs` thresholds
`job_outbox` failures at 0) — the defect is the state itself, not its visibility.

---

## P2 findings

### A4 — The stage emits no log line; the intake promised one per outcome

**File:** `worker/jobs/account-offboarding/purge-stages.ts:755-803`
**At stake:** `docs/superpowers/plans/feat-stripe-customer-redaction-intake.json:185`:

> "A structured worker log line per redaction outcome: redacted, already_redacted,
> skipped_shared_customer, not_applicable, customer_absent. The stripe customer id
> is scrubbed."

`runStripeCustomerRedactionPurgeStage` takes `(sql, stripe, row)` — **no logger
parameter** — and its body contains no `console.*` and no `createWorkerLogger`
call. I read all 49 lines. The only record of any outcome is the JSONB append at
`:805-818`. This is the one purge stage that makes a live third-party call, and it
is the only one with no log line at all.

**Failure scenario.** An operator investigating "did we actually redact customer
X?" has: no log, no metric, no Sentry event on success or skip. The single source
of truth is `account_offboardings.provider_dispositions`, a JSONB column with no
reader, no admin surface, and a SHA-256 hash instead of the id — so the operator
cannot even find the row from a Stripe-side customer id without hashing it by
hand. Combined with A5, the `skipped_shared_customer` outcome is invisible.

### A5 — Two co-tenants purging concurrently both skip redaction, permanently, silently

**File:** `worker/jobs/account-offboarding/purge-stages.ts:769-789`

```sql
      SELECT COUNT(*)::int AS count
      FROM accounts a
      WHERE a.stripe_customer_id = ${customerId}
        AND a.id <> ${row.account_id}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM account_offboardings ao
          WHERE ao.account_id = a.id AND ao.status = 'purged'
        )
```

`status = 'purged'` is written **only** by `finalizePurgeInTransaction`
(`:928-940`), which runs two stages *after* this one. So an account that is
mid-purge is, by construction, always counted as a live co-tenant.

**Failure scenario.** Accounts A and B share one `cus_…` (the branch itself
documents that `accounts.stripe_customer_id` has no unique constraint —
`billing-locks.ts:88-92`). Both request `delete_data`. The customer-keyed
advisory lock serialises them, which is what makes the outcome deterministic
rather than racy:

1. A takes the binding lock, counts B → B has no `purged` offboarding → count 1
   → **skip**, append `skipped_shared_customer`, commit, release.
2. A tombstones; A finalizes; `scrubLifecycleReceiptInTransaction` (`:1063-1080`)
   nulls `account_offboardings.stripe_customer_id`. A's local copy is gone.
3. B takes the lock, counts A. A's `accounts.stripe_customer_id` is now NULL
   (tombstone, `:876`) so A does not match — **but the same reasoning applied in
   reverse timing (B reaching step 1 before A finalizes) makes B skip too.**

Both purges report success and send deletion receipts. The Stripe Customer keeps
its name, email, phone and address forever, and **neither account retains the id
to retry with**. The same terminal outcome arises from the far more likely
one-sided case: any co-tenant whose own purge failed terminally (A3) or who is
merely cancelled sits in `accounts` forever, so the purging account skips
redaction permanently. Skipping to protect a live co-tenant is correct policy
(D1); the defect is that the skip is terminal, unobservable (A4), unalerted, and
indistinguishable from success in the deletion receipt.

### A6 — The transaction spans two unbounded Stripe calls; the retry knob the interface declares is never passed

**Files:** `src/lib/account-offboarding/stripe-customer-redaction.ts:87-104`
(interface), `:152-183` (call sites), `worker/jobs/account-offboarding/purge-stages.ts:763-802`
**At stake:** CLAUDE.md — "Every outbound provider call gets an explicit timeout +
bounded, jittered retries"; the PgBouncer `statement_timeout` gotcha.

The declared client advertises the bound:

```ts
    retrieve: (customerId: string, params?: Record<string, never>,
      requestOptions?: { maxNetworkRetries?: number }) => Promise<StripeCustomerLike>;
    update: (customerId: string, params: Record<string, unknown>,
      requestOptions?: { idempotencyKey: string; maxNetworkRetries?: number }) => …
```

Neither call site uses it:

```ts
    customer = await stripe.customers.retrieve(customerId);           // :152, no options at all
    await stripe.customers.update(customerId, buildRedactionParams(…),
      { idempotencyKey: stripeCustomerRedactionIdempotencyKey(offboardingId) });   // :174-178
```

so both inherit `STRIPE_CLIENT_CONFIG` (`src/lib/payments/stripe-client.ts:16-20`):
`timeout: 20_000`, `maxNetworkRetries: 2`. Worst case is two sequential chains of
3 attempts × 20 s plus SDK backoff — **on the order of 120 s** — all of it inside
`sql.begin` (`purge-stages.ts:763`), holding:

- one of `SHARED_POOL_MAX` = 10 shared-pool connections, idle-in-transaction,
  behind the #773 admission cap (`src/lib/db/server.ts:44,55-70`);
- the customer-keyed advisory lock, taken at `:767` and explicitly required to
  "outlive the Stripe call".

`connection.statement_timeout: 30_000` bounds **statements**, not transactions,
and the Stripe call is not a statement — so nothing in the system bounds this. It
is the only transaction in the codebase held open across an external network call,
and it runs ~4× longer than the 30 s ceiling every other transaction respects.

**Failure scenario.** Stripe degrades to 20 s timeouts. A purge stage sits
idle-in-transaction for ~2 minutes. Concurrently a `customer.subscription.updated`
for the same customer arrives; `applyStripeSubscriptionStateInternal:325` blocks
on `pg_advisory_xact_lock` — that *is* a statement, so `statement_timeout` kills
it at 30 s → the handler throws → `worker/ingress/stripe.ts:143-152` writes
`status='failed'` + 500 → and per A2's threshold of 0, `checkFailedInboundEvents`
pages. A slow provider call in the offboarding lane thus manufactures a webhook
incident. (Self-recovering via Stripe's redelivery, which is why this is P2 and
not P1 — but the unbounded hold is the root and is trivially fixable by passing
`{ maxNetworkRetries: 0 }` and moving `redactStripeCustomer` outside `sql.begin`.)

### A7 — `RECLAIMABLE_INBOUND_EVENT_STATUSES` invokes the `OUTBOX_IN_FLIGHT_STATUSES` idiom without the audit that makes that idiom safe

**File:** `worker/ingress/shared.ts:18-34`

```ts
 * ... The predicate below
 * spells the members literally — this constant is what the tests assert against,
 * mirroring the `OUTBOX_IN_FLIGHT_STATUSES` idiom.
 */
export const RECLAIMABLE_INBOUND_EVENT_STATUSES = ['failed', 'stale_ignored'] as const;
```

I enumerated every reference (`git grep RECLAIMABLE_INBOUND_EVENT_STATUSES 00f6d56b`):
`shared.ts` (the declaration + two comments), `docs/directory.md:1762`, and
`worker/ingress/__tests__/shared.test.ts:36,84-85`. **Zero production consumers.**
The tests assert only `toContain('stale_ignored')` / `toContain('failed')` on the
constant itself — never that `claimInboundEvent`'s SQL (`shared.ts:64-70`) spells
the same set.

The idiom it names is safe precisely because CLAUDE.md invariant #2 backs it with
`ci:outbox-status`, which "checks members **and order**" at every hand-spelled
site. There is no equivalent audit here, and none was added.

**Failure scenario.** A future change adds a third reclaimable status to the
constant, or drops `stale_ignored` from the SQL `OR` chain in `claimInboundEvent`.
Every gate stays green (`ci:static-policy`, `ci:outbox-status`, the two `toContain`
assertions, typecheck). The regression is silent: an operator's dashboard resend
of an acked event returns `duplicate` / 200, the replay path this whole design
exists to preserve is gone, and nothing surfaces it. This is the accepted-findings
class *"a total non-throwing predicate is possible, so the accepted gap was
avoidable"* — the fix is one `.some()` over the constant in the SQL builder, or
one line in `static-policy-audit.ts`.

---

## P3 findings

### A8 — No kill switch and no env-registry row for a new provider write in the purge lane

`git diff --stat b9fb9601..00f6d56b -- docs/eservices-variables.md .claude/reference/env-vars.md`
returns nothing: neither file changed. Every `delete_data` purge now makes two
live Stripe writes with no flag to disable them. `ci:env-registry` cannot catch
this — it fails a var that *is* read with no row, never the absence of a var.

This is out of pattern for the repo: `LLM_CIRCUIT_BREAKER_ENABLED`,
`DB_ADMISSION_ENABLED`, `OPENAI_MODERATION_ENABLED`, `TRIAGE_ENABLED`,
`JUDGE_ENABLED`, `AUTO_APPROVAL_ENABLED` all exist so a misbehaving dependency can
be taken out of a lane without a redeploy. Given A3 (a Stripe outage terminalizes
every in-flight purge into a half-purge), the recovery play during an incident is
"redeploy the worker with the stage commented out" — which is what a flag exists
to avoid. A `STRIPE_CUSTOMER_REDACTION_ENABLED` default-on flag, skipping the
stage and appending a `skipped_disabled` record, would make the incident
survivable. Not a defect in the shipped behaviour, but a gap the owner should
decide on rather than inherit.

### A9 — The disposition record can silently fail to write after the Stripe mutation has landed

**File:** `worker/jobs/account-offboarding/purge-stages.ts:805-818`

```sql
    UPDATE account_offboardings
    SET provider_dispositions = provider_dispositions || ${tx.json([record] as never)}, …
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
      AND terminal_at IS NULL
```

`redactStripeCustomer` runs at `:791` **before** this UPDATE. If `terminal_at` was
set between `loadPurgeOffboarding` and this statement (a concurrent
`markPurgeTerminalFailure` from a stale attempt, or the `purge_cancelled_at` path),
the UPDATE matches 0 rows and returns without error. The Stripe Customer is
redacted, the transaction commits, and — with A4's missing log line — there is no
record anywhere that it happened. The `terminal_at IS NULL` guard is consistent
with the sibling stages, but those stages write *before* their irreversible act,
not after it.

---

## Appendix — below the 80% confidence bar

- **Ack-path correctness.** I traced every arm of both handlers and found no path
  where the dispatcher's status disagrees with the handler's report.
  `subscription-deleted` returns the frozen `ACKED_FOR_AGE`/`HANDLED_NORMALLY`
  singletons on all five exits; `subscription-updated`'s `stale_no_account` is
  produced at exactly one site (`:627`) and consumed by an exact
  `kind === 'ignored' && reason === 'stale_no_account'` test at
  `worker/ingress/stripe.ts:120-121`. A throw after the ack decision is impossible
  because the decision *is* the return. `markInboundEventStaleIgnored` throwing is
  caught by the dispatcher's own catch → `failed` + 500 → Stripe retries → the row
  reclaims. **No finding.**
- **Deadlock.** The docblock claim "This stage requests no other lock, so it cannot
  participate in a deadlock cycle" is imprecise — the stage does take an
  `account_offboardings` row lock at `:810`, after the advisory lock. I could not
  construct a cycle: the only other `acquireStripeCustomerBindingLock` caller
  (`apply-subscription-state.ts:325`) never touches `account_offboardings` inside
  its transaction, and the stage never waits on an `accounts` row lock. The claim's
  conclusion holds even though its premise does not. Flagging the wording only.
- **Single-replica.** Nothing in the diff newly assumes single-replica. The
  customer-keyed advisory lock is genuinely replica-safe (`pg_advisory_xact_lock`
  is cluster-wide, not in-process), so the redaction guard would survive a second
  replica — that is real, not incidental. The pre-existing `hashtext()` → int4 lock
  space is now shared by five suffixes instead of four; collision risk is
  unchanged in kind.
- **Sentry warning storm.** `warnStripeSubscriptionEventAckedForAge` uses a fixed
  message string, so Sentry groups every occurrence into one issue — a storm
  inflates an event count rather than flooding the issue stream. Whether the
  per-event `extra` survives Sentry's sampling well enough for an operator to
  enumerate affected customers, I could not determine from the code.
- **`!customerId` early return** (`purge-stages.ts:760-761`) writes no record at
  all, so "no Stripe customer" and "stage never ran" are indistinguishable after
  the fact. Whether the teardown path can null `account_offboardings.stripe_customer_id`
  before the purge — which would turn a real redaction into a silent no-op — I did
  not verify; `scrubLifecycleReceiptInTransaction` (finalize) is the only writer I
  confirmed.
- `getStripe()` is evaluated eagerly at `PurgeWorker.ts:91` even for offboardings
  with no customer id. It cannot throw in practice: `STRIPE_SECRET_KEY` is in
  `STRIPE_WORKER_REQUIRED_ENV` (`worker/config/startup-assert.ts:18-21`), so the
  worker fails at boot rather than here. **No finding.**
