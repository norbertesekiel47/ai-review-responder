# Plan — #505 pool-wedge root-cause + boot-readiness cure + reaper deletion

Ticket #505 (map #472). Intake: `.feature/intake.json`. Hypothesis + evidence:
`fix-505-pool-wedge-rootcause-investigation.md`. Adversarial review + triage:
`fix-505-pool-wedge-rootcause-plan-review.md` (Codex R1 REVISE, incorporated below).
RISK=high, backend, no migration.

Glossary (verbatim, per CONTEXT.md + #500/#502): **wedge** (a pooler backend parked
`active/ClientRead`), **boot burst** (the ~20-loop + 30-queue/30-worker first-tick
storm at worker start), **boot-readiness cure** (NEW — await Redis/BullMQ readiness
+ hold BullMQ `autorun` until DB loops start, then strictly-monotonic staggered
DB-loop starts; add to CONTEXT.md), **bulkhead** (#502 dedicated health client +
recycle-on-timeout), **reaper** (`PoolWedgeReaperPoller`), **genuine-direct route**
(a verified non-pooler `:5432` connection), **backlog depth** (#480/#501, already on
main).

## Root cause is UNPROVEN (Codex R1/F1)

The prior "cork/uncork flush under starvation" mechanism is WRONG for postgres.js
3.4.9 (no cork/uncork; buffered single write deferred via `setImmediate`) and
doesn't explain the wedge's PERMANENCE, `state_change` fixity vs `query_start`
restamp, or poison-migration. Root cause stays a **leading candidate (boot-window
concurrency), not a proven mechanism**. T1 must instrument the actual driver
write path (`debug` hook, pre-write) and any accepted mechanism must explain
permanence + state_change fixity + migration. The cure is therefore justified as
**defensible boot-storm hardening**; a "cure" CLAIM requires T1 treatment-negative
evidence across repeated fresh boots (intake edge case).

## Modules & seams (codebase-design)

- **NEW deep module `worker/background/boot-stagger.ts`** at the boot-orchestration
  seam. Interface: pure `computeBootSchedule(count, opts) → number[]` (bounded,
  **strictly monotonic**, jittered per-loop delays) + `staggerBoot(starts, opts,
  scheduler=setTimeout) → { cancel(): void; done: Promise<void> }` (Codex F4:
  cancellable + awaitable, NOT `void`). Implementation hides delay/jitter/scheduling
  + timer bookkeeping. Pure-core + thin-shell mirrors `select-terminations.ts`.
- **Boot-readiness coordinator (Codex F3, R2-2, R2-3)** — the cure is more than
  poller stagger: BullMQ Workers autorun at module scope and run DB-backed handlers
  before pollers start. Construct workers `autorun:false`; await **bounded**
  Redis/BullMQ readiness; then `staggerBoot` the DB loops; **then, AFTER
  `staggerBoot.done`, resume the workers** (`.run()`) — worker activation is ordered
  strictly after the staggered DB-loop starts so it can't recreate a concurrent DB
  burst. Exactly-once; skipped if shutting down. Lives in `worker/index.ts` boot
  path. **One `AbortSignal` (R2-2)** spans the readiness-await + `staggerBoot` + the
  worker-resume: shutdown aborts it; every stage checks the shutting-down flag; the
  readiness listener/resources are disposed on abort so no continuation outlives
  shutdown.
- **Deepen** `src/lib/db/server.ts` `closeAllPostgresClients` — drop the reaper
  closer; keep health + shared-`sql` close order + resilience.
- **Shutdown (Codex F4, R2-2)** — `worker/shutdown.ts` `stopBackgroundLoops` aborts
  the coordinator signal FIRST (cancelling readiness-await + pending staggered starts
  + pending worker-resume), then stops loops; readiness stays false until settled.
- **Delete** `PoolWedgeReaperPoller.ts` + `pool-wedge-reaper/**` + tests; the SIX
  `/* rw-reapable */` marker sites; the marker test.
- **Untouched (kept):** the #502 HealthAlertPoller **bulkhead** + recycle.

## Tracer tickets

### T1 — Faithful boot repro harness (root-cause tracer) · blocked by: none
Boots the REAL worker, **fresh process per trial**, against the **staging** pooler
(positive staging-project match; unconditional prod REJECT) with the real 30
`Queue`/30 `Worker` constructions + actual start functions. Exposes an env toggle
for the T2 coordinator so the SAME harness runs baseline (cure off) and treatment
(cure on). Lives `scripts/`, run via `tsx` (NO package.json script). Self-cleans via
`pg_terminate_backend`.
**Characterize the wedge (R2-1)** — before self-clean, observe and log the three
persistence behaviors any mechanism must explain: (1) **permanence** — the backend
stays `active/ClientRead` after the boot window settles; (2) **state_change fixity**
— sample `pg_stat_activity` over time, confirming `query_start` restamps while
`state_change` stays pinned; (3) **migration** — terminate the wedged pid, watch a
different connection re-wedge.
**Instrument the transport (R2-1)** — the postgres.js `debug` hook fires PRE-write
(shows messages queued, not `socket.write()` completion); best-effort wrap the
connection `socket.write` to capture write-callback completion / backpressure. If
the transport mechanism stays opaque, say so — **cure validation is EMPIRICAL**
(treatment-negative across repeated fresh boots), not mechanism-based.
Acceptance: baseline reproduces + characterizes the wedge; treatment = **zero wedge
across repeated fresh boots** (not first-boot-self-healed).

