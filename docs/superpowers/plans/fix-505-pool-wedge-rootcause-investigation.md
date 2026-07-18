# #505 — pool-wedge root-cause investigation (hypothesis + evidence)

Consolidated from #500's evidence trail, PR #502, ADR 0007, and a fresh boot-burst
code map (2026-07-18). This is the durable on-disk record of the root-cause
hypothesis — a resumed session reads this instead of the grilling transcript.

## The wedge (established, do NOT re-walk)

A worker Postgres connection parks server-side `state=active, wait_event=ClientRead`
mid-extended-protocol on the Supabase Supavisor transaction pooler (`:6543`) — the
backend is blocked reading bytes the client never sends. No timeout heals it
(`statement_timeout` fires only during execution; `idle_timeout`/`max_lifetime`
spare busy conns). Permanent until `pg_terminate_backend` or redeploy.

- Forms during the **boot burst** (24 BullMQ queues + ~20 loops initializing);
  reproduces on the **first poller cycle of a fresh container**, not from runtime
  accumulation (#500 fresh-container soak).
- Signature is **`state_change`-keyed** — `query_start` restamps each 5-min cycle,
  `state_change` does not; age filters must key on `state_change`.
- **Poison migrates**: terminate the wedged pid → another connection wedges;
  pre-restart it marched to a full-pool outage (all ~20 loops timing out).
- **Isolation repro was 21/21 CLEAN** (`.scratch/wedge-repro.ts`: same query, same
  pooler URL, `prepare:false`, bursts 6@max1 + 12@max2). ⇒ concurrent pooler
  queries ALONE do not wedge. The trigger requires the worker's full in-process
  boot state.

### Six falsified hypotheses (CLOSED — do not re-litigate)
1. slow SQL / missing index (queries <1ms, `job_outbox`=62 rows)
2. queue-Redis IPv6 hang (`/ready` showed `queue_redis: ok, postgres: failed`)
3. boot-time-contention-only (failures recur every cycle at steady state pre-#502)
4. `DB_POOL_MAX` misconfig (unset, default 10)
5. prepared statements over tx-pooler (`prepare:false` is set)
6. postgres.js pipelining through Supavisor (isolation repro clean)

## Root-cause hypothesis (UNPROVEN candidate — corrected per Codex R1/F1)

**Leading candidate: something in the full-worker boot-burst concurrency leaves a
Supavisor backend parked `active/ClientRead`.** The mechanism is NOT proven.

⚠️ The earlier "cork/uncork flush under starvation" mechanism was WRONG. postgres.js
3.4.9 does NOT call `socket.cork()/uncork()` — it buffers the full
Parse/Describe/Bind/Execute/Sync into one buffer, defers small writes via
`setImmediate`, then does one `socket.write()` (`connection.js:185,246`). And
temporary event-loop starvation would DELAY the `setImmediate`, not lose it forever
— so starvation alone does NOT explain the three hardest facts, which any accepted
mechanism MUST explain:
- **Permanence** — the wedge never clears after the event loop recovers.
- **`state_change` fixity vs `query_start` restamp** — why the visible query
  restamps every 5 min while `state_change` stays pinned.
- **Poison migration** — terminating the wedged pid re-wedges a different connection
  after the boot storm has passed.

The clean isolation repro only tells us "full-worker in-process state is required,"
not that starvation is the cause. T1's job is to reproduce faithfully AND instrument
the driver write path (postgres.js `debug` hook, which fires pre-write) to actually
test a mechanism. Until then the boot-readiness cure is justified as **defensible
boot-storm hardening**, not a proven fix.

Boot-burst evidence (what IS established — the concurrency surface):
- `worker/index.ts:496-523` starts ~20 loops back-to-back after `app.listen()`,
  **none awaited**, and **each `start*()` fires its first cycle immediately**
  (`guarded-poll.ts:119 void runOnce()`; `OutboxPoller.ts:333`; `AnalyticsDispatch:202`;
  `Zernio:534`; `HealthAlert:91`). ⇒ ~18 loops issue their first query — and open
  their first pooler connection — on the same tick.
- Concurrently, `queues.ts` (31 `Queue`) + `index.ts:157-305` (24 `Worker`)
  construct at **import time**, opening dozens of Redis connections +
  `*.railway.internal` IPv6 DNS lookups in the same window.
- With `prepare:false`, postgres.js still uses the **extended protocol** (unnamed
  statements): Parse/Bind/Describe/Execute/Sync buffered into one `socket.write()`,
  small writes deferred via `setImmediate` (`connection.js:185,246`) — NO cork/uncork.
  How the boot burst turns this into a PERMANENT `active/ClientRead` park (a lost/
  half-written message, a Supavisor server-slot state, a socket-backpressure edge)
  is the open question T1's `debug`-hook trace must answer.
- `withTimeout` (`with-timeout.ts:22-39`) is `Promise.race` — it **never cancels**
  the underlying query, so a stalled first-cycle query leaks its pooled connection
  permanently (only client-recycle or server-kill reclaims). Shared-`sql` loops
  have NO recycle path; only HealthAlert (post-#502) and the reaper do.

**The fix precedent already exists in-tree.** `StripeLocationsReconcilePoller`
alone defers its first cycle by `INITIAL_RUN_DELAY_MS=45_000` with the comment
*"issuing its SELECT in start() lands it inside the boot connection storm."* It is
the only loop that dodges the storm.

## Cure candidate — bounded boot stagger

Spread every boot-fired loop's first cycle across a bounded, jittered window so the
first-cycle pooler-connection opens don't collide simultaneously with the Redis/DNS
storm. Design (see plan): a pure `computeBootSchedule(count, opts) → number[]`
behind a thin `staggerBoot(starts, opts, scheduler)` shell, called once from
`index.ts` in place of the 20 synchronous `startX()` calls. Bounded so no health
signal is meaningfully delayed (invariant: boot incidents still page).

**Escalation levers if stagger alone doesn't cure** (harness decides):
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
