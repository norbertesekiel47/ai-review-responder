# Deviations — fix/1301-migration-guard-execution

Every entry is something the intake or plan did not anticipate. Step 6 reads
this file end to end and records a one-line **Verdict:** ACCEPT or RE-PLAN per
entry before any review agent is dispatched.

---

## D1 — one promised test title claimed an assertion the pattern cannot make

**When:** step 3, during the design pass, before any code was written.

**What the intake said.** `tests_to_add` carried
`re-applying 051 restores the guarded indexes and check constraints after they
are dropped`.

**Why it is wrong.** Migration 051's `CHECK` constraints on `source`,
`severity` and `status` are declared inside its `CREATE TABLE IF NOT EXISTS`.
The table already exists at head, so a verbatim re-apply skips that statement
entirely. A degrade that dropped those constraints could never be repaired by
re-applying the file, and the case would fail for a reason that is not a
regression.

**What changed.** The title is now
`re-applying 051 restores the guarded indexes after they are dropped`.
Both intake copies were updated and `.feature/state.json` re-recorded the
arming copy's hash.

**Class.** A `tests_to_add` retitle. Not a surface amendment — the edit surface
did not move, so the amendment counter was not incremented.

**Generalised into the plan.** The same limit applies to 048, 051 and 117: a
verbatim re-apply restores indexes, row security and `GRANT`/`REVOKE`, never
the `CREATE TABLE` body. Each suite states its own limit in its header, the way
`migration-119-job-outbox-rls.integration.test.ts` states its two.

**Verdict:** ACCEPT

---

## D2 — the local PostgreSQL 17 container was added beside the 16 container, not swapped for it

**When:** step 2, setup.

**What the intake implied.** The owner chose "recreate the local test container
on postgres:17", which reads as replacing the existing container.

**What the container actually held.** `repworth-testdb-recovery-20260914`
(postgres:16, port 5499) serves seven databases — `test`, `test_ws4`,
`test_629`, `test_1010`, `test_1011`, `test_1012`, `test_ws5` — for other
worktrees, including the in-flight `fix/batch-e-screens-vs-runtime`. Replacing
it would have broken their gates.

**What was done instead.** A second container `repworth-testdb-pg17`
(postgres:17.11, port 5500, database `test_1301`) runs alongside it. This
worktree's `.env.local` points at it; the previous value is kept at
`.env.local.pg16-backup`. The 16 container is untouched and still serving.
`pnpm test:db:setup` provisioned the new database to head with zero `ERROR:`
or `FATAL:` lines, and migration 122's post-apply MAINTAIN query returns 0.

**Class.** An environment decision that made the owner's choice safe. Strictly
less destructive than what was approved.

**Verdict:** ACCEPT

---

## D3 — the test-line estimate grew 1.8× during plan review, before any code

**When:** step 3, across plan review rounds 1 to 3.

**What changed.** `estimated_test_lines` went 1,250 → 1,700 → 2,100 → 2,250,
and `tests_to_add` went 37 → 51 → 55 → 58. `estimated_prod_lines` did not move.

**Why.** Every increase came from an accepted review finding, not from scope
creep. The three largest:

- **F4** — the self-comparison oracle is circular on a freshly provisioned
  database, so every suite gained a second oracle of pinned literals.
- **F1, across all three rounds** — the vacuity check needed to be per named
  object, with exact-name matching, and with a second polarity for degrades
  that add rather than remove.
- **F10** — 051 needed a real four-table fixture chain, because a row count is
  vacuous on an empty table.

**Why this is recorded rather than acted on.** The re-classification trigger in
step 5 fires when an **actual** bucket exceeds ~2× its estimate. Estimates
moving during review is the review working. The trigger is now measured against
2,250, and if the implemented tests exceed roughly 4,500 lines the run returns
to step 0 with real numbers.

The size axis was re-checked against `execution-lanes.md` § Classification and
stays `standard`: still eight tracers, still one tight surface, no new risk
domain. Nothing here makes it an epic.

**Class.** Estimate correction driven by review findings. Not a surface
amendment; the surface moved once, separately, and is counted as amendment 1.

**Verdict:** ACCEPT
