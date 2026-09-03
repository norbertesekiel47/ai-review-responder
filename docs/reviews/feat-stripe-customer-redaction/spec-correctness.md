# Review — SPEC AND CORRECTNESS

- **SHA reviewed:** `00f6d56be77d77b4f1e45ff28a99b7c6bda778fe`
- **Fork point (merge-base):** `b9fb96016cc025c151f17db4b39baf165cb80a13`
- **How files were read:** every source file was read through `git show 00f6d56b:<path>` or
  `git diff b9fb9601..00f6d56b -- <path>`. No file was opened from the working tree, because a
  sibling red-team agent is mutating this worktree concurrently. Test files were additionally
  materialised into the session scratchpad from `git show` output before being scanned
  programmatically, so the 45-title check also ran against the committed bytes.
- Line numbers below are line numbers **at the reviewed SHA**.

## Summary of what was checked

- All 45 `tests_to_add` titles: **present verbatim**, each in a real `it(...)` body, no
  `.todo`/`.skip`/`.skipIf`/`.runIf` anywhere in the feature's test files.
- All 10 `non_goals`: **none violated.** No migration, no `customers.del`, no invoice mutation,
  no `tax_ids` write, no cancel_only path reaches the stage (`validatePurgeableOffboarding`
  rejects `mode !== 'delete_data'`), the event-age argument is required, no reconciliation
  outbox topic, `STALE_EVENT_THRESHOLD_SECONDS` untouched, no new privacy-policy section, no
  invoice count in the receipt.
- `allowed_edit_surface`: **exact match.** Every changed file is listed; every listed file is
  changed. Zero scope creep at the file level.
- The 900-second boundary: `outOfOrderRetryWindowOpen` (`worker/ingress/stripe/shared.ts:88-92`)
  is `ageSeconds <= 900 → open`, so 900 throws, 901 acks, a negative age throws, and `NaN`
  throws. Implemented at **both** handlers, both read `eventContext.created` (the *event's*
  clock), never `Stripe.Subscription.created`. Proven separately per handler under
  `vi.setSystemTime`. **Correct as specified.**
- D9 traced end to end. `processSubscriptionDeleted` returns `ACKED_FOR_AGE`;
  `processSubscriptionUpdated` returns `ignoredOutcome(..., 'stale_no_account')`; the dispatcher
  (`worker/ingress/stripe.ts:108-143`) is the **only** writer of `processed` for a Stripe event
  and it is in the `else` arm. Both handlers have exactly one production caller. **No path can
  write `processed` for an age-acked event.**
- The `already_redacted` predicate (`stripe-customer-redaction.ts:221-232`) requires the marker
  key to equal *this* `offboardingId` **and** all eight fields to be empty. Since the marker and
  the field clears ship in one `customers.update`, a partially-redacted Customer cannot satisfy
  it. **Not misreadable.**
- The eight cleared fields were checked against the installed SDK
  (`node_modules/stripe/esm/resources/Customers.d.ts`, stripe 22.2.0): `name`/`email`/`phone`/
  `description` are `string`, `address`/`shipping`/`business_name`/`individual_name` are
  `Emptyable<T>`, `metadata` values unset on `''`. All eight exist on `CustomerUpdateParams`.
  This matters because `buildRedactionParams` returns `Record<string, unknown>`, so the compiler
  proves nothing here — verified by hand instead. **Correct.**
- The shared-customer guard's `NOT EXISTS` arm (`purge-stages.ts:768-775`): `status = 'purged'`
  is a real `AccountOffboardingStatus` terminal value (`src/lib/account-offboarding/types.ts:11`),
  and a purged co-tenant's `accounts.stripe_customer_id` is already `NULL` by
  `purge-stages.ts:876`, so the arm is belt-and-braces rather than load-bearing. It cannot
  produce a **false negative** (redacting while a live co-tenant holds the id), which is the
  only direction that matters. **Correct.**
- The two PINs. `buildCheckoutSessionParams never sets a customer field` really was green before
  implementation and pins the D10 premise. `checkFailedInboundEvents does not count stale_ignored
  rows` pins `status = 'failed'` and the absence of `IN (` / `!=`, so a later widening fails.
  Both pin the premise they claim.
