# Spec & Correctness review — fix/gate-tooling-batch-a

Axis: SPEC & CORRECTNESS (review-only). Fork point: `git merge-base HEAD origin/main`
(origin/main is an ancestor; zero drift). Commits reviewed: f74e25f60, d03cfe78d,
b783cc27b, 57bd411f3, 6d30cd1e1, 5842cd366, b17a55d3e.

Evidence was produced by reading the diff and by running the suites and
reproductions recorded below at the branch HEAD. Every reproduction is
read-only against the repo (fixtures live in /tmp).

---

## FINDINGS

| severity | file:line | finding |
|---|---|---|
| BLOCKING | `.agents/skills/feature/scripts/progress.mjs:234,249` | The carry recency check compares the parent ladder's `updatedAt` against the **mtime of the worktree's `.feature/intake.json`**, which `scripts/feature-setup.sh:76` re-creates with `cp` moments before `carry` runs — so it is always newer than a ladder written during steps 0–1. Every legitimate carry is refused; the intake's promised path ("its timestamp is newer: the carry proceeds exactly as today") is unreachable in the real `/feature` flow. |
| MAJOR | `src/__tests__/ci-audit-wiring.test.ts:258,305-306` · `.github/workflows/ci.yml:249-252` | The derived doc-reading candidate set is limited to `src/__tests__/*.test.ts`. At least five suites outside that directory read a repo doc at run time, are skipped by the docs-only `test` skip, and are invisible to the new guard — so #1199's defect is still live. ci.yml's rewritten `test`-job comment asserts a safety property ("That is safe only because every …") the code does not deliver. |
| MINOR | `.agents/skills/red-team/scripts/mutation-runner.mjs:567` | The T5 narrowing's only production wiring point is untested. `validateOperatorAdmission` calls `findWorktreeWatchers(...)` with no `cwdOf` seam, and both new tests call the helper directly with an injected lookup. Reverting line 567 to `findWatchers(processes.stdout, selfAncestry())` passes the whole suite on any machine with no watcher process running. |
| MINOR | `scripts/gate-promised-tests.sh:72` · `scripts/ci/__tests__/gate-rows.test.ts:196-205` | Nothing on the branch pins the matcher's `--include='*.test.ts' --include='*.test.tsx'` filters, and `gate-rows.test.ts`'s line-extraction check — which previously ran the line carrying those flags — was narrowed in scope to "the roots handed to `promised_title_found`". A mutant dropping the includes (widening into non-test files → false GREEN, the dangerous direction) now survives both suites. |
| MINOR | `scripts/gate-promised-tests.sh:41-53` | `edge_cases[1]` ("a promised title containing a literal backslash") is neither handled nor tested. A source name spelled `it('a \\ b escape')` is not matched by the promised title `a \ b escape` (verified). No candidate spelling covers a backslash, and no test in `gate-promised-tests.test.ts` uses one. |

---

## 1. BLOCKING — the carry recency guard refuses every real carry

### The contract

- `user_visible_behavior[1]`: "feature-setup.sh carries the parent checkout's ladder
  only when its axes match the locked intake **and it is no older than that intake**".
- `edge_cases[6]`: "The parent ladder's axes match the intake and its timestamp is
  newer: **the carry proceeds exactly as today**."

### What the code does

`progress.mjs:229-251`:

```js
const intakePath = resolve(root, flags.intake ?? join(dir, 'intake.json'));
…
intakeMtimeMs = statSync(intakePath).mtimeMs;          // line 234
…
if (carriedUpdatedAtMs < intakeMtimeMs) {              // line 249
  refuse(`parent ladder (updated ${carried.updatedAt}) is older than the locked intake`);
}
```

`intakeMtimeMs` is the mtime of `<worktree>/.feature/intake.json`. That file is not
the locked intake — it is a **copy made at arming time** by `scripts/feature-setup.sh:76`:

```bash
if [ "$SRC" != "$ROOT/.feature/intake.json" ]; then cp "$SRC" .feature/intake.json; fi
```

`cp` without `-p` stamps the destination with the current time. The production
ordering, per `.agents/skills/feature/SKILL.md` §1–§2, is fixed:

1. steps 0–1 run **in the parent checkout**; step 1 ends with
   `progress.mjs step intake done --note "<revision> · signed off"`, which sets the
   parent ladder's `updatedAt`;
2. step 2 creates the worktree and runs `feature-setup.sh`, which `cp`s the intake
   (mtime = now) and then calls `carry`.

So `parent.updatedAt < intake.mtime` **always**, by construction. The axes check is
fine; the recency check is unconditionally fatal.

### Reproduction (end to end, real `feature-setup.sh`)

