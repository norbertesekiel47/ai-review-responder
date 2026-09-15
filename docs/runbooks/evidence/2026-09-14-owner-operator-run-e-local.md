# Run E local verification

Local worktree: `codex-owner-operator-run-e`, normalized after D feature #1291
and docs #1292 onto `30896acbcb2ee127131504e531f230fcfc7e4409`.
The earlier temporary D base was `4b13d96621b156a47dbc4140995f45745bc8114d`;
all partial E files were preserved byte-for-byte during normalization.
No E remote migration or deployment.
Local test database: loopback port5499, database `test_ws5`; all checks use the
safe `/private/tmp/run-e-local-check.py` wrapper with provider keys blank.

## T1 — refusal vocabulary and migration

Root implemented and reviewed T1 alone. Migration121 atomically replaces the
five declared refusal CHECKs, preserving C2/C4/C5 and access posture. The
existing writer gains two type-safe lane shapes; no second writer is added.
Existing Restraint exhaustive label maps receive the new category so consumers
continue to compile. This is not a claim that the complete refusal UI is done.

- RED: `/private/tmp/run-e-t1-red.log`: 2 failures, old schema rejects the new
  category and migration file does not exist.
- Provision121: `/private/tmp/run-e-db-head-121.log`: PASS, isolated local DB.
- `/private/tmp/run-e-t1-green.log`: 93 tests passed across migration116,
  migration121, vocabulary and existing writer suites.
- `/private/tmp/run-e-t1-typecheck.log`: PASS.
- `/private/tmp/run-e-t1-build.log`: PASS.
- `/private/tmp/run-e-t1-live-db-audit.log`: PASS, new shape suite uses the
  required exclusive local DB lock and executes actual migration SQL.
- `/private/tmp/run-e-t1-tenant.log`: PASS, 380 existing exceptions unchanged.
- `/private/tmp/run-e-t1-rls.log`: static and live DB PASS.
- Added actual shared-writer lane/retry test:
  `/private/tmp/run-e-t1-lane-recovered.log`: all 3 migration121 cases PASS.

The executable migration test restores pre121 constraints and proves rejection,
applies the file verbatim twice, accepts both correctly scoped lanes, rejects
invalid scope/subject/code-array combinations, and compares the public table
catalogue including columns, indexes, retained constraints, owner, ACLs and RLS
policy definitions. Historical116 behavior remains separately tested.

## Local infrastructure interruption

At 2026-09-14T04:58Z Docker shut down after a host no-space error. The additional
writer test failed before execution with ECONNREFUSED; preserved logs are
`/private/tmp/run-e-t1-lane-green.log` and `run-e-t1-lane-recovery.log`.
No test failure is represented as a successful assertion.

Removed only regenerable `.next` build caches from C and D, retaining all
source, evidence and database volumes. Docker's failed backend required a
restart after graceful shutdown failed. The stopped `repworth-testdb` contained
a 94-byte zero-filled `postmaster.pid`; it was preserved as
`postmaster.pid.zeroed-20260914`. A second corrupted temporary socket lock lived
in the old container layer. A new local container
`repworth-testdb-recovery-20260914` reuses the original data volume and port5499;
the old container remains stopped and retained. No volume rebuild or WAL reset.
Postgres readiness passed, and the migration/writer tests then passed at05:18Z.
D staging health continued to pass during the interruption; its candidate and
observation data were not changed.

## Restore and refusal component checks after D closeout

- `/private/tmp/run-e-t3-inverse-green.log`: 22 tests passed across catalog
  and proposals, including nullable tone, unrelated-field preservation and
  inverse writer selection for absent/deleted policy rows.
- `/private/tmp/run-e-writer-integration-review.md`: independent shared-writer
  review APPROVE. This does not verify the not-yet-connected Restore route.
- `/private/tmp/run-e-refusal-unit.log`: 20 card tests passed (8 TurnBody,
  12 existing ProposalCard). Focused ESLint and diff check passed.
- `/private/tmp/run-e-refusal-completion-green.log`: 11 helper tests passed;
  scope mapping, separate same-lane subjects and writer-error propagation.
  This is not yet a winning-fence/rollback integration proof.
- `/private/tmp/run-e-restore-preview-green.log`: 26 tests passed across the
  catalog and refusal helper. Restore preview covers custom 5/30/2 dials,
  inherited absence, current suspension preservation and account absence.
  The preceding `/private/tmp/run-e-restore-preview.log` was a test-runner
  startup failure from an incorrect project filter; no assertions ran there.

Third/final plan review: `/private/tmp/run-e-lock-order-plan-review.md`.
Root accepted lifecycle business-before-account ordering and preparation-only
`FOR NO KEY UPDATE` parent locks to avoid concurrent submission FK deadlocks.
Promised concurrency tests were added to both intake copies. Review verdict
REVISE is preserved; implementation verification remains outstanding.

Pure source validation: `/private/tmp/run-e-restore-inputs-green.log` passed
9 tests covering strict provenance, source/receipt scope and contract checks,
nullable tone, per-field restoration and clear/restore/undo derivation.
`/private/tmp/run-e-local-component-typecheck.log` passed after all component
files were present. The preceding typecheck ran during the deliberate missing-
module red phase and failed only on that missing module. `git diff --check`
passed. These components are not yet connected to the full Restore flow;
no final build/gate/browser claim follows from these checks.

