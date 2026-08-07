# Adversarial approach review — #679 Import consent worker guard

## Scope

This review covers `git diff 2f369582..HEAD` and challenges the feature's
enforcement locus, concurrency model, failure semantics, and deployment
coupling. It deliberately does not assess line-level defects, coding standards,
or spec conformance; those belong to the other review axes.

The implementation is internally coherent on its chosen terms. The concerns
below are places where those terms should be reconsidered before the approach is
treated as settled.

## Findings

### A1 — High — Analytics is now an availability dependency of consent and connection finalization

The approach values perfect atomicity between a domain fact and its analytics
event over availability of the domain operation. That trade is too expensive on
this path.

`createImportOffer` writes `import_offer_created` through the caller's open
transaction (`src/lib/reviews/import-consent.ts:256-266`), and
`recordImportDecisionAndEnqueue` does the same for
`import_decision_recorded` (`:348-367`). Migration 102 explicitly acknowledges
that a database missing the two event names rolls back every offer and owner
decision (`supabase/migrations/102_import_consent_analytics_events.sql:14-25`).
This is not confined to the consent POST: `finalizeConnectionTx` calls
`createImportOffer` inside the transaction that writes the active Zernio
connection, the drain job, and the existing `gbp_connected` event
(`src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:205-226`). A
code-before-migration deploy can therefore break Google connection finalization,
not merely omit an analytics row.

The control is a manual deploy-order step. There is no compatibility window, DB
capability check, or release gate proving that the target database admits the
new names before Vercel or Railway begins serving the new code. The migration is
also a DROP/re-ADD CHECK swap under an ACCESS EXCLUSIVE lock, so analytics
taxonomy evolution is on the critical path of a user action even when the
domain schema itself has not changed.

Atomic analytics is useful, but an offer-created/decision-recorded funnel does
not justify turning a telemetry-schema mismatch into a connection and consent
outage. Revisit the boundary. Viable directions include a stable durable event
envelope whose schema does not require a per-name DB migration, an enforced
pre-deploy capability gate, or explicitly best-effort analytics after the
domain commit. If the transactional-outbox invariant rules out post-commit best
effort, that argues for the stable envelope or release gate—not for relying on a
runbook instruction.

### A2 — Medium — A policy refusal is persisted as indistinguishable success

Every non-accepted state is converted to a generic completed outbox row
(`worker/jobs/zernio/job-eligibility.ts:193-201`). The worker placement doubles
down on that choice: a refused run is intentionally kept out of
`zernio_backfill_runs` so it leaves "NO durable trace at all"
(`worker/jobs/zernio/ZernioBackfillWorker.ts:140-149`). The only surviving
explanation is a structured log line.

That erases the exact evidence this defense-in-depth control exists to produce.
The threat model is a hand-inserted row, a future producer regression, or an
ordering mistake. In all three cases, operations later sees a `completed` job—the
status documented as "Worker confirmed success"—with no completion reason and
no run record. Completed outbox rows are archived after seven days, and the log
is not a durable domain/audit record. A malformed producer can therefore keep
generating policy-blocked work while the queue looks healthy.

The three blocked classes also do not have identical recovery semantics:
`declined` and `expired` are terminal, while `pending` may become `accepted`.
Today pending recovery depends on a later acceptance transaction noticing that
the old row was completed and creating a replacement. That makes the consent
writer—not the blocked work item—the sole recovery mechanism and silently drops
the job if a future legitimate producer ever violates the assumed ordering.

Use a durable disposition. The existing `job_outbox.completion_reason` mechanism
shows the repository already distinguishes a completed job whose terminal
meaning is not ordinary success. At minimum, record consent-blocked reasons by
state and surface them in admin tooling. Prefer a reversible blocked/deferred
disposition for `pending`, or document and enforce the replacement-job protocol
as an explicit state transition rather than treating all non-accepted states as
the same successful no-op.

### A3 — Medium — “Manual SQL means no enqueue-time chokepoint” is a false constraint

The design concludes that the worker must be authoritative because the admin
path is manual SQL and therefore cannot share an application enqueue helper.
That considers only application-code chokepoints. The common durable boundary is
the `job_outbox` insertion itself.

