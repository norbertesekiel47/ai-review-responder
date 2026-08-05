# Standards & Maintainability Review — feat-673-import-consent-columns

- **Branch:** `feat-673-import-consent-columns` (worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-673-import-consent-columns`)
- **Range:** `git diff 44e5a62f...HEAD` (6 commits, 11 files, +1288/−3)
- **Method:** `thermo-nuclear-code-quality-review` skill, plus the repo-specific lenses (CLAUDE.md standards, CONTEXT.md-adjacent glossary, locked change-detector exemptions, triaged deviations D1–D6)
- **Scope:** migration `100_import_consent_and_backfill_counters.sql`, `worker/jobs/zernio/ZernioBackfillWorker.ts` UPDATE block, `scripts/ci/tenant-scope-allowlist.ts` re-pin, `src/lib/shared/__tests__/helpers/schema-ready.ts` entry, the two test files, `.claude/reference/migrations-log.md` entry. Docs/plan/intake artifacts read as review inputs, not audited.

## Verdict

**PASS.** No structural regression, no missed code-judo move of consequence, no file-size explosion, no spaghetti growth, no boundary leak. The production diff is close to minimal for the locked design: 8 worker lines riding the existing counts UPDATE, one additive migration, one registry entry, one allowlist re-pin. One Low finding (test-helper duplication in new test code).

## Findings (≥80% confidence)

| # | Severity | Location | Standard | Finding |
|---|----------|----------|----------|---------|
| 1 | Low | `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts:239-243`, `:428-432`, `:339-342` | Copy-pasted logic instead of extracted helper (thermo-nuclear checklist; CLAUDE.md "reuse existing helpers") | The branch extracts `findCountsCalls()` (line 153) for the counts-UPDATE template predicate, but then copy-pastes the structurally identical `INSERT INTO zernio_backfill_runs` filter predicate inline in **two** new places (the reactivation test and the `it.each` dual-write test). Additionally, the pre-existing test the diff touched (expectation at line 344 changed to the 8-element array) still carries its own inline copy of the exact predicate `findCountsCalls()` now owns (lines 339-342). A sibling `findInsertCalls()` helper plus using `findCountsCalls()` at the touched site removes three duplicates for ~6 lines. Behavior-neutral, test-only. |

### Finding 1 — detail

New code in the same file, same PR:

```ts
// helper added by this branch (line 153)
function findCountsCalls(): any[][] { … template.some((s) => s.includes('gap_processed_count')) … }

// yet the same shape is re-inlined twice for INSERT (lines 239-243, 428-432):
const reactivationInsert = mockSql.mock.calls.find((call: any[]) => {
  const template = call[0];
  return Array.isArray(template) &&
    template.some((s: string) => s.includes('INSERT INTO zernio_backfill_runs'));
});
```

The `(call: any[])` mocked-template inspection idiom itself is pre-existing sanctioned style in this file — not part of the finding. The finding is only the missed extraction/reuse.

## Standards checklist (repo lenses)

| Lens | Result |
|---|---|
| **Invariant #15 (explicit `sql` param)** | Pass — `handleZernioBackfill(sql, job)` unchanged; no new `@/lib/db/server` import. |
| **No string-literal statuses in TS** | Pass — the worker adds no status literals; `'pending'/'accepted'/…` live only in migration SQL and in the shape suite's `ENUM_VALUES` pin (a change-detector, correctly local — no production TS consumer of `import_decision` exists until #677, so minting a constants file now would violate "no new file" / "no abstraction for a single caller"). |
| **No `any`** | Pass — worker code clean; test-file `any[]` is the pre-existing sanctioned mock-inspection idiom. |
| **Tenant-scope allowlist re-pin** | Pass — snippet at `scripts/ci/tenant-scope-allowlist.ts:2223` byte-matches the new UPDATE; category/reason unchanged, correctly so. |
| **Live-DB suite conventions (#573)** | Pass — `*.integration.test.ts`, `acquireLiveDbLock`, `assertSchemaReady(MIGRATION_100_IMPORT_CONSENT)`, no run-time migration SQL; behavioural probes roll back or are rejected statements, so fixtures stay inert. The SQL-file text test correctly sits outside the DB gate so it fails red when the file is absent. |
| **Migration conventions** | Pass — `SET lock_timeout = '5s'` (099 precedent), `ADD COLUMN IF NOT EXISTS`, named CHECK with idempotent DROP/ADD pair, CHECK paired with NOT NULL (CHECK-passes-NULL trap addressed), no speculative index, no down migration per precedent, COMMENT literals semicolon-free per the suite's split contract (D6). `migrations-log.md` head bumped 099→100 with **LOCAL-ONLY** tag per convention. |
| **Schema-ready registry** | Pass — `MIGRATION_100_IMPORT_CONSENT` uses the pre-existing `constraints` field (090 precedent); doc comment explains why the constraint is asserted by name (the 099 lesson). Matches registry idiom. |
| **Glossary** | Pass — "Consented Review Import", "import offer"/"import-offer state", "collapse"/"collapsed counters", "ADD half"/"DROP" used consistently across migration comments, worker comment, schema-ready entry, migrations-log, and test headers. No concept renames. |
| **Deep-module discipline** | Pass — zero new production interfaces; the worker change deepens an existing statement rather than widening any seam. The only new exports are the registry entry and test-local helpers. |
| **Comment idiom** | Pass — issue/spec/§ references match surrounding style; "T1/round-3 finding N" references follow established precedent (`ask-generation.ts`, 099 suite). |
| **Deviations D1–D6** | All ACCEPTed deviations verified as implemented as described (D5's standalone-identifier regex at test line 251; D6's em-dash COMMENT). None re-flagged. |

## Change-detector exemptions honored

Per the locked decisions, the following strictness is **deliberate and not flagged**: the `DUAL_WRITE_TEMPLATE` whole-statement pin, the shape suite's full-definition `pg_get_constraintdef` equality (`'pending'::text` rendering pin, PG16), the `column_default` catalog pins, the 7-column presence count, and the additive-only executable-SQL allowlist (including its ~40-line statement parser — fail-closed: any unrecognized statement, inline comment, or literal semicolon fails loudly with the offending statement in the message, and the migration header documents the authoring constraint). No brittleness **beyond** what those locked decisions require was found.

## Code-judo assessment

Considered and rejected as inferior to the shipped shape:

- **Computing the sums in SQL** (`imported_count = ${gapProcessed} + ${historicalProcessed}`) — the two named JS consts are clearer and keep the allowlist snippet legible.
- **Postgres generated columns** for the collapsed counters — would eliminate the dual-write but breaks at the #680 DROP half (generated columns referencing dropped columns) and violates the locked two-migration revert-safety design (§8a R4). Correctly not done.
- **A side table for consent** — explicitly rejected at charting (#673); 099/089 precedent puts 1:1 per-location config on `businesses`. Migration comment records this.

## Low-confidence appendix (not findings)

- `DUAL_WRITE_TEMPLATE` comment "Normalized against Task 3 Step 1's statement" (test line 143) references plan-internal task numbering with no file pointer; survivable since the invariant itself is stated in the same comment, and "round-N finding" references are established repo idiom — but a `#673` plan-file pointer would age better.
- The reconcile-failure test destructures `[reconcileCounts] = findCountsCalls()` without asserting exactly one counts call (the dual-write `it.each` does assert `toHaveLength(1)`); if the flow ever grew a second counts UPDATE the assertion would silently check only the first.
- `executableSql` filtering strips full-line `--` comments but not trailing comments on code lines; the allowlist fails closed on such a line, so this is self-defending, merely implicit.
- Shape-suite `sql()` accessor wrapping `db!` is a micro-indirection the 099 suite lacks; the docstring justifies it (probes must not capture the still-undefined binding) and it is arguably an improvement — noted only as a divergence from the sibling suite.

## Approval bar

- No structural code-quality regression — met
- No missed dramatic-simplification path — met (see code-judo assessment)
- No file pushed past 1k lines — met (worker test → ~590 lines; shape suite 333)
- No spaghetti growth — met (worker adds two consts + two SET columns to one existing statement)
- No hacky/magical abstraction, no wrapper/cast churn — met
- No boundary leak / canonical-helper duplication in production code — met (Finding 1 is test-local)

**APPROVE** with Finding 1 as an optional test-only cleanup.

## Round 2 verification (2026-08-05)

Scope: verify the fix for round 1's single accepted STANDARDS finding (Low — duplicated
test predicates in `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`), landed
in commit `14704a19`.

