# Standards & Maintainability — #1082 exhaustion-refusal batch

**Review skill run:** `thermo-nuclear-code-quality-review` (loaded and followed; no fallback needed).

**Range:** `b9fb9601..4f39fbd2` (merge-base `b9fb96016cc025c151f17db4b39baf165cb80a13`, HEAD `4f39fbd26e51e46bea1a45d8e6069d576c756021`). HEAD was not moved; nothing fetched, rebased, staged or committed.

**Surface:** `src/lib/solicitation/ask-generation.ts` (+70/−17, measured 27 code / 40 comment / 3 blank added), the two `__tests__` siblings, and feature paperwork (intake, plan, deviations, `arch-review-log.md`).

**Verdict:** the change itself is right — the loop-to-set conversion is correct, it stays inside `sql.begin`, the empty case is delegated rather than re-spelled, and the abort test guards the one hazard the move creates. What does not clear the bar is the *prose*: the branch's central quantitative claim is wrong by 200×, one pre-existing docblock was falsified by this very commit and left standing, and a 12-line test mechanism is defended by a claim no test can check. There is also one visible code-judo move that deletes a whole function and dissolves the stale docblock with it.

---

## Findings (≥80% confidence)

| # | Severity | Location | Finding |
|---|---|---|---|
| F1 | high | `src/lib/solicitation/ask-generation.ts:1862` | The perf comment cites the wrong bound: `holes` is capped at `BATCH_CAP = 25`, not `MAX_DATA_ROWS` 5,000 — the ticket's whole quantitative rationale is 200× too large. |
| F2 | medium | `src/lib/solicitation/ask-generation.ts:652-656` | `recordOutreachWithheldRefusal`'s docblock still enumerates three call sites and "four writers, three call sites"; this commit removed one and left the docblock false. |
| F3 | medium | `src/lib/solicitation/ask-generation.ts:695-707` | `recordOutreachWithheldRefusal` is now a pure pass-through wrapper with two callers; deleting it collapses two functions and two docblocks into one and dissolves F2. |
| F4 | medium | `src/lib/solicitation/__tests__/ask-generation.test.ts:1244-1252` | The `invocationCallOrder` sort is defended as "LOAD-BEARING and not tidiness", but no test distinguishes it from plain concatenation — the mechanism has no oracle. |
| F5 | low | `src/lib/solicitation/ask-generation.ts:1858-1866` | The set-arm cost argument is now spelled a third time (after `write.ts:547-560` and `batch-builder.ts:655-663`); the third copy is the one that went wrong (F1). |

---

### F1 — [high] The comment's stated bound is wrong by 200×, and it is the ticket's entire justification

`src/lib/solicitation/ask-generation.ts:1858-1866`:

```
// … `holes` is bounded only by
// the batch, `loadCandidateWindow` bounds a batch at MAX_DATA_ROWS
// (5,000), and this transaction already holds the per-Business advisory
// lock AND the `solicitation_batches` row lock — so a write per iteration
// is that many sequential round trips with both locks held …
```

Measured, not reasoned:

- `holes` (ask-generation.ts:1825-1841) filters `ask.status = 'send'`.
- The **only** `INSERT INTO solicitation_asks` in the repo is `batch-builder.ts:615`, inside `commitAskDecisions`, fed by `evaluateBatch`.
- `evaluateBatch` (`restraint-policy.ts:436-466`) hard-caps `send` decisions at `BATCH_CAP`, re-labelling the overflow `velocity_banked`. `BATCH_CAP = 25` (`restraint-policy.ts:87`).
- No statement anywhere `UPDATE`s `solicitation_asks.status` — the only `UPDATE solicitation_asks` is `batch-builder.ts:721`, which sets `agent_run_id`.

So `holes.length ≤ 25`, hard. `MAX_DATA_ROWS` / `loadCandidateWindow` bounds the **candidate window** — the cohort the batch *evaluates* — which is exactly why `write.ts:550-552` cites it correctly for the `ask_withheld` lane, where every candidate can be withheld. `batch-builder.ts:413-414` says this in its own words: *"`evaluateBatch` counts only `send` decisions against BATCH_CAP, so a withheld candidate has never consumed a slot."* The `send` lane does not inherit the candidate-window bound; the comment borrowed the constant along with the sentence.

