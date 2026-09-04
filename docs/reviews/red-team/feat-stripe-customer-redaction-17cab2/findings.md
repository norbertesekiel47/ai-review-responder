# Red team — `feat/stripe-customer-redaction` — ROUND 2 (final)

- **Mode:** feature · **Risk:** high · **Round:** 2 of 2 (cap spent)
- **fork:** `b9fb96016cc025c151f17db4b39baf165cb80a13`
- **merge-base:** `b9fb96016cc025c151f17db4b39baf165cb80a13`
- **HEAD:** `02bb77002b0258240ba5abb0f0cbf9d49fd10917`
- **Round-2 scope:** `git diff 00f6d56b..02bb7700` — the fix hunks and their direct
  callers. Parts of the branch round 1 cleared were not re-audited.
- **Round 1's report** (2 P0, 8 P1, 4 P2) is preserved in git history at commit
  `29a97f0d`; the checker derives exactly one report path per branch, so the
  round-2 sidecar replaces it in the working tree.
- **Status at the time of the pass: `OPEN_P0`** — 3 P0, 6 P1, 2 P2 · inventory 17 · 6 killed, 1 survivor
  (reclassified `inconclusive`), 5 uncovered, 5 excluded, 0 skipped for budget.

> Round 1 found the defects. Round 2 finds that **the fixes are individually
> sound and mutation-proof — six of seven mutations died, including round 1's own
> F02 mutation — while the pass left the branch's authoritative documentation
> asserting the world it had just repudiated, and shipped a new guard predicate
> that is wrong in the modal case it was meant to protect.**

---

## Attacks the code SURVIVED (results, not findings)

### S1 — the D5-inversion gating claim holds (task item 1)

Claim: no live, serviceable account can exist after redaction has run, because
cancellation is gated on `purge_started_at IS NULL`.

Attacked by enumerating every writer and every escape hatch:

- `purge_started_at` is stamped by `AccountOffboardingPurgePoller.ts:126` inside
  the **claim transaction**, before the outbox row dispatches — so it is always
  set by the time `PurgeWorker` reaches stage 1.
- `keep-my-data.ts:181-199` is the **only** writer of `purge_cancelled_at` in the
  repo (`rg 'purge_cancelled_at'`, whole tree, non-test), and it carries
  `AND purge_started_at IS NULL`.
- No admin route resets `purge_started_at`, un-terminalizes a failed purge, or
  re-drives one: `rg -l 'account_offboarding' src/app/api/admin src/app/admin`
  returns only the impersonation route.
- Reactivation (`reactivate.ts:240-247, 268-283`) is gated
  `mode = 'cancel_only' AND status = 'scheduled' AND teardown_started_at IS NULL`.
  A `delete_data` offboarding cannot reach it.

**The ORDERING rationale is sound.** But the same docblock
(`PurgeWorker.ts:96-99`) says *"The shared-customer guard, not the ordering, is
what protects a co-tenant."* That sentence is correct, and it is why R03 is a P0:
the guard does not use the point-of-no-return marker the ordering argument
depends on.

### S2 — the ArchivalPoller index claim holds, verified by EXPLAIN (task item 2)

Measured rather than trusted. Indexes at HEAD:
`idx_ie_archival btree(processed_at) WHERE status='processed'` and
`idx_ie_status btree(status) WHERE status <> 'processed'`. With `enable_seqscan=off`:

| Query | Plan |
|---|---|
| arm 1 (`status='processed'`) | `Index Scan using idx_ie_archival`, `Index Cond: processed_at < …` |
| arm 2 (`status='stale_ignored'`) | `Index Scan using idx_ie_status`, `Index Cond: status='stale_ignored'`, `Filter: processed_at < …` |
| old `status IN ('processed','stale_ignored')` | `Seq Scan`, cost `10000000000.00` — **no index path at all** |

The full `UNION ALL` CTE plans both arms through their own index. Migration
citations check out too: `idx_ie_archival` exists only in
`065_archival_watchdog_indexes.sql`; `idx_ie_status` is created in
`001_initial_schema.sql:291` with the `!= 'processed'` predicate. **Claim verified
in full.** Its *reporting* half did not survive — see R06.

### S3 — `processed_at` is the right window column for the new probe (task item 5)

