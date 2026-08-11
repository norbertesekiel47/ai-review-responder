# Broader pipelining-pattern audit ticket (follow-up to #505)

**Status: FILED and PARTLY DONE — this is no longer a draft.**

- **Filed as issue #769** (2026-08-10), which is the live home for the remaining
  site-by-site sweep. Tied to map #472 alongside #474, #480, and the reaper re-arm
  ticket (`fix-505-pool-wedge-rootcause-rearm-ticket.md`).
- **Two rounds already merged**: PR #761 (admin surface) and PR #767 (owner
  dashboard). Both confirmed live on staging, then soaked — see the dated sections
  below for what was found and fixed.
- **A capacity question was split out as issue #773**: a **2-query** fan-out wedged
  during the admin soak despite being *under* the pool, which suggests concurrent
  requests sharing a Fluid Compute isolate can exceed `DB_POOL_MAX` even when each
  request stays under it. If that holds, per-request sequencing — the cure this
  whole ticket prescribes — is necessary but **not sufficient**, and the real answer
  is a pool-sizing change gated by the ADR 0009 burst drill. **Do not treat this
  ticket's fix idiom as complete until #773 is answered.**
- **Still unverified against the real pooler**: the 8-member aggregate wave
  `fetchPerLocationAggregateSlices`, because staging has no multi-location accounts.
  Details and the reproduction recipe are in
  `2026-08-10-505-wedge-soak-handoff.md` §4.

Issue #505 itself is CLOSED and should stay closed — its scope was the worker
health-poller wedge, which it cured. This document covers the same mechanism on
other surfaces.

---

## Title (draft)

Audit + verify other concurrent-query-on-shared-client sites for the #505 pipelining wedge pattern

## Background

