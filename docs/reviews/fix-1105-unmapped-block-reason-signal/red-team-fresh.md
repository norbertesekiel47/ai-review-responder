# Red team — fresh pass, `fix-1105-unmapped-block-reason-signal`

- **Mode:** feature · **Round:** 1 (of a NEW pass) · **Risk:** high
- **fork_sha:** `42078f3913ef0fa3fcaca70d62a8eee6684bf4c9` (`origin/main`)
- **merge_base_sha:** `313a3e01fa73612037eb6674718619e5bf75eb4b`
- **head_sha:** `eb2b51de8ce633ac262ea535419890d0e8daa7d2`
- **intake_sha256:** `66e88227241c8f2672977d0d221afe9c8ad870cce7713c3cd7854deddbd3b326`
- **Status:** `OPEN_P0`

## Why this pass exists, and the two contract deviations it carries

The owner started this pass deliberately after the previous pass exhausted its
two-round budget with its own fixes unverified. Two contract facts, stated
plainly rather than glossed:

1. **`round-start` refused round 3.** `.feature/red-team-journal.json` is a
   gitignored per-pass run artifact. It was **closed** (every mutation
   `restored`, `dotenv.open: false`, no live supervisor), so nothing was
   stranded. The previous journal was archived to the session scratchpad and a
   fresh journal opened at round 1 for this pass. The prior pass's own sidecar at
   `docs/reviews/red-team/fix-1105-unmapped-block-reason-signal-e06658/` was
   **not touched**.
2. **This report is at a NEW slug the checker cannot reach.** `deriveIdentity()`
   in `red-team-status.mjs` derives the slug DETERMINISTICALLY from the
   checked-out branch, so `fix-1105-unmapped-block-reason-signal-e06658` is the
   only path `red-team-status.mjs` will ever read on this branch. Honouring "new
   slug" therefore means this sidecar is **not** the one the `reviewed`
   transition parses. That is for the owner to resolve; this pass may not decide
   it by overwriting the prior pass's artifact.

## Deviation from the literal Duty-1 step

The skill's step 3 runs the individual case with `-t` plus `assert-one-test`.
This pass ran the whole covering test FILE per mutant and read the failing case
titles out of the JSON report. That is strictly stronger for attribution — it
shows *every* case that kills a mutant and cannot mis-report a survivor because
the wrong `-t` was chosen — and it is what the KILLED-BY column records. The
single `-t` form was used once, for the M18 re-run, where the point was to
re-execute exactly one case at a different wall-clock instant.

Environment: allowlisted env via `mutation-runner.mjs env` with a validated
localhost `TEST_DATABASE_POOL_URL`; `dotenv-swap` open for every mutant run;
`finalize` after each. 24 of 30 runs used. Baseline 90/90 green across both
covering files at HEAD. Tree clean and journal closed before this file was
written.

---

## Findings

### F1 — P0 (Duty 2) — a proven-fake assertion: the overflow log line's `cap` is asserted by the wall clock

`src/lib/refusals/__tests__/write.test.ts:1032`

    expect(JSON.stringify(overflowLines[0])).toContain(String(cap));

`String(cap)` is the single character `'8'`. `overflowLines[0]` is the whole
`console.warn` call, and `createWorkerLogger` stamps every line with
`timestamp: new Date().toISOString()` (`src/lib/shared/logger.ts:50`). The
assertion therefore passes whenever **any** digit anywhere in the serialised
line — the timestamp included — is an `8`.

**Proof, not inference.** Mutant M18 changed the overflow log line's payload from
`cap: UNMAPPED_SIGNAL_CAP` to `cap: 0`, leaving every other line untouched.

- First run: **killed**. Failure message:
  `expected '["{\"timestamp\":\"2026-09-04T07:37:0…' to contain '8'` — the clock
  happened to be at `07:37:0x`, a timestamp with no `8` in it.
- Second run, same mutant, same case, `-t`-scoped so exactly one test executed:
  **passed**. The mutant survived.

The same mutant killed at one instant and survived at another. The oracle is the
system clock. This assertion is in the exact hunk round 2 added to close its own
P0-c ("the overflow marker's durable log line had no oracle at all"), so the
claim that the gap is closed is half true: the line's **existence** has a real
oracle (`expect(overflowLines).toHaveLength(1)` kills M13, deletion of the log
line); its **payload** has none.

The failure is one-directional: with the correct value `cap: 8` the `'8'` is
always present, so it never flakes red. It is silently vacuous, which is worse.