`markInboundEventStaleIgnored` (`worker/ingress/shared.ts:96-101`) writes
`status='stale_ignored', processed_at = NOW()`, and its docblock says the stamp
exists so ArchivalPoller can sweep on it. Reclaim (`shared.ts:62-70`) does not
NULL it and a re-acked row re-stamps it, so a redelivered orphan stays in-window.

It is also the **only** writer of `stale_ignored` in the tree
(`worker/ingress/stripe.ts:140` is its one call site), so the probe cannot be
tripped by the Resend solicitation lane's #967 acks — which matters, because
`beta-launch-alerting.md` §1 rates those as expected noise below 3/hour and this
probe fires at `error` above 5/hour.

### S4 — Duty 4 sibling search: ZERO siblings, sound search recorded

Fixed shape: *a `status IN (…)` whose members are split across two different
single-value partial indexes, so neither is matched.*

Searched every `status IN (` / `delivery_status IN (` / `generation_status IN (`
in `src/lib/**` and `worker/**` (excluding `__tests__`), cross-checked against
every partial index in the live schema (`pg_indexes WHERE indexdef LIKE '%WHERE%'`):

| Call site | Backing index | Matches? |
|---|---|---|
| `job_outbox status IN ('pending','dispatching','dispatched')` (14 sites) | in-flight partial indexes spelled `= ANY (ARRAY[…])` | yes — invariant #2's byte-for-byte contract |
| `zc.status IN ('pending','active')` (`confirm.ts:276`, `snapshot.ts:115`) | `zernio_connections_one_active_per_business … WHERE status = ANY (ARRAY['pending','active'])` | yes |
| `delivery_status IN ('rendered','queued','sending')` (`approval.ts:1382`) | `solicitation_outreach_one_live_per_ask … WHERE delivery_status = ANY (ARRAY['rendered','queued','sending'])` | yes |
| `responses status IN ('approved','edited','awaiting_owner_connect')` (`zernio-publisher.ts:195`) | — | excluded: keyed `UPDATE` guard, not an index-driven scan |
| `keep-my-data.ts:195` | — | excluded: PK lookup |

`inbound_events` was the unique case: two **single-value** partial indexes that
between them cover the set while neither can be matched by a ScalarArrayOp.
**No missed sibling exists.**

### S5 — six of seven mutations died

Every mutation the task named, plus three more, re-run at HEAD under the
allowlisted environment. Round 1's F02 mutation (`ackedForAge = false` at the
delete arm) **now dies**. Full detail in the sidecar's inventory.

---

## P0 — blocks the PR

### R01 — `CONTEXT.md`'s LOCKED terms still assert the world this pass repudiated

`CONTEXT.md:168-171` is the authoritative domain model. This pass corrected three
confident-but-false sentences **in the code docblocks** and left the identical
claims standing in `CONTEXT.md`, which no CI check reads.

1. **`CONTEXT.md:170`** — *"**It runs LATE** (D5), after
   `runAuditAndCostPayloadPurgeStage` and immediately before
   `runParentTombstonePurgeStage` … running first would fail fast with nothing
   destroyed, but a later local failure would then leave a **live** account whose
   Stripe billing contact is already wiped."*
   At HEAD the stage runs **first** (`PurgeWorker.ts:100`). The locked term does
   not merely carry a stale ordering — it argues *against* the ordering that
   shipped, on a hazard `PurgeWorker.ts:93-99` now says is unreachable. A reader
   who trusts the domain model concludes the code is the bug.
2. **`CONTEXT.md:170`** — *"`acquireStripeCustomerBindingLock` (D8) which the
   stage takes **ALONE**."* `purge-stages.ts:757-762` at HEAD: *"It does take a
   second lock … 'requests no other lock' was simply false."*
3. **`CONTEXT.md:171`** — *"the purge receipt and the privacy policy's Retention
   paragraph are **both written from it**."* `table-disposition.ts:446-455` at
   HEAD: *"neither imports this array … An earlier version of this comment said
   they 'are written from these reasons', which implied a coupling that does not
   exist."*

Fourth, weaker: `:170` defines the operation as eight fields plus metadata and
omits **PaymentMethod detachment**, a new irreversible provider-side effect.

