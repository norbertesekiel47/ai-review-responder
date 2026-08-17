# Deviations — #629 owner approval lane

Entries the plan did not anticipate, or intake corrections. Read end to end
before review (step 6); every entry gets an ACCEPT / RE-PLAN verdict there.

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
