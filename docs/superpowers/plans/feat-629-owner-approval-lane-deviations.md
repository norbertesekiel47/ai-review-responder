# Deviations — #629 owner approval lane

Entries the plan did not anticipate, or intake corrections. Read end to end
before review (step 6); every entry gets an ACCEPT / RE-PLAN verdict there.

---

## Step 6 read-back — verdicts (2026-08-17)

All ten entries read end to end. **No entry invalidates a locked decision, so no
RE-PLAN and no abort criteria triggered.** Review agents receive this triaged
file.

| # | One-line verdict |
|---|---|
| D1 | **ACCEPT** — four test titles added/retitled from round-1 findings; surface unchanged, so not an amendment. |
| D2 | **ACCEPT** — round-1 reasoning was wrong and is recorded as overturned rather than deleted. The test it restored then caught a real defect (the plan's own sketch was vacuously green), which is the strongest possible argument the entry was right. |
| D3 | **ACCEPT, with a live constraint attached** — the closest call in the file. B2 post-approval regeneration means "byte-for-byte" is *conditional*, and that is a headline guarantee. Accepted only because the path has no owner entry point today (unreachable in the shipped surface) and the owner deferred the regenerate ticket explicitly. **The constraint is binding on that ticket**: a post-approval regenerate must re-open approval for the superseded ask or be refused once `approved_at` is set. Now also recorded in the `CONTEXT.md` **Owner approval** term, so it survives this file. |
| D4 | **ACCEPT** — plan-prose defect only; the Step-body test specs are the contract and all 33 titles shipped. |
| D5 | **ACCEPT** — safety fix. Unwrapped DROP+ADD could have left `solicitation_outreach` with no status/reason constraint at all; resulting constraint byte-identical. |
| D6 | **ACCEPT** — both cases are the plan being less specific than the repo, not contradicted. The `LOCAL-ONLY` half is load-bearing: without it D5 would have been blocked by the immutability guard. |
| D7 | **ACCEPT** — owner-decided. No behaviour change (same 11 tests pass before and after), and it avoided committing a false "deliberately cross-tenant" claim to the allowlist. |
| D8 | **ACCEPT** — owner-approved surface amendment #1 of 2. The lock analysis is the substance and matches two existing carve-outs in the same lane. |
| D9 | **ACCEPT** — owner-decided. The halt coverage gap it exposed was a genuine defect: the destructive verb was the less-tested one. |
| D10 | **ACCEPT** — environment, not code. Contains a deliberately recorded wrong diagnosis (the `lock_timeout` theory) because the misdiagnosis is the reusable lesson. |

**One thing a reviewer should look at hardest:** D3. Everything else is either a
correction or an owner decision; D3 is the only entry that leaves a real
conditional inside a guarantee this feature advertises.

---

## D1 — `tests_to_add` grew by three titles and one retitle (owner-approved, not a surface amendment)

**When:** plan review round 1, before any implementation.
**What:** the intake's `tests_to_add` changed in both copies (`.feature/intake.json`
and the committed `docs/superpowers/plans/` audit copy):

- Added `refuses a stale exclusion list without cancelling any row or approving the batch`
- Added `approves the rendered subset when another send ask is withheld`
- Added `treats a superseded attempt as ready only once its replacement exists`
- Retitled `shows the approve control only when every ask has rendered` →
  `…only when every ask has an attempt`

**Why:** all four come from round-1 findings (1, 2, 3). The retitle is a
correctness fix, not cosmetics: readiness admits a `withheld` attempt, so the
old title asserted something the design deliberately does not do.

**Classification:** `allowed_edit_surface` is unchanged, so per the workflow this
is a deviations-file entry and does **not** count toward the two-amendment abort
budget.

---

## D2 — the interleaving concurrency test IS written (my round-1 reasoning was wrong)

**When:** raised in plan review round 1 (finding 4); **my dismissal of it was
overturned in round 2.**

**What I first wrote, and why it was wrong:** I argued the "hold a generation
transaction open across the approval" test could not be written because
"generation is not a single transaction, so there is nothing to hold." The
premise is true and the conclusion does not follow. `persistChildRender`
(`ask-generation.ts:714`) opens a **per-child** `sql.begin` that takes the
advisory batch lock and the batch row lock and holds both across its insert.
That per-child transaction is exactly the thing to hold. I had read this code
while writing D2's own evidence note below and still drew the wrong conclusion
from it.

