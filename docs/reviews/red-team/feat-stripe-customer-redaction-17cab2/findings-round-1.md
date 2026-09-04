# Red team — feat/stripe-customer-redaction

**Status: `OPEN_P0`** · mode `feature` · risk `high` · round 1 · generated 2026-09-03T21:18:22Z

| | |
|---|---|
| fork / merge-base | `b9fb96016cc025c151f17db4b39baf165cb80a13` |
| head | `00f6d56be77d77b4f1e45ff28a99b7c6bda778fe` |
| intake sha256 | `8a550fc4c129c53aa892db096937bc9b65d828ca03d0b8abc5b50828f488ad4f` |
| run id | `feature-feat-stripe-customer-redaction-17cab2` |

Environment: allowlisted (`PATH`, temp `HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, plus a validated localhost `TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL`). `.env.local` was swapped for a scrubbed replacement for the whole mutation phase and restored by the finalizer. 18 runs of a 30-run round budget were spent; every journaled process group was reaped and `git status --porcelain` is empty on every tracked path.

Green baseline produced in this pass: one run over all 14 candidate test files at HEAD — **14 files, 251 tests, 0 failures**.

---

## Severity table

| id | sev | duty | finding | at |
|---|---|---|---|---|
| `F01` | **P0** | 3 | docs/directory.md documents an ack mechanism that does not exist at HEAD — three false symbol claims | `docs/directory.md:1763, docs/directory.md:1795, docs/directory.md:1796` |
| `F02` | **P0** | 1 | The `customer.subscription.deleted` arm of D9 is defended by zero tests — forcing it to write `processed` passes the whole ingress suite | `worker/ingress/stripe.ts:113` |
| `F03` | **P1** | 2 | Promised test 30's delete half asserts through the dispatcher's CATCH arm, so it proves nothing about that arm's success path | `worker/ingress/__tests__/stripe.test.ts:~197 (beforeEach `mockProcessSubscriptionDeleted.mockResolvedValue(undefined)`)` |
| `F04` | **P1** | 5 | The new acked-for-age Sentry signal has no rule row, while the change removes the error-level alert it replaces | `worker/ingress/stripe/shared.ts:100 (`captureMessage('stripe_subscription_event_acked_for_age')`) vs docs/runbooks/beta-launch-alerting.md` |
| `F05` | **P1** | 5 | The intake's first observability promise — a structured log line per redaction outcome — was not delivered | `worker/jobs/account-offboarding/purge-stages.ts:760-818 (runStripeCustomerRedactionPurgeStage)` |
| `F06` | **P1** | 1 | Uncovered change: the UPDATE-side `resource_missing` short circuit has no covering test | `src/lib/account-offboarding/stripe-customer-redaction.ts:192` |
| `F07` | **P1** | 1 | Uncovered change: the non-finite `created` guard in outOfOrderRetryWindowOpen has no covering test | `worker/ingress/stripe/shared.ts:82` |
| `F08` | **P1** | 1 | The already_redacted short circuit does not discriminate `.every` from `.some` — a marker-present, field-dirty customer is untested | `src/lib/account-offboarding/stripe-customer-redaction.ts:227` |
| `F09` | **P1** | 2 | Fragile assertion: promised test 43 asserts SQL query text and structural absences instead of the behaviour its title names | `worker/background/pollers/health-alert/__tests__/checks.test.ts:222-236` |
| `F10` | **P1** | 2 | Promised test 40 is a behavioural duplicate of test 10 and exercises no lock ordering, despite a title that claims a race | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts:138-152` |
| `F11` | **P2** | 2 | Promised test 8 carries a tautological second assertion | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts:247-249` |
| `F12` | **P2** | 1 | The deliberately duplicated 900-second boundary tests cannot detect the drift their comment cites | `worker/ingress/stripe/shared.ts:80-85` |
| `F13` | **P2** | 4 | RECLAIMABLE_INBOUND_EVENT_STATUSES has no CI audit, unlike the OUTBOX_IN_FLIGHT_STATUSES idiom it says it mirrors | `worker/ingress/shared.ts:37` |
| `F14` | **P2** | 1 | One pre-existing test fails under the isolated environment at HEAD — recorded so it is not mistaken for mutant damage | `worker/ingress/__tests__/ (ingress rate-limit hook — absolute-form request targets)` |

Counts — inventory_total: 47, killed: 12, survived_confirmed_p0: 1, equivalent: 0, inconclusive: 3, skipped_budget: 31, excluded: 0, findings_total: 14, p0_open: 2, p1_open: 8, p2_open: 4, accepted_risk: 0, fixed: 0, rejected: 0

---

## What survived my attack

Three of the branch's claims held up under direct attempts to falsify them, and the attempts are worth recording as much as the failures.

**Claim 3 — the redaction stage runs late and cannot leave a live account with a wiped Stripe contact — HELD.** I moved `runStripeCustomerRedactionPurgeStage` to *after* `runParentTombstonePurgeStage` (M10, the dangerous direction, not merely "not between") and promised test 13 failed at once. Its assertion is the full three-call subsequence `['audit','redaction','tombstone']`, so it catches both directions. I separately attacked the shared-customer guard by weakening the sharing predicate from `> 0` to `> 1` (M8) and promised test 10 failed. I also checked the append's durability by hand: `finalizePurgeInTransaction`'s row scrub (`purge-stages.ts:1068`) nulls the identifier columns and does **not** touch `provider_dispositions`, and migration 056 declares the column `NOT NULL DEFAULT '[]'::jsonb` with a `jsonb_typeof = 'array'` CHECK, so the `||` append can neither null-propagate nor type-error. The audit-trail claim is sound.

**Claim 5 — the 900-second boundary is implemented identically at both handlers — HELD, and more strongly than claimed.** I verified the implementations rather than the tests: there is exactly ONE comparison in the repository, the pure `outOfOrderRetryWindowOpen` in `worker/ingress/stripe/shared.ts`, and both handlers call it. A single one-character mutation (`<=` → `<`) killed promised test 25 *and* promised test 26. The handlers cannot drift because there is nothing to drift. See `F12` for the consequence: the comment justifying the duplicated tests describes a hazard the chosen structure forecloses.

**Claim 6, partially — most doc claims re-resolved TRUE.** I re-checked every checkable assertion in the new `CONTEXT.md` entries and the `arch-review-log.md` row against HEAD: `idx_ie_status` really is partial on `status != 'processed'` (`001_initial_schema.sql:291`); `ALLOWLIST_BASELINE` really moved 373 → 375; `PROVIDER_DATA_RETENTION` really carries no `purgeVerification` field and really never enters `ACCOUNT_OFFBOARDING_TABLES`/`PURGE_VERIFICATION_TABLES`; `buildCheckoutSessionParams` really exists (`create-checkout-session.ts:146`) and really never sets `customer`. The three false claims I did find are all in `docs/directory.md` and all describe the same deleted mechanism — see `F01`.

**Claim 7 — a missed sibling — searched, none found.** Recorded in full under `F13`, including the exact patterns, scope and the two near-misses I cleared (`worker/ingress/resend.ts:150` and the Telegram/Twilio/Zernio reclaim inheritors). What the search did surface is an enforcement gap rather than a missed case.

I also checked whether promised test 37's `.todo|.skip|.skipIf|.runIf` regex leaves `it.only`/`describe.only` as an escape hatch. It does — but Vitest's `allowOnly` defaults to `!process.env.CI`, the repo overrides it nowhere, and CI sets `CI=true`, so a `.only` fails CI already. Not a finding.

---

## What did not survive

### `F01` (P0) — `docs/directory.md` documents an API that does not exist

Three rows describe `callVoidHandlerReportingAckForAge` and `recordStripeEventAckedForAge` and call `processSubscriptionDeleted` a `Promise<void>` handler that "returns undefined either way". `git grep` for either symbol at `00f6d56b` returns **only those two doc lines** — no source, no test. The handler is declared `Promise<StripeSubscriptionAck>` (`subscription-deleted.ts:18-21`). Deviation D4 records this exact change ("`processSubscriptionDeleted` now returns `StripeSubscriptionAck` instead of `void`, and the `AsyncLocalStorage` ack channel is deleted"); the directory rows were written against the pre-D4 design and never re-resolved. `ci:directory-map` enforces row *existence*, not row *content*, which is why a green gate says nothing here.

### `F02` (P0) — the delete arm of D9 is pinned by nothing

This is the answer to the brief's second challenge, "find a path that still writes `processed`".

```
worker/ingress/stripe.ts:113    ackedForAge = ack.ackedForAge;      ->  ackedForAge = false;
  target test (promised 30)  ............................  PASSED   (survived)
  npx vitest run worker/ingress/ under the mutant ........  472 passed, 1 failed
  npx vitest run worker/ingress/ at unmutated HEAD .......  472 passed, 1 failed  (identical)

worker/ingress/stripe.ts:122    ackedForAge = outcome.kind === 'ignored'
                                  && outcome.reason === 'stale_no_account';  ->  false
  target test (promised 29)  ............................  FAILED   (killed)
```
The `customer.subscription.updated` arm is properly defended. The `customer.subscription.deleted` arm is defended by zero tests: under the mutation a stale delete event closes its row as `processed`, `claimInboundEvent` then answers `duplicate` to an operator's dashboard resend, and the event is silently swallowed — the precise outcome the branch names as D9's reason for existing. The code at HEAD is correct; the claim is simply unproven for half its surface.

`F03` explains the mechanism: the one test that touches that arm drives it into the dispatcher's catch arm, proven by captured stderr at HEAD — `Failed to process event evt_ctx_deleted (customer.subscription.deleted): Cannot read properties of undefined (reading 'ackedForAge')`. The mock resolves `undefined`; the test passes anyway because its only assertion fires before the throw.

### Operational completeness (`F04`, `F05`)

The feature retires an error-level, thresholded, documented alert (`inbound_events_failed:stripe:customer.subscription.*` — the intake's own stated success signal) and replaces it with a `warning`-level `captureMessage` that has **no row in `docs/runbooks/beta-launch-alerting.md`** and no changed runbook file on the branch. The same runbook states three times that a `warning` `captureMessage` "does not reliably classify as high priority" and that no Discord route is configured. Separately, the intake's first observability promise — a structured log line per redaction outcome — was not delivered: the stage emits no log line and `purge-stages.ts` imports no logger. The answer to the brief's eighth challenge is therefore: an operator can recover from the *webhook* failure mode (the row stays reclaimable, and `F02` aside the mechanism works), but has no live signal for the *redaction* failure modes beyond the pre-existing generic `account_offboarding_purge_failed`.

---

## Full inventory

47 rows: the 45 promised titles, plus two production hunks that reverse-import search found no covering candidate for.

| id | outcome | class | test | file |
|---|---|---|---|---|
| `T01` | skipped-budget | — | redactStripeCustomer clears name, email, phone, description, address, shipping, business_name an… | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T02` | skipped-budget | — | redactStripeCustomer unsets every pre-existing metadata key and writes only the offboarding id k… | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T03` | skipped-budget | — | redactStripeCustomer never calls customers.del | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T04` | inconclusive | oracle | redactStripeCustomer returns already_redacted and issues no update when the customer is already … | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T05` | skipped-budget | — | redactStripeCustomer treats a resource_missing error as success | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T06` | skipped-budget | — | redactStripeCustomer treats a deleted customer returned by retrieve as success | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T07` | skipped-budget | — | redactStripeCustomer rethrows a retryable Stripe error type | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T08` | skipped-budget | — | redactStripeCustomer sends a deterministic idempotency key derived from the offboarding id | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T09` | skipped-budget | — | runStripeCustomerRedactionPurgeStage is a no-op when the offboarding row carries no stripe_custo… | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts` |
| `T10` | killed | — | runStripeCustomerRedactionPurgeStage skips the Stripe call and records skipped_shared_customer w… | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts` |
| `T11` | skipped-budget | — | runStripeCustomerRedactionPurgeStage appends a system provider-redaction record that extractConc… | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts` |
| `T12` | killed | — | runStripeCustomerRedactionPurgeStage never writes the raw stripe customer id into provider_dispo… | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts` |
| `T13` | killed | — | handleAccountOffboardingPurge runs the redaction stage between runAuditAndCostPayloadPurgeStage … | `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` |
| `T14` | skipped-budget | — | handleAccountOffboardingPurge does not finalize the purge when the redaction stage throws a retr… | `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` |
| `T15` | skipped-budget | — | PROVIDER_DATA_RETENTION classifies the Stripe Customer object as retain_compliance_limited_pii | `src/lib/account-offboarding/__tests__/table-disposition.test.ts` |
| `T16` | skipped-budget | — | PROVIDER_DATA_RETENTION entries never appear in ACCOUNT_OFFBOARDING_TABLES or PURGE_VERIFICATION… | `src/lib/account-offboarding/__tests__/table-disposition.test.ts` |
| `T17` | skipped-budget | — | verificationQuery still throws missing_purge_verification_sql for an unknown table name | `src/lib/account-offboarding/__tests__/table-disposition.test.ts` |
| `T18` | skipped-budget | — | buildAccountOffboardingEmailHtml renders the payment-processor retention sentence in the purge r… | `src/lib/notifications/__tests__/email-templates.test.ts` |
| `T19` | skipped-budget | — | buildAccountOffboardingEmailHtml renders no payment-processor sentence for any non purge_receipt… | `src/lib/notifications/__tests__/email-templates.test.ts` |
| `T20` | skipped-budget | — | the privacy policy deletion paragraph names retained paid invoices and their billing name and ad… | `src/lib/legal/__tests__/content.test.ts` |
| `T21` | skipped-budget | — | processSubscriptionUpdated throws AccountNotProvisionedYetError when the event is 60 seconds old… | `worker/ingress/__tests__/stripe-subscription-updated.test.ts` |
| `T22` | skipped-budget | — | processSubscriptionUpdated logs and returns without throwing when the event is older than 15 min… | `worker/ingress/__tests__/stripe-subscription-updated.test.ts` |
| `T23` | skipped-budget | — | processSubscriptionDeleted throws AccountNotProvisionedYetError when the event is 60 seconds old… | `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts` |
| `T24` | skipped-budget | — | processSubscriptionDeleted logs and returns without throwing when the event is older than 15 min… | `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts` |
| `T25` | killed | — | processSubscriptionUpdated throws at an event age of exactly 900 seconds and acks at 901 under a… | `worker/ingress/__tests__/stripe-subscription-updated.test.ts` |
| `T26` | killed | — | processSubscriptionDeleted throws at an event age of exactly 900 seconds and acks at 901 under a… | `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts` |
| `T27` | skipped-budget | — | processSubscriptionUpdated throws rather than acking for a future event timestamp | `worker/ingress/__tests__/stripe-subscription-updated.test.ts` |
| `T28` | skipped-budget | — | processSubscriptionDeleted throws rather than acking for a future event timestamp | `worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts` |
| `T29` | killed | — | the stripe webhook replies 200 when a stale no-account subscription event is acked | `worker/ingress/__tests__/stripe.test.ts` |
| `T30` | survived-confirmed-P0 | — | handleStripeWebhook passes the event context to both subscription handlers | `worker/ingress/__tests__/stripe.test.ts` |
| `T31` | skipped-budget | — | redactStripeCustomer leaves exactly the offboarding metadata key when the fake applies Stripe me… | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T32` | skipped-budget | — | redactStripeCustomer rethrows a permanent Stripe error that is not resource_missing | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T33` | killed | — | acquireStripeCustomerBindingLock hashes the customer id with its own dedicated suffix | `src/lib/accounts/__tests__/billing-locks.test.ts` |
| `T34` | skipped-budget | — | applyStripeSubscriptionStateUnderEntitlementLock takes the customer binding lock before writing … | `worker/ingress/stripe/__tests__/apply-subscription-state.test.ts` |
| `T35` | skipped-budget | — | runStripeCustomerRedactionPurgeStage takes the customer binding lock before counting sharing acc… | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts` |
| `T36` | skipped-budget | — | a concurrent stripe_customer_id binding cannot interleave with the redaction guard | `src/lib/accounts/__tests__/billing-locks.integration.test.ts` |
| `T37` | skipped-budget | — | the feature test suite contains no todo or skipped tests | `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts` |
| `T38` | killed | — | buildCheckoutSessionParams never sets a customer field, so Stripe always mints a new Customer | `src/lib/payments/__tests__/create-checkout-session.test.ts` |
| `T39` | skipped-budget | — | applyStripeSubscriptionState takes the customer binding lock on its own exported entry point | `worker/ingress/stripe/__tests__/apply-subscription-state.test.ts` |
| `T40` | skipped-budget | — | the redaction guard still skips when the writer wins the binding lock first | `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts` |
| `T41` | killed | — | a stale no-account subscription event is recorded with the stale_ignored status, not processed | `worker/ingress/__tests__/shared.test.ts` |
| `T42` | killed | — | claimInboundEvent reclaims a stale_ignored row so a resent Stripe event reprocesses | `worker/ingress/__tests__/shared.test.ts` |
| `T43` | killed | — | checkFailedInboundEvents does not count stale_ignored rows | `worker/background/pollers/health-alert/__tests__/checks.test.ts` |
| `T44` | killed | — | ArchivalPoller sweeps stale_ignored rows on the same 30-day clock as processed rows | `worker/background/pollers/__tests__/ArchivalPoller.test.ts` |
| `T45` | skipped-budget | — | the acked-for-age Sentry warning is raised from an event context carrying both id and created | `worker/ingress/__tests__/stripe.test.ts` |
| `B01` | inconclusive | oracle | runStripeCustomerRedactionPurgeStage / PurgeWorker — production hunk: the UPDATE-side `resource_… | `src/lib/account-offboarding/stripe-customer-redaction.ts` |
| `B02` | inconclusive | oracle | outOfOrderRetryWindowOpen — production hunk: the non-finite `created` guard | `worker/ingress/stripe/shared.ts` |

### Row reasons

- **All `skipped-budget` rows** — In scope and not executed: the 30-run round budget was spent on the 14 candidates covering the branch's three headline claims. Baseline green at HEAD (part of the 251-test, 14-file baseline run).

- **`T04`** (inconclusive) — M2: src/lib/account-offboarding/stripe-customer-redaction.ts:227 `REDACTED_CUSTOMER_FIELDS.every(...)` -> `.some(...)`. The test still PASSED. Arbiter: the mutated line IS executed by this test, and `.some` is not equivalent to `.every` — with the offboarding marker present and one field still populated, `.some` returns already_redacted and issues NO update, leaving that identifier live at Stripe. But this test supplies all-eight-cleared, for which the two agree, so the mutation is not meaningful FOR THE TESTED BEHAVIOUR. The oracle cannot discriminate; that is a claim about the oracle, not proof the mutant preserves behaviour, so this is inconclusive rather than a confirmed survivor. See F08.

- **`T10`** (killed) — M8: worker/jobs/account-offboarding/purge-stages.ts:782 `(sharing?.count ?? 0) > 0` -> `> 1`. Test failed.

- **`T12`** (killed) — M9: worker/jobs/account-offboarding/purge-stages.ts:722 replaced the sha256 digest with the raw customerId. Test failed.

- **`T13`** (killed) — M10: worker/jobs/account-offboarding/PurgeWorker.ts moved runStripeCustomerRedactionPurgeStage AFTER runParentTombstonePurgeStage. Test failed — the subsequence assertion catches the dangerous direction, not merely 'before the tombstone'.

- **`T25`** (killed) — M1: worker/ingress/stripe/shared.ts:84 `ageSeconds <= OUT_OF_ORDER_RETRY_WINDOW_SECONDS` -> `<`. Test failed (1 failed / 0 passed).

- **`T26`** (killed) — M1b: the same one-character mutation at worker/ingress/stripe/shared.ts:84. Test failed (1 failed / 0 passed) — both handlers share one predicate.

- **`T29`** (killed) — M13: worker/ingress/stripe.ts:122 `ackedForAge = outcome.kind === 'ignored' && outcome.reason === 'stale_no_account'` -> `false`. Test failed — the `customer.subscription.updated` arm IS pinned.

- **`T30`** (survived-confirmed-P0 → `F02`) — M12: worker/ingress/stripe.ts:113 `ackedForAge = ack.ackedForAge` -> `ackedForAge = false`. The test PASSED. Arbiter: the line is on an executed branch (this test drives `case 'customer.subscription.deleted'`), and the mutation is decisively meaningful — under it a `customer.subscription.deleted` event the handler acked for age closes its `inbound_events` row as `processed`, the one status D9 says must never appear, so an operator's dashboard resend returns `duplicate` and is silently swallowed. Not equivalent, not unexecuted. A full `npx vitest run worker/ingress/` under the mutant returned exactly the same result as HEAD (472 passed, 1 pre-existing unrelated failure), so ZERO tests in the repo kill it.

- **`T33`** (killed) — M11: src/lib/accounts/billing-locks.ts:7 `':stripe_customer_binding'` -> `':tier_entitlement'` (a deliberate key collision). Test failed.

- **`T38`** (killed) — M7: src/lib/payments/create-checkout-session.ts:207 added `customer: 'cus_reused_mutant'` to the returned Session params. Test failed — the D10 pin is real, not a tautology.

- **`T41`** (killed) — M3: worker/ingress/shared.ts:99 `status = 'stale_ignored'` -> `'processed'`. Test failed.

- **`T42`** (killed) — M4: worker/ingress/shared.ts:67 removed `OR status = 'stale_ignored'` from the reclaim predicate. Test failed.

- **`T43`** (killed) — M6: worker/background/pollers/health-alert/checks.ts:277 `WHERE status = 'failed'` -> `WHERE status IN ('failed','stale_ignored')`. Test failed. (The sed also rewrote a second identical line at :89, which this test does not read.)

- **`T44`** (killed) — M5: worker/background/pollers/ArchivalPoller.ts:97 `status IN ('processed','stale_ignored')` -> `status = 'processed'`. Test failed.

- **`B01`** (inconclusive) — Direction B reverse-import search: `redactStripeCustomer`'s update-side `if (isResourceMissing(err)) return { outcome: 'customer_absent' }` (stripe-customer-redaction.ts:192) has NO covering candidate. Every `resource_missing` test (T05) rejects on `customers.retrieve`; the only `customers.update` rejections in the suite are `StripeConnectionError` (T07) and `parameter_unknown` (T32). Uncovered change. See F06.

- **`B02`** (inconclusive) — Direction B reverse-import search: `if (!Number.isFinite(eventCreatedSeconds)) return true` (shared.ts:82) has NO covering candidate. T27/T28 supply a NEGATIVE age (-3600), which the `<=` comparison handles without the guard; no test in either boundary suite supplies NaN, undefined, or a missing `created`. The module's own docstring calls the guard load-bearing ("`NaN <= 900` is false, which would otherwise ack everything"). Uncovered change. See F07.

---

## Findings in full

### `F01` — P0 — docs/directory.md documents an ack mechanism that does not exist at HEAD — three false symbol claims

**At:** `docs/directory.md:1763, docs/directory.md:1795, docs/directory.md:1796` · **Duty 3** · **Disposition:** `open`

Re-resolved every symbol in the branch's changed directory.md rows against HEAD with `git grep <sym> 00f6d56b`. Three claims are FALSE, all describing the AsyncLocalStorage ack channel that D4 records as DELETED: (1) :1763 says the dispatcher reads the ack "from `callVoidHandlerReportingAckForAge` for the `Promise<void>` delete handler"; (2) :1795 lists "the ack report channel (`callVoidHandlerReportingAckForAge`/`recordStripeEventAckedForAge`) the `Promise<void>` delete handler uses" among worker/ingress/stripe/shared.ts's exports; (3) :1796 says subscription-deleted.ts "acks for age via `recordStripeEventAckedForAge()` (returns undefined either way)". Neither symbol exists anywhere in the repo at 00f6d56b except in those two doc lines. `processSubscriptionDeleted` is declared `Promise<StripeSubscriptionAck>` (subscription-deleted.ts:18-21) and returns `ACKED_FOR_AGE`/`HANDLED_NORMALLY`, never undefined. A reader following these rows would look for a reporting seam that is not there and would believe the delete handler returns void. `ci:directory-map` checks row EXISTENCE, not row content, which is why the gate was green. This is the fourth self-description defect on a branch whose deviations already record three.

### `F02` — P0 — The `customer.subscription.deleted` arm of D9 is defended by zero tests — forcing it to write `processed` passes the whole ingress suite

**At:** `worker/ingress/stripe.ts:113` · **Duty 1** · **Disposition:** `open`

**Arbiter confirmation.** The mutated statement is on an executed branch: promised test 30 drives `case 'customer.subscription.deleted'` through the dispatcher. The mutation is not equivalent — `ackedForAge = false` makes a stale, acked-for-age delete event close its inbound_events row as `processed` instead of `stale_ignored`, and `claimInboundEvent` returns `duplicate` for `processed`, so an operator's manual resend from the Stripe dashboard is silently swallowed. That is precisely the outcome the branch names as D9's most important detail and states it prevents. I confirmed the survivor is total, not local: `npx vitest run worker/ingress/` under the mutant produced 472 passed / 1 failed, byte-identical to the same command at HEAD (the one failure is an unrelated pre-existing rate-limit test, see F14). No test in the repository kills it.

The CODE at HEAD is correct — `ackedForAge = ack.ackedForAge` does the right thing. What is absent is any test that would notice if it stopped. The asymmetry is sharp and measurable: the sibling `customer.subscription.updated` arm at stripe.ts:122 is properly pinned (M13 forced it to `false` and promised test 29 failed immediately), while the deleted arm at :113 is pinned by nothing. Claim 2 of the review brief — "the ack writes stale_ignored, never processed" — is therefore TRUE in the code and UNPROVEN by the suite for one of its two handlers. Cheapest fix: one dispatcher test mirroring promised test 29 for `customer.subscription.deleted`, with `mockProcessSubscriptionDeleted.mockResolvedValue({ ackedForAge: true })`, asserting `markInboundEventStaleIgnored` was called and `markInboundEventProcessed` was not.

### `F03` — P1 — Promised test 30's delete half asserts through the dispatcher's CATCH arm, so it proves nothing about that arm's success path

**At:** `worker/ingress/__tests__/stripe.test.ts:~197 (beforeEach `mockProcessSubscriptionDeleted.mockResolvedValue(undefined)`)` · **Duty 2** · **Disposition:** `open`

Proven by running the test at HEAD under the isolated environment and capturing stderr: `[ingress/stripe] Failed to process event evt_ctx_deleted (customer.subscription.deleted): Cannot read properties of undefined (reading 'ackedForAge')`. The suite's mock resolves `undefined`, but the dispatcher does `ackedForAge = ack.ackedForAge`, so the delete half of the test throws a TypeError, is caught by handleStripeWebhook's catch arm, and marks the event failed. The test still passes because its only assertion is `expect(mockProcessSubscriptionDeleted).toHaveBeenCalledWith(...)`, which was already satisfied before the throw. Consequence: no test anywhere executes the delete arm's ack->status-close path successfully, which is the mechanism behind F02. This is the same class as the branch's own D4 note about a test pinning `resolves.toBeUndefined()` — a stale mock shape outliving the signature change. Fix: make the mock resolve `HANDLED_NORMALLY`/`{ackedForAge:false}`.

### `F04` — P1 — The new acked-for-age Sentry signal has no rule row, while the change removes the error-level alert it replaces

**At:** `worker/ingress/stripe/shared.ts:100 (`captureMessage('stripe_subscription_event_acked_for_age')`) vs docs/runbooks/beta-launch-alerting.md` · **Duty 5** · **Disposition:** `open`

Static comparison of the emitted signal against the runbook. The branch emits a NEW signal — `captureMessage('stripe_subscription_event_acked_for_age', { level: 'warning', tags: { feature: 'stripe_subscription_out_of_order', event_type } })` — and `docs/runbooks/beta-launch-alerting.md` contains no matching row: grep for `stripe_subscription_event_acked_for_age`, `acked_for_age`, `stale_ignored` and `stripe_subscription_out_of_order` all return zero hits, and the branch changes no file under docs/runbooks/. All six facets are therefore unrecorded: signal identity, filter, level, grouping title, threshold/cadence and destination action. The gap is worse than a missing row because of what the change simultaneously removes: the intake names the success signal as "HealthAlertPoller's inbound_events_failed:stripe:customer.subscription.* rate ... should fall to zero for the no-account class" — i.e. an ERROR-level, thresholded, documented alert is deliberately retired, and the only replacement is a WARNING-level captureMessage which the same runbook says three times (lines 79, 180, 306) "does not reliably classify as high priority" and for which "no Discord route is configured yet". An operator therefore loses a page and gains nothing routed.

### `F05` — P1 — The intake's first observability promise — a structured log line per redaction outcome — was not delivered

**At:** `worker/jobs/account-offboarding/purge-stages.ts:760-818 (runStripeCustomerRedactionPurgeStage)` · **Duty 5** · **Disposition:** `open`

The intake's `observability[0]` reads: "A structured worker log line per redaction outcome: redacted, already_redacted, skipped_shared_customer, not_applicable, customer_absent. The stripe customer id is scrubbed." `runStripeCustomerRedactionPurgeStage` emits no log line at all, and purge-stages.ts imports no logger (`grep -n 'logger|createWorkerLogger'` over the file at HEAD returns nothing). The only durable record of an outcome is the `provider_dispositions` append, which is queryable but is not an operator-visible log line and does not reach the worker's JSON log stream. Two of the five promised outcome names also do not exist in the code: `not_applicable` is not a member of `StripeCustomerRedactionOutcome` nor of the stage's record union. Combined with F04 this leaves the whole redaction stage with no live observability surface: no log line, no metric, and no alert rule for the one Sentry signal the feature does emit.

### `F06` — P1 — Uncovered change: the UPDATE-side `resource_missing` short circuit has no covering test

**At:** `src/lib/account-offboarding/stripe-customer-redaction.ts:192` · **Duty 1** · **Disposition:** `open`

Reverse-import search over the module's only test file found no candidate exercising `customers.update` rejecting with `code: 'resource_missing'`. Promised test 5 rejects on `customers.retrieve`; the two update-side rejection tests use `StripeConnectionError` (T07) and `parameter_unknown` (T32). The branch's claim 4 — "only `resource_missing` and a deleted customer are success" — is therefore proven for the retrieve path and unproven for the update path, even though the update path is the one that performs the irreversible write and the one whose misclassification would finalize a purge whose redaction silently failed.

### `F07` — P1 — Uncovered change: the non-finite `created` guard in outOfOrderRetryWindowOpen has no covering test

**At:** `worker/ingress/stripe/shared.ts:82` · **Duty 1** · **Disposition:** `open`

Reverse-import search across both boundary suites found no test supplying a non-finite `created`. Promised tests 27 and 28 supply a NEGATIVE age (`eventContext(-3600)`), which the `ageSeconds <= 900` comparison rejects on its own with the guard removed, so they do not cover it. The function's own docstring singles the guard out as load-bearing — "a non-finite one (a fixture or provider payload with no `created` — `NaN <= 900` is false, which would otherwise ack everything)" — and that is the more dangerous half of the fail-open story, because a provider payload missing `created` would silently ack every subscription event with no resolvable account. Documented as essential, defended by nothing.

### `F08` — P1 — The already_redacted short circuit does not discriminate `.every` from `.some` — a marker-present, field-dirty customer is untested

**At:** `src/lib/account-offboarding/stripe-customer-redaction.ts:227` · **Duty 1** · **Disposition:** `open`

Mutation M2 changed `REDACTED_CUSTOMER_FIELDS.every(...)` to `.some(...)` and promised test 4 still passed. The test seeds all eight fields null plus a matching marker, an input for which the two quantifiers agree, so it cannot tell them apart. Under `.some`, a Customer carrying this offboarding's marker with even one field still populated is reported `already_redacted`, NO update is issued, and that identifier stays live at Stripe — the exact privacy failure the stage exists to prevent. Reachability is narrow but not nil: the marker can only match when this same offboarding already redacted this customer, so the state needs a write to the Customer at Stripe between the first update and a retry, or a future change that adds a ninth field to REDACTED_CUSTOMER_FIELDS while old markers exist. One test — marker present, `email` populated, expect `redacted` and one update call — closes it.

### `F09` — P1 — Fragile assertion: promised test 43 asserts SQL query text and structural absences instead of the behaviour its title names

**At:** `worker/background/pollers/health-alert/__tests__/checks.test.ts:222-236` · **Duty 2** · **Disposition:** `open`

The title is "checkFailedInboundEvents does not count stale_ignored rows", but the test never supplies a stale_ignored row and never asserts anything about the returned findings — it pushes `[]` into the mock and then inspects the template string: `expect(queryText).toContain("status = 'failed'")`, `.not.toContain('stale_ignored')`, `.not.toContain('IN (')`, `.not.toContain('!=')`. The last two are absence-of-token proxies of exactly the class this duty exists to catch: `not.toContain('IN (')` and `not.toContain('!=')` are stand-ins for "the predicate stayed failed-only", and they will fail on a legitimate rewrite that keeps the behaviour (adding an unrelated `AND source IN (...)` filter, or expressing the same window with `!=`), while passing any widening that avoids those two byte sequences. The behavioural replacement is cheap and stronger: push a row set containing a stale_ignored group into `sqlReturnQueue` and assert no `inbound_events_failed:*` finding is emitted for it. The kill I measured (M6) confirms the test does pin SOMETHING, so this is fragility, not a fake.

### `F10` — P1 — Promised test 40 is a behavioural duplicate of test 10 and exercises no lock ordering, despite a title that claims a race

**At:** `worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts:138-152` · **Duty 2** · **Disposition:** `open`

"the redaction guard still skips when the writer wins the binding lock first" has an identical arrangement to promised test 10 — the same three `sqlReturnQueue` pushes with `{ count: 1 }` — and identical assertions (`mockRedactStripeCustomer` not called; the append names `skipped_shared_customer`). Nothing in it represents a writer winning a lock; the mock returns `count: 1` unconditionally, so the two orderings are indistinguishable at this seam. Evidence that it adds no discriminating power: mutation M8 (`> 0` -> `> 1`) is the single mutation covering this behaviour and it kills test 10, so test 40 can only ever repeat that verdict. The genuine ordering claim is already carried by test 35 (lock index 0, before the count index) and by the live-DB test 36; test 40 either needs a distinguishing arrangement or is honest padding on the count of 45.

### `F11` — P2 — Promised test 8 carries a tautological second assertion

**At:** `src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts:247-249` · **Duty 2** · **Disposition:** `open`

`expect(stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID)).toBe(stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID))` compares a pure function's output to itself and cannot fail for any implementation, including a random one, provided it is memoised or simply deterministic within a tick — and a genuinely random implementation would already have been caught by the first assertion. The first assertion (the key passed to `customers.update` equals the exported helper's output) is real and does the work; the second is decoration. Determinism ACROSS calls with the same input is worth pinning as a literal expected string, not as a self-comparison.

### `F12` — P2 — The deliberately duplicated 900-second boundary tests cannot detect the drift their comment cites

**At:** `worker/ingress/stripe/shared.ts:80-85` · **Duty 1** · **Disposition:** `open`

Both suites carry a comment saying the boundary is proven separately per handler because "one shared boundary test could exercise processSubscriptionUpdated while processSubscriptionDeleted quietly used >= 900". That drift is structurally impossible at HEAD: there is exactly ONE comparison in the codebase, the pure `outOfOrderRetryWindowOpen`, and both handlers call it. Measured: mutation M1 (`<=` -> `<`) killed promised test 25 and, unchanged, killed promised test 26 (M1b) — one character, two kills. The duplication is therefore free insurance against a refactor that inlines the predicate, but the stated rationale no longer describes the code. Claim 5 of the review brief SURVIVES this attack: the boundary is not merely implemented identically at both handlers, it is implemented once. Recording it so a later reader does not mistake the comment for a description of two implementations.

### `F13` — P2 — RECLAIMABLE_INBOUND_EVENT_STATUSES has no CI audit, unlike the OUTBOX_IN_FLIGHT_STATUSES idiom it says it mirrors

**At:** `worker/ingress/shared.ts:37` · **Duty 4** · **Disposition:** `open`

Sibling search across the repo for consumers of `inbound_events.status`: `rg -n 'inbound_events' --glob '!**/__tests__/**' --glob '!*.md'`. Every consumer that needed updating was updated — ArchivalPoller's sweep (widened), checks.ts's failed-only alert (correctly left alone), the purge's payload scrub (status-independent), purge-verification.ts (status-independent), and claimInboundEvent's reclaim. Two near-misses that are genuinely safe: `worker/ingress/resend.ts:150` tests `existing.status !== 'processed'`, but that branch is only reachable after claimInboundEvent returns 'duplicate', which a stale_ignored row never does; and the Telegram/Twilio/Zernio handlers inherit the widened reclaim without writing the new status. So: zero missed siblings, recorded as a sound negative. What the search did surface is an enforcement gap. The constant's docstring says the SQL "spells the members literally ... mirroring the OUTBOX_IN_FLIGHT_STATUSES idiom", but that idiom's other half is `ci:outbox-status`, which checks members AND order against the hand-spelled SQL; nothing equivalent exists for this constant. A third member added to the array with no SQL change passes lint, typecheck and promised test 42, which asserts only that the array contains 'failed' and 'stale_ignored'.

### `F14` — P2 — One pre-existing test fails under the isolated environment at HEAD — recorded so it is not mistaken for mutant damage

**At:** `worker/ingress/__tests__/ (ingress rate-limit hook — absolute-form request targets)` · **Duty 1** · **Disposition:** `open`

`npx vitest run worker/ingress/` at unmutated HEAD under the red-team scrubbed environment returns 472 passed / 1 failed: "ingress rate-limit hook — absolute-form request targets enforces the ingress rate limit on an absolute-form request target". The identical result appeared under mutation M12, which is how I established that M12 is killed by zero tests. Because it reproduces at HEAD it is not a defect this branch introduced; the most likely cause is the deliberately minimal dotenv the run substitutes (the environment allowlist is PATH/HOME/TMPDIR/NODE_ENV/CI/MOCK_EXTERNAL_APIS plus the localhost test DB). Flagged only so a later reader comparing my numbers against the branch's green gate evidence is not misled.

---

## Authorizations

_None. No finding on this run is dispositioned `accepted-risk`._

---

## Adjudication needed

Two open P0s block the PR and, per the skill, wake the user. Eight open P1s on a high-risk (worker + webhook + billing) branch require user adjudication rather than root-agent arbitration.

Cheapest path to green, in the order I would take it:

1. `F01` — correct three `docs/directory.md` rows to the shipped `StripeSubscriptionAck` return. Pure documentation.
2. `F02`/`F03` — one dispatcher test for the `customer.subscription.deleted` stale-ack path, and fix the stale `mockResolvedValue(undefined)` that hides it. Roughly fifteen lines.
3. `F04` — one row in `docs/runbooks/beta-launch-alerting.md` for `stripe_subscription_event_acked_for_age`, with all six facets.
4. `F06`/`F07`/`F08` — three small tests closing three uncovered branches the code's own docstrings call load-bearing.
5. `F05`, `F09`, `F10` — a log line, a behavioural rewrite of test 43, and a distinguishing arrangement for test 40 (or its honest retirement).

The 31 `skipped-budget` rows do not change the status (`OPEN_P0` takes precedence) but they are the honest limit of this pass: 14 of 45 promised titles were mutation-tested, chosen to cover the three headline claims. A round 2 could spend its budget on titles 2, 14, 32 and 35, which carry the most behaviour per test among the untested.
