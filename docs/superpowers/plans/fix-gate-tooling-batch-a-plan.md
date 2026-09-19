# Plan — Batch A, gate tooling (#1107, #1108, #1199, #1305)

Intake: `docs/superpowers/plans/fix-gate-tooling-batch-a-intake.json` (locked).
Lane: SIZE = standard · RISK = normal · SURFACE = backend.

## What this batch is for

Three of these tickets are the same defect class: **a gate row reports a state
that is not the branch's state**. #1108 makes the promised-tests row report
work as unwritten when it is written. #1107 makes an armed worktree report
another run's classification. #1199 lets a docs-only pull request merge green
past a cap it broke. #1305 is a flake that is already fixed and needs closing
with evidence rather than code.

A later gate run is only trustworthy if these three stop lying.

## Module design (the `codebase-design` pass)

| Ticket | Module | Interface | Why this shape |
|---|---|---|---|
| #1108 | `scripts/gate-promised-tests.sh` (new) | `promised_title_found <title> <root>…` → exit 0/1; internal seam `promised_title_spellings <title>` → candidate spellings, one per line | Delete it and the escape rule reappears inline in `verify-gate.sh`, where no test can reach it: sourcing `verify-gate.sh` RUNS the gate. That is the exact argument `scripts/gate-rows.sh`'s header already makes for itself. A separate file, not an addition to `gate-rows.sh`, because that module's interface is row identity and title matching would widen it for no leverage. |
| #1107 §1 | `.agents/skills/feature/scripts/progress.mjs`, command `carry` | `carry <parent-root> --intake <path> [--runtime …]` | Deepening an existing module, not a new interface. Today the decision is split — `feature-setup.sh` decides WHETHER to invoke `carry`, `progress.mjs` decides HOW. Putting the new rule in bash would spread one rule across two files and leave it untestable. The rule moves behind the interface that already exists; `feature-setup.sh` keeps one call and prints what the command reports. |
| #1107 §2 | `scripts/arm-check.sh` | unchanged | This REMOVES implementation. The silent `case`-statement defaults go; the script validates and names the bad field. Smaller body, honest interface. |
| #1199 | `src/__tests__/ci-audit-wiring.test.ts` | the failure message | A guard test, not another `ci:*` script — the file's own header states why (an audit that checks wiring would have to be wired itself). The candidate/excused two-column shape is that file's established idiom, used twice already (`UNGATED_BY_DESIGN`, `CI_ONLY_BY_DESIGN`). |

## Slicing and order

T1 and T3 both edit `scripts/verify-gate.sh`, so they are NOT independent. T2
is disjoint from both.

1. **T1** alone — it is also the first-task enforcement spot check.
2. **T2 ‖ T3** — disjoint file sets once T1 has landed.
3. **T4** last — it needs nothing from the others.

---

## T1 — #1108: the promised-tests row stops under-reporting quoted titles

**Create:** `scripts/gate-promised-tests.sh`
**Create:** `scripts/ci/__tests__/gate-promised-tests.test.ts`
**Modify:** `scripts/verify-gate.sh`

### Behavior

`verify-gate.sh`'s promised-tests row greps each `tests_to_add` title as a
verbatim fixed string (`scripts/verify-gate.sh:497-507`). A JavaScript
single-quoted test name spells an apostrophe `\'`, so the backslash breaks the
match and the row reports a test that exists, passes and was mutation-verified
as MISSING. The row can only ever UNDER-report, so the failure reads as
unwritten work and invites rewording the title — which weakens the contract
instead of fixing the quoting. 40 single-quoted titles in this repo carry an
escaped apostrophe today.

After this task, a promised title matches when the source spells it in any
quoting style a JavaScript string literal can produce.

**The rule.** For a title `T`, the matcher tries these candidate spellings in
order and succeeds on the first hit:

1. `T` verbatim.
2. `T` with every `'` replaced by `\'` (source used a single-quoted name).
3. `T` with every `"` replaced by `\"` (source used a double-quoted name).
4. `T` with every `` ` `` replaced by `` \` `` (source used a template literal).

Each candidate is matched with `grep -rqF` over the same roots and the same
`--include` filters the row uses today: `src worker scripts tests`, with
`--include='*.test.ts' --include='*.test.tsx'`.

**Negative cases.** A title absent from every root still fails: normalization
only ADDS candidate spellings, it never rewrites the searched files, so it
cannot manufacture a match. A title containing a literal backslash still
matches verbatim through candidate 1.

**Why not normalize the file side.** Stripping `\` before a quote in every
candidate file would have to rewrite ~900 test files per title. Generating
four candidate spellings per title costs four `grep` passes at worst and
compares the same two things.

### Interface

```bash
# promised_title_spellings <title>
#   Prints the candidate spellings, one per line, most literal first.
#   The internal seam: the gate does not call it, the suite does.

