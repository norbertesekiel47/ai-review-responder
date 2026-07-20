# /feature handoff — #477 split Postgres pools + pool-wait observability

**Branch:** `feat-477-split-pg-pools-poolwait` (working IN-PLACE in the main checkout — this background session is configured to work in place, not a sibling worktree; the `.feature/` hooks arm off `.feature/intake.json` + `$CLAUDE_PROJECT_DIR` = repo root, verified by ARM CHECK).

**Resume with:** `/feature-resume feat-477-split-pg-pools-poolwait` — re-enter, re-run ARM CHECK, bootstrap from the files below. Do NOT re-read the grilling transcript; all decisions are on disk.

## Current position: STEP 3 (plan), gated on Codex round-3 verdict + user sign-off

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

## Execution notes (verified precedents for step 4 subagents)
- **KPI route test** (`src/app/api/dashboard/kpis/__tests__/route.test.ts`) already mocks `@/lib/db/server` (line 15) and asserts `getLocationKpiSummary`/`getAccountKpiSummary` with `expect.any(Function)` as arg 1. To prove `sqlRead` is passed (not `sql`): add a distinguishable `sqlRead` SENTINEL to that mock and switch the KPI-call assertions from `expect.any(Function)` → the sentinel.
- **queue-health test** (`worker/internal/__tests__/queue-health.test.ts`): deps are `createQueueHealthHandler({ getSecret, getQueueCounts, getBacklogDepth })`; add `getPoolWait: vi.fn().mockResolvedValue({ waitMs, timedOut, saturating, max })` the same way.
- **server.test.ts** floor test uses `vi.resetModules()` + `vi.stubEnv` + dynamic `import('../server')` — reset modules again after so it doesn't leak into sibling tests.

## Ship-time glossary to fold into CONTEXT.md (step 8 domain sweep)
read pool / `sqlRead`; pool-wait probe (single-flight, reservation-settlement latch); `timedOut` (censored lower bound); saturating; WEDGE_SAFE_READ_MIN.
