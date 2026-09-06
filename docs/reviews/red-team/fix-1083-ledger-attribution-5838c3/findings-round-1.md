# Red team — fix/1083-ledger-attribution

- **Mode** feature · **Round** 1 · **Risk** high (from the signed-off intake)
- **Fork / merge-base** `91b32506a694954643e9523eae3901d784a348ca`
- **HEAD under review** `c94277bf1fe7fa789bba7bbb7208c7f7210b9188`
- **Intake SHA-256** `2e75d18ec1349bca1aeff2324f2834d09fb59acee89c7346ca278cffc7dbf6de`
- **Status** `OPEN_P0`

Staged at `.feature/review-staging/` rather than
`docs/reviews/red-team/fix-1083-ledger-attribution-5838c3/` at the orchestrator's
instruction, so porcelain stayed unambiguous during the mutation phase. The
orchestrator copies both artifacts into place after the finalizer. The sidecar was
validated by `red-team-status.mjs` from the expected path and then removed from it: the
schema, counts, derived `run_id`, recomputed merge-base and intake digest all pass, and
the only reported failures are the intended blocking ones (`OPEN_P0`, plus three open P1s
on a high-risk run).

## Environment

Allow-listed environment via `mutation-runner.mjs env` with a temporary `HOME`, plus a
`dotenv-swap` held open across every mutation. The local test database
(`localhost:5499`, container `repworth-testdb`) validated as localhost, so the live-DB
lane ran rather than slept. The swap was reopened after each `finalize`.

Budget: **25 of 30** runs. One deviation from the per-test cap is recorded below and on
the inventory rows themselves.

---

## Severity table

| Severity | `file:line` | Finding |
|---|---|---|
| **P0** | `src/lib/refusals/write.ts:1098` | The set-arm capture `extra` has no closed key set — a prose or unbounded per-row field can be added and the whole eval stays green (RT-1) |
| **P0** | `src/lib/refusals/write.ts:1100` | `extra.refusal_lanes` is asserted only against a single-lane fixture, so it can silently degrade to the first input's lane (RT-2) |
| **P1** | `docs/runbooks/beta-launch-alerting.md:499` | A fourth `error`-level `subsystem:refusal_ledger` emitter ships with no rule row, and the runbook's count and description contradict HEAD (RT-3) |
| **P1** | `docs/superpowers/plans/fix-1083-ledger-attribution-handoff.md:52` | Every source line the handoff's "three traps" cites is stale, and each now points at an unrelated line in the OTHER write arm (RT-4) |
| **P1** | `docs/superpowers/plans/fix-1083-ledger-attribution-deviations.md:52` | D3 repeats the same stale citations; D4's stated rationale for `refusal_lanes` is factually false (RT-5) |
| **P2** | `src/lib/refusals/write.ts:1095` | The false 200-character truncation rationale is repeated in the production comment, the test comment and the `CONTEXT.md` term (RT-6) |
| **P2** | `docs/superpowers/plans/fix-1083-ledger-attribution-deviations.md:253` | D9's "green at `330b938e` with a current fingerprint" is not current at the HEAD under review (RT-7) |
| **P2** | `worker/jobs/response-generation/persist.ts:1069` | On `policy_gate_held` the write fault and the vocabulary fault carry byte-identical tag sets; a Sentry rule cannot filter on the `extra` that separates them (RT-8) |

---

## What was re-derived, and what held

**Claim 2 — the sixteen `tests_to_add` titles.** All sixteen resolve **verbatim** in the
tree (twelve in `write.test.ts`, four in `persist.test.ts`), matched by exact substring
against the intake array rather than by eye.

**Claim 3 — the live-DB lane runs rather than skips.** Reproduced both ways. Without a
validated database the two suites report `39 total, 0 passed, 39 pending` and the harness
prints `TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED`. With
`localhost:5499` supplied they report **39 total, 39 passed, 0 failed, 0 pending** — 7 in
`write.integration.test.ts`, 32 in `refusal-write.integration.test.ts`. The claim is exact.

**Claim 4 — D9's two flakes.** Both named suites run together in isolation under the
scrubbed environment: `live-db-suites-audit.test.ts` 43/43 and `review-qr.test.ts` 17/17,
60 passed / 0 failed. The counts match D9's table exactly. Nothing about the branch is
implicated.