**Resolution:** the test is in the plan (Task 3, `blocks approval on the batch
lock until an in-flight render commits, then counts it`). It uses a second
postgres.js connection to hold the lock, asserts the approval has NOT settled
while it is held, then asserts it counts the committed render. That proves
serialization; the refuse-then-succeed pair alone does not.

**Verified while writing this entry, and it strengthens the design:**
`persistChildRender` takes the same advisory batch lock, re-reads the batch
`FOR UPDATE`, and **refuses to insert unless `deriveBatchState(batch) === 'built'`**
(returns `{ kind: 'stopped', state }`). So the whole-batch generation lane
already declines to add a render to an approved batch. The readiness gate in
`approveBatch` and this guard are two independent locks on the same door, taken
in the same order — neither is redundant, because readiness is what stops a
*premature* approval and this is what stops a *late* render.

---

## D3 — post-approval regeneration is a real gap in the byte-for-byte contract, scoped OUT of this ticket

**When:** plan review round 1 (finding 5).
**What:** amendment B2 permits per-ask regeneration of un-excluded `rendered`
rows *after* approval. Verified in code: `REGENERABLE_BATCH_STATES`
(`ask-generation.ts:1222`) is `{ built, approved, veto_window, sending }`, with a
doc comment naming B2 — #628 built this deliberately, it is not an oversight.
The swap then inserts `attempt_no + 1` and cancels the prior row `superseded`.
So approved bytes can in principle be replaced without a fresh approval
decision, and the guard that protects the whole-batch lane (`persistChildRender`
requiring state `built`, see D2) deliberately does **not** apply here.
**Why not fixed here:** no owner entry point enqueues a per-ask regenerate today
(#629 defers that surface with owner sign-off), so the path is unreachable in the
shipped product. Narrowing `regenerateAsk` would reopen a locked amendment,
which is not this ticket's call.
**Carried forward:** the deferred regenerate ticket must ship with one of —
(a) a post-approval regenerate re-opens approval for that ask, or (b) it is
refused once `approved_at` is set. Recorded in the plan's Architecture note so
the constraint is not lost with this file.

---

## D4 — the round-2 amendment left two stale counts in the prose around it (plan defect, found during execution)

**When:** step 4 (EXECUTION), after Task 1 committed, before Task 3 was dispatched.

**What:** round 2 added the test `blocks approval on the batch lock until an
in-flight render commits, then counts it` to the intake and to Task 3's Step 5
body. It did **not** update two pieces of surrounding prose that count the same
tests:

1. **Task 1 Step 2's stub list** (plan ~213–238) omits the new title, so the
   committed `approval.integration.test.ts` has 16 `it.todo`s, not 17. Verified:
   the title is absent from the stub file and present at `.feature/intake.json:91`.
2. **Task 3 Step 5** says "write the remaining **nine**" and **Step 6** says
   "Expected: **7** passing". The describe actually holds **eleven** titles.
3. **Task 4 Step 3** says "Expected: **13** passing, 0 todo" for the whole
   integration file. The correct total is **seventeen** (11 approveBatch +
   5 haltBatch + 1 tenant scope).

**The staleness is two rounds deep, not one.** 13 = 7 + 5 + 1 is the count from
*before* round 1, and 7 is the pre-round-1 approveBatch count. So neither the
round-1 amendment (which added three approveBatch titles) nor the round-2
amendment (which added one) updated any of these running totals. Every
"Expected: N passing" line in the plan is therefore suspect on sight; the
authoritative source is the intake's `tests_to_add` (**33** titles, counted from
the file) and the per-test specifications in the Step bodies, never a total in
prose. The 33 distribute as: 3 in `approval.test.ts`, 17 in
`approval.integration.test.ts` (11 + 5 + 1), 6 in `approval-routes.test.ts`,
5 in `approval-panel.test.tsx`, 2 in `batch-view.test.ts`. Note that
`reports the derived batch state and approval readiness on the built batch view`
is one title asserted in two places by design (Task 1 over the pure function,
Task 5 over the live read model), so file counts sum to 33 without it being
double-counted in the intake.