- `provider_dispositions` survives finalize — `scrubLifecycleReceiptInTransaction`
  (`purge-stages.ts:1063-1081`) does not touch that column — so `observability[2]` holds.

**No P0 or P1 findings.** Four P2 and five P3 follow.

---

## P2-1 — `observability[0]` is unmet: the redaction stage emits no log line for any outcome

- **Severity:** P2
- **File:** `worker/jobs/account-offboarding/purge-stages.ts:755-818`
- **Contract violated:** `observability[0]` — *"A structured worker log line per redaction
  outcome: redacted, already_redacted, skipped_shared_customer, not_applicable,
  customer_absent. The stripe customer id is scrubbed."*

**Evidence.** The whole stage contains no logger and no `console`:

```ts
export async function runStripeCustomerRedactionPurgeStage(
  sql: postgres.Sql,
  stripe: StripeCustomerRedactionClient,
  row: AccountOffboardingPurgeRow,
): Promise<void> {
  const customerId = row.stripe_customer_id?.trim();
  if (!customerId) return;

  await sql.begin(async (tx) => {
    await acquireStripeCustomerBindingLock(tx, customerId);
    const [sharing] = await tx<{ count: number }[]>`…`;
    if ((sharing?.count ?? 0) > 0) {
      await appendStripeCustomerRedactionRecord(tx, row, stripeCustomerRedactionRecord(customerId, 'skipped_shared_customer'));
      return;
    }
    const { outcome } = await redactStripeCustomer({ stripe, customerId, offboardingId: row.id });
    await appendStripeCustomerRedactionRecord(tx, row, stripeCustomerRedactionRecord(customerId, outcome));
  });
}
```

`grep -n "logger\|console\." purge-stages.ts` at this SHA returns **nothing** for the whole file,
and `PurgeWorker.ts` logs only two lines (`:99` stale-attempt, `:104` failure) — neither names a
stage or an outcome.

**Failure scenario.** Owner A and owner B share a Stripe Customer (the exact case D1 exists for).
A's `delete_data` purge runs, the guard counts 1, the stage skips, the purge finalizes, and the
receipt is sent. An operator asked "did we actually redact A's Customer?" has **no log line to
grep** — the only trace is a JSONB element inside `account_offboardings.provider_dispositions`
on a row they must know to query by offboarding id. The `not_applicable` case (`row.stripe_customer_id`
null) leaves no trace anywhere at all: no log, no `provider_dispositions` record. This is exactly
the visibility `observability[0]` was written to guarantee for a `risk: high`, irreversible,
compliance-facing action.

---

## P2-2 — The purge receipt drops the half of the promised sentence that says redaction happened

- **Severity:** P2
- **File:** `src/lib/notifications/email/templates/account-offboarding.ts:284-286` (rendered at `:182`)
- **Contract violated:** `user_visible_behavior[0]`

**Intake promises:**

> The purge receipt email gains one sentence: **RepWorth cleared the identifying details from its
> payment processor's customer record**, and paid invoices with their billing name and address are
> retained for tax and accounting purposes.

**Code ships:**

```ts
const PAYMENT_PROCESSOR_RETENTION_SENTENCE =
  'Our payment processor keeps paid invoices, including the billing name and address on them, and tax identifiers, for financial record-keeping.';
```

The affirmative clause — that RepWorth *cleared* the customer record — is absent. What ships is a
pure retention disclaimer. No entry in `feat-stripe-customer-redaction-deviations.md` (D1–D5)
records this change; D5 lists seven gate findings and none is the receipt copy.

**Failure scenario.** Owner completes a `delete_data` deletion. The receipt tells them their data
was deleted, then tells them the payment processor *keeps* invoices with their billing name and
address — and never tells them the customer record itself was scrubbed. The net reading is
strictly worse for the owner than today's receipt plus silence: it introduces retained PII without
the counterbalancing erasure claim the intake wrote to sit beside it.

