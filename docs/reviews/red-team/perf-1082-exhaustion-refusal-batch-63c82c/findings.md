# Red team — #1082, the generation-exhaustion Refusal batch

- **Run** `feature-perf-1082-exhaustion-refusal-batch-63c82c`, round 1 of a
  FRESH pass (the previous pass's two rounds are closed).
- **Branch** `perf/1082-exhaustion-refusal-batch`
- **Fork / merge-base** `862a039d1a9ffc1f2f7b048eb4d9b4101fa13fa9` (`origin/main`)
- **HEAD measured** `a40fe38d20dc3bfe246744a43579c718d2a5a967`
- **Risk** high · **Status** `OPEN_P1`

**Why this pass exists.** `red-team-status.mjs` refused the previous sidecar
after a rebase pulled #1090, #1091 and #1093 from main; #1093 added 141 lines to
`src/lib/solicitation/restraint-policy.ts`, a module the changed lane's stated
bound depends on. Every finding below was produced against `a40fe38d`. The
previous pass's report, measured at `c6d80358`, is preserved in git at
`git show a40fe38d:docs/reviews/red-team/perf-1082-exhaustion-refusal-batch-63c82c/findings.md`;
its 11 findings were re-read but not re-derived, and none is restated here.

**A note on the slug.** `deriveIdentity` in `red-team-status.mjs` derives the
slug from the BRANCH NAME alone, so a feature-lane re-run on the same branch
cannot have a new one. This report is written to the path the checker computes.

## Findings

| Severity | Where | Finding |
|---|---|---|
| P1 | `docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-deviations.md:17` | D1's "27 code lines, **40 comment lines** and 3 blank — measured at HEAD … the reasoning is 1.5x the code" is false at HEAD: 27 / **68** / 3, ratio **2.5x**. Triage T16 marks this exact figure FIXED and the arch-review-log row was corrected; its twin in the deviations doc was not, and now contradicts that row's "two to three lines of reasoning per line of code". |
| P2 | `docs/reviews/perf-1082-exhaustion-refusal-batch/triage.md:96` | The new LIVING/DATED scope clause enumerates both buckets and puts the branch's own deviations doc (and the arch-review-log row it wrote) in neither — the gap the P1 above survives in. |

Full arbiter reasoning for both is in `findings.json`.

## 1. The bound chain, re-derived on the rebased tree — HOLDS

The branch asserts in five places that `holes` is bounded by `BATCH_CAP` (25),
not `MAX_DATA_ROWS` (5,000). Re-derived link by link at `a40fe38d`, not taken
from the branch's own statement of it:

1. `settleGenerationExhaustion`'s hole query filters `ask.status = 'send'` for a
   single `batch_id` under both tenant predicates
   (`src/lib/solicitation/ask-generation.ts`, the `holes` SELECT). No `LIMIT`,
   so the cap has to come from the writer.
2. `solicitation_asks` has exactly TWO write statements in the whole production
   tree: the `jsonb_to_recordset` INSERT in `commitAskDecisions`
   (`src/lib/solicitation/batch-builder.ts`), which takes `status` from
   `decision.decision`, and one UPDATE that sets `agent_run_id` and nothing
   else. Searched: every occurrence of `solicitation_asks` under `src/` and
   `worker/`, excluding `__tests__`. No other producer of a `send` ask exists.
3. `decisions` reaches `commitAskDecisions` from ONE call site, and its only
   source is `evaluateBatch(candidates, …)`.
4. `evaluateBatch` (`restraint-policy.ts`) returns early when
   `eligible.length <= BATCH_CAP` and otherwise keeps `.slice(0, BATCH_CAP)`,
   re-deciding every other `send` as `velocity_banked`. `BATCH_CAP = 25`.
5. A batch cannot be rebuilt past the cap: `buildSolicitationBatch` takes the
   batch row `FOR UPDATE` and returns `already_built` on a non-null `built_at`
   before it evaluates anything.

**#1093 did not falsify this.** It rewrote `resolveVertical` — adding an
exact-match `SUBCATEGORY_VERTICALS` table ahead of the retained keyword matcher —
and added `SUBCATEGORY_VERTICALS` itself. It did not touch `evaluateBatch`, the
cap, or any writer of `solicitation_asks.status`. Verified by reading the #1093
diff of `restraint-policy.ts` directly, not from its commit message.

**Verdict: the corrected number survives the rebase. 25, not 5,000. No P0.**

## 2. The citation rule's third form, and its scope clause

The rule at HEAD is unqualified: **cite by symbol, always**, governing LIVING
documents and not DATED EVIDENCE.

**The historical claim it rests on is TRUE, checked rather than assumed.** At
`862a039d^` the cap logic sits at `restraint-policy.ts:440-448`; at `a40fe38d`
the byte-identical block sits at `:579-587`. #1093 moved it, the branch never
touched the file, and the line citation the round-2 fix had just added went
stale — exactly as the commit message says.

**The audit claim is TRUE as stated.** Zero `path:line` citations remain in the
plan, both intake copies (byte-identical), the triage file, `ask-generation.ts`
and both test files. The four `:440-448` / `:579-587` occurrences are narrative
about the falsification, not citations. Every backtick-quoted identifier in
those documents was re-resolved against HEAD — 127 checked, 122 resolve; the
five that do not are two SHAs, two intake schema field names, and
`recordOutreachWithheldRefusals`, a symbol the plan names precisely to say it
was NOT created.

**The tool claim is TRUE.** `prevalidate-plan.py` on the plan reports
`CITATIONS: 0 checked, 0 unresolved` → `PASS`, so its PASS is vacuous there,
which is what the plan says about it.

**Where the third form is still incomplete: the scope clause's enumeration.**
See RT1082R3-02. The LIVING/DATED distinction itself survived attack — the
operative test ("does this assert about the current tree, or record a measured
SHA?") sorts every document the clause names correctly — but the enumeration
omits the branch's own deviations doc, and that omission has a live consequence
(RT1082R3-01), so it is not cosmetic.

## 3. Mutations, re-run on the rebased tree

11 mutations, all journaled and restored. Baseline at HEAD confirmed first:
unit **51/51**, live-DB **22/22**.

| # | Mutation | Result |
|---|---|---|
| M1 | revert the batching — write inside the loop, drop the post-loop call | **killed** (2 cases) |
| M2 | hoist the set write off the transaction — `writeRefusalEvents(sql, …)` | **killed** live-DB (3 cases); unit lane blind |
| M3 | drop one collected input — `refusals.slice(1)` | **killed** (2 cases) |
| M4 | wrong category — hard-code `'unsafe_content'` in the builder | **killed** |
| M5 | wrong subjectType — `'solicitation_ask'` | **killed** (2 cases) |
| M6 | `occurredAt: 'transaction_time'` | **killed** unit (2) AND live-DB (4) |
| M7 | wrap the write in `if (refusals.length > 0)` | **killed** (1 case, the design pin) |
| M10 | `allRefusalCodes: []` instead of `null` | **killed** |
| M11 | wrong lane — `refusalSource: 'ask_withheld'` | **killed** |
| M8 | replace the `invocationCallOrder` sort with plain concatenation | **survives — equivalent, proof in the sidecar** |
| M9 | revert `clearRefusalCalls` to the one-armed `mockClear` | **survives — equivalent, proof in the sidecar** |

**The branch's claim about M8 and M9 is the one it now makes, and it is
correct.** Both docblocks say "INERT TODAY … MEASURED, NOT ASSUMED" and quote
51/51. Re-measured independently at `a40fe38d`: 51/51 both times. The earlier
"load-bearing" claims are gone from HEAD; neither replacement asserts a third
one. No finding.

**M2 is the one worth reading twice.** It is invisible to the unit lane (the arm
is mocked) and killed in the live-DB lane by the NEW abort case *and* by two
pre-existing cases. That reproduces the branch's own honest note that the new
case is not the only guard, and settles the converse the note does not claim:
the same-transaction guarantee is genuinely covered, from three directions.

## 4. Did the rebase break anything semantically? — NO

#1093 changed `resolveVertical`'s resolution order (closed table first, keyword
matcher retained as fallback). The solicitation ask-generation lane reads it in
exactly one place, `assembleInterpolation`, to fill the `vertical`
interpolation input. Two reasons it cannot couple to this branch:

- `settleGenerationExhaustion` — the only function this branch changed — never
  calls `assembleInterpolation`. Its fills write `interpolationInputs: {}` by
  construction, because the asks were never assembled.
- The changed suites' only category fixture is `'restaurant'`, lowercase free
  text and not a member of the 92-item vocabulary, so it still resolves through
  the retained keyword matcher to `food_and_drink` exactly as before.

Both suites green at HEAD confirms it empirically; the above is why.

## 5. Volume

**100 consecutive runs of `src/lib/solicitation/__tests__/ask-generation.test.ts`
at `a40fe38d` under the isolated environment: 0 failing runs, 51/51 every time.**

This is a fourth independent measurement against the reporting axis's 2-in-~102
at the much older `4f39fbd2`. The deviations doc's D6/R2 table should gain the
row; the rejection it supports is unaffected.

## 6. Fragile assertions — one, already adjudicated

`expect(mocks.writeRefusalEvents.mock.calls[0]![1]).toEqual([])` in the
"no holes" case pins a structural fact (that the call happens at all) rather
than a behavioural one, and M7 confirms it is the only thing that fires on an
outcome-identical `if (refusals.length > 0)`. It is not a new finding: the test
labels it "A DESIGN PIN, NOT THE TITLE'S PROPERTY", separates it from the three
behavioural assertions above it, and states the remedy (delete the pin, do not
weaken the test). That is the disposition of RT1082-05 from the previous pass,
verified as landed. Nothing else in the changed tests asserts an absence-of-tag
proxy, an exact string count on rendered output, or an order with no contract —
the one order assertion (`subjectId` sequence) pins the set arm flattening in
its input order, which is a stated property of the change.

## 7. Missed siblings — searched, none found

Pattern searched: a single-row `writeRefusalEvent` call reachable inside a loop
or a per-element iteration. Scope: every `writeRefusalEvent`/`writeRefusalEvents`
reference under `src/` and `worker/`, excluding `__tests__` and the owning
module `src/lib/refusals/write.ts`.

Nine production call sites, matching the triage's count. Seven single-row:
`ask-generation.ts` (the three render writers, through
`recordOutreachWithheldRefusal`), `dispatch.ts` (`commitWithhold`),
`approval.ts` (`latchHalt`), `auto-approval/suspension.ts`
(`suspendAccountAutonomy`), `publisher/auto-policy-downgrade.ts`, and
`response-generation/persist.ts` twice (`recordPolicyGateRefusal`,
`recordModerationAndHold`). Two set-arm: `batch-builder.ts`
(`commitAskDecisions`) and this branch's new one.

No enclosing loop at any of the seven, and no enclosing function that is itself
driven per-element: `commitWithhold` is reached from `dispatchOutreach`, which
is one job per outreach row, not a fan-out. **Zero siblings — a sound search
with a nil result.**

## 8. Operational completeness — nothing owed

The diff adds no `catch`, no swallow, no log line, no Sentry signal and no error
class. The failure mode is unchanged in kind and reduced in count: one throw out
of `writeRefusalEvents` instead of up to N, propagating out of the same
`sql.begin` to the same failed-hook. No rule row in
`docs/runbooks/beta-launch-alerting.md` becomes stale and none is owed.

Two adjacent claims re-checked because the batching could have moved them:
with `REFUSAL_LEDGER_ENABLED=false` the warning count is unchanged (one per
episode either way — `warnedThisEpisode` is module-level and latched), and the
empty case still warns NOT AT ALL, because `writeRefusalEvents` returns on
`inputs.length === 0` before it reads the flag.

## 9. Method, and one deviation to record

Environment isolated through `mutation-runner.mjs env` (allowlist:
`PATH`, temporary `HOME`, `TMPDIR`, `NODE_ENV`, `CI`, `MOCK_EXTERNAL_APIS`, and
a validated localhost `TEST_DATABASE_POOL_URL`). Watchers checked clean before
the round opened.

**Deviation 1 — whole-file runs instead of `-t` per case.** Each mutant was run
against the whole changed test file rather than one `-t`-selected case, so
`assert-one-test` was not used. This is strictly more evidence per run (it names
every case that fires, which is how M1, M3, M5 and M6 were found to be killed by
more than one) and it removes the `-t`-regex mismatch hazard that check exists
to catch. Baselines were established the same way.

**Deviation 2 — the dotenv swap closed early.** `dotenv-swap` was opened for the
round, but calling `finalize` after each mutation (to restore the file
immediately) also closed the swap, so mutations after M1 ran with the real
`.env.local` on disk beneath the scrubbed process environment. Recorded rather
than hidden. It does not change any result here: the unit suite mocks every
external module and touches no database, the live-DB runs were pointed at the
same validated localhost database explicitly, and the M1 run (swapped) and the
M3-M11 runs (not swapped) produced identical 51/51 baselines.

**Deviation 3 — the journal was reset to open round 1.** The worktree's journal
was at `round: 2` from the previous, now-closed pass, so `round-start` refused.
It was verified clean first (every mutation `restored`, dotenv closed, no active
supervisor), archived to `.feature/red-team-journal.prev-run-63c82c.json`
(gitignored), and replaced with an empty round-0 journal. The 2-round cap is a
per-RUN bound, not a per-worktree one; this is round 1 of a new run.

**Budget.** 17 of 30 runs used. No candidate was left unexecuted; there are no
`skipped-budget` rows.

**Restoration.** `finalize` reports every journaled process group empty (17
recorded), 11 mutations restored, journal closed, no dotenv backup outstanding.
`git status --porcelain` is empty except this report's two artifacts.

## Authorizations

None.

---

# Root dispositions — written by the orchestrator, not by the pass

Both findings `fixed`. Neither rejected, neither `accepted-risk`.

**Provenance.** The pass measured `a40fe38d`. `head_sha` is advanced to
`b5e94ca6`, the fix commit, on a basis a reader should re-check rather than
take: `git diff a40fe38d..b5e94ca6 --name-only -- src worker` is **empty**. The
fix touched five files, all documentation — this report, its JSON sidecar, the
triage file, the deviations file and the arch-review-log row — so the mutation
inventory above still describes the code it measured. No rebase and no
dependency change sits between the two SHAs, unlike the previous run's
extrapolation, which is why that one was retired and replaced by this fresh
pass instead.

**A note on why this SHA is recorded in a FOLLOWING commit, not this one.**
Writing HEAD into a file that is part of HEAD changes HEAD — the first attempt
amended the fix commit to carry its own SHA and produced a dangling reference
to a commit that no longer existed. The sidecar therefore names the fix commit
`b5e94ca6`, and the single commit after it touches nothing but this report and
its JSON sidecar, which `red-team-status.mjs` tolerates by design. A
self-referential hash needs one level of indirection; an amend cannot supply it.

## RT1082R3-01 (P1) — fixed

Accepted in full, including the sharpest part of the reasoning: **"T16's FIXED
overstates what was fixed."** It did. The arch-review-log row was rewritten to
stop quoting the comment count and its twin in deviations D1 was never touched,
so the branch's two living documents contradicted each other on one figure — the
row saying "two to three lines per line of code", D1 saying 1.5x.

Re-derived at HEAD by the branch's own prescribed method: 27 code, 68 comment,
3 blank, ratio 2.5x. The finding's numbers are exact.

Fixed by the rule rather than by the number. D1 no longer quotes the count at
all; it names the arch-review-log row as the figure's **single owner** and tells
the reader to re-derive there. Patching 40 → 68 would have produced the same
defect on the next prose commit, which is how this figure already moved three
times (40 → 66 → 68).

The finding's precedent citation is apt, and it was on this branch's reading
list: the #1080 row records "The same 79 still stands, uncorrected, in
`.feature/deviations.md` § D5" as a known residual. #1082 repeated the omission
one ticket later. It is now arch-review-log bullet (h): **a figure that moves
under prose edits needs one owner, and every other mention points at it** —
because "fix both" is exactly what failed here.

## RT1082R3-02 (P2) — fixed

Accepted, and it is the more useful of the two: it explains *why* the P1
survived a sweep that claimed to cover everything. The finding is also fair
about what it could not falsify — the LIVING/DATED split itself is coherent, and
it confirmed the commit's audit claim was true within its stated scope. The
defect was the scope, not the rule.

Fixed beyond the finding's suggested remedy. It proposed naming the deviations
doc and the branch's own arch-log row in the LIVING list — a one-word repair
that would leave the next unlisted document in the same gap. The clause is now
stated as a **test** rather than a list:

> Is this document asserting what is true NOW, or recording what was measured
> THEN?

with the classification of this branch's documents given as an application of
that test rather than as its definition. Enumerations of a category are how
things fall out of it, which is precisely what happened here.
