# Red-team — `feat/1011-refusal-outreach-render`

| | |
|---|---|
| Mode | `feature` (dispatched inside /feature step 7's review wave) |
| Round | 1 of 2 |
| Risk | `high` (from the intake) |
| Fork / merge-base | `06a163f0b4b102c88687c95862999e38a1c3f517` |
| Head | `535e0763ac6c3361db3caf08a965e7567854f350` |
| Intake SHA-256 | `38b5ced758c8abd6e380a0581033d9dcb43c584d60f4c21042e657dabbc748cb` |
| Test database | `test_1011` (localhost:5499, this run's alone) |
| **Status** | **`OPEN_P0`** |

Mutations planted **21** · killed **18** · survived **2** (one finding) · arbiter-reclassified then resolved **1**.
Mutation runs consumed **26 of 30**.

---

## Claimed evidence, re-derived

The pass was handed three claims and trusted none of them.

| Claim | Re-derived at HEAD | Verdict |
|---|---|---|
| All 23 promised titles present and active | 9 executed in `ask-generation.test.ts`, 14 in `ask-generation.integration.test.ts` — 23 total, none skipped | **TRUE** |
| Every promised title green | 23/23 passed on the baseline runs under the scrubbed allowlist environment | **TRUE** |
| Gate green, review mode, first round, no fix loop | Not re-run here (step 7.5 owns the final serialized gate); the tree at HEAD is clean and the production blob matches HEAD exactly | Not contested |

The worktree was clean at the committed head throughout, and every mutated file
was restored to HEAD's exact blob (`9fd9bd5161bf…`) before this report was written.

---

## Findings

### RT-1 · **P0** · open · Duty 1 (hand-mutation)

**The clock-POSITION invariant is pinned for only one of the four writers.**

`src/lib/solicitation/ask-generation.ts:1543` (`regenerateAsk`) and
`src/lib/solicitation/ask-generation.ts:1752` (`settleGenerationExhaustion`).

The intake's first invariant is stated for the lane, not for one writer:

> The clock is read immediately after the render DECISION and before the
> transaction opens or waits … Round 1 rejected the earlier design, which read
> the clock inside the transaction and made both columns persist time.

Two mutations restored exactly that rejected design, one writer at a time:

| Mutation | Change | Result |
|---|---|---|
| **M14** | `settleGenerationExhaustion`'s `decidedAt` read moved from before `sql.begin` to after `acquireSolicitationBatchLock` | 9/9 unit **and** 14/14 integration passed — **survived** |
| **M15** | `regenerateAsk`'s `decidedAt` read moved from before its swap `sql.begin` to after `acquireSolicitationBatchLock` | 9/9 unit **and** 14/14 integration passed — **survived** |

Why nothing noticed. Only one test measures *position* rather than column
equality — `the render lane never stamps occurred_at from the transaction, so a
slow lock does not move the decision time`. It holds the per-Business advisory
lock for 600 ms from inside the LLM round trip and then asserts
`rendered_at_ms < lockHeldAt + HOLD_MS`. That fixture drives
`generateAsksForBatch`, so it reaches `persistChildRender` (W1, and W2 through
it) and neither of the other two writers. The mutation is confirmed live against
that discriminator: **M1**, the same move applied to `persistChildRender`, was
killed by it (`expected 1788157004535 to be less than 1788157004529`).

The column-equality tests cannot substitute. `rendered_at` and `occurred_at`
move *together* under M14/M15, so `r.occurred_at = o.rendered_at` stays true —
which is exactly the property the equality tests assert. Equality proves the two
columns agree; only the held-lock fixture proves *what instant they agree on*.

**Arbiter confirmation (required, recorded verbatim in the sidecar).** Not
equivalent: the mutation changes what both columns record, from decision time to
post-advisory-lock persist time — the semantic difference the intake records as
decided and both production comments assert. Not an unexecuted branch: both
mutated statements sit on the straight-line path of transactions the passing
tests drive — `a generation exhaustion writes one refusal_events row per
outreach hole it settles as withheld` reaches the W4 statement and `a
regenerated ask writes its refusal_events row against the replacement outreach
id` reaches the W3 statement. Both wrote their rows under the mutation, so the
line executed and produced a differently-timestamped row that no assertion
inspected. Contrast M8 below, which I *did* reclassify as unexecuted once M10
proved the fixture aborts earlier; no such reclassification applies here.

**Suggested closure.** `holdBatchAdvisoryLock` already exists in the integration
suite. Extend it to `regenerateAsk` and `settleGenerationExhaustion` with the
same `rendered_at_ms < lockHeldAt + HOLD_MS` discriminator that kills M1.

---

### RT-2 · **P2** · open · Duty 1

**Two guard mutations turn the unit suite red through mock-SQL FIFO exhaustion
rather than through the behavioural assertion.**
`src/lib/solicitation/__tests__/ask-generation.test.ts:305`

Deleting the outbox-ownership CAS (**M5**) or the batch-lifecycle re-check
(**M6**) makes the run throw `batch … vanished before child persist` — the
mutant consumed queue entries the fixture never provisioned — so the trailing
`expect(writeRefusalEvent).not.toHaveBeenCalled()` never evaluates.

These tests are **not** hollow. **M7** and **M10** leave every guard intact and
hoist only the ledger write above the guard; both were killed on that exact
assertion (`expected "vi.fn()" to not be called at all, but actually been called
1 times`). The property is genuinely measured. Recorded only because the coarse
channel means those two rows would also go red for many changes unrelated to the
ledger. No action required for this PR.

---

### RT-3 · **P2** · open · Duty 2 (fragile assertions)

**The cross-writer matrix test pairs the Nth ledger call with the Nth withheld
insert positionally.**
`src/lib/solicitation/__tests__/ask-generation.test.ts:235`

`refusalCalls()[i]` is matched to `withheld[i]` by array index across four
separately-driven writers. Sound today — every call site writes its Refusal
synchronously immediately after its own insert on a sequential path, so call
order is a real contract. It is **not** one of the classes the skill names (no
absence-of-tag proxy, no exact string count, no ordering assertion over an
unordered source), and `subjectId` is separately pinned by identity via
`inserts.indexOf`, which carries the real weight. Recorded because the coupling
is implicit.

---

## Duty 2 — fragile assertions

Scanned all 23 added cases. **No P1.** Specifically checked and cleared:

- **Absence-of-tag proxies** — none; this diff renders no markup.
- **Exact string counts on rendered output** — none. Every count assertion is
  over *rows* or *mock calls*, each with a stated contract (one Refusal per
  withheld outreach).
- **Order assertions with no ordering contract** — the two positional pairings
  are RT-3, and both have a real sequential contract.
- **Timing margins.** The held-lock discriminator was checked for structural
  soundness, not just observed to pass: under the rejected design `rendered_at`
  is read only after the lock is *granted*, which cannot precede its release, so
  `rendered_at_ms < lockHeldAt + HOLD_MS` is false by construction rather than by
  luck. Observed margin under M1 was 6 ms, which is the lock hand-off latency and
  not a flake window.
- **Microsecond truncation (#520).** The suite compares `occurred_at` to
  `rendered_at` **as columns inside SQL**, never through a postgres.js
  round trip — the correct handling, and M17 confirms the comparison is live.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was present and run against both changed plan documents.

| Document | Citations | Fixtures | Result |
|---|---|---|---|
| `docs/superpowers/plans/feat-1011-refusal-outreach-render-plan.md` | 1 checked, 0 unresolved | 3 checked, 0 gitignored | **PASS** |
| `docs/superpowers/plans/feat-1011-refusal-outreach-render-deviations.md` | 7 checked, 0 unresolved | 2 checked, 0 gitignored | **PASS** |

All seven `rendered_at` reader citations in deviation **D1** were additionally
re-resolved by hand against HEAD and all seven land on the claimed construct:
`ArchivalPoller.ts:307-333`, `tenant-scope-allowlist.ts:972` (the byte-identical
SQL twin), `batch-view.ts:492` and `:511`, `release.ts:1642-1657`, migration
`092`'s redaction index, migration `091:210`'s `NOT NULL`.

**D1's central argument was independently re-derived, not taken on trust.**
The claim is that `release.ts:1654`'s untiebroken `ORDER BY o.rendered_at ASC`
survives only because its `delivery_status = 'rendered'` filter excludes every
newly-shared-instant row. Verified: `renderFailedOutcome`
(`ask-generation.ts:421-435`) returns `status: 'withheld'`, `toInsertInput`'s
non-rendered branch maps that to `deliveryStatus: 'withheld'`, and
`settleGenerationExhaustion` sets `deliveryStatus: 'withheld'` literally — so
every row a multi-row settle gives one instant is `withheld`, and the query never
sees one. `batch-view.ts:511`'s `o.id` tiebreak is real and `insertOutreachRender`
does mint `uuidv7()`. **The doc claim is TRUE.** The "standing consequence" it
records — that the protection is the filter, not the clock — is the correct
reading.

Also verified true: **D5**'s claim that the rollback twin discriminates a helper
opening its own connection. **M19** made `recordOutreachWithheldRefusal` write on
a fresh `postgres()` connection instead of the deciding `tx`; the twin caught the
surviving row (`expected 1 to be +0`). That is a real invariant-#15 discriminator,
not an argued one.

Not contested, because it is a process claim no artifact at HEAD can settle: the
arch-review-log's "15 of 23 genuinely red→green" and "gate green at 29 rows".

## Duty 4 — missed sibling cases

**Pattern searched:** a site that persists a `withheld` outreach render without
recording a paired `outreach_withheld` Refusal.

**Scope:** `src/` and `worker/`, `*.ts`, excluding `__tests__/`.
**Queries:** `insertOutreachRender`; `deliveryStatus: 'withheld'` /
`delivery_status … 'withheld'`; `writeRefusalEvent`.

| Site | Disposition |
|---|---|
| `ask-generation.ts:813` (`persistChildRender`) | Covered — W1/W2 |
| `ask-generation.ts:1604` (`regenerateAsk`) | Covered — W3 |
| `ask-generation.ts:1817` (`settleGenerationExhaustion`) | Covered — W4 |
| `dispatch.ts:1374` (`commitWithhold`) | **Explicit non-goal** — the DISPATCH withhold, owned by #1010, different reason enum |
| `outreach.ts:631` (`supersedeLiveRender`) | Not a sibling — writes `cancelled`/`superseded`, never `withheld`, and returns only `{ priorAttemptNo }` |

`insertOutreachRender` has exactly three call sites and all three write a Refusal
on the withheld branch. **Zero missed siblings.** Recorded as a sound search with
a nil result, not as an absence of risk.

## Duty 5 — operational completeness

**Scope: operator-actionable terminal or swallowed failure paths this diff adds.
It adds none.** The diff introduces no `catch` and no `.catch(` — the ledger write
is deliberately uncaught, so a migration-116 CHECK violation aborts the render
transaction, fails the BullMQ job, and reaches Sentry through `attachJobFailureSink`
(`worker/index.ts:545`, attached in the same registration loop as every other
worker). That is a pre-existing path; no new rule row is owed.

The one alert rule this lane touches already has **both halves**, both from #1009
and untouched here: the rule row at `docs/runbooks/beta-launch-alerting.md:54-65`
(`subsystem:refusal_ledger`, level `warning`, once per **disabled episode**,
routed to Discord) and the emitting signal inside `writeRefusalEvent`
(`src/lib/refusals/write.ts`). `REFUSAL_LEDGER_ENABLED` carries its rows in both
registries (`docs/eservices-variables.md:213`, `.claude/reference/env-vars.md:551`).
**No finding.**

---

## Run conditions — one precondition satisfied in substance, not by the tool

Precondition 2 (`mutation-runner.mjs watchers`) **aborted**, reporting four
processes. It is a machine-wide `ps -Ao pid=,command=` scan with no path or cwd
scoping — its own header calls the over-breadth deliberate ("a false positive
here refuses a run, which is the safe direction"). Every reported process was
resolved and **none serves this worktree**:

| PID | Working directory |
|---|---|
| 68547, 69387, 69738 | `…/startups/RepWorth` — the parent checkout |
| 76253 | `…/RepWorth-worktrees/refactor-globals-css-extraction` — a sibling |

Confirmed by a stronger check with a **positive control**: of 37,028 `lsof` rows,
**0** touch this worktree, while the same query correctly finds the sibling
worktree that *is* being served. This worktree is a sibling of the parent
checkout, not nested beneath it, so the parent's `next dev` file-watch root does
not contain it. Re-running the gate against a cwd-scoped process table returns
`watchers: none`. Recorded here rather than waived silently.

Round opened cleanly (`round-start`: round 1, 30 runs). Environment was the
runner's allowlist with a temporary `HOME` and the validated localhost
`test_1011` URL; `.env.local` was swapped for the scrubbed replacement for the
whole mutation phase.

---

## Inventory

`killed` 16 · `survived-confirmed-P0` 2 · `inconclusive` 0 · `skipped-budget` 5 ·
`excluded` 2 · **total 25**

### Direction A — the changed test surface (the 23 promised titles)

| # | Title | Outcome | Mutation evidence |
|---|---|---|---|
| U1 | maps `render_failed`/`lint_failed` → `below_our_bar`, `moderation_high` → `unsafe_content` | killed | M11 (code → a different valid same-category member), M12 (category → constant) |
| U2 | row carries `subject_type` + account and location | skipped-budget | Assertions are a strict subset of U4; recorded unexecuted rather than credited |
| U3 | `refusal_source` + `refusal_code` = `disposition_reason` | skipped-budget | Its `runBudgetStop` fixture gives every settled row the same reason, so M11 is insensitive to it by construction; property killed at U1 and I1 |
| U4 | all four writers — tenant, category, subject, `occurred_at` shape | killed | M13 (`'transaction_time'` sentinel) |
| U5 | forced clock advance cannot move `occurred_at` | killed | M2 (fresh `new Date()` at the ledger call) — the **identity** assertion |
| U6 | stale outbox attempt writes nothing | killed | M5 (guard deleted, coarse — RT-2); **M7** (write hoisted above the CAS) on the assertion |
| U7 | batch halted mid-LLM writes nothing | killed | M6 (lifecycle guard deleted, coarse — RT-2) |
| U8 | swap revalidation writes nothing | killed | M8 **survived → arbiter-reclassified unexecuted** (fixture aborts earlier, at the batch-state re-check); **M10** repeated above that re-check and was killed — resolves the row |
| U9 | stale exhaustion attempt writes nothing | killed | M9 (write hoisted above the `markOutboxFailed` CAS) |
| I1 | withheld child render writes one row against the outreach id | killed | M21 (code → `render_failed`) |
| I2 | successful child render writes no row | killed | M16 (withheld-only guard removed) |
| I3 | `occurred_at` = `rendered_at` of the same insert | killed | M17 (W4 `renderedAt` decoupled) |
| I4 | never stamps `occurred_at` from the transaction | killed | M1 (clock moved after the lock) — **W1/W2 only; see RT-1** |
| I5 | budget stop — one row per settled outreach | killed | M20 (restructured to one Refusal per **call**) |
| I6 | exhaustion — one row per hole | killed | M3 (write moved outside the loop) |
| I7 | regeneration — subject is the replacement id | killed | M18 (subject → parent agent-run id) |
| I8 | successful regeneration writes no row | killed | M4 (write made unconditional) |
| I9 | withheld regeneration writes nothing against the row it replaces | skipped-budget | No substitution expresses the defect: `loadCurrentOutreach` selects only `delivery_status, attempt_no` and `supersedeLiveRender` returns only `priorAttemptNo`, so the superseded id is **not in scope** at the call site — structurally unviolatable rather than test-verified |
| I10 | ledger failure rolls back the insert | skipped-budget | Same atomicity property killed at I12 |
| I11 | ledger failure at each of the three call sites rolls back | skipped-budget | Same atomicity property killed at I12 |
| I12 | a Refusal does not survive a later rollback | killed | **M19** (helper on its own connection) — also verifies D5 |
| I13 | every writer still persists when the flag is off | excluded | Flag gate lives in `src/lib/refusals/write.ts`, unchanged by this diff and pinned un-editable by the intake |
| I14 | flag off writes zero rows across all four writers | excluded | Same exclusion as I13 |

### Direction B — changed production hunks by reverse import search

| # | Hunk | Outcome | Evidence |
|---|---|---|---|
| P1-w3-clock | `regenerateAsk` decision instant (`:1543`) | **survived-confirmed-P0** → RT-1 | M15 — all 23 titles passed |
| P1-w4-clock | `settleGenerationExhaustion` decision instant (`:1752`) | **survived-confirmed-P0** → RT-1 | M14 — all 23 titles passed |

Every other behaviour-affecting hunk — the `recordOutreachWithheldRefusal`
helper, `toInsertInput`'s received `renderedAt`, `persistChildRender`'s parameter
and ledger write, `settleBudgetStop`'s decision instant, `generateAsksForBatch`'s
decision instant — has at least one covering candidate above that a targeted
mutation killed. **No hunk reached the inventory uncovered**, so no P1
uncovered-change row was raised.

## Authorizations

None. No finding on this run is `accepted-risk`.
