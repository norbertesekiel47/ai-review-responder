# ADR 0008: Pool-wedge root cause (PROVEN) — sequential health-bundle cure + boot-storm hardening

## Status

Accepted — 2026-07-18 (ticket #505, map #472)

## Context

#500/#502 established that a worker Postgres connection can park server-side in
`state=active, wait_event=ClientRead` on the Supabase Supavisor transaction
pooler — a socket-level stall no server-side timeout heals (`statement_timeout`
only fires during execution; the app-level `withTimeout` races the promise, it
never cancels the underlying query or closes the socket). #502 shipped a
client-side bulkhead (dedicated health-check client, `max:2`, recycle-on-timeout)
as a fast, effective containment, and a server-side `PoolWedgeReaperPoller`
backstop that #505 found architecturally unreachable on Railway (see the
"Reaper deletion" section below) and deleted.

That left the wedge's *formation* unaddressed. The investigation trail
(`fix-505-pool-wedge-rootcause-investigation.md`) first hypothesized the **boot
burst** (~24 background loops firing their first cycle un-awaited, ~31 BullMQ
`Queue`s + ~30 `Worker`s opening Redis connections at import time, all landing
on roughly the same tick after `app.listen()`) as the leading candidate. A
clean isolation repro (21/21, uniform queries at concurrency > pool size)
showed that concurrency-over-pool-size **alone**, with a uniform query shape,
does not reproduce the wedge — ruling out "boot burst" as a *sufficient*
standalone explanation and leaving the boot-burst theory as an unproven
candidate.

**Root cause is now PROVEN.** A second differential-repro pass, run directly
against the actual `HealthAlertPoller` code path on the staging Supavisor
pooler, isolated the real mechanism: `runHealthChecks`
(`worker/background/pollers/health-alert/checks.ts`) fired its **6 health
checks concurrently via `Promise.all`** on the dedicated bulkhead client,
which is provisioned with `max:2`. Over the Supavisor **transaction pooler**,
postgres.js pipelines the queries that exceed the pool's actual connection
count onto the shared connections that are open — and a pipelined query's
response then parks server-side in `state=active, wait_event=ClientRead` and
is never read by the client, because the client that issued it has already
moved on to treat that logical connection slot as free. The result is a
**permanent** connection wedge, and because `runHealthChecks` runs on every
health cycle, the wedge recurs **every 5 minutes** — not just at boot. This
also resolves the three hardest facts from the original investigation:
permanence (the pipelined response is never drained), `state_change` fixity
vs. `query_start` restamp (each cycle's queries restamp `query_start` on the
same wedged backend while `state_change` stays pinned to the original park),
and poison migration (killing the wedged pid frees the slot, but the very
next 5-minute cycle re-fires the same concurrent bundle against a different
shared connection and wedges it in turn).

**Proof — deterministic differential repro on the staging pooler:**

| Bundle | Client config | Result |
|---|---|---|
| Real 6-query `Promise.all` bundle | `max:2` (matches production bulkhead) | **6/6 wedged** |
| Same 6 queries, run sequentially | `max:2` | **0/6 wedged** |
| Same 6 queries, concurrent `Promise.all` | `max:6` (one connection per query) | **0/6 wedged** |
| Actual (fixed) `runHealthChecks`, sequential | `max:2` | **0/6 wedged**, validated post-fix |

The observed wedge query was a health-bundle check —
`SELECT COUNT(*)::int AS count FROM job_outbox WHERE status='dispatching' …`
— parked `active/ClientRead`, aging past 3+ minutes, recurring at exactly the
5-minute health cadence.

**Honest nuance, preserved from the original investigation:**
concurrency-exceeding-pool-size is *necessary* but not, by itself,
demonstrated to be *sufficient* — #500's earlier isolation repro fired
*uniform* concurrent queries at concurrency > `max` and came back **clean**
(21/21). The proven mechanism is pipelining of concurrent queries onto shared
connections over the transaction pooler; the trigger also depends on the
query mix issued by the real bundle, not on the raw count of concurrent
queries alone. Do not read this ADR as "any `Promise.all` over `max`
wedges" — it is "this proven pipelining mechanism wedges `active/ClientRead`
over Supavisor transaction pooling," verified on the actual production query
bundle. Sites with a *different* query mix must be verified with the same
differential-repro method before being treated as confirmed instances (see
`fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md` for the follow-up
audit of other candidate sites).

