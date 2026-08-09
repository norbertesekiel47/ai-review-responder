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

---

## Round 2 verification

Scope: verification-only. Diff re-reviewed: `git diff ab54a187..HEAD` (`c827429f`, `7fe7bd87`).
No new fronts opened against unchanged code; unrelated observations are in the appendix, untriaged.

### Verification performed

| Check | Result |
|---|---|
| `npx tsx scripts/ci/live-db-suites-audit.ts` | `live-db-suites-audit: passed` |
| `npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` | 43 passed (was 42 — one new test for the inline spelling) |
| Suites matching the WIDENED `HELPER_DB_MARKER` | **186** of 904 (184 under the old `from 'postgres'`-only form) — the branch's figure is correct |
| Of those 186, neither visible via `LIVE_DB_MARKERS` nor `*.integration.test.ts` | **112** — correct |
| Audited set / suites / helpers | 917 / 904 / 13 — unchanged, correct |
| Tracked `*.test.{ts,tsx}` matched by NO `vitest.config.ts` include | **1** — `src/lib/shared/index.test.ts`. `isSuite`'s "the two disagree on exactly one tracked file today" is exact |
| `vitest` parallel-project file count today | **821** (integration project 82). The removed `~740` was stale by ~80 — the R1 bullet's arithmetic is right |
| Helpers importing `postgres` / of those `import type` | 6 / **5** (`live-db-lock.ts` the value import) — "Five of the six" is correct |
| `apply-migration-074.ts` own-lock geometry | declaration at `:23`, `db.unsafe(readMigration074Sql())` at `:55` inside `withMigration074ApplyLock(db, …)` opened at `:44` — the new BOUND describes the file accurately |
| Executable change in the diff | one line: `HELPER_DB_MARKER` regex widened. Everything else is comments/docs |
| Exported surface | still `LiveDbFileFinding` + `auditLiveDbFile(file, text)` + `listAuditedFiles()`; `isSuite` (`:414`) and `HELPER_DB_MARKER` (`:207`) still private. Deep-module claim holds unchanged |
| Glossary (**suite**, **helper**, **fragment**, **R1/naming**, **R2/runtime-ddl**, **unlocked-ddl**) | no drift introduced. One new term, **SPELLING** (the `from 'postgres'` clause vs the inline `import('postgres')` type), used consistently in module, test and lab-notes |

### Per-finding verdicts

| # | Verdict | Evidence |
|---|---|---|
| 1 | **VERIFIED** | `~740` gone from all three docs; replaced by 186/112 at `.claude/reference/lab-notes.md:1874`, `docs/currents.md:10`, `docs/progresstracking.md:2124`. Both figures re-measured against the tree and correct. The rationale is now the *semantics* argument ("R1 is a claim about which vitest project a file lands in; a mock-shaping type import is not evidence a suite reaches a database") with the volume figure behind it, which is the correct ordering. |
| 2 | **VERIFIED** | `scripts/ci/__tests__/live-db-suites-audit.test.ts:347-349` now reads "Five of the six … (the exception, live-db-lock.ts, CONSTRUCTS a connection)", matching `live-db-suites-audit.ts:179-181` and the tree. |
| 3 | **VERIFIED** | `scripts/ci/live-db-suites-audit.ts:132-142` adds the BOUND: names the declaration at `:23` as what satisfies the own-text check, states `unlocked-ddl` can never fire for that file, names the exact refactor it fails to catch (DDL moved outside the wrapper), and says the guarantee differs between the two members of the set. Behaviour deliberately unchanged. Accurate against the file. |
| 4 | **VERIFIED** | `scripts/ci/live-db-suites-audit.ts:189-198` now answers the question the header at `:8` sends the reader there for. The module is self-contained on this point. |
| 5 | **VERIFIED** | `scripts/ci/live-db-suites-audit.ts:389-404` now states the predicate is a filename **suffix** test, not a vitest-include check, names `src/lib/shared/index.test.ts` as the sole divergence, says why the suffix test is kept, and states the bound (R1 would advise a rename for a serialization that never applies). The "exactly one tracked file" claim measured exact. |
| 6 | **VERIFIED** | Header `:64-67` is now a four-line pointer sitting **below** both the `R1 —` and `R2 —` bullets; the enumeration is contiguous and R2 is no longer forward-referenced. `isSuite`'s JSDoc `:406-412` carries the full argument. Nothing load-bearing was dropped in the dedupe — the two clauses the header shed ("R1 asks which vitest project a file lands in"; "true of that statement wherever it was written — including in a helper whose fragment a suite splices in as raw SQL") both survive verbatim in the surviving owner, which additionally gained the "a helper renamed to `*.integration.test.ts` would be executed as an empty suite" clause that previously lived only in lab-notes. |

