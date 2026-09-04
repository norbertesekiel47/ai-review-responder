# Red team — `fix/1105-unmapped-block-reason-signal`

**Status: `OPEN_P0`.** One new P0, two new P1, five open P2 (three new, two carried).

| | |
|---|---|
| Mode | `feature` |
| Run id | `feature-fix-1105-unmapped-block-reason-signal-e06658` |
| Fork / merge-base | `313a3e01fa73612037eb6674718619e5bf75eb4b` |
| HEAD measured | `e88eaaece598d9d0b3cf118a30bc3417ce7144af` |
| Intake sha256 | `40f2cc8890b4e75c53e85165b57bc6da0b64c59795b377132fcdd7a429ded75a` |
| Risk | `high` (from the signed-off intake) |
| Journal round | 2 (see "Round accounting" — this is the branch's **third** measured pass) |
| Mutation runs used | 16 of 30 |
| Generated | 2026-09-04T08:17:55Z |

## What this pass is, and what it supersedes

This is a **scoped verification round**. It re-measures the previously-recorded
findings against HEAD and mutation-tests only the hunks that changed since the
fresh pass measured (`git diff eb2b51de..e88eaaec`). It does not re-open the
surface earlier rounds cleared.

It replaces, at the path the checker actually reads, the round-1/2 sidecar that
stood here — that file was pinned to `05f94055`, declared `OPEN_P0`, and every
one of its R2-01…R2-06 findings has since been fixed. A later, correct pass wrote
to `…-fresh-f12f6b/`, which `red-team-status.mjs` never reads: the slug it
derives from the branch name is `…-e06658` and nothing else. Both earlier passes'
findings are preserved below with their measured disposition; the **inventory**
is only what this pass executed at HEAD.

### Round accounting — stated plainly

The skill caps a pass at two rounds and `round-start` refuses a third. It did
**not** refuse here, and the reason is mechanical rather than a loophole: the
journal is per-worktree and the fresh pass reset it with its own `round-start`,
so the counter stood at 1 and this opened as round 2 with a fresh 30-run budget.
In the branch's own history this is the **third** adversarial pass (round 1 +
round 2 at `05f94055`, the fresh pass at `eb2b51de`, this one at `e88eaaec`). The
sidecar records `round: 2` because the schema admits only 1 or 2. Nothing was
worked around: no inventory row was invented, no disposition was hand-edited, and
the status below is what the checker recomputes from the rows.

## Preconditions

| Check | Result |
|---|---|
| Clean tree at a committed SHA | PASS — `git status --porcelain` empty at `e88eaaec` |
| No process serving/watching the worktree | PASS — `mutation-runner.mjs watchers`: none |
| Journal closed, round open | PASS — `round-start: round 2 open, 30 mutation runs available` |
| Environment isolated | `env --tmp-home $(mktemp -d)` (allowlist: PATH, HOME, TMPDIR, NODE_ENV, CI, MOCK_EXTERNAL_APIS, `REPWORTH_DISABLE_LIVE_DB_SUITES=1`) + `dotenv-swap` (1 file). No `--test-db` was passed: every candidate is a unit suite, and passing the URL would have put a credential on a command line. |
| Finalizer before any report byte | PASS — `finalize: restored 0 mutated file(s) and 1 dotenv file(s); journal closed`; `git status --porcelain` empty afterwards |

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `docs/runbooks/beta-launch-alerting.md:401` | The new register qualification calls `subsystem:autonomy_governor` a `warning` signal; it is a `captureException` at `error`, and the same runbook says so at :156 and :391 |
| **P1** | `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-deviations.md:322` | D14's "Promoted to lab notes." is false at HEAD — the identical claim this branch caught and corrected one commit earlier |
| **P1** | `docs/runbooks/beta-launch-alerting.md:414` | Rules 7 and 8 pair a CONSTANT capture title with a first-seen trigger — the combination the same runbook says fires once, ever, then goes silent |
| P2 | `docs/runbooks/beta-launch-alerting.md:376` | "the register eleven lines below" resolves to 10–15 source lines depending on the anchor |
| P2 | `src/lib/refusals/__tests__/write.test.ts:1029` | The overflow log line is matched through the same exported constant the production line emits, so the message VALUE has no oracle |
| P2 | `src/lib/refusals/__tests__/vocabulary.test.ts:592` | Sibling sweep: the "`resolvePolicyGateRefusal` still keeps duplicates" half of the new contrast has no oracle |
| P2 | `src/lib/refusals/__tests__/write.test.ts:1336` | *(carried, unmeasured)* the both-transports-throw case may be redundant with the cooldown case |
| P2 | `worker/jobs/response-generation/generate-draft.ts:77` | *(carried)* one live unbounded-cardinality Sentry capture message, in unchanged code |