# promised_title_found <title> <root>...
#   Exit 0 when any candidate spelling appears in a test file under any root.
#   Exit 1 otherwise. Prints nothing.
```

`gate-promised-tests.sh` is SOURCED, never executed. Follow
`scripts/gate-rows.sh`'s header convention: state in the file why it is its own
file, and never `exit` from it — `verify-gate.sh` sources it, and an `exit`
would take the gate down before it could record a RED `gate-status.json`,
leaving the previous run's green file for `.claude/hooks/stop-gate.sh` to read
as this run's result.

### `verify-gate.sh` changes

- Source it beside `gate-rows.sh` at `scripts/verify-gate.sh:186-187`, with the
  same `# shellcheck source=` directive.
- Assert it loaded, the way lines 191-193 assert `gate-rows.sh` did, via
  `gate_abort` — a silently unsourced matcher would report every title missing.
- Replace the `grep -rqF "$TITLE" …` line at `scripts/verify-gate.sh:500` with
  `promised_title_found "$TITLE" src worker scripts tests`.
- Replace the comment block at `scripts/verify-gate.sh:494-496`. It currently
  instructs the author to work around the defect ("write a title containing an
  apostrophe with double quotes"). That instruction is what this task deletes.
  Keep the search-roots comment at lines 482-492 — it documents a different
  and still-live trap.

### Security contract

None. The matcher reads repository files that are already in the gate's search
path and writes nothing. It never evaluates a title as shell: every candidate
reaches `grep` as a fixed string through `-F` and an argument, never through
`eval` or an unquoted expansion. Pin that: a title containing `$(…)` or a
backtick must be searched for literally, never executed.

### Test titles (suite: `scripts/ci/__tests__/gate-promised-tests.test.ts`)

Drive the helper the way `scripts/ci/__tests__/gate-rows.test.ts` drives
`gate-rows.sh`: source it under the gate's own shell flags (`bash -euo
pipefail`) and call the functions directly. Build a fixture tree under
`mkdtempSync` with test files in each quoting style.

1. `finds a promised title spelled verbatim in the test source`
2. `finds a promised title whose apostrophe the source escapes inside a single-quoted name`
3. `finds a promised title whose quotation mark the source escapes inside a double-quoted name`
4. `keeps the gate honest about a title that carries an author's apostrophe`
   — **write this one's `it(...)` name SINGLE-quoted, so the source spells it
   `author\'s`.** The title is also in the intake's `tests_to_add`, so the
   gate's own promised-tests row goes green only if this task's fix works.
   That is the end-to-end proof, and it must not be reworded.
5. `reports a title no test file spells, so the row goes red only on real absence`
6. `searches src, worker, scripts and tests, and no other root`
   — assert a title present only under a fifth root is NOT found.
7. `the verify gate reads its promised-tests verdict from the shared matcher`
   — read `scripts/verify-gate.sh` and assert it sources
   `gate-promised-tests.sh` and calls `promised_title_found`, so the row and
   the tested rule can never drift apart.

Add one more case for the security contract, in the low-risk appendix of the
same suite rather than the intake list: a title containing `$(touch pwned)`
is searched for literally and creates no file.

### Precedent

`scripts/gate-rows.sh` (seam + header rationale),
`scripts/ci/__tests__/gate-rows.test.ts` (`runWithLib`, `shellQuote`).

---

## T2 — #1107: an armed worktree's ladder matches its own intake

**Modify:** `.agents/skills/feature/scripts/progress.mjs`
**Modify:** `scripts/feature-setup.sh`
**Modify:** `scripts/arm-check.sh`
**Test:** `scripts/ci/__tests__/feature-workflow-runtime.test.ts`

### §1 behavior — the carry decision

`scripts/feature-setup.sh:84-89` copies the parent checkout's
`.feature/progress.json` into the newly armed worktree whenever one exists, on
the assumption that steps 0-1 ran there for THIS ticket. A `/feature-swarm`
wave breaks that assumption: the parent holds no per-ticket ladder, and on
2026-09-02 it held a stale one from the merged #1014 run, so the first armed
worktree came up reporting `standard·high·ui` on a `small·high·backend`
ticket.

It is silent. `arm-check.sh:49` prints *"initialized from the intake (no
parent ladder carried)"* and the carry then overwrites the stub, so the
message and the result disagree. **This reproduces on this very branch** —
arming printed that line and the ladder below it carried the parent's intake
note.

