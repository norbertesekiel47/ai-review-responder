# Standards & Maintainability review — #500 pool-wedge self-heal

**Reviewer:** Standards & Maintainability (thermo-nuclear code-quality lens)
**Scope:** `git diff main...HEAD` production files (reaper poller + query + selection, health-alert bulkhead, `db/server` shutdown seam, config, `worker/index.ts` wiring).
**Method:** `thermo-nuclear-code-quality-review` skill, standards/maintainability axis. Confidence filter: table holds only ≥80%-confidence findings with `file:line` + exact standard violated. Accepted deviations in `fix-500-pool-wedge-selfheal-deviations.md` (D1–D7) were verified-as-implemented, not re-litigated.

## Verdict

**NO HIGH-CONFIDENCE FINDINGS.**

This is a structurally clean diff. Modules are deep and well-named; complexity is pulled down appropriately; no file approaches the 1k-line boundary (largest new file: `PoolWedgeReaperPoller.ts` at 319 lines). No spaghetti branching was bolted onto existing flows — `worker/index.ts` gains only symmetric start/stop/close wiring, and the `closeDb` dep actually *shrank* to a one-liner delegating to the new `closeAllPostgresClients` seam. No `any`, no boundary leaks, no invariant-#15 violations (both pollers are registered composition roots and own the factory import; `health-db.ts` correctly receives an injected `buildClient` per D4).

## Findings table

_None at ≥80% confidence._

| severity | file:line | finding |
|---|---|---|
| — | — | No high-confidence findings. |

## Reasoning — why the obvious candidates do NOT clear the bar

**Marker DRY (`checks.ts` hardcodes the `/* rw-reapable */` literal in 5 queries instead of importing `REAPABLE_MARKER`).** This is the one place knowledge is physically duplicated. It is *forced*: postgres.js seeds the sent query text with `strings[0]` verbatim, so interpolating `${REAPABLE_MARKER}` would turn the marker into a bind parameter and it would never appear in `pg_stat_activity.query`. The literal must be inline. Critically, the duplication is guarded by a real test — `health-alert-markers.test.ts` imports `REAPABLE_MARKER` and asserts each of the five check queries `.startsWith()` it — so the "keep in lockstep" comment is enforced by code, not trust. Engineering.md's single-owner rule is satisfied by the test acting as the derivation check. Not a finding.

**Three-way `AcquireOutcome` + unified `acquireVerifiedClient` (D7).** Replacing the boolean `isVerifiedDirect` with a `verified | pooler | transient` discriminated union is the opposite of spaghetti — it collapses the boot path and the re-acquire path into one verification seam and makes the transient-vs-definitive distinction a type, not a scattered conditional. This is the code-judo direction the skill asks for. Correctly implemented.

**`selectTerminations` as a pure function.** The dangerous decision (which/how-many to kill) is isolated as a side-effect-free pure fn with property-testable contract, keeping the SELECT a plain query and the poller a plain loop. Textbook special-general decomposition. Deep and earning its keep.

**`closeAllPostgresClients` seam (D6).** Extracting the close-order + `Promise.allSettled` best-effort contract into the db owner is the right home (it owns `sql`), makes the resilience invariant unit-testable without booting the worker, and shrinks the `worker/index.ts` `closeDb` dep. Well-placed, not a pass-through wrapper — it encodes a load-bearing ordering + fault-isolation guarantee.

**Bulkhead + reclaim (`health-db.ts`, `createDedicatedPostgresClient`).** Dedicated small pools with injected builders; shared base config has one authoritative owner (`BASE_POSTGRES_OPTIONS`). Information hiding is strong.

## Low-confidence appendix (below the ≥80% bar — not blockers, listed for author judgment only)

1. **Near-duplicate close helpers.** `closeReaperClient` (`PoolWedgeReaperPoller.ts:310`) and `closeHealthSql` (`health-db.ts:68`) are byte-similar (~8-line: capture client → null the module var → `if (!client) return` → `try { end({timeout:5}) } catch {}`). A shared helper is awkward here because each owns a distinct module-level `let` (`reaperSql`/`healthSql`) that can't be passed by reference without getter/setter closures — extracting would add indirection for little clarity gain (design.md argues *against* it). Left as-is is defensible; flagging only for awareness.

2. **Decomposition asymmetry.** The health poller extracts its client lifecycle to `health-db.ts`, but the reaper keeps build/acquire/recycle/close/`endQuietly` + module state inside `PoolWedgeReaperPoller.ts`. Justifiable on cohesion grounds (the reaper's lifecycle is entangled with the three-way verification, and the file is only 319 lines), but a future reader may expect a parallel `reaper-db.ts`. Not worth churning now.

3. **Double `resolveDirectUrl()` read** in `pollPoolWedgeReaper` (`:226` guard, then again inside `acquireVerifiedClient` `:137`). Intentional — the outer guard distinguishes "no URL → permanent `disableWithAlert`" from acquire's defensive "no URL → transient". Correct behavior; the second read is a cheap env lookup. Could be tidied by having acquire return a `'no-url'` status, but that widens the union for marginal benefit.

4. **Op-timeout consistency.** The reaper's per-op bound is env-tunable (`readOpTimeoutMs()`, default 8s); the health poller's `HEALTH_CHECK_TIMEOUT_MS` is a hardcoded 30s module const (pre-existing). Minor inconsistency in tunability posture across the two sibling pollers; not introduced as a regression.
