# Handoff — #505 pool-wedge root-cause + cure + reaper deletion

Resume a fresh session from this doc → referenced files → step 4 (EXECUTE). Do NOT
need the prior transcript. **Re-run the ARM CHECK first** (below).

## Worktree & resume
- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-505-pool-wedge-rootcause`
  (sibling; cwd resets to parent each Bash call — `cd` into the worktree every command).
- Branch `fix-505-pool-wedge-rootcause` off `main` (which already has #501 `aa3368d3` + #502).
- Resume via `/feature-resume fix-505-pool-wedge-rootcause`.
- ARM CHECK (must pass before editing):
  `echo '{"tool_input":{"file_path":"'"$PWD"'/__arm_check__/probe.ts"}}' | bash ./.claude/hooks/edit-surface-guard.sh` → exit 2
  `echo '{}' | bash ./.claude/hooks/stop-gate.sh` → exit 2

## Read these (authoritative — by path, not restated)
- `.feature/intake.json` — locked contract (drift detector). 16-glob surface, `open_questions:[]`.
- `docs/superpowers/plans/fix-505-pool-wedge-rootcause.md` — THE PLAN (T1–T4 + OP1–OP5).
- `docs/superpowers/plans/fix-505-pool-wedge-rootcause-investigation.md` — root cause (UNPROVEN) + boot-burst evidence.
- `docs/superpowers/plans/fix-505-pool-wedge-rootcause-plan-review.md` — Codex R1 REVISE triage + verified facts.

## Locked decisions (from grill — do NOT re-litigate)
- Root-cause bar: **repro harness + hypothesis**; attempt cure if it reproduces; poller resumes behind #502 bulkhead.
- Execution: **I drive via MCP** (Railway + Supabase, staging); 24h soak is async/owner-gated.
- Reaper: **DELETE** (unreachable on Railway) + supersede ADR 0007 + #477-tied re-arm ticket; **same #505 branch, merge gated on cure validation**.
- Bulkhead: **KEEP** as defense-in-depth.
- Marker: **REMOVE** from all 6 sites; supersede ADR 0007.
- #501: **already MERGED** (backlog-depth alert on main) — no land step.

## Gate status — STEPS 4, 5, 7 COMPLETE; READY FOR STEP 6 (user) + STEP 8 (SHIP)
- Plan adversarial review: Codex R1 REVISE (7) → R2 REVISE (3) → **R3 APPROVED**. All in plan-review doc.
- User sign-off: all grill forks + surface amendment + F5 sequencing = GIVEN.
- **Step 4 EXECUTE done** — T3→T2→T1→T4 (order deviation D0), each through spec + code-quality
  review gates. Fixes F1–F4 applied. See deviations doc for the full as-built record.
- **Step 5 verify-gate GREEN** (all 14 checks, `ci:db-imports` critical). `pnpm build` clean.
- **Step 7 dual /code-review done** — Standards: 0 hard + 1 minor (`toError` dup, FIXED in `c30c8410`);
  Spec: PASS (no missing/creep/wrong; all D0-D8/F1-F4 documented). Both axes ship-ready.
- **Remaining:** Step 6 adversarial `/codex:adversarial-review` (USER-invoked, RISK=high) → Step 8 SHIP:
  push branch, OP1-OP5 staging via MCP (baseline repro → treatment zero-wedge → resume → burst drill → 24h soak),
  **PR→main gated on OP2/OP3 cure validation**. Prod env at promotion: remove `HEALTH_ALERT_POLL_INTERVAL_MS` + all `POOL_WEDGE_REAPER_*`.
- HEAD at handoff: `c30c8410`. Branch `fix-505-pool-wedge-rootcause`, 10 code/doc commits off `main` (aa3368d3).

## Step 4 (EXECUTE) — dispatch fresh per-task subagents (subagent-driven-development), TDD where specifiable
Order: **T1 harness** and **T3 reaper-delete** are independent (parallelizable); **T2 cure** code independent but validated by T1; **T4 docs** last.
Each subagent prompt MUST carry: the CONTEXT.md glossary excerpt (wedge, boot burst,
boot-readiness cure, bulkhead, reaper, genuine-direct route, backlog depth) + the
task's plan slice + blocking edges. Subagents report ≤10 lines; surprises →
`docs/superpowers/plans/fix-505-pool-wedge-rootcause-deviations.md`.
- **T1** faithful real-worker repro harness under `scripts/` (fresh process/trial, staging-only, debug-hook write trace, self-clean). Run via `tsx` — NO package.json.
- **T2** `worker/background/boot-stagger.ts` (pure `computeBootSchedule` + cancellable `staggerBoot`) + autorun:false-until-ready + Redis/BullMQ readiness await + ordered starts (`index.ts`) + shutdown cancel (`shutdown.ts`). TDD.
- **T3** delete reaper + `pool-wedge-reaper/**` + tests; remove 5 `POOL_WEDGE_REAPER_*` + `DIRECT_URL`; strip marker from 6 sites; update `closeAllPostgresClients` + `server.test.ts` + `worker.test.ts`; supersede ADR 0007; clean env-vars.md/lab-notes.md/health-db.ts/CONTEXT.md. Keep `ci:db-imports` green.
- **T4** cure ADR + CONTEXT.md glossary + resume/burst-drill runbooks + re-arm ticket draft.

## Step 5 gate → `scripts/verify-gate.sh` (backend; ci:db-imports critical). Then step 6 (adversarial /codex:adversarial-review — user-invoked, RISK=high) → step 7 dual review → step 8 SHIP (staging ride, OP1–OP5, then PR→main after cure validation; prod env removes HEALTH_ALERT_POLL_INTERVAL_MS + POOL_WEDGE_REAPER_*).

## Operational (orchestrator drives via MCP, post-code): OP1 baseline repro → OP2 treatment zero-wedge → OP3 staging resume steady-state → OP4 #480 burst drill → OP5 24h soak (async).
