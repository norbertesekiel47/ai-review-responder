# Handoff — #500 Pool-wedge self-heal

**Resume with:** `/feature-resume fix-500-pool-wedge-selfheal` **from inside the
worktree** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-500-pool-wedge-selfheal`.
Re-run the ARM CHECK first, then continue at **Step 8 (SHIP — RISK=high, staging first)**.

## Step 7 dual review: DONE — BOTH AXES CLEAN
- Spec & correctness + Standards & maintainability both returned NO HIGH-CONFIDENCE
  FINDINGS. Full reports + triage: `docs/reviews/fix-500-pool-wedge-selfheal/`
  (`spec-correctness.md`, `standards-maintainability.md`, `TRIAGE.md`). No code
  change from triage → gate stays GREEN at HEAD.

## Step 8 SHIP checklist (RISK=high → staging FIRST, then PR to main, then PAUSE for user merge)
1. **Set/confirm `DIRECT_URL`** on the Railway **staging** worker = a real direct
   `:5432` route (staging `DATABASE_URL` already is direct; reaper resolves
   `DIRECT_URL ?? DATABASE_URL`). Without it the default-ON reaper self-disables +
   Sentry-warns. Same confirmation needed on **prod** at promotion.
2. **Land branch on `staging`** (push → full stack auto-deploys; no migration —
   db_touching=false). Then **revert `HEALTH_ALERT_POLL_INTERVAL_MS`
   86400000→300000** on the Railway staging worker (ENV change).
3. **Staging tracer** (proves the fix end-to-end): open an `active+ClientRead`
   backend running a `/* rw-reapable */`-marked query on staging; assert (a) reaper
   URL routes direct (app_name echo / non-6543 port), (b) stable pid+backend_start +
   monotonic age, (c) backend DISAPPEARS after the sweep, (d) shared pool unaffected.
   Runbook: none specific yet — see the plan "Verify → Staging tracer" section.
4. **Open PR to `main`**, confirm all GitHub CI green (incl. fallow), then PAUSE for
   the user's explicit merge approval. No prod migration (db_touching=false).
5. **After merge:** `git pull --ff-only` main; `git merge --ff-only main` onto staging;
   remove worktree + delete branch; `document-feature` sweep; domain-modeling sweep
   (fold Connection wedge / Wedge reaper / rw-reapable marker terms — already in
   CONTEXT.md via T3); increment merge counter in `.claude/reference/arch-review-log.md`.
   Confirm `DIRECT_URL` genuinely direct on prod; lab-note/ADR 0007 already landed (T3).

## Step 6 adversarial review: DONE (Codex `needs-attention` → fixed)
- F1 [high] (transient boot outage permanently disabled the reaper) + F2 [medium]
  (recycled clients bypassed direct-route verification) — BOTH accepted, fixed in
  `0ad2647a`, triage recorded in `docs/superpowers/plans/fix-500-pool-wedge-selfheal-review-triage.md`.
  Fix: 3-way `acquireVerifiedClient` outcome (verified/pooler/transient); permanent
  disable only on a definitive pooler echo or absent config; transient → fail-closed
  retry on the poll cadence; recycle end+nulls so every (re)acquire re-verifies.
  Invariant strengthened to hold across the whole lifecycle. Gate GREEN post-fix.
- STILL PENDING for Step 8: the staging active+ClientRead termination tracer
  (direct routing, actual termination, reconnect, shared-pool isolation) + REVERT
  `HEALTH_ALERT_POLL_INTERVAL_MS` 86400000→300000 on the Railway staging worker.

## Status (updated 2026-07-18, step 5→6 boundary)
- Steps 0–5 DONE. Classification: **RISK=high · backend · db_touching=false ·
  SIZE=normal · ticket-seeded** (map #472 → #500).
- Intake locked + amended, plan Codex-cleared (3 rounds), **user signed off**.
- **Step 4 EXECUTE complete** — all tracers implemented + committed on branch:
  - `04625945` T0 dedicated-client factory (`createDedicatedPostgresClient`) + reaper config vars + `DIRECT_URL` + env-vars.md.
  - `2972ea1b` intake test-surface tightened to `src/lib/db/__tests__/**` + `src/lib/config/__tests__/**` (user-approved; T0 impl had widened to `src/**/__tests__/**`).
  - `43ba9e3f` T1 PoolWedgeReaperPoller (select-terminations pure fn + reaper-query + poller + worker/index.ts register).
  - `37763f08` T2 health-poller bulkhead + self-heal (health-db.ts + marker on 5 checks + recycle-on-timeout).
  - `c33ec854` closeDb integration — `closeAllPostgresClients([closeReaperClient, closeHealthSql])` in `src/lib/db/server.ts`, delegated from `worker/index.ts` closeDb (option (c): in-surface testable helper; no boot-guard / shutdown.ts edit / surface expansion — see deviations D6).
  - `8acb7dc8` T3 docs — ADR 0007, CONTEXT.md glossary, lab-notes.
  - `b08588d4` stale-comment cleanup on `closeReaperClient` (now wired) + dropped its unused-export fallow-ignore.
- **Step 5 VERIFY GATE: GREEN** — 14/14 (lint, typecheck, test, + 11 ci audits incl. db-imports, rls-audit, tenant-scope, static-policy). `.feature/gate-status.json` (gitignored) `passed:true`, newer than HEAD.
- Deviations: `docs/superpowers/plans/fix-500-pool-wedge-selfheal-deviations.md` (D1/D2 = `unnest(int[],timestamptz[])` + timestamptz-as-text vs postgres.js 3.4.9 row-value `IN` mis-render; D4/D5 = invariant-#15 builder injection into health-db; D6 = closeDb option (c)).
- **Note:** T2/integration agents' `git commit --amend` on their OWN same-session commits tripped a harness "destructive git" heuristic — verified benign via reflog (only the agent's just-created commit was rewritten; no pre-session/tracer history touched; branch unpushed).
- **Next: Step 6** — PAUSED awaiting the user to run `/codex:adversarial-review` on the branch (user-invocable only). Then Step 7 dual review, Step 8 ship via staging.

## Read these (do NOT restate — they are authoritative)
- Scope contract: `.feature/intake.json`
- Plan (tracer tickets T0–T3, seams, verify): `docs/superpowers/plans/fix-500-pool-wedge-selfheal.md`
- Glossary: `CONTEXT.md` (T3 coins *Connection wedge*, *Wedge reaper*, *rw-reapable marker*)
- Ticket: `gh issue view 500 --repo RepWorth/ai-review-responder` (+ its evidence comment)

## Verified facts (already investigated — trust, don't redo)
- **Supavisor tx-pooler flattens client `application_name` → `'Supavisor'`** server-side
  (proven on staging). So backend identity = the `/* rw-reapable */` query-comment
  marker (anchored PREFIX match), never app_name. Same flattening is reused as the
  reaper's direct-route self-check (set app_name, confirm it echoes back).
- **`DATABASE_URL` is the DIRECT :5432 connection on staging** (`<ref>.supabase.co:5432`)
  despite `env-vars.md:38` calling it "pooled". The pooler is `pooler.supabase.com:6543`
  (= `DATABASE_POOL_URL`). No `DIRECT_URL`/`STAGING_DIRECT_URL` exists yet — T0 adds
  `DIRECT_URL` (opt) to `src/lib/config/worker.ts`; reaper resolves `DIRECT_URL ?? DATABASE_URL`.
- **postgres.js 3.4.9.** API: `PendingQuery.cancel()`, `sql.reserve()/.release()`,
  `sql.end({timeout})`. `.end()` → `socket.end()` (FIN, not destroy) → EOF plausible
  not guaranteed → reaper backstops. `.cancel()` REJECTED (unproven vs socket wedge).
- **No existing `pg_terminate_backend`/`pg_stat_activity` usage in the repo** — reaper
  is new territory. OutboxPoller's "watchdog" reclaims ROWS, not backends (cadence
  precedent only).
- **`withTimeout` does not cancel work** (`src/lib/shared/with-timeout.ts:23-28`) — the
  root leak mechanism: wedged query's connection never returns to the pool.
- Sentry emit pattern: `Sentry.captureMessage(title,{level,tags,extra})`
  (`worker/background/pollers/health-alert/emit.ts`). Reaper emits its own warning
  (tag `subsystem:'pool_wedge_reaper'`), decoupled from health-alert.
- Poller wiring: `worker/index.ts` imports `{start*,stop*}` (~L14-102), `start*()`
  ~L494-519, `stop*()` ~L547-566. Shutdown: `worker/shutdown.ts` — `stopBackgroundLoops()`
  is SYNC (clearInterval); the async dedicated-client `.end()`s MUST be awaited in the
  `closeDb` dep (the awaited `db close` step, `shutdown.ts:99`), alongside `sql.end()`.
- Staging DB access: parent `.env.staging.local` → `STAGING_DATABASE_URL` (direct :5432),
  `STAGING_DATABASE_POOL_URL` (pooler :6543). For psql, strip `?pgbouncer=true` and add
  `?sslmode=require`. Role `postgres` is member of `pg_signal_backend` (can terminate).

## Locked defaults (T0 config)
`POOL_WEDGE_REAPER_ENABLED=true`, `POOL_WEDGE_REAPER_INTERVAL_MS=60000`,
`POOL_WEDGE_REAPER_AGE_S=300`, `POOL_WEDGE_REAPER_MAX_PER_SWEEP=3`,
`POOL_WEDGE_REAPER_OP_TIMEOUT_MS=8000`, `DIRECT_URL` (opt).

## Enforcement state (IMPORTANT)
- **Edit-surface guard: ARMED** (file-anchored on the edited file's repo root; blocks
  out-of-surface + wrong-checkout edits). All Edit/Write must use absolute WORKTREE
  paths. Never edit repo files via Bash (`sed -i`, `>`, `mv`).
- **Stop-gate: effectively DISARMED** under this harness — cwd resets to the parent each
  turn and `CLAUDE_PROJECT_DIR` is UNSET, so at real stop time it finds no `.feature/`.
  COMPENSATE: manually run `scripts/verify-gate.sh` and confirm green
  `.feature/gate-status.json` (newer than HEAD) before any completion claim.
- **Stale-`.feature/intake.json`-on-main gotcha:** main carries a committed
  `.feature/intake.json` from prior features; this worktree's copy was overwritten with
  #500's and committed (`cc9320d4`). Watch for it on future branches.

## Tracer tickets (blocking edges)
- **T0** (blocks T1,T2): `createDedicatedPostgresClient` factory in `src/lib/db/server.ts`
  + reaper/`DIRECT_URL` config in `src/lib/config/worker.ts` + `env-vars.md` docs.
- **T1** (⊂ T0): `worker/background/pollers/pool-wedge-reaper/{reaper-query,select-terminations}.ts`
  + `PoolWedgeReaperPoller.ts` + register in `worker/index.ts`. Tests: fast-check on
  `selectTerminations` (targets⊆input, ≤cap, oldest-first), disabled-without-verified-direct,
  already-gone-tuple tolerance.
- **T2** (⊂ T0): `worker/background/pollers/health-alert/health-db.ts` +
  `HealthAlertPoller.ts` edit + prepend `/* rw-reapable */` to the 5 queries in
  `health-alert/checks.ts`. Tests: recycle-on-timeout (unconditional rebuild), shared-pool
  isolation, marker present, `'error'` check-in preserved.
- **Integration** (⊂ T1,T2): wire `closeHealthSql()` + `closeReaperClient()` (both async)
  into `worker/index.ts` `closeDb`.
- **T3** (⊂ T1,T2, docs-exempt): `docs/adr/0007-supavisor-app-name-flattening.md`,
  `CONTEXT.md` glossary, `.claude/reference/lab-notes.md`.

## Step-8 ship reminders (RISK=high → ride staging FIRST)
- Staging tracer (proves Codex F2+F3): open an `active+ClientRead` backend running a
  `/* rw-reapable */`-marked query on staging; assert (a) reaper URL routes direct
  (app_name echo), (b) stable pid+backend_start + monotonic age, (c) backend DISAPPEARS
  after the sweep, (d) shared pool unaffected.
- **REVERT the staging mitigation** `HEALTH_ALERT_POLL_INTERVAL_MS=86400000 → 300000`
  on the Railway staging worker (ENV change, not code).
- Confirm prod has a genuinely-direct URL for the reaper (else it self-disables + alerts).
- Lab note + ADR 0007 on close.

## Codex reviewer
Same session resumable: agentId `a5f640e547aa256b1` (SendMessage) if the built code
needs another adversarial pass.
