# feat-860 — deviations

Entries are things the plan did not anticipate. Each is read back end to end at
step 6 and given an ACCEPT / RE-PLAN verdict before any review agent sees it.

---

## D1 — surface overlap with `codex/859-tenant-scope-subqueries` (owner-decided at step 2)

**When:** step 2 (SETUP), reported by `scripts/feature-setup.sh`.

**What:** `feat-860`'s surface glob `src/lib/solicitation/*` overlaps two armed
worktrees. Only one overlap is real:

| Worktree | Files | Real collision |
|---|---|---|
| `codex-858-close-batch-case` | `src/lib/solicitation/outreach.ts` | **No** — covered by the glob, absent from this feature's planned file set |
| `codex-861-requests-load-copy-test` | `requests-client.test.tsx` | **No** — one test file this feature does not touch |
| `codex-859-tenant-scope-subqueries` | `src/lib/solicitation/approval.ts`, `src/lib/solicitation/batch-view.ts` | **Yes** |

The #859 collision is not merely a shared filename. That ticket fixes the
`ci:tenant-scope` parser and **reverts the #629 workarounds in the exact
statements this feature extends**: it collapses `lockBatchForAction`'s
two-statement split back into one correlated form, and `approveBatch`'s
readiness anti-join back into `NOT EXISTS`. Verified in its working tree
(uncommitted, +265/−183 across `approval.ts`, `batch-view.ts` and their tests).

`lockBatchForAction`'s signature and return type are unchanged by #859, so
`requestAskRegeneration` calling it is unaffected. The genuine conflict surface
is the file-header prose and the SQL hunks themselves.

**Owner decision (step 2):** **merge order is `#859` before `#860`.** This
branch proceeds now rather than blocking on another session's uncommitted WIP,
and the plan sequences the `approval.ts` / `batch-view.ts` tickets **last**:

- If #859 has merged by the time those tickets run, rebase onto it and write the
  new statements in the post-fix convention.
- If it has not, write them in the scanner-shaped workaround form. #859 already
  reverts the #629 workarounds; reverting one more is marginal cost to that
  ticket and is the direction that keeps the security audit's proof intact.

Rejected alternative: `#860` first. It would force a tenant-isolation audit to
re-derive its proof over SQL that did not exist when it was written — putting
the cost on the security ticket.

**Also noted in:** `codex-859-tenant-scope-subqueries` deviations.

---

## D2 — surface amendment #1: `src/lib/agents/*` (owner-approved at step 3)

**When:** step 3 (PLAN), during the pre-plan risk sweep.

**What:** the `ask_regeneration_requested` run step needs its key registered in
`STEP_PERSONA` (`src/lib/agents/run-spine.ts`), because `AgentStepKey` is
`keyof typeof STEP_PERSONA` — an unregistered key is a tsc error, not a runtime
surprise. There is **no** DB CHECK on `agent_run_steps.step_key`, so this needs
no migration. Only two files in the repo reference `STEP_PERSONA`: `run-spine.ts`
and its own test.

**Owner decision:** amend `allowed_edit_surface` with `src/lib/agents/*`.
Applied to both intake copies (`.feature/intake.json` arming copy and the
committed audit copy), verified identical.

Rejected: reusing `ask_generated` (the worker writes a real one on the swap, so
the timeline would show two generations for one regenerate) and dropping the
step (reverses the step-1 actor decision and leaves an owner-triggered LLM spend
unattributable).

**Amendment count: 1 of 2.** A pre-plan sweep found no other out-of-surface file:
`docs/`, `CONTEXT.md` and `.feature/` are always-allowed by both matchers;
`queue-names.ts`, `job-outbox-helpers.ts`, `job-outbox-status.ts` and the auth
helpers are read-only imports; `worker/` needs no change because
`worker/jobs/solicitation-batch/generate.ts` already dispatches on `ask_id`.

---

## D3 — `job_outbox` is not a tenant table (finding, no action)

**When:** step 3 (PLAN), risk sweep.

**What:** `batch-view.ts`'s new in-flight regeneration read carries no
`account_id` / `business_id` predicate. That is correct, not an oversight:
`job_outbox` is absent from `scripts/ci/tenant-tables.ts`, so a statement
referencing only `job_outbox` is not audited by `ci:tenant-scope` and needs no
allowlist entry.

**Consequence for implementation:** the read must NOT join `solicitation_batches`
to "look scoped". Doing so would pull a tenant table into the statement, make it
auditable, and require scope keys on a query whose safety comes from elsewhere —
the caller already proved the batch belongs to the tenant via the scoped
lifecycle read, and `aggregate_id` is that same proven id. Write that reasoning
as a code comment so a reviewer does not read the absent keys as a defect.

---

## D4 — plan bookkeeping drift: stale counts and incomplete `Files:` lists (execution, no re-plan)

**When:** step 4 (EXECUTE), Tasks 1 and 2.

**What:** the plan's prose counts trail its own content, because revisions 1–3 grew
`tests_to_add` from 32 to 40 without re-counting the headings:

| Location | Says | Actually |
|---|---|---|
| Task 1 heading + Step 10 commit message | 32 tests | 40 |
| Task 1 Step 2 heading | six titles | eight |
| Task 1 Step 6 heading | eleven titles | thirteen |
| Task 1 `Files:` | six files | seven (`ask-generation.integration.test.ts` missing) |
| Task 2 `Files:` | five files | six (same file, for Step 5b) |

Task 1 Step 8's own arithmetic (31 + 9 = 40) and the listed titles are correct
throughout. **Only the prose counts are wrong**, so the contract never moved.