**Fix:** re-resolve `CONTEXT.md:168-171` in the same change as the code
docblocks — CLAUDE.md's "one authoritative owner per fact".

### R02 — four `docs/directory.md` rows are false at HEAD, made so by this pass

Round 1's F01 fixed the two rows it named and predicted a further
self-description defect. `ci:directory-map` checks **completeness**, never truth.

| Line | Claim | Reality at `02bb7700` |
|---|---|---|
| `:1684` | ArchivalPoller "sweeps BOTH terminal statuses … **in one predicate**" | Two equality arms under `UNION ALL` (`ArchivalPoller.ts:113-131`). "One predicate" is verbatim the reasoning `ArchivalPoller.ts:96-99` records as *the cause of the defect*. |
| `:1650` | PurgeWorker "… → audit/cost payloads → **Stripe Customer redaction** → parent tombstone; **the redaction runs LATE by D5**, and the worker resolves `getStripe()` at its own boundary" | Redaction is **first**; the worker passes the `getStripe` **factory** (`PurgeWorker.ts:100`), resolved by the stage after its null check (`purge-stages.ts:775`). Both halves false. |
| `:1267` | stripe-customer-redaction.ts "Takes an injected client (**`retrieve` + `update` only**)" | The client also declares `paymentMethods.list` + `detach` (`:134-144`) and the function detaches every attached method (`:237`). |
| `:1725` | checks.ts "**env-tunable** `HEALTH_ALERT_*` thresholds … runs them SEQUENTIALLY: … failed inbound events, stalled send batches" | Enumeration omits `checkStaleIgnoredInboundEvents` (`checks.ts:512`); its two thresholds are deliberately not env-tunable (`checks.ts:82-88`). Stale rather than affirmatively false. |

### R03 — the new guard predicate erases a co-tenant who has not passed the point of no return, and still both-siblings-skips one status over

`purge-stages.ts:808-819`. The fix replaced `ao.status = 'purged'` with
`ao.mode = 'delete_data' AND ao.status IN ('purge_scheduled','purged')`. It keys
on `status`. The property it needs is *"this sibling can no longer come back"*,
and the branch's own D5 argument (`PurgeWorker.ts:96-99`) names the marker for
that: `purge_started_at`. The sets differ in **both** directions.

**W1 — a sibling in the ordinary purge grace window is excluded, and can still
cancel.** `keep-my-data.ts:192-199` admits a cancellation when
`mode='delete_data' AND status IN ('pending','tearing_down','purge_scheduled')
AND terminal_at IS NULL AND purge_started_at IS NULL AND purge_cancelled_at IS NULL`.
Intersected with the guard's exclusion set that leaves
`status='purge_scheduled', purge_started_at IS NULL` — **the entire purge grace
window**, the modal state of every `delete_data` offboarding between teardown and
`purge_after`.

So when account A purges while co-tenant B sits anywhere in its own grace window,
A's guard excludes B, counts zero live co-tenants, and **redacts the shared
Customer**. B can still click "Keep my data" — a supported action whose entire
purpose is *do not destroy my data* — and B's Stripe billing contact has already
been destroyed, irreversibly, by another tenant's purge, with nothing recorded
against B. The docblock's premise *"Both are being deleted, so redacting the
shared Customer harms neither"* is false for a `purge_scheduled` sibling: it is
**scheduled** for deletion, not committed to it.

**W2 — a terminally-failed sibling is NOT excluded, so both-siblings-skip
survives.** `markPurgeTerminalFailure` leaves `status='failed'` with
`purge_started_at` set (`PurgeWorker.ts:131`); `'failed'` is outside the
exclusion set, so a sibling unambiguously past the point of no return counts as a
**live co-tenant** and A skips — the exact class the fix set out to remove, one
status over, reachable whenever a sibling's purge exhausts its attempts.

**Both vanish with one predicate:** `AND ao.purge_started_at IS NOT NULL AND
ao.purge_cancelled_at IS NULL`. It still closes the concurrent-purge case,
because the poller stamps `purge_started_at` in the claim transaction before
either job runs.

**Why it shipped:** the predicate has **no behavioural test**. Stage tests mock
`sql` and push `{count:0}`/`{count:1}`; the offboarding live-DB suite never
exercises it; the only pin is the byte-for-byte string in
`tenant-scope-allowlist.ts:2841`, which asserts nothing about meaning.
(Inventory `U01`.)