Real numbers: up to 24 round trips removed, not 4,999.

**Concrete failure scenario.** The filed follow-up is "batch `insertOutreachRender` too". A later pass sizing that decision reads this comment, believes the loop can reach 5,000 iterations with the advisory lock held, and either over-invests in a second batching change or uses the same figure to argue for widening `ci:pool-fanout` to `src/lib/solicitation/`. The `arch-review-log` row's own honest framing — *"the win is 2N → N+1 round trips"* — is a much weaker argument at N ≤ 25 than at N ≤ 5,000, and that difference is exactly what the wrong constant hides.

The same false claim appears in two more places inside this diff:

- `src/lib/solicitation/__tests__/ask-generation.test.ts:1581-1583` — *"`loadCandidateWindow` bounds a batch at MAX_DATA_ROWS = 5,000"*, in the docblock of the ticket's headline test.
- `docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-intake.json` → `user_visible_behavior[0]` — *"At the lane's documented ceiling of 5,000 asks that removes up to 4,999 sequential round trips from the advisory-lock window."*

**Fix.** Cite `BATCH_CAP` (`src/lib/solicitation/restraint-policy.ts`) and state the bound by symbol, not by number — `holes ≤ BATCH_CAP` because `evaluateBatch` caps `send` decisions and no writer mutates `solicitation_asks.status` afterwards. The locks half of the sentence is correct as written and verified (`acquireSolicitationBatchLock` → `pg_advisory_xact_lock(hashtext('solicitation_batch_' || businessId))` at `batch-builder.ts:222-227`, and the `FOR UPDATE` on `solicitation_batches` at ask-generation.ts:1810-1816).

This is the same defect class the checklist already accepted twice on this wave (*"Three counting claims are wrong"*, *"The shipped comment's false-green arithmetic is wrong"*), with a sharper edge: here the wrong number *is* the ticket's stated reason to exist.

---

### F2 — [medium] The commit that removed the third call site left the docblock claiming three

`src/lib/solicitation/ask-generation.ts:646-707`, unchanged by this diff:

```
 * PRIVATE, AND SHARED BY THE LANE'S THREE PHYSICAL CALL SITES —
 * `persistChildRender` (which `settleBudgetStop` also settles through),
 * `regenerateAsk`'s swap, and `settleGenerationExhaustion`'s hole fill. Four
 * WRITERS, three call sites. The alternative was three repeated nine-field
 * objects each restating the lane, the category lookup, the subject pair and
 * both tenant columns, which is past the "no abstraction before the second
 * use" line …
```

At the fork point that was true — `git grep` at `b9fb9601` shows call sites at `:832`, `:1632`, `:1851`. At HEAD there are two: `:866` (W1/W2) and `:1666` (W3). `settleGenerationExhaustion` now reaches the shape through `outreachWithheldRefusalInput` and `writeRefusalEvents`; it does not call this function at all.

Both halves of the docblock's rationale are now wrong:

1. The enumeration names a call site that no longer exists, and the count "three call sites" is off by one.
2. The justification defends the function against "three repeated nine-field objects" — but the nine-field object moved to `outreachWithheldRefusalInput` at :731-748. This function no longer spells a single one of those fields.

The intake's invariant *"`recordOutreachWithheldRefusal` keeps its docblock as the lane's mapping contract"* was honoured literally — the docblock was kept verbatim — which is how the enumeration survived a change that invalidated it. Keeping a contract is not the same as keeping a census.

**Named standard.** `.claude/CLAUDE.md` § Working rules: *"When deleting a doc or ticking a checklist item, fix its audit tick and grep the filename to clean every cross-reference in the same change."* The same duty applies to a call-site census inside a docblock, and the checklist's accepted precedent is explicit that *"the commit that writes the citation is the commit that moves the target"* is the recurring mechanism on this wave.

**Fix.** Two call sites, three writers (W1/W2 share :866, W3 is :1666), and a fourth writer that reaches the shape through the builder — or, better, F3.