### Defects introduced by the fixes (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| R2-1 | **Medium-Low** | `scripts/ci/live-db-suites-audit.ts:64-65` | The header pointer paragraph FIX 9 rewrote still opens "A SUITE is a file vitest runs (`*.test.{ts,tsx}`)" — the exact equivalence FIX 6 removed from `isSuite`'s JSDoc 325 lines below, which now reads "That is a suffix test, **not** a check that vitest would run the file" (`:390-392`). |
| R2-2 | **Medium-Low** | `scripts/ci/live-db-suites-audit.ts:200-202` | The rewritten `HELPER_DB_MARKER` BOUND keeps "a helper that types its handle as `unknown` and casts … is invisible" while the same commit widened the regex to match exactly that form, and the same commit's new test asserts it is matched. |
| R2-3 | **Low** | `scripts/ci/live-db-suites-audit.ts:27-30` | `7fe7bd87` delegates the parallel-project count to `vitest.config.ts` in the same sentence that says the removed copy had gone stale by ~80 — but `vitest.config.ts:9` carries that same stale figure (`~738`; measured 821). The pointer lands on the number it just disowned. |
| R2-4 | **Low** | `.claude/reference/lab-notes.md:1874` vs `scripts/ci/live-db-suites-audit.ts:193-198` | FIX 8 gave the module the census figure without demoting lab-notes to a pointer, so 186/112 now has **four** durable homes instead of three — module, lab-notes, `docs/currents.md:10`, `docs/progresstracking.md:2124` — the module and lab-notes near-verbatim, parenthetical included. |

---

#### R2-1 — the header re-asserts the definition `isSuite` was corrected to deny

`scripts/ci/live-db-suites-audit.ts:64-67`:

```
// The two rules do not share a unit, and #706 made that explicit. A SUITE is a
// file vitest runs (`*.test.{ts,tsx}`); a HELPER is any other `.ts`/`.tsx` under
// `__tests__/`. R1 applies to suites only; R2 and the lock check apply to every
// live-DB file, helpers included. `isSuite`'s JSDoc owns the argument for why.
```

`scripts/ci/live-db-suites-audit.ts:389-404` (FIX 6):

> A SUITE, to this audit, is a file whose NAME ends `.test.ts`/`.test.tsx`. That is a suffix test, **not a check that vitest would run the file** … The two disagree on exactly one tracked file today — `src/lib/shared/index.test.ts` …

The wording at `:64-65` is carried over from `main` unchanged, but its status changed under this fix: FIX 9 *designated* `isSuite` the single owner of this argument and reduced the header to a pointer at it, and FIX 6 made that owner explicitly contradict the pointer's own opening sentence. Before this round both places asserted the same (wrong) thing; after it, the module states two incompatible definitions of its central term, and the one a reader meets first — in the header, in the paragraph that defines the enforcement unit — is the falsified one. Measured: `src/lib/shared/index.test.ts` is the one tracked `*.test.ts` that no `vitest.config.ts` include matches, so it is a SUITE to `isSuite`, is not a file vitest runs, and is not under `__tests__/` either — under the header's definitions it is neither a suite nor a helper.