**Boot-stagger targeted the wrong mechanism.** Because the wedge is
per-health-cycle, not per-boot, spreading the boot-window concurrency does
not address it: staging showed the health cycle wedging every 5 minutes at
steady state, independent of how clean the boot window was. The
boot-readiness cure documented below is retained anyway, reclassified as
**defensible boot-storm hardening** — it spreads the *separate* Redis/DNS/BullMQ
connection-open concurrency at boot, which is a legitimate (if lower-severity)
concern in its own right — but it is **not the wedge cure** and must not be
cited as one.

## Decision

### Primary fix — sequential health-check bundle (commit a10f5eb)

`runHealthChecks` now issues its 6 checks **sequentially** (one query in
flight at a time) instead of via `Promise.all`, eliminating the pipelining
that causes the wedge:

- No query is dispatched while another is outstanding on the bulkhead client,
  so nothing pipelines onto a shared connection over the transaction pooler.
- The core checks' shared-fate semantics are preserved naturally: a
  rejection from any of the 5 core checks still propagates and fails the
  cycle (sequential `await` does this automatically, same as `Promise.all`
  did), and the poller's existing `.catch` still recycles the client.
- The backlog-depth check keeps its own isolating `try/catch` — its failure
  degrades to a diagnostic warning finding instead of failing the whole
  cycle, exactly as before.
- The #502 `max:2` bulkhead is **kept** as defense-in-depth: it bounds the
  blast radius of a future accidental re-introduction of concurrency on this
  client, even though the sequential fix is what actually removes the
  pipelining trigger.
- Validated: the actual (fixed) `runHealthChecks` on `max:2` ran 0/6 wedges
  against the staging pooler, matching the sequential-bundle row of the
  differential repro above.

See the lab note in `.claude/reference/lab-notes.md` (2026-07-18 entry) for
the generalized idiom: run concurrent queries sequentially, or give each
concurrent query its own connection (`max ≥ concurrency`).

### Retained hardening — boot-readiness cure (boot-storm surface, not the wedge)

Ship a **boot-readiness cure** (`worker/background/boot-stagger.ts`, wired in
`worker/index.ts`) that spreads the boot-window concurrency instead of firing
it all on one tick. This addresses the separate BullMQ/Redis/DNS connection-open
storm at boot — defensible hardening on its own merits, precedented in-tree,
but **not** the Postgres pool-wedge cure (see Context above):

1. **BullMQ Workers are built `autorun:false`.** Construction (and the Redis
   connections it opens) is unchanged, but no `Worker` starts polling for jobs
   until explicitly resumed.
2. **Bounded, fail-open readiness await.** `awaitQueueReadiness` races one
   queue's `waitUntilReady()` against a 5s timeout. A confirmed connection, a
   timeout, or a connect error all proceed (only an abort signal stops the
   sequence) — per production.md, boot must never hang on Redis, and the
   system is already spend-safe (cost reservation precedes every LLM call), so
   proceeding on an unconfirmed connection is safe.
3. **Bounded, strictly-monotonic, jittered stagger of the DB-backed loops'
   first cycles.** `computeBootSchedule` (pure) returns `count` delays in
   `[0, totalSpreadMs]` (8s), strictly increasing with jittered gaps so
   first-cycle starts don't collide on one tick; `staggerBoot` (thin shell)
   schedules each loop's `start()` at its delay via an injectable scheduler,
   contains a synchronous throw from any one `start()` so it can't escape as a
   fatal `uncaughtException` and kill every queue/loop (F2), and exposes
   `cancel()` + an awaitable `done`.
4. **Workers resume only AFTER the stagger completes.** `runBootCoordinator`
   sequences readiness → stagger → `resumeWorkers()` (`worker.run()` for every
   autorun-deferred Worker, all at once — see Consequences).
