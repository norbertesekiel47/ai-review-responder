# Plan: #543 Run-engine executor + Solicitation watch-mode worker

_Locked via ticket-seeded `feature` grilling. Terms follow `CONTEXT.md`,
`docs/superpowers/specs/2026-07-23-run-engine-executor-shape.md`, and ADR 0011._

## Classification and contract

- **Risk:** high — worker execution plus migration 088.
- **Surface:** backend.
- **Estimated diff:** approximately 1,500 lines (about 825
  production/schema, 675 tests/docs), reclassified after the required surface
  amendments for mandatory account-offboarding coverage and shared
  exact-attempt outbox locking. The feature remains normal-sized: one
  worker/domain seam, one migration, and a tight named-file surface.
- **Intake:** `docs/superpowers/plans/codex-543-run-engine-executor-intake.json`.
- **Migration boundary:** migration 088 belongs to this branch; issue #546 and
  its migration remain out of flight until #543 lands.

## Module and seam design

### Agent run spine — deepen the existing module

`src/lib/agents/run-spine.ts` remains the only module that writes
`agent_runs`, `agent_run_steps`, and `agent_outcomes`. Deepen its existing
interface in two narrowly-scoped ways:

1. permit the two Solicitation run/subject pairings and optional
   `parentRunId` on `startOrGetActiveRun`;
2. add a set-based interface for recording already-decided completed child
   runs plus their single `ask_evaluated` steps.

This bulk interface is forced by the declared 5,000-contact bound and by the
run-spine ownership invariant. It keeps the implementation set-based without
creating another writer seam. The interface accepts ids/enums/counts only and
does not know about `solicitation_asks`.

### Solicitation batch builder — one new deep module

Add `src/lib/solicitation/batch-builder.ts`. `ingest.ts` was considered and
rejected: it owns one upload's parsing/contact/visit transaction, while batch
construction reads the accumulated location pool, owns retry semantics, and
commits a run graph. Adding that work to `ingest.ts` would worsen the #565
hotspot rather than deepen an existing coherent module.

The batch-builder interface owns the complete execution contract: gate
revalidation, parent start/reuse, outbox ownership, per-Business
serialization, bounded candidate selection, pure `evaluateBatch`, bulk
child/ask persistence, parent terminal attribution, `built_at`, and intentional
skip cleanup. The Railway worker calls this interface and logs the returned
aggregate; it does not reproduce domain SQL.

Parent preparation locks the exact dispatched outbox attempt before the batch
or run graph, then locks and re-reads the batch. A stale/terminal attempt exits
without creating a parent, and a `built_at IS NOT NULL` committed replay exits
without starting a second parent. Gates are rechecked on every attempt. A
closed gate deletes owned unbuilt work without a failed run when no parent
exists; when a parent already exists, the same transaction completes the owned
outbox and terminalizes that parent with bounded `gate_closed` attribution.

### Outbox/queue registries — deepen in place

Extend `QUEUE_NAMES`, `worker-types`, `job-outbox-helpers`, `worker/queues.ts`,
and `worker/index.ts` using the existing `csv_ingest` precedent. Deepen
`src/lib/shared/outbox.ts` with one
`lockDispatchedOutboxAttemptIfOwned`-style helper built from its private
`dispatchedRow` predicate; batch-builder must not duplicate that
watchdog-sensitive predicate. No new queue abstraction or dependency is
introduced. The `build_solicitation_batch` failed hook owns
exhausted-attempt behavior and uses the existing coupled terminal-transition
order: outbox ownership CAS first, then parent failure.

### New-file justification

- Migration 088 is required for additive schema.
- `batch-builder.ts` is required for the new deep module described above.
- `worker/jobs/solicitation-batch/` follows the mandated per-domain worker
  layout and keeps failure behavior beside the worker.
- New integration/unit test files match the corresponding public seams.
- No package or lockfile changes.
- Net growth above 150 lines is inherent new schema, worker behavior, and
  regression coverage; there is no superseded production path to delete.

## Tracer bullets

### T1 — Represent and persist one complete Solicitation run graph

**Blocking edges:** none.

Add migration 088 and the minimum run-spine interface needed to represent a
parent `solicitation_batch` run and completed `solicitation_ask` children:

- add nullable `agent_runs.parent_run_id` with `ON DELETE SET NULL` and its FK
  index;
- add the two additive run/subject pairings, `solicitation` persona,
  `ask_evaluated` / `batch_built` step keys, and
  `solicitation_batch_built` outcome without changing the three-state status
  enum or active-run partial index;
- create `solicitation_batches` and `solicitation_asks` with application
  UUIDv7 ids, composite Business integrity, owner-read-only RLS, idempotency
  constraints, archival-safe `agent_run_id`, and indexes serving candidate
  history/window queries;
- make the `solicitation_batches` owner SELECT policy itself require
  `built_at IS NOT NULL`;
- add `parentRunId` and a set-based completed-child interface to
  `run-spine.ts`;
- register both tables in the RLS inventory and migration retention log.
- register both tables as `hard_delete` account-offboarding data, add
  fail-closed purge verification, and extend the existing
  contact_csv_uploads cascade tests through batch → ask.

TDD slices:

1. migration catalog/constraint/RLS behavior;
2. parent linkage while the active-run conflict predicate stays exact;
3. set-based completed children with one `ask_evaluated` step each.

**Acceptance:** migration and run-spine promised tests pass; legacy
review/weekly run tests remain green.

### T2 — Turn one completed upload into one durable unbuilt batch

**Blocking edges:** T1.

Extend the successful `terminalizeUpload` transaction as one end-to-end
outbox tracer:

- generate one batch UUID;
- when and only when status is completed and
  `SOLICITATION_WATCH_ENABLED=true`, insert the unbuilt batch
  (`built_at=NULL`) and `build_solicitation_batch` outbox row in the same
  transaction;
- make replay idempotent by source upload;
- add the typed payload, queue name, enqueue helper, and focused helper tests;
- keep failed/subscription-inactive uploads and flag-off completions free of
  batch/outbox rows;
- update the flag registry description and structured ingest log counts.

Use a small named completion helper inside `ingest.ts` if necessary; do not
perform #565's unrelated five-function refactor.

TDD slices:

1. flag-on completed upload creates exactly one paired batch/outbox;
2. flag-off and non-completed terminal states create none;
3. replay creates no duplicate.

**Acceptance:** ingest integration and outbox-helper promised tests pass; the
state change and outbox row are proven atomic.

### T3 — Build one bounded batch atomically

**Blocking edges:** T1 and T2.

Implement the batch-builder deep module and its worker handler:

- in a short preparation transaction, call the shared
  `lockDispatchedOutboxAttemptIfOwned` helper, which composes the existing
  `dispatchedRow` predicate with `SELECT ... FOR UPDATE`, then lock/re-read the
  batch; stale/terminal attempts return before any parent mutation, preserving
  the outbox → batch/run lock order used by construction and the failed hook;
- return immediately on `built_at IS NOT NULL` without creating another
  parent;
- find an active parent and revalidate the feature flag plus
  `subscriptionGrantsFullAccess` on every attempt; when a gate is closed,
  atomically completion-CAS the owned outbox and delete the unbuilt batch,
  creating no failed run when no parent exists but terminalizing an existing
  parent with bounded `gate_closed` attribution;
- when gates are open, reuse the active parent or start the first parent under
  those locks;
- in the construction transaction, completion-CAS the exact outbox attempt
  first, then lock/re-read the batch and acquire the distinct per-Business
  advisory lock;
- select at most 5,000 distinct contacts from the whole accumulated location
  pool, ordered by least-recently-evaluated ask (NULL first), latest visit
  descending, then contact id;
- derive consent from the latest visit's completed upload, set
  `suppression=null` and `matchedReview=null`, and derive `priorBatch` from the
  latest prior ask with `status='send'` only;
- evaluate once with a single `decidedAt`, pre-generate ask/run ids, insert
  authoritative asks with nullable `agent_run_id` first, bulk-write completed
  child runs/steps second, then link each ask to its run in the same
  transaction; record the parent `batch_built` step and
  `solicitation_batch_built` outcome, complete the parent, and set `built_at`;
- return aggregate counts for PII-free structured logging.

The empty-pool case still builds a valid zero-unit batch. Because
`agent_outcomes.unit_count` currently requires `> 0`, migration 088 and the
interface must deliberately permit `0` for
`solicitation_batch_built` without weakening positive-unit requirements for
existing outcome kinds.

TDD slices:

1. candidate window cap/rotation and priorBatch semantics;
2. one atomic success from outbox ownership through built batch;
3. concurrent same-Business builds serialize and observe prior sends;
4. committed retry does not create a second running parent or duplicate
   domain/run rows;
5. the shared exact-attempt lock rejects stale ownership before parent
   creation without duplicating the outbox predicate.

**Acceptance:** batch-builder unit/integration and worker success-path tests
pass with no external call and no PII in JSONB/log aggregates.

### T4 — Register, skip safely, and terminalize exhausted attempts

**Blocking edges:** T3.

Complete the production worker path:

- instantiate/register the queue and worker at default single-slot
  concurrency, following `csv_ingest`;
- attach the failed hook;
- on flag/subscription skip, prove owned outbox completion and unbuilt-row
  deletion are coupled; if a parent exists, couple its bounded
  `gate_closed` failure attribution too;
- on exhausted failure, perform `markOutboxFailed` ownership CAS first, then
  mark only the active parent failed with bounded metadata while leaving the
  unbuilt batch hidden;
- stale attempts and non-exhausted failures write nothing terminal;
- add structured batch aggregate/skip/failure logs and rely on existing
  worker Sentry lifecycle plus failed-topic health checks.

TDD slices:

1. no-parent flag/subscription skip;
2. gate closure after parent start terminalizes that parent without
   evaluating candidates;
3. stale ownership no-op occurs before parent mutation;
4. exhaustion marks the owned parent and outbox only;
5. queue/worker registration is covered by outbox-topic and type gates.

**Acceptance:** all fifteen intake test titles exist verbatim and pass; the
worker entry point remains registration/lifecycle only.

## Verification and staging order

1. Run each tracer's focused unit/integration tests during TDD.
2. Run `scripts/verify-gate.sh`; integration SKIP is not acceptable for this
   DB-touching feature.
3. Run the high-risk adversarial implementation review, then deviations
   read-back.
4. Run `scripts/verify-gate.sh --review`, blast-radius analysis, and the two
   independent review axes.
5. Ride staging first. Apply migration 088 to staging only at the migration
   step, introspect columns/constraints/indexes/RLS, deploy the staging worker,
   and smoke a flag-on upload through built batch plus a forced retry.
6. Open the PR to `main` after staging evidence. Pause for explicit merge
   approval; production migration remains unapplied until promotion.

## Rollback and observability

The intake contract's rollback plan is binding. Immediate containment is the
default-off `SOLICITATION_WATCH_ENABLED` flag. Migration 088 is additive and
immutable after application; any destructive reversal is a new migration
after code rollback, staging first.

Production evidence is the structured batch aggregate, parent
`solicitation_batch_built` outcome/unit count, `built_at`, and existing
failed-outbox/Sentry worker signals. Never log or copy contact PII into run
details, outcome metadata, or structured logs.

## Open questions

None.