**Verdict: ACCEPT.** No intake field changed; no amendment spent. The executors
were told the correct count up front and committed 40. A resumed session should
trust `tests_to_add` and Step bodies over any heading count in this plan.

---

## D5 — `askRegenLimitResponse`, not `enforceAskRegenBudget` (the plan contradicts itself)

**When:** step 4 (EXECUTE), Task 3.

**What:** the plan's File-structure table says `dashboard-regen-rate-limit.ts`
"Gains `enforceAskRegenBudget`". Its Task 3 Step 3 body names
`askRegenLimitResponse` and gives the reason: a globally-keyed peek-and-refuse
placed *before* tenant validation lets an authenticated owner distinguish a
foreign ask id from an unknown one (codex round 1, finding 4). The intake's own
promised test `POST regenerate answers 404 for an over-budget ask belonging to
another tenant` pins that ordering.

**Shipped:** `askRegenLimitResponse(limit: number): NextResponse` — a response
**builder only**. It does not peek and does not decide. Task 4's route and
`requestAskRegeneration` own the ordering: validate tenant scope FIRST, then
budget.

**Verdict: ACCEPT** — the body wins over the table, because the body carries the
security argument and the table is a summary. Task 4 must call the shipped name.

---

## D6 — the peek log discriminator stays `'batch' | 'ask'`

**When:** step 4 (EXECUTE), Task 3.

**What:** Task 3 Step 2's primitive signature proposed `peek: 'review' | 'ask'`.
Renaming the live value would break
`src/lib/costs/__tests__/regen-budget-batch.test.ts:158`, which pins BOTH the
value `'batch'` and the exact four-key warn payload
(`event`, `peek`, `reason`, `subject_count`). That file is **outside this
feature's `allowed_edit_surface`**, so the rename would have cost an amendment
from a budget with 1 of 2 already spent.

Task 3 Step 1 exists precisely to discover this and branches on the answer. The
answer was yes. Shipped as `'batch' | 'ask'`; the review door keeps `'batch'`,
the new ask door emits `'ask'`; the pinned suite is still green.

**Verdict: ACCEPT.** No surface amendment spent.

---

## D7 — one `@ts-expect-error` marker, not two (binds Task 5)

**When:** step 4 (EXECUTE), Task 1.

**What:** Task 1 Step 7 widens the `sendLane()` fixture with two fields that
`SendLaneView` does not carry until Task 5, and prescribes marking "the two added
lines". TypeScript's excess-property check (TS2353) reports only the **first**
offending key, so a second marker on `regenBudgets` is itself an error —
TS2578, unused `@ts-expect-error` directive.

**Shipped:** exactly one marker, above `regeneratingAskId`; `regenBudgets: {}` is
unmarked.

**Consequence for Task 5:** Step 5 says "remove Task 1's markers". There is
**one** marker to remove, not two. Removing it is mandatory — once `SendLaneView`
carries both fields the directive becomes unused and TS2578 fails the typecheck
gate.

**Verdict: ACCEPT.**

---

## D8 — Task 2 Step 5b's snippet targeted the wrong helpers and the wrong window

**When:** step 4 (EXECUTE), Task 2.

**What:** two independent defects in one snippet.

1. **Wrong vocabulary.** `seedRenderedBatch`, `readOutreach(batchId)`, `userId()`
   and `seededOutboxHandle` belong to `approval.integration.test.ts`, not to
   `ask-generation.integration.test.ts`, whose real helpers are `seedSendAsk`,
   `seedRenderedAttempt`, `contactIdOfAsk`, `seedDispatchedOutboxRow`,
   `accountId()`, `tenant!.userId`.
2. **Wrong window — this one is load-bearing.** The snippet calls `approveBatch`
   *before* `regenerateAsk`. With approval already committed, `regenerateAsk`
   refuses at the **non-transactional pre-check** and never opens the swap
   transaction, so no row lock and no rollback is exercised — leaving codex
   round 1 finding 2 ("prove that Postgres row locks and rollback preserve the
   stored bytes") unaddressed by the very test written to address it. The plan's
   own inline comment states the opposite intent of its code.

**Shipped:** the comment's intent. `approveBatch` runs *inside* the `runLlmTask`
mock — the window decision 7 leaves open by design — so the pre-check
legitimately reads `built` and the **locked re-check under `FOR UPDATE`** is what
refuses. Mutation-checked: widening the predicate back to
`built || approved || veto_window` makes the test fail on the byte comparison,
then restored. It is a real oracle, not a tautology.

**Verdict: ACCEPT.** The test now proves what the review asked for.

---

## D9 — `git add -A` is unsafe while tasks run in parallel in one worktree

**When:** step 4 (EXECUTE), Tasks 2 and 3 running concurrently.

**What:** every task's commit step in this plan says `git add -A`. The task graph
runs 2 ∥ 3 and 4 ∥ 5 **in the same worktree**, so `-A` stages the sibling task's
half-written files. Task 3 committed while Task 2 had `ask-generation.ts` and its
test dirty; `-A` would have swept both into
`bb4ba74c` — a commit whose message claims only budget doors, carrying a
half-finished D3 narrowing.

Task 3 caught it and staged its three files explicitly. Task 2's work survived
intact and landed as `d5dcf153`.

**Consequence for Tasks 4 and 5:** both dispatch prompts forbid `git add -A` and
require explicit per-file staging. The same applies to any future resumed session
that runs two tasks of this plan at once.

**Verdict: ACCEPT** — a plan-wide instruction defect, worked around per-task
rather than by editing six commit steps.