Fixture: parent checkout holding a `small/high/backend` ladder with
`steps.orient.status = done` and `updatedAt = now`; a child worktree armed from a
matching `small/high/backend` draft — i.e. the *happy path* the contract says must
carry.

```
--- feature-setup stdout ---
intake installed: docs/superpowers/plans/codex-child-intake.json (uncommitted) + .feature/intake.json
ladder: .feature/progress.json initialized from the intake
ARMED: edit-surface guard + stop gate live for …/e2e-carry-child-PvGlSg
ladder: kept the intake stub — parent ladder (updated 2026-09-19T21:46:20.183Z) is older than the locked intake
…
parent updatedAt : 2026-09-19T21:46:20.183Z
intake mtime     : 2026-09-19T21:46:20.241Z   <- 58 ms later, written by `cp`
resulting ladder steps: {"orient":{…,"note":""},"intake":{…,"note":"ladder auto-initialized by arm-check"},…}
```

The parent's real orient/intake history (including the sign-off note) is discarded
and replaced with the arm-check stub. In production the gap is minutes or hours,
not 58 ms, so this is deterministic, not a race.

A narrower reproduction against `progress.mjs carry` alone gives the same result:

```
parent 2026-09-19T21:43:55.529Z  intakeMtime 2026-09-19T21:44:05.529Z
ladder: kept the intake stub — parent ladder (updated …) is older than the locked intake
exit=0
```

The manual re-carry documented at `SKILL.md:185` is equally dead: SKILL.md states
"Every later progress, review-log, and live-view command runs from the worktree",
so the parent ladder is never updated after arming either.

### Why the suite did not catch it

`scripts/ci/__tests__/feature-workflow-runtime.test.ts:25-31` introduces
`writeIntakeInThePast`, which backdates the intake file's mtime **60 seconds into
the past** before writing the parent ladder. That inverts production's ordering.
The deviations doc records the reason as mtime-resolution determinism, which is a
real concern — but the chosen fix is what makes the happy path pass in the test and
fail in production. There is no test that runs `feature-setup.sh` end to end with
a *matching* parent ladder and asserts a carry; the one test that does run
`feature-setup.sh` (`names the reason when feature-setup keeps the intake stub…`)
uses mismatched axes, so it is satisfied by the axes branch and never reaches the
recency branch.

### Refusal-path walk (the rest is correct)

| condition | behavior | exit code | ladder left on disk |
|---|---|---|---|
| source unreadable / unparseable | `fail(...)` — a fault | non-zero | stub (arm-check already wrote it) |
| intake absent or unparseable | `refuse` — "intake unreadable at …" | 0 | stub |
| axes disagree | `refuse` with both triples | 0 | stub |
| `updatedAt` missing / unparseable | `refuse` — "no updatedAt to compare" | 0 | stub |
| `updatedAt` strictly older | `refuse` | 0 | stub |
| `updatedAt` equal to intake mtime | proceeds (`<` is strict) — matches "no older" | 0 | carried |

Refusal is exit 0, fault is non-zero, as the contract requires. On the
`feature-setup.sh` path a refusal can never leave the run without a ladder:
`arm-check.sh` runs first and either writes the stub or DISARMs. Standalone
`progress.mjs carry` in a tree with no ladder and no intake refuses and leaves
nothing — that is exactly the case the T2 deviation documents, and it is only
reachable outside the arming flow.

### Suggested direction (not a fix, for the owner to choose)

Compare against a timestamp that means *when the intake was locked*, not *when it
was copied*: e.g. `statSync` the **source** draft passed to `feature-setup.sh`
(pass it through as `--intake`), or `cp -p`, or record a `lockedAt` field inside
the intake JSON and compare against that. Whichever is chosen, the regression pin
has to be an end-to-end `feature-setup.sh` test whose intake mtime is **not**
backdated.

---

## 2. MAJOR — the derived doc-reading guard only derives from `src/__tests__`

### The contract

- `goal`: "a docs-only change **still runs every suite that reads a doc**".
- `user_visible_behavior[6]`: "A new **src test** that reads a doc at run time fails
  the wiring guard until it is added to both docs-only lanes."
- `edge_cases[9]`: "A future fourth doc-reading suite: the wiring guard fails until
  it appears in ci.yml's lint job and in verify-gate.sh."

### What the code does

`ci-audit-wiring.test.ts:258` fixes the scan root to `src/__tests__`, and line 305
uses a **non-recursive** `readdirSync` filtered to `.test.ts` (line 306) — so
`.test.tsx` files and every nested `__tests__` directory are outside the candidate
set by construction. The guard's own docblock argues correctly that "a hardcoded
list of three suites would repeat the exact failure this ticket is about" — but the
directory is hardcoded instead, which has the same failure mode one level up.