**Hypothesis 2 — can the writer's guard be defeated?** Every one of the brief's four named
mutations was killed, along with thirteen more:

| # | Mutation | Result |
|---|---|---|
| RT-M1 | hoist `uuidv7()` to a `const` above the single-row `try` | **killed** |
| RT-M2 | start the set arm's guard at the INSERT instead of the row map | **killed** |
| RT-M3 | compute the set arm's lane string from `rows` rather than `inputs` | **killed** (ReferenceError replaces the caller's RangeError) |
| RT-M4 | drop `.sort()` | **killed** |
| RT-M5 | drop the `new Set` de-duplication | **killed** |
| RT-M6 | remove the reporter's own inner `try/catch` | **killed** |
| RT-M7 / RT-M13 | swallow instead of rethrow, single-row / set arm | **killed** |
| RT-M8 | hard-code the single-row lane tag | **killed** |
| RT-M9 | leak `refusal_code` into the single-row `extra` | **killed** |
| RT-M10 | leak per-row subject ids into the set-arm `extra` | **killed** |
| RT-M11 | `level: 'warning'` instead of `'error'` | **killed** |
| RT-M12 | force the single-row kill-switch guard's condition false | **killed** |
| RT-P1 | re-add the removed `held_draft` call-site wrapper | **killed** (2 captures) |
| RT-P2 | move the policy-gate write back inside the wrapper | **killed** (2 captures) |
| RT-P3 | make `withLedgerAttribution` swallow | **killed** |
| RT-P4 | remove guard 4's `return` so the resolve runs with the switch off | **killed** |

The four the brief named are genuinely load-bearing. So is the "three negatives carry a
control" claim: RT-M12 proves the kill-switch case's control half is real (it drives two
captures with the switch on before asserting zero with it off), and the same
control-then-clear shape is present in the empty-input and `ON CONFLICT` cases.

**Hypothesis 3 — #1079 kill-switch containment.** Held. Both arms return before their
`try` (`write.ts:824` before `:867`; `write.ts:999` before `:1017`), the set arm's empty
return precedes even the flag read (`write.ts:995`), `endDisabledEpisode()` sits outside
both guards, and the three off-arm helpers (`warnLedgerDisabled`, `noteRefusalLedgerDark`,
`noteUnmappedBlockReasons`) each carry their own swallowing guard. `persist.ts:968` still
returns before the resolve. RT-M12 and RT-P4 both die when that ordering is broken. **No
path was found by which ledger code can throw into a caller's transaction with
`REFUSAL_LEDGER_ENABLED=false`.**

**Hypothesis 4 — double reporting.** None found. The two reporters are disjoint by
position: `withLedgerAttribution` (`persist.ts:1058`) now wraps only
`resolvePolicyGateRefusal`, which throws strictly before `writeRefusalEvent` is called,
and `captureLedgerWriteFault` (`write.ts:752`) wraps only the two statements. RT-P1 and
RT-P2 both raise the second event the moment either boundary is widened, and both are
killed. See RT-8 for the residual *triage* problem, which is not a double-fire.

**Hypothesis 5 — the five unedited lane files.** Sound search, **zero siblings**. Searched
`src/lib/auto-approval/suspension.ts`, `src/lib/solicitation/{approval,ask-generation,batch-builder,dispatch}.ts`
and `worker/jobs/publisher/auto-policy-downgrade.ts` for `try {` / `catch` /
`captureException` / `Sentry` around every `writeRefusalEvent(s)` call. Every call site is
a bare `await` with no surrounding handler: `suspension.ts:331`, `approval.ts:637`,
`ask-generation.ts:710` and `:1940`, `batch-builder.ts:670`, `dispatch.ts:1474`,
`auto-policy-downgrade.ts:208`. Each carries a "NOT wrapped in try/catch" comment, and
each of those comments remains true at HEAD — they describe the *call site*, and
catch-and-rethrow inside the writer changes neither what the call site does nor what it
sees. No swallow, no double-report, no contradicted comment.

A second sweep confirms the single-writer invariant survives: `INSERT INTO refusal_events`
is spelled only at `write.ts:869` and `write.ts:1042` outside tests. The two `DELETE FROM
refusal_events` sites (`ArchivalPoller.ts:441`, `purge-stages.ts:453`) are pre-existing
retention/purge and untouched.

