# ADR 0009: Split the Postgres pool — a dedicated read bulkhead + shared-pool wait observability, sized under a measured backend ceiling

## Status

Accepted — 2026-07-20

(ADR numbers 0007 and 0008 were already taken — 0007 is the Supavisor
`application_name`-flattening finding, 0008 is the #505 boot-readiness cure — so
this pool-split work lands as 0009. It builds directly on both: 0007's
flattening result is reused below, and #505's root cause is the reason the read
bulkhead exists.)

## Context

RepWorth runs every Postgres write through one shared postgres.js client (`sql`,
`src/lib/db/server.ts`) pointed at the Supavisor transaction pooler
(`DATABASE_POOL_URL`, `:6543`). Two forces converged on this client:

1. **#505 (lab-notes 2026-07-18): fan-out > open connections wedges
   permanently.** A concurrent `Promise.all` on ONE postgres.js client over the
   Supavisor **transaction** pooler pipelines multiple queries onto shared
   backend connections and wedges PERMANENTLY in `state=active,
   wait_event=ClientRead` when the fan-out exceeds the number of open
   connections. Proven with a differential repro: a 6-query `Promise.all` on
   `max:2` wedged 6/6; the SAME 6 queries on `max:6` (one connection per query)
   wedged 0/6. A Vercel-side wedge is catastrophic — a serverless isolate has no
   recovery loop.

2. **#474 capacity burst on the worker.** The hot-four BullMQ workers all
   contend for the single shared `sql` pool, and their summed concurrency is
   ingest 5 + generate 5 + notif 4 + publish 4 = **18** (`worker/index.ts`
   ~194–236) — above the historical `max:10`. Under the #474 design burst (1000
   ingest events in 10 minutes) the pool would queue reservations, and we had no
   signal to see it happening.

Both problems are about how many connections a single pool can hand out, and we
had no instrument to observe pool contention. We also could not attribute or
segregate connections by identity: **ADR 0007** proved Supavisor flattens every
client's `application_name` to the literal `'Supavisor'` server-side, so
`application_name` cannot separate worker traffic from dashboard traffic through
the pooler.

Measured capacity (2026-07-19, via Supabase MCP — the only measured numbers in
this ADR):

- prod + staging BOTH: `max_connections = 60`, `superuser_reserved_connections =
  3`, `reserved_connections = 0` (PG17) → **57 usable backend connections**. Org
  plan = free → **Nano** compute tier (NOT inferable from `max_connections=60`,
  which is identical on Nano and Micro). Current usage is low (prod 12 total / 1
  active; staging 17 total / 1 active).
- **Four distinct limits, each of which can bind independently:** (a) the
  postgres.js client `max` — an app-side ceiling *per client*; (b) Supavisor
  "Max Clients" ≈ 200 — accepted client connections; (c) Postgres
  `max_connections=60` → 57 usable — the backend session ceiling; (d) Supavisor
  backend `pool_size` — the backend sessions Supavisor actually opens (NOT
  SQL-queryable; confirm in the Supabase dashboard at the staging gate). Backend
  sessions active OR **idle** each consume a slot.

## Decision

Split the read path onto a dedicated client, narrow what rides it to a
wedge-safe shape, and add a shared-pool wait probe — sized against the measured
ceiling above, not against an assumed one.

1. **Separate client instance, not sizing alone.** Add a dedicated `sqlRead`
   client (`src/lib/db/server.ts`) built via `createDedicatedPostgresClient`,
   with its own LOCAL pool (`DB_READ_POOL_MAX`, default 8). A heavy read wave now
   consumes `sqlRead`'s slots, not the write client's 3 Vercel slots — the write
   path can't be starved by reads. **This is LOCAL write-slot isolation, NOT
   backend isolation.** `sqlRead` shares the same `DATABASE_POOL_URL` / user / db
   / transaction-mode as `sql`, so it draws from the SAME Supavisor backend pool.
   A slow read still consumes a backend connection and DB CPU — the bulkhead
   bounds contention for local postgres.js reservation slots, nothing more. We
   state this honestly because sizing `sqlRead` as if it were backend-isolated
   would over-commit the 57-connection ceiling.

