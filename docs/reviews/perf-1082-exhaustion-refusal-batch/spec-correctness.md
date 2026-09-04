# Spec & correctness review — `perf/1082-exhaustion-refusal-batch`

- Fork point: `b9fb9601`
- HEAD reviewed: `4f39fbd2`
- Diff: `git diff b9fb9601..4f39fbd2` (7 files, +513 / −29)
- Axis: spec conformance against the locked intake, correctness of the N→1 write
  transformation, blast radius, and truth of every doc claim at HEAD.

---

## Findings table (>= 80% confidence)

| severity | file:line | finding |
|---|---|---|
| medium | `src/lib/solicitation/ask-generation.ts:652-655` | `recordOutreachWithheldRefusal`'s retained docblock still names `settleGenerationExhaustion`'s hole fill as one of its "THREE PHYSICAL CALL SITES" — the branch removed exactly that call site, leaving two (`:866`, `:1666`). The lane's designated mapping contract now describes the pre-change code. |
| medium | `src/lib/solicitation/__tests__/ask-generation.test.ts:1276,1463,1597` | The unit suite is intermittently red at HEAD: 2 failures in ~102 local runs, both on assertions this branch introduced or reshaped (0 failures in 48 runs of the same suite at the fork point). The gate's `test: PASS` is not reproducible on demand. |
| low | `src/lib/solicitation/__tests__/ask-generation.test.ts:1382,1392` | Inside the reason→category mapping test, only `mocks.writeRefusalEvent.mockClear()` is called between phases; `writeRefusalEvents` is never cleared. Because `refusalCalls()` now sorts on the globally monotonic `invocationCallOrder`, an uncleared set call from an earlier phase sorts *ahead* of the fresh single-row calls and mis-pairs every row — the exact failure the new fold's docblock says it prevents. |

---

## 1. Intake contract, field by field

### `goal`
> "settleGenerationExhaustion records every hole's Refusal in ONE writeRefusalEvents statement, so the batch advisory lock and the batch row lock are held across one ledger round trip instead of one per hole."

**Honoured.** `src/lib/solicitation/ask-generation.ts:1866-1917`: the loop now pushes
`WriteRefusalEventInput` values and a single `await writeRefusalEvents(tx, refusals)`
follows at `:1899`, inside the one `sql.begin` opened at `:1797`. `writeRefusalEvents`
(`src/lib/refusals/write.ts:584`) is a real `jsonb_to_recordset` set insert, not a loop
wearing a batch name.

### `non_goals` — all seven honoured

| # | Non-goal | Verdict |
|---|---|---|
| 1 | Do not batch `insertOutreachRender` | HONOURED — still one call per hole (`:1871`), and `expect(mocks.insertOutreachRender).toHaveBeenCalledTimes(3)` pins it at `:1605`. |
| 2 | Do not edit `src/lib/refusals/write.ts` | HONOURED — not in `git diff --name-only`. |
| 3 | Do not change `persistChildRender` / `regenerateAsk` | HONOURED — both still route through `recordOutreachWithheldRefusal` (`:866`, `:1666`), whose observable behaviour is byte-identical (same object, same helper). |
| 4 | Do not change the idempotency contract | HONOURED — both arms re-spell `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING`; the set arm additionally resolves an intra-statement duplicate, which `DO UPDATE` could not. No behavioural delta for this lane, whose subjects are freshly minted per hole. |
| 5 | Do not change `occurred_at` | HONOURED — every input carries the caller's `decidedAt` (read at `:1793`, before `sql.begin` and before the advisory lock). The `'transaction_time'` sentinel is never produced; `COALESCE(event.occurred_at, NOW())` in the set arm is unreachable for this lane. `Date` → `toISOString()` → `timestamptz` is lossless at JS millisecond precision, so `refusal_events.occurred_at` still equals `solicitation_outreach.rendered_at` exactly (the existing live-DB `timestamps_equal` guard at `:1420-1428` still holds). |
| 6 | Do not widen `ci:pool-fanout` | HONOURED — `scripts/ci/` untouched. |
| 7 | No private set-arm wrapper in `ask-generation.ts` | HONOURED — `outreachWithheldRefusalInput` is a pure input builder with **two** callers (`:701`, `:1892`), not a one-caller wrapper around the set arm. |

