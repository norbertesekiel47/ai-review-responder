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
   shape. The read pool is **code-floored at `WEDGE_SAFE_READ_MIN = 8`**
   (`readReadPoolMax()` does `Math.max(8, parsed)`), so a mis-set low env can
   never drop below the widest routed fan-out and reintroduce the wedge.
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
  budget — it is floored at 8. Crossing the ≤16-warm-isolate Vercel bound is the
  other tripwire.

## Staging calibration + capacity gate (pending)

The following are NOT measured yet — they are recorded at the ship-time staging
burst-drill gate. A future agent fills these in (do not invent them earlier):

- **`DEFAULT_POOL_SATURATING_MS` calibration** — run the warm/cold `reserve()`
  latency procedure on staging: sample `probePoolWait` latency on a warm pool and
  on a cold pool, and set the saturating threshold above warm noise but below the
  wedge onset. **Record:** warm reserve() latency samples, cold reserve() latency
  samples, the chosen calibrated `DEFAULT_POOL_SATURATING_MS`.
- **Backend-ceiling confirmation under burst** — during the #474 burst drill,
  capture `pg_stat_activity` backend-session counts (total + active + idle) and
  confirm they stay well under 57. **Record:** observed peak backend-session
  count.
- **Supavisor `pool_size`** — read it from the Supabase dashboard (not
  SQL-queryable) for both prod and staging. **Record:** the observed backend
  `pool_size`.
- **Warm Vercel isolate count** — observe how many warm isolates the 10-render
  peak actually produces (Fluid Compute packs several renders per isolate).
  **Record:** observed warm-isolate count vs the ≤16 bound.
- **Final `DB_POOL_MAX`** — the drill-proven worker pool ceiling. 20 is the
  starting value; confirm or adjust it against the recorded backend-session peak.
  **Record:** the drill-proven final `DB_POOL_MAX`.
- **Follow-up:** wire the pool-wait saturating signal into `HealthAlertPoller`
  once the threshold above is calibrated.