#505 proved the RepWorth Postgres pool-wedge's root cause: `runHealthChecks`
fired 6 health-bundle queries **concurrently via `Promise.all`** on a
dedicated postgres.js client (`max:2`) over the Supabase **Supavisor
transaction pooler**. postgres.js pipelines the queries that exceed the
pool's open-connection count onto the connections that are open; a pipelined
query's response then parks server-side in `state=active,
wait_event=ClientRead` and is never read — a **permanent** connection wedge.
Full mechanism, proof, and the shipped sequential-bundle cure are documented
in `docs/adr/0008-boot-readiness-cure.md` and
`docs/superpowers/plans/fix-505-pool-wedge-rootcause-investigation.md`.

A repo-wide grep for `Promise.all` fan-outs against a shared postgres.js
client (as opposed to a per-request/per-connection client) surfaced the same
shape — multiple concurrent queries sharing one client whose pool size is
smaller than the fan-out — at roughly 15 other sites. This ticket exists to
verify each one with the same differential-repro method #505 used, and fix
any that are confirmed. It was **not** rolled into #505 because most of these
sites sit outside #505's edit surface (Vercel dashboard/admin code, not the
worker health poller) and each needs its own verification pass, not a
blanket fix.

## CRITICAL caveats — read before touching any of these

1. **These are SUSPECTS, not confirmed instances.** The proven mechanism is
   pipelining of concurrent queries onto shared connections over the
   transaction pooler — but #500's earlier isolation repro (uniform queries,
   concurrency > pool `max`) came back **clean, 21/21**. Concurrency exceeding
   pool size is *necessary* but not, by itself, shown to be *sufficient* — the
   trigger also depends on the specific query mix. Each site below must be
   verified with #505's differential-repro method (real query bundle,
   concurrent-vs-sequential-vs-one-connection-each, against the real pooler)
   before being treated as confirmed or "fixed." Do not fix by analogy alone.
2. **Vercel serverless functions are short-lived; long-lived worker paths are
   where a wedge is catastrophic.** A wedge in a Vercel dashboard/KPI/admin
   request may be masked by function teardown recycling the connection before
   anyone notices — the request completes, the lambda instance is later
   frozen or recycled, and the wedged backend eventually gets cleaned up by
   Supavisor's own idle handling for that instance's connections (unverified;
   part of what this audit should establish). By contrast, #505's wedge was
   catastrophic specifically because the **worker is long-lived** — one
   wedged slot on a small dedicated pool starves that pool permanently until
   redeploy or client-side recycle (the #500 outage). **Prioritize the worker
   fan-out sites first**; the Vercel sites are lower urgency until the
   masking hypothesis is checked.
3. **Fix idiom, once confirmed:** either run the queries **sequentially** (one
   in flight at a time on the shared client), or give each concurrent query
   **its own connection** (raise the client's `max` to cover the fan-out).
   Do not default to "just bump `max`" without checking whether sequential is
   simpler and cheap enough for the call site's latency budget — dashboard
   reads in particular may prefer the `max` bump to keep parallel latency.

## 2026-08-10 — FIRST CONFIRMED INSTANCES (admin surface), and a falsified caveat

The admin surface stopped being hypothetical. On staging the whole admin portal
went unusable: every admin **page** returned 200 headers and then never finished
streaming its body (so the browser sat on `loading.tsx` forever), while admin
**API routes** stayed healthy. `pg_stat_activity` showed the wedge signature
live — `state=active, wait_event=ClientRead` backends held for **>3 minutes**,
accumulating one per render, including `overview-service`'s businesses query and
`cost-report-service`'s byDay query. Note for future diagnosis: the page-gate
query `SELECT id, role FROM users WHERE auth_id = $1` was itself among the
wedged backends, which made the failure look like an auth problem at first.

**Caveat 2 below is CORRECTED — its mechanism is half-right, its conclusion is
wrong.** It guessed that a Vercel-side wedge "may be masked by function teardown
recycling the connection before anyone notices" and therefore deprioritized the
Vercel sites. Teardown *does* eventually reclaim these backends — a follow-up
check ~40 minutes later showed **zero** wedged connections with no intervention,
presumably once the isolates were torn down and their sockets sent FIN, giving
the ClientRead an EOF. But "eventually" is minutes, and the pool is 3. Wedges
accumulate one per render far faster than teardown returns them, so the surface
is fully down long before the self-heal arrives, and it re-wedges the moment
anyone loads the page again. Teardown is a slow janitor, not a safety net —
treat Vercel fan-out sites as first-class, not lower-urgency. The practical
consequence for triage: **the evidence is transient**, so capture
`pg_stat_activity` while the surface is actually broken; come back an hour later
and it looks clean.

Fixed in this pass (confirmed by the live staging observation above, converted to
the sequential idiom, and guarded by
`src/lib/admin/__tests__/pool-fanout-sequential.test.ts`, which asserts peak
in-flight concurrency === 1 and carries a guards-the-guard case):

- `src/lib/admin/overview-service.ts` — 7-query fan-out → sequential
- `src/lib/admin/business-detail/queries.ts` — both batches (7 and 6) → sequential
- `src/lib/admin/cost-report-service.ts` — 5-query fan-out → sequential
- `src/app/admin/overview/page.tsx`, `src/app/admin/costs/page.tsx`,
  `src/app/api/admin/costs/route.ts` — composition-level `Promise.all` → sequential

Left concurrent, deliberately, at fan-out **3 = pool 3** (one connection per
query, the proven non-wedge shape) and now annotated with their count + the limit
per item 4 below: `src/lib/admin/margin-service.ts`,
`src/lib/admin/jobs-service.ts`.

## 2026-08-10 (second pass) — owner dashboard confirmed and fixed

`src/app/api/dashboard/route.ts` passes the singleton `sql` (pool 3), not the
larger `sqlRead`, so the owner dashboard carried the same defect — in production,
not just staging. Fixed in the same sequential idiom:

- `getActiveDashboardData` (`service.ts`) — **13-member** wave (11 sql + a Redis
  marker + the reputation batch), plus the business read racing alongside it.
  This is the "~14 queries" the candidate list below describes; an `await
  Promise.all` grep misses it because it is ASSIGNED (`const settledPromise =
  Promise.allSettled([...])`) and awaited far later in the function.
- `fetchPerLocationAggregateSlices` (`aggregate-queries.ts`) — **8-member** wave.
- `fetchReputationRows` (`service.ts`) — **5-query** wave.

Waves with a real degradation contract kept their per-member settled results
through a new shared runner, `settledInOrder`
(`src/lib/shared/settled-in-order.ts`); plain awaits would have let one rejection
throw past the FATAL/degradable split. Members are THUNKS — a promise argument is
already in flight before the runner sees it.

`aggregate-service.ts`'s two waves are deliberately left concurrent: each is a
single-member `allSettled` paired with one fatal read (2 streams, under the pool).

**Sequentializing changes query dispatch order — budget for it.** Two suites had
encoded the old order and failed in ways that read like data bugs rather than
ordering bugs. Two distinct causes: (a) an `async` function member runs EAGERLY
while the array is being built, so it dispatched first and now runs in written
position; (b) a sequential wave stops front-loading its siblings, so a read on
the following line can move much earlier. Both are written up in the lab notes.

The remaining unverified suspects (past-replies, settings/locations, KPI) are
tracked in issue #769 rather than here.

## Candidate sites (from the grep sweep, 2026-07-18)

### Vercel dashboard/KPI/admin — shared `sql` client, Vercel sets `DB_POOL_MAX=3` per serverless instance (`src/lib/db/server.ts`)

- `src/lib/dashboard/service.ts:142` — `Promise.all` of ~14 queries (business
  info, review counts, velocity, ranking, recent reviews, briefs, Zernio
  connection/reconnect state, unresolved incidents, rating breakdown,
  pending, reputation).
- `src/lib/dashboard/aggregate-queries.ts:126` — multi-query `Promise.all`
  aggregate fan-out.
- `src/lib/kpi/service.ts:178` and `:283` — `[rateRows, starRows, volumeRows,
  ttrRows, trendRows] = await Promise.all([...])`, two separate call sites
  with the same 5-query shape.
- `src/lib/past-replies/load-replies.ts:92` — `[rows, orphanRows,
  gapCountRows, histCountRows, avgRows] = await Promise.all([...])`.
- `src/lib/admin/overview-service.ts:209` — multi-query `Promise.all`.
- `src/lib/admin/business-detail/queries.ts:105` and `:222` — two separate
  multi-query `Promise.all` fan-outs.
- `src/lib/admin/cost-report-service.ts:183` — `[providerRows, byBusinessRows,
  businessCountRows, dayRows, todayRows] = await Promise.all([...])` (a
  second, smaller fan-out also exists at `:309`, not separately listed here —
  same file, same client).
- `src/app/api/admin/costs/route.ts:20` — `[cost, margin] = await
  Promise.all([...])`.
- `src/app/(authenticated)/settings/locations/page.tsx:34` — `[locations,
  activeCount, archivedLocations, account] = await Promise.all([...])`.

### Worker fan-outs — shared `sql` client, worker default `DB_POOL_MAX=10`

Safe **today** (fan-out of 2, well under `max:10`), but carry a misleading
comment claiming the pool guarantees safe parallelization — the comment
should be corrected regardless of audit outcome, since it currently reads as
"parallel is always fine on the pool," which #505 disproved as a general
claim:

- `worker/jobs/publisher/load-context.ts:44` — `const [[response],
  [business]] = await Promise.all([...])`, comment: *"they run on the pool —
  not a shared transaction — so they parallelize for real."*
- `worker/jobs/publisher/ResponsePublisherWorker.ts:42` — `const [context,
  hasProviderAttempt] = await Promise.all([...])`, comment: *"run on the
  pool, so they parallelize safely."*

These two are **worker paths** (long-lived process) but are low fan-out (2
queries each, well under `max:10`) — flagged for comment correction and
lowest-priority verification, not because they're suspected of wedging today.

## What this ticket should produce

1. For each Vercel dashboard/admin site: run the #505 differential-repro
   method (real query bundle from that call site, against the real pooler,
   concurrent-vs-sequential-vs-`max`-bump) and record wedge rate.
2. For the two worker fan-out sites: correct the "parallelizes safely on the
   pool" comments to note the real constraint (fan-out must stay under the
   client's `max`, verified per #505, not "always safe on the pool"), and
   decide whether to verify them too given their worker/long-lived context.
3. For any site that reproduces a wedge: apply the fix idiom above
   (sequential or per-query connection) and add a regression test/comment
   mirroring `runHealthChecks`'s `// SEQUENTIAL, one query in flight at a
   time — do NOT re-introduce a Promise.all` guard comment.
4. For any site that comes back clean: leave it, but replace vague "runs on
   the pool" comments with an explicit statement of the fan-out count and the
   client's `max`, so a future edit that grows the fan-out past `max` is a
   visible, deliberate decision instead of a silent regression.