**Why it matters:** an agent that trusts Step 6 stops at 7 green and reports the
task done, leaving up to four promised tests unwritten. The verify gate's
`promised-tests` row matches the intake file-wide, so the miss would surface —
but at the gate, after the commit, not during the task.

**Resolution:** no plan edit and no intake change. The counts are prose, the test
bodies in Step 5 are the contract, and all eleven are specified there. Task 3's
brief carries the corrected count (**11**, not 7) and names the missing todo
explicitly. The end state is unchanged: Task 3 writes the interleaving test as a
real `it(...)`, so the stub file's omission never reaches the gate.

**Classification:** plan-internal inconsistency, not a scope change.
`allowed_edit_surface` and `tests_to_add` are both untouched, so this does not
count toward the two-amendment abort budget.

---

## D5 — migration 108's SQL amended: wrapped in one transaction with a `lock_timeout` (safety defect in the plan's literal SQL)

**When:** step 4 (EXECUTION), after Task 2 committed `56075ac4`. Raised by the
Task 2 agent, which wrote the plan's SQL verbatim rather than amend a locked
plan unilaterally — the right call. Verified and fixed by the orchestrator.

**What the plan specified:** a bare `ALTER TABLE … DROP CONSTRAINT` followed by
a bare `ALTER TABLE … ADD CONSTRAINT`, with no `BEGIN`/`COMMIT` and no
`lock_timeout`.

**Why that is wrong, not merely unidiomatic — two independent failure modes:**

1. **psql autocommits each statement.** A DROP that succeeds followed by an ADD
   that fails leaves `solicitation_outreach` with *no* status/reason constraint
   at all. The table's entire disposition domain would be silently gone, and
   `disposition_reason` is a bare `TEXT` column with no other constraint
   governing it (confirmed: no other migration in 001–107 constrains it), so
   nothing else would catch a bad write.
2. **No lock bound.** `ALTER TABLE` takes ACCESS EXCLUSIVE. Without
   `lock_timeout` the acquisition can queue behind a long Supavisor session and
   stall every reader of the table for the duration.

**Repo precedent is unambiguous, and the plan simply missed it:** `101` and
`106` set `lock_timeout = '5s'`; `105` — the *same* drop-then-re-add-a-superset
shape — wraps in `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;`. The
`new-migration` skill mandates a lock timeout for any `ALTER TABLE`.

**Applied:** 108 now opens `BEGIN; SET LOCAL lock_timeout = '3s';` and closes
`COMMIT;`, matching 105. **The resulting constraint is byte-for-byte unchanged** —
this is purely about how it is applied. Re-verified by rebuilding the local test
DB from scratch: all 108 migrations apply clean, and the live constraint carries
`owner_excluded`.

**Why this was editable at all:** 108 carries the **LOCAL-ONLY** marker in
`migrations-log.md`, which is what keeps `migration-immutability-guard.sh` from
freezing it (see D6). Had Task 2 omitted that marker, this fix would have been
blocked.

**Classification:** safety fix inside `allowed_edit_surface`
(`supabase/migrations/108_*.sql`), no scope change, no intake change. Does not
count toward the amendment budget.

---

## D6 — two repo conventions the plan did not name; Task 2 followed the convention over the plan text (both correct)

**When:** step 4 (EXECUTION), Task 2.

**1. `schema-ready.ts` placement.** The plan said append "after
`MIGRATION_099_SOLICITATION_POSTAL_ADDRESS`". 099 is no longer last — 100, 104
and 105 follow it, and the `SchemaRequirement` block is kept in ascending
migration order. Task 2 appended after `MIGRATION_105_CHECKOUT_ATTEMPT_COUPON`,
the true end of that block. This satisfies both "append" and the file's
ordering; following the plan literally would have broken the ordering.

**2. The `LOCAL-ONLY` marker.** The plan said leave the "APPLIED TO STAGING"
line blank until Task 8. `migrations-log.md` lines 7–15 make something stronger
a hard convention: an unpromoted entry MUST carry **LOCAL-ONLY**, and that
marker is precisely what keeps `migration-immutability-guard.sh` from freezing
the file. Omitting it would have made 108 immutable the moment head was bumped —
blocking Task 8's promotion edit *and* blocking D5's fix. Task 2 added it with a
pending STAGING/PRODUCTION line instructing Task 8 to remove it.

**Verdict:** ACCEPT both. Neither changes behaviour or scope; each is the plan
being less specific than the repo, not the plan being contradicted.