---

## Findings

### RT-1 — P0 — `src/lib/refusals/write.ts:1098` — the set-arm capture `extra` has no closed key set

**Arbiter confirmation, verbatim.** The single-row arm pins its payload twice —
`Object.keys(extra).sort()` against `SINGLE_ROW_EXTRA_KEYS` and an exhaustive `toEqual` —
and RT-M9 proved that pin real by killing a `refusal_code` leak. The set arm has neither.
Its only case asserts `extra.row_count === 3`, `extra.refusal_lanes === 'ask_withheld'`,
and a `not.toContain(subjectId)` loop; the `not.toContain` proxy catches only values that
happen to be the fixture's UUIDs. Adding
`refusal_codes: inputs.map(r => r.refusalCode).join(',')` survived that case (RT-M14) and
survived the full four-suite sweep including both live-DB suites (RT-M16, **146 passed,
0 failed, 0 pending**). The mutation is executed by the case, is observably different, and
violates a named intake invariant — *"Sentry extra and tags carry only closed enums and
UUIDs. No review text, no response text, no refusal_code prose, no unbounded per-row id
lists"* — and the writer's own docblock at `write.ts:743-747`. It is neither equivalent
nor on an unexecuted branch.

**Failure scenario.** An `ask_withheld` build withholds 5,000 Asks and the set INSERT
violates a migration-116 CHECK. A later maintainer, acting on the same "more context helps
triage" impulse the diff itself resisted, adds the codes to `extra`. Five thousand
free-ish gate-reason strings ride an error envelope into Sentry, past the redaction
discipline `.claude/CLAUDE.md` and ADR 0023 impose, and no test turns red.

**Behavioural replacement.** Pin the set-arm key set the way `SINGLE_ROW_EXTRA_KEYS` pins
the single-row one: `expect(Object.keys(extra).sort()).toEqual(['refusal_lanes',
'row_count'])`. One line, and it kills RT-M14.

### RT-2 — P0 — `src/lib/refusals/write.ts:1100` — `extra.refusal_lanes` is asserted only against a single-lane fixture

**Arbiter confirmation, verbatim.** Two cases touch the set arm. The multi-lane one
(`write.test.ts:1560`) deliberately uses an unsorted, duplicated, two-lane fixture and
asserts `tags` and `level` — it never reads `extra`. The `extra` case
(`write.test.ts:1596`) uses a three-row **single**-lane fixture, where the distinct-sorted
string and `inputs[0].refusalSource` are the same value. Replacing `refusal_lanes: lanes`
with `refusal_lanes: inputs[0]!.refusalSource` survived (RT-M15) and survived the
four-suite sweep (RT-M16). The mutation is executed and observably different for any mixed
cohort. It is not equivalent: `WriteRefusalEventInput[]` permits a mixed array — the exact
edge case the intake enumerates — and the key exists precisely to be the durable full-set
copy.

**Failure scenario.** A future lane batches two sources; the set INSERT fails; the Sentry
event names one lane in `extra` while the tag names two. An operator triaging a
mixed-cohort ledger fault reads a payload that contradicts its own tag — the worst
outcome for a change whose whole purpose is telling an operator which subsystem to reach
into.

**Behavioural replacement.** Assert `extra.refusal_lanes` on the **multi**-lane case
(`'ask_withheld,outreach_withheld'`), not on the single-lane one. Both fixtures already
exist in the file; only the assertion sits on the wrong one.

> RT-1 and RT-2 are one edit apart. Both are satisfied by moving the `extra` assertions
> onto the multi-lane fixture and pinning its key set there.

### RT-3 — P1 — `docs/runbooks/beta-launch-alerting.md:499` — a fourth error-level emitter with no rule row

At HEAD, four emitters carry `subsystem:refusal_ledger` at level `error`:

| Emitter | Site | Distinguishing tag |
|---|---|---|
| `noteUnmappedBlockReasons` | `write.ts:657` | `fault:unmapped_block_reason` |
| `noteUnmappedOverflow` | `write.ts:703` | `fault:unmapped_block_reason_overflow` |
| `withLedgerAttribution` | `persist.ts:1069` | *(none — `refusal_lane` + `flag`)* |
| **`captureLedgerWriteFault`** | **`write.ts:765`** | ***(none — `refusal_lane` + `flag`)*** |

