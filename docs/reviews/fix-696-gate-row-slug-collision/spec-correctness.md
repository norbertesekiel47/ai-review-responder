# Spec & correctness review — `fix-696-gate-row-slug-collision`

Commit under review: `f3d64fdd` (fork point `git merge-base HEAD origin/main`).
Reviewer: spec & correctness agent (review-only; no repo files edited except this report).

Environment for every reproduction below: `/bin/bash` on this machine is **GNU bash 3.2.57(1)-release (arm64-apple-darwin25)** — i.e. what `#!/usr/bin/env bash` resolves to when a login shell has no newer bash first on PATH, which is the bash 3.2 target the intake's `edge_cases` names.

---

## Verdict summary

| # | Severity | Location | Finding |
|---|---|---|---|
| F1 | Medium | `scripts/ci/__tests__/gate-rows.test.ts:98` | Wiring test asserts source *text*, so feeding the assert the wrong array (`PIDS` instead of `NAMES`) disables duplicate detection with 7/7 green — **reproduced** |
| F2 | Medium | `scripts/verify-gate.sh:137` | The bash-3.2 empty-array spelling at the real call site is untested; the mutation to `"${NAMES[@]}"` survives 7/7 and kills the gate on macOS default bash without writing a RED status — **reproduced** |
| F3 | Medium | `scripts/gate-rows.sh:29` | New source-time `exit 1` runs *before* `gate_abort` is defined, so it exits leaving the previous run's green `gate-status.json` — violates a locked intake invariant — **reproduced** |
| F4 | Low | `scripts/verify-gate.sh:69` | `kill $(jobs -p)` does **not** kill the full-vitest row (function-wrapped subshell → grandchild survives); the comment names that exact row as the reason for the kill — **reproduced** |
| F5 | Low | `scripts/verify-gate.sh:58` | `GATE_SCRIPT_DIR` is not CDPATH-hardened; an exported `CDPATH` breaks the source and produces `GATE: RED — duplicate gate row name 'lint'` on every run — **reproduced** |
| F6 | Low | `scripts/verify-gate.sh:197` | Uniqueness is asserted only inside `launch()`; dynamic rejected-extra rows register through `NAMES+=` and bypass it |
| F7 | Low | `scripts/ci/__tests__/gate-rows.test.ts` (absence) | `gate_abort` — including the RED-`gate-status.json` write that is `user_visible_behavior[2]` and D2's entire justification — has no test |

**Blocking: F1, F2, F3** (three). F1/F2 mean the suite is green while the shipped feature can be disabled or the gate can be bricked on the primary dev platform; F3 breaks an invariant the intake locked verbatim.

---

## What is correct (verified, not asserted)

Before the findings, the parts I confirmed work:

- **The ticket's live collision is closed.** `row_slug` produces `…-8cd3d8` for `src/lib/reviews/__tests__/import-consent.integration.test.ts` and `…-346e50` for `…import-consent-analytics.integration.test.ts` — distinct row name, distinct `.feature/logs/<name>.log`, distinct `--coverage.reportsDirectory`.
- **Both slug sites are routed.** `grep -rn "cut -c1-" scripts/ .claude/` finds the truncation only inside `scripts/gate-rows.sh` (and one assertion string in the test). The ticket named only the integration site; the extras site at `verify-gate.sh:193` was fixed too, which is the right call.
- **The duplicate-name abort works end-to-end.** Ran the real `scripts/verify-gate.sh` in a sandbox repo with `verification_commands: ["echo hello", "echo hello"]`:
  ```
  gate-rows: duplicate row name 'extra-echo-hello-2e2664' — two checks would share one status slot …
  VERIFY GATE:
    row-name-collision       FAIL
  GATE: RED — duplicate gate row name 'extra-echo-hello-2e2664' (see above).
  exit=1
  → .feature/gate-status.json = {"passed":false,…,"checks":[{"name":"row-name-collision","result":"FAIL"}]}
  ```
  `exit` from `gate_abort` (called in `launch()`, which runs in the main shell) does terminate the script, and the RED file is written.