### `user_visible_behavior` — all three honoured

1. **N inserts → 1 insert inside the same transaction.** Confirmed above.
2. **No owner-facing change.** Stored `refusal_source`, `refusal_code`, `refusal_category`,
   `subject_type`, `subject_id`, `occurred_at`, `vocabulary_version` are produced by the
   same builder for both arms; the set arm writes the same eleven columns in the same
   order (`write.ts:608-660`). The Restraint tab reads the stored category, so nothing moves.
3. **Warning count unchanged with `REFUSAL_LEDGER_ENABLED=false`.** Verified against
   `write.ts:296` (`warnedThisEpisode`) and `:368` (`warnLedgerDisabled`): N single-row calls
   already latched to one warning; one set call warns once. Same signal.
   Cited line numbers re-resolved at HEAD — both correct.

### `invariants` — 7 of 8 honoured, 1 broken in the doc layer

| Invariant | Verdict |
|---|---|
| `write.ts` stays the only place `INSERT INTO refusal_events` is spelled | HONOURED — the branch adds no statement. |
| One Refusal per hole, never one per invocation | HONOURED — `refusals.push` is unconditional inside the loop; the live-DB guard at `integration.test.ts:1461` (untouched) compares id **sets**, not counts. |
| Write stays INSIDE `sql.begin`, after the last fill, before `recordGenerationSteps` | HONOURED — `:1899`, between the loop's close and `if (parent)` at `:1901`. `settleGenerationExhaustion` opens exactly one `sql.begin`; `markOutboxFailed`, `acquireSolicitationBatchLock`, `insertOutreachRender` and `recordGenerationSteps` all take `tx`. |
| Every Refusal carries the caller's `decidedAt` instance | HONOURED — the builder is pure; no clock read inside it. |
| `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES` has ONE reader in this module | HONOURED — grep across `src` + `worker` shows exactly one production read, `ask-generation.ts:743`, inside the builder. |
| Return shape `{ status, filled }` unchanged | HONOURED. |
| Subject ids stay the ids `insertOutreachRender` minted, in loop order | HONOURED — array order is preserved into `inputs.map` and into the recordset. |
| `recordOutreachWithheldRefusal` keeps its docblock as the lane's mapping contract | **BROKEN in substance.** The docblock is retained byte-for-byte, but `:652-655` now states something false about the code beneath it. See F1. |

### `edge_cases` — all eleven check out

- **Zero holes.** `writeRefusalEvents` returns on `if (inputs.length === 0)` (`write.ts:588`)
  *before* the kill-switch read at `:592`. No statement, no warning. Pinned at
  `ask-generation.test.ts:1608-1622`.
- **One hole.** `jsonb_to_recordset` over one row; no fast path, none added.
- **Flag off with holes present.** One latched warning, same as N latched calls.
- **Duplicate subject from an earlier settlement.** Absorbed; the set arm asserts no
  affected-row count (`write.ts:571-578` documents why). Verified — no count assertion in the body.
- **CHECK violation.** Not caught at either arm; still aborts the settlement.
- **No send parent.** `agentRunId: parent?.id ?? null` on the fill; the Refusal never reads `parent`.
- **Ordering.** All fills land before any Refusal, inside one transaction — no reader sees an
  intermediate state. The intake's claim that `refusal_events.id` ordering is preserved
  **holds**: ids are now minted in a tight synchronous `inputs.map`, but `uuid@14.0.0`'s v7
  (`node_modules/.pnpm/uuid@14.0.0/.../dist/v7.js`, `updateV7State`) increments a monotonic
  `seq` when `now <= state.msecs`, and all 32 seq bits are encoded in descending significance
  across bytes 6-10, so same-millisecond ids are strictly increasing. This was the one edge
  case where the batch conversion could plausibly have changed a stored fact; it does not.
- **`insertOutreachRender` throws mid-loop.** Collected inputs die with the transaction.
- **Stale CAS / missing batch.** Both return before the loop; neither arm reached.
- **Abort after the loop.** New live-DB case covers it.

### `allowed_edit_surface`

