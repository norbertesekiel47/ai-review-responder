# Standards & Maintainability review — `fix/gate-tooling-batch-a`

**Skill run:** `thermo-nuclear-code-quality-review` (invoked and followed; the
`code-review` fallback was not needed).

**Diff reviewed:** `git merge-base HEAD origin/main` = `3795a0f50` → `b17a55d3e`.
391 executable production lines across 7 files, plus 592 test lines. Workflow
paperwork reviewed only for false claims about the code (one found — F5).

**Verification performed:** read every production hunk and every test hunk;
re-ran `vitest run src/__tests__/ci-audit-wiring.test.ts
scripts/ci/__tests__/gate-promised-tests.test.ts
scripts/ci/__tests__/gate-rows.test.ts` (118 passed); re-implemented
`stringLiterals`/`mentionsDocPath` standalone and ran it against the real
`src/__tests__` tree and against adversarial fixtures; traced `set -e`
semantics through `promised_title_found` and `arm-check.sh`; traced
`findWatchers` → `processServes` → `processCwd` against real `ps`/`lsof`
behaviour; diffed for deleted/skipped/loosened assertions.

---

## Findings table (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| MAJOR | `src/__tests__/ci-audit-wiring.test.ts:275` | `stringLiterals` is blind to JS **regex** literals; a quote-bearing regex on the same line as a doc-path string (the exact shape already at `src/__tests__/page-metadata.test.ts:55`) makes the doc path vanish from the scan, so a real doc-reading suite is never a candidate and the whole `it.each` passes vacuously — a false GREEN in the lane #1199 exists to keep honest. Reproduced. |
| MAJOR | `.agents/skills/red-team/scripts/mutation-runner.mjs:2052` | T5's worktree narrowing is applied in `--ps-source` **fixture** mode, so fixture PIDs (`999`, `101`, `102` in `red-team-mutation-runner.test.ts:1658-1671`) are resolved with real `lsof` against the live machine. The same call deliberately neutralises `selfAncestry` for fixture mode but leaves `cwdOf` on the default — a hermetic test made machine-dependent. |
| MINOR | `scripts/arm-check.sh:49-95` | Three near-identical type-probe blocks and six `jq` spawns where one `jq` pass plus the three existing `case` checks does the whole job. |
| MINOR | `scripts/ci/__tests__/gate-promised-tests.test.ts:153-159` | `describe('verify-gate.sh row wiring')` re-asserts the gate's roots as **source text** — precisely the weaker form `gate-rows.test.ts:188-197` documents as mutant-passing, and which that suite already covers by executing the real line. |
| MINOR | `docs/superpowers/plans/fix-gate-tooling-batch-a-plan.md:23` | "This REMOVES implementation … Smaller body" is false for `arm-check.sh`: the axis block went 6 lines → 47 (`+55/−6` on the file). A plan row reporting a state that is not the branch's state — this branch's own defect class. |
| MINOR | `.agents/skills/red-team/scripts/mutation-runner.mjs:2148` | An invalid `--phase` is a ninth rejection cause reported as `'candidate metadata is invalid'`, while the new docblock claims the cause is "no longer fused". `candidateMetadata` is also a pure alias of `operatorMetadata`. |
| MINOR | `scripts/feature-setup.sh:92` | `\|\| echo "…keeping the auto-initialized stub."` became `\|\| true`: on the genuine-fault path the call site no longer says it continued with the stub. |

---

## F1 (MAJOR) — the doc-reading scanner can go silently green

`src/__tests__/ci-audit-wiring.test.ts:275-283`

```ts
const re =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
```

The docblock's two stated hazards (apostrophes in comments; backticks in
comments) are handled correctly — I verified both. The hazard it does **not**
handle is the third one it names only in passing, at line 309, and then treats
as a property of this one file: **regex literals**.

The self-exclusion at line 313 (`.filter((entry) => entry !== 'ci-audit-wiring.test.ts')`)
patches the one instance the author knew about. The blindness is general. Run
against the real tree today, the scanner's output for `ci-audit-wiring.test.ts`
is a 500-character "literal" that swallows the whole `mentionsDocPath`
docblock — proof that the corruption is real, not theoretical.

Reproduced false negative:

```js
// one line, both halves perfectly ordinary
expect(src).toMatch(/title:\s*['"]/); const DOC = 'docs/runbooks/new-thing.md';
// stringLiterals → ['"]/); const DOC = ']      ← the doc path is GONE
// mentionsDocPath → false                       ← not a candidate
```

`/title:\s*['"]/` is not invented: it is live at
`src/__tests__/page-metadata.test.ts:55`. The moment someone writes a
doc-reading assertion next to a quote-bearing regex, the suite drops out of
`docReadingCandidates()`, `it.each` never runs for it, and every remaining
assertion in the describe block still passes. The `toBeGreaterThanOrEqual(3)`
floor does not catch it — three other candidates remain.

The failure direction is the bad one. This is a checker whose entire premise is
"a claim about *every* doc-reading test must not go stale", and it can go stale
silently, by the same mechanism.

**Remedy — delete the lexer.** The property under test is "reads a doc at run
time". Two ways to get it without lexing JS:

1. *Over-approximate on raw text* — `if (/docs\/|\.claude\/|\.md\b/.test(src))`
   it is a candidate. More files land in the wired-or-excused columns, which is
   the **safe** direction, and `NOT_DOC_READING` is already the idiom for
   excusing them. Removes ~35 lines, the docblock, and the self-exclusion hack.
2. *Match the actual read* —
   `/(?:readFileSync|readdirSync|existsSync)\s*\([^)]*(?:docs\/|\.claude\/|\.md)/`.
   Tighter, still no lexer, and it matches the sentence the check actually
   wants to enforce instead of a proxy for it.

Either one makes the excuse list shorter *and* the check harder to fool. I
would take (1): the two current `NOT_DOC_READING` entries survive unchanged,
and over-approximation cannot produce a false green.