---

## P1 — needs adjudication

### R04 — `detachPaymentMethods` declares `has_more` and never reads it; its sibling in the same directory paginates and throws

`stripe-customer-redaction.ts:274-296`. `StripePaymentMethodListResult` declares
`has_more: boolean` (`:105`); nothing reads it. One page of 100 is fetched and
`redactStripeCustomer` returns `'redacted'`. The justification is a one-line
assumption (`:253`), and Stripe caps attached PaymentMethods at no number.

1. **The sibling 100 lines away does it correctly.** `stripe-invoices.ts` —
   whose `isRetryableStripeError` this pass's own new docblock calls
   *"BYTE-IDENTICAL"* — declares the same shape (`:30`), paginates with
   `starting_after` (`:143-176`), and **throws a retryable
   `bounded_pagination_exhausted`** when the bound is exhausted.
2. **Silent, then unrecoverable.** `'redacted'` lets the purge finalize and
   `runParentTombstonePurgeStage` NULLs `accounts.stripe_customer_id` — verbatim
   the outcome `stripe-customer-redaction.ts:336-339` gives as the reason not to
   map permanent errors to success.
3. **A retry cannot recover it.** The marker is written on the same run, so
   `isAlreadyRedacted` (`:228`) short-circuits before `detachPaymentMethods`.

**Fix:** paginate as the sibling does, or minimally `throw` when
`page.has_more`. P1 only because the trigger needs >100 attached methods; the
failure class is P0-shaped.

### R05 — round 1's F04 is not closed: the acked-for-age warning still routes to nobody

`docs/runbooks/beta-launch-alerting.md` is **untouched by the entire branch**
(`git diff --name-only b9fb9601..HEAD -- docs/runbooks/` is empty).

`warnStripeSubscriptionEventAckedForAge` (`shared.ts:106-121`) emits at level
`warning` with `tags: { feature: 'stripe_subscription_out_of_order', event_type }`
and **no `subsystem` tag**:

| Facet | Emitted | Rule row |
|---|---|---|
| filter | `feature=stripe_subscription_out_of_order` | none — the five live filters are `subsystem=health_alert`, `cost_event=limit_exceeded`, `feature=stripe_reconciliation`, `subsystem=import_consent_analytics`, `feature=solicitation_lane` |
| level | `warning` | §1 records a `warning` `captureMessage` "does not reliably classify as high priority" (CONFIG-1) |
| destination | — | none |

An emitted operator signal with no rule row — Duty 5's exact definition — and it
is the signal D9 leans on (*"the operator's only handle on the acked event"*).
The pass answered F04 with a **different** signal (the health probe, which does
route via rule 1) covering the aggregate stream but not the per-event handle.

Second half: the new probe has **no §1 checklist bullet**, despite §1 carrying
the explicit precedent *"Rule 6 is a REPLACEMENT, not an addition (#967)"* —
written because an ack took events out of `checkFailedInboundEvents`' set.

**Fix:** a §1 bullet + frequency-conditioned rule row for
`feature:stripe_subscription_out_of_order` (constant title → a first-seen rule
fires once ever), and a §1 bullet recording the new probe as a replacement.

### R06 — the events arm was split in two and its saturation reporting was not

`ArchivalPoller.ts:109-112` claims *"each arm saturates and reports
independently."* False: the query returns **one** combined count (`:132`) and
`:472` compares it against a single `BATCH_LIMIT = 5000` whose true cap is now
10 000.

- **False positive:** `processed` 3 000 (exhausted) + `stale_ignored` 2 000
  (exhausted) = 5 000 → warns *"more rows may remain"* when nothing remains.
  Reachable across `[5000, 9999]`. `:212` already names the class by hand.
- **Lost attribution:** the `Archived` log's `events:` key (`:456`) is now the sum
  of two retention arms, so a growing acked-for-age backlog is invisible.

This diverges from the idiom the same file established for the same situation:
arms 9 and 10 are one table split for the same index reason and carry **two
counts and two saturation entries**, with `ArchivalPoller.test.ts:420-422`
stating why. **Fix:** report `events_processed` / `events_stale_ignored`
separately. (Inventory `U02`.)