2. **Read scope narrowed to wedge-safe fan-out ≤ pool.** Only two routes ride
   `sqlRead`: `GET /api/dashboard/kpis` (a 5-query KPI wave + gate ≤ 6 peak
   concurrent) and `GET /api/dashboard/past-replies/draft-status` (peak 2
   concurrent, ≤ 4 reads/request). Every wave routed onto `sqlRead` has fan-out ≤
   its pool, so each query gets its own connection — the proven #505 non-wedge
   shape. The read pool size is **validated + clamped to the reviewed range
   `[WEDGE_SAFE_READ_MIN = 8, READ_POOL_MAX_CEILING = 8]`** (`readReadPoolMax()`):
   a mis-set LOW env can never drop below the widest routed fan-out and
   reintroduce the wedge, and an oversized HIGH env can never silently multiply
   client connections across isolates and blow the ≤16-warm-isolate budget below
   (codex adversarial #1). Out-of-range values are clamped to 8 and warn-logged;
   raising the pool is a deliberate capacity change (bump `READ_POOL_MAX_CEILING`
   + re-run the staging drill), never an unbounded env override.
   **Heavy fan-out routes STAY on the write `sql` client and are explicitly
   deferred** to the #505 Vercel pipelining audit: `src/app/api/dashboard/route.ts`
   (~14-query wave), the aggregate 8-query wave, and `agent-team`. Each needs its
   own differential repro before it moves — a Vercel wedge is catastrophic, so we
   do NOT fix-by-analogy.

3. **Pool-wait probe measures the SHARED pool, intentionally.**
   `probePoolWait(sql, …)` (`src/lib/shared/pool-wait.ts`) times how long
   `sql.reserve()` takes to hand back a connection on the shared write pool — the
   pool the workers actually contend for — and releases immediately. It is
   **single-flight over ONE outstanding reservation** globally: the latch is the
   reservation promise itself, cleared only when it SETTLES (resolve or reject),
   so repeated endpoint hits reuse the one pending `reserve()` and accumulation
   is bounded ≤ 1 (no queued reservations pile up under a wedge). On timeout,
   `timedOut:true` and `waitMs = timeoutMs` — a **CENSORED LOWER BOUND**
   (rendered `≥` downstream), never a measured value. Defaults:
   `DEFAULT_POOL_WAIT_TIMEOUT_MS = 1000` (< backlog 4s < admin 5s abort);
   `DEFAULT_POOL_SATURATING_MS = 50` is **PROVISIONAL** and must be calibrated on
   staging (warm/cold `reserve()` procedure — TO BE RECORDED). Critically, the
   app-side probe **cannot validate the Supavisor / backend ceiling** — it only
   sees local reservation latency. Only `pg_stat_activity` + the Supabase
   dashboard can confirm backend-session and `pool_size` headroom.

4. **`application_name` is NOT attribution.** `sqlRead` sets
   `application_name: 'repworth_reads'`, but ADR 0007 proved Supavisor flattens
   it to `'Supavisor'` server-side. It is kept only as harmless client intent —
   never relied on to attribute or segregate connections in `pg_stat_activity`.

5. **`DB_POOL_MAX = 20` on the Railway worker is a ceiling-aware STARTING
   value.** 20 covers the summed hot-four concurrency (18) + ~2 poller headroom;
   the `HealthAlertPoller` is already off the shared pool on its own dedicated
   `max:2` client. 18 is worker *concurrency*, NOT 18 held backend connections —
   a job holds a connection only while its transaction is active. 20 is bounded
   above by the 57-usable-connection backend ceiling and is **blessed only by the
   staging burst-drill gate**; Vercel stays at `DB_POOL_MAX=3`, code default
   stays `10`.

6. **Pool-wait ALERTING is deferred.** This ticket ships the queue-health
   payload `pool` field + the admin jobs badge (observability only).
   `HealthAlertPoller` integration (paging on sustained saturation) is a
   documented follow-up, once `DEFAULT_POOL_SATURATING_MS` is calibrated on
   staging so the threshold is real.

## Consequences

- **Positive:** the write path can't be starved by dashboard reads; the two
  read-heavy routes run in their proven non-wedge shape; we finally have a
  shared-pool contention signal (single-flight, leak-safe, censored-honest); and
  pool sizing is anchored to a *measured* 57-connection ceiling and a computed
  ≤16-warm-isolate Vercel budget rather than a guess.
- **Negative / accepted:** `sqlRead` is NOT backend isolation — a slow read
  still burns a shared backend connection + DB CPU; the bulkhead only isolates
  local postgres.js slots. The heavy fan-out routes remain on `sql` and remain a
  latent #505 risk until the Vercel pipelining audit reaches them (deferred
  deliberately — fix-by-analogy on a catastrophic wedge is worse than waiting for
  a per-route repro). The saturating threshold is provisional until calibrated,
  and the app-side probe cannot see the backend ceiling. `DB_POOL_MAX=20` is
  unproven until the staging drill.
- **Reversal / revisit trigger:** if the staging burst-drill shows the shared
  pool saturating at 20, or `pg_stat_activity` shows backend sessions approaching
  57, raise the Supabase compute tier (higher Max-Clients + `max_connections`)
  before raising `DB_POOL_MAX`. Do NOT lower `DB_READ_POOL_MAX` to reclaim
  budget — it is clamped to `[8, 8]` (raising the read pool means bumping
  `READ_POOL_MAX_CEILING` + re-running the drill, not an env tweak). Crossing the
  ≤16-warm-isolate Vercel bound is the other tripwire.