`git diff --name-only b9fb9601..HEAD` yields seven paths. Four are the declared surface
(`ask-generation.ts`, both suites, `arch-review-log.md`). The other three
(`…-intake.json`, `…-plan.md`, `…-deviations.md`) live under `docs/`, which
`scripts/ci/feature-surface-audit.ts:68` treats as `ALWAYS_ALLOWED` process surface.
**In surface. Not a finding.** (Noted only because two of the three most recent intakes
in `docs/superpowers/plans/` list `docs/superpowers/plans/<slug>*` explicitly and this
one does not — a stylistic inconsistency the audit forgives.)

### `tests_to_add` — all four exist, verbatim, and test what they claim

| # | Title | Location | Does it test its title? |
|---|---|---|---|
| 1 | `a generation exhaustion records every hole's Refusal in ONE writeRefusalEvents call, never one call per hole` | unit `:1580` | YES, and strongly. Asserts the single-row arm is untouched, the set arm called exactly once, the flattened fan-out is 3, the subject ids are `outreach-1..3` **in order**, and `insertOutreachRender` still ran 3 times. A writer that batched-but-dropped and a writer that kept-every-row-but-looped both fail. Double-quoted `it("…")` so the apostrophe is verbatim on disk (deviation D2). |
| 2 | `a generation exhaustion that finds no holes issues no Refusal write through either arm` | unit `:1608` | YES with a gloss. It asserts `writeRefusalEvents` **was** called once with `[]`, reconciled in-test as "one call carrying an empty set is not a ledger write". The assertion is stronger than the title, not weaker — it pins the exact call shape and the empty fan-out. See appendix A1. |
| 3 | `a stale generation-exhaustion attempt writes no Refusal through either the single-row or the set arm` | unit `:1565` | YES. `markOutboxFailed → false` returns before the hole query; `expectNoRefusalWrite()` names both arms. |
| 4 | `a generation exhaustion that aborts after its fills records neither the outreach rows nor their refusal_events rows` | integration `:1493` | YES. Uses `abortingExecutor` (the sanctioned non-DDL injection) with a real `22012` poison raised on the same `tx` *after* the callback completes, and asserts BOTH surfaces empty. This is the correct test for the hazard the move creates. |

Four negative assertions previously naming one arm (`:1526`, `:1543`, `:1559`, `:1577`)
now route through `expectNoRefusalWrite()` (`:1274-1277`), which names both. The T1 tracer
did what it promised.

---

## 2. Correctness of the transformation

### (a) N single-row writes vs one set write

Every axis the intake claimed to have resolved actually resolves:

- **Row identity / columns.** Both arms write the same eleven columns; `all_refusal_codes`
  keeps `null` distinct from `'{}'`; `vocabulary_version` is the same frozen literal.
- **Idempotency.** Byte-identical `ON CONFLICT … WHERE … DO NOTHING` in both arms.
- **Kill switch.** Read live, per call, inside each body. The batch conversion is a strict
  *improvement*: previously a mid-loop flag flip could produce a half-recorded settlement;
  now the N rows share one flag read.
- **`occurred_at`.** Millisecond-identical in both arms (see non-goal 5).
- **Error semantics.** Both raise into the deciding transaction and abort it. Identical.
- **`created_at`.** `DEFAULT NOW()` = `transaction_timestamp()`, stable across both shapes.
- **Ordering of `refusal_events.id`.** Preserved (uuid v7 monotonic seq — evidenced above).

No unresolved behavioural difference found.

### (b) Can the write land outside the transaction?