### Live instances still in the gap

`docs_only` is defined at `.github/workflows/ci.yml:110` as *every* changed path
matching `^(docs/|\.claude/)` or `\.md$`. Suites that read a real repo doc at run
time, run only in the `test` job, and are not candidates for the new guard:

| suite | doc it reads | a docs-only PR that breaks it |
|---|---|---|
| `src/lib/legal/__tests__/content.test.ts:32` | `docs/legal/<slug>` (asserts byte-equality with the shipped legal blocks) | editing `docs/legal/terms.md` alone |
| `src/lib/notifications/channels/__tests__/whatsapp-body.test.ts:50,90` | `docs/runbooks/whatsapp-templates.md` | editing that runbook alone |
| `scripts/ci/__tests__/feature-lane-parity.test.ts:16-17,32` | `.claude/commands/feature.md`, `.agents/skills/feature/SKILL.md`, `.claude/commands/feature-small.md` | editing `.claude/commands/feature.md` + `SKILL.md` — both docs-only paths |
| `scripts/ci/__tests__/rls-audit.test.ts:45` | `docs/security/rls-inventory.md` | editing the RLS inventory alone |
| `scripts/ci/__tests__/feature-workflow-runtime.test.ts:186` | `.agents/skills/feature/references/execution-lanes.md` | editing that reference alone |

The first two are literally "a src test that reads a doc at run time" and satisfy
neither column of the new two-column idiom — they are simply invisible to it.

### The overstating comment

`.github/workflows/ci.yml:249-252`:

```yaml
    # Docs-only PRs skip this whole job. That is safe only because every
    # src/__tests__ suite that reads a doc at run time (…) runs in `lint`
    # instead (see its "Run doc-reading test suites" step above), and `lint`
    # never skips.
```

The scoped clause ("every `src/__tests__` suite") is accurate. The *conclusion*
("That is safe") is not: the skip is unsafe for the five suites above. This is the
same class of stale-comment defect #1199 exists to remove, restated one directory
narrower — and the diff replaced a comment that was merely stale with one that is
affirmatively wrong about safety.

### What the guard does get right

- The candidate floor (`toBeGreaterThanOrEqual(3)`) prevents the vacuous-zero
  collapse, which is a genuinely good guard against the failure shape.
- `verifyGateDocSuitePaths` is asserted **equal** to `lintDocSuitePaths`, not merely
  non-empty — the two docs-only lanes cannot drift.
- `withoutHashComments` + `jobBlock` stop prose from satisfying a run check.
- `NOT_DOC_READING` entries are checked for staleness against the candidate set.
- `counts the design-system doc pin as a doc-reading suite` fails **by name**, not
  by count, which is the correct strength for a regression that drops one suite.

### The self-exclusion (`ci-audit-wiring.test.ts:313`)

The stated reason is sound as far as it goes: `stringLiterals` is a regex-based
scanner blind to JS *regex literals*, and this file's own `stringLiterals` /
`mentionsDocPath` sources contain `'`, `"` and `` ` `` inside character classes.
I probed whether that hazard generalizes into a false negative for other files:

- the `\n` exclusion in the single- and double-quoted alternatives (documented in
  the docblock) does defuse the common `/['"]/` case — the alternative simply fails
  to match and the scan resumes;
- the backtick alternative *does* allow newlines, so `` /`[^`]+`/ `` swallows a
  span — but in the constructed probe the scan still recovered and flagged the
  later `'docs/currents.md'` literal;
- scanning every current `src/__tests__` file, no file that actually reads a doc is
  missed today (`design-scope-purity` and `design-token-single-source` are flagged
  and correctly excused; `self-serve-signup-flag-scope.test.tsx` mentions a docs
  path only in a header comment and reads no doc).

So the exclusion creates no live hole and I am not filing it as a finding; it is in
the low-confidence appendix as a latent hazard.

---

## 3. Contract walk — field by field

### `user_visible_behavior`

| # | claim | delivered? | evidence |
|---|---|---|---|
| 0 | promised-tests row finds a title whose source spelling escapes a quote | YES | `scripts/gate-promised-tests.sh:41-53` (candidates), `:65-75` (matcher); `verify-gate.sh:521` swaps the inline grep for `promised_title_found "$TITLE" src worker scripts tests`. Verified: all 21 promised titles of this run resolve through the helper, including `keeps the gate honest about a title that carries an author's apostrophe`, whose source spelling is `author\'s`. |
| 1 | feature-setup carries only on matching axes AND no-older; otherwise keeps the stub and prints the reason | **PARTIAL — see finding 1**. The refusal half works and prints the reason (`progress.mjs:222-251`, `feature-setup.sh:88-96`). The carry half is unreachable. |
| 2 | arm-check's ladder message no longer claims a carry outcome | YES | `arm-check.sh:96` — `"ladder: .feature/progress.json initialized from the intake"`; the `(no parent ladder carried)` suffix is gone, and the test asserts its absence. |
| 3 | arm-check refuses, naming the field, on an absent/out-of-vocabulary size, risk or surface | YES | `arm-check.sh:47-93` — three per-axis blocks, each printing `DISARMED: intake <field> is <value> — expected one of …` and `exit 1`. |
| 4 | ci.yml's lint job runs the doc-reading guard suites | YES (for the three named) | `ci.yml:172-180`. |
| 5 | verify-gate docs-only mode runs the same suites | YES | `verify-gate.sh:381-390` — `launch doc-shape pnpm vitest run …` in the `else` of the docs-only branch; set-equality with the lint job is asserted. |
| 6 | a new **src** test that reads a doc fails the wiring guard | **NO — see finding 2**. Only a new `src/__tests__/*.test.ts` does. |