A database trigger or constrained stored procedure can reject
`zernio_initial_backfill` inserts unless the referenced business is accepted.
It sees an acceptance update made earlier in the same transaction, so the
owner-decision producer remains atomic; it also covers manual SQL and future
producers at the point where the invalid state would otherwise be created. DB
triggers are not alien to this repository—migrations 056 and 077 already use
them for cross-field invariants.

The chosen worker protocol discovers the violation only after dispatch. Every
legitimate import now opens a transaction, locks the business row, and then
performs another business/account read in `guardZernioJobEligibility`; the
acceptance race required a three-session, lock-choreographed 516-line integration
suite to prove. Those costs are manageable at the current onboarding volume,
but they are costs of choosing the asynchronous consumer as the first
authoritative boundary, not unavoidable costs of consent enforcement.

This does not imply the worker check has no value as defense in depth. It means
the claim that it is the only possible chokepoint is unsound. Compare a DB-boundary
guard (possibly retaining a simpler worker assertion) against the current
consumer-side mutex before locking in the latter as the domain design.

## Appendix — lower-confidence observations, not table findings

### S1 — The separate-guard argument is a false dichotomy

Keeping live ingest unaware of Import consent does not require two backfill
reads. A backfill-specific composite preflight could read consent, archive state,
and subscription eligibility in one transaction/query while the existing ingest
guard remains unchanged. The present split is probably affordable at current
scale, so this is not promoted to a finding, but “merge the guard” versus “make
ingest know consent” are not the only two choices.

### S2 — The row lock closes the acceptance race, not multi-replica execution

The consent lock is released as soon as the guard returns `accepted`; it is not a
lease over the import. If duplicate accepted jobs execute on two worker replicas,
both can pass the guard and select the same incomplete `zernio_backfill_runs` row
before doing external work. BullMQ concurrency 1 plus the detected single-replica
invariant makes this unlikely today, but the new lock should not be read as
making the import multi-replica safe.

### S3 — The test ratio is corroborating evidence, not a defect by itself

The large test surface is mostly the cost of proving SQL ordering, transaction
membership, and a very specific lock interleaving. Those tests are justified for
the chosen protocol. Their size is useful evidence when comparing that protocol
with an insertion-time database invariant, but a high test-to-production ratio
alone is not a finding.

## Findings table

| severity | file:line | one-line finding |
|---|---|---|
| High | `src/lib/reviews/import-consent.ts:259` | Transactional analytics makes a per-event schema migration an availability dependency for Import consent and even Google connection finalization. |
| Medium | `worker/jobs/zernio/job-eligibility.ts:193` | Non-accepted jobs are consumed as generic success with no durable policy-block reason, conflating terminal refusal, recoverable pending state, and successful work. |
| Medium | `worker/jobs/zernio/job-eligibility.ts:185` | The worker-only chokepoint rests on a false premise: the database outbox insertion boundary can enforce consent for product code, manual SQL, and future producers before dispatch. |

---

## Orchestrator triage — 2026-08-07 (branch review round 1)

| Finding | Verdict | Disposition |
|---|---|---|
| High — transactional analytics is an availability dependency | **ACCEPT** | Verified independently and found to be **understated**: `createImportOffer` runs inside `finalizeConnectionTx` (`finalize-tx.ts:208`) and `select-location/route.ts:97-108` rethrows non-`23505`, so an unapplied migration 102 breaks **GBP connect entirely**, not merely a consent decision. Converged with the spec axis, which rated the same issue Medium. Owner chose the savepoint remedy: each emission is wrapped so a failed insert rolls back only itself and the parent transaction survives — atomicity kept on the success path, the availability dependency removed **in code** rather than by runbook discipline. |
| Medium — no durable policy-block reason | **ACCEPT as follow-up** → issue **#695** | Real. Today a refusal is visible only as a log line plus the *absence* of a `zernio_backfill_runs` row (intake `observability` item 3). A queryable block reason is better, but adding one is a design change to a twice-reviewed decision, not a defect in what shipped. |
| Medium — outbox-boundary chokepoint | **ACCEPT as follow-up** → issue **#695** | Genuine, possibly better. Filed rather than re-planned: it would reopen a decision locked at #670, add a migration, and delay closing the ADR 0015 §3 gap this ticket exists to close. Trade-offs on the issue, including that an insert-time gate cannot catch consent revoked between enqueue and dispatch — so it would complement the worker guard, not replace it. |

**Net: 3 of 3 accepted** — one fixed on this branch, two filed as #695. Nothing rejected.
