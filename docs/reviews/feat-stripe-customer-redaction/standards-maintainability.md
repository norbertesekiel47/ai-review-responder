# Standards & maintainability review — feat/stripe-customer-redaction

- **SHA reviewed:** `00f6d56be77d77b4f1e45ff28a99b7c6bda778fe`
- **Fork point:** `b9fb96016cc025c151f17db4b39baf165cb80a13` (18 commits)
- **Production diff:** 885 lines (846 added, 39 deleted), excluding tests and docs.
  Measured on the added production hunks: 461 code, 324 comment (38.5%), 56 blank.
- **How files were read:** every source file via `git show 00f6d56b:<path>` and
  `git diff b9fb9601..00f6d56b -- <path>`. Nothing was read from the working tree
  (a sibling red-team agent is mutating it). Line numbers below are line numbers
  **at `00f6d56b`**, verified by re-reading the blob.
- **Skipped:** anything the green gate already enforces (`ci:tenant-scope`,
  `ci:static-policy`, `ci:directory-map` row presence, `ci:db-imports`,
  `ci:outbox-status`, lint, typecheck). Nothing in the diff circumvents a tool.
- Checked every entry in `docs/reviews/finding-checklists/standards-maintainability.md`
  against this diff. Two of its classes recur here and are reported below: **stale
  prose that the same commit invalidated** (F1) and **a comment that states a
  mechanism the code does not implement** (F4, F5).

---

## F1 — P1 — `docs/directory.md:1763`, `:1795`, `:1796`

**Violated standard.** CLAUDE.md working rules: *"When deleting a doc or ticking a
checklist item, fix its audit tick and grep the filename to clean every
cross-reference in the same change."* And the global rule *"Green CI is not proof
that documentation is true."* `ci:directory-map` only checks that a **row exists**
per production file — it never reads the row's prose, so this passes green.

**Evidence.** Three rows describe an ack-reporting design that commit `15e57e4c`
deleted, and they name two symbols that do not exist anywhere in the tree at this
SHA:

- `:1763` (`worker/ingress/stripe.ts`) — *"and from `callVoidHandlerReportingAckForAge`
  for the `Promise<void>` delete handler"*
- `:1795` (`worker/ingress/stripe/shared.ts`) — *"the ack report channel
  (`callVoidHandlerReportingAckForAge`/`recordStripeEventAckedForAge`) the
  `Promise<void>` delete handler uses"*
- `:1796` (`subscription-deleted.ts`) — *"acks for age via
  `recordStripeEventAckedForAge()` (returns undefined either way)"*

`git grep -n 'callVoidHandlerReportingAckForAge\|recordStripeEventAckedForAge' 00f6d56b`
returns **only these three doc lines**. At this SHA
`processSubscriptionDeleted` returns `Promise<StripeSubscriptionAck>`
(`subscription-deleted.ts:21`) and reports via `ACKED_FOR_AGE`/`HANDLED_NORMALLY`
(`:82`, `:118`). The branch's own D4 deviation records the deletion
(*"the `AsyncLocalStorage` ack channel is deleted"*) — the code was updated, the
map was not. A reader who greps for `recordStripeEventAckedForAge` finds nothing
and cannot tell whether the doc or the code is current.

**Smallest correction.** Rewrite the three clauses to name the shipped mechanism —
`processSubscriptionDeleted` returns `StripeSubscriptionAck` (`ACKED_FOR_AGE` /
`HANDLED_NORMALLY`); the dispatcher reads `ack.ackedForAge` for delete and the
`stale_no_account` reason for update. Three sentence edits, no code change.

---

## F2 — P2 — `src/lib/account-offboarding/stripe-customer-redaction.ts:266-278`

**Violated standard.** CLAUDE.md working rules: *"no near-duplicate dependencies,
no abstractions for a single caller"* — and the named owner's own docblock,
`src/lib/payments/stripe-error-inspect.ts:9-15`: *"The consumers apply different
RETRY POLICIES on top of these facts … and those policies are intentionally
theirs. What must never drift independently is the vocabulary below."* The
justification only holds while the policies actually differ.