- **Duplication removed.** `findBackfillInsertCalls()` is defined at lines 160–166,
  directly after `findCountsCalls()`, and replaces both inline copies of the
  INSERT-template predicate (reactivation test line 247, initial-branch `it.each`
  line 437). The diff-touched Copilot counts test now calls `findCountsCalls()`
  (line 341). No inline copy of either extracted predicate remains in any
  diff-touched test; the surviving inline `gap_processed_count` predicates
  (lines 392, 528, 563, 575) are in unchanged pre-existing tests or the negated
  variant — outside this finding's scope.
- **Helpers used correctly.** Single-call sites destructure `[first]` and assert
  `toBeDefined()` (lines 247, 341, 581); multi-call sites keep the array and assert
  length (lines 429, 437). Semantics match the replaced `.find(...)` calls.
- **Style consistent.** Same `find*Calls(): any[][]` naming/signature and
  `mockSql.mock.calls.filter` shape as the file's existing `findCountsCalls()`.
- **Tests pass.** `npx vitest run worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`
  → 1 file, 14/14 passed (vitest 4.1.7, 185ms).
- **Nothing new introduced.** The fix commit touched only the three sites plus the
  helper definition in this file; no behavior or assertion strength changed.

**VERDICT: fix VERIFIED — round 1 STANDARDS finding closed.**