### P0 — `beta-launch-alerting.md:401`

Lines 398–405, added by `e88eaaec` as the fix for the fresh pass's F5, read:

> The premise that makes this register alarming — CONFIG-1's finding that a
> `warning` `captureMessage` does not reliably classify as high priority —
> applies to the first two signals, which are `warning`.

The first two signals in that register (lines 390–391) are
`subsystem:refusal_ledger` and `subsystem:autonomy_governor`. The first is
`warning`. The second is not:

- `worker/background/schedulers/AutonomyGovernorScheduler.ts:116` —
  `Sentry.captureException(error, { tags: { subsystem: 'autonomy_governor' } })`,
  no `level` override, so Sentry defaults it to `error`.
- The register entry being annotated says so two lines above it: "a
  `captureException`, so today it reaches issue owners by **email**".
- §1's checklist item at line 156 says it outright: "**Unlike the row above this
  one is a `captureException`, so it defaults to level `error`**".

This is not a cosmetic slip. The paragraph exists to sort four un-ruled signals
into *the warning premise applies* versus *the unfiltered production rule
`3920752` may already catch it*, and it files an error-level signal under the
wrong premise while instructing the reader not to repeat either claim as settled.
The branch already recorded a false level claim in this same register as **P0**
(R2-02). Same shape, same severity.

**Fix:** name only `subsystem:refusal_ledger` as the `warning` case; move
`subsystem:autonomy_governor` into the `error` group whose routing is UNVERIFIED,
which is where §1:156 already puts it.

### P1 — `…-deviations.md:322`

D14 closes its lesson with "**Promoted to lab notes.**"

- `git diff --stat 313a3e01..e88eaaec -- .claude/reference/lab-notes.md` is empty.
- `rg '1105|substring assertion|serialized log line' .claude/reference/lab-notes.md` returns nothing.
- `.claude/reference/arch-review-log.md:1663`, edited earlier on this same branch,
  reads: "**Promotion to lab notes happens at step 8, and this row claimed it had
  already happened** — red team caught the tense; `lab-notes.md` is untouched by
  this branch and the branch's own deviations entry says 'at step 8'."

So the branch found this claim, corrected it in one document, and then wrote it
again in another. Severity follows the branch's own adjudication of the identical
claim (F-03 was P1). **Fix:** "To be promoted at step 8."

### P1 — `beta-launch-alerting.md:414` (duty 5, six-facet comparison)

| Facet | Rule rows 7/8 (lines 300–301, 407, 410–417) | Emitted signal | Agree? |
|---|---|---|---|
| Signal identity | `unmapped_block_reason` / `_overflow` | `write.ts:658`, `write.ts:691` | yes |
| _If_ filter | `fault` equals … | `tags.fault` on both captures | yes |
| Level | `error` | `level: 'error'` on both | yes |
| Grouping title | constant string | `UNMAPPED_BLOCK_REASON_MESSAGE` / `…_OVERFLOW_MESSAGE` | yes |
| _Then_ action | Discord, "for all eight" | n/a | yes |
| **Threshold / cadence** | **issue is first seen** | constant title ⇒ ONE issue group for all time | **no** |

The runbook's own paragraph at 419–426 states the consequence for exactly this
shape: "Each capture title is a constant string, so every occurrence groups into
ONE Sentry issue… A first-seen trigger fires once, ever, and then stays silent
through exactly the repetition that is the signal." The justification offered for
7/8 at 414–417 answers a *frequency* trigger, not this.

What is lost is specific and load-bearing: the repetition here is a **second
distinct unmapped code from a different producer**, and `write.ts:341–352` argues
at length that this is not redundant evidence — it is the whole reason the latch
is per-code rather than one boolean. Under first-seen on a single issue group,
that second code pages nobody. The code takes trouble to emit it; the rule
discards it.

