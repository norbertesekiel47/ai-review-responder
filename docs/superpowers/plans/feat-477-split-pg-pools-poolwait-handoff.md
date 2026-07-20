# /feature handoff — #477 split Postgres pools + pool-wait observability

**Branch:** `feat-477-split-pg-pools-poolwait` (working IN-PLACE in the main checkout — this background session is configured to work in place, not a sibling worktree; the `.feature/` hooks arm off `.feature/intake.json` + `$CLAUDE_PROJECT_DIR` = repo root, verified by ARM CHECK).

**Resume with:** `/feature-resume feat-477-split-pg-pools-poolwait` — re-enter, re-run ARM CHECK, bootstrap from the files below. Do NOT re-read the grilling transcript; all decisions are on disk.

## Current position: STEP 8 in progress — worker-pool drill PASS; OPEN merge fork (needs user decision). PR #510 draft.

**Latest HEAD:** `d482fd1d` (feat branch, pushed). **Gate: GREEN** (18/18). **PR #510** = DRAFT → `main`, CI green, `mergeState=BLOCKED` (draft). **Staging** = feature deployed at `f7045c8f` (Railway `repworth-worker-staging`, `DB_POOL_MAX=20`, pool-wait metric live). **Prod:** untouched.

**Worker-pool staging burst-drill (2026-07-20): PASS** — full record in ADR 0009 "Staging calibration + capacity gate (executed …)". backend sessions baseline 19 → 1000-row burst peak ~17–19 (never near 57-usable, never near the 20 ceiling); `pool.waitMs`~1ms, `saturating:false` throughout (no queueing induced); warm reserve p99≈3ms / cold 0ms; burst held 50 pending → self-drained to 0, `release` inventory clean. `DEFAULT_POOL_SATURATING_MS=50` **staging-validated** (unchanged) — promoted from "provisional" in `pool-wait.ts`. Execution gate met (#507 soak PASS recorded).

**⚠️ OPEN DECISION — the merge fork (needs the user):** the drill validated the **worker write pool** ONLY. It did NOT exercise the **central hazard** (post-review obs #1) — Vercel connection multiplication: each warm isolate holds write 3 + **read 8 = 11** client conns; the ≤16-warm-isolate budget (16×11 + worker 20 + health 2 ≈ 198 < 200 Max-Clients) rests on ARITHMETIC, not a Vercel-side measurement. So:
- **(a) Ship on the budget argument** — read pool clamped at 8, current traffic low (~10 peak renders << 16-isolate headroom), Vercel side accepted budget-bounded → un-draft #510 + merge.
- **(b) Close the gap first** — run a **Vercel-side drill** on staging (concurrent KPI/draft-status renders) and record observed warm-isolate count + total client connections + backend sessions vs the ≤16 / 200 / 57 bounds BEFORE merge. (There is currently NO Vercel-side load harness — would need building/one-off scripting.)

**Post-review observations (2026-07-20, none code bugs) — captured in ADR 0009:** (1) Vercel multiplication = central hazard (the fork above). (2) read=8 vs #474 ~5 is a justified upward deviation (wedge-safe floor) that directly raises per-isolate conns to 11 — links to (1). (3) read-pool (`sqlRead`) saturation is UNOBSERVED — probe watches only write `sql` (`worker/index.ts:515`); ADR follow-up added to also probe `sqlRead`. (4) pool-wait ships as exposure without paging — intentional (intake non-goal; HealthAlertPoller integration is the tracked follow-up).

**Remaining mechanical steps (after the fork is decided):** (1) **prod** `DB_POOL_MAX=20` on Railway at merge + read Supavisor `pool_size` on the prod dashboard (separate authorization — NOT done); (2) un-draft PR #510 → merge; (3) fast-forward `staging` onto `main` after merge. Staging sits at pre-obs-commit `f7045c8f`; the later ADR/comment commits are no-behavior-change docs (threshold value unchanged) so a staging re-deploy is optional.

**Cleanup note:** `DB_POOL_MAX=20` is set on the Railway **staging** worker and the feature is on the `staging` branch — if the fork resolves to NOT shipping, reset staging to `bd9c8ef9` and unset the staging `DB_POOL_MAX` var.

### (historical) STEPS 4–7 COMPLETE — dual review clean, codex adversarial done + fix landed, GATE GREEN.

**STEP 7 dual review (`/code-review since origin/main`): CLEAN both axes** — Standards: 0 hard violations (4 defensible judgement calls); Spec: 0 findings (faithful to intake + plan).
**STEP 6 codex adversarial review (`--base origin/main`): needs-attention → BOTH findings resolved.**
- Finding #1 [high] `DB_READ_POOL_MAX` unbounded upper → **FIXED** (`c6d90a36`): `READ_POOL_MAX_CEILING=8` + clamp-to-`[8,8]` + warn-log; regression test (`=800`→ceiling); docs + intake reconciled. Deviations doc has full record.
- Finding #2 [high] staging gate pending → **NOT a code fix** — it IS the STEP-8 staging burst-drill (ADR 0009 "TO BE RECORDED" numbers); a hard pre-merge blocker, executed below.
**Post-fix full verify-gate: GREEN 18/18.** The ceiling fix touched only `server.ts` clamp logic + tests + docs (small, well-tested); a full dual-review re-run is optional — offer it, don't force.

**Next action = STEP 8 SHIP (high-risk lane, needs user + Railway/PR):** (1) set `DB_POOL_MAX=20` on Railway **staging**, redeploy; (2) burst-drill with the pool-wait metric live + `pg_stat_activity` watch → calibrate `DEFAULT_POOL_SATURATING_MS` (warm/cold), confirm backend sessions < 57 & Max-Clients < 200 & KPI p99 < 8s, record ALL pending numbers into ADR 0009's staging-gate section; (3) land the drill-proven `DB_POOL_MAX` on prod Railway at promotion; (4) PR to `main`, pause for merge approval; (5) after merge, fast-forward `staging` onto `main`.

### (historical) STEPS 4 + 5 COMPLETE — GATE GREEN, final holistic review PASS.

**STEP 5 verify-gate: GREEN** — all 18 checks PASS (lint, typecheck, full test suite, `build`, every `ci:*` audit incl. db-imports/tenant-scope/static-policy/rls-audit). `.feature/gate-status.json` `passed:true`.
**Final holistic (whole-branch) review: Ready to ship — YES** — 0 critical/important. Verified all cross-task seams (shared-`sql` injection not the health bulkhead; 3-hop `PoolWait` type chain byte-identical; 3-client shutdown ordering leak-safe; invariants #1 + #15 whole-branch). 2 Minors: (a) `PoolWaitPayload` mirror comments corrected for accuracy (canonical owner is shared code, local mirror is a deliberate HTTP-boundary DTO convention — fixed, commit after `197d82fa`); (b) KPI/draft-status 8s-vs-30s statement_timeout = STAGING watch-item (in deviations).

**Next actions (need the user / external systems — natural stop points):**
- **STEP 6 (RISK=high):** offer `/codex:adversarial-review` on the BUILT code. It is USER-INVOKED/billed — the coordinator cannot launch it. Present it; proceed on the user's call.
- **STEP 7:** dual review (standards + spec) — can run via `/code-review` when ready.
- **STEP 8 SHIP high-risk lane:** (1) set `DB_POOL_MAX=20` on **Railway staging**, redeploy; (2) burst-drill with the pool-wait metric live + `pg_stat_activity` watch → calibrate `DEFAULT_POOL_SATURATING_MS` (warm/cold), confirm backend sessions < 57 & Max-Clients < 200 & KPI p99 < 8s, record ALL pending numbers into ADR 0009's staging-gate section; (3) land the drill-proven `DB_POOL_MAX` on prod Railway at promotion; (4) PR to `main`, pause for merge approval. Fast-forward `staging` onto `main` after promotion.

### (historical) STEP 4 COMPLETE — all 4 tasks implemented + two-stage reviewed.

**All four tracer tasks are DONE, committed, and each passed the two-stage review (spec-compliance → code-quality) with its review-fix committed:**
- **Task 1 (sqlRead read bulkhead):** `6f4093b2` + review-fix `ef040783` (bounded `sqlRead.end({timeout:5})`). Spec ✅ / quality ready-with-fixes (Minor #1 fixed; Minor #2 = 30s→8s statement_timeout tightening → STAGING-VALIDATION item in deviations; Minor #3 deferred).
- **Task 2 (single-flight pool-wait probe, `src/lib/shared/pool-wait.ts`):** `b6783e30` + review-polish `3afaf6ce` (diagnostic log for swallowed reserve rejection + drift-safe `Awaited<ReturnType<...reserve>>` type). Spec ✅ / quality ready-to-merge YES.
- **Task 3 (queue-health `pool` + admin badge):** `9e4a8bda` + review-fix `93331958` (lockstep comment → canonical owner). Spec ✅ / quality YES. Invariants #1 + #15 verified by reviewers.
- **Task 4 (env-vars.md + ADR 0009):** `5c7766e2` + review-fix `197d82fa` ("three"→"four" limits). Docs accuracy review ✅ — every capacity number cross-checked against code, no fabricated staging numbers (all "TO BE RECORDED" placeholders).

**Next action for a resumed session:** STEP 5 verify-gate (`scripts/verify-gate.sh` → `.feature/gate-status.json`) — was RUNNING at last checkpoint (lint+typecheck+test+build+all `ci:*`). If GREEN → STEP 6: offer the user `/codex:adversarial-review` on the BUILT code (RISK=high). Then STEP 7 dual review, STEP 8 SHIP high-risk lane: set `DB_POOL_MAX=20` on Railway **staging**, run the burst-drill with the pool-wait metric live + `pg_stat_activity` watch (calibrate `DEFAULT_POOL_SATURATING_MS`, record all pending numbers into ADR 0009's staging-gate section), THEN PR to main + pause for merge approval. **Re-run the ARM CHECK first.**

### (historical) STEP 3 COMPLETE — plan APPROVED.
**Codex round-4 (confirmation, user-approved): `VERDICT: APPROVED`** — all round-3 must-fix items resolved, no new blockers. RISK=high step-3 gate satisfied: 4 adversarial rounds + user sign-off.

---

## (historical) Prior position: STEP 3, gated on Codex verdicts

- Steps 0–2 complete: classified (RISK=high / mixed / normal, ticket-seeded), intake locked + committed, working in-place, ARM CHECK green.
- Step 3 plan is now **round 3** (`docs/superpowers/plans/2026-07-19-split-pg-pools-poolwait.md`). Codex round-1 = REVISE (9 findings) → round-2 plan; codex round-2 = REVISE (blockers #2/#10 latch, #4/#12 capacity, #6 floor + should-fixes) → round-3 plan. Both fully triaged (`plan-review-round1.md`, `plan-review-round2.md`), all accepted. **Codex round-3 (FINAL round — 3-round cap) is RUNNING in the background** (resumed session `019f7dfa-a607-7481-a43b-b263459f3c0a`). If it still REVISEs → surface disagreement to user (do NOT loop a 4th round).
- Round-3 fixes applied: reservation-settlement latch; Nano-tier capacity (57 usable, ≤16 Vercel-isolate budget); DB_READ_POOL_MAX floored at 8; shutdown propagation preserved; draft-status inventory; calibration procedure; final full gate; PoolWait import. Commit `4ef2dfc8`.

## Read these (in order) to bootstrap

1. **Intake contract (drift detector):** `.feature/intake.json` — round-2 amended (surface, non-goals, `pool` behavior).
2. **Plan (round 2):** `docs/superpowers/plans/2026-07-19-split-pg-pools-poolwait.md` — 4 tracer tasks + "How each round-1 codex finding is addressed" table + measured capacity facts.
3. **Round-1 review + triage + #6 decision + capacity facts:** `docs/reviews/feat-477-split-pg-pools-poolwait/plan-review-round1.md`.
4. **Governing invariants:** `.claude/CLAUDE.md` #15 (composition-root DB-client wiring), #1 (Vercel UI-only / queue-health is worker-side). Precedents: `src/lib/db/server.ts` (`createDedicatedPostgresClient`, `closeAllPostgresClients`), `src/lib/shared/backlog-depth.ts` (queue-health injection seam), `worker/internal/queue-health.ts`.
5. **#505 constraint:** lab-notes 2026-07-18 (Promise.all-over-transaction-pooler wedge) + `docs/superpowers/plans/fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md` (owns the heavy dashboard/aggregate waves this ticket deliberately does NOT touch).

## Locked decisions (do not re-litigate)

- **4 grill deltas:** Vercel read bulkhead + worker raise + metric; **separate client instance** (bulkhead); **reserve()-latency** metric; **DB_POOL_MAX=20** target.
- **#6 (post-codex):** RIGHT-SIZE + NARROW. `sqlRead max=8` hosts ONLY `/api/dashboard/kpis` (5-wave) + `past-replies/draft-status` (1). The 14-wave dashboard route + 8-wave aggregate + agent-team STAY on write `sql` (owned by #505 audit). Bulkhead = LOCAL-slot isolation only (shared Supavisor backend — honest ADR).
- **Capacity (measured):** prod+staging `max_connections=60` (57 usable), Micro tier. The 60-conn backend ceiling is binding; `DB_POOL_MAX=20` is ceiling-aware; burst-drill watches `pg_stat_activity`.
- **Probe:** single-flight (≤1 outstanding reserve globally), `{ waitMs, timedOut, saturating, max }`, timedOut = censored lower bound.
- **ADR number 0009** (0007/0008 taken). `application_name` is client-intent-only, NOT attribution (ADR 0007).
- **db_touching:false** — no migration.

## Next actions (in order)

1. **Poll Codex round-2:** `node "/Users/norbertesekiel/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" status <task-id>` (task-id from the round-2 codex-rescue notification), then `... result <task-id>`.
2. If **REVISE**: triage (append to the round-1 review doc), revise plan, re-submit (max 3 rounds total; if still stuck, surface to user).
3. If **APPROVED**: present the approved plan to the user for **sign-off** (step 3 gate for RISK=high).
4. After sign-off → **STEP 4 EXECUTE** via `superpowers:subagent-driven-development`: fresh subagent per task (Task 1 ∥ Task 2 → Task 3; Task 4 docs). Each subagent prompt includes the task's plan slice + CONTEXT glossary (read pool / pool-wait probe / timedOut / saturating).
5. **STEP 5 gate:** `scripts/verify-gate.sh` (writes `.feature/gate-status.json`) — the stop-gate needs it green + newer than HEAD before completion. Extra verification cmds: `pnpm ci:db-imports`, `pnpm ci:tenant-scope`, `pnpm ci:static-policy`.
6. Step 6 skipped-or-not: RISK=high but step 6 (adversarial review of BUILT code) is `/codex:adversarial-review` (user-invocable) — offer it. Step 7 dual review. Step 8 SHIP high-risk lane: staging ride first (set `DB_POOL_MAX=20` on Railway staging, burst-drill with metric live + pg_stat_activity watch), then PR to main, pause for merge approval.

## Execution progress (STEP 4 — subagent-driven; checkpoint after Task 1)
- **Task 1 (read bulkhead): DONE + COMMITTED `6f4093b2`.** All gates green: `ci:db-imports`, `ci:tenant-scope` (394/394), `ci:static-policy`, typecheck, 107 tests. Includes: sqlRead (floored max 8) + SHARED_POOL_MAX + WEDGE_SAFE_READ_MIN in server.ts; DB_READ_POOL_MAX in config schema; closeAllPostgresClients owns sqlRead (best-effort) + sql.end() propagates; KPI gate SELECT + get*KpiSummary → sqlRead (auth stays on sql); draft-status job_outbox+response reads → sqlRead; sqlRead-sentinel mocks. **Plus a user-approved surface amendment**: fixed `scripts/ci/tenant-scope-audit.ts` `extractSqlTagNames` to recognize `sqlRead` (was blind to it → tenant-scope coverage gap) + 2 regression tests. Deviations file has details.
- **PENDING: Task 1 two-stage review** (subagent-driven-development: spec-compliance reviewer, THEN code-quality reviewer) — NOT yet done; do this first on resume before Task 2.
- **Tasks 2, 3, 4: NOT STARTED.** Order: Task 2 (single-flight probe) → Task 3 (queue-health + admin) → Task 4 (docs/ADR 0009). Then final full review + `scripts/verify-gate.sh` (step 5) → step 6 offer `/codex:adversarial-review` → step 7 dual review → step 8 SHIP high-risk lane (staging ride: set DB_POOL_MAX=20 on Railway staging, burst-drill w/ pool-wait metric + pg_stat_activity watch → PR to main, pause for merge approval).
- **Resume:** `git log origin/main..HEAD` shows committed tasks; continue from Task 1 review → next uncommitted task. Each implementer subagent prompt must include: the plan's Task-N slice + the CONTEXT/glossary + hard constraints (edit-surface guard armed; invariant #15; the specific per-task gotchas). Run one implementer at a time (no parallel).

## Execution readiness (verified)
- `ci:db-imports` accepts `sqlRead` imports in KPI/draft-status **route handlers** (composition roots); `pool-wait.ts` takes `sql` as a param (never imports db/server) — invariant #15 clean.
- `verify-gate.sh` reads intake `.surface` = `mixed` → runs lint+typecheck+test + all `ci:*` (except fallow) + `build`. That IS the Task-4 final gate.
- Round-4 (user-approved confirmation) verdict pending; if APPROVED → Step 4. Recommend a fresh `/feature-resume` session for execution (this planning session is context-heavy).

## Execution notes (verified precedents for step 4 subagents)
- **KPI route test** (`src/app/api/dashboard/kpis/__tests__/route.test.ts`) already mocks `@/lib/db/server` (line 15) and asserts `getLocationKpiSummary`/`getAccountKpiSummary` with `expect.any(Function)` as arg 1. To prove `sqlRead` is passed (not `sql`): add a distinguishable `sqlRead` SENTINEL to that mock and switch the KPI-call assertions from `expect.any(Function)` → the sentinel.
- **queue-health test** (`worker/internal/__tests__/queue-health.test.ts`): deps are `createQueueHealthHandler({ getSecret, getQueueCounts, getBacklogDepth })`; add `getPoolWait: vi.fn().mockResolvedValue({ waitMs, timedOut, saturating, max })` the same way.
- **server.test.ts** floor test uses `vi.resetModules()` + `vi.stubEnv` + dynamic `import('../server')` — reset modules again after so it doesn't leak into sibling tests.

## Ship-time glossary to fold into CONTEXT.md (step 8 domain sweep)
read pool / `sqlRead`; pool-wait probe (single-flight, reservation-settlement latch); `timedOut` (censored lower bound); saturating; WEDGE_SAFE_READ_MIN.
