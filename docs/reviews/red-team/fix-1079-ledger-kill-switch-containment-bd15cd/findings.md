# Red team — `fix/1079-ledger-kill-switch-containment`

| | |
|---|---|
| Mode | feature (dispatched inside `/feature` step 7's review wave) |
| Round | 1 of 2 |
| Risk | high (from `.feature/intake.json`, sha256 `bd6f73ef…dcbf5e65`) |
| Fork / merge-base | `f797d25064c31997dfe400414baf99967b63315f` |
| Head | `659810f23660fd12cc6c8a6223fe8bfc04547d58` |
| Mutation runs used | 18 of 30 |
| **Status** | **`OPEN_P0`** |

## Verdict in one paragraph

The engineering claims this branch makes about itself are **true and they are
proven true**. Both claims the dispatch flagged as most attackable survived a
direct attempt to break them: the zero-resolver-invocation assertion is not
vacuous (deleting the guard makes it fail *with the resolver's recorded argument
in the failure message*, so the fixture demonstrably reaches the resolver), and
the property test is a real biconditional whose **both** arms produce
generator-derived counterexamples. All eight promised test titles are present
verbatim **and** each one has at least one confirmed kill, so the verify gate's
title-only match is not hiding an empty assertion anywhere. Ten of twelve
inventory rows are killed; nothing is inconclusive, nothing was skipped for
budget, and no mutant survived that measures this diff.

The one blocking finding is **documentation, not code**: the rewritten guard
docblock re-publishes a mutation-testing result that is now false for two of its
three guards — and the branch's *own new test* is what falsified one of them.

## Severity table

| ID | Sev | Duty | Where | Finding |
|---|---|---|---|---|
| RT-1 | **P0** | 3 | `worker/jobs/response-generation/persist.ts:703` | The guard docblock re-asserts "deleting guard 1, 2 or 3 individually changes no outcome and kills no test". False for guard 1 (falsified by this branch's own new test) and false for guard 3 on **both** halves. True only for guard 2. |
| RT-2 | P1 | 5 | `docs/runbooks/beta-launch-alerting.md:54` | The refusal-ledger alert rule row is contradicted on its threshold/cadence facet and still asserts in bold that the warning is the ledger's only gap detector, with no mention of the blind spot this branch deliberately opened. |
| RT-3 | P2 | 3 | `worker/jobs/response-generation/persist.ts:743` | `write.ts:488-492` — the citation the branch treats as its governing rule — does not resolve at HEAD; the rule is at `:525-529`. Already logged by the async axis; severity lowered to avoid double-counting. |
| RT-4 | P2 | 2 | `worker/jobs/response-generation/__tests__/persist.test.ts:55` | The new file-global `../auto-approval` mock keeps a dictated gate verdict in module state that only the last `describe` resets. Latent, not present. |

---

## RT-1 (P0) — the docblock's recorded mutation result is now false

`persist.ts:703-707` says:

> Branch review round 1 mutation-tested the original three: deleting guard 1, 2
> or 3 individually changes no outcome and kills no test, because the resolver
> guard already covers each case.

This branch did not leave that sentence alone. It renumbered it and then
explicitly bounded the staleness risk to guard 4 — *"THAT RESULT IS ABOUT THOSE
THREE AND THE RESOLVER GUARD (now numbered 5) AND NOTHING ELSE — guard 4
post-dates it (#1079)"*. That re-scoping publishes the claim as **current at
659810f2**. Measured, one guard at a time:

| Mutation | Result | Evidence |
|---|---|---|
| M10 — delete guard 1 (`if (held) return;`, `:776`) | **KILLS** T7 | `expected "vi.fn()" to not be called at all, but actually been called 1 times`, call recorded as `["moderation_flagged","moderation_held"]` |
| M11 — delete guard 2 (`if (autoDecision.approved) return;`, `:777`) | **survives**, 82/82 | claim holds here |
| M12 — delete guard 3 (`if (!isGenuineAutoCandidate(…)) return;`, `:778`) | **KILLS** a pre-existing case, **and changes the outcome** | `expected [ { …(9) } ] to have a length of +0 but got 1` — a `policy_gate_held` row **is written** |

Two distinct defects sit inside one sentence:

- **Guard 1 was falsified by this commit.** The test it now kills is
  `the held_draft lane still writes its refusal row and still aborts on a writer
  fault with the flag on` — added *by this branch*, and its
  `expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled()` did not exist when
  round 1 took its measurement. The commit that re-asserts the claim is the
  commit that breaks it.
- **Guard 3 fails both halves**, and was already false at the fork point (the
  killing test predates the branch at `f797d250`). It is re-published rather
  than introduced — but it is re-published under a sentence that just told the
  reader it had been re-checked.

**Why P0 and not P1.** This is not a stale line number and not a style
objection. The docblock's stated job is to tell the next reader which guards are
safe to delete as "defence in depth". As written it licenses deleting guard 3,
and doing so writes a spurious `policy_gate_held` Refusal for a structural
non-candidate — a data-correctness defect in the ledger the Restraint tab
renders. The skill's rubric puts a misleading false claim at P0, and the branch
holds itself to exactly this standard three lines further down:

> an earlier version of this docblock claimed "each answers a different
> question", which was false and is corrected here rather than left to mislead
> the next reader.

**No runtime behaviour is wrong.** The fix is a docblock correction naming which
guard is actually unpinned (guard 2, with the proof) and what now pins the other
two.

## RT-2 (P1) — the alerting runbook overstates the ledger's gap detector

All six facets compared against the signal emitted at HEAD:

| Facet | Verdict |
|---|---|
| Signal identity | matches — `captureMessage`, `tags.subsystem=refusal_ledger` via `warnLedgerDisabled` |
| Filter | matches; pre-existing ambiguity **not** added here (`withLedgerAttribution` also tags `subsystem:refusal_ledger` at level `error`, and its capture body is unchanged by this diff — only its docblock moved) |
| Level | matches (`warning`) |
| Grouping title | n/a |
| **Threshold / cadence** | **CONTRADICTED** |
| Destination action | matches (Discord) |

The row says the warning fires *"once per disabled episode whenever
`REFUSAL_LEDGER_ENABLED=false` and a write is attempted"*. After this branch,
guard 4 returns **before any write is attempted** on the `policy_gate_held`
lane, so with the flag off that lane contributes nothing to the episode.

The branch records this as an accepted cost in three places (intake
`observability[3]`, the arch-review-log row, the guard-4 docblock), and I
verified the compensating claim is **true**: the `held_draft` lane at
`persist.ts:930` and all six other production write sites still call
`writeRefusalEvent(s)` with no flag guard, so they still warn. What was not
updated is the runbook — the operator-facing document that specifies the alert
rule and asserts in bold *"**This is the only signal that the ledger has a
gap**"*. It now overstates that coverage with no mention of the blind spot.

**Scope note for the adjudicator:** `docs/runbooks/beta-launch-alerting.md` is
not in the intake's `allowed_edit_surface`, so this is a scope decision for the
root, not an implementer miss. The fix is one sentence.

## RT-3 (P2) — a stale citation, deliberately not double-counted

At `659810f2`, `src/lib/refusals/write.ts:488-492` is the close of a docblock
plus three fields of `interface RefusalEventRow`. The empty-input no-warn rule
the branch repeatedly cites as its governing constraint is at
`src/lib/refusals/write.ts:525-529`. The same commit that cites `488-492`
shifted it, by inserting 36 lines above it. Four occurrences: `persist.ts:743`,
`write.test.ts:646`, `write.test.ts:698`, and
`.claude/reference/arch-review-log.md:1510`.

**Severity set below the rubric on purpose.** In isolation a stale line number is
P1. The async review axis already recorded this defect twice in
`docs/reviews/finding-checklists/async.md` at `[low]` during this same wave, and
my independently derived numbers agree with theirs exactly (`:525-529`). Filing
it as a blocking P1 here would count one defect twice across two axes and force
user adjudication on an already-triaged low. Recorded at P2 with the
verification attached so the root can dedupe. Both axes converge on the same
fix: cite the owner **by symbol**, not by line range.

Observed and **not** filed: every `path:line` citation in the intake
(`write.ts:353-359`, `:364-368`, `:488-492`, `:369`; `persist.ts:788-807`,
`:877`) resolves against the fork point rather than HEAD — correct and expected
for a locked pre-change contract.

---

## What I attacked hardest, and what held

### Claim 1 — "with the flag off the vocabulary resolver is invoked ZERO times"

The dispatch's concern was that an absence assertion passes on any fixture
defect. It does not here, and the evidence is unusually direct: under **M1**
(guard 4 deleted) the test fails with

```
expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: 1st vi.fn() call: [ [ "triage_high_severity" ] ]
```

The recorded argument proves the fixture reaches the resolver on the policy lane
with a real, non-veto block reason — a wrong tier, wrong origin lane, null
threshold, `held` or `approved` would each have produced zero calls here too.

The positive control is real and it is the **same fixture** (identical
`seedReview` + `makeInput`; the flag value is the only difference). Under **M2**
(guard 4 inverted) it fails with `expected 1 times, but got 0 times`. A vacuous
control could not do that.

### Claim 2 — the property test is a biconditional over the flag

It depends on its generated input on **both** arms:

- **OFF arm** — M1 → counterexample `[["policy_not_enabled"], false]`
- **ON arm** — M8 (array sorted before the resolver call) → counterexample
  `[["policy_not_enabled","moderation_flagged"], true]`, killing the "verbatim
  and in order" clause specifically.

Also checked for latent flakiness, since a throwing resolver would make this
test intermittently red: all 22 members of `POLICY_GATE_HELD_REFUSAL_CATEGORIES`
are mapped, and all 15 non-`null` members appear in
`AUTO_APPROVAL_BLOCK_PRECEDENCE`, so no generated subset can reach the resolver's
`unmapped_…` or `unranked_…` throws. The generator is safe today; #1080 owns the
structural enforcement.

### The eight promised titles

The verify gate matches title text only and never checks that a title asserts
anything. All eight are present verbatim, and **each has a confirmed kill**:

| Promised test | Killed by |
|---|---|
| T1 off ⇒ zero resolver calls | M1 |
| T2 on ⇒ exactly one + row | M2 |
| T3 capture once, tags, same instance | M3 |
| T4 still aborts, no response row | M7 |
| T5 one warning per disabled episode | M9 |
| T6 empty input: no statement, no warning | M5 **and** M6 |
| T7 `held_draft` lane pin | M10 |
| T8 the flag decides the resolver call count | M1 **and** M8 |

M7 deserves a note: it is the swallowing `try/catch` around the resolve — the
exact alternative shape the branch documents as rejected. It fails T4 with
`promise resolved "{ kind: 'persisted' }" instead of rejecting`. The
over-application guard does the job it claims.

### The purity contract

Both halves are load-bearing and both are pinned:

- **M5** — predicate warns (`if (!on) warnLedgerDisabled();`) → T6 fails,
  `expected [ Array(1) ] to have a length of +0 but got 1`.
- **M9** — predicate mutates the latch (`if (on) endDisabledEpisode();`) → T5
  fails with its own message, *"the predicate did not end the episode"*.
- **M6** — flag read hoisted above the `inputs.length === 0` return → T6 fails.
  The documented ordering is real.

## Duty 4 — missed sibling cases: **zero, from a sound search**

**Pattern searched.** The shape #1079 fixes is *a caller performing ledger work
that can throw, in front of `write.ts`'s flag read, inside the deciding
transaction.*

**Searches run**

1. `grep -rn "refusals/vocabulary" --include="*.ts" src worker` (minus `__tests__`) — every production importer of the vocabulary module.
2. `grep -rn "writeRefusalEvent\b\|writeRefusalEvents\b" --include="*.ts" src worker` — every production call site of either write arm.
3. `grep -n "^export function\|throw new Error" src/lib/refusals/vocabulary.ts` — every throwing export.

**Scope** `src/`, `worker/`. **Exclusions** `__tests__/` (not production) and
`src/lib/refusals/write.ts` itself (the owner).

**Result.** `resolvePolicyGateRefusal` is the **only** throwing export in the
vocabulary module, and its only production consumer is
`worker/jobs/response-generation/persist.ts`. The six sibling write sites each
derive their category by a **total map index over a closed union** — no throwing
call anywhere in front of the flag read:

| Site | Derivation |
|---|---|
| `src/lib/solicitation/dispatch.ts:1474` | `OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES[…]` |
| `src/lib/solicitation/ask-generation.ts:698` | `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES[reason]` |
| `src/lib/solicitation/batch-builder.ts:670` | `ASK_WITHHELD_REFUSAL_CATEGORIES[decision.reason]` |
| `src/lib/solicitation/approval.ts:637` | `BATCH_HALTED_REFUSAL_CATEGORIES[input.reason]`, null-checked before the write |
| `src/lib/auto-approval/suspension.ts:331` | `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES[…]` |
| `worker/jobs/publisher/auto-policy-downgrade.ts:208` | `AUTO_POST_REVOKED_REFUSAL_CATEGORIES[…]` |

**Zero true siblings.** One near-miss recorded and rejected as a finding:
`batch-builder.ts:670` builds its whole `decisions.flatMap(…)` array eagerly as
the *argument* to `writeRefusalEvents`, so that work does run in front of the
flag read — but it is pure, total and non-throwing, so it cannot abort a
transaction. The intake's non-goal ("do not extend attribution to the other six
write sites — that is #1083") is about attribution, not containment; on
containment there is nothing to extend.

Also verified while there: the intake names the six sites without directories.
All six **line numbers resolve correctly**, but `suspension.ts` is
`src/lib/auto-approval/` (not `agents/governor/`) and `auto-policy-downgrade.ts`
is `worker/jobs/publisher/` (not `src/lib/refusals/`). Recorded as an
observation, not filed.

## Duty 2 — fragile assertions: none of the three named shapes

Searched the three changed test files for absence-of-tag proxies, exact string
counts on rendered output, and order assertions with no ordering contract.

- **Every absence assertion added by this diff carries a proven positive
  control** — T1 by T2 (killed under M2), T6 by its trailing non-empty batch
  (killed under M5 and M6), T5 by its `resetRefusalLedgerWarningForTests`
  new-episode arm (killed under M9), T7 directly (killed under M10).
- The single order assertion — `toEqual` on the resolver argument in T8 — has an
  explicit ordering contract in `vocabulary.ts` ("the input VERBATIM, in its own
  order") and is killed under M8.
- Tags are compared with `toMatchObject`, not exact equality.
- `ALL_BLOCK_REASONS` is derived via `Object.keys(...)` rather than hardcoded,
  and its `// 22 today` comment is accurate (15 mapped + 7 `null`).

The one thing worth recording is RT-4, a latent state-leak hazard rather than a
fragile assertion.

## Other invariants re-derived against HEAD

| Claim | Verdict |
|---|---|
| `write.ts` is the only production module spelling `INSERT INTO refusal_events` | **true** — only `write.ts:432` and `:580` |
| `src/app/api/dashboard/refusals/route.ts:76` keeps its own literal flag spelling for `ci:env-registry` | **true** — `readFlagEnabledByDefault('REFUSAL_LEDGER_ENABLED')` |
| `REFUSAL_LEDGER_FLAG` is still used in `persist.ts` (no dead import) | **true** — `persist.ts:852`, in the Sentry tags |
| `held_draft` lane gains no guard and no behaviour change | **true** — `persist.ts:930`, unguarded |
| The resolver returns `null` (not a throw) for an empty set, as guard 2's redundancy argument requires | **true** — `vocabulary.ts:627` |
| `withLedgerAttribution`'s capture body is unchanged by this diff | **true** — docblock-only hunk |

## Method and environment

- Baselines and mutants ran under an identical isolated environment built by
  `mutation-runner.mjs env` (allowlist: `PATH`, temporary `HOME`, `TMPDIR`,
  `NODE_ENV`, `CI`, `MOCK_EXTERNAL_APIS`, plus a **validated localhost**
  `TEST_DATABASE_POOL_URL`). `.env.local` was swapped for a scrubbed copy for
  the whole mutation phase.
- Live-DB lane: the shared local Postgres at `localhost:5499` was used as-is.
  `pnpm test:db:setup` was **not** run, per the wave brief. Gate invocations
  carried `MAX_PARALLEL=2 VITEST_WORKERS=2`.
- **One deviation, recorded:** the first integration baseline silently skipped
  all 30 cases because `mutation-runner.mjs run` needs its own `--test-db`
  (passing it only to `env` is not enough — the child otherwise inherits
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1`). Caught and re-run before any
  measurement was taken. Worth knowing for the next pass: a live-DB red-team run
  that forgets this reports green mutants that never executed.
- Green baselines at HEAD before any mutation: **30/30** integration,
  **65/65** unit.
- Every mutant run was verified with `assert-one-test` except the two
  whole-suite Duty-3 doc probes (M11, M12), where the question was expressly
  *"does this kill **any** test"* and a single-test run could not answer it.
  That deviation is deliberate and is why those two rows are `excluded` rather
  than coverage measurements.
- 18 of 30 mutation runs used. Nothing was skipped for budget.

## Restoration

Every mutated file was restored to its `659810f2` blob and verified by object
id; `git status --porcelain --untracked-files=no` is empty apart from this
report directory. Untracked siblings present during the run and **not** mine:
`.feature/review-staging/` (the read-only review axes) and
`docs/reviews/finding-checklists/` (written by the root's `review-log.mjs
triage`). Neither is evidence of a failed restoration.

**The dotenv swap is still open by design** — this run does not call
`finalize`; the root owns it. `.env.local` is currently the scrubbed replacement
and the real file is at `.env.local.red-team-backup`. The root's
`mutation-runner.mjs finalize` restores it and closes the journal; every
mutation entry will be found already at its original oid and marked restored
without a write.

## Authorizations

None. No finding on this pass is `accepted-risk`.