**Behavioural replacement:** parse the line and match the object —
`expect(JSON.parse(overflowLines[0][0] as string)).toMatchObject({ cap, flag: REFUSAL_LEDGER_FLAG })`.

### F2 — P0 (Duty 3) — "Rule 6 is the one still genuinely owed" is false at HEAD, contradicted eleven lines below it by the same commit

`docs/runbooks/beta-launch-alerting.md:371`

> **Rule 6 is the one still genuinely owed, and it is owed in PRODUCTION.**

At `313a3e01` that was true. This branch added rules 7 and 8 to the §1a-do table
and, in the same edit, wrote at line 383:

> **Four §1 signals have no rule in either project** … and — added by #1105 —
> `fault:unmapped_block_reason` and `fault:unmapped_block_reason_overflow`,
> rules 7 and 8 above.

At HEAD **three** rules are genuinely owed, not one. The edit that changed the
register left the ownership sentence stale — the branch's own stated signature
failure ("a count changed by one edit and left stale by the next"), inside the
paragraph pair that records that very lesson.

An operator reading §1a-do top to bottom hits the false sentence first.
Mitigating but not sufficient: the correct paragraph follows eleven lines later.

**Fix:** "Rules 6, 7 and 8 are the ones still genuinely owed", or scope the
sentence to the pre-#1105 rules explicitly.

### F3 — P1 (Duty 1) — the overflow marker fires on ONE distinct code when a call carries duplicates, and burns the paging latch for the process

`src/lib/refusals/write.ts:577-579`

    const room = Math.max(0, UNMAPPED_SIGNAL_CAP - signalledUnmappedCodes.size); // SET SLOTS
    const reportable = fresh.slice(0, room);
    const overflowed = fresh.length > room;                                      // ARRAY ENTRIES