**Evidence.** `isRetryableStripeError` in the new module is **byte-identical** to
`src/lib/account-offboarding/stripe-invoices.ts:443-455` — verified by
`diff` of the two 13-line extracts, zero differences. The error-detail extraction
(`:251-256` vs `stripe-invoices.ts:458-463`) is the same four expressions, and
`StripeCustomerRedactionErrorDetails` (`:116-121`) is field-for-field
`StripeInvoiceCleanupErrorDetails` (`stripe-invoices.ts:91-96`). Yet
`:260-265` asserts *"The retry POLICY is this module's own; only the type
vocabulary is shared"* — a distinction the code does not make. Both live in the
same folder, both classify Stripe errors for the same offboarding lane. The
precedent module's own history shows the repo's rule for this: `error-inspect.ts`
was extracted *"when its third non-Stripe consumer arrived"*.

**Smallest correction.** Move the shared 13-line function to
`src/lib/payments/stripe-error-inspect.ts` as `isRetryableStripeError(err)` (it
already owns both type sets that function reads) and have both offboarding modules
import it; delete the `:260-265` comment. If the copy is instead deliberate,
change that comment to say so verbatim — *"a deliberate byte-copy of
`stripe-invoices.ts`'s policy; keep them in lockstep"* — so the next reader is not
told the two differ when they do not.

---

## F3 — P2 — `worker/ingress/shared.ts:34` and `src/lib/account-offboarding/table-disposition.ts:450`