**Note in the implementation's favour, which is why this is P2 and not P1:** the promised
affirmative clause would be **false** in the `skipped_shared_customer` and (arguably) the
`customer_absent` outcomes, because the receipt is unconditional and the stage has no channel to
tell the email worker which outcome occurred. So the right resolution may be a deviation record
plus a conditional sentence, not a literal restoration of the intake wording. Either way the
contract as written is unmet and undocumented.

---

## P2-3 — Test 45 asserts its own stub, not the production warning; the D9 warning payload is asserted nowhere

- **Severity:** P2
- **File:** `worker/ingress/__tests__/stripe.test.ts:603-637`
- **Contract violated:** `tests_to_add[44]` — *"the acked-for-age Sentry warning is raised from an
  event context carrying both id and created"* — and `observability[3]`.

**Evidence.** The test replaces the production handler with a mock **that itself calls
`captureMessage`**, then asserts the payload it just wrote:

```ts
mockProcessSubscriptionUpdated.mockImplementation(
  async (_sub: unknown, ctx: { id: string; created: number }) => {
    const Sentry = await import('@sentry/node');
    Sentry.captureMessage('stripe_subscription_event_acked_for_age', {
      level: 'warning',
      extra: { event_id: ctx.id, event_created: ctx.created, stripe_customer_id: 'cus_stale' },
    });
    return { kind: 'ignored', reason: 'stale_no_account' };
  },
);
…
expect(options).toMatchObject({ level: 'warning', extra: { event_id: 'evt_warning_context', … } });
```

`worker/ingress/stripe/shared.ts:100-124` — the real
`warnStripeSubscriptionEventAckedForAge` — is never executed by this test. The two tests that
*do* drive the real handlers assert only `expect(options).toMatchObject({ level: 'warning' })`
(`stripe-subscription-updated.test.ts:914-919`, `subscription-deleted-trial.test.ts:196-200`).
A repo-wide grep confirms `stripe.test.ts:613` is the **only** place `event_id` / `stripe_customer_id`
appear inside a `captureMessage` assertion, and it is the stub's own literal.

**Failure scenario / surviving mutant.** Delete `event_id`, `stripe_customer_id` and
`stripe_subscription_id` from the `extra` block of `warnStripeSubscriptionEventAckedForAge`
(shared.ts:112-118). Every test in this feature stays green. In production the operator then gets
`stripe_subscription_event_acked_for_age` with no event id — and D9's entire justification for
rejecting the deferred-reconciliation worker was *"the id is how they find the retained
`inbound_events` row and replay it. A bare 'an event was acked' line would not do that job."*
The one thing that makes the accepted residual acceptable is untested.

---

## P2-4 — `docs/directory.md` documents two symbols that do not exist at this SHA

- **Severity:** P2
- **File:** `docs/directory.md:1763` and `docs/directory.md:1795`
- **Rule violated:** project working rule — *"Green CI is not proof that documentation is true.
  Re-check cited line numbers and doc claims against current HEAD."* `docs/directory.md` is
  CI-complete for `worker/` and is the map a future agent reads first.

**Evidence.** Line 1763 (`stripe.ts` row):

> …and from `callVoidHandlerReportingAckForAge` for the `Promise<void>` delete handler).

Line 1795 (`stripe/shared.ts` row):

> …and the ack report channel (`callVoidHandlerReportingAckForAge`/`recordStripeEventAckedForAge`)
> the `Promise<void>` delete handler uses.

`git grep -n "callVoidHandlerReportingAckForAge\|recordStripeEventAckedForAge" 00f6d56b -- '*.ts'`
returns **zero** hits. Deviation D4 records that this mechanism was deleted:
*"`processSubscriptionDeleted` now returns `StripeSubscriptionAck` instead of `void`, and the
`AsyncLocalStorage` ack channel is deleted."* The doc rows were written against the intermediate
design and never re-derived. The delete handler's signature at
`worker/ingress/stripe/subscription-deleted.ts:18-21` is
`Promise<StripeSubscriptionAck>`, not `Promise<void>`.

**Failure scenario.** The next agent touching Stripe ingress reads the directory map, greps for
`callVoidHandlerReportingAckForAge` to understand how the ack is reported, finds nothing, and
either re-invents the AsyncLocalStorage channel D4 deliberately removed or spends the afternoon
proving the map wrong. Fix is two edits in the same file the branch already touches.

