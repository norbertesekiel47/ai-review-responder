# Red-team — `perf/1082-exhaustion-refusal-batch`

| | |
|---|---|
| Mode | feature, **round 2** (the cap — `round-start` refuses a third) |
| Fork / merge-base | `b9fb96016cc025c151f17db4b39baf165cb80a13` |
| Round 1 HEAD | `4f39fbd26e51e46bea1a45d8e6069d576c756021` |
| HEAD | `aa3fab6eabd4eff982b5da7cd918d55629c076e1` |
| Intake SHA-256 | `e8b60f89…31ea` (risk: **high**) |
| Generated | 2026-09-03T19:22:13Z |
| **Status** | **OPEN_P0** |

Mutation runs used: **5 of 30**. Every mutation restored; `finalize` reported
`reap: every journaled process group is empty (5 recorded)` then
`restored 0 mutated file(s) and 1 dotenv file(s); journal closed` — 0 because
each mutant was returned to its journaled original blob before the next was
applied, so the finalizer found nothing outstanding. `git status --porcelain`
is EMPTY apart from this report directory.

Environment: allowlist env via `mutation-runner.mjs env --tmp-home … --test-db
postgresql://…@localhost:5499/test_ws4`, `.env.local` swapped for the scrubbed
replacement for the whole mutation phase. The live-DB lane RAN (22/22).

**Scope, as briefed.** The fix commit `aa3fab6e` and its direct callers only.
The round-1 findings were re-checked for closure; no new front was opened
against code the fix did not touch. One unrelated observation is in the
appendix, untriaged.

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `.claude/reference/arch-review-log.md:1513` | The fix retracted one false "LOAD-BEARING" claim and asserted another in the same bullet: "What IS load-bearing today is the paired `clearRefusalCalls()`" is false — reverting it to the one-armed clear leaves 51/51 green — and the review finding the fix acted on says "Today this is inert" in the same words. |
| **P1** | `.claude/reference/arch-review-log.md:1513` | "27 executable lines added (40 comment, 3 blank — **measured AT HEAD**)" was falsified by the commit that re-published it: at `aa3fab6e` the production diff adds 96 = 27 code + **66** comment + 3 blank. |
| **P1** | `docs/superpowers/plans/…-plan.md:55` | The new banner "CITATIONS IN THIS PLAN ARE BY SYMBOL, NOT BY LINE" is false — two bare line citations survive, and `:1632` (`regenerateAsk`) lands on an unrelated `SELECT` 146 lines from the declaration. `prevalidate-plan.py` cannot see bare `:NNN`, so its PASS is vacuous here. |
| P2 | `docs/superpowers/plans/…-deviations.md:134` | The intermittent-suite rejection refutes a desync mechanism the spec axis never proposed (it wrote "I could not identify the mechanism"); the vitest claim itself is TRUE, but it answers appendix A4, not F2. |
| P2 | `src/lib/solicitation/ask-generation.ts:1878` | The corrected bound comment introduces `restraint-policy.ts:440-448` — the only new line citation in production code on a branch whose plan, intake and commit message all say it moved to symbol citation. It resolves. |

Round-1 findings are carried in `findings.json` with their round-2
dispositions; the closure evidence is in "Round 1 — dispositions" below.

## Duty 1 — hand-mutation

Five inventory rows: 1 killed, 2 equivalent (each carrying its proof), 2
excluded with a recorded reason, 0 inconclusive, 0 skipped for budget.

| Id | Mutation | Result |
|---|---|---|
| R2-M1 | `clearRefusalCalls()` reverted to the one-armed `mocks.writeRefusalEvent.mockClear()` the fix replaced | **SURVIVED** — the single case green under `assert-one-test`, then 51/51 on the whole file. Provably equivalent (see below); the DOC claim is RT1082-07 |
| R2-M2 | caller-side `if (refusals.length > 0)` around `writeRefusalEvents(tx, refusals)` (`ask-generation.ts:1930`) | **killed** — 1 failed / 50 passed, failing at `:1659`, the design pin, with all three title-property assertions passing |
| R2-M3 | `refusalCalls()`'s `.sort((l, r) => l.order - r.order)` removed, leaving plain `[...single, ...set]` | **SURVIVED**, 51/51 — re-measured at the NEW head, confirming the fix's own retraction |

