# #505 — pool-wedge root-cause investigation (PROVEN — pipelining over Supavisor)

Consolidated from #500's evidence trail, PR #502, ADR 0007, and a fresh boot-burst
code map (2026-07-18), then updated the same day once a second differential-repro
pass against the actual `HealthAlertPoller` code path proved the mechanism. This is
the durable on-disk record — a resumed session reads this instead of the grilling
transcript. See ADR 0008 for the shipped decision (sequential health-bundle cure,
commit a10f5eb) and the retained boot-stagger hardening.

## The wedge (established, do NOT re-walk)

A worker Postgres connection parks server-side `state=active, wait_event=ClientRead`
mid-extended-protocol on the Supabase Supavisor transaction pooler (`:6543`) — the
backend is blocked reading bytes the client never sends. No timeout heals it
(`statement_timeout` fires only during execution; `idle_timeout`/`max_lifetime`
spare busy conns). Permanent until `pg_terminate_backend` or redeploy.

- Reproduces on the **first poller cycle of a fresh container** (#500
  fresh-container soak) — originally read as boot-burst-only, but PROVEN
  (below) to recur on **every** 5-minute health cycle, boot or not; the fresh
  container just happens to hit its first health cycle early.
- Signature is **`state_change`-keyed** — `query_start` restamps each 5-min cycle,
  `state_change` does not; age filters must key on `state_change`.
- **Poison migrates**: terminate the wedged pid → another connection wedges;
  pre-restart it marched to a full-pool outage (all ~20 loops timing out).
- **Isolation repro was 21/21 CLEAN** (`.scratch/wedge-repro.ts`: same query, same
  pooler URL, `prepare:false`, bursts 6@max1 + 12@max2). ⇒ concurrent pooler
  queries ALONE do not wedge. The trigger requires the worker's full in-process
  boot state.

### Five falsified hypotheses (CLOSED — do not re-litigate) + one refined, not falsified
1. slow SQL / missing index (queries <1ms, `job_outbox`=62 rows)
2. queue-Redis IPv6 hang (`/ready` showed `queue_redis: ok, postgres: failed`)
3. boot-time-contention-only (failures recur every cycle at steady state pre-#502 —
   this observation held up and pointed at the eventual per-cycle finding below)
4. `DB_POOL_MAX` misconfig (unset, default 10)
5. prepared statements over tx-pooler (`prepare:false` is set)
6. **postgres.js pipelining through Supavisor — REFINED, NOT falsified.** The
   original isolation repro (uniform queries, concurrency > `max`) came back
   21/21 clean and was read at the time as closing this hypothesis. It did not:
   it only proved that pipelining does not wedge for an *arbitrary* uniform
   query shape. A second differential repro using the REAL 6-query
   `HealthAlertPoller` bundle reproduced the wedge 6/6 — pipelining through
   Supavisor IS the mechanism, triggered by that bundle's specific query mix,
   not by concurrency-over-`max` alone. See "Root cause (PROVEN)" below.

## Root cause (PROVEN) — Promise.all pipelining onto shared connections over Supavisor

**Confirmed mechanism:** `runHealthChecks` (`worker/background/pollers/health-alert/checks.ts`)
fired its 6 health checks **concurrently via `Promise.all`** on the dedicated
bulkhead client (`max:2`). Over the Supabase **Supavisor transaction pooler**,
postgres.js pipelines the queries that exceed the pool's actual open-connection
count onto the connections that ARE open. A pipelined query's response then
parks server-side in `state=active, wait_event=ClientRead` and is never read —
the issuing client has already moved past that logical slot. The wedge is
therefore **permanent**, and because `runHealthChecks` runs on every poll cycle,
it recurs **every 5 minutes at steady state** — this was never a boot-only
phenomenon; the boot-burst framing above was a plausible but wrong lead, not
the mechanism.

This proven mechanism accounts for all three of the hardest facts that the
boot-burst/starvation theory could not explain:
- **Permanence** — a pipelined response that's never drained doesn't clear on
  its own; only client-side FIN (recycle) or server-side kill reclaims it.
- **`state_change` fixity vs `query_start` restamp** — each 5-min cycle's
  `Promise.all` bundle restamps `query_start` on the same wedged backend
  (postgres.js keeps issuing bundle queries against the shared connection
  pool), while `state_change` stays pinned to the original park.
- **Poison migration** — killing the wedged pid frees that slot for one cycle,
  but the very next cycle re-fires the same concurrent bundle and pipelines a
  *different* shared connection into the same wedge.

**Proof — deterministic differential repro against the staging pooler:**

| Bundle | Client config | Wedge rate |
|---|---|---|
| Real 6-query `Promise.all` bundle (the actual pre-fix code) | `max:2` (production bulkhead) | **6/6** |
| Same 6 queries, run sequentially | `max:2` | **0/6** |
| Same 6 queries, `Promise.all` | `max:6` (one connection per query) | **0/6** |
| Actual fixed `runHealthChecks` (now sequential) | `max:2` | **0/6**, validated post-fix |