Related, smaller: `withoutHashComments` (line 348) reimplements the filter
already inlined in `jobBlock` (line 172) and its own comment says so ("Same
reasoning as `jobBlock` above"). Extract once, call it from both.

---

## F2 (MAJOR) — T5 narrowed correctly in production, and one step too far in the test seam

`.agents/skills/red-team/scripts/mutation-runner.mjs:2048-2056`

**The narrowing itself is right.** `processServes` fails **closed** on an
unreadable cwd (`cwd === null → true`), so an absent `lsof`, an
already-exited process, or a process owned by another user all keep blocking —
the pre-T5 machine-global behaviour. The boundary check
(`root.endsWith('/') ? root : root + '/'`) correctly refuses a sibling
`…/RepWorth-worktrees/other-branch` that shares a prefix with
`…/RepWorth-worktrees/other`. `findWatchers` stays pure and untouched, and the
two new tests pin **both** directions (unrelated checkout admitted; own-worktree
watcher still blocks). `repoRoot()` is `git rev-parse --show-toplevel`, which
returns the physical path, so it agrees with `lsof`'s resolved cwd. I could not
find a false-GREEN path in the production lane.

**The problem is `cmdWatchers`.** Look at what the same call does with the two
machine-dependent inputs:

```js
const matches = findWorktreeWatchers(
  output,
  typeof parsed['ps-source'] === 'string' ? new Set() : selfAncestry(),  // neutralised
  root,                                                                   // …but cwdOf is not
);
```

`--ps-source` exists to make this command hermetic. The author saw that and
neutralised `selfAncestry`. `cwdOf` defaults to the real `processCwd`, so every
PID in the fixture file is handed to a live `lsof`. `red-team-mutation-runner.test.ts:1658`
writes `101`/`102`, line 1671 writes `999`. On a machine where one of those PIDs
exists, is readable, and has a cwd outside the fixture repo, the match is
dropped and `aborts when a process matching "%s" is live` flips from status 1 to
status 0. Today it passes because low PIDs are root-owned and `lsof` returns
non-zero (fail-closed) — that is luck, not design, and it varies by OS, by
container, and by whether the runner is root.

**Remedy:** pass a fixture `cwdOf` on the same ternary, so both machine inputs
are neutralised together:

```js
typeof parsed['ps-source'] === 'string' ? () => root : undefined
```

Two lines, and `--ps-source` goes back to meaning what its name says.

---

## F3 (MINOR) — `arm-check.sh`: keep the three `case` blocks, collapse everything above them

`scripts/arm-check.sh:49-95`

You asked for a verdict, not both sides. **The duplication is not honest bash —
it is avoidable, and the part that is duplicated is the part that carries no
information.**

The three `case` vocabulary blocks *should* stay three blocks. Each names a
different vocabulary and a different DISARMED sentence, they are greppable, and
bash gives you no clean way to return "value + fail with a message on stdout"
from a function (the tests assert on **stdout**, and a command substitution
would capture the message — that alone rules out the obvious helper). Keeping
them explicit is the right call.

What is *not* earning its keep is the 3×6 lines of type-probing above them and
the six `jq` process spawns. That scaffolding is byte-identical for `surface`
and `size`, and `jq` can express the whole thing in one pass:

```bash
IFS=$'\t' read -r LADDER_RISK LADDER_SURFACE LADDER_SIZE < <(jq -r '
  def scalar(v): if (v|type) == "string" then v else (v|tojson) end;
  [ scalar(if (.risk|type) == "string" then .risk else .classification end),
    scalar(.surface),
    scalar(.size) ] | @tsv' .feature/intake.json)
```

then the three existing `case` blocks, unchanged. Same behaviour on every case
the new tests cover (absent → `null`; object → its compact JSON in the message;
legacy scalar `classification` honoured only when `.risk` is not a string), one
`jq` instead of six, ~45 lines down to ~20.

**Correctness of the current version is fine** — I checked the `set -uo pipefail`
(no `-e`) interaction: a malformed `intake.json` leaves `RISK_TYPE` empty, falls
to the `else`, leaves `LADDER_RISK` empty, and DISARMs via `case *`. Fails
closed, which is right. The only cosmetic wart is that the message then reads
`intake risk is  — expected one of normal|high` with an empty value.

---

## F4 (MINOR) — the two promised-tests suites: the branch's argument is *mostly* sound

You asked whether `gate-promised-tests.test.ts` and the repointed
`promised-tests title discovery` block in `gate-rows.test.ts` are redundant.

**The escape-behaviour tests are not redundant, and the split is correct.**
`gate-rows.test.ts` extracts the *literal line* from `verify-gate.sh` and runs
it — it pins the gate's wiring (which roots, which `--include`). The new suite
calls `promised_title_found` directly with explicit roots — it pins the matcher's
contract (four quoting spellings, literal-only search, no shell evaluation).
Different subjects, different mutants kill them. Keep both.

**One block is redundant and weaker than what it duplicates.**
`gate-promised-tests.test.ts:153-159`:

```ts
expect(source).toMatch(/promised_title_found\s+"\$TITLE"\s+src\s+worker\s+scripts\s+tests/);
```

This is a source-text assertion over the whole file, which is exactly the form
`gate-rows.test.ts:188-197` documents as inadequate — "A source-text assertion
… passes against a mutant that names the root in a comment and drops it from
the command — the same disarmed-mutant trap the launch tests above exist for."
And `gate-rows.test.ts` already covers the same property properly, by extraction
and execution. Drop the `toMatch`; keep the `toContain('gate-promised-tests.sh')`
line above it (that one pins the `source` directive, which nothing else does).

**On the new-file-vs-`gate-rows.sh` call: the seam is in the right place.**
`gate-rows.sh`'s header argues the sourceable-file pattern for the *bash has no
in-file test seam* reason, not for "put shared gate bash here". Its interface is
row identity — `row_slug`, `assert_unique_row_name`, `GATE_ROW_HASH_CMD`. Title
matching shares the mechanism and nothing of the concept. Two small cohesive
libraries beat one grab-bag named after neither. The new file's "NEVER `exit`
from this file" header is a faithful, load-bearing restatement of the same
constraint, and `verify-gate.sh:193-199` correctly adds the matching
`command -v promised_title_found` abort so a failed source cannot read as "every
title missing".

---

## F5 (MINOR) — the plan's Module design table makes a false claim about the code

`docs/superpowers/plans/fix-gate-tooling-batch-a-plan.md:23`

> `#1107 §2 | scripts/arm-check.sh | unchanged | This REMOVES implementation. The silent case-statement defaults go; the script validates and names the bad field. **Smaller body, honest interface.**`

"Honest interface" is true and is the point of the ticket. "REMOVES
implementation. Smaller body" is false: the axis block went from 6 lines to 47,
and the file is `+55/−6`. On a branch whose entire subject is *a check reporting
a state that is not the branch's state*, a design table reporting a shape the
code does not have is worth one line of correction before it is read back as
precedent.

(F3's remedy would make the row true, which is the better resolution.)

---

## F6 (MINOR) — the un-fusing is one cause short of complete

`.agents/skills/red-team/scripts/mutation-runner.mjs:693-716`, `:2148-2150`

`operatorRunRejectionReason` is a genuine improvement — the two call-site tests
at `red-team-mutation-runner.test.ts:2768-2779` went from "some rejection
happened" to "*this* rejection happened", which is a real strengthening, and the
helper is pure and directly testable. Two nits:

- `phaseValid` (line 2148) is computed and then folded into
  `candidateMetadataValid`, so an invalid `--phase` is reported as
  `'candidate metadata is invalid'`. The docblock says the fused message was
  "identical for all eight causes" and that naming the cause "turns that into a
  real assertion instead of a vacuous one" — for the phase input it still
  misreports. Either add `phaseValid` as its own field, or say in the docblock
  that phase is deliberately reported as candidate-metadata.
- `const candidateMetadata = …; operatorMetadata = candidateMetadata;` is a
  pure alias; `candidateMetadata` is used once, for `!!candidateMetadata`.
  Assign `operatorMetadata` directly and pass `candidateMetadataValid: !!operatorMetadata`.
  (I checked the downstream uses at 2180/2185/2278/2312 — the old expression
  could yield `false`/`undefined` and now yields `null`; every consumer is
  truthiness or `?? {}`, so the change is behaviour-preserving.)

---

## F7 (MINOR) — `|| true` drops the only call-site signal on the fault path

`scripts/feature-setup.sh:92`

```diff
-  node … carry "$PARENT_ROOT" --runtime "$RUNTIME" \
-    || echo "ladder: carry from $PARENT_ROOT failed — keeping the auto-initialized stub."
+  node … carry "$PARENT_ROOT" --runtime "$RUNTIME" || true
```

The reasoning in the new comment is right for the *refusal* path: `carry` now
prints `ladder: kept the intake stub — <reason>` itself and exits 0, so the old
`|| echo` would have been a second, less-informative voice. But on the *fault*
path (`fail()` → `console.error` + `exit 2`: unreadable parent ladder, bad
`--runtime`) the only output is progress.mjs's bare stderr line, with nothing
saying `feature-setup` carried on and armed with the stub. That is the one case
the removed line was actually for.

Cheap fix that keeps the new reasoning intact:

```bash
node … carry … || echo "ladder: carry faulted — arming with the intake stub."
```

`carry`'s own refusal exits 0, so this only fires on a genuine fault.

---

## What this branch got right (not padding — these are the things a weakened-check
## sweep specifically looks for, and they are clean)

- **No test deleted, renamed away, skipped, or made conditional.** Diff scan for
  removed `it(`/`describe(`/`expect(` lines returns four hits, all of which are
  *strengthenings*: `GREP_LINE` → `MATCHER_LINE` (same assertion, renamed
  subject) and two `expect(launch(…).status).toBe(1)` that gained `stderr`
  cause assertions. No `.skip`/`.only`/`.todo` added anywhere.
- **No assertion loosened.** The one new `toBeGreaterThanOrEqual(3)` is an
  explicit vacuity floor with a comment saying so, sitting alongside an exact
  `toEqual` between the two docs-only lanes.
- **Shell correctness in the sourced library is right.** `promised_title_found`
  never `exit`s; `grep … && return 0` is `set -e`-exempt as the non-final member
  of an `&&` list, and the trailing `return 1` is only ever reached in `&&`
  context at the call site. The inner `while … done < <(…)` gives `grep` its own
  stdin, so it cannot steal the outer loop's `jq` stream. `grep -F` plus quoted
  expansion makes the injection test at `gate-promised-tests.test.ts:162` a real
  contract, not decoration. `-q` also means a missing root (exit 2) cannot mask a
  match found elsewhere.
- **The four-spelling candidate set is correct and complete.** A JS string
  literal escapes only its *own* delimiter, so a title containing both `'` and
  `"` needs exactly the single-escaped-apostrophe candidate, not a cross
  product. Each candidate is emitted once. Normalisation only *adds* spellings,
  so a genuinely absent title still fails — the comment's claim holds.
- **`ci.yml` matches its comments.** The `test` job's replaced comment no longer
  asserts the thing that went stale; the `lint` step's name and comment describe
  what it does; `jobBlock` already strips `#` comments so the prose naming
  `ci-audit-wiring.test.ts` in both files cannot satisfy the lockstep check.
  `lint` has no `docs_only` condition, which the new test pins by name.
- **`carry`'s refusal semantics are modelled well.** Refusal is exit 0 with a
  reason; only a fault is non-zero. Both directions are tested, including the
  end-to-end `feature-setup.sh` path with a real `git worktree`. The
  `writeIntakeInThePast` helper and its comment are the right fix for mtime
  granularity — not a sleep, not a retry.
- **`arm-check.sh` fails closed** on every unreadable-authority path, including
  malformed JSON, and the "does not report an outcome it does not own" change is
  pinned by an explicit `not.toContain('no parent ladder carried')`.

---

## LOW-CONFIDENCE APPENDIX (not in the table)

- **`processCwd` is a per-match `spawnSync('lsof')`.** Bounded by watcher count,
  so cost is fine, but on a runner without `lsof` (common in slim containers)
  T5 is inert: every match fails closed and `cmdWatchers` reverts to
  machine-global while `mutation-runner.mjs:2061` still says "a process is
  watching or serving this worktree". Safe direction; the message is now
  optimistic on those machines. A one-line "cwd unknown" annotation on the
  printed match would close the gap.
- **`root` vs `lsof` path normalisation.** `git rev-parse --show-toplevel` is
  physical and `lsof` resolves symlinks, so they should agree; a
  `realpathSync(root)` at the seam would make that an invariant rather than an
  assumption. I could not construct a failing case on this machine.
- **`refuse()` does `console.log` then `process.exit(0)`** (`progress.mjs`).
  Node's stdout to a **pipe** is asynchronous on POSIX, so a very long message
  can truncate before exit. The messages are short and the existing `fail()` has
  the same shape, so this is consistent with the file; `process.exitCode = 0` +
  `break` would remove the hazard entirely.
- **`verifyGateDocSuitePaths` scans all of `verify-gate.sh`,** not just the
  docs-only branch. If any future non-comment line in that script names a
  `src/__tests__/…` path, the `toEqual` between the two lanes breaks spuriously.
  Scoping the read to the `DOCS_ONLY` `else` block would make the check say what
  it means.
- **The `lint` job now runs the three doc-reading suites on *every* PR,** where
  `pnpm test` runs them again. A few seconds, and no comment claims otherwise —
  noting it only because the branch is otherwise scrupulous about lanes.
- **`stringLiterals`' docblock says a comment quoting "a doc path in backticks
  … (this very docblock does, two paragraphs up)".** Two paragraphs up the
  docblock backticks `text`, an identifier, not a doc path. Under a charitable
  reading the parenthetical attaches to "quote in backticks" generally, so I am
  not staking a finding on it — but the sentence as written does not
  self-verify, and this branch holds comments to that standard.
- **`gate-promised-tests.test.ts:139` ("searches src, worker, scripts and tests,
  and no other root")** passes the roots in explicitly, so it demonstrates that
  `grep` searches the directories you hand it. Its real content is the
  `--include` filter and the fact that `promised_title_found` adds no roots of
  its own; the name overpromises slightly.

---

## Verdict

No structural regression, no file pushed past 1k lines, no spaghetti growth, no
architecture-boundary leak. The two new libraries are cohesive and the seam
placement is right. The branch is close to mergeable.

**Fix F1 before merge** — it is a latent false-GREEN in the exact lane this
branch added, and the fix deletes code rather than adding it. **Fix F2 before
merge** — two lines, and it restores a test seam the branch itself relies on.
F3–F7 are fine as follow-ups, except F5, which should be corrected wherever the
plan is next touched so the table is not read back as precedent.