### R07 — the observability fix for round 1's F05 has zero covering tests

`logStripeCustomerRedactionOutcome` (`purge-stages.ts:847-865`) is called at four
sites. `rg 'not_applicable|Stripe customer redaction|createWorkerLogger'` over
the stage's test file returns **no matches**, and no other suite imports the
stage. The `not_applicable` line matters most — it is the only trace a
no-Stripe-Customer purge leaves anywhere. (Inventory `U03`.)

### R08 — the factory / lazy-`getStripe` fix is unpinned; the mutation survived

Mutation M7 hoisted `const stripe = resolveStripe();` above the `if (!customerId)`
early return (`purge-stages.ts:769-775`), reverting to eager resolution. Baseline
green, mutant **PASSED**.

Arbiter reasoning: the test's named contract is *"no-op when there is no
`stripe_customer_id`"*, justified as *"issuing a Stripe call here would spend a
network round trip"* — both still hold under the mutant, which issues no Stripe
call and no SQL. The mutant breaks a **different** property, the one
`purge-stages.ts:764-768` states (*"`getStripe()` … throws when
`STRIPE_SECRET_KEY` is unset"*), asserted by no test. A survivor on a property
the test never asserts is `inconclusive`/`oracle`, not a confirmed P0.

**Fix:** one test passing a factory that throws.

### R09 — D6's reason for not delivering the receipt clause is false (task item 9)

D6: *"the template has no outcome data to condition on."* The counter-example is
in the same payload type: `worker-types.ts:386-391` carries
`retained_suppression_count` on the `purge_receipt` payload, *"snapshotted inside
the finalize transaction rather than queried at send time"*, with the matching
enqueue field at `outbox.ts:45-50`. The redaction outcome is written to
`account_offboardings.provider_dispositions` by an earlier transaction of the
same job (`purge-stages.ts:838`), and `finalizePurgeInTransaction` — which
enqueues the receipt — runs last. The outcome is committed and readable at
exactly the moment `retained_suppression_count` is snapshotted, by the same
mechanism, for the same reason.

**This is not a demand to ship the clause.** The finding is that the durable
record gives an infeasibility reason that is not true, so a future session reading
D6 concludes the option was closed when it is one snapshotted field away — the
"confident prose that is in fact the defect" pattern D7 itself names.

---

## P2 — recorded, does not block

### R10 — "restores the pager the ack removed" overstates what the probe restores

Before the ack, a **single** orphaned customer paged continuously for Stripe's
~3-day retry schedule (reclaim resets `received_at`; `failedThreshold` is `0`,
`checks.ts:302-303`). After the ack that row leaves the failed set, and the new
probe's threshold is `5`/hour per `(source, event_type)` — the single-orphan case
now pages **nothing**. Only a stream is restored. `checks.ts:52-58` is honest
about the threshold; D6 and `tenant-scope-allowlist.ts:258-261` are the records
that overstate.

### R11 — the probe's window column and threshold boundary are unasserted

Substituting `received_at` for `processed_at` passes both new tests — the choice
is correct (S3) but unpinned, and diverges from the sibling probe's `received_at`
(`checks.ts:300`) with no comment explaining why. `count > threshold` → `>=` also
passes both, silently moving the effective threshold from 6 to 5. Not executed as
mutations; neither changes behaviour at HEAD.

---

## Method

- **Environment:** allowlisted via `mutation-runner.mjs env --tmp-home` +
  `dotenv-swap` (scrubbed `.env.local`, localhost-validated
  `TEST_DATABASE_POOL_URL`).
- **Budget:** 14 of 30 runs (7 baseline/mutant pairs). Nothing was skipped for
  budget; every unexecuted in-scope hunk is recorded as an uncovered change with
  a reason.
- **Restoration:** `finalize` reports 7/7 mutations restored, dotenv restored,
  journal closed; `git status --porcelain` empty at `02bb7700` outside this run's
  artifacts.
- **Duty 3 tooling:** `prevalidate-plan.py` was **not** used — every claim in
  R01, R02 and R09 was hand-resolved against HEAD by reading the cited symbol or
  running `rg`. Stated here per the skill's requirement.
- **Not run:** the verify gate. Per the skill's ordering it re-runs as the last
  serialized step, after these artifacts are committed, and is the invoking
  agent's step.

## Authorizations

None recorded. All eleven findings are `open`. Three P0s block outright; on a
high-risk run each of the six open P1s requires user adjudication, and the
two-round cap is spent — there is no round 3 behind any of them.

---

# ADDENDUM — the fix pass, 2026-09-04

**Every one of the eleven findings is FIXED.** The owner adjudicated all six P1s
and both P2s as fix-rather-than-accept on 2026-09-04, so no finding is
`accepted-risk` and the `authorizations` array stays empty.

| id | sev | where it was closed |
|---|---|---|
| R01 | P0 | `ecf4c224` — `CONTEXT.md:170-171` re-resolved; ordering, lock and coupling claims corrected, detachment added to the definition |
| R02 | P0 | `ecf4c224` — all four `docs/directory.md` rows |
| R03 | P0 | the R03 commit — predicate keys on `purge_started_at` / `purge_cancelled_at`, **plus** the behavioural live-DB suite |
| R04 | P1 | `ecf4c224` — bounded pagination, retryable `bounded_pagination_exhausted` |
| R05 | P1 | `3170d108` — `beta-launch-alerting.md` rule 9 (numbered 7 at the time; #1105 took 7 and 8 first) + two §1 bullets |
| R06 | P1 | `ecf4c224` — two statements, two counts, two saturation entries |
| R07 | P1 | `3170d108` — four tests for the outcome log line |
| R08 | P1 | `3170d108` — a factory that throws, pinning the property M7 broke |
| R09 | P1 | `3170d108` — D6's false infeasibility reason corrected; the decision stands |
| R10 | P2 | `3170d108` — D6 and the allowlist note no longer overstate the probe |
| R11 | P2 | `3170d108` — window column and threshold boundary pinned |

## Why `head_sha` still says `02bb7700`, and why this sidecar still FAILS

`head_sha` is **deliberately not re-anchored** to the fix HEAD. `02bb7700` is
where the round-2 adversarial pass actually ran. Moving it would make
`red-team-status.mjs` pass by asserting an adversarial pass that never happened
— the "confident prose that is in fact the defect" pattern D7 names, encoded as
machine-readable evidence. Owner decision 2026-09-04.

So the checker reports three failures, and **all three are true**:

1. `INCOMPLETE_ORACLE` — six inventory rows (M7, U01–U04, T06) were recorded
   `inconclusive/oracle`. Every one names a coverage gap this pass has now
   closed, and each closure was verified by reinstating its defect and watching
   the new test fail. But **that verification is self-checking, not
   adversarial**, and the inventory records what the PASS observed, not what the
   fixer later claims. The rows stand as written.
2. `intake_sha256` mismatch — surface amendment 5 (owner-approved 2026-09-04)
   added the R03 behavioural test file and `beta-launch-alerting.md`. The
   evidence genuinely predates the amended intake.
3. Staleness — the tree moved, because the fixes landed.

**The fixes ship unattacked. That is the gap, and it is reported rather than
hidden.** The two-round cap is spent by design and the owner declined a third
round twice (2026-09-03 and again on resume 2026-09-04). Deviation D8 carries
the same statement in the branch's durable record, and the PR description
repeats it.

## What the fixes carry instead of an adversarial pass

Five of the eleven were mutation-verified during the fix pass — each defect
reinstated, the specific new test watched to fail, then restored with a clean
`git diff`:

| finding | mutation reinstated | result |
|---|---|---|
| R03 | the old `status IN ('purge_scheduled','purged')` predicate | 3 of 8 live-DB cases fail |
| R04 | the one-page sweep that ignored `has_more` | 4 tests fail |
| R06 | one summed saturation count instead of two | 2 tests fail |
| R08 | M7 — `resolveStripe()` hoisted above the null check | 1 test fails |
| R11 | `received_at` for `processed_at`; `>` for `>=` | 1 test each fails |

R01, R02, R09 and R10 are documentation corrections, hand-resolved against HEAD.
R05 is a runbook rule row with no code to mutate. R07's four log tests were not
mutation-tested — the one gap inside the gap, stated rather than glossed.