5. **One `AbortController`, created at module load** (before signal handlers
   can fire), spans the whole sequence — readiness-await, staggered starts,
   and worker-resume. `worker/shutdown.ts`'s `stopBackgroundLoops` aborts it
   **first**, before stopping loops, so a SIGTERM arriving mid-boot cancels
   any pending continuation instead of letting it begin DB work concurrently
   with the already-running teardown (fixed as F1 after a real race was found
   in review: the controller had originally been created after
   `await app.listen()`, so a signal arriving while listen was pending saw a
   still-null controller and no-op'd).
6. **Toggle `BOOT_STAGGER_ENABLED`, default ON.** Only the exact literal
   `"false"` disables it, reverting to the pre-#505 legacy synchronous boot
   (every loop + every worker fired at once) — this is the **baseline** the T1
   repro harness (`scripts/wedge-repro.ts`) used to characterize the (separate)
   boot-burst concurrency surface.

The #502 **bulkhead is kept** as defense-in-depth: the sequential fix removes
the proven wedge trigger; the bulkhead remains the client-side self-heal for
any wedge that forms anyway (health-check client, `max:2`, recycle via
`end()` + unconditional rebuild on `withTimeout` expiry).

**Reaper deletion.** `PoolWedgeReaperPoller` (#500/#502's server-side backstop)
was deleted, not kept dormant. Its safety precondition — a runtime-verified
*genuinely direct* `:5432` route (`application_name` echoed back exactly,
proving the connection isn't flattened by Supavisor per ADR 0007) — is
architecturally unreachable from Railway: Railway's outbound network is
**IPv4-only**, Supabase's direct `:5432` host is **IPv6-only**. The reaper has
never fired live; it would sit permanently `transient` and never sweep, even
enabled. Re-arming it is gated on a genuine reachable direct route and is
deferred to a #477-tied ticket (see
`docs/superpowers/plans/fix-505-pool-wedge-rootcause-rearm-ticket.md`), which
preserves ADR 0007's app-name-flattening + genuine-direct-route knowledge.

## Escalation levers (boot-storm surface only — the wedge itself is cured)

These are held in reserve for the *boot-storm* (Redis/DNS/BullMQ
connection-open) surface the boot-readiness cure targets, not for the
Postgres wedge, which the sequential fix above already removes at its root:

- **Serialized pool warm-up** — open the shared pool's connections
  one-at-a-time at boot (letting each TCP+TLS+startup handshake finish before
  the next begins) instead of relying on stagger of the *query-issuing* side
  alone.
- **A `.cancel()`-based client-side timeout experiment**, added as
  containment alongside (not instead of) the stagger — closing the socket
  proactively on a suspiciously-long-running first query rather than waiting
  for the bulkhead's recycle path to notice.
- **Deeper boot-readiness handshaking** — gate DB-loop starts on more than
  queue-Redis readiness (e.g. an explicit "Redis+DNS storm settled" signal)
  if 8s of spread is shown to be insufficient.

For the Postgres-wedge mechanism specifically, the escalation path if a new
instance surfaces elsewhere is the audit ticket
(`fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md`): verify the
candidate site with the same differential-repro method, then apply the same
idiom (sequential, or one connection per concurrent query).

The bulkhead remains the backstop under every escalation tier — none of these
levers remove the client-side self-heal.

## Consequences

- **Positive:** the pool-wedge root cause is proven (pipelining of concurrent
  queries onto shared connections over the Supavisor transaction pooler,
  parking a query's response in `active/ClientRead` permanently) and cured at
  its source — `runHealthChecks` now runs its 6 checks sequentially,
  validated 0/6 wedges against the actual staging pooler, against a 6/6
  wedge rate for the prior concurrent bundle. A companion audit ticket
  catalogues ~15 other candidate sites with the same shape for follow-up
  verification (see `fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md`).
- **Positive (boot-storm hardening):** the boot-readiness cure still
  generalizes a pattern already proven in-tree —
  `StripeLocationsReconcilePoller`'s pre-existing `INITIAL_RUN_DELAY_MS=45_000`
  dodge — into a systematic, bounded, cancellable mechanism for every
  DB-backed loop instead of one-off per-poller delays, addressing the
  (separate, lower-severity) boot-window connection-open concurrency.
- **Negative / accepted:** the first health-alert cycle (and every other
  DB-backed loop's first cycle) can be delayed up to ~8s at boot by the
  retained boot-stagger. This is bounded by design — a real boot-time
  incident still pages within one poll interval, just not on the very first
  tick.
- **Accepted, documented so a future reader doesn't "fix" it:** worker resume
  (`resumeWorkers()`) is **not** staggered — all ~30 autorun-deferred Workers
  resume together, immediately after the DB-loop stagger completes. This is an
  intentional burst of **Railway-Redis** connection opens, not a
  **Postgres/Supavisor pooler** burst — the (now-cured) wedge surface, which
  the loop stagger already spreads regardless. Job handlers only touch
  Postgres as jobs actually arrive off the (now-spread) DB-backed loops, so
  the all-at-once worker resume does not recreate boot-window pooler
  concurrency (deviation D6).
- **Deferred:** the reaper re-arm ticket (#477-tied) stays open until a
  genuine direct IPv4 route to Supabase (or an equivalent reachable
  non-pooler path) exists. Until then the bulkhead is the only server-side
  containment beyond the sequential fix and the boot-readiness cure.
- **Operational follow-up:** `HEALTH_ALERT_POLL_INTERVAL_MS` was slowed on
  staging while the wedge was unmitigated; the sequential fix + the kept
  bulkhead make the normal 5-minute cadence safe again (poller-resume runbook,
  `docs/runbooks/beta-launch-alerting.md`).
