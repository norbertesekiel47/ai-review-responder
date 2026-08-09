# #706 live-DB helper scan — Standards & maintainability review, round 1

Branch: `fix-706-live-db-helper-scan` · Diff under review: `git diff main...HEAD`
Implementation commits: `96a85fc6`, `4eafae5d`, `2c7148dd`, `55593b3b` (plus three docs commits)
Method: `/thermo-nuclear-code-quality-review`, plus the repo-specific standards named in the brief.

---

## Verification performed

| Check | Result |
|---|---|
| `npx tsx scripts/ci/live-db-suites-audit.ts` | `live-db-suites-audit: passed` |
| `npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` | 42 passed |
| `git ls-files '*.test.ts' '*.test.tsx'` | 904 |
| `git ls-files '*.test.ts' '*.test.tsx' '*__tests__/*.ts' '*__tests__/*.tsx'` | 917 (the 904→917 claim is true) |
| Non-suite `.ts`/`.tsx` newly in scope | 13 (matches the branch's own table exactly) |
| Of those 13, importing `postgres` | 6 — `abort-injection`, `apply-migration-074`, `live-db-lock`, `outreach-fixture`, `schema-ready`, `live-db-tenant` |
| Of those 6, `import type` | **5** (`live-db-lock.ts` is the sole value import) |
| Of those 13, matched by `LIVE_DB_MARKERS` alone | **4** (`describe-with-db.ts`, `abort-injection.ts`, `live-db-lock.ts`, `live-db-tenant.ts`) |
| `*.test.ts` / `*.test.tsx` files referencing the `postgres` module | **0** |
| Stale `*_SUITES` / `auditLiveDbSuite` / `listTestFiles` symbols outside historical review + plan docs | none |
| New file added to the source tree | none (invariant "default is no new file" respected) |
| Back-compat shim for a renamed export | none (correct — zero external consumers) |

---

## The deep-module claim — tested, and it holds

The brief asks whether the change *deepens* the module or widens its interface. It deepens it.

Exported surface **before** (`main`): `LiveDbSuiteFinding`, `auditLiveDbSuite(file, text)`, `listTestFiles()`.
Exported surface **after**: `LiveDbFileFinding`, `auditLiveDbFile(file, text)`, `listAuditedFiles()`.

Same count (1 interface + 2 functions), same arity, same return shapes, same `rule` union (`'naming' | 'runtime-ddl' | 'unlocked-ddl'` — no fourth rule for the helper case, which was the tempting wrong move). Every new concept is private:

- `isSuite` — module-private function (`:369`), never exported.
- `HELPER_DB_MARKER` — module-private const (`:175`), never exported.
- `MIGRATION_SHAPE_FILES` / `DDL_PROBE_FILES` / `OWN_APPLY_LOCK` — private, as before.

Nothing on this branch is reachable only by testing *past* the interface. Every new test in the `#706` block drives `auditLiveDbFile` or `listAuditedFiles`; there is no `export const __testOnly` and no `expect(isSuite(...))`. The `listAuditedFiles()` dedupe assertion (`expect(new Set(files).size).toBe(files.length)`) is a property of the public function, correctly asserted there rather than by reaching into the pathspec array.

The branch also resisted two real temptations that would have been structural regressions:

1. **A second entry point** (`auditLiveDbHelper`). It would have duplicated the `NOT_LIVE_DB` gate, the source-file construction and the whole DDL/lock tail. One function with a private `suite` boolean is right.
2. **A `HELPER_GLOB = '__tests__/helpers/**'` unit.** The tests explicitly pin why that was rejected (`live-db-tenant.ts` sits directly under `__tests__/`, not under `helpers/`) — the chosen unit ("non-suite file under `__tests__/`") is the one that actually matches the tree.

Control flow added to `auditLiveDbFile` is three lines and no new nesting:

```ts
const suite = isSuite(file);
const reachesDb =
  LIVE_DB_MARKERS.some((marker) => text.includes(marker)) ||
  (!suite && HELPER_DB_MARKER.test(text));
if (!reachesDb) return [];
```

plus `if (suite && !file.endsWith(...))` on the existing naming branch. No spaghetti growth, no new special case bolted into an unrelated flow, no file-size problem (`live-db-suites-audit.ts` 456 → 488 lines). No `any`, no cast, no new optionality, no silent catch. I have **no structural finding at any severity**.

Everything below is comment/doc correctness — which, in a module whose prose is its spec and whose failure mode is silent, is the review surface that matters here.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | **Medium** | `.claude/reference/lab-notes.md:1874` (also `docs/currents.md:10`, `docs/progresstracking.md:2121`) | The stated reason `HELPER_DB_MARKER` is withheld from suites — "~740 parallel unit tests import `postgres` types to shape a mock" — is false: **zero** `*.test.ts`/`*.test.tsx` files in the tree reference the `postgres` module at all. |
| 2 | **Medium-Low** | `scripts/ci/__tests__/live-db-suites-audit.test.ts:347` | "Four of the six DB-reaching helpers import the module type-only" contradicts `scripts/ci/live-db-suites-audit.ts:165` ("five of the six") and the tree (five). The plan-literal number D1 corrected in the source survived in the test. |
| 3 | **Medium-Low** | `scripts/ci/live-db-suites-audit.ts:121-133` | The `OWN_APPLY_LOCK` JSDoc presents a live guarantee that is vacuous for the entry #706 added: `apply-migration-074.ts` *defines* `withMigration074ApplyLock`, so `text.includes(OWN_LOCK_MARKER)` can never be false and `unlocked-ddl` can never fire for that file. Not stated. |
| 4 | **Low** | `scripts/ci/live-db-suites-audit.ts:8` | The module header promises `HELPER_DB_MARKER`'s JSDoc explains "why that third route is offered to helpers only". Its JSDoc (`:155-175`) never answers that; the only place carrying the rationale is lab-notes — where it is finding #1. |
| 5 | **Low** | `scripts/ci/live-db-suites-audit.ts:358-359` | `isSuite`'s JSDoc asserts "A SUITE is a runner entry point — `vitest.config.ts` includes `**/__tests__/**/*.test.{ts,tsx}`", but `isSuite` tests the suffix only. `src/lib/shared/index.test.ts` is git-tracked, in the audited set, classified a suite, and matched by none of vitest's five include globs. |
| 6 | **Low** | `scripts/ci/live-db-suites-audit.ts:28-33` vs `:362-367` | The enforcement-unit argument is stated twice in near-identical wording 330 lines apart (a third time in the test at `:299-305`), and its insertion between the `R1 —` and `R2 —` bullets splits the rule enumeration and forward-references R2 before it is defined. |

---

### 1 — Medium. The rationale for the suite/helper asymmetry is checkably false, and it is triplicated

`.claude/reference/lab-notes.md:1874`:

> Deliberately not offered to suites: ~740 parallel unit tests import `postgres` types to shape a mock, and admitting them would fire R1 across the tree on files that reach no database.

Repeated at `docs/currents.md:10` ("it is deliberately not offered to suites, where ~740 parallel unit tests import `postgres` types to shape a mock") and at `docs/progresstracking.md:2121`.

Measured:

```
$ git ls-files '*.test.ts' '*.test.tsx' | xargs rg -l "['\"]postgres['\"]" | wc -l
0
```

Not "fewer than 740" — **zero**. No suite in the tree imports `postgres`, type-only or otherwise, nor `vi.mock('postgres')`. The `~740` figure is `vitest.config.ts`'s count of *files in the parallel project* (its own comment says "the other ~738 files stay fully parallel"), which has been re-used as if it were a count of `postgres` importers.

**Why this matters concretely.** The asymmetry is the single most consequential design decision on the branch: it is the reason a suite that reaches the DB through a route not in `LIVE_DB_MARKERS` stays invisible to R1. Someone who later wants to close that gap will read this paragraph, conclude that extending the marker costs an R1 avalanche across ~740 files, and decline. The true cost today is **zero findings** — extending `HELPER_DB_MARKER` to suites right now changes nothing, so the decision is a semantics call about what R1 means, not a noise-management necessity. The doc replaces a real (and defensible) argument with a fabricated one.

This is the identical defect class #694's review filed as its only Medium, and the one the branch's own deviations doc D1 is built around ("this module's stated review criterion is that no comment asserts something untrue"). D5 credits the branch for verifying the two "no occurrence today" claims in `hidesStatementStart` before shipping them — the discipline exists; this claim slipped it, and slipped it into three files at once.

**Fix:** replace with what is true and checkable in all three places, e.g. *"Deliberately not offered to suites: no suite in the tree imports `postgres` today, so it would change no finding, and R1 is a claim about a file vitest runs — admitting a mock-shaping type import as a live-DB signal would make the naming rule fire on files that reach no database."*

Note the maintenance cost this creates: one correction is three edits, in three files, none of which cross-reference the others.

---

### 2 — Medium-Low. Two comments on this branch state different counts for the same fact

`scripts/ci/live-db-suites-audit.ts:165-167`:

> Value and type-only imports both count: **five** of the six DB-reaching helpers use `import type` (the exception is `helpers/live-db-lock.ts`, which CONSTRUCTS a connection rather than being handed one)…

`scripts/ci/__tests__/live-db-suites-audit.test.ts:347`:

> // **Four** of the six DB-reaching helpers import the module type-only. A
> // value/type distinction here would re-open the hole immediately.

The tree says five (`abort-injection.ts:32`, `apply-migration-074.ts:7`, `outreach-fixture.ts:30`, `schema-ready.ts:18`, `live-db-tenant.ts:20` are `import type`; `live-db-lock.ts:21` is the value import). The deviations doc D1 records that the plan's literal "four" was verified false and corrected — but only in the source. The test file was outside both Task 3's and Task 4's declared file lists (D2 flags exactly this surface hole for the symbol rename), and the number rode along uncorrected.

The test's *behaviour* is correct — it pins the type-only route with `import type postgres from 'postgres'` — so this is a comment defect, not a coverage gap. But it is the one place a reader lands when asking "does `import type` really count?", and it now disagrees with the module it is testing.

---

### 3 — Medium-Low. `OWN_APPLY_LOCK`'s new entry makes its own lock check unfalsifiable, and the JSDoc does not say so

`scripts/ci/live-db-suites-audit.ts:121-129`:

> 074 predates the shared lock and serializes on its own dedicated apply lock (`withMigration074ApplyLock`) … Accepted as an alternative to `acquireLiveDbLock` for the 074 shape suite **and for the helper that DEFINES that lock** — which is also the answer to "a helper cannot hold a lock on its own behalf": this one does, and the check is on the file's OWN text. Inheriting a caller's lock would need an import graph, so an allowlisted file that does not name its lock marker is `unlocked-ddl`, never a pass.

The check is `text.includes('withMigration074ApplyLock')`. In `src/lib/shared/__tests__/helpers/apply-migration-074.ts` that string is the file's own `export async function withMigration074ApplyLock` at line 23. The predicate is therefore satisfied by the *declaration*, independent of whether the DDL at line 55 is inside the wrapper. For this one entry the `unlocked-ddl` rule cannot fire.

The branch's own test proves it — `scripts/ci/__tests__/live-db-suites-audit.test.ts:376-383` satisfies the lock check with a bare stub:

```ts
const findings = auditLiveDbFile(
  APPLY_074,
  HELPER_PG_IMPORT + 'export async function withMigration074ApplyLock() {}\n' + OPAQUE_UNSAFE,
);
expect(findings).toEqual([]);
```

**Concrete failure scenario.** Someone refactors `applyMigration074IfMissing` (`apply-migration-074.ts:43-57`) so the `db.unsafe(readMigration074Sql())` no longer runs inside `withMigration074ApplyLock` — an inverted early return, a hoisted probe, a "fast path when the index exists" that skips the wrapper. The DDL is then unserialized against parallel suites, which is precisely #573. `ci:live-db-suites` stays green, because the lock function is still *defined* in the file. The other `OWN_APPLY_LOCK` entry (the 074 shape suite) does not have this property — its marker is a genuine call site — so the guarantee genuinely differs between the two members of one set, and nothing says so.

This is not a demand to build an import graph. It is the module's own `BOUND:` convention: every mechanism states its blast radius, and *"for `apply-migration-074.ts` this check is satisfied by the definition, so it detects removal of the helper but not a caller that bypasses it"* is exactly the kind of statement `isUnsafeCall`, `blankSqlComments` and `listAuditedFiles` all make about themselves. As written, the paragraph reads as a live guarantee ("never a pass") that is empty for the entry the ticket added.

The `MIGRATION_SHAPE_FILES` JSDoc has a milder version of the same shape — "Every entry must hold a cross-process lock (enforced below)" is now true of five entries in the ordinary sense and of the sixth only in this degenerate one.

---

### 4 — Low. The header's cross-reference does not deliver

`scripts/ci/live-db-suites-audit.ts:6-8`:

> …or — being a HELPER, handed its handle rather than resolving one — merely types that handle with an import of `postgres` (`HELPER_DB_MARKER` below, **and why that third route is offered to helpers only**).

The header sends the reader to `HELPER_DB_MARKER`'s JSDoc for that answer. That JSDoc (`:155-175`) explains why *helpers need* a third route (they are handed their handle, so `LIVE_DB_MARKERS` cannot see them), why value and type imports both count, and its `BOUND:`. It never explains why *suites are excluded* from it — a different question, and the one the header promises.

The answer exists only in `lab-notes.md:1874` and its two copies, i.e. outside the module the header points at, and is itself wrong (finding #1). In a module where the comments are the spec, a pointer that lands on a paragraph not carrying the promised content is the same defect as a stale comment: the reader either concludes the asymmetry is unreasoned, or goes and reads the false version.

**Fix:** add one sentence to `HELPER_DB_MARKER`'s JSDoc — the corrected version from finding #1 — so the module is self-contained and lab-notes summarises it rather than owning it.

---

### 5 — Low. `isSuite`'s JSDoc claims a definition its own body does not implement

`scripts/ci/live-db-suites-audit.ts:357-371`:

```
 * A SUITE is a runner entry point — `vitest.config.ts` includes
 * `**\/__tests__\/**\/*.test.{ts,tsx}` …
 */
function isSuite(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx');
}
```

Two mismatches, one cosmetic and one falsified by the tree:

- `vitest.config.ts:22-35` has **five** include globs, not one, and two of them (`scripts/ci/**`, `tests/**`) are `.test.ts` only, no `.tsx`. The quoted single glob is a simplification.
- More importantly, every include glob requires `__tests__/` in the path; `isSuite` does not. `src/lib/shared/index.test.ts` is git-tracked, matched by `listAuditedFiles`' first pathspec, classified `suite === true`, and matched by **no** vitest include — it is never executed by anything.

Consequence if that file (or a future sibling) ever names a live-DB marker: the audit emits `naming` and tells the author to rename it to `*.integration.test.ts` so vitest serializes it — advice that would not help, because vitest does not run the file at all. The real hazard (a live-DB test that silently never executes) goes unreported.

The tightening is one predicate — `file.includes('__tests__/') && (…)` — but I would not insist on the behaviour change in this PR. What the module's own standard does require is that the JSDoc stop asserting an equivalence the tree already falsifies: either narrow the predicate, or say "suffix-only; one tracked file (`src/lib/shared/index.test.ts`) matches the suffix without matching any vitest include".

---

### 6 — Low. The enforcement-unit argument has three owners, and its placement breaks the R1/R2 list

Module header `:28-33`:

> The two rules do not share a unit … R1 asks which vitest project a file lands in, so it can only be asked of a suite. R2 and the lock check ask whether a statement takes ACCESS EXCLUSIVE on a shared relation, which is true of that statement wherever it was written…

`isSuite` JSDoc `:362-367`:

> The distinction is what makes R1 sound. Naming is a claim about which vitest project a file lands in, so it can only be asked of a file vitest runs … R2 and the lock check ask instead whether the file takes ACCESS EXCLUSIVE on a shared relation, which is true of the statement wherever it was written.

Test `:299-305` states it a third time. Three near-verbatim owners for one fact, in a module that is otherwise disciplined about single ownership (`hidesStatementStart` correctly *defers* to `listAuditedFiles`' BOUND rather than restating it: "`listAuditedFiles`' own BOUND says why"). The same house rule the docs are held to — one authoritative owner per fact — applies inside a file, and this is the same maintenance trap `lab-notes.md`'s own "An exact count written into a comment is a maintenance trap" entry describes: two copies drift, and 330 lines is far enough apart that an editor will update one.

**Suggested ownership:** `isSuite`'s JSDoc owns the argument (it sits on the mechanism); the header states the unit in one line — *"A SUITE is a file vitest runs; a HELPER is any other `.ts`/`.tsx` under `__tests__/`. R1 applies to suites only — see `isSuite`."*

Separately, the placement is a legibility regression. `main` read as a clean two-item enumeration:

```
// R1 — NAMING. …
//
// R2 — NO RUN-TIME DDL. …
```

The new paragraph is inserted *between* them (`:28-33`), so a reader scanning for `R2 —` first hits a paragraph that discusses "R2 and the lock check" before R2 has been defined. Moving it below the R2 block (or collapsing it per the ownership suggestion) restores the list.

---

## Glossary check — clean

The branch's terms (**suite**, **helper**, **fragment**, **R1/naming**, **R2/runtime-ddl**, **unlocked-ddl**) are used consistently in code, tests and all four docs. I found no near-synonym drift: no "test helper module", no "integration file", no "DDL guard". The rename `*_SUITES` → `*_FILES` is complete in live code, and `docs/currents.md:166` correctly updates the #694 file table with a parenthetical saying why. The remaining `MIGRATION_SHAPE_SUITES` / `auditLiveDbSuite` / `listTestFiles` hits are all in historical review reports and prior plan/deviation docs, which are dated records of what was true then — correctly left alone.

One deliberate near-collision worth noting as *correct*: `MIGRATION_SHAPE_FILES` is `_FILES` while `DDL_PROBE_FILES` holds only suites. The rename is still right — the two sets are peers in one mechanism and a split naming convention would imply a distinction that does not exist — and `docs/progresstracking.md:2126-2128` states the reason. No finding.

## Docs ownership check

CLAUDE.md (`:192`, one-line gotcha + "Full mechanics: lab-notes") and lab-notes (`:20` index line + `:1874` dated entry) are the established summary/detail pair; that is the file convention, not duplication. `docs/currents.md` states #706 in three places (lead paragraph `:10`, file table `:166`, the #694 section's closing paragraph `:180-193`) — also its existing convention (headline / inventory / narrative). D4's decision to close the bound *in place* inside #694's record rather than open a second `## Quick summary` section is right and consistent with the two existing "DISCHARGED at #679" markers.

The one genuine cross-owner duplication is finding #1: the `~740` sentence is a *fact* (not a summary/detail split) replicated verbatim in three files, and it is wrong in all three.

## Test structure check — coherent

The `describe('audits helpers as well as suites (#706)')` block sits alongside the existing `VIA_HELPERS` block at the same nesting level, carries its own REACH-style header comment matching the file's convention (`// REACH.`, `// FAIL CLOSED.`, `// PRAGMA.`, `// DDL-PROBE SUITES.`), and duplicates no setup: it reuses `LIVE_DB` and `OPAQUE_UNSAFE` from the outer scope and adds four constants (`HELPER_PG_IMPORT`, `HELPER_FRAGMENT_DDL`, `HELPER_PATH`, `APPLY_074`) at the same outer scope the file already uses for fixtures. Seven tests, each pinning a distinct behaviour; the fragment test correctly asserts *both* halves (helper red, splicing suite clean) rather than only the interesting one. The repo-wide sweep at the bottom was correctly retargeted to `listAuditedFiles` and renamed. No finding.

---

## Appendix — below the confidence bar (not findings)

- **Real paths with synthetic content.** The `#706` block asserts against real files (`worker/__tests__/helpers/mock-sql.ts:355-364`, `src/__tests__/helpers/describe-with-db.ts:346`) while supplying fabricated text, and the comments make claims about the real files ("mock-sql.ts mocks the `sql` tag with vitest and touches no database") that the test does not verify. `auditLiveDbFile` is pure, so this is harmless; but the block already has a fictional `HELPER_PATH` for exactly this, and mixing the two invites a reader to think the real file is under test. Low value to change.
- **Two mechanisms for one job.** `LIVE_DB_MARKERS` is a string list consumed by `text.includes`; `HELPER_DB_MARKER` is a `RegExp` consumed by `.test`. Defensible (the regex needs the quote alternation and the `\b`), but it means "how does this audit decide a file reaches the DB?" has two shapes of answer.
- **Regex breadth.** `/\bfrom ['"]postgres['"]/` matches the string anywhere — a comment, a `describe()` title, a string literal. Fails toward *more* scanning, so safe; not worth tightening.
- **Pathspec edge.** `*__tests__/*.ts` would also match a directory literally named e.g. `legacy__tests__/`. No such directory exists; noted only because the JSDoc describes the pathspec as "under `__tests__/`".
- **R2 census recount method.** The header's recount instruction (`:56-57`) still says "walk every git-tracked `*.test.ts`", which no longer matches `listAuditedFiles`' pathspecs. D3 argues persuasively that this is correct — the census is a claim about marker-passing *suites*, and widening it would change what the figure means — and I agree. Noted only because the two adjacent pathspec descriptions now differ, and a future reader may "fix" the one that is deliberately narrow.
- **`e2e/` bound wording.** `listAuditedFiles`' BOUND says the `e2e/` Playwright lane is "deliberately absent", which is accurate for `e2e/*.spec.ts`; note that the *second* pathspec does now reach `e2e/**/__tests__/**/*.ts` helpers, which the paragraph does not mention (it mentions only that `e2e/**/__tests__/**/*.test.ts` was always matched by the first). Not wrong, just incomplete; no occurrence today.
- **Cost of the widened sweep.** The in-`pnpm test` repo-wide assertion now reads 917 files instead of 904 (~0.7s previously). Negligible.

---

## Verdict

**No structural finding.** The change is the right shape: interface preserved at the same size and arity, all new behaviour private behind it, one added boolean instead of a second entry point or a fourth rule, no new file, no shim, no `any`, no file-size problem, and the two most likely wrong turns (a `__tests__/helpers/**` unit, a separate helper audit function) were considered and correctly rejected with the reasoning pinned in tests.

Every finding is in the prose layer, which in this module is the spec. Finding **#1** is the one I would gate on: the branch's own deviations record makes "no comment asserts something untrue" the module's stated review criterion, and the load-bearing rationale for its central design decision is false in three files. **#2** and **#3** are the next two — #3 because it is a real, if narrow, hole in the guarantee the ticket's headline change relies on, and it is exactly the kind of thing this module documents everywhere else.

---

## Round 1 triage (orchestrator)

Every finding **ACCEPT**. Applied on this branch in the round-1 fix commit.
Fix numbering (FIX 1–9) is shared with `review-spec-correctness.md`.

| # | Verdict | Disposition |
|---|---|---|
| 1 | **ACCEPT — with a correction to this review's stated basis** | FIX 3 — `~740` replaced in all three docs with the verified **186 of the 904 suites match the marker; 112 of those are neither already visible through `LIVE_DB_MARKERS` nor named `*.integration.test.ts`**. **The basis quoted here is wrong**: "zero `*.test.ts`/`*.test.tsx` files reference the `postgres` module" is false — 184 do under the old marker, 186 under the widened one, so the `rg -l` measurement at `:88` did not measure what it claimed. The finding survives the correction intact (the number as written was false, and triplicated), and so does the fix direction: the rationale is now stated as what R1 *means* — a mock-shaping type import is not evidence a suite reaches a database — with a true volume figure behind it rather than a fabricated one. The "true cost today is zero findings" claim in the finding body does not hold. |
| 2 | **ACCEPT** | FIX 2 — the test comment now reads "Five of the six", naming `live-db-lock.ts` as the value-import exception. |
| 3 | **ACCEPT** | FIX 5 — a `BOUND:` paragraph added to `OWN_APPLY_LOCK`, stating plainly that the own-text check is satisfied by the *declaration* for `apply-migration-074.ts`, that `unlocked-ddl` can therefore never fire for that file, that it detects deleting the helper but not a refactor moving the DDL outside the wrapper, and that the guarantee differs between the two members of the set. Behaviour deliberately unchanged — proving the DDL sits inside the wrapper needs call-graph analysis. |
| 4 | **ACCEPT** | FIX 8 — `HELPER_DB_MARKER`'s JSDoc now answers the question the module header sends the reader there for ("why offered to helpers only"), carrying the corrected FIX-3 rationale and figures. lab-notes stays the mechanics owner; the module is now self-contained on this one point. |
| 5 | **ACCEPT — JSDoc corrected, predicate unchanged** | FIX 6 — `isSuite`'s JSDoc now says what the predicate does (a filename **suffix** test, not a vitest-include check), names the one divergence (`src/lib/shared/index.test.ts` is git-tracked, in the audited set, classified a suite, matched by no vitest include), says why the suffix test is kept, and states the bound. The predicate is untouched: that file has been in the audited set since #573 and narrowing to `__tests__/` would shrink the scan. |
| 6 | **ACCEPT** | FIX 9 — one authoritative owner: `isSuite`'s JSDoc keeps the full enforcement-unit argument (it sits on the mechanism); the module header now carries a four-line pointer instead of a second copy, **moved below both the `R1 —` and `R2 —` bullets** so the rule enumeration is contiguous again and R2 is no longer forward-referenced before it is defined. The test file's version (`~:299-305`) is deliberately left alone — a test-side explanation of the rule it exercises is legitimate. |

### Out of scope for this round (recorded, not applied)

The module header's R1 bullet still reads "the fully parallel project alongside **~740** other files" — the same stale figure as spec finding 3, one paragraph up from FIX 9's edit. It is unchanged from `main`, outside this diff, and was raised only in the spec axis' below-the-bar appendix (A6), so it was not in the accepted set. It is a false checkable number in this module and should be folded into the next touch of this file.