**Why R2-M1 is `equivalent` and not a P0 survivor.** `clearRefusalCalls()` has
exactly two call sites (`:1409`, `:1419`), both inside
`'the render lane maps render_failed and lint_failed …'`. That case drives only
`runSingleChild`, whose lane is `persistChildRender` →
`recordOutreachWithheldRefusal` → `writeRefusalEvent` — the SINGLE-ROW arm.
`writeRefusalEvents` is reached only from `settleGenerationExhaustion`, which
the case never invokes, so the set-arm mock holds zero calls at both clear
points and clearing it is a no-op. That is a proof about the MUTANT, so the row
does not block. The claim that the line is load-bearing **today** is a separate
claim about the world, and it is the P0.

**Why R2-M3 is `equivalent`.** The matrix case is the only one that mixes arms,
and it drives W1 (`:1477`) → W2 (`:1479`) → W3 (`:1481`) → W4 (`:1483`), with
W4 = `settleGenerationExhaustion` the only set-arm writer. Its calls are
therefore already last under plain concatenation. This is the fix's own stated
reason, re-derived independently and re-measured at the new head.

**Direction B.** The fix commit's production diff to `ask-generation.ts` is
COMMENT-ONLY. Classifying every added line of `b9fb9601..aa3fab6e` by first
non-whitespace token: 96 added = 27 code + 66 comment + 3 blank, and the code
count is identical to round 1's 27 at `4f39fbd2`. There is no
behaviour-affecting production hunk in this commit beyond the one R2-M2 covers,
so the two `excluded` rows are complete rather than a sample.

## The claims the brief asked me to verify, one by one

**1 — the `refusalCalls()` retraction.** Sound. Both prose sites now say the
sort is NOT load-bearing today, name the W1→W4 happenstance, and justify
keeping it for order-independence. Re-measured as R2-M3: 51/51 green without
the sort. **The `@vitest/spy` sub-claim is TRUE in the installed version.** In
`@vitest/spy@4.1.7`, `mockClear` resets `state.calls` and
`state.invocationCallOrder` inside one function body
(`dist/index.js:142-150`), and `registerCalls` / `registerInvocationOrder` are
called on adjacent unconditional lines `:288-289` of the mock body — so the two
arrays are always index-aligned and the non-null assertions at
`ask-generation.test.ts:1272`/`:1276` are safe. Nothing else in the new prose
is false — **except** the substituted `clearRefusalCalls()` claim (RT1082-07).

**2 — the new "load-bearing" hazard.** MUTATED, and it does not hold. R2-M1
reverted `clearRefusalCalls()` to the single arm; nothing went red, 51/51.
Worse than merely unmeasured: `docs/reviews/perf-1082-exhaustion-refusal-batch/spec-correctness.md:275`
(F3) — the very finding the fix implemented — says "**Today this is inert**:
all three phases run W1, which uses only the single-row arm", and gives its
trigger as a FUTURE edit. The helper is a good forward-looking change; the
ledger's present tense is the defect. Raised as **P0**, not P1: it is the same
class, the same file, the same row and the same measurement method as round 1's
P0, and this ledger is the durable authoritative layer. The one-clause fix is
to phrase it prospectively, exactly as the sort's retraction two clauses
earlier already does.

**3 — the 200x bound correction. The 25 is CORRECT.** Chain re-derived
independently, end to end:

1. `holes` filters `AND ask.status = 'send'` — `ask-generation.ts:1848`.
2. `commitAskDecisions` builds `status: decision.decision` and inserts it —
   `batch-builder.ts:607`, `:615-640`.
3. `evaluateBatch` returns at most `BATCH_CAP` send decisions: everything past
   `.slice(0, BATCH_CAP)` is rewritten to `withhold`/`velocity_banked` —
   `restraint-policy.ts:436-460`, `BATCH_CAP = 25` at `:87`.
4. `UPDATE solicitation_asks ask SET agent_run_id = link.run_id` is the ONLY
   update statement in the repo — `batch-builder.ts:721`. `rg` over `src`,
   `worker` and `supabase/migrations` finds exactly two write statements
   against the table (the INSERT at `:615` and that UPDATE), no trigger and no
   other writer, so no other path can produce a `send`-status ask.

**Can one `batch_id` accumulate more than `BATCH_CAP`?** No. `commitAskDecisions`
has a single caller, `constructBatch` (`batch-builder.ts:829`), inside one
`sql.begin` that takes the ownership CAS, then the per-Business advisory lock,
then `SELECT … FOR UPDATE OF sb`, and returns `already_built` when
`batch.built_at !== null` (`:771`). `built_at` has exactly one writer — the
`SET built_at = …` guarded on `AND built_at IS NULL` at `:849` — so a batch is
built once and the ask set is written once. **No P0 here: the correction went
from a wrong number to a right one.**