**Concrete failure scenario.** A maintainer adding a rule that depends on the unit (say, "R1 should also check the file is in the `integration` project") reads `:64-65`, takes `isSuite` to already mean "vitest runs it", and builds on a premise the predicate does not supply. The narrower, likelier one is the finding-5 hazard restated: someone reading only the header will not know that R1's rename advice is inert for a file vitest never executes.

**Fix:** one word each way — "A SUITE is a file NAMED `*.test.{ts,tsx}` (a suffix test — see `isSuite` for the one file where that diverges from what vitest runs)".

---

#### R2-2 — the BOUND lists an escape the same commit closed, and its own test proves it closed

`scripts/ci/live-db-suites-audit.ts:200-205`:

> BOUND: a helper that types its handle as `unknown` and casts, or takes it through a generic parameter, is invisible. The inline import-type form is NOT one of those escapes — it is matched. … make **the two remaining shapes** a deliberate act rather than an accident …

`scripts/ci/__tests__/live-db-suites-audit.test.ts:364-370`, added by the same commit:

```ts
it('counts an inline import("postgres") type annotation as a helper reaching the database', () => {
  const source =
    "const db = handle as unknown as import('postgres').Sql;\n" + OPAQUE_UNSAFE;
  expect(source).not.toContain("from 'postgres'");
  const findings = auditLiveDbFile(HELPER_PATH, source);
  expect(findings.map((finding) => finding.rule)).toEqual(['runtime-ddl']);
});
```

The fixture *is* "types its handle as `unknown` and casts", and the assertion is that it is caught. The two live sites of the inline spelling in the tree are also casts of exactly this shape — `src/lib/shared/__tests__/pool-wait.test.ts:6` (`… as unknown as import('postgres').Sql`) and `src/lib/escalations/__tests__/raise.test.ts:40` (`… as never as import('postgres').TransactionSql`) — so in this codebase the `as unknown as` cast and the inline import-type form are the *same* shape, not two. The paragraph's next sentence ("The inline import-type form is NOT one of those escapes") therefore contradicts the sentence before it rather than qualifying it, and "the two remaining shapes" is a miscount: only the generic-parameter form, and a cast whose target names no `postgres` type at all, are genuinely invisible.

This is the finding-1 defect class re-entering through the fix: a checkable claim about the module's blast radius, falsified by the module's own test file. It matters more here than a stale count, because a BOUND is the thing a future author reads when deciding whether a hazard is already closed — R2-2 would have them re-open a ticket for a case the widened regex handles, or skip review of a helper they believe the audit cannot see.

**Fix:** "a helper that takes its handle through a generic parameter, or casts it to a type that names no `postgres` symbol, is invisible. Casting through `unknown` is NOT an escape when the cast target is `postgres.Sql` or the inline `import('postgres').Sql` — both spellings are matched."

---

#### R2-3 — the count was handed to an owner carrying the same stale figure

`scripts/ci/live-db-suites-audit.ts:26-30`:

> … runs in the fully parallel project alongside every other non-integration file, unsynchronized against every other live-DB writer. (The count is deliberately not restated here: it is owned by `vitest.config.ts`, and the copy that used to sit in this sentence had gone stale by ~80 files …)

The arithmetic is right — measured today the `parallel` project holds **821** files (903 vitest-matched, minus the 82 the `integration` glob claims), so the removed "~740 other files" was ~80 light. But `vitest.config.ts:9`, the owner this sentence names, reads *"the other ~738 files stay fully parallel"* — the same figure, equally stale. The sentence disowns a number and then points at it.