---

### F3 — [medium] `recordOutreachWithheldRefusal` is now a pass-through; deleting it is the code-judo move

At HEAD the function is:

```ts
async function recordOutreachWithheldRefusal(
  tx: TransactionSql,
  ids: { accountId: string; businessId: string },
  outreachId: string,
  reason: RenderWithholdReason,
  decidedAt: Date,
): Promise<void> {
  await writeRefusalEvent(
    tx,
    outreachWithheldRefusalInput(ids, outreachId, reason, decidedAt),
  );
}
```

Its parameter list is `tx` plus `outreachWithheldRefusalInput`'s parameter list, verbatim and in order. It adds no branch, no default, no error handling, no naming. It is a pass-through.

**Answering the question the brief asked directly (target 1):** `outreachWithheldRefusalInput` *is* the right seam. It has two genuine callers, it is the single reader of `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES` in the module (verified by grep: `ask-generation.ts:62` import, `:743` sole use), and it is what makes the mapping un-driftable across the two arms. That is a real deepening, not line-moving. The problem is what it left behind: the *outer* layer stopped earning its keep the moment the inner one existed. Two functions, two docblocks totalling ~50 comment lines, describing one nine-field object — with the contract attached to the wrapper and the object attached to the builder. A reader now has to hold both to know either.

**Proposed restructuring (behaviour-identical):**

1. Delete `recordOutreachWithheldRefusal`.
2. At `:866` and `:1666`, write `await writeRefusalEvent(tx, outreachWithheldRefusalInput(ctx, outreachId, outcome.dispositionReason, decidedAt));` — both sites already sit inside `if (outcome.status === 'withheld')` blocks, so the call shape is unchanged in every respect except the function name.
3. Move the surviving contract docblock (the `@param` semantics for `reason`/`decidedAt`, the dispatch.ts cross-reference, the never-try/catch rule) onto `outreachWithheldRefusalInput`, where the fields it describes actually live, and rewrite the census as "three physical call sites, one per arm plus the exhaustion loop".

Net: one fewer function, one fewer docblock, the mapping and its contract in one place, and F2 dissolves rather than being patched. Skill rule 4 is explicit — *"Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity"* — and the preferred remedy is *"Delete a whole layer of indirection rather than polishing it."*

The intake's non-goal *"Do not add a private set-arm wrapper in ask-generation.ts. It would have one caller, which the repo working rules ban"* is respected by this proposal; it removes a wrapper rather than adding one, and the edit stays inside `allowed_edit_surface`.

**Counter-argument, stated fairly:** the wrapper saves a nested call expression at two sites and keeps `writeRefusalEvent` out of the render lane's body. That is worth about two lines of nesting, against a duplicated contract and a docblock that has already gone stale once in a single commit.

---

### F4 — [medium] The `invocationCallOrder` sort is defended by a claim no test can check

`src/lib/solicitation/__tests__/ask-generation.test.ts:1244-1252`:

```
 * `invocationCallOrder` IS THE MECHANISM AND NOT A DETAIL. Vitest records
 * calls per mock, so concatenating the two arms would order by arm — and
 * the matrix test below pairs `refusalCalls()[i]` with `withheld[i]`
 * positionally … Arm order would mis-pair every row the moment a second
 * arm appears.
```

The same claim is re-published in `.claude/reference/arch-review-log.md:1513` (d): *"sorts on `invocationCallOrder`, which is LOAD-BEARING and not tidiness … Arm order mis-pairs every row the moment a second arm exists."*

A second arm exists now. It does not mis-pair. Enumerated every consumer:

| Consumer | Arms exercised |
|---|---|
| `:1376`, `:1386`, `:1402`, `:1413` (`runSingleChild`) | single only |
| `:1435` (`runBudgetStop`) | single only |
| `:1463`, `:1483` — the four-writer matrix at `:1443` | **both** |
| `:1506` (`runSingleChild`) | single only |
| `:1597`, `:1598` (`runExhaustion(3)`) | set only |
| `:1621` (`runExhaustion(0)`) | set only |