**4a — citations.** Every symbol the plan and intake now quote resolves at
HEAD: `settleGenerationExhaustion`, `writeRefusalEvents`, `commitAskDecisions`,
`persistChildRender`, `regenerateAsk`, `recordOutreachWithheldRefusal`,
`outreachWithheldRefusalInput`, `abortingExecutor`, `abortAfterLedgerWrite`,
`evaluateBatch`, `insertOutreachRender`, plus the three verbatim test titles
(`:1470`, `:1462`, `:1692`). The intake's three surviving line citations
(`restraint-policy.ts:440-448`, `write.ts:368`, `write.ts:296`) were
hand-resolved and all three land correctly. What does NOT hold is the plan's
banner — see RT1082-09.

**4b — observability.** TRUE. `deadLetterWholeBatch`
(`worker/jobs/solicitation-batch/generate-failed-hook.ts:170-209`) is one
`for` loop; the `try` arm logs and `return`s, the `catch` arm either `continue`s
or logs and `return`s. No `throw` on any path, and the sole caller (`:279`)
returns immediately after. `terminal_settlement_abandoned` (`:136`) appears in
no rule row of `docs/runbooks/beta-launch-alerting.md`. Both halves of the
corrected claim stand.

**4c — the "no holes" split.** VERIFIED BY MUTATION (R2-M2). Exactly one case
red across the file, failing at `:1659` — the pin — with `:1648`, `:1649` and
`:1650` all passing. Nit, not a finding: the comment says the guard "would turn
THESE two lines red"; the first fails and vitest never reaches the second.

**4d — the abort comment, both halves.** TRUE. The named sibling
`'a refusal written by each render writer does not survive a later rollback of
its outreach transaction'` is at `integration.test.ts:1692`; at its
`settleGenerationExhaustion` phase only `askOne` is still a hole (`askTwo` was
rendered by `seedRenderedAttempt`, `:1712`), and `abortAfterLedgerWrite`
aborts with `throw abort` on a JS `Error` (`:383`) — ONE hole, JS throw. The
new case seeds two send asks (`:1509-1510`), poisons with
`` tx`SELECT 1 / 0` `` (`:1515`) and asserts
`.rejects.toMatchObject({ code: '22012' })` (`:1522`) — TWO holes, real
Postgres 22012.

**5 — the `recordOutreachWithheldRefusal` census.** COUNTED AT HEAD, and it is
right. `recordOutreachWithheldRefusal` has exactly two call sites,
`ask-generation.ts:874` (inside `persistChildRender`) and `:1674` (inside
`regenerateAsk`) — "TWO SINGLE-ROW CALL SITES". The lane's four writers reach
the ledger through three call sites: those two plus
`writeRefusalEvents(tx, refusals)` at `:1930` — "FOUR WRITERS, THREE CALL
SITES, TWO OF THEM HERE". Consistent with the sibling docblock's "Three of the
four writers … go through `recordOutreachWithheldRefusal`" (`:757-760`), which
counts WRITERS (W1, W2 through `persistChildRender`, W3) rather than call
sites.

The kept-rather-than-inlined reasoning is sound but the fraction is generous.
The three items it names are real and do describe the WRITE — the no-catch
paragraph (`:699-703`), migration 116's CHECKs (same paragraph) and the
`dispatch.ts` counterpart (`:671-679`) — plus `@param tx` (`:681-685`). That is
roughly 20 of ~55 non-blank docblock lines, about a third rather than "half".
Recorded here, not raised: naming three real items and rounding their share up
is not a false claim, and the census it sits beside is now correct.

**6 — the volume run. 200 runs, 0 failures.** `ask-generation.test.ts` run 200
consecutive times at `aa3fab6e` under the scrubbed environment
(`REPWORTH_DISABLE_LIVE_DB_SUITES=1`), each run 51/51. Zero failing runs
captured, so there is nothing to attach. Round 1's spec axis measured 2/~102 at
`4f39fbd2`; the root measured 0/80 at `aa3fab6e`; this pass measures **0/200**.
That is 280 clean runs at the new head against 2 failures in ~102 at the old
one. It is evidence of absence at this volume, not proof — and the rejection's
STATED reasoning still does not reach the report it rejects (RT1082-10).

## Duty 2 — fragile assertions

The fix's test edits reduce fragility rather than add it. The two remaining
one-armed `expect(mocks.writeRefusalEvent).not.toHaveBeenCalled()` assertions
(`:1624`, `:1646`) are deliberate and each is paired with an explicit set-arm
assertion on the next lines, so neither is the one-arm-of-a-two-arm-writer
class. `expectNoRefusalWrite` (`:1285-1288`) covers both arms. No
absence-of-tag proxy, no exact string count, and the one positional pairing
(`:1492`) has a stated ordering contract. **Nothing new to report.**