This is not a request to edit `vitest.config.ts` (outside this branch's edit surface, as the round-1 triage recorded). It is that the delegation, as phrased, is a claim about where the true number lives, and it is not true today. Either name the recount instead of the owner — the module already does this twice, for the template census (`:50-54`) and for the marker census (`:197-198`) — or say the owner's copy is a point-in-time census too.

---

#### R2-4 — the census figure gained a fourth home rather than a single owner

Round 1's finding #1 closed on the maintenance cost: *"one correction is three edits, in three files, none of which cross-reference the others."* After the fixes it is four:

- `scripts/ci/live-db-suites-audit.ts:193-198` — "186 of the 904 suites match this marker today, and 112 of those are neither already visible through `LIVE_DB_MARKERS` nor named `*.integration.test.ts`. … (A census, not a constant; recount with the marker against `listAuditedFiles()`.)"
- `.claude/reference/lab-notes.md:1874` — "186 of the 904 suites match the marker today, 112 of them neither already visible through `LIVE_DB_MARKERS` nor named `*.integration.test.ts` … (A census, not a constant; recount the marker against `listAuditedFiles()`.)"
- `docs/currents.md:10` and `docs/progresstracking.md:2124` — the same two figures again.

FIX 8 was correct to put the rationale in the module (finding 4 required it). What did not happen is the other half: lab-notes still states the figures rather than deferring, and the two copies are near-verbatim down to the recount parenthetical. CLAUDE.md's convention — and the module's own discipline, where `hidesStatementStart` defers to `listAuditedFiles`' BOUND instead of restating it — is one authoritative owner per fact, summary/detail elsewhere. The doc/narrative pair (`currents`, `progresstracking`) is defensible as dated record; the module/lab-notes pair is not, because both are live reference and both will be read as current.

The figures drift on every added or moved test file, and the recount instruction is only in two of the four places. `.claude/CLAUDE.md:192` is clean — it carries the one-line gotcha with no figures and defers to lab-notes, which is the shape the other three should take relative to the module.

**Fix:** lab-notes keeps the mechanics and the *reason*, and replaces the two numbers with "the module's `HELPER_DB_MARKER` JSDoc carries the current census and the recount method".

---

### Appendix — below the confidence bar, untriaged

- **"the six DB-reaching helpers"** (`live-db-suites-audit.ts:179`, mirrored into the test at `:347`). There are **seven** helpers the audit treats as reaching the DB; `src/__tests__/helpers/describe-with-db.ts` is the seventh and imports no `postgres` (it matches `LIVE_DB_MARKERS`). "The six" means "the six that reach it through *this* marker", which the surrounding paragraph makes clear. Pre-existing wording, unchanged by the fixes.
- **`raise.test.ts` uses `.TransactionSql`, not `.Sql`.** The JSDoc at `:183-187` names the idiom as "the inline `import('postgres').Sql` type" and then cites `raise.test.ts` (`:40`, `TransactionSql`) as an instance. The regex keys on `import('postgres')` so behaviour is unaffected.
- **A third and fourth inline-form site exist.** `src/__tests__/eslint-boundaries.test.ts:60` (a string-literal fixture, `"await import('postgres');"`) and this audit's own test file also match the widened marker. Both are suites, and the audit's own test is in `NOT_LIVE_DB`, so the JSDoc's "so nothing is invisible" conclusion still holds; the enumeration at `:185-187` is illustrative rather than exhaustive but does not claim otherwise.
- **`docs/currents.md:180`** ("not just the suites vitest runs") carries the same suite⇄vitest-runs conflation as R2-1. Unchanged by these commits; noted only so a correction sweep catches it.
- **The R1 bullet's parenthetical is now four lines of meta-commentary inside a rule statement** (`:27-30`), explaining the history of a figure that is no longer there and forward-referencing `listAuditedFiles`' BOUND. Correct, but it is the longest thing in the bullet.
- Appendix items from round 1 (real paths with synthetic content; two mechanisms for one job; regex breadth; pathspec edge; R2 census recount method; `e2e/` bound wording) are unchanged by these commits and remain as filed.

### Round 2 verdict

All six round-1 findings are **fixed, and fixed well** — each correction was re-measured against the tree rather than taken on its word, and every figure the fixes introduced (186, 112, 904/917, five-of-six, `~80`, `:23`) checks out. The dedupe lost nothing and improved the header's reading order. The executable surface is one widened regex; the deep-module claim is unchanged.

Four defects came out of the fixes, all in the prose layer, none behavioural. **R2-2** is the one worth gating on: it is a false blast-radius claim contradicted by the same commit's own test, in the paragraph whose entire job is to be true about what the audit cannot see. **R2-1** is next — the module now defines its central term two incompatible ways, and the pointer FIX 9 created opens with the wrong one.

---

## Round 2 triage (orchestrator)

All five round-2 findings **ACCEPT**. Applied on this branch in the round-2 fix
commit. Every fix is prose: the comment-stripped `scripts/ci/live-db-suites-audit.ts`
is byte-identical to the round-1 HEAD (`7fe7bd87`), so no rule behaviour moved.
Fix lettering (FIX A–E) is shared between `review-spec-correctness.md` and
`review-standards.md`.

| # | Axis | Verdict | Disposition |
|---|---|---|---|
| 6 | spec | **ACCEPT** | FIX A — the `OWN_APPLY_LOCK` BOUND is rewritten around what the check literally is (`text.includes(OWN_LOCK_MARKER)`): it reads the identifier's PRESENCE, so it cannot distinguish DDL inside `withMigration074ApplyLock` from DDL hoisted out of it, and it does still report `unlocked-ddl` when the identifier goes away. "Can never fire" is gone. The preceding sentence's "never a pass" absolute went with it — it is true only of an allowlisted file that reaches the lock check, i.e. one that executes DDL — so it now reads "an allowlisted file that reaches the lock check without naming its lock marker is reported `unlocked-ddl`". |
| R2-1 | standards | **ACCEPT** | FIX B — the header pointer no longer opens with the equivalence `isSuite`'s JSDoc was corrected to deny. It now says a SUITE is a file NAMED `*.test.ts`/`*.test.tsx` — a suffix test, not the same question as whether vitest runs the file — and points at `isSuite` for the argument and for the one tracked file where the two disagree. The header points; it no longer re-defines. |
| R2-2 | standards | **ACCEPT** | FIX C — the `HELPER_DB_MARKER` BOUND now names only what the shipped regex genuinely misses, determined by probing it rather than by taking the finding's word: a bare generic parameter (`db: T`), a `Sql` imported from a module that re-exports it, and a cast to a locally declared structural type all return `[]`; `as unknown as import('postgres').Sql` and `as unknown as postgres.Sql` both return `['runtime-ddl']`. So casting through `unknown` is not itself an escape, and the "two remaining shapes" count is gone. |
| R2-3 | standards | **ACCEPT** | FIX D — the R1 bullet no longer names `vitest.config.ts` as the count's owner (that file carries the same stale figure and is outside this branch's edit surface). It now says there is deliberately no count here because it moves with every test file added or renamed, and gives the recount instead. |
| R2-4 | standards | **ACCEPT** | FIX E — one owner for the census: the module's `HELPER_DB_MARKER` JSDoc, because that is where the mechanism's blast radius is argued and it is the file that changes when the mechanism changes. `.claude/reference/lab-notes.md`, `docs/currents.md:10` and `docs/progresstracking.md` keep the *rationale* (admitting the marker to suites would fire R1 broadly on files that reach no database) and carry no figures. |