The one test that mixes arms runs them in the order W1 (`runSingleChild`) → W2 (`runBudgetStop`, 2 rows) → W3 (`runRegeneration`) → W4 (`runExhaustion(2)`, 2 rows) — `:1450-1456`. The set-arm calls are already **last**. `[...single, ...set]` therefore yields `[W1, W2a, W2b, W3, W4a, W4b]`, byte-identical to the sorted result. Delete the comparator and the entire suite stays green.

**Concrete failure scenario.** The comparator, the `!` non-null assertions on two `invocationCallOrder[index]` lookups, and the `order`/`inputs` intermediate objects are twelve lines of unexercised machinery in a test oracle. If a later Vitest upgrade changes `invocationCallOrder` semantics, or a refactor breaks the comparator, nothing turns red — while both the test docblock and the permanent architecture ledger tell the next reader the mechanism is proven. That is the checklist's accepted class verbatim: *"the shipped comment's stated condition is incomplete"* and *"a comment that names the wrong widening mechanism teaches the next reader to test the wrong thing."*

**Fix — either one, not both:**

- **Give it an oracle.** Add one ordering to the matrix test (or a new case) where the set arm fires *before* a single-row arm — e.g. `runExhaustion(1)` then `runSingleChild()` — and assert the flattened subject ids are in chronological rather than arm order. That single reordering makes the comparator's deletion a red test.
- **Or drop the sort** and say plainly that concatenation is order-correct today because the set arm is a single trailing call in every mixed test, with a note that a future mixed ordering needs the comparator back. Then correct the `arch-review-log` row, which currently asserts a property of this branch's own tests that is false.

Answering target 3 directly: `refusalCalls()` is **not** doing too much to be trustworthy in what it computes — flattening the set arm is the right call, and the ticket test at `:1591` correctly pins the *call* count (`toHaveBeenCalledTimes(1)`) separately from the *row* count, so the flatten cannot mask a writer that looped. The trust problem is narrower and real: one of its two mechanisms is unexercised and is documented as proven.

---

### F5 — [low] Third copy of one argument; the third copy is the one that went wrong

The set-arm cost rationale now exists in three places:

- `src/lib/refusals/write.ts:547-560` — the arm's own "WHY THIS ARM EXISTS": `MAX_DATA_ROWS` (5,000), advisory lock + batch row lock, `src/lib/db/admission.ts` chokepoint. Correct for the `ask_withheld` lane it describes.
- `src/lib/solicitation/batch-builder.ts:655-663` — the precedent call site: "ONE STATEMENT FOR THE WHOLE SET, deliberately. A build can propose up to MAX_DATA_ROWS (5,000) … so a loop over the single-row helper would hold both across 5,000 sequential round trips."
- `src/lib/solicitation/ask-generation.ts:1858-1866` — this diff, near-verbatim, with the constant carried across into a lane where it does not hold.

Three copies of one argument is how one copy goes wrong, and F1 is that copy. The house style in this area is heavy commenting, and that is not the objection — the objection is that this particular paragraph is restating a rationale `writeRefusalEvents`' own docblock already owns rather than saying what is *local* to this lane.

**Fix.** Keep the two local facts (the `BATCH_CAP` bound per F1; the two locks this transaction actually holds, both verified) and defer the rest to `writeRefusalEvents`' contract by reference.

---

## Checked and clean

Verified against the diff, no finding:

- **Naming vs `CONTEXT.md` LOCKED terms (target 5).** `outreachWithheldRefusalInput`, `refusals`, `refusalCalls`, `expectNoRefusalWrite`, `refusalSource: 'outreach_withheld'`, and the stored-category read all use **Refusal**, **Refusal category** and **Refusal source** in their locked senses. No drift. The invariant "a Refusal is RECORDED, never re-derived" holds — the builder reads the stored map and the lane writes it once.
- **Refusal-ledger invariants.** No new `INSERT INTO refusal_events`: `write.ts` remains the table's only writer (grep-confirmed). The write stays inside `sql.begin`, after the last `insertOutreachRender`, before `recordGenerationSteps` — the documented lock order and the rollback guarantee both hold.
- **`occurredAt` contract.** Every input keeps the caller's `decidedAt` instance; the `'transaction_time'` sentinel never appears on this lane. The comment explaining why moved from the object literal into the builder docblock — moved, not duplicated.
- **Empty-case delegation.** `writeRefusalEvents(tx, [])` is called unconditionally and `write.ts:585` returns before the kill-switch read, exactly as the comment claims. Declining a caller-side length check is correct and matches `batch-builder.ts:670`.
- **Invariant #15.** Both arms take `tx`; the builder is pure and takes neither `tx` nor a clock.
- **Line counts.** `arch-review-log.md:1513`'s "27 executable lines added (40 comment, 3 blank — measured AT HEAD by first non-whitespace token)" reproduces exactly: I measured 27 / 40 / 3, total 70. No finding — and worth noting given the checklist's history with counting claims on this wave.
- **File size.** `ask-generation.ts` is already well past 1,000 lines at the fork point; this diff adds 70 and extracts one function. It does not cross the threshold and it does not worsen the shape.
- **Dead / duplicated / back-compat (target 6).** No dead code, no compatibility shim, no unnamed external consumer. `writeRefusalEvent` is still imported and still used via the two remaining single-row call sites; the only redundancy is the pass-through wrapper itself (F3).
- **The abort test.** `abortingExecutor` with `SELECT 1 / 0` (22012) asserting **both** surfaces empty is the right guard for the hazard the move creates, and it is a hazard a column-equality test genuinely cannot see. This is the strongest thing in the diff.

---

## Low-confidence appendix

Below the 80% bar — recorded, not tabled.

- **`expectNoRefusalWrite()` (target 4)** — `ask-generation.test.ts:1273-1277`. On balance it makes the four sites *clearer*, not less inspectable: it holds two separate `expect` calls whose own failure messages still name the offending mock, so a failure points at `writeRefusalEvent` or `writeRefusalEvents` by name and the stack frame still resolves to the calling test. The zero-argument shape is defensible because the assertion has no variable part. Two soft notes: the name says "no Refusal write" but the assertion is "the writer was not called" (a distinction this codebase is otherwise careful about — the ticket test's own comment insists "one call carrying an empty set is not a ledger write"), and being unparameterised means the next test that needs "single arm silent, set arm called once" cannot use it. Neither rises to a finding.
- **"IT IS PURE, and that is what makes it safe to call inside a loop"** — `ask-generation.ts:721-723`. Purity is not what makes it loop-safe; the pre-change code called the *impure* `recordOutreachWithheldRefusal` in the same loop and that was safe too. The property that matters is "issues no I/O and reads no clock", which the next sentence states correctly. Rhetorical rather than false, and the definition of "pure" it invokes is the one `vocabulary.ts` fixed for this area, so I would not block on it.
- **"which #1001 made the only owner of either"** — `ask-generation.ts:724-726`. `write.ts:562-565` credits #1001 with owning the *statement*. The kill switch's placement inside the writer is a #1079 fact per `arch-review-log.md:1511`. Folding both under #1001 may be an attribution slip, but I did not read #1001 itself and will not stake 80% on it.
- **`arch-review-log.md:1513` credits `writeRefusalEvents` to #1009**, while `write.ts` and the surrounding ledger row discuss #1001/#1010. Unverified; possibly correct.
- **Comment-to-code ratio, 40:27 (target 2).** In band for `src/lib/refusals/` and `src/lib/solicitation/`, and I would not flag the volume. Judged line by line, the added prose is not restatement — it carries the *why* (both-arms rationale, unconditional-call rationale, in-transaction placement) rather than the *what*. The defects are falsity (F1), staleness inherited but not fixed (F2), split ownership (F3) and an unfalsifiable claim (F4) — not verbosity. Two of the four are of the "will be false after a plausible edit" kind the brief asked about, and one is already false today.
- **A stylistic alternative to `refusals.push(...)` inside the loop:** collect `outreachId`s and build the array with one `.map()` after the loop, so the loop body has a single responsibility. Marginal; the current form is fine and matches how the precedent call site builds its array in one expression.