## Duty 3 — docs vs reality, re-resolved at HEAD

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was run on
both changed docs: `PASS` for each, but the plan now reports
`CITATIONS: 0 checked` — the fix converted the citations the script CAN see
into symbols and left two the script CANNOT see, so its PASS is now vacuous for
this file. Every claim below was hand-checked.

Confirmed TRUE at HEAD: the whole `BATCH_CAP` chain (item 3 above); the
`@vitest/spy` alignment claim; the `deadLetterWholeBatch` no-rethrow claim and
the missing alert row; the retraction of the sort claim; the abort comment's
two halves; the `recordOutreachWithheldRefusal` census; every symbol citation
in the plan and intake; the intake's three surviving line citations.

Confirmed FALSE or self-contradicted: RT1082-07, RT1082-08, RT1082-09,
RT1082-10, RT1082-11.

## Duty 4 — missed sibling cases

**Pattern searched:** the shape the fix introduced — a one-armed mock reference
to a two-armed writer. `rg -n 'mocks\.writeRefusalEvent[^s]'` and
`rg -n 'mockClear|mockReset|clearAllMocks|resetAllMocks'` over
`src/lib/solicitation/__tests__/ask-generation.test.ts`. **Scope:** the changed
test file, because that is the only file the fix's test change touches.
**Exclusions:** the production surface, which the fix did not change
executably.

Seven hits. `:108` and `:280` are the mock factory and its `beforeEach` reset,
both correct. `:1271-1272` are inside `refusalCalls()`, which folds both arms.
`:1286` is `expectNoRefusalWrite`'s first line, paired with `:1287`. `:1302` is
`clearRefusalCalls`'s first line, paired with `:1303`. `:1624` and `:1646` are
deliberate, each paired with a set-arm assertion. **Zero siblings.** The
generic reset loop at `:249-256` calls `mockReset()` on every mock in the
`mocks` object, so both arms are cleared between cases regardless.

## Duty 5 — operational completeness

The fix commit adds no executable production line, therefore no new terminal or
swallowed failure path, therefore no new rule row is owed in
`docs/runbooks/beta-launch-alerting.md`. The one operational claim it CHANGES
is the observability entry, and that change made a false claim true (RT1082-04,
verified above). The pre-existing gap it now names honestly —
`terminal_settlement_abandoned` has no alert row — is confirmed and remains out
of this branch's scope.

## Round 1 — dispositions

| Id | Severity | Round-2 disposition |
|---|---|---|
| RT1082-01 | P0 | **fixed** — both prose sites retract; re-measured as R2-M3 (51/51 without the sort). The substitute claim in the same bullet is RT1082-07. |
| RT1082-02 | P1 | **fixed** — by an honest comment naming the sibling; both halves verified. |
| RT1082-03 | P1 | **fixed** — the seven named citations are gone and every replacement symbol resolves. The residue is RT1082-09. |
| RT1082-04 | P2 | **fixed** — verified against `generate-failed-hook.ts:170-209` and the runbook. |
| RT1082-05 | P2 | **fixed** — verified by mutation R2-M2; only the pin goes red. |
| RT1082-06 | P2 | **fixed** — no 53/23 claim survives anywhere; re-measured 51 and 22. |

## Authorizations

None recorded.

## Appendix — unrelated, untriaged

Not a finding, and outside this round's scope: `docs/directory.md`'s prose for
`src/lib/solicitation/` still describes the pre-#1082 call graph. The fix
recorded this as D6/R3 "RAISED, NOT TAKEN" because the file is outside
`allowed_edit_surface` and `ci:directory-map` checks row presence rather than
prose. Recorded here only so it is not lost.

---

# Root dispositions — written by the orchestrator, not by the pass

Added at `c6d80358`. `findings.json` carries a `disposition` per finding and no
field for reasoning, so the reasoning lives here. Every round-2 finding is
`fixed`; none is rejected and none is `accepted-risk`.

## Provenance, stated before the dispositions

Round 2 measured the tree at **`aa3fab6e`**. The sidecar's `head_sha` and
`intake_sha256` are advanced to **`c6d80358`** on this basis, which a later
reader should re-check rather than take:

