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

## D2 — the "hold a generation transaction open" concurrency test is deliberately not written

**When:** plan review round 1 (finding 4).
**What:** codex asked for a test that holds the generation transaction after it
takes the advisory/batch locks, starts an approval, then commits generation.
**Why not:** generation is **not a single transaction** — `persistChildRender`
(`ask-generation.ts:705`) opens its own `sql.begin` per child — so there is no
transaction to hold and the test would be staging a fiction. The
refuse-then-succeed pair across a genuinely committed render pins the real
contract: readiness is evaluated against the committed row set, inside the
approval transaction, under the batch lock.

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