The runbook at `:499` states *"Three different faults now carry `subsystem:refusal_ledger`
at `error` — `withLedgerAttribution`'s ledger-failure attribution (since #1079) and both of
these"*. Two facets contradict the emitted signal after this diff: the **count** is now
four, and the **description** is wrong — `withLedgerAttribution` no longer attributes a
ledger *write* failure at all; it attributes only a vocabulary hole on one lane, and the
write-failure attribution moved to a new emitter the runbook does not mention. The register
at `:458-463` likewise still says *"Four §1 signals have no DEDICATED rule in either
project"*; it is now five.

This is the register's own named defect class: *"The count was 'two' and the two new
signals were not listed when they shipped; red team caught the omission, which is the same
class of defect this whole register exists to prevent."*

All six Duty-5 facets for the new signal: **signal identity** — a `captureException`,
grouped by the underlying exception rather than a constant title; **filter** — none exists;
**level** — `error`, consistent with its neighbours; **grouping title** — inherited from the
Postgres/RangeError instance, so one issue per distinct failure mode rather than one per
fault class; **threshold/cadence** — undefined, no row; **destination action** — none. The
comparison is static, per the skill; a staging delivery drill stays runbook acceptance work.

### RT-4 — P1 — `docs/superpowers/plans/fix-1083-ledger-attribution-handoff.md:52` — every cited line is stale

The handoff's "three traps most likely to be re-broken" is the section a future agent reads
first, and all four of its citations mis-resolve at HEAD:

| Cited | Claimed to be | Actually at HEAD | What sits at the cited number |
|---|---|---|---|
| `write.ts:904` | the set arm's row map | `write.ts:1020` | `});` — the end of the **single-row** capture call |
| `write.ts:925` | the set arm's INSERT | `write.ts:1042` | a comment about the frozen vocabulary literal |
| `write.ts:922` | `toISOString()` | `write.ts:1038` | a bare `//` |
| `write.ts:791` | the `uuidv7()` interpolation | `write.ts:882` | a comment about the `account_audit_log` join |

The prose claims are all TRUE; only the numbers are wrong, so this is a stale-line-number
P1 rather than a false-claim P0. It is worth fixing rather than waving through, because
three of the four now land inside the *other* write arm — a reader following `write.ts:904`
to check "does the set-arm guard still start at the row map?" arrives in the single-row
catch and can plausibly conclude it does not.

### RT-5 — P1 — `docs/superpowers/plans/fix-1083-ledger-attribution-deviations.md:52` — D3 repeats the stale citations, and D4's rationale is false

D3 at `:52` repeats `write.ts:904` / `:925` / `:922` verbatim; the plan repeats them at
`:164`, `:186-189`, `:348` and `:397`. Same resolution table as RT-4.

Separately, D4 at `:84` states: *"a Sentry **tag** value truncates at 200 characters and
`extra` does not, so a cohort spanning every lane is exactly the case where the tag can
lose a member."* The second clause is **false and structurally unreachable**.
`REFUSAL_SOURCES` has seven members; the longest possible sorted comma-joined string is

```
ask_withheld,auto_post_revoked,autonomy_suspended,batch_halted,held_draft,outreach_withheld,policy_gate_held
```

which is **108 characters**. The tag cannot lose a member at any cohort, and the intake
itself pins the vocabulary at seven ("`REFUSAL_SOURCES` stays seven members"). The
duplication `refusal_lanes` provides is real redundancy with a false reason attached —
which matters because that reason is the only recorded justification for the key, and RT-2
shows the key is under-tested exactly where it would earn its keep.

### RT-6 — P2 — `src/lib/refusals/write.ts:1095` — the same false rationale in three more places