The observed wedge query was a health-bundle check —
`SELECT COUNT(*)::int AS count FROM job_outbox WHERE status='dispatching' …` —
parked `active/ClientRead`, aging past 3+ minutes, recurring at exactly the
5-minute health cadence.

**Honest nuance — do not overclaim.** Concurrency-exceeding-pool-size is
*necessary* for pipelining but the earlier isolation repro (uniform queries,
concurrency > `max`, 21/21 clean — hypothesis 6 above) shows it is not
*sufficient* by itself: the trigger also depends on the query mix issued by
the real bundle. State the mechanism as "pipelining of concurrent queries onto
shared connections over the tx-pooler wedges in `ClientRead`," verified on the
actual production bundle — not "any concurrent-over-max query set always
wedges." A broader audit of other concurrent-query-on-shared-client sites is
tracked separately in
`fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md`, precisely because
each candidate site needs its own differential-repro verification rather than
inheriting this proof by analogy.

Boot-burst context (still true, but now understood as a DIFFERENT, secondary
concern — Redis/DNS/BullMQ connection-open concurrency at boot, not the
Postgres wedge):
- `worker/index.ts:496-523` starts ~20 loops back-to-back after `app.listen()`,
  **none awaited**, and **each `start*()` fires its first cycle immediately**
  (`guarded-poll.ts:119 void runOnce()`; `OutboxPoller.ts:333`; `AnalyticsDispatch:202`;
  `Zernio:534`; `HealthAlert:91`). ⇒ ~18 loops issue their first query — and open
  their first pooler connection — on the same tick.
- Concurrently, `queues.ts` (31 `Queue`) + `index.ts:157-305` (24 `Worker`)
  construct at **import time**, opening dozens of Redis connections +
  `*.railway.internal` IPv6 DNS lookups in the same window.
- `withTimeout` (`with-timeout.ts:22-39`) is `Promise.race` — it **never cancels**
  the underlying query, so a stalled query leaks its pooled connection
  permanently (only client-recycle or server-kill reclaims). Shared-`sql` loops
  have NO recycle path; only HealthAlert (post-#502) and the reaper do.

**The fix precedent already exists in-tree.** `StripeLocationsReconcilePoller`
alone defers its first cycle by `INITIAL_RUN_DELAY_MS=45_000` with the comment
*"issuing its SELECT in start() lands it inside the boot connection storm."* It
dodges the boot-storm concurrency surface, but that surface is distinct from
the proven per-cycle wedge mechanism above.

## Shipped cure — sequential health-check bundle (the actual wedge cure)

`runHealthChecks` now issues its 6 checks **sequentially**, one query in flight
at a time, instead of `Promise.all` (commit a10f5eb) — this is what removes
the pipelining trigger. See ADR 0008 for the full decision record, the
differential-repro table, and the retained (secondary) boot-stagger hardening.

## Boot-stagger hardening (retained, but NOT the wedge cure)

Spread every boot-fired loop's first cycle across a bounded, jittered window so
the first-cycle pooler-connection opens don't collide simultaneously with the
Redis/DNS storm. Design: a pure `computeBootSchedule(count, opts) → number[]`
behind a thin `staggerBoot(starts, opts, scheduler)` shell, called once from
`index.ts` in place of the 20 synchronous `startX()` calls. Bounded so no health
signal is meaningfully delayed (invariant: boot incidents still page). This
hardening did NOT make steady state clean by itself — staging continued
wedging the health cycle every 5 minutes until the sequential fix above shipped
— so treat it as defensible boot-storm hardening for the Redis/DNS surface,
not as a fix for the Postgres wedge.

**Escalation levers for the boot-storm surface** (harness decides; the wedge
itself has its own escalation path via the audit ticket, not these):
- Serialized pool warm-up: open shared-pool connections one-at-a-time (letting each
  TCP+TLS+startup handshake finish) before starting DB loops.
- Boot-readiness handshake: gate DB-loop starts until the Redis/worker connection
  storm has settled (production.md handshaking-for-readiness).

## Reaper reachability (confirms delete)

`reaper-query.ts:50-52,65` correctly keys age on `state_change`. But on Railway the
genuine-direct route is unreachable (IPv4 egress → Supabase IPv6-only direct host),
so `acquireVerifiedClient` returns `transient` (`PoolWedgeReaperPoller.ts:162`) —
even ENABLED it would sit `transient` and never sweep. It has never fired live.
Architecturally unreachable on current infra ⇒ delete; re-arm tracked with #477.

## Driver facts
- `postgres` `^3.4.9` (caret, resolved 3.4.9). No custom socket/cork/debug/onnotice
  handling anywhere; no `debug` hook to trace protocol messages today.
- `BASE_POSTGRES_OPTIONS` (`server.ts:21-26`): `prepare:false`, `idle_timeout:30`,
  `max_lifetime:1800`, `connect_timeout:10`; `statement_timeout` 30_000ms.
- Shared `sql` max 10 (`DB_POOL_MAX` default); health bulkhead max 2 (#502).