> `git diff aa3fab6e..c6d80358 -- 'src/**/*.ts'` contains **zero executable
> lines**. Every round-2 finding was about prose, and the only code-file change
> in the fix commit is a docblock — which INV-R2-05 established independently
> for the production file ("the fix commit's production diff to
> `ask-generation.ts` is COMMENT-ONLY").

So the mutation inventory above still describes the code at `c6d80358`. The
mutations themselves ran at `aa3fab6e`; `generated_at` and the inventory rows
preserve that, and this section is the only place the two heads are
distinguished, because the schema has no field for it.

The owner authorised this disposition on 2026-09-03, having been offered and
declined the alternative — a fresh pass at `c6d80358` under a new slug.
`round-start` refuses a third round on this run by design, and step 7.5 sends a
round-2 P0 to the owner with no round behind it. That is the path taken.

## RT1082-07 (P0) — fixed

Accepted in full; the diagnosis is exact. The retraction of one unmeasured
adjective asserted a second one three clauses later, and the spec axis's own
wording ("Today this is inert") already said so.

Fixed in the order the finding implies — **the mutation first, the prose
after**. `clearRefusalCalls` was reverted to the one-armed `mockClear` in the
root session and the suite ran 51/51 green; only then was the sentence
rewritten. The arch-review-log bullet now retracts the second claim explicitly,
records BOTH helpers as inert-today trap-removers, and carries the transferable
rule — RUN THE MUTATION BEFORE WRITING THE ADJECTIVE — in place of a third
adjective.

The test docblock was rewritten too, beyond the finding's ask. The finding
judged it defensible as prospective rationale; it opened "A ONE-ARMED CLEAR IS
THE TRAP THE SORT ABOVE EXISTS FOR", which reads present-tense to the same
reader. Both helpers are KEPT, as the finding recommends.

## RT1082-08 (P1) — fixed

Re-measured on `b9fb9601..c6d80358` by first non-whitespace token: 27 code + 66
comment + 3 blank, confirming the finding's 66 exactly.

The fix follows the prescription the #1080 row already carries rather than
patching the number: **the comment count is no longer quoted at all**, because
any prose fix — including this one — falsifies it again. The row quotes the half
that does not move under a prose edit (27 code), gives the ratio as
approximate, gives the derivation command, and tells the reader to re-derive.
The stale 1.5x ratio in deviations D1 is superseded by the arch-log row, which
is the durable owner of the figure.

## RT1082-09 (P1) — fixed

Both halves accepted. The two bare citations at `plan:55` are deleted,
including the unresolvable `:1632` — the finding's re-anchoring is right
(`regenerateAsk` is declared at `:1486`, its call site at `:1674`).

The banner is replaced by the rule that is actually true, and that the intake's
surviving citations already obeyed: **a file this branch EDITS is cited by
symbol; a file it does not touch may be cited by line.** Audited mechanically
across all six branch files afterwards — 0 violations, and the three survivors
(`restraint-policy.ts:440-448`, `write.ts:368`, `write.ts:296`) all point at
untouched files and all resolve.

The finding's observation that `prevalidate-plan.py` reports "0 citations
checked" for a bare-citation plan, making its PASS vacuous, is now recorded in
the banner itself — so the next reader does not trust that check the way this
branch did.

## RT1082-10 (P2) — fixed

Accepted: the desync refutation answered appendix item A4, not F2, and the
reporting axis had said plainly it could not identify a mechanism.

D6/R2 is rewritten to say so, and the rejection now rests only on the evidence
that speaks to an unexplained intermittency — run volume, across both heads and
all four observers:

| Observer | Head | Runs | Failures |
|---|---|---|---|
| spec-correctness axis | `4f39fbd2` | ~102 | 2 |
| root | `4f39fbd2` | 60 | 0 |
| root | `aa3fab6e` | 80 | 0 |
| red team round 2 | `aa3fab6e` | 200 | 0 |

The finding is recorded as **unexplained rather than solved**, with that table
named as the baseline if it recurs, and the two signatures the finding
describes — a `(tx, [])` set call in the stale-CAS case, and `refusalCalls()`
short by one — preserved as the shapes to look for. The vitest desync claim is
retained where it belongs, in the `refusalCalls()` docblock as justification for
indexing `invocationCallOrder`, since this round re-verified it true in
`@vitest/spy@4.1.7`.

## RT1082-11 (P2) — fixed

Fixed by correcting the RULE rather than the citation, which is what the
finding's own framing points at — it recorded convention drift, not a wrong
citation, and noted the range covers exactly the cap logic.
`restraint-policy.ts` is untouched by this branch, so under the corrected rule
the citation is legal and stays. That rule is now the one stated in the plan
banner, the intake and this section, so the self-contradiction the finding
identified is closed in both directions.