Browser verification remains pending T7. D and its separate docs closeout are
now merged, so that sequencing dependency is satisfied. Authenticated refused
GET projection and Restraint copy edits were rejected twice by automatic
approval review, which treated the trusted authorization as D-only. No edits
from that proposed slice were applied; root requested direct E confirmation.
The release has not run.

## Hook-requested review gate — incomplete E candidate

The stop hook explicitly required the review wrapper before pausing. Root ran
`MAX_PARALLEL=1 VITEST_WORKERS=2` through the safe local wrapper; no pending
read/API patch was applied. Log: `/private/tmp/run-e-hook-required-review-gate.log`.
The run completed RED; `.feature/gate-status.json` records timestamp1789420473.
This is not final implementation verification or release evidence.

- Lint, typecheck, build, tenant/RLS/static-policy and the other passing audits
  completed successfully; local migration provisioning reached121.
- Full tests:16044 passed,11 skipped,1 failed. The same failure appeared in
  the gate's separate non-DB coverage stage (14760 passed,1285 skipped,1 failed).
  `openai-provider.test.ts:115` incorrectly requires every schema object to
  have a property; the new strict empty clear input reaches that assertion.
  Both test rows fail on this single case. No provider network calls occurred.
- Offline LLM evaluation:20/20 passed. Automated E2E:60 passed,108 skipped;
  this does not satisfy E's pending deployed browser journeys.
- All five changed integration suites passed, covering policy Apply/state,
  shared settings and migrations116/121.
- Directory map is missing rows for refusal-completion.ts, refusals.ts and
  restore-inputs.ts. Feature-surface sees two migration paths as absent because
  those files remain untracked; both files exist, and the intake spelling is
  correct. Do not remove required surface entries merely to silence this row.
- Eighteen promised public-flow test titles remain absent, consistent with
  unfinished Restore/fenced refusal integration. Do not rename helper tests
  to claim that those public behaviors are covered.

The first sandboxed gate-status probe falsely reported DEAD because it could
not inspect the escalated process. Root confirmed pid7810 remained live, waited
on the original execution handle, and did not restart it. The gate has now
terminated with exit1. Direct E confirmation remains pending after the two
automatic approval rejections; no second gate run has been launched.

## Explicit resume and integrated implementation — September 15 UTC

The owner directly answered “Yes finish it” to continuing and finishing E.
That resolves the earlier pending confirmation. The readback patch and the
Restore/fenced refusal integration are now applied. These results supersede
the earlier descriptions of unimplemented components; the earlier runs remain
historical evidence.

| Check | Result | Log |
|---|---|---|
| Owner refusal/read-reference and Restraint unit suites | 51 passed across 4 suites | `/private/tmp/run-e-refused-readback-unit.log` |
| Owner readback and Restraint real database suites | 51 passed across 2 suites, zero skips | `/private/tmp/run-e-refused-readback-integration.log` |
| Model/worker/provider contracts | 75 passed across 8 suites | `/private/tmp/run-e-model-worker-unit.log` |
| Refusal completion and updated prompt | 19 passed | `/private/tmp/run-e-completion-unit-green.log` |
| Full relevant turn-worker real database suite | 29 passed | `/private/tmp/run-e-turn-worker-db-green.log` |
| Restore UI and routes | 82 passed across 7 suites | `/private/tmp/run-e-restore-ui-final.log` |
| Added refusal/timeline reload and strict request checks | 24 passed across 2 suites | `/private/tmp/run-e-ui-reload-origin-contract.log` |
| Root Apply/proposals/provenance unit checks | 37 passed across 3 suites | `/private/tmp/run-e-root-apply-proposals-unit.log` |
| Repository lint | Passed | `/private/tmp/run-e-integrated-lint.log` |

Completion tests prove lost-fence suppression, actual SQL-error rollback after
Restore insertion, mixed proposal indices, distinct durable refusal subjects,
and concurrent turn submission. Refusal timestamps use the existing writer's
transaction-time sentinel because sending a returned JavaScript Date loses
PostgreSQL microseconds; the database asserts exact equality with completed_at.

Restore integration exposed two product corrections before the full gate:
timeline cursor values now bind as text before casting to timestamptz, avoiding
Postgres.js Date serialization of infinity and microseconds; malformed source
receipts now return invalid_source through a locked minimal evidence read,
instead of throwing while rendering the historical source card. The real RED
malformed-receipt trace is in `/private/tmp/run-e-restore-integration-races.log`.
The remaining race and malformed-source reruns are pending at this record.

Read-only migration preflight at 2026-09-15T01:06Z found the same eight existing
refusal CHECK definitions on staging and production; neither has the two new
Operator lanes yet. Raw introspection is retained at
`/private/tmp/run-e-refusal-constraints-before.json`. No E remote write occurred.

The corrected Restore suite passed all 15 real database cases in
`/private/tmp/run-e-restore-integration-corrected.log`. Six additional contention
cases passed in `/private/tmp/run-e-restore-locking-final.log`: both directions
against real voice Apply, policy Apply and location archive, with PostgreSQL
blocker evidence. Two final worker-to-GET cases passed in
`/private/tmp/run-e-worker-refusal-get-green.log` (28 unrelated tests skipped).
The latter uses mocked model classification and does not claim that the live
model has been tested. The first rerun found a missing actor field during root's
row-builder cleanup; it was restored explicitly before these green results.
All promised test titles are present. Full integrated gate and deployed browser
verification remain outstanding.