A branch comparison cannot be the discriminator: steps 0-1 legitimately run on
`main` while the worktree is on the feature branch.

After this task, `carry` proceeds only when BOTH hold:

- the parent ladder's `size`, `risk` and `surface` all equal the locked
  intake's, and
- the parent ladder's `updatedAt` is not older than the intake file's
  modification time.

Otherwise it keeps the stub and prints the reason. Either way the carry prints
its own outcome, so the message and the result can never disagree again.

**Exit codes are load-bearing.** A refusal is a CORRECT outcome, not a fault:

- carried → exit 0, print `ladder: carried from <parent-root>`
- refused → exit 0, print `ladder: kept the intake stub — <reason>`
- fault (no ladder at the source, unreadable JSON, same-worktree source) →
  non-zero, as today via `fail()`

`feature-setup.sh:87-88`'s `|| echo "…carry failed…"` today conflates a
refusal with a fault. Drop that fallback message and let the command speak;
keep a `|| true`-equivalent only for the genuine fault path so a fault still
never blocks arming (the stub is always a safe fallback).

### §1 interface

```
progress.mjs carry <parent-repo-root|parent progress.json> [--intake <path>] [--runtime codex|claude]
```

`--intake` defaults to `.feature/intake.json` in the destination worktree. When
the intake is absent or unreadable, carry is REFUSED with that reason — the
axes cannot be checked, and an unchecked carry is what this task removes.

Keep the existing `samePath` guard at `progress.mjs:197-203` exactly as it is;
its comment records a real macOS symlink defect.

### §2 behavior — the loud axes

`scripts/arm-check.sh:40-45` reads `size`, `risk` and `surface` from the
intake and silently substitutes `standard` / `normal` / `backend` for anything
it does not recognise. The ticket reports #1080's `"risk": "high"` becoming
`normal`.

**That does not reproduce against current code.** Running arm-check's own jq
expression over the real `docs/superpowers/plans/fix-1080-precedence-totality-intake.json`
returns `high`. The observed `normal` was almost certainly §1's carry
overwriting a correct stub. So this task pins the working behavior with a test
AND removes the silent substitution that makes such a report impossible to
diagnose.

After this task:

- A valid intake produces a stub whose axes equal the intake's — pinned.
- An absent, non-scalar, or out-of-vocabulary `size`, `risk` or `surface`
  makes `arm-check.sh` print `DISARMED: intake <field> is <value> — expected
  one of <vocabulary>` and exit 1. The intake is the run's authority; a run
  whose authority is unreadable must not arm.
- Line 49's parenthetical `(no parent ladder carried)` goes. `arm-check.sh`
  does not decide the carry, so it must not report it. The line becomes
  `ladder: .feature/progress.json initialized from the intake`.

Keep the `.risk // .classification // "normal"` legacy fallback ONLY for
`.classification` as a scalar; a `.classification` object is out-of-vocabulary
and now fails loudly.

### Security contract

None — no trust boundary is crossed. Both scripts read repository-local files
the caller already controls.

### Test titles (suite: `scripts/ci/__tests__/feature-workflow-runtime.test.ts`)

Extend the existing file. Its suites already drive `progress.mjs` and the
arming scripts as CLIs against fixture repositories. **Every fixture that
spawns `git` passes `env: GIT_FREE_ENV`** (`.claude/rules/ci-tooling.md`):
git exports `GIT_DIR` into hook processes, and under lefthook's `test-changed`
from a worktree the test otherwise commits into the pushing branch and writes
`core.bare=true` into the shared `.git/config`.

8. `carries the parent ladder when its axes match the intake and it is no older`
9. `refuses to carry a parent ladder whose axes disagree with the intake`
10. `refuses to carry a parent ladder older than the locked intake`
11. `names the reason when feature-setup keeps the intake stub instead of carrying`
    — drive `scripts/feature-setup.sh` end to end against a fixture worktree
    with a stale parent ladder; assert the printed reason and that the
    resulting `progress.json` axes equal the intake's.