---

## P3-1 — `tests_to_add[39]` is a byte-equivalent duplicate of `tests_to_add[9]` and exercises no lock ordering

- **Severity:** P3
- **File:** `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts:138-152`
- **Contract:** `tests_to_add[39]` — *"the redaction guard still skips when the writer wins the
  binding lock first"*

The body is identical to the `skipped_shared_customer` test at `:100-115`: queue a lock result,
queue `{count: 1}`, queue an append result, assert no Stripe call and a `skipped_shared_customer`
record. Nothing in it establishes that a writer held the lock first — there is one mock SQL client
and one caller. The test's own comment concedes the point ("the lock only makes the two orders
deterministic, it does not decide the outcome"), but then the title claims a lock-winner order it
never constructs. The *other* order genuinely is proven, against real Postgres, by
`billing-locks.integration.test.ts:695-741`. Confidence that the title over-claims: high;
confidence this is harmless in production: also high — hence P3.

---

## P3-2 — the `not_applicable` outcome named in `edge_cases[4]` is not implemented

- **Severity:** P3
- **File:** `worker/jobs/account-offboarding/purge-stages.ts:760-761`
- **Contract:** `edge_cases[4]` — *"`row.stripe_customer_id` is null: not applicable, no Stripe
  call, **stage returns `not_applicable`**."* Also `observability[0]`, which lists
  `not_applicable` among the logged outcomes.

The stage returns `Promise<void>` and the null case is a bare `return;`. The record union
(`StripeCustomerRedactionRecord['outcome']`) is
`redacted | already_redacted | customer_absent | skipped_shared_customer` — `not_applicable`
appears nowhere in the branch. Behaviourally a silent no-op is what you want, so this is a naming
and observability gap rather than a bug; it compounds P2-1, because the one outcome with no
`provider_dispositions` record is also the one with no log line.

---

## P3-3 — `PROVIDER_DATA_RETENTION` has no production consumer, contrary to its own docblock and the CONTEXT lock

- **Severity:** P3
- **File:** `src/lib/account-offboarding/table-disposition.ts:450`
- **Claim contradicted:** the export's own docblock (*"The deletion receipt and the privacy policy
  are written from these reasons"*), the plan's T3, and `CONTEXT.md:171` (*"because the purge
  receipt and the privacy policy's Retention paragraph are both written from it"*).

`git grep -n PROVIDER_DATA_RETENTION` at this SHA returns only `table-disposition.ts:450`
(the definition), the test file, and one prose comment in `stripe-customer-redaction.ts:27`. The
receipt sentence is a hand-written literal at
`account-offboarding.ts:285`; the policy paragraph is a hand-written literal at
`legal/content.ts:244`. Neither reads the inventory. Three copies of the same disclosure now
drift independently, and the CONTEXT lock asserts a coupling that does not exist. `non_goals`
does not exempt this, and it is the second half of what makes D2's separate-inventory decision
worth its cost.

---

## P3-4 — the "passes the event context" test's deleted-handler stub returns a shape production never returns

- **Severity:** P3
- **File:** `worker/ingress/__tests__/stripe.test.ts:551` (`mockProcessSubscriptionDeleted.mockResolvedValue(undefined)`)

The dispatcher does `const ack = await processSubscriptionDeleted(...); ackedForAge = ack.ackedForAge;`
(`worker/ingress/stripe.ts:109-113`). With the stub returning `undefined`, that line throws a
`TypeError`, the dispatcher takes its catch arm, writes `inbound_events` `failed` and replies 500.
The test passes anyway because it only asserts `toHaveBeenCalledWith`. So the second half of test
`tests_to_add[29]` silently exercises the error path while claiming to exercise the happy one, and
a real regression in the deleted-branch ack handling would be indistinguishable.

---

## P3-5 — `RECLAIMABLE_INBOUND_EVENT_STATUSES` cites the `OUTBOX_IN_FLIGHT_STATUSES` idiom but ships without its CI guard

- **Severity:** P3
- **File:** `worker/ingress/shared.ts:18-33`

