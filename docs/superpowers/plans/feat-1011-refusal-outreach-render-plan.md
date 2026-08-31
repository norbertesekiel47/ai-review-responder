# Plan — #1011, the `outreach_withheld` render lane (four writers)

Slice 4 of 7 on map #994. Four write sites, one file, one reason enum. Intake:
`docs/superpowers/plans/feat-1011-refusal-outreach-render-intake.json`.

## §0 What is already decided, and what this plan may not re-open

| Decision | Owner |
|---|---|
| `occurredAt` is the app-supplied `renderedAt`, never the transaction sentinel | ticket #1011 |
| Subject is the outreach id the render mints; a regeneration's replacement is a DISTINCT subject | #1001 |
| One helper owns the whole `refusal_events` statement | #1001 |
| `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES` — three codes, no `null` | #994 harvest, landed by PR #1034 |
| The lane is FOUR writers, not one — any rollout sliced by lane under-counts by exactly these | #997 resolution 2 |

**A correction to the ticket's stated rationale, recorded because the conclusion
survives it and the reasoning does not.** The ticket says transaction time here
is "persist time, seconds after the decision", implying `renderedAt` is closer to
the decision. It is not. `renderedAt` is minted by `toInsertInput`
(`src/lib/solicitation/ask-generation.ts:663`), and `persistChildRender` calls
that INSIDE its own `sql.begin` (`:733-735`). So `renderedAt` is persist time
too — and it is NOT close to `NOW()` either, because `NOW()` freezes at
transaction START while `renderedAt` is minted after the per-Business advisory
lock has been waited on. The two diverge by exactly that wait.

**AND THE PLAN'S OWN FIRST ANSWER WAS ALSO WRONG — round 1 rejected the framing
as a false choice, and the owner took its option.** This section is the
corrected version; the superseded reasoning is recorded in §8 R1-1.

The false-choice draft argued: keep `renderedAt` because it gives exact equality
with the immutable `solicitation_outreach.rendered_at`, and accept that both are
persist time. It also claimed the gap was "within milliseconds of `NOW()`".
**That claim is false when the advisory lock blocks:** `NOW()` freezes at
transaction START, while `renderedAt` is minted AFTER the lock wait, so the two
diverge by exactly the wait.

**The decided design gets both properties.** Capture the timestamp IMMEDIATELY
AFTER the render decision and BEFORE the transaction opens or waits, then pass
that same `Date` instance to BOTH writes:

| Writer | Where the clock is read |
|---|---|
| W1 `persistChildRender` | after `generateChildRender` returns, before `sql.begin` |
| W2 `settleBudgetStop` | when the budget exception decides the remaining rows |
| W3 `regenerateAsk` | after `generateChildRender` returns |
| W4 `settleGenerationExhaustion` | before its settlement transaction opens |

`refusal_events.occurred_at` still equals `solicitation_outreach.rendered_at`
exactly — one `Date`, two columns — and now BOTH are decision time rather than
persist time.

**This changes what `rendered_at` records, and that is a real consequence, not a
detail.** The column is `NOT NULL`, never updated, and read elsewhere — the
dispatch replay path among them. **Before moving the value, the implementer
audits every reader of `solicitation_outreach.rendered_at`** and records the
audit in the deviations file. If any reader depends on it meaning persist time,
STOP and raise it; do not adapt the reader.

**Consequence for the implementer:** the timestamp is a parameter or a local,
NOT a new field on `ChildRenderOutcome`. Round 1 was explicit that the outcome
type does not need to carry it.

## §0.1 Precedent — read these before the first edit

* `src/lib/auto-approval/suspension.ts` — the #1009 call-site precedent, and the
  only Refusal write site on `main`. Copy its SHAPE.
* `src/lib/refusals/write.ts` — `writeRefusalEvent` and its per-lane union. Read
  the header in full.