### T2 — Boot-readiness cure · blocked by: T1 (validation), not code
`boot-stagger.ts` (pure `computeBootSchedule` + cancellable `staggerBoot`) +
`autorun:false`-until-ready + bounded Redis/BullMQ readiness await + ordered
DB-loop starts, wired in `index.ts`/`queues.ts`; shutdown cancels pending timers
(`shutdown.ts`). Bound: total spread ≤ ~10s; Stripe's in-`start()` 45s preserved.
Tests (TDD): `computeBootSchedule` bounded + strictly monotonic + covers `count`
(property/example); `staggerBoot` invokes each start once at its delay via injected
fake scheduler AND `cancel()` prevents un-fired starts + resolves `done`; the
coordinator resumes workers ONLY after `staggerBoot.done` (ordering, R2-3);
**abort during the readiness-await fires NO start and NO worker-resume** (R2-2)
and disposes the readiness listener. Cure-CLAIM gated on OP2. If T1 can't reproduce or treatment
still wedges → ship as hardening, say so, keep the bulkhead, escalate (`.cancel()`
client-side timeout experiment as ADDED containment).

### T3 — Reaper deletion + marker removal · blocked by: none (code); MERGE gated on OP2/OP3 (Codex F5)
Delete `PoolWedgeReaperPoller.ts`, `pool-wedge-reaper/**`, their `__tests__`; remove
`startPoolWedgeReaperPoller` wiring + the reaper closer from `closeAllPostgresClients`
(keep `closeHealthSql`); remove ALL FIVE `POOL_WEDGE_REAPER_*` env vars + `DIRECT_URL`
config exposure (sole consumer was the reaper — preserve the direct-route concept in
the re-arm ticket) from `worker/config/worker.ts` (+ `__tests__`), `startup-assert`,
`.claude/reference/{env-vars,lab-notes}.md`; remove the marker from ALL SIX query
sites (5× `health-alert/checks.ts` + 1× `src/lib/shared/backlog-depth.ts:37`) + the
comment refs (`health-db.ts`, `CONTEXT.md`) + delete `health-alert-markers.test.ts`.
Update `src/lib/db/__tests__/server.test.ts` to the new closer list, PRESERVING the
shutdown-resilience invariant. Mark **ADR 0007 Superseded** (preserve app_name-
flattening + route knowledge for #477). `ci:db-imports` stays green.
**Sequencing (F5):** code lands in-branch parallel to T2, but the PR→main merge is
gated on OP2/OP3 cure validation; if the cure FAILS, re-plan the reaper (keep
dormant). Cleaner alternative offered to the user: split the deletion into its own
small PR that merges regardless.

### T4 — Docs + operational scaffolding · blocked by: T2, T3
NEW **ADR** for the boot-readiness cure (context, decision, escalation levers, root
cause still unproven). Add `boot-readiness cure` to CONTEXT.md glossary. Runbooks:
poller-resume (remove `HEALTH_ALERT_POLL_INTERVAL_MS` staging→prod) + #480 burst-drill
procedure. Draft the **re-arm ticket** body (reaper + `DIRECT_URL` direct-route,
gated on a genuine-direct IPv4 route, tied to #477).

## Operational sequence (I drive via MCP; NOT part of the in-session Stop gate)
- **OP1** run T1 harness vs staging → baseline reproduces the wedge (+ debug-trace).
- **OP2** enable the T2 seam, re-run T1 → zero wedge across repeated fresh boots.
- **OP3** deploy branch to staging; remove `HEALTH_ALERT_POLL_INTERVAL_MS`; watch
  `pg_stat_activity` + logs for clean 5-min cycles, no bulkhead recycling.
- **OP4** #480 burst drill (backlog-depth alert already on main via #501): 1000
  synthetic ingest events/10min → drained ≤30min; alert fires ~1500 and clears.
- **OP5** 24h clean 5-min-cycle soak (async, spans sessions; owner-gated).
- **SHIP** PR #505 → main after staging validation; file the re-arm ticket; prod
  env: remove `HEALTH_ALERT_POLL_INTERVAL_MS` + all `POOL_WEDGE_REAPER_*` at
  promotion.

## Verify gate (step 5): `scripts/verify-gate.sh` — lint, typecheck, test, all ci:*
audits (**`ci:db-imports` critical** after reaper deletion). Backend-only → gate
skips `pnpm build` by convention; run it manually as insurance. Property test not
mandated (no billing/approval/escalation logic).