**Needs adjudication.** Either the rows adopt the `Every event` trigger plus tag
filter that the 2026-09-01 owner decision (lines 357–364) makes the default for
rare-by-construction detectors, or 414–417 records why a once-ever page is
accepted for this fault.

## Duty 1 — mutation evidence, all at HEAD

16 runs of a 30-run budget. Baselines green for every candidate before mutating.
Every mutant was applied through `mutation-runner.mjs mutate` (journaled), run
under a paused supervisor with `assert-one-test` confirming exactly one executed
test, and reverted before the next.

### 1. The overflow log assertion no longer passes on the clock — CONFIRMED

The mutant is `cap: UNMAPPED_SIGNAL_CAP → cap: 0` in `noteUnmappedOverflow`'s
`logger.warn` payload (`write.ts:682`) — the fresh pass's P0 mutant, verbatim.

| Run | Instant (UTC) | Result |
|---|---|---|
| 1 | 08:06:45Z | FAILED — `the cap is carried as a NUMBER, by name: expected +0 to be 8` (write.test.ts:1042) |
| 2 | 08:06:46Z | FAILED — same assertion |
| 3 | 08:06:46Z | FAILED — same assertion |

**And the control, which is the part that actually settles it.** With the same
`cap: 0` mutant still applied, the assertion block was rewound to the superseded
`expect(JSON.stringify(overflowLines[0])).toContain(String(cap))` and re-run at
08:07:29Z. It **PASSED**.

Every run in this pass fell inside UTC hour `08`, so the logger's ISO timestamp
carried the digit `8` throughout — precisely the instants at which the old
assertion was blind. Same mutant, same minute: old assertion survives, new
assertion dies. The oracle is now the parsed `data.cap`, not the wall clock. An
hour whose string contains no `8` could not be sampled without waiting for
09:00Z, and the control makes that unnecessary: it isolates the assertion as the
only variable rather than relying on the clock to cooperate.

The `flag` half of the rewritten assertion was mutated separately
(`flag: 'NOT_THE_FLAG'`) and also died.

### 2. De-duplication at the latch seam — CONFIRMED

`write.ts:604`, `[...new Set(unmapped.filter(…))] → unmapped.filter(…)` (the
pre-fix form). The new case *counts DISTINCT codes, not repeats, against the cap*
FAILS on `one report, no overflow marker: expected "vi.fn()" to be called 1
times, but got 2 times` — under the mutant, `cap + 1` repeats of ONE code again
trip the cap-reached page and burn its once-per-process latch, and the case sees
it. At HEAD the same input produces one report naming `one_code`, no overflow
marker, and a latch holding exactly one distinct code.

`resolvePolicyGateRefusal` still KEEPS duplicates — verified statically, not
mutated, because `vocabulary.ts` is untouched by this branch and round 2 forbids
a front against unchanged code. `vocabulary.ts:769` returns
`allRefusalCodes: [first, ...rest]`, the input verbatim, with no sort and no Set.
The claim in `write.ts:596–603` is therefore TRUE at HEAD. Its **oracle** is
missing, which is P2 V-F6: the only order/identity case
(`vocabulary.test.ts:585–604`) feeds three DISTINCT codes and asserts
`toEqual(input)`, which a de-duplicating resolver satisfies unchanged; none of
the 12 `resolve([…])` call sites in that suite passes a repeated code.

### 3. The boundedness oracle — CONFIRMED, and it is not self-fulfilling

`write.ts:651`, `for (const code of reportable) → for (const code of fresh)` —
the mutant that survived **31/31** for the fresh pass. It now FAILS on

```
AssertionError: the latch never exceeds the cap: expected 11 to be 8
    at src/lib/refusals/__tests__/write.test.ts:1084
```

killed by the new `unmappedSignalledCodeCountForTests()` assertion and by nothing
else in the case.

Because a test-only accessor can itself be the fake, it was mutated too:
`return signalledUnmappedCodes.size → return UNMAPPED_SIGNAL_CAP`
(`write.ts:412`) FAILS on `one distinct code: expected 8 to be 1`. The accessor is
pinned by two different expected values — `cap` in the bounds case, `1` in the
DISTINCT case — so no constant satisfies both.

### 4. The order case still kills a sort — CONFIRMED

