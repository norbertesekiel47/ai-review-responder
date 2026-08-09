# Handoff — fix-706-live-db-helper-scan

**Ticket:** #706 — `ci:live-db-suites` cannot see DDL in a SQL fragment built inside `__tests__/helpers/*.ts`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-706-live-db-helper-scan`
**Lane:** RISK = normal · SURFACE = backend · SIZE = normal · `db_touching: false`
**Phase at write time:** `plan_approved` (step 3 → step 4 boundary)

## Artifacts — read these, not this file's summary of them

| What | Path |
|---|---|
| Intake contract (arming copy) | `.feature/intake.json` |
| Intake contract (committed audit copy) | `docs/superpowers/plans/fix-706-live-db-helper-scan-intake.json` |
| Implementation plan (4 serial tasks, full code) | `docs/superpowers/plans/2026-08-08-706-live-db-helper-scan.md` |
| Deviations (created by subagents on first surprise) | `docs/superpowers/plans/fix-706-live-db-helper-scan-deviations.md` |
| The module under change | `scripts/ci/live-db-suites-audit.ts` |
| Its test | `scripts/ci/__tests__/live-db-suites-audit.test.ts` |
| Why the hole exists (Postgres.js `fragment()`, proved live) | `docs/reviews/fix-694-live-db-ddl-detector/review-spec-correctness-round-2.md` §F1 |
| Prior ticket's deviations, entry D7 | `docs/superpowers/plans/fix-694-live-db-ddl-detector-deviations.md` |

No glossary excerpt applies: `CONTEXT.md` is the product-domain glossary and carries no CI-audit terms. The authoritative owner of live-DB-suite mechanics is the audit's own header plus `.claude/reference/lab-notes.md:22` and the CLAUDE.md gotcha bullet — all three are rewritten by plan Task 4.

## Decisions locked during grilling (owner-chosen, do not re-litigate)

1. **Scan unit = every non-suite `.ts`/`.tsx` under `__tests__/`**, not the ticket's `__tests__/helpers/**`. Rationale: `src/lib/shared/__tests__/live-db-tenant.ts` is a live-DB helper outside any `helpers/` directory, and vitest's own runner glob is the non-arbitrary line.
2. **Helper reachability = an import of `postgres`** (value or type-only), helper-only. Suites keep `LIVE_DB_MARKERS` unchanged — ~740 parallel unit tests import `postgres` types for mocks and would trip R1.
3. **`apply-migration-074.ts` is allowlisted and lock-enforced**, and both allowlists rename `_SUITES` → `_FILES`.
4. **The `e2e/` Playwright lane is an explicit non-goal.**

Decided by the orchestrator, not asked: an allowlisted file's lock marker must appear in its **own** text (inheriting a caller's lock needs an import graph); no ADR and no `CONTEXT.md` term.

## Ticket premises that turned out wrong — corrected in the intake

- "Several helpers would immediately trip R1 (naming)" — only **two** carry a `LIVE_DB_MARKERS` string, and with R1 restricted to suites neither trips anything. **No `NOT_LIVE_DB` expansion is needed**, contrary to the ticket's Scope section.
- Widening the glob alone closes almost nothing: helpers are handed their handle and name no marker. Decision 2 is the load-bearing half of the fix, and the ticket does not mention it.

## Verified facts (re-check only if the tree moved)

- Scanned set 904 → **917** files (+13). `git ls-files` dedupes across pathspecs (`| sort | uniq -d` empty).
- Forcing the gate open across all 13: **exactly one** fires — `src/lib/shared/__tests__/helpers/apply-migration-074.ts:55`, `db.unsafe(readMigration074Sql())`. Zero false positives on the other 12.
- The renamed symbols have **no consumers outside the two files in the edit surface** → no compat shim (pre-launch rule).

## Next step

Step 4 — dispatch plan Tasks 1→4 as fresh subagents, **serial** (all four touch the same two files; the plan marks none mutually independent). Run the first-task enforcement spot check after Task 1: `git status --porcelain` paths must all sit inside `allowed_edit_surface`.

Then step 5 (`scripts/verify-gate.sh`, then `--review`), step 6 deviations read-back, step 7 two-axis review (spec+correctness, standards — no adversarial axis, RISK = normal), step 8 normal lane (push, PR to `main`, CI green, merge).

Gate note: `db_touching: false` and no `*.integration.test.ts` changes, so the gate's `integration-suites` row is not a review-readiness blocker here.