### `OWN_APPLY_LOCK` — the two axes are two halves of one truth

The standards axis (round-1 finding 3, re-verified at its round-2 verdict 3) and
the spec axis (round-2 finding 6) are not in conflict; each holds one half, and
the round-1 BOUND stated only the first half, as an absolute.

- **Standards is right about what the check cannot see.** `text.includes('withMigration074ApplyLock')` reads presence, not position. `apply-migration-074.ts` DECLARES that function at its own `:23`, so hoisting `db.unsafe(readMigration074Sql())` out of the wrapper leaves the identifier in the file and the audit green.
- **Spec is right that the rule still fires.** Delete or rename the helper and the identifier is gone with it, which is exactly the mutation three shipped docs cite as proof of enforcement.

Both halves re-run against the real file text before the rewrite was written:

```
baseline (real file text)                  → []
mutation: rename the lock helper           → ["unlocked-ddl"]
  hoist keeps the declaration?              true
  hoist keeps the DDL call?                 true
  hoist still wraps the DDL?                false
mutation: DDL hoisted out of the wrapper   → []
```

The round-1 BOUND's error was not picking the wrong half — it was writing
"`unlocked-ddl` can never fire for that file" where the code supports only "the
check cannot distinguish in-wrapper from out-of-wrapper DDL". That is the same
defect class both rounds have now found in this module: a sweeping claim about a
mechanism that is a narrow text-presence check.