The docblock says *"The predicate below spells the members literally — this constant is what the
tests assert against, mirroring the `OUTBOX_IN_FLIGHT_STATUSES` idiom."* The idiom it names is
enforced by `pnpm ci:outbox-status`, which checks members **and order** byte-for-byte
(`.claude/CLAUDE.md` invariant #2). No equivalent audit was added here, and the value is now
spelled literally in three separate places: the reclaim predicate (`shared.ts:67`),
`markInboundEventStaleIgnored` (`:99`), and `ArchivalPoller.ts:97`. The one test that ties them
together (`worker/ingress/__tests__/shared.test.ts:64-83`) asserts the reclaim SQL *contains*
`'stale_ignored'` and `'failed'`, which will not catch a member added to the constant and not to
the SQL. Low severity because the set has two members and one writer today.

---

## Non-actionable appendix (observations below the reporting bar)

- **Replay window asymmetry.** D9 promises *"an operator resending the event from Stripe still
  reprocesses it,"* and the `stale_ignored` row is swept at 30 days. But
  `STALE_EVENT_THRESHOLD_SECONDS` (`worker/ingress/stripe.ts:27`) rejects any event older than
  **7 days** with a 200 before `claimInboundEvent` runs, so between day 7 and day 30 the retained
  reclaimable row cannot actually be reprocessed. Changing that guard is `non_goals[7]`, and the
  same asymmetry already applied to `failed` rows before this branch, so this is pre-existing and
  out of scope — but the D9 sentence is broader than the mechanism.
- **Transaction held open across a Stripe HTTP call.** `runStripeCustomerRedactionPurgeStage` keeps
  a pooled Postgres transaction (and its advisory lock) open for the duration of
  `stripe.customers.retrieve` + `customers.update`. This is D8, explicitly locked ("hold it for the
  whole transaction including the Stripe call"), so it is not re-litigated. I could not establish
  with confidence whether Supabase's `idle_in_transaction_session_timeout` would abort that
  transaction mid-call under PgBouncer transaction pooling; if it can, the failure is a rolled-back
  record with a completed Stripe write, recoverable on retry via `already_redacted`. Worth one
  measurement during the staging smoke, not a finding.
- **Receipt sentence renders for accounts that never had a Stripe Customer.** The disclosure is
  unconditional by design (documented in the template docblock), so a comped/beta account whose
  `stripe_customer_id` is null still receives "Our payment processor keeps paid invoices…". A
  deliberate simplification, and the sentence is generic enough not to be false.
- **`already_redacted` ignores leftover metadata keys.** The predicate checks the marker key and the
  eight fields but not whether *other* metadata keys remain. Since marker and clears ship in one
  update, the only way to reach that state is a third party writing metadata back onto a redacted
  Customer between attempts. Contrived; noted only so a future reader does not rediscover it as a
  defect.
- **Plan citation drift, not a code defect.** Plan T3 says the disclosure "sharpens the existing
  deletion paragraph at `src/lib/legal/content.ts` line 150." At the fork point line 150 is in the
  **Terms** doc (`Termination`), not the privacy policy. The implementation put it in the privacy
  policy's `Retention` section, which is what `user_visible_behavior[1]` actually asks for, and
  `non_goals[8]` (no new retention section) is respected. The code is right; the plan's line
  citation was wrong.
- **Meta-check file list is narrower than the edit surface.** `FEATURE_TEST_FILES`
  (`stripe-customer-redaction.test.ts:264-281`) lists 16 files; the branch edits 27 test files. The
  omitted 11 (the seven ingress suites from surface amendment 4, the harness, the out-of-order
  suite, the static-policy suite, the autopilot integration suite) carry no promised test, so the
  list matches its stated scope — but `invariants[16]` says *"No test in this feature is written as
  todo or skipped,"* which is broader than what is enforced.
- **Tautological assertion.** `stripe-customer-redaction.test.ts:247-249` asserts
  `stripeCustomerRedactionIdempotencyKey(X) === stripeCustomerRedactionIdempotencyKey(X)`, which is
  true for any pure function. The line above it (comparing against the update call's actual
  `idempotencyKey`) is the one carrying the test.