**Violated standard.** CLAUDE.md working rules: *"no abstractions for a single
caller"*; and the fallow/dead-export posture the branch itself invokes in D4
(*"without this it had zero production callers — dead code the adversarial pass
would rightly flag"*).

**Evidence.** Two new exports have **zero production consumers** — only their own
test files:

1. `RECLAIMABLE_INBOUND_EVENT_STATUSES` (`worker/ingress/shared.ts:34`, docblock
   `:17-33`). Its docblock says *"The predicate below spells the members literally — this
   constant is what the tests assert against, mirroring the
   `OUTBOX_IN_FLIGHT_STATUSES` idiom."* That idiom is only safe because
   `ci:outbox-status` mechanically compares the constant's members **and order**
   against every literal SQL site (`src/lib/shared/job-outbox-status.ts:18-20`,
   `:29-32`). There is no equivalent audit here, so the constant and the SQL at
   `:67` can drift silently and the two assertions
   (`worker/ingress/__tests__/shared.test.ts:84-85`, both `toContain`) would still
   pass. The claimed mirror is the half that does no work.
2. `PROVIDER_DATA_RETENTION` (`table-disposition.ts:450`). Only
   `__tests__/table-disposition.test.ts` imports it.

**Smallest correction.** For (1): make the SQL derive from the constant, or drop
the `OUTBOX_IN_FLIGHT_STATUSES` claim and state plainly that it is a
documentation constant with no drift guard. For (2) see F4 — a real consumer
exists and would remove the dead-export status.

---

## F4 — P2 — `src/lib/account-offboarding/table-disposition.ts:444-449`

**Violated standard.** Same class as the accepted finding *"the shipped comment's
stated condition is incomplete / states a FALSE mechanism"* — a docblock that
claims a data-flow the code does not have.

**Evidence.** The docblock says *"The deletion receipt and the privacy policy are
written from these reasons"* (`:446`). Neither is. The receipt sentence is a
hardcoded const —
`src/lib/notifications/email/templates/account-offboarding.ts:285-286`,
`PAYMENT_PROCESSOR_RETENTION_SENTENCE` — and the privacy paragraph is a hardcoded
string in `src/lib/legal/content.ts:244`. Neither file imports
`PROVIDER_DATA_RETENTION` (grep confirms: no `.ts` importer outside the test).
CONTEXT.md's new "Provider data retention" entry repeats the same claim
(*"both written from it"*). So the same fact — *paid invoices keep the billing
name and address, `tax_ids` survives* — is now spelled in **three** places, with
one of them documented as the owner of the other two. That is precisely the
condition under which the two copies drift and the "owner" stops being true.

**Smallest correction.** Either derive: export a
`providerRetentionSentence()` from `table-disposition.ts` (or a sibling) and have
both the email template and `legalDocs` read it — which also gives
`PROVIDER_DATA_RETENTION` its production consumer and resolves F3(2). Or, if the
prose must stay hand-tuned per surface, change `:446` and the CONTEXT.md sentence
to *"the wording an author must reconcile with"* and add a test asserting the
three texts agree on the two named categories.

---

## F5 — P2 — `src/lib/account-offboarding/stripe-customer-redaction.ts:260-265` (with `:123-131`)

**Violated standard.** Same class again: a comment naming a consumer that does not
exist. Also invariant #12's spirit — *"modules own failure behavior"* — the module
built a structured failure contract that nothing reads.

**Evidence.** `:263-265`: *"the classification exists so the purge worker's failure
sink can tell a Stripe outage from a misconfiguration without parsing a message."*
The purge worker's failure sink is `PurgeWorker.ts:97-113` and
`alertPurgeFailure` (`:116-134`). It reads `errorMessage(err)`, scrubs it, and
sends `error: safeMessage` to Sentry. It never touches `.retryable`, `.operation`,
or `.stripeError`. Grep confirms no non-test reader of `StripeCustomerRedactionError`
anywhere. So the operator gets exactly *"Stripe customer redaction hit a permanent
Stripe error on update."* — with the `type`/`statusCode`/`code`/`requestId` the
class was built to carry (`:251-256`) dropped on the floor. The `:123-131`
docblock's premise (bounded message **plus structured details**) is only half
delivered.

*(On the question the brief asked: the error CLASS itself is **not** speculative
generality — it matches the named precedent exactly. `StripeInvoiceCleanupError`
also has no non-test reader of `.retryable`. The defect is the new, checkable, and
false claim about who consumes it.)*

**Smallest correction.** In `alertPurgeFailure`, add the structured fields to the
Sentry `extra` when the error is a `StripeCustomerRedactionError` — roughly four
lines, and it makes the docblock true. If that is out of scope, delete the second
sentence of `:260-265` and the "structured details" half of `:129-131`.

---

## F6 — P2 — `worker/ingress/stripe.ts:113` vs `:122`, and `worker/ingress/stripe/shared.ts:127-144`

**Violated standard.** Invariant #12 — *"Entry points orchestrate; modules own
failure behavior"*; and *"no abstractions for a single caller"*.

**Evidence.** One fact — *this event was acked for age* — is now reported to the
dispatcher through **two different mechanisms**:

- `:113` — `ackedForAge = ack.ackedForAge`, from `StripeSubscriptionAck`.
- `:122` — `ackedForAge = outcome.kind === 'ignored' && outcome.reason === 'stale_no_account'`,
  a two-part literal comparison the **dispatcher** performs.

The `:122` form puts the policy knowledge ("this reason means acked") in the entry
point rather than in the module that produced the outcome, and spells the
discriminant `'stale_no_account'` as a bare literal in `stripe.ts` in addition to
its declaration site (`subscription-updated.ts:129`). Meanwhile
`StripeSubscriptionAck` + the two frozen sentinels
(`stripe/shared.ts:136-144`) exist for exactly **one** caller, and their docblock
generalises to *"What a subscription handler reports back to the dispatcher"* —
which the update handler does not do. So the diff ships both a single-caller
abstraction and an entry point doing the module's classification.

**Smallest correction.** Export a one-line predicate from `subscription-updated.ts`
next to the union — `export function updatedOutcomeAckedForAge(o: SubscriptionUpdatedOutcome): boolean`
— and have the dispatcher call it, so the literal lives with its declaration and
both arms read the same at the call site. (A larger unification — making
`processSubscriptionUpdated` also return `StripeSubscriptionAck` — is not worth it;
its outcome type carries other consumers.)

---

## F7 — P2 — `worker/ingress/__tests__/helpers/stripe-webhook-harness.ts:27`

**Violated standard.** Same "fix every cross-reference in the same change" rule as
F1, applied to a shared helper's canonical usage contract.

**Evidence.** The harness header is the documented recipe every suite copies. Line
27 still reads:

```
//   vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
```

This branch proved that exact factory now throws — the seven suites it repaired
each carry the comment *"a factory naming only claimInboundEvent throws 'No export
defined on the mock' at the closing write"* (e.g.
`worker/ingress/__tests__/stripe-audit.test.ts:38-40`). The harness that owns the
recipe was edited in the same commit range (`:208-215`, `:250-256`, `:293-302`,
`:377-382`) but its instructions were not. The next suite written from this header
fails on its first run.