No. `writeRefusalEvents(tx, …)` takes the transaction handle explicitly (invariant #15),
`settleGenerationExhaustion` opens exactly one `sql.begin`, and the new live-DB abort case
proves the fills and their Refusals roll back together.

### (c) Can a hole be filled without its Refusal, or gain a Refusal without a fill?

No. `refusals.push(...)` follows every `insertOutreachRender` unconditionally in the same
iteration; the array is never filtered, spliced, or conditionally skipped; and both writes
share one transaction. A `throw` anywhere takes both. The only remaining asymmetry is the
kill switch, which is by design and unchanged.

### (d) Is `refusalCalls()`'s `invocationCallOrder` fold correct?

**Yes for the current shape, with one latent hole (F3).**

`invocationCallOrder` is a global monotonic counter (`@vitest/spy@4.1.7`
`dist/index.d.ts:80`), per-mock arrays index-aligned with `mock.calls`. Sorting the union
on it restores true chronology, and flattening a set call in input order reproduces exactly
what N single-row calls would have produced. For the matrix test the resulting sequence is
W1(1) → W2(2) → W3(1) → W4(2) = 6, which pairs positionally against `insertOutreachRender`'s
own 6 withheld inserts. Correct.

Interleaving a set call with single-row calls is also correct *as long as every set call's
own fills precede it*, which is true for W4 (all inserts, then one set write). The `beforeEach`
at `:249-255` `mockReset()`s every entry of `mocks`, so no cross-test leakage — except via
the explicit mid-test `mockClear()` at `:1382`/`:1392`, which is one-armed. That is F3.

### (e) Blast radius — 7 importers of `ask-generation.ts`

| Importer | Semantic exposure |
|---|---|
| `src/lib/solicitation/dispatch.ts:131` | `import type { OutboxHandle }` only. None. |
| `worker/jobs/solicitation-batch/generate-failed-hook.ts:179` | Calls `settleGenerationExhaustion`; return shape `{ status, filled }` unchanged. None. |
| `worker/jobs/solicitation-batch/generate.ts:15` | `generateAsksForBatch` path untouched. None. |
| `worker/jobs/solicitation-batch/__tests__/generate.test.ts` | `vi.mock(…, { spy: true })` then `vi.mocked(settleGenerationExhaustion).mockResolvedValueOnce(…)` throughout — never executes the real body. None. |
| `src/lib/solicitation/__tests__/auto-approval.integration.test.ts:90` | Imports `generateAsksForBatch` + `regenerateAsk` only, both still on the single-row arm, and does **not** mock `@/lib/refusals/write` (runs the real helper against the real table). None. |
| the two edited suites | Updated in this branch. |

No caller relied on the per-hole call count, on `writeRefusalEvent` being the lane's only
ledger entry point, or on any ordering the change moves. **No blast-radius finding.**

---

## 3. Doc claims re-resolved at HEAD

Every `file:line` and quoted symbol in the diff was re-checked against the current files.

| Claim | Where | Verdict |
|---|---|---|
| `warnLedgerDisabled` at `write.ts:368`, `warnedThisEpisode` at `:296` | intake | TRUE |
| set arm at `write.ts:547-683` (docblock from `:547`, body `:584`) | intake / plan | TRUE |
| `batch-builder.ts:655-697` is the only other `writeRefusalEvents` call site; the call is at `:670` | intake / plan / arch row | TRUE — `grep` finds exactly two call sites repo-wide |
| `MAX_DATA_ROWS` = 5,000, `loadCandidateWindow` bounds a batch by it | new comment `:1861-1863`, plan, arch row | TRUE — `contacts-csv.ts:22`, `batch-builder.ts:420` + `LIMIT ${MAX_DATA_ROWS}` at `:499` |
| existing live-DB guard at `integration.test.ts:1461`, untouched | intake / plan | TRUE — the "one refusal_events row per outreach hole" test, unedited, compares id sets |
| "`writeRefusalEvents` issues no statement for an empty input and returns before it even reads the kill switch" | new comment `:1893-1896` | TRUE — `write.ts:588` precedes `:592` |
| "`persistChildRender` (W1/W2) and `regenerateAsk` (W3) each settle ONE render per transaction" | plan / arch row (a) | TRUE, and non-obvious: `settleBudgetStop` (`:958`) *loops*, but each iteration calls `persistChildRender`, which opens its **own** `sql.begin` at `:833`. So no per-iteration write shares a lock window. The claim survives scrutiny. |
| "the ticket said 'worth checking the other seven write sites'" | arch row (a) | TRUE — verbatim in `gh issue view 1082` |
| "27 executable lines added (40 comment, 3 blank — measured AT HEAD by first non-whitespace token)" | arch row / deviation D1 | TRUE — independently re-measured: `code=27 comment=40 blank=3` |
| "`batch-builder.ts:670` calls unconditionally with a possibly-empty `flatMap`" | arch row (c) | TRUE |
| "the matrix test pairs `refusalCalls()[i]` with the outreach inserts POSITIONALLY" | arch row (d) | TRUE — `integration`… sorry, `ask-generation.test.ts:1465-1478` |
| `estimated_prod_lines` 35→90, `estimated_test_lines` 75→150 "in both intake copies" | deviation D1 | TRUE — `docs/superpowers/plans/…-intake.json` and `.feature/intake.json` both read 90 / 150 |
| the arch-review-log row was appended after the #1080 row | deviation D3 | TRUE — it is the last line of the file |
| `recordOutreachWithheldRefusal` is "SHARED BY THE LANE'S THREE PHYSICAL CALL SITES … and `settleGenerationExhaustion`'s hole fill" | `ask-generation.ts:652-655` | **FALSE at HEAD** — see F1 |

One false claim out of fourteen, and it is in the production file rather than in a plan doc.

---

## 4. Findings in detail

### F1 [medium] — `src/lib/solicitation/ask-generation.ts:652-655`

```
 * PRIVATE, AND SHARED BY THE LANE'S THREE PHYSICAL CALL SITES —
 * `persistChildRender` (which `settleBudgetStop` also settles through),
 * `regenerateAsk`'s swap, and `settleGenerationExhaustion`'s hole fill. Four
 * WRITERS, three call sites.
```

At HEAD `settleGenerationExhaustion` does **not** call `recordOutreachWithheldRefusal`.
`grep -n "recordOutreachWithheldRefusal("` returns two call sites: `:866` (inside
`persistChildRender`) and `:1666` (inside `regenerateAsk`'s swap). W4 now calls
`outreachWithheldRefusalInput` at `:1892` and hands the result to the set arm.

Why it matters rather than being cosmetic: the intake designates this exact docblock as
"the lane's mapping contract", and `docs/reviews/finding-checklists/spec-correctness.md`
plus the branch's own arch-review row for #1080 both flag "the branch states something
about itself that is false" as a recurring class here. A reader who opens the contract
before touching W4 is told W4 goes through the single-row arm — which is precisely the
fact this branch changed. The new builder's docblock does say W4 uses `writeRefusalEvents`,
so the module now contains two docblocks that disagree about the same call graph.

Fix is one sentence: "TWO PHYSICAL CALL SITES — `persistChildRender` … and `regenerateAsk`'s
swap. `settleGenerationExhaustion` projects the same shape through
`outreachWithheldRefusalInput` into the set arm. Four writers, two call sites plus the batch lane."

### F2 [medium] — `src/lib/solicitation/__tests__/ask-generation.test.ts:1276, :1463, :1597`

The suite is **intermittently red at HEAD**. Two distinct failures observed:

1. `expectNoRefusalWrite` (`:1276`) called from the stale-CAS test (`:1577`):
   `expected "writeRefusalEvents" to not be called at all, but it was called 1 time` with
   arguments `(tx, [])`. The preceding assertions in that test passed
   (`settled === { status: 'stale' }`, `insertOutreachRender` not called), so the lane
   returned before its loop — meaning the recorded call did not originate in that test's
   own invocation. Result line: `Tests 1 failed | 50 passed (51)`.
2. A later run (first invocation after `rm -rf node_modules/.vite`):
   `Tests 2 failed | 49 passed (51)` —
   `:1463 expect(refusalCalls()).toHaveLength(6)` received 5, and
   `:1597 expect(refusalCalls()).toHaveLength(3)` received 2, while
   `expect(mocks.writeRefusalEvents).toHaveBeenCalledTimes(1)` passed on the same run.
   Both short by exactly one exhaustion-lane Refusal.

Measured rates on this machine (`REPWORTH_DISABLE_LIVE_DB_SUITES=1 npx vitest run <file>`):

| tree | failures |
|---|---|
| HEAD `4f39fbd2` | 2 / ~102 |
| fork point `b9fb9601` (extracted via `git archive`, node_modules symlinked) | 0 / 48 |

Not reproducible on demand: 40 paired runs, 10 `--sequence.shuffle` runs, 3 cold-cache runs
and 8 runs deliberately preceded by an errored vitest startup were all green on both trees.

**What I can and cannot stake.** The failures happened, at HEAD, with no working-tree edits —
I am confident of that. I could **not** identify the mechanism, and 2/102 vs 0/48 is not
enough to attribute it to the branch rather than to a pre-existing leak in this suite's
`sqlReturnQueue` FIFO or mock-reset ordering that the new assertions merely expose. What is
actionable regardless: `.feature/gate-status.json` records `test: PASS`, and that result is
not reproducible on demand at HEAD. Both failure signatures land on the new two-arm fold, so
whoever owns the fix should start there. Suggested next step for the red-team pass: run this
one file 300× on CI hardware and capture a failing run with `--reporter=verbose --no-file-parallelism`.

### F3 [low] — `src/lib/solicitation/__tests__/ask-generation.test.ts:1382, :1392`

The reason→category mapping test resets between its three phases with:

```
mocks.writeRefusalEvent.mockClear();
resetMockSql();
```

`mocks.writeRefusalEvents` is never cleared. Today this is inert: all three phases run W1,
which uses only the single-row arm. But `refusalCalls()` (`:1256-1268`) now folds both arms
and orders on `invocationCallOrder`, whose counter is global and **monotonically increasing
across the whole file**. So a set call recorded in an earlier phase and never cleared carries
a *lower* order number than the single-row calls of the current phase, and would be prepended
to the fold — mis-pairing every subsequent positional assertion. Concrete trigger: add a W4
phase to this test (the natural next edit, since the other three phases already cover W1's
three reasons), or route any of W1/W2/W3 through the set arm in a later ticket. The branch's
own arch-review row calls arm-order mis-pairing "the moment a second arm exists" the hazard
it fixed; this is the one place in the file where the fix is still one-armed.

Fix: replace both with a two-armed helper, mirroring `expectNoRefusalWrite`.

---

## Appendix — low-confidence observations (deliberately NOT in the table)

**A1.** `tests_to_add[1]`'s title, "issues no Refusal write through either arm", is reconciled
with `expect(mocks.writeRefusalEvents).toHaveBeenCalledTimes(1)` only by the in-test comment
("one call carrying an empty set is not a ledger write"). The assertion is strictly stronger
than the title, and the intake's zero-holes edge case explicitly anticipated the delta
("Today zero holes make zero calls"), so this is a naming nit, not a coverage gap. A title
like "…issues no Refusal ROW through either arm" would remove the need for the gloss.

**A2.** The intake invariant says "the extracted input builder does not become a second place
that explains the mapping". The builder's docblock (`:707-730`) is 24 lines and restates the
source, code axis, subject axis and clock rule — including the whole `NOW()` /
`transaction_timestamp()` paragraph that the diff *deleted* from the object literal at the
old `:707-712`. Strictly, the reasoning moved rather than duplicated (the sentinel rationale
now has one home), and `recordOutreachWithheldRefusal`'s `@param decidedAt` still carries a
compressed version. Judgement call; I would not block on it.

**A3.** `outreachWithheldRefusalInput` declares its return as the full `WriteRefusalEventInput`
union rather than the `outreach_withheld` lane member. The object literal is still checked
against the discriminated union at the `return`, so nothing is unsound, but a caller pushing
into `WriteRefusalEventInput[]` gets no lane narrowing. Narrowing the return type to
`Extract<WriteRefusalEventInput, { refusalSource: 'outreach_withheld' }>` would make the
"one mapping owner" claim structural rather than conventional.

**A4.** `refusalCalls()`'s non-null assertions on `invocationCallOrder[index]` are safe
(the array is index-aligned with `mock.calls` in `@vitest/spy@4.1.7`), but they are the kind
of assertion that would silently produce `NaN` comparisons and an unstable sort if vitest ever
changed that alignment. A `?? 0` would fail loudly instead of scrambling order.

---

## Verdict

The transformation itself is correct. Every non-goal, every user-visible-behavior claim, all
eleven edge cases and seven of eight invariants hold under scrutiny, including the two that
looked most likely to have been asserted rather than verified (uuid v7 ordering, and
`settleBudgetStop` not being a per-transaction loop). All four promised tests exist verbatim
and assert what they claim; the abort test is the right test for the hazard the move creates.

Two things stand between this and clean: a docblock that now describes the pre-change call
graph (F1, a one-sentence fix), and a suite whose green is not reproducible on demand (F2,
needs a bounded investigation before "verified" is honest).