`room` counts Set slots; `fresh.length` counts array entries. `fresh` is
`unmapped.filter(...)` — **not** de-duplicated, deliberately (write.ts:552-556:
"never sorted or de-duplicated … a repeat is itself a fact about the decision";
`docs/directory.md`'s `write.ts` row: "verbatim, in input order, **duplicates
kept**").

**Reproduced at HEAD** with a journaled probe case appended to `write.test.ts`
(applied through `mutation-runner mutate`, restored by `finalize`; the tree is
clean). One call carrying `cap + 1 = 9` copies of a **single** unmapped code:

    PROBE1 captures=2 msgs=["auto_approval_unmapped_block_reason",
                            "auto_approval_unmapped_block_reason_cap_reached"]
    PROBE1 codes="ghost_dup, ghost_dup, ghost_dup, ghost_dup, ghost_dup, ghost_dup, ghost_dup, ghost_dup"
    PROBE2 after-a-single-distinct-code captures=1 msgs=["auto_approval_unmapped_block_reason"]
    PROBE3 genuine-overflow captures=0

Three consequences, all wrong:

1. The report names one code eight times — the `extra.codes` an operator reads to
   find the escapee.
2. `auto_approval_unmapped_block_reason_cap_reached` fires. That is **runbook
   rule 8**, a first-seen `error` page, documented (runbook:131-133) as meaning
   "more than `UNMAPPED_SIGNAL_CAP` **distinct** codes escaped in one worker
   process". One distinct code escaped.
3. `unmappedOverflowSignalled` latches for the life of the process, so the
   **genuine** cap-reached page never fires (PROBE3: 0 captures after the Set is
   subsequently filled to the real cap and passed a further new code).

**Reachability today: none.** The sole production call site passes
`autoDecision.blockReasons`, which `compactBlockReasons`
(`worker/jobs/response-generation/auto-approval.ts:429-436`) de-duplicates
through `new Set`, and `collectStructuralBlockReasons` builds by distinct pushes.
That is why this is P1 and not P0. But `noteUnmappedBlockReasons` is an exported
module function whose own docblock and `docs/directory.md` row declare duplicate
input supported and meaningful, and two documents describe the marker's meaning
in terms the duplicate path falsifies.

**Fix (one line):** de-duplicate before measuring —
`const fresh = [...new Set(unmapped.filter((code) => !signalledUnmappedCodes.has(code)))];`
— which also makes `extra.codes` readable. If input-order duplicates must survive
into the report, compare distinct counts instead: `new Set(fresh).size > room`.

### F4 — P1 (Duty 1) — the Set-bound half of the round-2 fix has no oracle

`src/lib/refusals/write.ts:615` · inventory row M5

Mutant M5 replaced `for (const code of reportable) signalledUnmappedCodes.add(code);`
with `for (const code of fresh) …` — precisely the round-2 P0 ("testing the Set's
SIZE and then adding every fresh code lets ONE call with N new codes grow the Set
to N"). It **survived 31/31** cases in `write.test.ts`, and there is no other
covering test: `noteUnmappedBlockReasons` / `UNMAPPED_SIGNAL_CAP` /
`signalledUnmappedCodes` appear in only four files repo-wide, and
`persist.test.ts` stubs the whole module.

The round-2 case concedes the gap in a comment:

> "If the Set had grown past `cap` this would still pass, so the assertion that
> carries the bound is the `extra.codes` count above."

True, and that is the problem: `extra.codes` proves the **report** is sliced.
Nothing proves the **Set** is bounded, and the Set bound is the stated reason the
cap exists (write.ts:353-357, `docs/directory.md`, the deviations doc D10/D13,
the runbook §1 latching paragraph — four documents again).

**Arbiter reasoning.** The mutant is executed (the cap-boundary case reaches that
loop with `fresh ≠ reportable`) and it is **not** equivalent — it changes the
realised bound from `CAP` to `CAP-1 + |call|`. It is however
*emission*-equivalent for duplicate-free input, which I can prove: after any
overflowing call the correct code lands at exactly `size == CAP`, so `room == 0`
forever and every later call is silent through both paths. That is why no
assertion on Sentry or the logger can see it, and why the row is recorded
`inconclusive` (class `oracle`) rather than `survived-confirmed-P0` — I cannot
prove the mutant preserves behaviour, so `equivalent` would be dishonest, and I
can see exactly why no current test catches it. Under F3's duplicate path the
mutant becomes emission-discriminating too.

**Fix:** give the Set an observable. A test-only reader beside the existing
`resetUnmappedBlockReasonSignalForTests` (e.g. `unmappedSignalCountForTests()`)
asserted `toBe(cap)` after the `cap + 3` call is the minimal honest oracle.

### F5 — P1 (Duty 5) — the register applies a `warning`-level premise to two `error`-level signals

`docs/runbooks/beta-launch-alerting.md:383-390`

The register lists `fault:unmapped_block_reason` and
`fault:unmapped_block_reason_overflow` as having "no rule in either project",
alongside `subsystem:refusal_ledger` (a `warning`) and
`subsystem:autonomy_governor` (a `captureException`). But the register's own
reasoning for rule 6, six lines above, is:

> a `warning` `captureMessage` does not reliably classify as high priority, so
> `3920752` does not catch it either

`3920752` is the production rule with **no filters** and *New/Existing high
priority issue* triggers. Both new signals are `level: 'error'`
(`src/lib/refusals/write.ts:608`, `654`), so by the runbook's own stated
mechanism `3920752` **does** catch them — which would make "no rule in either
project" wrong for two of the four, and rules 7/8 a routing refinement rather
than a gap.

Either way the runbook is internally inconsistent. This is not decidable from the
code; it needs a Sentry read-back like the one that produced the
`2026-08-31T22:25Z` table. Recorded rather than guessed.

### F6 — P2 (Duty 5) — "may simply have been reported in an earlier event" is incomplete at the cap boundary

`docs/runbooks/beta-launch-alerting.md:116-117`

> A code missing from the list may simply have been reported in an earlier event.

At HEAD a code can also be **dropped by the cap in the same call** and never
named anywhere: `reportable = fresh.slice(0, room)` is a strict subset when
`fresh.length > room`, and the overflow marker "names no code deliberately"
(runbook:135). The operator instruction should say both cases.

### F7 — P2 (Duty 3) — deviations D13 asserts these fixes carry no adversarial round

`docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-deviations.md:266-268`

> There is no round 3; `round-start` refuses one. These fixes therefore carry NO
> adversarial round behind them.

False once this pass lands. The two-round cap is a per-pass property of a
gitignored journal, not a property of the branch. D13 should record this pass.

### F8 — P2 (Duty 2) — the overflow log message is a copied literal where its Sentry twin is an exported constant

`src/lib/refusals/__tests__/write.test.ts:1029` filters on the literal
`'distinct unmapped code cap reached'`. The module's stated discipline
(write.ts:376-383) is that message strings are exported "so the eval pins
grouping on the constant rather than on a copied literal", and
`UNMAPPED_BLOCK_REASON_OVERFLOW_MESSAGE` exists for exactly that reason. The
**log** half of the same signal has no constant. It fails loud (a reworded
production string makes `toHaveLength(1)` fail), so P2, not P1.

### F9 — P2 (Duty 3) — "Rules 4, 5 and 6 are the odd ones … Rules 1–3 fire on a new issue" is now incomplete

`docs/runbooks/beta-launch-alerting.md:393-394`. Rules 7 and 8 also fire on a new
issue. Not false, only no longer exhaustive.

---

## Duty 4 — sibling sweep (sound search, no unrecorded sibling)

Patterns searched, whole repo, `-g '*.ts'`, `__tests__` excluded from production
counts:

| Pattern | Scope | Result |
|---|---|---|
| `REFUSAL_CATEGORIES\[` / `_CATEGORIES\[` | `src` + `worker` | 6 direct `MAP[reason]` index sites |
| `subsystem: 'refusal_ledger'` | `src` + `worker` | 4 sites (1 `warning`, 3 `error`) |
| `fault: '` | `src` + `worker` | exactly the 2 new sites |
| `noteUnmappedBlockReasons` / `UNMAPPED_SIGNAL_CAP` / `signalledUnmappedCodes` | repo | 4 files |

**The "Five lanes" claim in `persist.ts`'s `unmappedBlockReasons` docblock is
CORRECT** and I re-derived it rather than accepting it. Six direct index sites map
onto five `RefusalSource` lanes, because `outreach_withheld` owns two constants
(`OUTREACH_WITHHELD_DISPATCH` at `src/lib/solicitation/dispatch.ts:1481` and
`OUTREACH_WITHHELD_RENDER` at `src/lib/solicitation/ask-generation.ts:751`).
Checked against `REFUSAL_SOURCES` (`src/lib/refusals/vocabulary.ts:106-114`): the
seven sources are `held_draft` (no code axis), `policy_gate_held` (this branch's
lane), and the five that index directly — `auto_post_revoked`,
`autonomy_suspended`, `ask_withheld`, `outreach_withheld`, `batch_halted`.

**The `fault` tag key is used at exactly the two new sites**, so runbook rules 7
and 8 cannot collide with an existing signal. Verified.

## Duty 3 — doc claims re-resolved against HEAD

`prevalidate-plan.py` run on the changed plan/runbook docs: `beta-launch-alerting.md`
PASS (0 citations), the plan PASS (3 fixtures), the deviations doc PASS (1
citation, 1 commit). The script checks citations and fixtures, not prose claims,
so every prose claim below was hand-resolved.

| Claim | Where | Verdict |
|---|---|---|
| rule 7 = `fault` `unmapped_block_reason`, first seen, `error` | runbook:297 | TRUE — `write.ts:607-609` |
| rule 8 = `fault` `unmapped_block_reason_overflow`, first seen, `error` | runbook:298 | TRUE — `write.ts:653-655` |
| "Three different faults now carry `subsystem:refusal_ledger` at `error`" | runbook:361 | TRUE — `persist.ts:1048-1050` (`captureException`, `error`), `write.ts:609`, `write.ts:655`; the fourth site `write.ts:483` is `warning` |
| "_Then_ action for all eight" | runbook:358 | TRUE by the section's own pre-existing convention — the table had 6 rows incl. superseded rule 5 and said "all six"; 6→8 is consistent |
| "#1079's blind spot is CLOSED (#1105)" | runbook:78 | TRUE — `persist.ts:964-965` |
| "A new code is reported UNTIL the cap, and silent after it" | runbook:142 | TRUE |
| latch per CODE, per PROCESS, never re-arms on a flag flip | runbook:137 | TRUE — no `endDisabledEpisode` touch; case "an enabled ledger does not re-arm the vocabulary-hole latch" |
| "It names NO code" (overflow marker) | runbook:135 | TRUE — `write.ts:650-657` |
| "The set holds at most `UNMAPPED_SIGNAL_CAP` distinct codes" | write.ts:353-357 | TRUE at HEAD — but untested (F4) |
| overflow marker means "> `UNMAPPED_SIGNAL_CAP` distinct codes escaped" | runbook:131-133 | **FALSE for duplicate input** (F3) |
| "Rule 6 is the one still genuinely owed" | runbook:371 | **FALSE at HEAD** (F2) |
| "Four §1 signals have no rule in either project" | runbook:383 | **premise mismatch** (F5) |
| "these fixes carry NO adversarial round behind them" | deviations:267 | **false once this pass lands** (F7) |
| "Five lanes index a category map directly" | persist.ts docblock / directory.md | TRUE (Duty 4) |
| `docs/directory.md` `write.ts` row: level, tags, constant message, per-code+per-process latch, cap, caller-owns-precondition, array-drop trap | directory.md:905 | ALL TRUE at HEAD |
| arch-review-log `#1105` row | arch-review-log:1663 | consistent with the diff |

## Duty 5 — operational completeness, all six facets

| Facet | Rule 7 | Rule 8 |
|---|---|---|
| signal identity | `auto_approval_unmapped_block_reason` (exported constant) ✓ | `auto_approval_unmapped_block_reason_cap_reached` (exported constant) ✓ |
| filter | `fault` equals `unmapped_block_reason` ✓ | `fault` equals `unmapped_block_reason_overflow` ✓ |
| level | `error` ✓ | `error` ✓ |
| grouping title | constant message, codes in `extra` ✓ | constant message, no codes ✓ |
| threshold / cadence | first seen — justified by the per-code latch ✓ | first seen — justified by the once-per-process latch ✓, but F3 shows that latch can burn on a false trip |
| destination | Discord `#repworth-alerts` ✓ | Discord `#repworth-alerts` ✓ |

Both halves of the alert path exist for both signals. The residual operational
defects are F2 (ownership sentence), F3 (rule 8's documented meaning is
falsifiable and its latch is burnable) and F5 (register premise).

---

## Inventory

| # | Mutation | File | Outcome | Killed by / reason |
|---|---|---|---|---|
| M1 | `room = Math.max(0, CAP - size)` → `room = CAP` | write.ts:577 | killed | cap case; cap-boundary case; overflow-cooldown case |
| M2 | `fresh.length > room` → `>=` | write.ts:579 | killed | cap case; overflow-cooldown case |
| M3 | `fresh.slice(0, room)` → `slice(0, room + 1)` | write.ts:578 | killed | cap case; cap-boundary case; overflow-cooldown case |
| M4 | drop `if (overflowed) noteUnmappedOverflow()` | write.ts:618 | killed | cap-boundary case |
| M5 | `for (const code of reportable) add` → `of fresh` | write.ts:615 | **inconclusive (oracle)** | survived 31/31; emission-equivalent for duplicate-free input, not behaviour-preserving — F4 |
| M6 | `reportable.length === 0` → `< 0` | write.ts:581 | killed | cap case; cap-boundary case; overflow-cooldown case |
| M7 | drop `Math.max(0, …)` | write.ts:577 | **equivalent** | proof: the Set gains at most `room = CAP - size` distinct codes per call, so `size ≤ CAP` by induction from `size = 0`; the clamp can never fire |
| M8 | drop the `Date.now() < nextUnmappedAttemptAt` gate | write.ts:564 | killed | both cooldown cases |
| M9 | drop `if (unmappedOverflowSignalled) return` | write.ts:641 | killed | cap case; cap-boundary case |
| M12 | drop `unmappedOverflowSignalled = true` | write.ts:658 | killed | cap case; cap-boundary case |
| M13 | delete the overflow `logger.warn` line | write.ts:644-647 | killed | cap case — round 2's P0-c fix is real |
| M16 | overflow `fault` tag value changed | write.ts:655 | killed | cap case |
| M17 | overflow `level: 'error'` → `'warning'` | write.ts:654 | killed | cap case |
| M18 | overflow log `cap: UNMAPPED_SIGNAL_CAP` → `cap: 0` | write.ts:646 | **survived-confirmed-P0** | killed at 07:37:0x, survived on re-run — the oracle is the clock (F1) |
| M19 | drop `if (fresh.length === 0) return` | write.ts:569 | killed | 5 cases incl. per-code latch, logger line, cooldown |
| M20 | drop the per-code filter | write.ts:568 | killed | 4 cases incl. per-code latch |
| M21 | report `level: 'error'` → `'warning'` | write.ts:608 | killed | error-level case |
| M23 | delete the report `logger.warn` line | write.ts:594-597 | killed | 4 cases incl. both ledger-dark independence cases |
| M10 | `!Object.hasOwn(MAP, code)` → `!(code in MAP)` | persist.ts:809 | killed | inherited-object-key case |
| M11 | pass `autoDecision.blockReasons` unfiltered | persist.ts:965 | killed | mixed mapped/unmapped case — round 1's P0 fix is real |
| M25 | drop the `unmapped.length > 0` guard | persist.ts:965 | killed | fully-mapped case; veto-only case |
| S1 | the report `logger.warn` try/catch wrapper | write.ts:593-602 | skipped-budget | not mutated this pass; a throwing-logger case exists but the swallow was not measured |
| S2 | the overflow `logger.warn` try/catch wrapper | write.ts:643-651 | skipped-budget | not mutated this pass |
| X1 | `refusal-write.integration.test.ts` | live-DB suite | excluded | imports `write.ts` but exercises no #1105 symbol; the branch diff does not touch it |

## Authorizations

None recorded.