### `invariants`

| invariant | preserved? |
|---|---|
| The row can only fail on real absence; normalization never makes an absent title match | YES. `promised_title_spellings` only *adds* longer, strictly more specific candidates (each inserts backslashes); no candidate is shorter or more permissive than the verbatim title, and the searched files are never rewritten. Verified: `a title nobody wrote` returns 1 against a populated fixture. |
| A gate row name = one status slot, one log file, one coverage dir (#696) | YES. `doc-shape` is a new, unique row name; `launch` is unchanged and the `assert_unique_row_name` guard still runs (`verify-gate.sh:188-194`). |
| lefthook mirrors every `ci:*` audit the lint job runs (#590) | YES. The new lint step is a `pnpm vitest run`, not a `ci:*` script, so the mirror check is unaffected; `lefthook.yml:52-53` runs `pnpm vitest run src/__tests__` wholesale, which does cover the three doc-reading suites. The arch-review-log claim "lefthook.yml needed no change: its `guards` command already ran them" is **true at HEAD** — re-checked. |
| docs-only short-circuit stays intact (test/build/promised-tests/reclassify/diff-coverage still skipped) | YES. The `doc-shape` row is added inside the existing `else`; nothing was un-skipped. Banner updated at `verify-gate.sh:667-669`. |
| `.feature/intake.json` stays authoritative; the ladder never overrides it | YES — strengthened. `carry` now defers to the intake, and `arm-check` reads it as sole authority. |
| the intake stays gitignored at `.feature/` (#512) | YES. No change to `.gitignore` or to the install logic. |

### `edge_cases`

| edge case | handled | tested |
|---|---|---|
| title with both an apostrophe and a quotation mark | YES — verified: `says 'hi' and "bye" now` matches a source spelled `it('says \'hi\' and "bye" now')` | **NO** — the suite has one apostrophe case and one quotation-mark case, never a title carrying both. Low-confidence appendix. |
| title containing a literal backslash | **NO** — see finding 5 | NO |
| title genuinely absent | YES | YES — `reports a title no test file spells…` |
| steps 0/1 run on `main`; the carry decision must not compare branches | YES — no branch comparison anywhere in `carry` | indirectly (the fixture parent is on a different branch) |
| no parent ladder at all: stub stands, nothing printed about a carry | YES — `feature-setup.sh:94` guards on `[ -f "$PARENT_ROOT/.feature/progress.json" ]` | partially — asserted via `reports the stub without claiming a carry outcome it does not decide` |
| parent ladder predates the intake → refuse | YES (over-broadly — finding 1) | YES — `refuses to carry a parent ladder older than the locked intake` |
| axes match and timestamp newer → carry proceeds | **NO in production** — finding 1 | YES, but only under an artificially backdated intake mtime |
| intake whose risk is an object → fail loudly naming the field | YES — `arm-check.sh:47-56`: `.risk \| type` must be `string`; the legacy `.classification` branch also requires `type == "string"`, so `{"classification": {"risk": "high"}}` falls through to the `jq -c` branch and DISARMs | YES — third entry of the `badIntakes` table |
| docs-only change touching no guard-read doc: suites run anyway and pass | YES | implicitly |
| a future fourth doc-reading suite fails the guard until wired | YES **within `src/__tests__`** only — finding 2 | YES |

### `tests_to_add` — all 21 titles

All 21 resolve through the new matcher against `src worker scripts tests`
(run at HEAD). Each was also read in the diff to confirm it is a real `it(...)`
title, not incidental text, and that its body asserts the plan's intent:

Strong (assert the named behavior, would fail on a plausible mutant): the five
matcher cases (fixtures written with real escaped source spellings, and the
`searches …, and no other root` case proves its own fixture valid by re-running
with `e2e` added); `refuses to arm when the intake risk is absent or not a
declared value` (three distinct bad intakes, asserts status 1, `DISARMED`,
the field name, **and** that no `progress.json` was created); the three carry
cases (assert stdout reason text *and* the resulting on-disk ladder); the five
`#1199` cases (set-equality between lanes, by-name pin, floor against vacuity).

Weaker than the title suggests:
- `admits an operator continuation while an unrelated checkout runs a dev server`
  and `refuses an operator continuation while a watcher serves this worktree` —
  both assert on `findWorktreeWatchers` with an injected `cwdOf`, not on an
  operator continuation. See finding 3.
- `the verify gate reads its promised-tests verdict from the shared matcher` —
  a source-text assertion (`toContain('gate-promised-tests.sh')` plus a regex on
  the call line). Acceptable for a wiring pin, and `gate-rows.test.ts` still
  *runs* the extracted line, so the pair is adequate.

No promised title exists-but-asserts-nothing.

### `allowed_edit_surface`

Every changed source file is inside the surface (amended twice, both recorded):

```
.agents/skills/feature/scripts/progress.mjs        ✓
.agents/skills/red-team/scripts/mutation-runner.mjs ✓ (amendment 2)
.claude/reference/arch-review-log.md               ✓
.github/workflows/ci.yml                           ✓
scripts/arm-check.sh                               ✓
scripts/feature-setup.sh                           ✓
scripts/gate-promised-tests.sh                     ✓
scripts/verify-gate.sh                             ✓
scripts/ci/__tests__/feature-workflow-runtime.test.ts ✓
scripts/ci/__tests__/gate-promised-tests.test.ts   ✓
scripts/ci/__tests__/gate-rows.test.ts             ✓ (amendment 1)
scripts/ci/__tests__/red-team-mutation-runner.test.ts ✓ (amendment 2)
src/__tests__/ci-audit-wiring.test.ts              ✓
```

The remaining changed paths are `/feature` run artifacts, not code:
`docs/superpowers/plans/fix-gate-tooling-batch-a-{intake.json,plan.md,deviations.md,handoff.md}`
and `docs/reviews/fix-gate-tooling-batch-a/blast-radius.md`. `lefthook.yml` is in
the surface and was correctly left untouched. **No file outside the surface was
changed.**

### `non_goals`

| non-goal | respected? |
|---|---|
| changing what the gate checks beyond the three defects | Respected for #1108/#1107/#1199. T5 adds a fourth change to gate tooling (`mutation-runner.mjs`), which is a deliberate, owner-approved mid-run scope addition recorded in the deviations doc, not creep. |
| adding a retry or rerun to a flaky check | Respected — no retry/rerun anywhere in the diff. |
| reworking the red-team sidecar / review wave / gate loop budget | Respected. T5 touches admission scoping and one message, not the sidecar, the wave, or `operatorLaunchAllowed`'s budget. |
| extending any `ci:*` audit script | Respected — `scripts/ci/*.ts` production scripts untouched; only `scripts/ci/__tests__/` changed. |
| backfilling the 40 escaped-apostrophe titles | Respected — no test renames in the diff. |
| un-skipping ci.yml's `test` job on docs-only PRs | Respected — `if: needs.changes.outputs.docs_only != 'true'` is unchanged at `ci.yml:258`. |

---

## 4. Correctness probes

### (a) `scripts/gate-promised-tests.sh` — false RED / false GREEN

**Can it miss a real test (false RED)?** Yes, in two residual shapes, neither a
regression:

- *Literal backslash* — finding 5. `it('a \\ b escape')` vs promised `a \ b escape`:
  all four candidates miss. Verified against the real helper.
- *Title whose source name is not a single contiguous literal* — a concatenation,
  a template with `${…}`, or a name split over two lines. Pre-existing; the old
  inline grep missed these identically.

Everything the ticket targets works. Verified against real fixtures:
apostrophe-in-single-quoted ✓, quote-in-double-quoted ✓, both together ✓,
verbatim ✓, genuine absence correctly reports missing ✓.

**Can it match something that is not the promised test (false GREEN)?** Only
through shapes that predate this branch and are unchanged by it:

- a promised title that is a **substring** of a longer real title, or that appears
  in a comment inside a `*.test.ts` file — `grep -F` is a substring match with no
  anchoring to `it(`/`test(`. Unchanged from the pre-#1108 line.
- a title containing a newline: `jq -r` + `while read -r` splits it into two
  independently-searched fragments. Unchanged.

The **escaping direction is safe**: each candidate is the verbatim title with
backslashes *inserted*, so every candidate is strictly longer and strictly more
specific than the verbatim one. There is no candidate that could match a
superset of what the verbatim spelling matches. The invariant "normalization
never makes an absent title match" holds.

**Regex/glob metacharacters**: harmless — `-F` makes every candidate a fixed
string. The security contract (`$(touch pwned)`, backticks) is quoted through to
`grep` as a single argument, never `eval`'d, and is pinned by its own test.

**Non-`exit` discipline**: the file returns, never exits, as its header requires —
verified by reading; `verify-gate.sh:194-199` adds a `gate_abort` if the library
failed to load, which correctly prevents exit-127 being read as "every title
missing" (#1108's own failure direction).

### (b) the `--include` filters

Confirmed unpinned. `gate-promised-tests.test.ts`'s `writeFixtureTest` only ever
writes `fixture.test.ts`; `gate-rows.test.ts`'s `corpusFixture` does the same. No
fixture anywhere writes a non-test file containing a promised title, so removing
both `--include` flags changes no assertion in either suite. This is finding 4.
The deviations doc logs it as a pre-existing residual and explicitly hands the
decision to this review — my recommendation is a single fixture that writes the
title into `src/notes.md` (or `src/helper.ts`) and asserts `false`, which is ~5
lines and closes the only false-GREEN direction in the matcher.

Note also the honest scope narrowing in `gate-rows.test.ts`: the comment at
:195-196 changed from "the flags, the `--include` filters, the roots — is kept
verbatim" to "the roots handed to `promised_title_found`". That is accurate about
the new code (the includes moved into the helper, out of the extracted line), and
it is disclosed rather than hidden — but it means the branch removed the *last*
place those flags appeared inside a check's blast radius.

### (c) `progress.mjs carry` — covered in finding 1, table of refusal paths above.

### (d) `scripts/arm-check.sh` — per-axis validation

Vocabularies accepted exactly: `normal|high` (:53), `ui|backend|mixed` (:69),
`trivial|small|standard|epic` (:85) — matching `RISKS`/`SURFACES`/`SIZES` in
`progress.mjs:45-47`. Everything else DISARMs naming the field.

Legacy `.classification`: a **scalar** is accepted only when `.risk | type` is
`"null"` (covers both an absent key and an explicit JSON null) *and*
`.classification | type` is `"string"`. An object classification falls to the
`jq -c` branch, producing `{"risk":"high"}` as the value, which matches no case
arm → DISARM. Correct, and pinned by the third `badIntakes` entry.

**Regression check on existing branches.** I surveyed every committed intake in
`docs/superpowers/plans/*intake*.json`:

- no intake has a `risk`/`surface` outside its vocabulary;
- ~59 intakes lack `size` entirely and would now DISARM where they previously
  defaulted to `standard` — but the newest of these is `2026-08-30`; **every intake
  from 2026-09 onward carries all three axes**. One legacy intake carries
  `classification: "small"`, which would now DISARM.

So the hardening is exactly the promised behavior (`user_visible_behavior[3]`) and
carries no practical regression for any current branch. The only exposure is a
`/feature-resume` on a pre-September branch, noted in the appendix.

### (e) `mutation-runner.mjs` `processServes` — fail-closed audit

Every path through `processCwd` (`:1658-1663`) returns `null` on failure, and
`processServes` (`:1680-1685`) maps `null` → `true` (= "treat as serving" = keep
blocking):

| condition | `processCwd` | `processServes` | direction |
|---|---|---|---|
| `lsof` not installed | `result.error` set → `null` | `true` | fail closed ✓ |
| `lsof` non-zero exit | `status !== 0` → `null` | `true` | fail closed ✓ |
| empty stdout | `[''].find(startsWith('n'))` → `undefined` → `null` | `true` | fail closed ✓ |
| no `n`-prefixed line | same → `null` | `true` | fail closed ✓ |
| process already exited | `lsof` non-zero → `null` | `true` | fail closed ✓ |

**Boundary:** `boundary = root.endsWith('/') ? root : root + '/'`, and the test is
`cwd === root || cwd.startsWith(boundary)`. `/foo/barbaz` does **not** match root
`/foo/bar` (`'/foo/barbaz'.startsWith('/foo/bar/')` is false). Correct.

**Does the narrowing ever let a serving watcher through (false GREEN)?** The
classification is by **process cwd**, which is a proxy for "serves this worktree",
not the thing itself. A watcher that serves the worktree from a different cwd —
`pnpm -C <worktree> dev`, `next dev --dir <worktree>`, a `vitest --root` launched
from elsewhere, or a process that `chdir`'d after start — is now admitted where it
previously blocked. That is a genuine narrowing beyond "unrelated checkout", but
it is a defensible one: the alternative (the pre-branch behavior) blocked on any
matching command line anywhere on the machine, which is what made the check
unusable. The PID→row mapping is sound: `findWatchers:1626` trims each row before
`split(/\s+/)[0]`, so `ps`'s right-padded PID column parses correctly — I checked
this specifically because an untrimmed row would yield `Number('') === 0` and
silently fail closed on every process.

Nested worktrees are handled conservatively in the safe direction: a watcher whose
cwd is `<parent>/.claude/worktrees/x` still blocks a check rooted at `<parent>`.

The narrowing is wired into two call sites — `validateOperatorAdmission:567` and
`cmdWatchers:2051-2057` — and `cmdWatchers`'s message ("…is serving this
worktree") is now true where it previously was not. Finding 3 is about the first
site having no test.

### (f) `operatorRunRejectionReason` — extraction equivalence

Original fused condition (pre-branch):

```js
if (!operatorMetadata || !operatorLaunchAllowed(journal.runs, timeout)
  || !resultPath || existsSync(resultPath) || existsSync(`${resultPath}.supervisor.json`)
  || journal.supervisors.some((e) => e.active === true || e.resultPath === resultPath)
  || JSON.stringify(argv) !== JSON.stringify(expectedArgv) || !dotenvSafe
  || parsed['no-release'] === true)
```

where `operatorMetadata = proof && ['baseline','mutant'].includes(parsed.phase) && operatorRunMetadata(…)`.

New form splits that first conjunct into `admissionValid = !!proof` and
`candidateMetadataValid = !!candidateMetadata`, where
`candidateMetadata = proof && phaseValid ? operatorRunMetadata(…) : null`. Since
`admissionValid` is a strict *precondition* of `candidateMetadataValid`, the
disjunction `!admissionValid || !candidateMetadataValid` is logically identical to
the original `!operatorMetadata`. The remaining six map one-to-one:

- `resultPathValid = resultPath !== null && !existsSync(resultPath) && !existsSync(`${resultPath}.supervisor.json`)` — De Morgan of the original three disjuncts (`resolve()` never yields an empty string, so `!resultPath` and `resultPath === null` agree);
- `supervisorClash`, `argvMatches`, `launchAllowed`, `dotenvSafe`, `noRelease` — unchanged expressions.

**Nothing dropped, added or inverted.** `operatorRunMetadata` is still evaluated
only when `proof && phaseValid`, so no new side effect or throw is introduced on
the invalid path.

**Order** (`:705-714`): admission → candidate metadata → argv → result path →
supervisor clash → launch budget → dotenv → `--no-release`. Deterministic
(pure `if` chain over eight booleans) and sensible: broadest precondition first,
narrowing to the most specific/operator-chosen flag last. `resultPath === null`
is reported as a result-path failure before `supervisorClash` can compare against
it, which is the right precedence.

The extraction also *strengthened* two pre-existing assertions in
`red-team-mutation-runner.test.ts:2768-2778`: `expect(...).toBe(1)` became
`toBe(1)` **plus** a `stderr` cause assertion (`'test command'`, `'dotenv'`).
Those two had been passing vacuously. That is the opposite of a weakened check.

### (g) the derived doc-reading guard — covered in finding 2.

---

## 5. Weakened-checks sweep

Mechanical sweep of the full diff:

| pattern | result |
|---|---|
| test deleted | none — `git diff … -- '*.test.ts' \| grep -E "^-\s*(it\|test\|describe)"` returns nothing |
| test renamed | none — every `it(...)` title in `gate-rows.test.ts` is byte-identical across the diff |
| `.skip` / `.only` / `.todo` added | none |
| assertion loosened | none found. Two were **tightened** (`red-team-mutation-runner.test.ts:2768-2778`, cause-specific `stderr` assertions added to previously bare `toBe(1)` checks). `gate-rows.test.ts`'s `expect(GREP_LINE).toBeDefined()` → `expect(MATCHER_LINE).toBeDefined()` is a rename with an updated message, same strength. |
| `expect.anything()` / `toBeGreaterThan(0)` substituted for an exact value | none. `toBeGreaterThanOrEqual(3)` in the new guard is a **floor added where nothing existed**, with an explicit comment that it exists to prevent vacuity — not a relaxation of an exact count. |
| scope narrowed so a check now passes where it used to fail | **three**, all deliberate: (i) T5's watcher scan — narrowed correctly in the fail-closed direction, judged sound in (e); (ii) `gate-rows.test.ts`'s line extraction no longer covers the `--include` flags, which moved into the helper — finding 4; (iii) `arm-check` narrowed in the *strict* direction (fewer intakes arm), which is the intended hardening. |
| comment that overstates its code | **one** — `.github/workflows/ci.yml:249-252`, finding 2. Also `progress.mjs:188-197` and `feature-setup.sh:81-87` both describe a carry that cannot happen (finding 1), and `mutation-runner.mjs:1682` says `processServes` returns true "when the cwd could not be read at all", which is accurate. |

`pnpm ci:weakened-checks` passing is consistent with this: none of the three
narrowings match a textual weakening pattern, and finding 1 is a semantic defect
no diff-reader could catch.

Suite status at HEAD (run during this review):
`ci-audit-wiring.test.ts` + `gate-promised-tests.test.ts` + `gate-rows.test.ts` →
118 passed; `feature-workflow-runtime.test.ts` → 32 passed.

---

## 6. #1305

The branch carries no code for #1305 (verified already fixed by `c9b2a2f9a`,
"fix(ci): red-team-status tests need more than the 5s default timeout (#1310)",
which is an ancestor of `origin/main`). There is nothing on this branch to review
against; I did not independently re-verify the issue's closure.

---

## LOW-CONFIDENCE APPENDIX

Observations I would not stake 80% on, or that are latent rather than live:

1. **`stringLiterals` and regex literals in *other* files.** The self-exclusion at
   `ci-audit-wiring.test.ts:313` is justified by a hazard that is general, not
   specific to that file. The backtick alternative allows newlines, so a regex
   literal containing a backtick can swallow a multi-line span. I could not
   construct a case where a *currently existing* doc-reading suite escapes, and my
   probes recovered in every attempt — so this is latent. If it is ever tightened,
   the cheap fix is to skip a `/`-initiated token the same way comments are
   skipped, in the same alternation.

2. **`.test.tsx` excluded from the candidate scan** (`:306`). Today the only
   `.test.tsx` mentioning a doc (`self-serve-signup-flag-scope.test.tsx:17`) does so
   in a comment and reads nothing. A future doc-reading `.test.tsx` would escape.

3. **Edge case "both an apostrophe and a quotation mark" is untested.** It works
   (verified), but the suite has no case for it, so the alternation between the two
   escape candidates has no regression pin. Adding it is one `it(...)`.

4. **`processCwd`'s real implementation is untested.** Both T5 tests inject
   `cwdOf`, so an `lsof` argument typo would never be caught — though it would
   fail closed (over-blocking), which is the safe direction.

5. **`repoRoot()` vs `lsof` path normalization.** `git rev-parse --show-toplevel`
   and `lsof -Fn` should both report physical paths, so a symlinked checkout
   (`/tmp` → `/private/tmp` on macOS) should compare equal. I did not construct a
   case where they disagree; if one exists, it fails closed.

6. **lefthook does not run the doc-reading suites on a docs-only push.** Its
   `guards` step runs `pnpm vitest run src/__tests__` unconditionally, so it does
   cover them — but the affected-tests step (`vitest --changed`) would select
   nothing. Not promised by the intake; noting it only because the "both lanes"
   framing invites the question of a third lane.

7. **`/feature-resume` on a pre-September branch** whose intake predates the
   `size` field would now DISARM rather than default to `standard`. Intended per
   `user_visible_behavior[3]`; recovery is adding the field to the intake.

8. **Amendment 2 and the abort criterion.** The deviations doc records that a
   second surface amendment is a `/feature` step-5 ABORT criterion and that the
   owner directed folding T5 in anyway, with the reason recorded via
   `feature-state.sh incr-amendment --reason`. That is a process decision, made
   explicitly and with the tension raised beforehand; I am not re-litigating it,
   and the T5 surface is genuinely tight (two files, same defect class).

---

## VERDICT

Two findings block a clean merge on the spec axis:

- **finding 1 (BLOCKING)** — the carry recency guard is measured against the wrong
  timestamp and refuses every carry the contract says must succeed. Reproduced
  end to end. The fix is small; the regression pin (an end-to-end
  `feature-setup.sh` test with a *non*-backdated intake) matters more than the fix.
- **finding 2 (MAJOR)** — the docs-only goal is not met: five doc-reading suites
  outside `src/__tests__` still skip on a docs-only PR, two of them `src` tests,
  and the new `ci.yml` comment claims a safety property the code does not have.

Everything else on the branch is sound, and several parts are notably strong: the
matcher's candidate generation is provably non-widening, the `operatorRunRejectionReason`
extraction is exactly equivalence-preserving and turned two vacuous assertions
into real ones, `processServes` is fail-closed on every path, and the docs-only
lane set-equality assertion is the right strength. No test was deleted, renamed,
skipped or loosened.