### Verification (round 2)

```
<scratchpad: 074 real-text rename mutation>                       → ['unlocked-ddl']
<scratchpad: 074 real-text DDL-hoist mutation>                    → []
<scratchpad: HELPER_DB_MARKER shape probe>                        → generic param / re-exported alias / local type invisible; both `unknown` casts matched
<scratchpad: comment-stripped HEAD vs working tree>               → IDENTICAL
REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts → 43/43
pnpm ci:live-db-suites                                            → live-db-suites-audit: passed
pnpm typecheck && pnpm lint                                       → clean
```

No test title was added, removed or reworded this round; the 9 titles (8 promised
+ the inline-form test) are unchanged.

## Round 3 verification

Scope: the five prose corrections in `9c826b3f` (`git diff 7fe7bd87..9c826b3f`),
plus the round's own zero-behaviour-change constraint. Nothing else was reviewed.
Every verdict below is re-derived from the shipped code — the round-2 fix notes
were treated as claims to test, not as evidence.

| Item | Verdict | Basis |
|---|---|---|
| **A** — `OWN_APPLY_LOCK` BOUND | **VERIFIED** | Both halves hold against the real file, mutated in memory. Presence-not-position: DDL hoisted OUTSIDE `withMigration074ApplyLock` with the declaration left in place → `[]`. Identifier gone: rename → `['unlocked-ddl']`; wrapper deleted → `['unlocked-ddl']`. The BOUND's literal claim matches `:476` (`text.includes(OWN_LOCK_MARKER)`); the declaration really is at `apply-migration-074.ts:23`; the 074 shape suite's marker really is a call site (`migration-074-…:304`), not a re-export. |
| **A** — neighbouring "never a pass" sentence | **VERIFIED** | Now scoped to a file that *reaches* the lock check. Probed the excluded case: an `OWN_APPLY_LOCK` file with no DDL and no lock marker → `[]` (`:458` returns before the lock check). As rewritten the sentence is unconditionally true — reaching `:475` without the file's own marker always pushes `unlocked-ddl`. |
| **B** — header pointer vs `isSuite` JSDoc | **VERIFIED** | Header `:65-70` ("a file NAMED `*.test.ts`/`*.test.tsx` — a suffix test, which is not the same question as whether vitest runs the file") and `isSuite`'s JSDoc `:400-424` now state the same predicate; the header defers rather than re-defining. `src/lib/shared/index.test.ts` is classifiable under the header's wording — it is a suite by name. The JSDoc's "the two disagree on exactly one tracked file today" is exact: replaying `vitest.config.ts`' five include globs over `listAuditedFiles()` gives 904 suites, 903 include-matched, and `index.test.ts` as the single divergence (0 in the other direction). Both supporting claims check out: every include glob does require `__tests__/`, and `INTEGRATION_GLOB` does narrow within it. |
| **C** — `HELPER_DB_MARKER` BOUND | **VERIFIED** | Probed against the shipped regex, not against the prose. All three shapes the BOUND names are genuinely invisible — bare generic parameter (`db: T`), `Sql` imported from a re-exporting module, cast to a locally declared structural type → `[]` each. All three it says are matched fire `runtime-ddl`: `as unknown as import('postgres').Sql`, `as never as import('postgres').TransactionSql`, `as unknown as postgres.Sql`. Also swept nine further spellings for an omitted escape: value import, double quotes, multi-line named import, `export type … from 'postgres'`, aliased import and `await import('postgres')` are all matched. |
| **D** — R1 bullet | **VERIFIED** | No count and no authority claim survive in `:27-31`. The `vitest.config.ts` ownership assertion was indeed false: that file still says "The 45 `*.integration.test.ts` suites" and "the other ~738 files", where the tree today has 82 and 821. The replacement recount recipe is executable and correct (903 include-matched − 82 integration = 821). |
| **E** — census single home | **VERIFIED** | `186` / `904` / `112` appear in exactly one durable place, `scripts/ci/live-db-suites-audit.ts:200-202` (occurrences under `docs/reviews/fix-706-…/` are this ticket's own review record). All figures recomputed exact against the tree: 917 audited files, 904 suites, 186 marker-matching suites, 112 of those neither `LIVE_DB_MARKERS`-visible nor `*.integration.test.ts`, 6 DB-reaching helpers. `.claude/reference/lab-notes.md`, `docs/currents.md` and `docs/progresstracking.md` keep the rationale, carry no figures, and lab-notes points at the module as the owner. |

**Findings: none.** Nothing in the five corrections would mislead a maintainer
reading the code.

### Zero-behaviour-change proof — independently reproduced

```
transpileModule(removeComments) 7fe7bd87 vs 9c826b3f      → byte-identical
raw diff lines that are not comment lines                 → 0
files changed under scripts/ in the range                 → live-db-suites-audit.ts only
scripts/ci/__tests__/live-db-suites-audit.test.ts         → untouched in the range (∴ no test title moved)
REPWORTH_DISABLE_LIVE_DB_SUITES=1 vitest run …audit.test.ts → 43/43 passed
pnpm ci:live-db-suites                                    → live-db-suites-audit: passed
npx eslint scripts/ci/live-db-suites-audit.ts             → clean
git status                                                → clean
```

The two checks are independent: the transpile erases type annotations as well as
comments, so it alone could mask a types-only edit; the raw-diff line scan closes
that, and finds every changed line to be `//` or ` * ` prefixed.

### Appendix — outside this round's five items, untriaged

- **`904 → 917` is quadruplicated** while `186`/`112` were consolidated to one home: `.claude/reference/lab-notes.md:1874`, `docs/currents.md:10`, `docs/currents.md:181`, `docs/progresstracking.md:2116`. Both figures are correct against the tree today, so nothing is wrong — but it is the same drift surface E was closing, one figure over.
- **`docs/currents.md:10` and `:181` still say "not just the suites vitest runs (904 → 917 files)"** — the exact equivalence FIX B removed from the module header, and off by one against it (`index.test.ts` is in the 904 and vitest runs it not at all).
- **"which is the form both in-tree sites use"** (`HELPER_DB_MARKER` BOUND) over-specifies: `pool-wait.test.ts:6` is `as unknown as import('postgres').Sql` exactly, but `raise.test.ts:40` is `as never as import('postgres').TransactionSql`. Both use the inline import-type *spelling* and both are matched, so the mechanism claim is unaffected; only the exemplar is narrower than "both".
- **Two invisible shapes the BOUND does not name**, found by sweep: a bare `require('postgres')` and a subpath specifier (`from 'postgres/src/index.js'`) both return `[]`, yet each *does* name the module — so the BOUND's leading generalisation ("typed WITHOUT the module being named in this file") is narrower than its own enumeration implies. Practically inert: the tree's actual `require` idiom is `require('node:fs') as typeof import('node:fs')` (3 sites), and the `postgres` analogue of that form is matched; an untyped `require('postgres')` yields an implicit `any`, which the no-`any` invariant already forbids.
