# ADR 0008: Boot-readiness cure for the pool-wedge — defensible hardening, root cause still unproven

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

That left the wedge's *formation* unaddressed. The evidence trail
(`fix-505-pool-wedge-rootcause-investigation.md`) narrowed the trigger to the
**boot burst**: ~24 background loops fire their first cycle immediately and
un-awaited, ~31 BullMQ `Queue`s and ~30 `Worker`s construct at import time
opening Redis connections, and none of this concurrency is spread — all of it
lands on roughly the same tick right after `app.listen()`. This boot-window
concurrency is the **leading candidate**, not a proven mechanism.

**Root cause is UNPROVEN.** The earlier "cork/uncork flush under starvation"
theory is **wrong** for `postgres` `^3.4.9`: the driver does not call
`socket.cork()/uncork()`; it buffers the full
Parse/Describe/Bind/Execute/Sync sequence into one buffer, defers small writes
via `setImmediate`, then issues a single `socket.write()`. Temporary event-loop
starvation would *delay* that `setImmediate`, not lose the write forever — so
starvation alone cannot explain the three hardest facts any accepted mechanism
must account for:

1. **Permanence** — the wedge never clears after the boot window (and the
   event loop) settles.
2. **`state_change` fixity vs `query_start` restamp** — the visible query
   restamps every health-check cycle while `state_change` stays pinned to the
   original wedge time.
3. **Poison migration** — terminating the wedged pid re-wedges a *different*
   connection, well after the boot storm has passed.

T1's clean isolation repro (21/21, same query/pooler/`prepare:false`, bursts up
to 12 concurrent) shows concurrent pooler queries *alone* do not wedge — the
trigger requires the worker's full in-process boot state. T1 also declared
transport-write instrumentation **opaque**: the postgres.js `debug` hook fires
pre-write (message queued, not `socket.write()` completion), so it cannot prove
a mechanism, and wiring a socket-write wrapper into the production DB singleton
was judged not worth the added surface for an inconclusive signal (deviation
D7). The cure is therefore justified as **defensible boot-storm hardening,
validated EMPIRICALLY** by the T1 repro harness — baseline (legacy synchronous
boot) reproduces the wedge and characterizes all three facts above; treatment
(cure on) shows **zero wedge across repeated fresh boots** — not a
proven-mechanism fix.

## Decision

Ship a **boot-readiness cure** (`worker/background/boot-stagger.ts`, wired in
`worker/index.ts`) that spreads the boot-window concurrency instead of firing
it all on one tick:

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
   repro harness (`scripts/wedge-repro.ts`) uses to reproduce the wedge for
   comparison against the treatment (cure on) run.

The #502 **bulkhead is kept** as defense-in-depth: the boot-readiness cure
addresses the leading candidate for wedge *formation*; the bulkhead remains
the client-side self-heal for a wedge that forms anyway (health-check client,
`max:2`, recycle via `end()` + unconditional rebuild on `withTimeout` expiry).

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

## Escalation levers (if the stagger proves insufficient)

Held in reserve, from the plan/investigation, in case OP2 (repeated staging
treatment runs) or the 24h soak (OP5) still shows a wedge:

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

The bulkhead remains the backstop under every escalation tier — none of these
levers remove the client-side self-heal.

## Consequences

- **Positive:** the leading candidate for wedge formation is addressed by
  hardening validated empirically (zero wedge across repeated fresh treatment
  boots in the T1 harness), without waiting on a fully proven mechanism that
  may never be cheaply provable (transport instrumentation was judged not
  worth the production intrusion for an inconclusive signal). The fix
  generalizes a pattern already proven in-tree —
  `StripeLocationsReconcilePoller`'s pre-existing `INITIAL_RUN_DELAY_MS=45_000`
  dodge — into a systematic, bounded, cancellable mechanism for every
  DB-backed loop instead of one-off per-poller delays.
- **Negative / accepted:** the first health-alert cycle (and every other
  DB-backed loop's first cycle) can be delayed up to ~8s at boot. This is
  bounded by design — a real boot-time incident still pages within one poll
  interval, just not on the very first tick.
- **Accepted, documented so a future reader doesn't "fix" it:** worker resume
  (`resumeWorkers()`) is **not** staggered — all ~30 autorun-deferred Workers
  resume together, immediately after the DB-loop stagger completes. This is an
  intentional burst of **Railway-Redis** connection opens, not a
  **Postgres/Supavisor pooler** burst — the wedge surface, which the loop
  stagger already spreads. Job handlers only touch Postgres as jobs actually
  arrive off the (now-spread) DB-backed loops, so the all-at-once worker
  resume does not recreate the boot-window pooler concurrency the cure exists
  to reduce (deviation D6).
- **Deferred:** the reaper re-arm ticket (#477-tied) stays open until a
  genuine direct IPv4 route to Supabase (or an equivalent reachable
  non-pooler path) exists. Until then the bulkhead is the only server-side
  containment beyond the boot-readiness cure.
- **Operational follow-up:** `HEALTH_ALERT_POLL_INTERVAL_MS` was slowed on
  staging while the wedge was unmitigated; the cure + the kept bulkhead make
  the normal 5-minute cadence safe again (poller-resume runbook,
  `docs/runbooks/beta-launch-alerting.md`).
