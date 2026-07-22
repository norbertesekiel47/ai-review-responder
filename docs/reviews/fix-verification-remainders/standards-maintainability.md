# Standards & Maintainability Review — fix/verification-remainders

- **Branch**: `fix/verification-remainders` (fork point: `main` @ eaf4f3f2)
- **Reviewer lens**: thermo-nuclear-code-quality-review skill + repo standards
  (`.claude/rules/repworth.md`, `.claude/rules/engineering.md`,
  `.claude/rules/design.md`, `.claude/CLAUDE.md`)
- **Date**: 2026-07-20

## Scope reviewed

`git diff main...HEAD`: migration 082 (`supabase/migrations/082_failover_lookup_indexes.sql`)
+ its integration test, `assertSummedLlmWorkerSlots` in
`worker/config/startup-assert.ts` + unit tests + the registration-site call in
`worker/index.ts`, and the doc/glossary sync (CONTEXT.md, ADR 0005 amendment,
migrations-log 082 entry, handoff/plan/intake artifacts).

## Verdict

**Approve with two medium findings.** No structural regression, no file-size
violation (worker/index.ts at 801 lines, startup-assert.ts at 408), no
spaghetti growth — the branch *deletes* a duplicated inventory comment and
replaces it with a pointer to the enforcing function, which is the correct
single-owner move. The two findings below are real but neither blocks: one is
a fifth verbatim copy of test boilerplate, one is a residual comment-guarded
fact of exactly the drift class this branch exists to fix.

## Findings (>=80% confidence)

### F1 (Medium) — fifth verbatim copy of the migration-test DB-guard harness

`src/lib/shared/__tests__/migration-082-failover-indexes.integration.test.ts:19-47`