## Staging calibration + capacity gate (executed 2026-07-20 — PASS)

Ran on RepWorth-staging (Supabase ref `kubdiqdhqbhwmqfditeg`) with the feature
deployed to the `staging` branch (Railway worker `repworth-worker-staging`,
`DB_POOL_MAX=20`) and the pool-wait metric live at `/internal/queue-health`.
Execution gate satisfied: #507 24h HealthAlertPoller soak recorded PASS (~36h,
zero timeouts); `job_outbox` pending baseline = 0. Load = the #505/#474
`scripts/burst-drill-load.ts` headroom arm (1000 immediately-claimable
`stripe_subscription_mirror_sync` rows, drill-tag `pool477drill`).

- **`DEFAULT_POOL_SATURATING_MS` calibration — VALIDATED at 50ms (unchanged).**
  Warm `reserve()` latency (15 back-to-back `pool.waitMs` samples): min 0, median
  1, **p99 ≈ 3ms**, max 3. Cold (first probe after a 40s idle, past the 30s
  `idle_timeout` reap): **0ms** — the worker's ~24 continuously-active background
  loops keep the shared pool warm, so there is effectively no cold-connect
  penalty on the worker pool. The design burst induced **no queueing** (`waitMs`
  held ~1ms, `saturating:false` throughout) — a positive capacity result that
  leaves the threshold's upper bound (real-queueing onset) unconstrained by data.
  50ms is retained: ~16× above warm p99 (no false-fire under design load), so it
  trips only on genuine saturation. Promoted from "provisional" to
  "staging-validated" in `pool-wait.ts`.
- **Backend-ceiling confirmation under burst — PASS.** `pg_stat_activity`
  total backend sessions: baseline **19** (1 active, 11 idle) → under the 1000-row
  burst peaked at **~17–19** (1–2 active, 0 `idle in transaction`, ≤1 active
  `ClientRead`). Never approached the **57-usable** ceiling (peak ≈ 33% of it) and
  never approached the `DB_POOL_MAX=20` local ceiling — pool pressure is bounded by
  worker concurrency (~16–19), not backlog size. The 1000 rows held at 50 pending
  throughout (drain kept pace), self-drained to 0, `release` inventory clean (0
  residual).
- **Supavisor `pool_size`** — not read separately from the dashboard this run;
  bounded above by the observed total backend-session peak (~19), which is the
  authoritative capacity measure and sits far under 57. (Dashboard read remains a
  cheap optional confirmation; not gating.)
- **Warm Vercel isolate count** — not stress-tested in this run: the drill
  exercises the **worker** write pool, not the Vercel read routes. The ≤16-warm-
  isolate budget stays a design bound (read `sqlRead` max is clamped at 8 —
  `READ_POOL_MAX_CEILING`), not exercised here; current staging traffic is low.
- **Final `DB_POOL_MAX` = 20 (confirmed).** The recorded backend-session peak
  (~19, with the pool never queueing) shows 20 is comfortably ceiling-aware with
  large headroom; no adjustment needed. Live + healthy on Railway staging.
  **Promotion action (separate authorization):** set `DB_POOL_MAX=20` on Railway
  **prod** at merge, and read the Supavisor `pool_size` on the prod dashboard then.
- **Follow-up (unchanged):** wire the (now-calibrated) pool-wait saturating signal
  into `HealthAlertPoller` — deferred, tracked separately.
- **Follow-up (read-pool observability gap):** the pool-wait probe is wired to the
  shared **write** `sql` (`worker/index.ts` — `probePoolWait(sql, …)`), so the
  **read** pool (`sqlRead`, the Vercel-side bulkhead) has **no** saturation signal
  today. This is acceptable for v1 (the write pool is the one the workers contend
  for, and the read pool is clamped at 8 with wedge-safe per-query connections),
  but it means the very pool tied to the central Vercel-multiplication hazard
  (below) is currently unobserved. Future: also probe `sqlRead` (a second
  `getPoolWait`-style dep, or a `sqlRead` reading in the same payload) so read-pool
  wait is visible before any read route is scaled up.

## Vercel-side connection-multiplication drill (executed 2026-07-20 — PASS)

The central-hazard gap flagged in the post-drill note below was closed by a
Vercel-side load drill on the same staging stack (Supabase ref
`kubdiqdhqbhwmqfditeg`, feature deployed). This is the deferred measurement that
the worker-pool drill did not exercise.

