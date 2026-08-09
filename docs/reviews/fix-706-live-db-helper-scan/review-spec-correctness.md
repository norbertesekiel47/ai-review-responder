# #706 live-DB helper scan — spec & correctness review, round 1

Axis: spec fidelity + correctness. Read-only. Diff under review: `git diff main...HEAD`
(4 implementation commits `96a85fc6`, `4eafae5d`, `2c7148dd`, `55593b3b`).

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan`

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | **Medium** | `scripts/ci/__tests__/live-db-suites-audit.test.ts:347` | Comment asserts "**Four** of the six DB-reaching helpers import the module type-only." The tree says **five** of six, and the source JSDoc this comment mirrors (`live-db-suites-audit.ts:164-167`) was corrected to "five" **in this same PR** (deviations D1, row 2). A shipped internal contradiction, of exactly the false-comment class #694 filed as its only Medium finding. |
| 2 | Low | `docs/currents.md:10` · `docs/progresstracking.md:2121` · `.claude/reference/lab-notes.md` (#706 entry) | "deliberately not offered to suites, where **~740** parallel unit tests import `postgres` types to shape a mock" — false by ~6.7×. **184** suites contain any `postgres` import; **111** are non-integration; **110** of those are not already reachable via `LIVE_DB_MARKERS`. Replicated verbatim in three durable docs. |
| 3 | Low | `scripts/ci/live-db-suites-audit.ts:451` | New `listAuditedFiles` BOUND prose: "vitest's `integration` project against **~738** parallel siblings". Tree: 903 suites under `__tests__/`, 82 integration → **821** parallel. (Restates the pre-existing stale "~740" at `:25`, which is equally wrong now but is outside this diff.) |
| 4 | Low | `scripts/ci/live-db-suites-audit.ts:175` (BOUND at `:170-173`) | `HELPER_DB_MARKER = /\bfrom ['"]postgres['"]/` does **not** match the inline import-type form `import('postgres').Sql` / `import('postgres').TransactionSql` — a form this repo already uses twice (`src/lib/escalations/__tests__/raise.test.ts:40`, `src/lib/shared/__tests__/pool-wait.test.ts:6`). A future helper typed that way is invisible to R2: the #694 blindness mode. The BOUND paragraph enumerates only `unknown`+cast and generic parameters, so the module's stated blast radius is incomplete against its own convention. |
| 5 | Low | `docs/currents.md:166` | The `live-db-suites-audit.ts` row still asserts "**Same exported signature** — deepened, not widened" in a present-tense *"What it owns now"* table, and its parenthetical (edited in this PR) mentions only the constant renames. #706 renamed **all three** exports — `auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`, `LiveDbSuiteFinding`→`LiveDbFileFinding` — which `docs/progresstracking.md:2128` records and this row does not. |

---

## 1 — Spec fidelity against `.feature/intake.json`

### `user_visible_behavior` — 5/5 true

| Claim | Verdict | Evidence |
|---|---|---|
| audits **13 additional** git-tracked files; every `.ts`/`.tsx` under `__tests__/` not matching `*.test.{ts,tsx}` | **TRUE** | `git ls-files '*.test.ts' '*.test.tsx'` = **904**; with `'*__tests__/*.ts' '*__tests__/*.tsx'` = **917**. `comm -13` yields exactly 13, and the list matches the plan's table file-for-file. |
| non-suite `__tests__/` file importing `postgres` (value OR type-only) + executing DDL → `runtime-ddl` | **TRUE** | Mutation harness T2/T4 green at baseline, red under M1 (drop marker) and M4 (value-imports-only marker). |
| `naming` never reported for a non-suite file | **TRUE** | `auditLiveDbFile` gates the branch on `suite &&` (`:384`). T3 green; red under M2 (naming applied to helpers) and M7 (`isSuite` always true). |
| `apply-migration-074.ts` newly allowlisted **and** newly enforced; stripping the lock turns CI red | **TRUE — mutation-proved** | Harness case `M-074`: took the *real* file text, replaced `withMigration074ApplyLock` → `withSomeOtherThing`, got exactly `['unlocked-ddl']`. It enforces; it does not merely silence. |
| `pnpm ci:live-db-suites` still reports `passed` | **TRUE** | Ran it: `live-db-suites-audit: passed`. Repo-wide test T8 also green over all 917 files. |

### `invariants` — 7/7 hold

- **#694's four precision fixtures** (regex literal, `toContain`, TS comment, unexecuted constant) — all green at baseline in the harness (P1–P4) and in the real suite (42/42 pass).
- **Repo-wide zero offenders across the widened set** — verified twice (CLI + T8).
- **No new false positive; the other 12 non-suite files stay clean** — audit passes; only `apply-migration-074.ts` fires, and it is allowlisted+locked.
- **`live-db-lock.ts` and `describe-with-db.ts` newly in the scanned set, no `naming` finding** — both are in the 13; `isSuite` is false for both; T3 pins `describe-with-db.ts` explicitly. (The intake's "two files newly enter the scanned set" is an undercount — 4 of the 13 match `LIVE_DB_MARKERS`: `describe-with-db.ts`, `abort-injection.ts`, `live-db-lock.ts`, `live-db-tenant.ts`. Undercount, not a defect; the invariant it guards is unaffected. D1 already records this.)
- **`scripts/ci/lib/sql-tag-scan.ts` byte-identical** — `git diff main...HEAD -- scripts/ci/lib/sql-tag-scan.ts` is **empty**.
- **Allowlisted file's lock marker checked against its OWN text** — `:419-421` reads `text`, never an import graph. Mutation-proved (M-074, M5, M8).
- **Reach asserted only by fixtures that assert a finding IS produced** — T2/T4/T6 all assert non-empty rule arrays; the comment at `:390-395` states the limitation correctly.

### `edge_cases` E1–E10 — all covered by code, and each by a discriminating test

| | Covered by code | Covered by a test that can go red |
|---|---|---|
| E1 `live-db-tenant.ts` not under `helpers/` | glob is `__tests__/`-wide | T1 asserts it in `listAuditedFiles()`; red under M3 |
| E2 `apply-migration-074.ts:55` opaque `db.unsafe(…)` counts as DDL | `extractExecutedSql` `text: null` → `unpragmaedDdlLines` adds the line | T6/T7 + M-074 |
| E3 helper handed its handle names no `LIVE_DB_MARKERS` | `HELPER_DB_MARKER` | T2; red under M1 |
| E4 type-only imports must count | regex is syntax-agnostic | T4; red under M4 |
| E5 `mock-sql.ts` outside the gate | `reachesDb` false | T5; red under M9 (`reachesDb` gate removed) — **not vacuous**, see §2 |
| E6 `describe-with-db.test.ts` is a SUITE, stays in `NOT_LIVE_DB` | `NOT_LIVE_DB` `:86` | pre-existing test at `:89` |
| E7 `scripts/ci/__tests__/` holds no non-suite `.ts` | n/a | verified: all 26 entries are `*.test.ts` |
| E8 helper cannot inherit a caller's lock | own-text check | T6/T7 |
| E9 finding lands on the HELPER, suite stays clean | walk visits the producing node | T2 asserts **both** halves |
| E10 the two sets are disjoint; no double-report | `isSuite` is a pure filename predicate; `git ls-files` dedupes | T1 asserts `new Set(files).size === files.length` |

### `non_goals` — all respected

- **No `e2e/` scanning added.** `e2e/` contains exactly one `__tests__` file and it is a suite (`e2e/fixtures/__tests__/zernio-fixture-server.test.ts`) — matched by the *first* pathspec as it always was. `e2e/helpers/*.ts`, `e2e/seed.ts`, `e2e/harness.ts`, `e2e/fixtures/*.ts` are not under `__tests__/` and remain unscanned.
- **`LIVE_DB_MARKERS` unchanged for suites** — array literal untouched; `HELPER_DB_MARKER` is gated behind `!suite`, so for a suite the reachability expression is *byte-identical* to `main`.
- **No logic change to `DDL_VERB` / `blankSqlComments` / `isUnsafeCall` / `hidesStatementStart`** — the diff for all four is JSDoc-only; function bodies are untouched.
- **No cross-file fragment provenance**, **no caller-lock inheritance**, **no ADR/CONTEXT entry** — all correctly absent.

### `tests_to_add` — 8/8 present verbatim

All eight intake titles appear character-for-character as `it(...)` titles at `:308, :320, :333, :346, :356, :368, :373, :401`.

### `allowed_edit_surface` — no path touched outside it

`scripts/ci/live-db-suites-audit.ts`, `scripts/ci/__tests__/live-db-suites-audit.test.ts`, `.claude/CLAUDE.md`, `.claude/reference/lab-notes.md`, `docs/currents.md`, `docs/progresstracking.md`, `docs/superpowers/plans/**`, `docs/reviews/**`. All 11 changed files are inside the surface.

### Behaviour in the diff not named in `user_visible_behavior`

Three exported symbols renamed (`auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`, `LiveDbSuiteFinding`→`LiveDbFileFinding`) and two `reason` strings reworded ("live-DB **suite** executes DDL" → "**file**"; "allowlisted **suite**" → "**file**"). Not a defect — `rg` over the whole tree finds **zero** live importers of the old names (only historical `docs/reviews/fix-694-*` prose), and `pnpm typecheck` is clean. Recorded here only because it is a public-surface change the intake does not name; see finding 5 for the one doc it left stale.

---

## 2 — Correctness

### Method: mutation, not reading

I materialised mutants of `live-db-suites-audit.ts` in the scratchpad (imports rewritten to absolute paths; no repo edits) and ran the eight new #706 scenarios, three transcribed pre-existing R1 scenarios, the four #694 precision fixtures, and a real-file 074 lock-strip against each. Baseline: **ALL GREEN**.

| Mutation | Tests that go RED |
|---|---|
| M1 drop the `HELPER_DB_MARKER` clause | T2, T3, T4, T6, M-074 |
| M2 apply `naming` to helpers too | T2, T3, T4, T6, T7, T8, M-074 |
| M3 drop the two `__tests__` pathspecs | **T1** |
| M4 `HELPER_DB_MARKER` matches value imports only | T2, T3, T4, T6, M-074 |
| M5 074 helper allowlisted but not in `OWN_APPLY_LOCK` | T7, T8 |
| M6 `isSuite` always false | O1, O2, O3 (the pre-existing R1 cases) |
| M7 `isSuite` always true | T2, T3, T4, T6, T8, M-074 |
| M8 074 helper off `MIGRATION_SHAPE_FILES` | T6, T7, T8, M-074 |
| M9 `reachesDb` gate removed entirely | **T5**, T8 |
| M10 `HELPER_DB_MARKER` offered to suites too | T8 |
| M11 `NOT_LIVE_DB` bypass removed | T8 |

**No vacuous test.** Every one of the eight new cases is killed by at least one mutation. The one that looked suspicious — T5 (`ignores a non-suite helper that imports no DB handle at all`), which passes because `auditLiveDbFile` returns `[]` before any rule runs — is killed by M9, which is exactly what its in-file comment claims it guards ("If the gate did not hold, every mocked template would become a candidate statement"). It is a gate-existence test, not a rule test, and it is honest about that.

M10 turning T8 red is a useful empirical confirmation of the design call in `:156-168`: there really are suites in the tree that would fire findings if the helper marker were offered to them (111 non-integration suites import `postgres`) — though not the ~740 the docs claim (finding 2).

### The 074 allowlist: enforces, does not silence

Decisive check, run against the **real file text** rather than a fixture:

```
readFileSync('src/lib/shared/__tests__/helpers/apply-migration-074.ts')
  .replaceAll('withMigration074ApplyLock', 'withSomeOtherThing')
→ auditLiveDbFile(...) === [{ rule: 'unlocked-ddl', ... }]
```

Confirmed. The DDL it fires on is `db.unsafe(readMigration074Sql())` at `:55` (opaque argument → `text: null` → counted); the lock marker it satisfies is the `withMigration074ApplyLock` *definition* at `:23`, in the file's own text, as the `OWN_APPLY_LOCK` JSDoc claims.

### Fail-closed: no reach regression

There is **no input** where the audit now returns `[]` and previously returned a finding.

- For any `file` where `isSuite(file)` is true, the new reachability expression `LIVE_DB_MARKERS.some(…) || (!suite && HELPER_DB_MARKER.test(text))` short-circuits to `LIVE_DB_MARKERS.some(…)` — literally `main`'s condition. The `naming` branch adds `suite &&`, which is `true`. Both rules and both allowlists are otherwise untouched.
- The old file set (`git ls-files '*.test.ts' '*.test.tsx'`) is exactly the set `isSuite` returns `true` for, so every previously-scanned file is still classified as a suite. The two pathspec sets can only overlap on `__tests__/*.test.ts`, and `git ls-files` dedupes (917 lines, 917 unique — asserted in-process by T1).

The change is monotone: it can only *add* findings.

### `HELPER_DB_MARKER` precision and reach

`/\bfrom ['"]postgres['"]/`.

**Over-matches (all fail-closed, all harmless):** a `from 'postgres'` inside a comment or a fixture string in a non-suite helper would classify it as live-DB. That direction only *widens* R2, and the repo-wide test proves it produces no finding today.

**Correctly does not match:** `from 'postgres-something'` (quote-anchored), `from '@/lib/db/server'`. I checked whether any repo-local module re-exports the `Sql`/`TransactionSql` types, which would falsify the JSDoc's "postgres is the only module that supplies the type" — it does not: the only two `import type { Sql } from '@/lib/db/server'` occurrences in the tree are fixture *strings* inside `scripts/ci/__tests__/{static-policy,db-imports}-audit.test.ts`. The claim holds.

**Under-matches — the one that matters (finding 4):** the inline import-type form. `import('postgres').Sql` types the handle with the postgres module and carries no `from 'postgres'`, so the regex misses it. This is not hypothetical syntax — the repo uses it twice today:

```
src/lib/escalations/__tests__/raise.test.ts:40   }) as never as import('postgres').TransactionSql;
src/lib/shared/__tests__/pool-wait.test.ts:6     return { … } as unknown as import('postgres').Sql;
```

Both are suites, so nothing is invisible *today*. But the idiom is established here for exactly the "hand a fake handle to a helper" shape, and a helper written that way would be a silent R2 blind spot. The BOUND paragraph at `:170-173` names only `unknown`+cast and generic parameters. One alternation — `/\bfrom ['"]postgres['"]|import\(['"]postgres['"]\)/` — closes it; at minimum the BOUND should name it, since this module's stated convention is that each mechanism carries an honest blast radius.

Other forms verified absent from the tree: `require('postgres')`, `await import('postgres')` outside `eslint-boundaries.test.ts`'s own fixture, and any `postgres/<subpath>` specifier.

### The suite/helper split

`isSuite` is a pure filename predicate and cannot misclassify any file in the tree in a way that matters:

- One `.test.ts` exists **outside** `__tests__/`: `src/lib/shared/index.test.ts`. It is an intentionally empty placeholder ("Replaced by real tests in `__tests__/` directory"), reaches no DB, and its treatment is unchanged from `main` — it was already in the old glob. Not a #706 defect, but it is the one file where `isSuite` says "suite" and vitest never runs it.
- `.integration.test.tsx` would still draw a `naming` finding (`endsWith('.integration.test.ts')` is false). Pre-existing, and arguably correct since `INTEGRATION_GLOB` is `.ts`-only. No such file exists.
- The `*__tests__/*.ts` pathspec would also match a directory whose name merely *ends* in `__tests__` (git's fnmatch has no `FNM_PATHNAME`, so `*` crosses `/`). No such directory exists.

### Numeric and factual claims in the new prose

| Claim (new in this diff) | Verified | Verdict |
|---|---|---|
| `HELPER_DB_MARKER` JSDoc: glob alone "reached **4 of the 13** new files" | `describe-with-db.ts`, `abort-injection.ts`, `live-db-lock.ts`, `live-db-tenant.ts` | **TRUE** |
| `HELPER_DB_MARKER` JSDoc: "**five of the six**… use `import type` (exception `helpers/live-db-lock.ts`)" | 6 match; `live-db-lock.ts` is the only value import | **TRUE** |
| `MIGRATION_SHAPE_FILES` JSDoc: "the 074 shape suite and **three further** integration suites delegate to" | 4 importers total: `migration-074-…`, `auto-approval/settings`, `publisher/veto-window-gate`, `response-generation/auto-approval-daily-cap` | **TRUE** |
| `apply-migration-074.ts:55` is `db.unsafe(readMigration074Sql())`, lock defined at `:23` | read the file | **TRUE** |
| lab-notes / currents / progresstracking: "904 → 917 files" | counted | **TRUE** |
| `hidesStatementStart` BOUND: "Neither has an occurrence today" (fragment outside `__tests__/`; `e2e/` lane) | DDL-verb sweep of `src/`+`worker/` outside `__tests__/` → nothing executed; sweep of `e2e/` → zero hits of any kind | **TRUE** |
| `listAuditedFiles` BOUND: "~**738** parallel siblings" | 903 suites under `__tests__/` − 82 integration = **821** | **FALSE** → finding 3 |
| test file `:347`: "**Four** of the six DB-reaching helpers import the module type-only" | **five** of six | **FALSE** → finding 1 |
| currents/progresstracking/lab-notes: "~**740** parallel unit tests import `postgres` types" | 184 suites total with a `postgres` import; 111 non-integration; 110 not already marker-reachable | **FALSE** → finding 2 |

### Re-checking the five triaged deviations against shipped code

| | Re-check |
|---|---|
| **D1** three plan-literal counts corrected | All three shipped values verified TRUE against the tree (table above). **But the correction was applied to the source JSDoc only** — the mirrored number in `live-db-suites-audit.test.ts:347` still reads "Four". D1's own consequence note ("do not restore the plan's numbers") was followed in the source and missed in the test. → **finding 1**. |
| **D2** stale `_SUITES` symbols left for Task 4 | `rg '_SUITES'` over the tree: zero hits outside historical `docs/reviews/fix-694-*` prose. Task 4 did widen to the test file (`:237`). Closed correctly. |
| **D3** three prose sites stale by meaning | Header `:3-8` now names three routes and points at `HELPER_DB_MARKER`'s JSDoc ✓. Lab-notes fragment entry narrowed to "outside `__tests__/` altogether" ✓. `currents.md:166` renamed the constants ✓ — **but the same row's "Same exported signature" sentence is now false** (finding 5), which is the identical stale-by-meaning class D3 was opened for. The deliberate non-change to the R2 census recount method is correct: that census is about marker-passing suites, and widening it would change what the figure means. |
| **D4** lab-notes as a dated section, bound closed in place | Matches the file's real convention; `## 2026-08-08 — #706 …` sits after its #694 siblings, one `### [2026-08-08]` entry in FAIL/WHY/CORRECT form, no content dropped. Correct. |
| **D5** the two "no occurrence today" claims verified | Independently re-verified (table above). Both hold. |

### Blast radius

`docs/reviews/fix-706-live-db-helper-scan/blast-radius.md` says "no changed production source files", which is accurate — but the changed files *do* have a public surface, so I checked it rather than accepting the empty report: three exports renamed, zero live importers anywhere in the tree, `pnpm typecheck` clean, `npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` → 42/42 pass, `pnpm ci:live-db-suites` → passed.

---

## Verification commands run

```
pnpm ci:live-db-suites                                     → live-db-suites-audit: passed
npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts → 1 file, 42 tests, all pass
pnpm typecheck                                             → clean
git diff main...HEAD -- scripts/ci/lib/sql-tag-scan.ts     → empty
git ls-files '*.test.ts' '*.test.tsx' | wc -l              → 904
git ls-files '*.test.ts' '*.test.tsx' '*__tests__/*.ts' '*__tests__/*.tsx' | wc -l → 917
<scratchpad mutation harness, 11 mutants × 16 cases>       → baseline all green; kill table above
```

---

## Appendix — below the confidence bar (not findings)

- **A1.** The public API rename is a behaviour not named in `user_visible_behavior`. Zero live consumers and typecheck-clean, so no failure scenario; noted only for intake hygiene.
- **A2.** `src/lib/shared/index.test.ts` is a `.test.ts` outside `__tests__/` that vitest never runs, yet `isSuite` calls it a suite and R1 would apply to it if it ever reached the DB. Pre-existing (`main` behaves identically); the file is empty by design.
- **A3.** The `*__tests__/*.ts` pathspec would match a directory ending in `__tests__` (e.g. `legacy__tests__/`) and `.d.ts` files under `__tests__/`. Neither exists; a `:(glob)` pathspec would tighten it. Cosmetic.
- **A4.** `HELPER_DB_MARKER` requires exactly one space in `from 'postgres'`; `from  'postgres'` (double space) misses. Prettier normalises, so unreachable in practice.
- **A5.** `listAuditedFiles()` shells `git ls-files` against the process cwd, so running the audit from a subdirectory would return subdir-relative paths and desynchronise the repo-relative allowlists. Pre-existing and unchanged by this diff; both call sites run from the repo root.
- **A6.** R1's header text at `:25` still says "~740 other files" — the same stale figure as finding 3, but it is unchanged from `main` and therefore outside this diff. Worth folding into the same fix.

---

## Round 1 triage (orchestrator)

Every finding **ACCEPT**. Applied on this branch in the round-1 fix commit.
Fix numbering (FIX 1–9) is shared with `review-standards.md`.

| # | Verdict | Disposition |
|---|---|---|
| 1 | **ACCEPT** | FIX 2 — `live-db-suites-audit.test.ts` "Four of the six" → "Five of the six", with the `live-db-lock.ts` exception named, matching the source JSDoc D1 already corrected. |
| 2 | **ACCEPT — with a correction to the reviewer's basis** | FIX 3 — the `~740` figure is replaced in all three docs (`currents.md`, `progresstracking.md`, lab-notes) with the verified **186 / 112**. See "Basis corrections" below: the standards axis reported the same finding on a *false* basis ("zero suites reference `postgres`"), and the number this axis reported (184/110) was measured against the pre-FIX-1 marker. |
| 3 | **ACCEPT — fixed by removal, not restatement** | FIX 4 — the `~738` figure is **deleted** from `listAuditedFiles`' BOUND rather than replaced with a fresh count. Its owner, `vitest.config.ts:9`, is outside this branch's edit surface and is itself stale (it assumes 45 integration suites; the tree has 82), and restating a count owned by another file is what created the staleness. The sentence carries its meaning without a number. |
| 4 | **ACCEPT — the only behaviour change in the round** | FIX 1 — `HELPER_DB_MARKER` widened to `/\bfrom ['"]postgres['"]\|\bimport\(['"]postgres['"]\)/`, the BOUND paragraph corrected so it no longer implies the inline form is an escape, and a new test added inside the `#706` describe block. Verified against all four shapes plus three negative controls; `pnpm ci:live-db-suites` still prints `passed` (no finding on the real tree changes — the two inline-form sites are suites, and the marker is gated behind `!suite`). |
| 5 | **ACCEPT** | FIX 7 — `currents.md:166` no longer claims "Same exported signature". It now says same exported **shape** (1 interface + 2 functions, unchanged arity/return/rule union) and names all three renames explicitly. |

### Basis corrections recorded

- **Finding 2 / standards F1 (`~740`).** The standards reviewer's stated basis — "**zero** `*.test.ts`/`*.test.tsx` files reference the `postgres` module" — is **wrong**: 184 do under the old marker, 186 under the widened one. Its `rg -l "['\"]postgres['\"]"` measurement did not do what it claimed. The *finding* stands (the number as written was false and triplicated); the *rationale* for the asymmetry stands too, and is now stated in terms of what R1 means, with a true volume figure behind it.
- **Finding 3 (`~738`).** Accepted, but fixed by removing the figure rather than by restating it — see the table row above.
- **The figures themselves.** This axis measured 184 suites / 110 newly-R1 against `/\bfrom ['"]postgres['"]/`. FIX 1 widens the marker, so the honest post-fix numbers are **186 / 112** (the +2 are exactly `raise.test.ts` and `pool-wait.test.ts`, the two inline-form sites this axis identified). The docs carry 186 / 112, because 184 / 110 would have been a false checkable number the moment FIX 1 landed.

---

## Round 2 verification

Verification-only pass over the two fix commits `c827429f` + `7fe7bd87`
(`git diff ab54a187..HEAD`). Read-only; no repo edits. Scope is the five round-1
findings plus defects a fix may have introduced — no new fronts against unchanged
code.

### Per-finding verdicts

| # | Verdict | Evidence |
|---|---|---|
| 1 | **VERIFIED** | `live-db-suites-audit.test.ts:347-349` now reads "Five of the six DB-reaching helpers import the module type-only (the exception, live-db-lock.ts, CONSTRUCTS a connection)". Re-counted against the tree: the marker matches exactly 6 helpers; `helpers/live-db-lock.ts:21` is the only `import postgres from 'postgres'` (and it does construct — `postgres(url, …)`); the other five are `import type`. Matches the source JSDoc at `:179-181`. |
| 2 | **VERIFIED** | `~740` is gone from all three docs. `docs/currents.md:10`, `docs/progresstracking.md:2124` and `.claude/reference/lab-notes.md:1874` now carry **186 / 112**, and each states the *reason* for the asymmetry (what R1 means) ahead of the volume. Independently recomputed — see "Counts" below. |
| 3 | **VERIFIED** | `~738` no longer appears in `scripts/ci/live-db-suites-audit.ts`. `listAuditedFiles`' BOUND (`:496-497`) now reads "vitest's `integration` project against the parallel project"; the header (`:25-30`) likewise drops the figure and says why. `rg '740|738'` over the audit script → zero hits. The only surviving copy is `vitest.config.ts:9`, its declared owner and outside this branch's edit surface. |
| 4 | **VERIFIED — closed, not documented** | `HELPER_DB_MARKER` is now `/\bfrom ['"]postgres['"]\|\bimport\(['"]postgres['"]\)/` (`:207`), the BOUND explicitly says the inline form is **not** an escape (`:200-202`), and a ninth `it()` pins it. Mutation-proved discriminating (below). Both cited sites still exact: `pool-wait.test.ts:6`, `raise.test.ts:40`. |
| 5 | **VERIFIED** | `docs/currents.md:166` now says "Same exported **SHAPE** … still 1 interface + 2 functions, same arity, same return shapes, same three-member `rule` union" and names all three renames. Checked against `main`: `LiveDbSuiteFinding`→`LiveDbFileFinding` (interface), `auditLiveDbSuite(file, text)`→`auditLiveDbFile(file, text)`, `listTestFiles()`→`listAuditedFiles()`; `rule` union identical in both. Every claim in the replacement sentence is true. |

### Counts — recomputed independently against the tree

Script: `git ls-files` with the audit's own four pathspecs, the widened regex, the
real `LIVE_DB_MARKERS` array, per-file reads.

| Figure as shipped | Recomputed | |
|---|---|---|
| 917 audited files, 917 unique | 917 / 917 | ✔ |
| 904 suites | 904 | ✔ |
| **186** of the 904 suites match the marker | **186** | ✔ |
| **112** neither marker-visible nor `*.integration.test.ts` | **112** | ✔ |
| the +2 vs the old marker are `raise.test.ts`, `pool-wait.test.ts` | exactly those two | ✔ |
| "4 of the 13 new files" reached by the glob alone | 4 | ✔ (unchanged) |
| header: the removed count "had gone stale by ~80 files" | 903 under `__tests__/` − 82 integration = 821 vs the old ~740 → **81** | ✔ |

Helpers matching the marker: **6 under the narrow regex, 6 under the widened one**
— the widening pulls in **zero** new helpers, so the audited-and-reaching set is
byte-identical on the real tree. `pnpm ci:live-db-suites` → `passed`.

### Did the widened regex over-match?

No, and it cannot change a verdict on today's tree. `HELPER_DB_MARKER` is gated
behind `!suite` (`:424`), so the two suites the widening newly matches are
unreachable by it. On the helper side the set is unchanged (6 → 6). The only
direction the new alternation can err is fail-closed (a comment or fixture string
containing `import('postgres')` in a helper would widen R2), and no such
occurrence exists. Repo-wide audit and the in-suite repo-wide test both green.

### Is the new test vacuous?

No. Mutant harness in the scratchpad (module copied out, imports absolutised, no
repo edits): reverting only `HELPER_DB_MARKER` to `/\bfrom ['"]postgres['"]/`
turns the new case **RED** and leaves all seven controls green —

```
mutant-narrow: RED   'counts an inline import("postgres") type annotation …'
               GREEN  type-only from-import → runtime-ddl
               GREEN  helper fragment DDL → runtime-ddl
               GREEN  mock-sql helper → []
               GREEN  describe-with-db helper → []
               GREEN  074 helper unlocked → unlocked-ddl
               GREEN  074 helper with own lock → []
               GREEN  suite carrying the inline form stays clean
```

The test also asserts `expect(source).not.toContain("from 'postgres'")`, so it
cannot pass by accidentally satisfying the old marker. `npx vitest run
scripts/ci/__tests__/live-db-suites-audit.test.ts` → **43 passed** (was 42).

### Test-title contract

All **8** intake `tests_to_add` titles present character-for-character
(`it('<title>'` string match against `.feature/intake.json`). Title diff old→new:
**one added, zero removed, zero altered** — the added one is
`counts an inline import("postgres") type annotation as a helper reaching the database`.

### Did any fix change rule behaviour beyond FIX 1's regex?

No. Stripping every comment line from `scripts/ci/live-db-suites-audit.ts` at
`ab54a187` and at `HEAD` and diffing the remainder yields exactly one changed
line:

```
-const HELPER_DB_MARKER = /\bfrom ['"]postgres['"]/;
+const HELPER_DB_MARKER = /\bfrom ['"]postgres['"]|\bimport\(['"]postgres['"]\)/;
```

`LIVE_DB_MARKERS`, `NOT_LIVE_DB`, `MIGRATION_SHAPE_FILES`, `DDL_PROBE_FILES`,
`OWN_APPLY_LOCK`, `SHARED_LOCK_MARKER`, `OWN_LOCK_MARKER`, `isSuite`, `DDL_VERB`,
`blankSqlComments`, `isUnsafeCall`, `hidesStatementStart`, `extractExecutedSql`,
`unpragmaedDdlLines`, `auditLiveDbFile`, `listAuditedFiles` — all byte-identical.
`pnpm typecheck` clean; `npx eslint` on both changed files clean.

### New prose introduced by the fixes — claim-by-claim

| New claim | Verified how | Verdict |
|---|---|---|
| `isSuite` JSDoc: "every one of `vitest.config.ts`' include globs additionally requires `__tests__/`" | read all five `sharedTestOptions.include` entries + `INTEGRATION_GLOB` | **TRUE** |
| `isSuite` JSDoc: "the two disagree on exactly one tracked file today — `src/lib/shared/index.test.ts`" | `git ls-files '*.test.ts' '*.test.tsx' \| grep -v __tests__/` → exactly that one file | **TRUE** |
| `isSuite` JSDoc: "an intentionally empty placeholder" | file is two comment lines, no code | **TRUE** |
| `isSuite` JSDoc: "in the audited set since #573" | audit added in `970a7980` (#573/#585); `index.test.ts` added in `24353cf1` (Sprint 1), i.e. already present | **TRUE** |
| header: removed count "had gone stale by ~80 files" | 821 actual vs ~740 stated → 81 | **TRUE** |
| header: the count "is owned by `vitest.config.ts`" | `vitest.config.ts:9` carries it | **TRUE** (see A9) |
| `HELPER_DB_MARKER` JSDoc: the inline form is "already the idiom this tree uses", citing `raise.test.ts`, `pool-wait.test.ts`, "both suites today" | both files still carry it at the cited lines; both end `.test.ts` | **TRUE** |
| `HELPER_DB_MARKER` JSDoc: 186 / 904 / 112 | recomputed | **TRUE** |
| `OWN_APPLY_LOCK` BOUND: "`apply-migration-074.ts` … DEFINES `withMigration074ApplyLock` (its own `:23`)" | `export async function withMigration074ApplyLock` is at line 23 | **TRUE** |
| `OWN_APPLY_LOCK` BOUND: the check "detects … not a refactor that moves `db.unsafe(readMigration074Sql())` outside the wrapper" | mutation: unwrapped the call while keeping the declaration → audit returns `[]` | **TRUE** |
| `OWN_APPLY_LOCK` BOUND: "**`unlocked-ddl` can never fire for that file**" | mutation on the REAL file text | **FALSE** → finding 6 |
| `currents.md:166`: 1 interface + 2 functions, same arity/returns/rule union, three renames | diffed the exported surface against `main` | **TRUE** |

---

### Findings introduced by a fix (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 6 | **Medium** | `scripts/ci/live-db-suites-audit.ts:132-136` | The `OWN_APPLY_LOCK` BOUND added by `c827429f` asserts "the own-text check is satisfied by the declaration and **`unlocked-ddl` can never fire for that file**". It can. Mutation against the real file text: `readFileSync('src/lib/shared/__tests__/helpers/apply-migration-074.ts').replaceAll('withMigration074ApplyLock', 'withSomeOtherThing')` → `auditLiveDbFile(...)` returns exactly `['unlocked-ddl']`. The sentence contradicts (a) its own next clause — "It therefore detects DELETING the helper" — which is only true if the rule *can* fire, and (b) three durable docs shipped in this same PR that record the opposite as proof of enforcement (`progresstracking.md:2130`, `currents.md:10`, `lab-notes.md:1874`: "mutation-proved: strip the lock marker, `unlocked-ddl` appears"). Failure scenario: a maintainer takes "can never fire" at face value, concludes the `apply-migration-074.ts` entry in `OWN_APPLY_LOCK` is inert and removes it; the file then falls to the `SHARED_LOCK_MARKER` branch (`:466`), does not contain `acquireLiveDbLock`, and `pnpm ci:live-db-suites` goes red with the finding the comment promised was impossible. Same false-comment class as round-1 finding 1 and #694's only Medium. Correct wording is the one the BOUND's own next sentence implies: the check fires only if the declaration is deleted or renamed, never on a refactor that moves the DDL out of the wrapper. |

Nothing else was introduced. Findings 1–5 are all fixed, and no fix changed rule
behaviour beyond the one intended regex line.

### Verification commands run (round 2)

```
git diff ab54a187..HEAD                                          → 7 files
pnpm ci:live-db-suites                                           → passed
REPWORTH_DISABLE_LIVE_DB_SUITES=1 npx vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts → 43/43
pnpm typecheck                                                   → clean
npx eslint <both changed files>                                  → clean
<scratchpad: comment-stripped diff of the audit script>          → 1 changed line
<scratchpad: narrow-regex mutant × 8 cases>                      → 1 RED (the new test), 7 GREEN
<scratchpad: 074 real-text lock-marker rename>                   → ['unlocked-ddl']
<scratchpad: 074 real-text DDL-outside-wrapper>                  → []
<scratchpad: marker/marker-set recount over git ls-files>        → 186 / 112 / 6 helpers
```

### Appendix — round 2, below the confidence bar (untriaged, out of scope)

- **A7.** The `HELPER_DB_MARKER` BOUND still says "a helper that types its handle as `unknown` and casts … is invisible", while the new test's own fixture is `handle as unknown as import('postgres').Sql` — an `unknown` cast that IS detected. The next sentence carves the inline form out explicitly, so the paragraph is not false, but "types its handle as `unknown` and casts" now means only "casts to a type whose module is not named here".
- **A8.** `\bimport\(['"]postgres['"]\)` also matches a genuine dynamic value import (`await import('postgres')`) and an `import('postgres')` inside a comment or fixture string. Both are fail-closed and neither occurs in a helper today.
- **A9.** The header now points readers at `vitest.config.ts` as the owner of the parallel-file count without noting that the owning copy (`vitest.config.ts:9`, "~738"; also "45 integration suites" at `:4`) is itself stale by ~83 files. Triage accepted this deliberately — the owner is outside the edit surface — but the pointer sends a reader to a wrong number.
- **A10.** `npx prettier --check` flags both changed files, but it flags them identically at `ab54a187` and there is no prettier config or `format` script in the repo (`lint` is `eslint .`), so this is a tool-default artifact, not a regression.
- **A11.** Appendix items A2–A6 from round 1 are unchanged by this round and remain open/out-of-scope as filed.

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