`write.ts:1095-1097`, `write.test.ts:1613-1616` ("*so a cohort spanning every lane is the
case where the tag can lose a member*") and `CONTEXT.md:167` all carry the RT-5 claim.
Recorded separately because fixing D4 alone leaves three copies standing, and `CONTEXT.md`
is the LOCKED-term surface a future ticket reads as authoritative.

### RT-7 — P2 — `docs/superpowers/plans/fix-1083-ledger-attribution-deviations.md:253` — the fingerprint is not current at HEAD

D9 closes *"The gate is green at `330b938e` with a current fingerprint."*
`.feature/codex-gate-fingerprint.json` records `headSha: 330b938e…`, and HEAD is
`c94277bf`. Two commits intervene — `9b8ce2e2` (this deviations file) and `c94277bf`
(`docs/reviews/fix-1083-ledger-attribution/blast-radius.md`) — and both are docs-only, so
no gate row's *input* changed. P2 rather than P1 because the skill's own ordering requires
the gate to re-run as the last serialized step after the review artifacts land, which
corrects this by construction. Flagged so the sentence is amended at that point rather than
left asserting a currency it does not have.

### RT-8 — P2 — `worker/jobs/response-generation/persist.ts:1069` — two fault classes, one tag set

On the `policy_gate_held` lane the vocabulary fault (`persist.ts:1069`) and the write fault
(`write.ts:765`) emit **byte-identical** tags: `{subsystem: 'refusal_ledger', refusal_lane:
'policy_gate_held', flag: 'REFUSAL_LEDGER_ENABLED'}` at the same level.
`persist.ts:1043-1047` and the `docs/directory.md` row both say the two are told apart by
`extra` — `{response_id}` versus the writer's five closed fields — and the eval asserts
exactly that. That is true for a human reading an issue and false for a **rule**: a Sentry
alert rule filters on tags and level, never on `extra`. The runbook's standing instruction
at `:104` ("*RULE ON THE `fault` TAG, NEVER ON `subsystem:refusal_ledger AND level:error`*")
exists for this reason, and the diff's deliberate "THREE TAGS, EXACTLY" decision
(`write.ts:757-763`) is what leaves the two classes unroutable apart.

Not raised higher because the intake explicitly closes the tag set at three and no rule
exists yet to be wrong; an operator can still separate them by hand. Recorded so whoever
writes the RT-3 rule row knows a `fault` facet would have to be added first.

---

## Duty 2 — fragile assertions

One absence-of-substring proxy is load-bearing and is folded into RT-1: the set-arm `extra`
case's only defence is `expect(serialized).not.toContain(input.subjectId)`, which constrains
the payload solely for values that happen to be the fixture's UUIDs. Its single-row twin
does not have this weakness — `write.test.ts:1531` pins the key set and `:1532` pins the
whole object, and the `not.toContain('no_consent')` / `not.toContain('no_permission')` lines
beside them are belt-and-braces rather than the oracle. That asymmetry *is* the finding.

No exact-string counts on rendered output and no order assertions without a contract were
found in the changed tests. The one ordering assertion — the sorted, comma-joined lane
string — has an explicit contract (`write.ts:1085-1091`, `CONTEXT.md:167`) and RT-M4 proves
it enforced.

## Duty 3 — method note

`prevalidate-plan.py` is present and was run against all three changed plan documents; all
report `PREVALIDATE: PASS`. **That script resolves file existence, fixtures and commits — it
does not verify that a cited LINE still says what the citing sentence claims**, which is why
every `path:line` in the changed docs was additionally hand-resolved against HEAD with
`sed -n <line>p`. RT-4 and RT-5 are the result of that hand check, not of the script.

`CONTEXT.md:167` and the two `docs/directory.md` rows were re-resolved symbol by symbol
against HEAD and are otherwise accurate: `captureLedgerWriteFault` is module-private with
exactly two callers (`write.ts:898`, `write.ts:1098`), `row_count` does read `inputs.length`,
the set-arm guard does start at the row map, and `withLedgerAttribution` is synchronous with
a single-literal `lane` parameter. Only the truncation clause (RT-6) fails.

## Budget deviation

Three mutations (RT-M4, RT-M5, RT-M13) were aimed at *"attributes a set-arm write failure with
the distinct sources sorted and comma-joined"*, and three (RT-M10, RT-M14, RT-M15) at *"carries
row_count and never per-row subject ids in the set-arm capture extra"* — one over the plan's
2-per-test cap in each case. Recorded rather than hidden. The third mutation on the second
title is what produced RT-2, so the overrun is the reason a P0 exists rather than an artefact
beside it.

## Authorizations

None. No finding on this pass is accepted-risk.
