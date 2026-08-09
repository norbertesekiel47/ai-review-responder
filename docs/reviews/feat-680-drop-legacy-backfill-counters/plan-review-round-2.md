# Plan review round 2 — codex adversarial (read-only, verification-only)

**Ticket:** #680 · **Reviewer:** `codex exec --sandbox read-only` (codex-cli 0.145.0)
**Brief:** `<b2dde277>/codex-plan-brief-680-r2b.md` · **Raw transcript:** `<b2dde277>/codex-plan-review-680-r2b.jsonl`
**Audited at:** clean `HEAD 95f276b6` (codex noticed HEAD advance `eed47342` → `95f276b6` mid-audit
and re-read the artifacts at the new HEAD before ruling — the verdict reflects the submitted tree)
**Verdict:** `REVISE`

## Round history

Round 2's **first** attempt was killed mid-run with no verdict; its "completed" background task
carried only state bookkeeping. Per owner decision 2026-08-08, an aborted run that never emitted a
verdict does not consume a round, so this re-submission is still round 2 — **round 3 is the last
permitted round.**

Two defects were fixed *before* this re-submission (commit `eed47342`): the `pg_temp`-shadow
BLOCKER and the dollar-quote-aware split. Codex confirms the shadow fix's mechanics but faults both
fixes on new grounds — see F11 and F13.

## Findings and triage

| # | sev | finding | verdict |
|---|---|---|---|
| F11 | BLOCKER | F1 still bypassable: excising the whole `DO` block makes its body opaque, and the 4-keyword denylist misses `DROP TABLE`/`CREATE`/`INSERT`/`ALTER` *inside* the guard. Also `.match()` without `/g` cannot count blocks by `.length`, and `/DO \$\$…/` fails closed on `$body$` | **ACCEPT** — all three sub-claims verified. `"aXbXc".match(/X/).length === 1` regardless of match count, so the "exactly one block" assertion was inert. Fix: pin the whole normalized `executableSql` and delete the excise-and-count step |
| F12 | BLOCKER | The early return checks only `gap_processed_count`; if it is absent while any of the other three remain, the guard returns and the `ALTER` irreversibly drops the survivors unreconciled. "Already dropped" is false for a partial schema | **ACCEPT** — 103's own four-column `ALTER` is atomic so it cannot *create* this state, but the guard must be fail-closed against any input state, not just states 103 produces. Fix: all four absent → RETURN, all four present → reconcile, partial → RAISE |
| F13 | MAJOR | "Resolves to `public` in a real apply" is conditional, not unconditional: Postgres searches the session's temp schema first, so a same-name temp table makes `to_regclass`, the unqualified `FROM` and the unqualified `ALTER` all target it — 103 could succeed while leaving `public.zernio_backfill_runs` untouched | **ACCEPT** — true of Postgres name resolution. Practically unreachable (migrations apply in a fresh session), but the plan asserted it unconditionally. Fix: make it true *by construction* with an explicit `SET LOCAL search_path = public, pg_temp` statement rather than by assumption |
| F14 | MAJOR | The false migration-102 precedent survives in **two** places — plan `:60` "Precedent to follow" and intake `:40` — both claiming 102's skeleton supplies `acquireLiveDbLock` + `assertSchemaReady`, contradicting the corrected split at plan `:36-41` | **ACCEPT** — verified: the 102 suite imports **neither** symbol (its imports are `node:fs`, `node:path`, `vitest`, `postgres`, `describe-with-db`, `analytics/events`). Round 1's F5 fix corrected the Design-analysis section and missed both of these |
| F15 | MAJOR | The pragma instructions cover the visible `CREATE TABLE` but not the necessarily dynamic `tx.unsafe(guardSql)`; the audit treats an unreadable `.unsafe()` argument as DDL, so the suite fails `ci:live-db-suites` without a second line-scoped ignore | **ACCEPT** — verified at `scripts/ci/live-db-suites-audit.ts:264-276`, whose header states it outright: "An unreadable `.unsafe()` argument counts as DDL: unresolvable SQL must never pass as safe" (`:285-286`) |
| F16 | MINOR | F9's rejected broad claim is still authoritative in the intake (`:30`, edge case E3): "It cannot exist" | **ACCEPT** — the plan was narrowed in round 1, the intake was not. Same correction, applied to E3 |
| F17 | MINOR | T2's outcome line still says test 4 goes green "on the header text" — but revised test 4 executes the guard and proves its passing branch | **ACCEPT** — stale sentence left behind by the F2 reversal |

**Rejected: none.** Every finding was verified against disk before acceptance.

## What codex independently CONFIRMED (corroboration, not findings)

- F3, F4, F6, F7, F10 are correctly addressed, **including the rebased worker and runbook line
  citations** (`:226`/`:716`/`:1090` and `:355-357`/`:359-362`/`:376-377`).
- `to_regclass` and the unqualified `FROM` **resolve consistently** under a fixed search path;
  calling the STABLE function twice is not itself hazardous; `NOT attisdropped` correctly excludes
  tombstone rows. The NEW-FIX-1 mechanics are sound — the fault is only that determinism was
  assumed rather than enforced (F13).
- Transaction rollback plus `acquireLiveDbLock` **is** sufficient isolation for the `pg_temp`
  fixture, once the dynamic-execution pragma is added (F15).

## Consequences for the plan

1. **T1 test 1 is restructured** (F11): pin the whole whitespace-normalized `executableSql` against
   an expected canonical text — the migration is immutable once landed, so exact pinning is the
   right instrument — and keep the destructive-keyword scan as a redundant readable tripwire. The
   excise-and-count step is deleted outright, which retires the `.match()`/`/g` bug and the `$body$`
   fragility with it.
2. **The guard grows a cardinality check** (F12): count the four legacy columns; `0` → RETURN,
   `4` → reconcile, anything else → RAISE naming the count.
3. **The migration gains an explicit `SET LOCAL search_path = public, pg_temp`** (F13), making the
   statement list four, not three.
4. Plan `:60` and intake `:40` corrected to the true precedent split (F14); intake E3 narrowed
   (F16); T2's test-4 outcome sentence corrected (F17).
5. T1 gains a second `-- live-db-ddl-ignore` on the `tx.unsafe(guardSql)` line (F15).
6. **Intake edited** → `intakeSha256` re-signed in `.feature/state.json`, both copies kept identical.
   F14 and F16 are factual corrections to citations and a soundness claim; **no scope, invariant,
   test title, or edit-surface entry changes.** Amendment count stays at 1.