`write.ts:629`, `reportable.join(', ') → [...reportable].sort().join(', ')`.
The case FAILS on `expected … to match object { extra: { codes: 'zeta, alpha' } }`.
Shortening the expectation from `'zeta, alpha, zeta'` to `'zeta, alpha'` cost
nothing: `zeta` precedes `alpha`, so alphabetical output still reverses them.

### 5. Two previously-open oracle gaps closed

- **R2-03** (overflow log had no oracle anywhere): deleting the whole
  `try { logger.warn(…) } catch {}` block from `noteUnmappedOverflow` now FAILS
  on `the marker reached the durable transport: expected [] to have a length of 1`.
- **R2-04** (overflow Sentry catch on an unexecuted branch — round 2 recorded it
  `inconclusive/oracle`): deleting `nextUnmappedAttemptAt = Date.now() +
  WARN_RETRY_COOLDOWN_MS` from that catch now FAILS on `the window suppresses:
  expected "vi.fn()" to be called 1 times, but got 2 times`. The branch is
  executed and asserted. **This pass therefore carries no inconclusive row.**

## Duty 2 — fragile assertions

The one shape found is recorded as **V-F5 (P2)**: `write.test.ts:1029` filters
`consoleWarn` calls by `refusalWrite.UNMAPPED_OVERFLOW_LOG_MESSAGE` while
`write.ts:680` emits that same symbol, so a change to the constant's *value*
moves both sides together and is undetectable. Recorded, not fixed — it is the
module's stated discipline (`write.ts:376–386`), the identical shape already
applies to `UNMAPPED_BLOCK_REASON_MESSAGE` which rounds 1 and 2 both cleared, and
pinning the literal would break the assertion on every legitimate retune. What is
genuinely unasserted is the human-readable prose of one log line; its behavioural
contract — the line exists, carries `cap`, carries `flag` — is pinned by three
separate mutants above.

No absence-of-tag proxy, no exact string count, and no order assertion without an
ordering contract was found in the changed test surface.

## Duty 3 — doc claims re-resolved against HEAD

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was **not used**;
every claim below was hand-checked, and this report says so per the skill.

| Claim (at HEAD) | Verdict | Evidence |
|---|---|---|
| "Rule 6 is not the only one still owed — #1105 added rules 7 and 8" (:374) | TRUE | rows 7, 8 at :300–301; register at :389 names four |
| "the register eleven lines below" (:376) | IMPRECISE → **V-F4 (P2)** | phrase :376, register :389 → 13 lines (15 / 10 by other anchors) |
| "Four §1 signals have no DEDICATED rule" (:389) | TRUE | four named, count matches list |
| "the first two signals, which are `warning`" (:401) | **FALSE → V-F1 (P0)** | `AutonomyGovernorScheduler.ts:116` is a `captureException` ⇒ `error`; contradicted at :156 and :391 |
| "Whether it does is UNVERIFIED here… this branch did not perform [the read-back]" (:403) | TRUE | no Sentry read-back anywhere in the branch diff; the honest form of the FP-5 fix |
| "A code you expected and cannot find is in one of three states" (:115–118) | TRUE, and complete | (a) per-code latch `write.ts:604`; (b) the Set at `write.ts:604`; (c) `reportable = fresh.slice(0, room)` at `write.ts:614` names nothing past the cap |
| "Rules 1–3 and 7–8 fire on a new issue" (:420) | TRUE of the table | _When_ column of rows 1,2,3,7,8 = "issue is first seen"; 4,5,6 = frequency. Whether first-seen is *right* for 7/8 is V-F3 |
| D14 "Promoted to lab notes." (:322) | **FALSE → V-F2 (P1)** | `lab-notes.md` untouched by the branch; no #1105 entry |
| D14 "a third test-only export" (:344) | TRUE | `rg 'export function .*ForTests' write.ts` → 3 (:324, :411, :435) |
| D14 "the overflow log message is matched through an exported constant" (:347) | TRUE | `write.ts:395`, `write.test.ts:1029` |
| D14 "the 'Rules 1-3 fire on a new issue' sentence is no longer non-exhaustive" (:350) | TRUE | :420 |
| D15 "write.ts 68 code / 216 comment, persist.ts 8 code / 88 comment" (:371) | TRUE, exactly | classified added lines of `git diff 313a3e01..e88eaaec`: write.ts 68 / 216 / 19 blank = 303; persist.ts 8 / 88 / 1 = 97 |
| D15 "Estimates corrected to 540 / 520 in both copies" (:384) | TRUE | `.feature/intake.json` and the plans copy are byte-identical and carry 540 / 520 |
| D13 "AT THE TIME THIS ENTRY WAS WRITTEN… Do not read this paragraph as the final state" (:266–269) | TRUE | FP-7 fixed |