**Smallest correction.** One line — add `markInboundEventProcessed: vi.fn(),
markInboundEventStaleIgnored: vi.fn(),` to the snippet at `:27`.

---

## F8 — P3 — `src/lib/account-offboarding/stripe-customer-redaction.ts:96`, `:101`

**Named smell.** Declared-but-unused interface surface (speculative parameter).

**Evidence.** `StripeCustomerRedactionClient` declares
`requestOptions?: { maxNetworkRetries?: number }` on `retrieve` and
`maxNetworkRetries?: number` on `update`. `redactStripeCustomer` never passes
either (`:171`, `:186-190`). The named precedent does the opposite: every call in
`stripe-invoices.ts` passes a normalised, capped `maxNetworkRetries`
(`:340-359`, `:418-423`). Behaviour is fine — `getStripe()` sets
`maxNetworkRetries: 2` globally (`stripe-client.ts:19`) — but the interface
advertises a knob no caller can reach and no test exercises.

**Smallest correction.** Delete `maxNetworkRetries` from both signatures (keep
`idempotencyKey`, which is used), or pass the module's own constant the way the
precedent does. Deleting is smaller and matches actual behaviour.

---

## F9 — P3 — `worker/background/pollers/health-alert/__tests__/checks.test.ts:235-236`

**Named smell.** Assertion coupled to incidental SQL text rather than to the
behaviour under test.

**Evidence.** The new case pins `expect(queryText).not.toContain('IN (')` and
`.not.toContain('!=')`. Neither token has anything to do with
`stale_ignored`. Any unrelated widening of that query — `WHERE source IN
('stripe','zernio')`, a `!= 'x'` guard — fails a test whose stated purpose is
"does not count stale_ignored rows". The two useful assertions
(`toContain("status = 'failed'")`, `not.toContain('stale_ignored')`) already carry
the claim in full. *(The `not.toContain` SQL-text idiom is pre-existing in this
file at `:361`, so the idiom itself is not the defect — the two generic tokens
are.)*

**Smallest correction.** Delete `:235` and `:236`.

---

## F10 — P3 — the same rationale is spelled out in four production comments

**Named smell.** Duplicated prose with no single owner — the condition under which
one copy goes stale (which this branch has already demonstrated once, F1).

**Evidence.** *"`'processed'` is the one status `claimInboundEvent` refuses to
reclaim, so closing an acked event as `processed` would make an operator resend
return `duplicate`"* is written out in full at:

- `worker/ingress/shared.ts:17-33` (the constant's docblock — the natural owner)
- `worker/ingress/stripe.ts:132-137` (the ack branch)
- `worker/ingress/stripe/subscription-updated.ts:125-129` (the union member)
- `worker/background/pollers/ArchivalPoller.ts:88-95` (paraphrase)

plus twice more in `docs/directory.md` and once inside a log string
(`subscription-deleted.ts:74`). `markInboundEventStaleIgnored`'s docblock
(`shared.ts:86-92`) is the one that does this correctly — it **points at** the
owner instead of restating it.

**Smallest correction.** Keep `shared.ts:17-33` as the owner; reduce the other
three to a pointer in the same style as `shared.ts:91` (*"see
`RECLAIMABLE_INBOUND_EVENT_STATUSES` for why"*). Net deletion of ~14 comment lines.

---

## Judgements the brief asked for, where I found no defect

- **`StripeCustomerRedactionClient` depth (`retrieve` + `update`).** Correct, and
  precedent-consistent — `StripeInvoiceCleanupClient` (`stripe-invoices.ts:33-54`)
  declares exactly the three methods it calls, with the same
  `(id, params, requestOptions)` shape. The `deleted?: boolean | void` field
  (`:63-73`) is the SDK's own union discriminant and the docblock earns its length
  by recording *why* narrowing it breaks `getStripe()`. No finding beyond F8.
- **`acquireStripeCustomerBindingLock` inside `applyStripeSubscriptionStateInternal`.**
  The stated reason holds and I verified it: both exported entry points
  (`apply-subscription-state.ts:208` and `:231`) funnel through the internal
  function, and `:218` takes the entitlement lock before delegating, so the
  documented ordering (entitlement first, customer-keyed second) is true for both.
  Locking in the wrapper would leave `applyStripeSubscriptionState` outside it.
  Right seam.
- **The seven repaired suites — better or worse coupling?** Net **better**. The
  four `sqlReturnQueue.push([]) // ingress wrapper marks processed` slots were
  *removed* from the harness (`:236`, `:275`, `:316`, `:407` at fork) and replaced
  by a named mock — the closing write no longer occupies a positional queue slot,
  which is strictly less brittle. The four new `2b` advisory-lock slots re-add
  positional coupling, but that is the pre-existing harness design (a positional
  `sqlReturnQueue`), not something this branch introduced, and each new slot
  carries a comment naming which lock it stands for. The one genuine regression is
  F7, the stale recipe.
- **Provider HTTP call inside `sql.begin` holding an advisory lock**
  (`purge-stages.ts:762-820`). Not a finding: this is an established pattern in
  the same subsystem — `checkout-completed.ts` provider-reads the Session and
  subscription under `acquireTierBillingActivationLocks`, and `invoice-paid.ts`
  retrieves the provider-current subscription inside the entitlement-locked tx
  (both per `docs/directory.md:1789`, `:1791`). The 20s `getStripe()` timeout
  bounds it. Precedent-consistent; the tradeoff is recorded in the stage docblock.
- **The line-keyed allowlist re-pinned twice** (`static-policy-audit.ts:255`,
  paired test `scripts/ci/__tests__/static-policy-audit.test.ts:443`).
  **No branch-local correction available; note and leave.** The key format
  `file:line` is baked into the audit at `static-policy-audit.ts:957` and into
  ~40 sibling entries; content-keying it is a cross-cutting change to the audit
  plus every entry, which does not belong in a Stripe-redaction PR. The branch
  handled it correctly: it re-pinned both copies, both resolve at this SHA
  (`worker/ingress/stripe/shared.ts:256` is the
  `subscription_status IN ('active', 'trialing')  -- enum:` predicate — verified),
  and it recorded the churn honestly. The one thing I would change is the
  narrative form: `:251-254` and the test's `:437-442` now each carry a
  three-hop line-number history that is itself a stale-citation liability. Worth a
  separate ticket to key the allowlist by `file` + the literal statement text.
- **Comment density.** 38.5% of added production lines are comments — high, but
  this repo's culture is decision-recording docblocks and most of them earn it
  (the `deleted?: boolean | void` SDK note, the D5 ordering tradeoff, the
  metadata-merge semantics, the `resource_missing`-only rule). The restating
  cases I found are F10 (duplication) and F4/F5 (comments that restate an
  intention the code does not implement). Nothing else read as narrating the code.

---

## Summary

| # | Sev | Where | One line |
|---|-----|-------|----------|
| F1 | P1 | `docs/directory.md:1763,1795,1796` | Three rows name two symbols the same branch deleted |
| F2 | P2 | `stripe-customer-redaction.ts:266-278` | `isRetryableStripeError` byte-identical to `stripe-invoices.ts`; comment claims it differs |
| F3 | P2 | `ingress/shared.ts:34`, `table-disposition.ts:450` | Two exports with zero production consumers; the `OUTBOX_IN_FLIGHT_STATUSES` mirror has no audit |
| F4 | P2 | `table-disposition.ts:444-449` | "receipt and privacy policy are written from these reasons" — neither is; three copies of one fact |
| F5 | P2 | `stripe-customer-redaction.ts:260-265` | The named consumer of the error classification reads only `.message` |
| F6 | P2 | `ingress/stripe.ts:113,122` | Two mechanisms for one fact; dispatcher performs the module's classification |
| F7 | P2 | `stripe-webhook-harness.ts:27` | Canonical usage recipe now throws; not updated with the seven suites |
| F8 | P3 | `stripe-customer-redaction.ts:96,101` | `maxNetworkRetries` declared, never passed |
| F9 | P3 | `health-alert/__tests__/checks.test.ts:235-236` | Asserts absence of generic SQL tokens unrelated to the claim |
| F10 | P3 | 4 files | One rationale restated in four production comments |

No P0. Nothing in the diff circumvents a green tool.