12. `builds the arm-check stub from the intake size, risk and surface`
13. `refuses to arm when the intake risk is absent or not a declared value`
    — cover three fixtures: missing `risk`, `"risk": "medium"`, and
    `"classification": { "risk": "high" }` (an object). Assert exit 1 and that
    the message names the field.
14. `reports the stub without claiming a carry outcome it does not decide`
    — assert `arm-check.sh`'s output does not contain `no parent ladder
    carried`.

### Precedent

`scripts/ci/__tests__/feature-workflow-runtime.test.ts` (`native Codex
workflow` describe block: fixture repo, CLI invocation, `GIT_FREE_ENV`),
`progress.mjs:188-223` (`carry`), `progress.mjs:157-183` (`init`).

---

## T3 — #1199: docs-only changes run every suite that reads a doc

**Modify:** `.github/workflows/ci.yml`
**Modify:** `scripts/verify-gate.sh`
**Modify:** `lefthook.yml` (only if the audit below proves a gap)
**Test:** `src/__tests__/ci-audit-wiring.test.ts`

### Behavior

`.github/workflows/ci.yml:232-237` skips the whole `test` job on a docs-only
pull request, and its comment states the premise that no unit test reads
`docs/**` or `*.md` at run time — *"If a doc-reading test ever appears, this
condition must learn about it."* The premise is now stale.
`scripts/verify-gate.sh:358-372` skips the `test` row in docs-only mode for
the same reason, so the hole is not caught before push either.

Three doc-reading suites exist, not the two the ticket names:

| Suite | Reads |
|---|---|
| `src/__tests__/reference-shape.test.ts` | `.claude/reference/lab-notes/`, `.claude/rules/`, `docs/context/`, `docs/directory/`, `docs/directory.md`, `CONTEXT-MAP.md` |
| `src/__tests__/claude-md-shape.test.ts` | `.claude/CLAUDE.md` |
| `src/__tests__/design-doc-token-pin.test.ts` | `docs/brand-asset-library/design-systems/{landing,island,console}/DESIGN.md` |

`design-doc-token-pin.test.ts` is the one #1199 missed. Its `SYSTEMS` table at
`src/__tests__/design-doc-token-pin.test.ts:40-52` names three `DESIGN.md`
files and reads each.

After this task a docs-only pull request that busts a documentation shape cap
fails, and the docs-only short-circuit is otherwise untouched: the full `test`
job, the build, promised-tests, reclassify and diff-coverage still skip.

### The shape

Run the three suites in `ci.yml`'s `lint` job, which never short-circuits. Do
NOT un-skip the `test` job: its Postgres service and full suite are still
pointless on a docs diff, and that asymmetry is the whole design of the
docs-only gate.

- **`ci.yml`, `lint` job**: one step, `pnpm vitest run <the three paths>`,
  placed after `Run typecheck`. Name it so a reader knows why a vitest call
  lives among the audits.
- **`ci.yml:232-237`**: rewrite the stale comment. It must state the true
  rule — doc-reading suites run in `lint`, which never skips, and the `test`
  job skips only the suites that read no doc.
- **`scripts/verify-gate.sh`**: in docs-only mode add a `doc-shape` row
  running the same three paths. It is a normal parallel row; it needs no DB and
  no build. Update the docs-only banner at `scripts/verify-gate.sh:644-646`,
  which currently lists what is skipped, to name the row that now runs.
- **`lefthook.yml`**: its `guards` command (`pnpm vitest run src/__tests__`,
  `lefthook.yml:52-53`) already runs all three unconditionally. **Verify this
  before editing.** If it holds, `lefthook.yml` needs no change and that fact
  is recorded in the guard test below — do not add a duplicate command.

### The derived guard — how it stops going stale

The failure this ticket is about is a true comment becoming false. A hardcoded
list of three repeats it. So the guard DERIVES the candidates and forces a
decision on each, using the two-column idiom
`src/__tests__/ci-audit-wiring.test.ts` already uses twice
(`UNGATED_BY_DESIGN` at lines 25-31, `CI_ONLY_BY_DESIGN` at lines 38-46):

1. Scan every `src/__tests__/*.test.ts` source for a string literal that
   starts `docs/` or `.claude/`, or ends `.md`.
2. Every candidate must be EITHER wired into both docs-only lanes (named in
   `ci.yml`'s lint step AND in `verify-gate.sh`'s docs-only row) OR listed in
   a `NOT_DOC_READING: Record<string, string>` map with a reason.
3. The map's keys must all still be candidates, so a stale excuse fails —
   mirroring `excuses only scripts that exist` at line 116.

`src/__tests__/design-token-single-source.test.ts:217` names a docs path
inside a FAILURE MESSAGE, not a read. It belongs in `NOT_DOC_READING` with
exactly that reason. Check each remaining candidate the same way and give each
its own honest reason; do not write one reason twice.

### Security contract

None — no trust boundary is crossed.

### Test titles (suite: `src/__tests__/ci-audit-wiring.test.ts`)

15. `every src test that reads a doc at run time runs in the docs-only lane`
    — the derived check: candidate, wired, excused, in the
    `expect({...}).toEqual({...})` shape line 86 uses, so a failure names the
    file and which column it is missing from.
16. `the lint job runs the doc-reading suites, and the lint job never skips`
    — assert the `lint` job block (via the existing `jobBlock` helper at
    lines 158-170, which strips comments so prose can never satisfy a check)
    contains the vitest step, and that the block carries no
    `needs.changes.outputs.docs_only` condition.
17. `verify-gate docs-only mode runs the same doc-reading suites as the lint job`
    — parse both files and assert the two path sets are equal. Not
    "both non-empty": equal, or the two lanes can drift.
18. `counts the design-system doc pin as a doc-reading suite`
    — name `design-doc-token-pin.test.ts` explicitly. It is the suite #1199
    missed, and a regression that drops it must fail by name rather than by
    a count.

### Precedent

`src/__tests__/ci-audit-wiring.test.ts` (both excuse maps, `jobBlock`,
`ciScriptsInvokedIn`), `.github/workflows/ci.yml:140-150` (the `lint` job's own
"never short-circuits" comment).

---

## T4 — #1305: verify the landed fix and close

**Create:** nothing. **Modify:** nothing.

### Behavior

#1305 reports two `red-team-status.test.ts` cases under *"the committed Run E
second-pass proof"* exceeding Vitest's 5000 ms default under full-suite load,
green on re-run.

`scripts/ci/__tests__/red-team-status.test.ts:28` already carries
`vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })`, landed by
`c9b2a2f9a` — *"fix(ci): red-team-status tests need more than the 5s default
timeout (#1310)"*, 2026-09-18. The comment above it at lines 20-27 names both
reported titles and argues 30 s over a retry, in the same terms #1305 uses.

The ticket's proposal (20 s on the Run E describe block) is SUPERSEDED, not
unimplemented: the landed fix is file-wide and higher.

### Evidence to produce

Run `pnpm vitest run scripts/ci/__tests__/red-team-status.test.ts` — the
intake's one `verification_command`, so the gate runs it as a row too. Record:
the commit SHA, the config line, and that both named cases pass.

Close #1305 with that evidence and a link to `c9b2a2f9a`. Do not add a second
timeout: a per-describe 20 s would LOWER the ceiling the landed fix set for
exactly those cases.

### Test titles

None. This task writes no code, so it promises no test. The evidence is the
suite run plus the cited commit.

---

## Self-review

1. **Intake coverage.** All 18 `tests_to_add` titles map: 1-7 → T1, 8-14 → T2,
   15-18 → T3. Every `user_visible_behavior` entry maps: promised-tests row →
   T1; carry, arm-check message, loud axes → T2; lint job, gate docs-only row,
   new-suite guard → T3. Every `edge_cases` entry is named in its task's
   Behavior or Test section.
2. **Placeholder scan.** No `TBD`, no `TODO`, no "similar to Task N", no
   "handle edge cases". Every type and function a task consumes is defined by a
   task: `promised_title_found` / `promised_title_spellings` (T1),
   `carry --intake` (T2), `NOT_DOC_READING` (T3).
3. **Security coverage.** No task crosses a trust boundary — all three read
   repository-local files under the developer's own control. T1 is the only one
   handling attacker-shaped input at all (a title is author-written), and it
   carries an explicit no-`eval` contract plus a literal-search case.
4. **Name consistency.** `promised_title_found`, `promised_title_spellings`,
   `NOT_DOC_READING`, `GIT_FREE_ENV` and `--intake` are spelled identically
   wherever they appear above.