---

## D7 — the plan's literal SQL cannot pass `ci:tenant-scope`; both queries reshaped in `approval.ts` and `batch-view.ts` (owner-decided)

**When:** step 4 (EXECUTION), after Tasks 3 and 5 landed. Hit independently by
both agents, in their own files, for the same underlying reason.

**The audit's actual rule:** `scripts/ci/tenant-scope-audit.ts` calls
`stripSelectSubqueries` (line 44) to blank every parenthesised `SELECT` *before*
reading predicates, and `splitTopLevelAnd` (line 170) skips anything at paren
depth > 0. **A scope predicate inside a subquery is therefore invisible to it.**
The audit cannot distinguish a correctly-scoped nested query from an unscoped
one — it reports the table as unscoped either way.

**What the plan specified:** scope keys inside a scalar subquery
(`lockBatchForAction`'s `agent_runs` lookup) and inside a `NOT EXISTS`
(`approveBatch`'s readiness query, and the analogous pair in Task 5's Step-3
read-model SQL). All four statements were genuinely scoped on both
`account_id` and `business_id` — verified by reading the SQL — so these were
**false positives, not tenant leaks**.

**Two ways out, and why one was rejected.** The allowlist
(`scripts/ci/tenant-scope-allowlist.ts` + `ALLOWLIST_BASELINE`) is the only other
mechanism — there is no per-line pragma. It was rejected on two grounds: the
file sits OUTSIDE `allowed_edit_surface`, so it would have cost a surface
amendment; and an allowlist entry asserts "deliberately cross-tenant", which
would have been **a false statement committed to the repo** about queries that
are correctly scoped.

**Applied (owner decision, 2026-08-16):** reshape so the keys are top-level.

- `batch-view.ts` (Task 5, in-task): the two scalar subqueries became three
  `LEFT JOIN`s carrying the tenant keys, with
  `COUNT(DISTINCT …) FILTER (WHERE o.id IS NULL)`. Verified against real
  Postgres including the row-multiplication case (4 asks × 3 moderation rows →
  `pendingRenders: 2, moderationWithheld: 3`).
- `approval.ts` (orchestrator, after the fact):
  1. `lockBatchForAction` split into **two statements** — the `FOR UPDATE OF b`
     batch read, then the `agent_runs` parent lookup. Lock order is unchanged
     and still batch → run (B11); the correlated `r.subject_id = b.id::text`
     became `r.subject_id = ${batchId}`, equivalent because the row above
     already proved that id belongs to this tenant.
  2. The readiness `NOT EXISTS` became an **anti-join** — `LEFT JOIN … ON`
     carrying every former subquery condition verbatim, plus `o.id IS NULL`,
     with `COUNT(DISTINCT a.id)`.

**Verified after the change:** `pnpm typecheck` clean; `pnpm ci:tenant-scope`
**passed with the baseline untouched at 392** (no allowlist entry, no amendment);
`approval.integration.test.ts` 11 passed / 6 todo — the same 11 that passed
before the reshape, so behaviour is unchanged.

**Why the inline comments matter:** both reshapes look like gratuitous
complexity to a reader who does not know the audit's parsing rule. Each site now
carries a comment saying why it is shaped that way and not to re-nest it.
Without that, the next simplification pass silently reintroduces a CI failure.

**Classification:** stays inside `allowed_edit_surface`. No intake change, no
surface amendment, no behaviour change. Does not count toward the abort budget.

---

## D8 — SURFACE AMENDMENT #1 of 2: `approval.ts` registered in the spine lock-order guard (owner-approved)

**When:** step 4 (EXECUTION), at the first full (non-docs) verify gate, after
Task 4. Every gate row passed except `test`.

**What failed:** `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`, two
assertions. It enforces the global lock order
`reviews → businesses → child rows → agent_runs` by requiring every file that
calls `recordStep`/`recordOutcome`/`completeRun` to be registered there.
`approval.ts` calls `recordStep` in both verbs, so it tripped as an unreviewed
new caller.

**Why an amendment was unavoidable.** The intake's `allowed_edit_surface` did not
list `src/lib/approval/**`. There is no way to satisfy the guard from inside the
surface: the `CALLER_ALLOWLIST` membership check can only be answered in that
test file, and the alternative — making `approval.ts` take a reviews lock so it
satisfies the pairing check — would introduce exactly the cross-lane lock the
carve-out exists to avoid. The plan mandated the `recordStep` calls (they are the
immutable record D9 requires, and are named in the intake's `observability`), so
this is the surface contract being incomplete, not the scope growing.

**The lock analysis, which is the substance of the entry.** `approval.ts` is the
third file in the solicitation send-batch lane and rests on the identical
argument as `outreach.ts` (#624) and `ask-generation.ts` (#628):

- Lock order is per-business advisory lock → `solicitation_batches` row
  `FOR UPDATE` → spine. Batch → run, the SAME single order the two existing
  carve-outs rest on, so no ABBA pair exists against either.
- Both verbs route through one helper, `lockBatchForAction`, which takes the
  advisory lock and the batch row lock **before** any `agent_runs` read or write.
  Every run-spine call in the file — `recordStep`, and `closeBatchIfSettled`
  which terminalizes — happens strictly after that.
- `reviews` is never touched. The subject is a `solicitation_batch`, and the only
  `agent_runs` row either verb reads or writes is that batch's own send parent.
- It INSERTs no `agent_runs`/`agent_outcomes` row. ~~As with `outreach.ts` the
  step INSERT's implicit FK `FOR KEY SHARE` lands on the run row the transaction
  already holds~~ — **struck 2026-08-17, round-1 standards review: that sentence
  was copied from `outreach.ts` and is FALSE here.** `approval.ts` holds no
  `agent_runs` lock of its own, so `recordStep`'s own `SELECT … FOR UPDATE` is
  the transaction's *first* lock on the send parent, and the FK `FOR KEY SHARE`
  lands on a row `recordStep` just took. The conclusion survives — that lock is
  taken strictly after both batch locks, so batch → run holds *a fortiori* — but
  the premise did not, and a carve-out justified by an untrue statement is
  worthless. Corrected at all three sites: `approval.ts`'s header, the
  `outcome-anchor-pairing.test.ts` carve-out comment, and here. No
  `businesses`/`accounts` parent-row lock is taken at all.

**One property the other two entries do not share,** recorded in the carve-out
comment: `approval.ts` is reached from HTTP routes rather than a worker, making
it the lane's only user-latency-bearing caller of the advisory lock. That affects
blocking *time*, not lock *order*, and order is what the carve-out governs — but
it is the thing to look at first if the Requests screen ever feels slow under a
concurrent generation run.

**Applied:** `approval.ts` added to `CALLER_ALLOWLIST` and to
`NON_REVIEW_SUBJECT_CALLERS`, with the analysis above as a carve-out comment
matching the two precedents. A third assertion pins the carve-out set's exact
contents — a deliberate "update this consciously" guard — and was updated too.
Guard suite: 4 passed.

**Both intake copies amended in the same change** (`.feature/intake.json` and the
committed audit copy), verified byte-identical afterwards.

**Budget: this is amendment 1 of 2. One remains** for Tasks 6, 7 and 8.

---

## D9 — two refactors after Task 8, driven by `ci:fallow:coverage` (owner-decided)

**When:** after all eight tasks landed and the gate was green. `ci:fallow:coverage`
is **advisory, not a required status check** — `ci.yml` says so in as many words
("It can go red but is NOT a required status check"). An earlier note in this
run called it "the real PR gate"; that was wrong and is corrected here.

**What it found, and what each finding turned out to be:**

| Finding | Verdict |
|---|---|
| `ApprovalPanel.halt` — CRAP 30, **0% tested** | real test gap |
| `haltHandler` 21% / `readBatchId` **0% tested** | real test gap |
| `VETO_WINDOW_MINUTES_OWNER` exported, no consumers | real |
| 3 clone groups / 131 lines across the three batch routes | real, architectural |
| `ApprovalPanel` cognitive complexity 19 | real, architectural |

**The halt coverage gap was the substantive one.** Approve had five route tests;
halt had only its refusal paths, so its success path, result mapping and body
parsing were entirely unasserted — the *destructive* verb was the less-tested
one. The tests added for it also pin the security rule at both layers: the panel
POST body must be exactly `{batchId}`, and the route must pass exactly four keys
to `haltBatch`. A `reason` key appearing in either is what would let a client
dictate whether the audit trail says email had already left.

**Owner chose to clear both architectural findings** rather than record them as
debt. Neither cost an amendment — `reviewed/route.ts` is already inside
`src/app/api/dashboard/solicitation/**`, which an earlier note in this run
mis-stated as outside the surface.

1. **Shared route runner** — `batch/_shared/scoped-batch-route.ts` exporting
   `withScopedBatch`. Not an invented shape: the repo already owns this policy
   one directory over in `withScopedContact`, and the new seam mirrors its
   signature. Config is 4 fields, none boolean.
   **The hazard here was real and was avoided:** the three routes do NOT share a
   flag gate — `reviewed` is watch-only, `approve`/`halt` are watch AND send.
   Collapsing them would have 404'd `reviewed` for every existing watch-mode
   customer, since `SOLICITATION_SEND_ENABLED` is unset in every environment
   today. The gate is bound per route as a **function reference**, and the
   regression is pinned by a test that stubs the send flag explicitly off. That
   test was proven load-bearing by mutation: binding the send gate to `reviewed`
   flips it and three siblings to 404.
2. **Panel split** — `AskList.tsx` + `ApprovalActions.tsx`.
   **The hazard here was the redaction guarantee**, which a split is exactly how
   you lose: `toRows` both filters `redacted` attempts and projects survivors
   onto three fields, and a child "needing a bit more data" would undo it.
   Verified independently after the fact: `toRows` remains the only consumer of
   an `AskAttemptView`, `AskList.tsx`'s reference is a type-only indexed access
   (`AskAttemptView['deliveryStatus']`), and no `subject`/`body`/
   `interpolationInputs` read exists in any of the three files.

**Result:** fallow reports `dead code 0 · complexity 0 · duplication 0`.
Duplication went 131 lines → 0; `ApprovalPanel` cognitive 19 → below threshold,
cyclomatic 13 → 7, length 164 → 80.

---

## D10 — the shared local test database silently deleted migration 108, twice, mid-run

**When:** during the D9 refactors. Two agents reported live-DB failures
(`violates check constraint "solicitation_outreach_status_reason_consistency"`).

**Root cause — worth promoting to lab notes after merge, since this file dies
with the branch.** Seven worktrees share ONE local test database
(`localhost:5499/test_ws4`). Only this branch carries migration **108**; every
other branch is at 107. `pnpm test:db:setup` rebuilds the database from **the
running branch's** `supabase/migrations/`, so an agent running it from any
107-head worktree silently reverts the shared database and breaks this branch's
live-DB suites — with an error that looks like a code defect in `approval.ts`.

**A wrong diagnosis is recorded here on purpose.** The orchestrator first blamed
the `lock_timeout` added in D5, theorising that a concurrent lock made 108's
`ALTER TABLE` time out and abort the provisioning script. That was speculation,
never verified, and it was wrong. The correct diagnosis came from checking every
worktree's migration head. The lesson generalises: *"the DB is in a state my
branch didn't put it in"* has a mundane multi-worktree explanation far more often
than an exotic locking one.

**Why it matters beyond the annoyance:** it silently invalidates evidence. One
agent reported `ci:fallow:coverage` green while the coverage feeding it was
produced against the reverted database; CRAP is computed from coverage, so a
"0% tested" finding there measured the harness, not the code. Any live-DB result
taken while the database is reverted must be discarded, not interpreted.

**Fix applied (owner decision):** this worktree now uses its **own** database,
`test_629`, created in the same container. `test_ws4` is left at 107 for the
other six worktrees, so nothing else is disturbed.

**How it is wired, and why not via `.env.local`:** the edit-surface guard
correctly refuses `.env.local` (not in the contract), and amending the contract
for a local config file would have spent the last amendment on something that is
not code. Instead every command exports `TEST_DATABASE_POOL_URL` explicitly,
which overrides `resolveTestDatabaseUrl()`'s `.env.local` fallback. **A resumed
session MUST export it too** — the handoff doc carries the value, because
without the export this branch silently falls back to the shared `test_ws4` and
its live-DB suites fail against a 107 schema.

**Verified after isolation:** verify gate GREEN 27/27, `pnpm test:coverage`
963 files / 12,356 tests passed with **zero** failures, `ci:fallow:coverage`
`✓ No issues in 36 changed files`. The three failures seen before isolation were
entirely the race.