**Method.** A bounded ramp of concurrent authenticated `GET /api/dashboard/kpis`
renders (the heavier of the two `sqlRead` routes — a multi-query per-location KPI
wave) against `https://staging.repworth.net`. One ephemeral active owner was
seeded (magic-link session minted through the app's own `/api/auth/callback`
token_hash lane; the Vercel SSO wall was passed with a Protection-Bypass-for-
Automation header, not by disabling protection) and deleted after the run — no
residual rows. Load driven from a one-off concurrent-fetch harness; backend
sessions sampled every 2 s from a **direct** (5432) connection so the sampler did
not perturb the Supavisor pool. Phases: 10 concurrent × 20 s → 20 × 20 s →
40 × 45 s.

**Vercel request health — PASS.** 1,575 requests (≈ 1.6 K invocations incl.
warm-up), **0 errors, 0 timeouts, 100 % HTTP 200** across all phases. At sustained
40-concurrent: rps ≈ 22, KPI latency p50 1.6 s / p95 3.2 s / **p99 3.5 s** — under
the 8 s `sqlRead` `statement_timeout`. Vercel Observability (all-environments,
Fluid, region iad1) corroborated: Error 0 % / Timeout 0 %, Active CPU p75 191 ms,
Memory p95 308 MB, TTFB p75 497 ms.

**The three central-hazard bounds — all PASS:**
- **Backend sessions (vs 57 usable):** baseline 8 → **peak 41 total** (40 net of
  the sampler's own connection) during the 40-concurrent phase = **≈ 70 % of 57**;
  peak `active` 12; **`idle in transaction` = 0 throughout** (no #505 wedge —
  fan-out ≤ pool held). After load stopped the count settled to a ~34 → 31
  Supavisor **warm-backend-pool** plateau that reaps over minutes (pooler keeps
  backends warm for reuse; not a leak — all `idle`).
- **Warm Vercel isolates (vs ≤ 16):** not a first-class Vercel metric, so
  **derived ≈ 4–6** from the ~32 Vercel-attributable backend sessions
  (peak 40 − ~8 baseline) at ~6–8 pooled connections per isolate — and
  **corroborated directly by Start Type = Hot 98.5 % / Cold 1.1 % / Prewarmed
  0.4 %** under the burst: Fluid served all 1.6 K requests by **reusing a small
  warm set** rather than fanning out to many isolates. Far under 16.
- **Total client connections (vs 200 Max-Clients):** at this scale Supavisor held
  ≈ 1 backend per pooled client connection (they show `idle`/`ClientRead`), so the
  client-side count ≈ the backend count — **peak ≈ 41 system-wide, Vercel share
  ≈ 32**, i.e. **~16–20 % of 200**. The ≤16-isolate × 11 arithmetic (≈ 198) is not
  reached because Fluid packing keeps the isolate count to ~4–6, not 16.

**Net.** Driving ~4× current peak dashboard traffic (40 concurrent vs ~10 today)
produced ~4–6 isolates, ~41 peak connections (70 % of the 57 backend ceiling,
~20 % of the 200 client ceiling), and zero connection-exhaustion failures. The
central hazard is now **measurement-proven**, not merely budget-bounded.

**Residual (honest) — the compound worst case is untested.** This Vercel drill ran
with a **quiet worker** (baseline 8); the earlier worker burst-drill ran with
Vercel quiet (peaked ~19). Neither exercised **both bursting simultaneously**. The
compound worst case (worker #474 burst ~19 + a 40-concurrent Vercel burst ~32, less
the ~8 shared baseline) ≈ **~52 / 57 (~91 %)** — headroom exists but is the tightest
scenario, and is precisely what the pool-wait metric surfaces and what the reversal
trigger below governs (raise the Supabase compute tier before raising `DB_POOL_MAX`
or `READ_POOL_MAX_CEILING`). At current traffic this compound scenario is far off.

## Post-drill note: what the WORKER-POOL staging drill did and did NOT prove (central-hazard scope)

> **Superseded by the Vercel-side drill above (2026-07-20 — PASS).** The gap this
> note describes is now closed; the paragraph is retained for the record.

The 2026-07-20 worker-pool drill validated the **worker write pool** at `DB_POOL_MAX=20`
(backend sessions peaked ~19 << 57; no queueing). It did **NOT** exercise the
**central hazard** — Vercel connection multiplication: each warm serverless isolate
now holds write 3 + **read 8 = 11** client connections against the shared Supavisor
backend, so the ≤16-warm-isolate budget (16 × 11 + worker 20 + health 2 ≈ 198 < 200
Max-Clients) rested on **arithmetic, not a Vercel-side load measurement**. The read
pool being **8** (the wedge-safe floor for the KPI ≤6 fan-out) rather than a #474-
style ~5 is a deliberate upward deviation that *directly* raises the per-isolate
count from 8 to 11 — i.e. the wedge-safety choice costs Vercel connection budget.
That gap has since been discharged by the Vercel-side drill above: observed
warm-isolate count ~4–6, total client connections ~41, backend sessions 41 peak,
all inside the ≤16 / 200 / 57 bounds.