* `src/lib/refusals/vocabulary.ts` — `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES`.
  Note the DISPATCH map beside it is a different constant for the same
  `refusal_source`; this lane must not touch it (#1010 owns it).
* `src/lib/solicitation/outreach.ts` — `insertOutreachRender`, the insert every
  write here accompanies, and the owner of `RenderWithholdReason`.

## §0.2 The four writers, and what each one needs

All four are in `src/lib/solicitation/ask-generation.ts`, all transactional.

| # | Writer | Anchor | Insert |
|---|---|---|---|
| W1 | `persistChildRender` | `:700` | `:733` |
| W2 | `settleBudgetStop` | `:821` | via the shared path |
| W3 | `regenerateAsk` | `:1325` | `:1490` |
| W4 | `settleGenerationExhaustion` | `:1602` | `:1682` |

**Round 1 correction: there are THREE physical ledger calls, not four.** W2
reuses W1's persist path. The four WRITERS remain four — that is #997's count and
the reason this ticket exists — but the call sites are three.

**Establish W1 first, then add the private helper.** Round 1 told this plan to
COMMIT rather than defer, and it is committed: the three call sites share one
small private function inside `ask-generation.ts` taking
`(tx, ctx, outreachId, reason, decidedAt)`. Three repeated nine-field objects,
each carrying timestamp, category, subject and tenant invariants, is past the
"no abstraction before the second use" line — and the alternative round 1 named
is a full cross-writer matrix test, which is more code and weaker evidence.

**Do NOT reach for a new module or a seam.** `src/lib/refusals/write.ts` states
there is no `RefusalLedger` interface and nothing varies across call sites. A
private function in `ask-generation.ts` is the whole abstraction this lane adds.

## §1 T1 — the eval (RED phase, first task)

**Every** `tests_to_add` title as a FAILING test, VERBATIM. No `.todo`, no
`.skip`, no `.fails`.

**`.feature/intake.json` is the authority for that list and this plan never
restates its length.** An earlier draft said "fourteen"; round 2 grew it to
twenty-three, and a stale number here is exactly how an implementer stops nine
tests early. Count the array; do not trust prose.

* Unit seam: `src/lib/solicitation/__tests__/ask-generation.test.ts`.
* Live-DB seam: `ask-generation.integration.test.ts` and
  `outreach-render.integration.test.ts` — both exist. The `*.integration.test.ts`
  name selects vitest's serialized project. **Add no run-time DDL of your own** —
  note that `outreach-render.integration.test.ts` already runs
  `CREATE OR REPLACE FUNCTION auth.uid()` inside a rollback probe; that is
  sanctioned and allowlisted, and it is not a licence for more (round 1 caught
  an earlier blanket claim that the suite ran none).

Evidence: every title in `tests_to_add` present and RED — the gate's
`promised-tests` row is what checks this, and it reads the intake, not this plan.

**Tracer-to-title mapping for round 1's additions.** The slow-lock title and the
forced-clock-advance title go to **T2**, with the `refusal_code` =
`disposition_reason` title; the W4-per-hole, the two regeneration titles and the
cross-writer shape matrix to **T3**; the two extra guard titles to **T4**; the
per-writer rollback pair and the zero-rows kill-switch title to **T5**.

## §2 T2 — W1 records a Refusal, and establishes the shape

**Behavior:** a withheld child render writes one Refusal against the outreach id
it just minted, in the same transaction as the outreach insert.

`persistChildRender` already has everything but the clock: `ctx` carries the
account and location, the outcome carries `dispositionReason`, and
`insertOutreachRender` returns the id.

**The timestamp is the whole discipline, and §0's decided design moves it.** Read
the clock where `generateChildRender` RETURNS — before `persistChildRender` opens
its transaction and before it waits on the advisory lock — pass that `Date` into
`persistChildRender`, and let it reach BOTH `toInsertInput` and the ledger call.
`toInsertInput` stops minting the value and starts receiving it. Reusing the
`Date` `toInsertInput` builds today would rebuild the post-lock timestamp round 1
rejected.

* **Test seam:** the batch generation entry point — which reaches W1 and W2
  ONLY. `regenerateAsk` and `settleGenerationExhaustion` are separate exported
  entry points and need their own fixtures (round 1, R1-10).
* **Turns green:** `a withheld child render writes one refusal_events row
  against the outreach id` · `a successful child render writes no refusal_events
  row` · `every render-lane refusal_events row carries occurred_at equal to the
  solicitation_outreach rendered_at of the same insert` · `the render lane maps
  render_failed and lint_failed to below_our_bar and moderation_high to
  unsafe_content` · `every render-lane refusal_events row carries subject_type
  solicitation_outreach and the account and location of the generation context`.
* **Blocking edges:** T1.
* **Evidence:** the `rendered_at` equality is live-DB and compares two COLUMNS in
  SQL, not two JS values. Reading either back through postgres.js truncates
  microseconds (#520) and would make an unequal pair look equal.

## §3 T3 — W2, W3 and W4 follow W1

**Behavior:** every path that settles an outreach as withheld records it. The
lane is four writers; three of them are the ones a lane-shaped rollout misses.

* **W2 `settleBudgetStop`** may settle SEVERAL outreach rows in one call. One
  Refusal per outreach, each with its own subject id — never one per call.
* **W3 `regenerateAsk`** mints a REPLACEMENT outreach row with a new id, and
  writes a Refusal ONLY when that replacement is withheld — it inserts a
  replacement for a successful render too. **The row it replaces has no Refusal
  to keep:** regeneration requires the current row to be `rendered`, both before
  and inside the swap, and a rendered row was never withheld. Round 1 killed the
  earlier "keeps its own Refusal" claim as a state the code forbids.
* **W4 `settleGenerationExhaustion`** writes `render_failed` for the holes it
  settles. **One Refusal per HOLE, not one per invocation and not one per
  attempt** — it selects and loops over holes, so a one-hole fixture cannot tell
  the two apart (round 1, R1-2).

* **Turns green:** `a budget stop writes one refusal_events row per outreach it
  settles as withheld` · `a generation exhaustion writes one refusal_events row
  per outreach hole it settles as withheld` · `a regenerated ask writes its
  refusal_events row against the replacement outreach id` · `a successful
  regenerated ask writes no refusal_events row for its rendered replacement` ·
  `a withheld regeneration writes no refusal_events row against the rendered
  outreach it replaces` · `all four render writers carry the paired outreach's
  tenant category subject and occurred_at shape`.
* **Blocking edges:** T2 — its shape is the precedent these three copy.
* **Evidence:** W2's case seeds MORE THAN ONE outreach and asserts one row per
  id. A single-row fixture cannot tell "one per outreach" from "one per call",
  which is the exact defect this tracer exists to prevent.

## §4 T4 — the paths that write nothing

**Behavior:** where no outreach row is inserted, no Refusal exists either.

Two guards precede every insert in `persistChildRender`: the outbox
ownership CAS, and the lifecycle re-check that refuses anything but `built`.
Both return before the insert, so neither can leave a Refusal behind.

* **Turns green:** `a stale outbox attempt writes neither an outreach row nor a
  refusal_events row` · `a batch halted during the LLM round trip writes neither
  an outreach row nor a refusal_events row`.
* **Blocking edges:** T2.
* **Evidence:** assert both COUNTS are zero. The second case is the one the
  revalidation ladder exists for — a halt that commits while the LLM call is in
  flight — so drive it by halting the batch between the generate and the persist.

## §5 T5 — failure and the kill switch

* A ledger failure aborts the persist transaction, so the outreach row does not
  exist either and the outbox attempt is retried. No `try/catch` at any of the
  four call sites.
* `REFUSAL_LEDGER_ENABLED=false` leaves all four writers byte-identical.

* **Turns green:** `a ledger failure rolls back the outreach render insert it
  accompanies` · `every writer still persists its render when
  REFUSAL_LEDGER_ENABLED is false`.
* **Evidence:** force the failure through a real constraint violation, not a
  mocked rejection. **Precedent:
  `src/lib/auto-approval/__tests__/suspension.integration.test.ts`** — its forced
  constraint-violation rollback case AND the success-then-rollback twin beside
  it, which is the only case that proves a SUCCESSFUL ledger row shares the
  caller's transaction. (Round 1 caught an earlier citation of
  `src/lib/refusals/__tests__/write.integration.test.ts`, which carries no such
  case.)

## §6 T6 — the documentation sweep

`docs/directory.md`'s `ask-generation.ts` row gains the four write sites and the
`renderedAt` rule. One row; no new file.

## §7 What this plan deliberately does not do

* No touch to `commitWithhold` in `dispatch.ts` — that is #1010's site, same
  `refusal_source`, different enum.
* No touch to `src/lib/refusals/**`. This lane consumes the helper as shipped.
* No new decision timestamp threaded through `ChildRenderOutcome`.
* No change to WHICH renders are withheld or why.
* No new PRODUCTION file, and no new test file — all three test seams exist.
  **The deviations file `docs/superpowers/plans/feat-1011-refusal-outreach-render-deviations.md`
  is expected and is not an exception to this:** §0 requires the
  `solicitation_outreach.rendered_at` reader audit to be recorded there, and the
  intake's `docs/superpowers/plans/**` glob covers it. Round 2 caught the
  contradiction between those two instructions.

## §8 Review appendix — round 1 (plan-skeptic, codex, read-only)

**VERDICT: REVISE.** Twelve findings, six HIGH. All accepted. This was the
sharpest of the three rounds: it rejected the plan's central argument, and the
owner took its alternative.

### R1-1 HIGH — the timestamp was a FALSE CHOICE, and the plan's own claim was wrong

Recorded in full in §0. Two errors: "within milliseconds of `NOW()`" is false
under a contended advisory lock, and the two-option framing missed the option
that gets both properties. **Owner decision: capture the clock after the render
decision and before the transaction, pass one `Date` to both writes.** The
reader audit of `solicitation_outreach.rendered_at` is an implementation
obligation, recorded in §0.

The locked title that exposes the wrong implementation appeared in NO "turns
green" list — it is now attached to T2.

### R1-2 HIGH — W4 settles MANY holes; the promised test covered one

`settleGenerationExhaustion` selects and loops over holes. A wrong
implementation writing one Refusal per INVOCATION passes a one-hole fixture.
Only W2 had a multi-row requirement.

**Replaces** `a generation exhaustion writes one refusal_events row for the outreach it withholds, not one per attempt`
**with:** `a generation exhaustion writes one refusal_events row per outreach hole it settles as withheld`

### R1-3 HIGH — W3 inserts replacements for RENDERED outcomes too

The successful-render negative test was W1-shaped. `regenerateAsk` inserts a
replacement whether the new render succeeded or was withheld, so an
unconditional W3 ledger call passes every promised regeneration test as long as
the fixtures use withheld replacements.

**Added:** `a successful regenerated ask writes no refusal_events row for its rendered replacement`

### R1-4 HIGH — the kill-switch test never asserted an empty ledger

"Still persists its render" is satisfied by a writer that bypasses the helper
with a raw insert. The point of the flag is that NO row is written.

**Added:** `REFUSAL_LEDGER_ENABLED=false writes zero refusal_events rows across all four render writers`

### R1-5 HIGH — one W1 rollback fixture does not cover W3 or W4

W3's swap transaction and W4's hole-fill transaction are separate. A CHECK
failure also cannot prove that a SUCCESSFUL row shares the caller's transaction —
that needs the success-then-rollback twin.

**Added:** `a ledger failure at each of persistChildRender, regenerateAsk, and settleGenerationExhaustion rolls back the outreach insert it accompanies`
**Added:** `a refusal written by each render writer does not survive a later rollback of its outreach transaction`

### R1-6 HIGH — the regeneration-history test asserted an impossible state

The plan promised that a regeneration "leaves the replaced outreach row's own
refusal_events row untouched". Regeneration REQUIRES the old row to be
`rendered`, both before and inside the swap — and a rendered row has no
render-lane Refusal. The old title could only be made green by seeding a state
the code forbids, and `ON CONFLICT DO NOTHING` would then hide a wrong extra
write against the old id.

**Replaces** `a regenerated ask leaves the replaced outreach row's own refusal_events row untouched`
**with:** `a withheld regeneration writes no refusal_events row against the rendered outreach it replaces`

### R1-7 MEDIUM — both zero-write tests exercised W1 only

W3 and W4 have independent ownership and lifecycle guards. A Refusal placed
before either passes the promised tests.

**Added:** `a regeneration rejected by swap revalidation writes neither a replacement outreach row nor a refusal_events row`
**Added:** `a stale generation-exhaustion attempt writes neither outreach hole rows nor refusal_events rows`

### R1-8 MEDIUM — the category test does not pin `refusal_code`

`WriteRefusalEventInput` accepts any string for the code, so a valid-but-wrong
reason keeps the expected category and passes. The shape test was W1-only.

**Added:** `every render-lane refusal_events row carries refusal_source outreach_withheld and refusal_code equal to its solicitation_outreach disposition_reason`
**Added:** `all four render writers carry the paired outreach's tenant category subject and occurred_at shape`

### R1-9 MEDIUM — column equality does not prove the timestamp was REUSED

Comparing the two columns correctly avoids postgres.js truncation, but two
separate `new Date()` calls in the same millisecond compare equal too. Under the
new §0 design this matters more, not less.

**Added:** `a forced clock advance between outreach insertion and refusal writing cannot change occurred_at from the outreach rendered_at`

### R1-10 MEDIUM — the test seam cannot reach all four writers

The intake claimed the batch generation entry point reaches all four. It reaches
W1 and W2; `regenerateAsk` and `settleGenerationExhaustion` are separate exported
entry points needing their own fixtures. Corrected in the intake — a broad "every
writer" title over a seam that reaches half of them is trivially satisfiable.

### R1-11 MEDIUM — the forced-failure precedent was the wrong file

§5 cited `src/lib/refusals/__tests__/write.integration.test.ts`, which carries no
forced `23514` case. **The real precedent is
`src/lib/auto-approval/__tests__/suspension.integration.test.ts`** — its
constraint-violation rollback case and the success-then-rollback twin beside it.
Corrected in §5, and carried to the other two slices, which cited the same wrong
file.

### R1-12 LOW — the "no run-time DDL" claim is inaccurate

`outreach-render.integration.test.ts` runs `CREATE OR REPLACE FUNCTION auth.uid()`
inside a rollback probe. It is sanctioned and allowlisted; the plan's blanket
description was wrong. Corrected in §1.