`assertLocalMigrationDatabaseUrl` + `afterLocalMigrationDatabaseGuard` +
`sql()` (~30 lines) are copy-pasted verbatim from the 079 test. This is now the
**fifth** copy — identical blocks live in the 076, 077, 078, 079, and now 082
migration tests. Standards violated: engineering.md ("When the same fact
appears in multiple artifacts, choose one owner"), repworth.md ("Reuse the
existing canonical helper instead of introducing a near-duplicate"). The
"wait for the second concrete use" bar was passed three copies ago.

**Remedy**: extract the localhost-guarded `postgres()` connector into
`src/__tests__/helpers/` beside `describe-with-db.ts` (e.g.
`connectLocalMigrationDb(testDatabaseUrl)`), and have the 082 test (at
minimum; ideally all five in a follow-up) use it. This also dissolves the
sub-issue that `afterLocalMigrationDatabaseGuard` is a one-caller pass-through
higher-order wrapper (`connect(assert(url))`) whose name obscures what it does
— repworth.md: "Before adding an abstraction for a single caller, don't."
(Inherited from the 079 precedent, so charged to the copy, not this author's
design — but this branch was the moment to stop the spread.)

### F2 (Medium) — LLM-queue inventory membership is still guarded only by a comment

`worker/index.ts:290` ("grep runLlmTask callers before editing this list —
generate_demo was missed once (#490)") and the hand-maintained six-entry array
at `worker/index.ts:291-298`.

The *cap* is now boot-enforced (good), but the *membership* of the list — the
fact "queue X reaches `runLlmTask`" — remains a manual mirror of the call
graph, protected only by a grep instruction in a comment. That is exactly the
failure mode this branch fixes: #490 was an inventory omission, and a future
LLM-calling queue whose author skips the comment escapes the cap silently,
with no test or assert failing. Standard violated: engineering.md trigger
"When hidden assumptions live only in comments, caller folklore, or tribal
setup steps, move them into code, contracts, tests, or checked configuration."

**Remedy** (either):
1. A unit test asserting the assert-site list equals the set of queues whose
   registered handlers transitively reach `runLlmTask` (a static
   grep-the-import-graph test, in the spirit of `eslint-boundaries.test.ts` /
   `model-pinning.test.ts`); or
2. Move the `llm: true` marker into the queue registry (`worker/queues.ts` or
   `QUEUE_NAMES` metadata) so registration and cap-membership are declared in
   one place and the assert input is derived, not restated.

Not a blocker for this PR (the grill explicitly settled on comment-only for
the adjacent backfill decision, and the enforced cap already fails boot on
any *concurrency* edit to the six known queues), but it should be a named
follow-up, not folklore.

## Checks that passed (explicitly verified)

- **Single owner for the cap constant**: `SUMMED_LLM_WORKER_SLOT_CAP = 9` and
  `FLAG_GATED_LLM_WORKER_SLOT_CAP = 1` live only in
  `worker/config/startup-assert.ts:115-116`. The old worker/index.ts comment
  that restated the full inventory + cap is **deleted** and replaced with a
  pointer ("owned + enforced by assertSummedLlmWorkerSlots") — correct
  single-owner hygiene. The ADR 0005 amendment restates the sum breakdown, but
  as a dated decision record that is the ADR's job, not a duplication.
- **Deep-module discipline**: `assertSummedLlmWorkerSlots` keeps the
  startup-assert surface small — one function, one entries array, an optional
  `flagGated` marker that models a real domain distinction (two separate caps),
  not a mode flag. Error messages carry the full inventory, the sum, the cap,
  and the ADR trigger — diagnosable at boot without opening the file. Reads
  EFFECTIVE `worker.opts` at the registration site, same pattern as
  `assertSingleConcurrencyWorker`. Nothing shallow or pass-through here.
- **Glossary terms used verbatim**: "worker-slot cap" (startup-assert docstring,
  worker/index.ts comment, error message, CONTEXT.md, ADR amendment),
  "pacing cap" + "guarded single-consumer invariant" (zernioBackfill comment,
  worker/index.ts:201-203), "sanctioned unguarded lane" (startup-assert
  docstring scope note, CONTEXT.md). No renamed concepts found.
- **Migration 082 style vs precedents**: header matches the 065 template
  (CONCURRENTLY non-transactional warning + Supabase single-transaction-box
  instruction), incorporates the 062 INVALID-index lesson with a concrete
  `pg_index.indisvalid` check + `DROP INDEX CONCURRENTLY` recovery — an
  *improvement* on 065's terser recovery note. Per-index comments cite the
  exact consumer query and the 018 mirror, matching 018/065 house style.
  Migrations-log entry follows the 080/081 format (newest-first placement,
  `- **082** — ...`, non-transactional + lockstep + recovery notes; head/next
  counters updated).
- **Test placement + assertions**: 082 integration test lives beside its
  074/078/079 siblings in `src/lib/shared/__tests__/`, asserts
  `indisvalid`/`indisready` (which the 079 precedent did not — a hardening,
  directly encoding the 062 lesson), and the startup-assert unit tests cover
  pass-at-9, fail-at-10, undefined-concurrency-defaults-to-1, flag-gated
  pass/fail, and the drift scenario (5→6 edit).
- **No spaghetti/branching growth**: the only change to a shared flow is one
  assert call after the last LLM worker registration, mirroring the existing
  `assertSingleConcurrencyWorker` pattern. No new conditionals in job paths.
- **Comment discipline**: new comments are why-comments (pacing-cap vs
  single-consumer rationale, scope note on the demo fan-out lane, the #490
  provenance). None restate code.

## Code-judo opportunities considered and rejected

- *Derive the assert input from a queue-registry flag now* — considered as F2
  remedy 2; not demanded in this PR because it would touch `worker/queues.ts`'s
  registry shape for six entries mid-hardening-branch; a follow-up does it
  calmly.
- *Fold the flag-gated check into the sum with a conditional* — worse: the two
  caps are genuinely different contracts (sum budget vs per-entry ceiling);
  merging them would need a mode flag inside the loop. Current shape is the
  simpler model.
- *Single generic `assertConcurrency` absorbing `assertSingleConcurrencyWorker`*
  — rejected: the two guards mean different things ("double-running corrupts
  state" vs "budget"), and the branch's own pacing-cap comment exists precisely
  to keep that distinction legible.

## Low-confidence appendix (opinions, <80% — not in the findings table)

- **IF NOT EXISTS vs 062's fail-loud choice**: 062 deliberately omitted
  `IF NOT EXISTS` so a re-run over an INVALID index fails loudly; 082 follows
  065's `IF NOT EXISTS` + documented `indisvalid` check instead. Defensible
  here (perf-only indexes, and the two-statement non-atomic file makes
  convenient re-run after a statement-2 failure genuinely useful), but the
  house now carries two contradictory precedents for the same hazard; a
  one-line note in migrations-log.md picking the default rule would close it.
- **CONTEXT.md hardcodes "≤9"**: the glossary restates the constant's value;
  if the cap changes, the glossary drifts. It does name the owning function,
  so it traces — acceptable for a glossary, but the "(≤**9**;
  boot-enforced by …)" phrasing invites staleness.
- **Error-message duplication**: the "Per ADR 0005, raising the sum past ~10…"
  sentence appears in both throw sites in `assertSummedLlmWorkerSlots`;
  trivially extractable, not worth churn.
- **Docstring inventory echo**: the startup-assert docstring's "five of the
  six LLM workers register with bare workerOpts" is a point-in-time fact that
  can silently go stale; the enforced list is the truth.

---
## Triage (orchestrator, 2026-07-20)
- Harness duplication (migration-082 test): ACCEPTED-DEFERRED — real single-owner violation, but extraction touches 4 out-of-surface test files (076/077/078/079); follow-up cleanup ticket, not this branch (small-diff bias; new test followed the 079 precedent as instructed).
- Inventory membership comment-only: REJECTED for this branch — same class as adversarial finding 1; LLM-boundness is not statically derivable, mitigations shipped (assert + maintenance comment + ADR ~10 trigger); logged as candidate future ci: contract audit.