- **`${NAMES[@]+"${NAMES[@]}"}` is genuinely load-bearing on bash 3.2.** Guarded spelling: `got 1: lint`. Bare spelling: `line 5: NAMES[@]: unbound variable`, shell exits 1.
- **`.` + `${BASH_SOURCE[0]}` resolves for both invocation forms.** `bash scripts/verify-gate.sh` from the worktree root and `bash /abs/path/scripts/verify-gate.sh` both source the sibling library correctly (confirmed by the sandbox runs above).
- **All 7 `tests_to_add` titles exist verbatim** under `src`/`worker`/`scripts` (ran the gate's own `grep -rqF` check for each). `scripts/ci/__tests__/gate-rows.test.ts` passes 7/7 in the worktree.
- **No intake drift.** Changed paths are exactly `scripts/verify-gate.sh`, `scripts/gate-rows.sh`, `scripts/ci/__tests__/gate-rows.test.ts` plus two `docs/**` files (exempt). `.feature/intake.json` and the docs copy are byte-identical after `jq -S`.
- **Deviation verdicts D3 and D4 hold up.** `docs/directory.md` contains **zero** `.sh` mentions (`grep -c '\.sh' docs/directory.md` → 0), so D3's "adding a row for this one shell library would misrepresent the table's scope" is accurate. For D4, the only consumer of row names anywhere is `.claude/hooks/stop-gate.sh:62`, which joins FAIL names into a human message — nothing keys off the exact spelling, so dropping the trailing `-` is free as claimed.

---

## Findings

### F1 — Medium — `scripts/ci/__tests__/gate-rows.test.ts:98-105`: the wiring test cannot see a mis-wired assert

`registers every launched row through assert_unique_row_name` asserts only that the text of `launch()` *contains* the strings `assert_unique_row_name` and `gate_abort`. It never executes `launch()`, so it cannot tell a correctly-wired assert from one wired to the wrong data.

**Reproduced mutation.** Copied the three files to `/tmp/g696/mut2`, changed `verify-gate.sh:137` to:

```sh
assert_unique_row_name "$name" ${PIDS[@]+"${PIDS[@]}"} \
```

`vitest run scripts/ci/__tests__/gate-rows.test.ts` → **Tests 7 passed (7)**.

**Failure scenario.** With that one-token change the gate compares each new row name against a list of *process IDs*, so it never matches and never aborts. Two `import-consent-*.integration.test.ts` suites again share one status slot and one log file, and a FAILED suite is reported as the other's PASS — the exact #696 defect, shipped under a green suite and a green gate. This is the same class the ticket itself calls out ("a check that structurally cannot see what it claims to enforce", cross-referenced to #694), and it is the repo's standing lesson that a test asserting source text rather than behaviour is weak. The intake cites `src/__tests__/ci-audit-wiring.test.ts` as the precedent for text assertions, and text assertions are the right tool for *"this list did not drift"* — but they are the wrong tool for *"this guard is armed"*.

**What would close it.** Execute the real `launch()`. The gate is already provably runnable from a sandbox (see "What is correct" above): a test that stands up a temp dir with `.feature/intake.json` carrying two identical `verification_commands`, runs `bash scripts/verify-gate.sh`, and asserts exit≠0 + `row-name-collision` in `gate-status.json` kills F1, F2 and F7 in one shot and takes ~1s.

---

### F2 — Medium — `scripts/verify-gate.sh:137`: the bash-3.2 empty-array guard is untested at the site that needs it

D1 justifies adding the test `accepts the first row name when no rows are registered yet` with: *"`${NAMES[@]+…}` is load-bearing for the very first `launch lint` call and nothing else would have caught a regression there."* That is not what the test does. The test re-spells the guard **inside the TypeScript file**:

```ts
const result = runWithLib('NAMES=(); assert_unique_row_name lint ${NAMES[@]+"${NAMES[@]}"}');
```

so it exercises the string the test itself wrote, never `verify-gate.sh:137`.

**Reproduced mutation.** `/tmp/g696/mut`, `verify-gate.sh:137` → `assert_unique_row_name "$name" "${NAMES[@]}"`. `vitest run` → **Tests 7 passed (7)**.

**Failure scenario (bash 3.2, the macOS default).** The first `launch lint` expands `"${NAMES[@]}"` against an empty array under `set -u`:

```
verify-gate.sh: line 137: NAMES[@]: unbound variable
```

`set -u` errors are fatal in a non-interactive shell, so the gate dies at line 137 — **before** anything writes `.feature/gate-status.json`. The previous run's file is left on disk, and `.claude/hooks/stop-gate.sh` only rejects it when `GATE_TS < HEAD_TS`; a green recorded against the current HEAD (the normal case — you go green, then edit, then re-run) passes the Stop gate. So the mutation converts the gate into a no-op that still satisfies the Stop hook, with the suite green.

Note this is the intake's own `edge_cases[3]`, so it is a promised behaviour with no real coverage.

---

### F3 — Medium — `scripts/gate-rows.sh:29` + `scripts/verify-gate.sh:60`: the new source-time `exit 1` leaves a stale-green `gate-status.json`

`gate-rows.sh` resolves the hash tool at source time and exits fatally if neither `shasum` nor `sha1sum` is on PATH. `verify-gate.sh` sources it at line 60; `gate_abort` is not defined until line 65. So this exit path — the only bare `exit` the commit introduces, and the only one in the file that is not `gate_abort` (pre-fix, `grep -n 'exit ' ` on `f3d64fdd^:scripts/verify-gate.sh` returns exactly lines 93/368/371, all of which write the status file first) — cannot write a RED status even in principle.

**Reproduced.** Sandbox at `/tmp/g696/probe` with a green `.feature/gate-status.json` and a PATH containing neither hash tool:

```
before: {"passed":true,"mode":"full","timestamp":9999999999,…}
gate-rows: neither shasum nor sha1sum on PATH — cannot derive collision-free row names
exit=1
after:  {"passed":true,"mode":"full","timestamp":9999999999,…}   ← unchanged
```

**Standard violated.** `.feature/intake.json` → `invariants[2]`: *"The gate never exits with a stale-green `.feature/gate-status.json` on disk."* This is verbatim the failure D2 argues `gate_abort` exists to prevent ("Aborting without it would leave the previous run's green file for `.claude/hooks/stop-gate.sh` to read as this run's result") — the commit closes that hole at one new abort site and opens it at another.

**Failure scenario.** A CI image / minimal container / `PATH`-scoped invocation without `shasum` or `sha1sum` (the file's own comment concedes this is reachable, which is why it chose fatal over degraded). The run silently keeps the last green, `stop-gate.sh` reads `passed:true` with `GATE_TS >= HEAD_TS`, and the session is allowed to end with no gate evidence for the current tree.

**Fix shape.** Either move the tool resolution into `row_slug` (first-use, so the failure lands inside `launch`/the extras loop where `gate_abort` exists), or move the `. gate-rows.sh` line below `gate_abort()`'s definition and have `gate-rows.sh` `return 1` so the caller can `|| gate_abort "hash-tool-missing" …`. The latter also keeps the library `return`-safe for the test harness, which currently relies on `exit` semantics that differ between `source` and direct execution.

---

### F4 — Low — `scripts/verify-gate.sh:67-69`: `kill $(jobs -p)` does not reach the row the comment names

The comment says: *"Rows already launched are detached children; without this they outlive the abort and keep burning CPU (`pnpm build`, the full vitest suite)."*

`kill $(jobs -p)` signals the job PIDs of the current shell. For `launch build pnpm build`, bash exec-optimises `( pnpm build ) &` so the job PID *is* `pnpm`. For the test row it cannot: `launch test run_full_suite pnpm test --maxWorkers=…` wraps a shell **function**, so `( run_full_suite … ) &` is a genuine subshell process and the `pnpm`/`node` grandchildren are not in `jobs`.

**Reproduced** (`/tmp/g696/orphan.sh`, bash 3.2), launching one direct row and one function-wrapped row, both `sleep 300`:

```
launched direct  pid=70697     70697 70696 sleep 300          ← exec-optimised
launched wrapped pid=70698     70698 70696 /bin/bash orphan.sh ← real subshell
descendants before abort: 70697 70700
aborted
sleep 300 survivors after abort: 70700   ← the wrapped row's grandchild
```

**Failure scenario.** `launch test` (line 171/173) happens before every collision-capable `extra-`/`integration-` row, so any `gate_abort` from `launch()` orphans a 4-worker vitest run that keeps hammering the CPU and, on a `db_touching` intake, the test database — while the operator has been told the gate aborted and everything was killed. Wrapping in a process group (`set -m` + `kill -- -$pid`) or killing the descendant tree would match the comment; failing that, the comment should stop naming the vitest suite.

---

### F5 — Low — `scripts/verify-gate.sh:58`: `GATE_SCRIPT_DIR` is not CDPATH-hardened

```sh
GATE_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
```

`cd` writes the resolved path to stdout when the directory was found via `CDPATH`, so with `CDPATH` exported the command substitution captures two lines.

**Reproduced.** `CDPATH=.:/tmp bash -c 'D=$(cd "$(dirname "scripts/verify-gate.sh")" && pwd); echo "[$D]"'` →

```
[/tmp/g696/e2e/scripts
/tmp/g696/e2e/scripts]
```

Running the real gate with `CDPATH` exported:

```
verify-gate.sh: line 60: /tmp/g696/e2e/scripts
/tmp/g696/e2e/scripts/gate-rows.sh: No such file or directory
verify-gate.sh: line 137: assert_unique_row_name: command not found
GATE: RED — duplicate gate row name 'lint' (see above).
```

**Failure scenario.** Any developer with `CDPATH` exported (a common `.zshrc`/`.bashrc` convenience) can never run the gate, and the error blames a duplicate row name for a missing-library problem. It fails *closed*, which is why this is Low rather than Medium — but it is a new, unconditional false RED introduced by this commit (pre-fix the script had no `cd` and no source). Standard hardening: `GATE_SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)`.

---

### F6 — Low — `scripts/verify-gate.sh:190-202, 250-253`: uniqueness is asserted only in `launch()`

The intake goal is *"assert uniqueness **at registration**"*. `launch()` is one of several registration sites. The rows appended directly to `NAMES` — `db-provision` (:248), rejected extras (:252), `promised-tests` (:287), `reclassify` (:324/:331), `run_sync` rows (:259/:261), `integration-suites` (:351) — never call `assert_unique_row_name`. All but one are literals; the exception is the **rejected-extra** row, which is `row_slug`-derived and therefore the one dynamic name in the file that is registered without the guard.

**Failure scenario.** `verification_commands: ["pnpm test:db:setup && x", "pnpm test:db:setup && x"]` (a duplicated intake entry — easy to produce when an intake is edited). Both entries take the `continue` branch, so:
- `.feature/logs/extra-<slug>.log` is opened with `>` twice — the second run truncates the first entry's rejection notice;
- `extra-<slug>` is appended to `NAMES` twice, printing the same row twice in the table and emitting two `{"name":"extra-<slug>",…}` objects into `gate-status.json`.

One name, two status slots — the precise condition the ticket set out to make impossible. It is **not** green-masking (rejected extras are always `FAIL`, so `PASSED=false` regardless), hence Low. But it also means `assert_unique_row_name` currently has exactly one caller, which sits awkwardly with CLAUDE.md's "no abstractions for a single caller"; routing the rejected-extra registration through it both closes the gap and earns the abstraction.

I checked for the more dangerous variants and did not find them: no `ci:*` key in `package.json` shadows `lint`/`typecheck`/`test`/`build` (`ci:admin-aal2 … ci:tenant-scope`, none collide), and a `row_slug`-derived name always carries an `extra-`/`integration-` prefix plus a `-[0-9a-f]{6}` suffix, so it cannot collide with any literal row name including `integration-suites`.

---

### F7 — Low — `scripts/ci/__tests__/gate-rows.test.ts`: `gate_abort` is entirely untested

No test in the suite spawns `verify-gate.sh` or `gate_abort`. Consequently:

- `user_visible_behavior[2]` — *"aborts the gate with a named error **and a RED gate-status.json** instead of silently overwriting a row"* — is unverified. Deleting the `printf … > .feature/gate-status.json` line from `gate_abort` passes 7/7.
- D2's entire correctness argument (the stale-green class) has no regression test, which is what let F3 through.
- The `db-provision` path was refactored to call `gate_abort`; nothing asserts its behaviour is unchanged.

The orchestrator's two mutation-verifications (drop the hash suffix → 2 red; always-return-0 assert → 1 red) both land inside `gate-rows.sh`, which is the only file the suite actually executes. Every mutation in `verify-gate.sh` I tried survived (F1, F2), which is consistent: the suite has real behavioural coverage of the library and text-only coverage of the consumer.

---

## Deviation verdicts — challenges

| Deviation | Orchestrator | My read |
|---|---|---|
| D1 — two extra test titles | ACCEPT | **Verdict stands, justification does not.** Adding the titles is right. But the stated reason for `accepts the first row name when no rows are registered yet` ("nothing else would have caught a regression there") is false — see F2, the regression at the call site passes. And `registers every launched row through assert_unique_row_name` does not close the "correct but unwired" gap it claims to close — see F1, a mis-wired assert passes. |
| D2 — `gate_abort` extracted | ACCEPT | **Stands** (two call sites, shared behaviour is a correctness requirement). Incomplete in two ways: a new exit path bypasses it (F3), and its child-kill does not reach the row its comment names (F4). |
| D3 — not added to `docs/directory.md` | ACCEPT | **Stands, verified.** `grep -c '\.sh' docs/directory.md` → 0. |
| D4 — `echo` → `printf` in the slug | ACCEPT | **Stands, verified.** The only row-name consumer anywhere is `stop-gate.sh:62`, which joins FAIL names into a message. |

## Intake conformance

| Field | Result |
|---|---|
| `allowed_edit_surface` | PASS — exactly the three named files, plus two `docs/**` (exempt) |
| `user_visible_behavior` | 3/3 implemented; item 3's "RED gate-status.json" half is untested (F7) |
| `invariants` | 1 and 2 hold; **invariant 3 violated by the new source-time exit (F3)** |
| `edge_cases` | 4/4 handled in code; edge case 4 (bash 3.2 empty array) is handled but untested at the real site (F2) |
| `tests_to_add` | 7/7 present verbatim (verified with the gate's own `grep -rqF`) |
| `non_goals` | PASS — nothing changes which checks run, their order, the fan-out, `gate-status.json`'s schema, #694, or the #679 call-site rename |
| `estimated_prod_lines: 65` | ~112 actual prod lines (65 new + 47 changed) — under the 2× reclassify trigger |
| `dependencies_added: []` | PASS |

## Repo-standards check (`.claude/CLAUDE.md`)

- **New file justified** — yes. Bash genuinely has no in-file unit-test seam (sourcing `verify-gate.sh` runs the gate); the split is what makes `row_slug` testable at all. No new top-level directory.
- **No abstraction before the second use** — `gate_abort` (2 callers) and `row_slug` (2 callers) pass. `assert_unique_row_name` has 1 caller; justified by the test seam and named by the ticket, but see F6 — it *should* have a second.
- **Precedent over invention** — followed: the abort mirrors the pre-existing db-provision failure path, and the test file follows `scripts/ci/__tests__/merge-coverage.test.ts` (a `scripts/ci/__tests__` suite covering a `scripts/` file) and `src/__tests__/ci-audit-wiring.test.ts` (source-as-text). The second precedent is the source of F1/F2 — it is the right precedent for drift detection and the wrong one for arming a guard.
- **Net-negative bias** — not applicable to a defect fix; the db-provision refactor is net −2 lines at that site.
- **Working rules** — bash only, no DB, no outbox, no flags, no `NEXT_PUBLIC_*`. Nothing else applies.

---

## Low-confidence appendix (NOT in the findings table)

1. `scripts/gate-rows.sh` is mode `100644` with a `#!/usr/bin/env bash` shebang. Correct for a sourced library, but `# shellcheck shell=bash` is the conventional marker; the shebang implies an executable that will never be executed.
2. `gate_abort` hardcodes `"mode":"full"` in the JSON. The `db-provision` caller is guarded by `DOCS_ONLY = false`, but the extras loop is not — a docs-only run with duplicated `verification_commands` writes `"mode":"full"`. Harmless today (`passed:false` short-circuits every consumer), pre-existing shape.
3. Shrinking the hash to `cut -c1-1` would still pass `derives distinct slugs…` (the two ticket paths hash to `8cd3d8` / `346e50`, differing in the first nibble). Untested mutation, but 6 hex chars is a sound choice and the mutation is contrived.
4. `expect(source).not.toContain('cut -c1-40')` is a literal-string guard: `cut -c1-41` or `head -c 40` would reintroduce a bare truncation without tripping it.
5. Two *identical* `verification_commands` now hard-abort the whole gate rather than being deduped. This is `user_visible_behavior[2]` as written, so it is in-contract — but a duplicated intake line is a benign authoring slip and dedup-with-a-warning may be the kinder behaviour.
6. `row_slug` forks 5 processes per call (`printf`/`tr`/`cut`/hash/`cut`). Irrelevant at gate scale; noted only because it runs once per changed integration suite.
7. `runWithLib` uses `bash -euo pipefail` while the gate runs `set -uo pipefail`. Stricter, so no false green from the difference, but the harness is not running the shell the code ships under.

## Reproduction artifacts

All scratch work lives under `/tmp/g696/` (no repo files were written):

- `t1.sh` / `t2.sh` — bash 3.2 empty-array expansion, guarded vs bare
- `mut/` — mutation `${NAMES[@]+"${NAMES[@]}"}` → `"${NAMES[@]}"`; 7/7 pass (F2)
- `mut2/` — mutation `NAMES` → `PIDS` in the assert; 7/7 pass (F1)
- `probe/` — gate run with no `shasum`/`sha1sum` on PATH; stale green survives (F3)
- `orphan.sh` — `kill $(jobs -p)` vs a function-wrapped row (F4)
- `e2e/` — real `verify-gate.sh` in a sandbox repo: duplicate-row abort (correct), absolute-path invocation (correct), `CDPATH` breakage (F5)

---

# Triage — round 1 (orchestrator)

All seven table findings ACCEPTED, plus appendix item 4. Fixes landed in the
round-1 fix commit; durable reasoning in
`docs/superpowers/plans/fix-696-gate-row-slug-collision-deviations.md` (D1b, D5,
D6).

| # | Finding | Verdict | Fix |
|---|---|---|---|
| F3 | source-time `exit 1` leaves a stale-green `gate-status.json` | ACCEPT (blocking) | `gate_abort` moved **above** the source; `gate-rows.sh` now contains no `exit` at all; the caller aborts on an unset `GATE_ROW_HASH_CMD` |
| F1 | wiring test asserts source text; `NAMES`→`PIDS` mutant passes | ACCEPT (blocking) | text test deleted; three tests now run the real `launch`/`gate_abort` bodies extracted from `verify-gate.sh` |
| F2 | bash-3.2 empty-array guard untested at the real call site | ACCEPT (blocking) | covered by *launches the first row when no rows are registered yet*, which exercises the real `launch` |
| F5 | `cd` not `CDPATH`-hardened; a failed load reports a bogus collision | ACCEPT | `CDPATH= cd`, plus a post-source `command -v row_slug` guard that names the real cause |
| F6 | rejected-extras path registers via `NAMES+=` and bypasses the assert | ACCEPT | that path asserts its own name; `REJECTED_EXTRAS` became an array |
| F7 | `gate_abort` entirely untested | ACCEPT | two tests assert the RED `gate-status.json` it writes |
| F4 | `kill $(jobs -p)` does not reach grandchildren | ACCEPT (comment only) | behaviour deliberately unchanged — per-row process groups need `set -m`, which changes the `jobs -rp` throttle the whole fan-out depends on. Comment corrected to claim only what it does. |
| A4 | `not.toContain('cut -c1-40')` is a literal-string guard | ACCEPT | widened to `/\b(cut\s+-c\s*1-\d+\|head\s+-c\s*\d+)/` |

Appendix items 1–3, 5–7 rejected: 3 and 4-adjacent mutations are contrived; 5 is
`user_visible_behavior[2]` as locked (a hard abort on a duplicated intake line is
the contract, and dedup-with-a-warning is the silent-resolution this ticket
exists to remove); 6 is irrelevant at gate scale; 7 is stricter than production,
so it cannot produce a false green.

## Mutation matrix after the fixes (baseline 10/10 green)

Run against copies of the two scripts; repo files untouched.

| Mutation | Result |
|---|---|
| `launch` asserts over `${PIDS[@]}` instead of `${NAMES[@]}` | **1 test red** — F1 killed |
| `${NAMES[@]+"${NAMES[@]}"}` → `"${NAMES[@]}"` | **2 tests red** — F2 killed (confirmed on `bash 3.2.57`, what `/usr/bin/env bash` resolves to here) |
| `gate-rows.sh` regains its source-time `exit 1` | **1 test red** — F3 killed |
| post-source `command -v row_slug` guard deleted | **1 test red** — F5 killed |

## Residual, accepted knowingly

- The "no hash tool on PATH" branch is covered structurally (the library
  contains no `exit`) rather than by executing a PATH stripped of `shasum` *and*
  `sha1sum` — the gate needs `mkdir`/`dirname` off that same PATH, so the setup
  would test the harness more than the code.
- A `row_slug`-derived name could in principle collide with a **literal** row
  appended outside `launch` (a hypothetical `ci:integration-suites` audit vs. the
  literal `integration-suites` row). Undefended: no such script exists, and
  `launch`'s assert covers every launched-vs-launched pair.