## Duty 4 — sibling sweeps (patterns, scope and exclusions recorded)

**Sweep A — the "substring assertion over a whole serialized line" shape**, the
lesson FP-1 generalises.
Patterns: `toContain\(String\(` and `JSON\.stringify\([^)]*\)\)?\)?\.(toContain|toMatch)`.
Scope: `src/` + `worker/`, excluding `node_modules`.
Hits: 4. `SiteFooter.test.tsx:14` asserts `String(new Date().getFullYear())` —
deliberately clock-derived, the correct use, not this shape. The other three
(`zernio-ingest-shared.test.ts:139`, `archive-location-tx.test.ts:1198`,
`import-offer-junction.test.ts:195`) assert non-numeric literal tokens, which no
timestamp can supply. **Zero true siblings**, recorded as a sound negative.

**Sweep B — a module-level mutable Set latch keyed on untrusted input**, the
shape the cap exists to bound.
Pattern: `^(const|let) \w+ = new Set<`, scope `src/` + `worker/` excluding
`__tests__`. Hits: 20. All but `signalledUnmappedCodes` (`write.ts:359`) are
either built once from a literal or compile-time list (bounded by construction)
or are UI-local registries keyed on internal ids. **Zero siblings**, recorded as
a sound negative.

**Sweep C — the duplicates-kept contrast.** Every `resolve([` in
`vocabulary.test.ts` (12 sites, :565–:827). None passes a repeated code → V-F6.

## Duty 5 — operational completeness

Both new signals now have a rule row (`§1a-do` rows 7 and 8), a filter, a level,
a `_When_` trigger and a destination action; the `_Then_` line reads "for all
eight" and there are eight rows. R2-06 is fixed. The register of un-ruled §1
signals names all four and its count matches its list.

Five of the six facets agree with the emitted signals. The sixth — cadence
against a constant grouping title — is **V-F3 (P1)**. The level facet is where
**V-F1 (P0)** was found, in the register's annotation rather than in a rule row.

This comparison is static; no staging delivery drill was run, per the skill.

## Carried findings from the earlier passes

Preserved as this branch's record. All 25 marked `fixed` were re-resolved against
HEAD this pass; the open ones appear in the severity table above.

**Round 1 / round 2 (at `05f94055` / `eb2b51de`):** F-01…F-10, R2-01…R2-08.
Fixed: F-01–F-07, F-09, F-10, R2-01–R2-07. Still open: **F-08** (P2, carried
unmeasured for the third pass; line reference re-resolved to `write.test.ts:1336`)
and **R2-08** (P2, unchanged code, separate ticket).

**Fresh pass (at `eb2b51de`, reported under the unread slug `…-fresh-f12f6b`):**
FP-1…FP-9, all fixed at `f0e44312` / `e88eaaec` and all re-verified above. Two of
those fixes introduced the new findings V-F1 (inside FP-5's replacement text) and
V-F4 (inside FP-2's), and one produced the P2 trade-off V-F5 (inside FP-8's).
That pattern — a correction that ships its own smaller defect — is now the
branch's fourth occurrence, and it is the reason this pass exists.

## Authorizations

None. No finding is `accepted-risk`.

## What blocks, and what an arbiter is being asked

- **V-F1 (P0)** blocks the PR outright.
- **V-F2 and V-F3 (P1)** block on a high-risk run unless fixed or authorized;
  the checker enforces that. V-F3 in particular is a genuine design question
  about alert cadence rather than a typo.
- The five P2s are recorded and do not block.

All three blocking findings are one-paragraph documentation or one-row runbook
edits. None touches production code: on this pass's evidence the code half of
this branch is correct and adequately oracled at HEAD — every mutant this round
executed, including all four the fresh pass and round 2 left alive, now dies.
