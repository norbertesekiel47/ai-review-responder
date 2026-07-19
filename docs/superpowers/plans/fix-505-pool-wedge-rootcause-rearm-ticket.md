# Draft — reaper re-arm ticket (tied to #477)

**Status: DRAFT.** This is not a live GitHub issue. It is the body to file as
a new ticket, tied to #477 (the future worker-vs-dashboard Postgres pool
split), once its precondition is met. File it under map #472 alongside #474
and #480.

---

## Title (draft)

Re-arm `PoolWedgeReaperPoller` on a genuine direct-Postgres route (blocked on #477)

## Background

Ticket #505 deleted `PoolWedgeReaperPoller.ts`, `worker/background/pollers/pool-wedge-reaper/**`
and their tests, the five `POOL_WEDGE_REAPER_*` env vars, the `DIRECT_URL`
config exposure (its sole consumer was the reaper), and the six
`/* rw-reapable */` query-comment marker sites (5× `health-alert/checks.ts` +
1× `src/lib/shared/backlog-depth.ts:37`). ADR 0007 was marked **Superseded**.

The reaper was **not** disabled-and-kept-dormant; it was removed outright,
because it is architecturally unreachable on current infrastructure:

- The reaper's safety precondition (`PoolWedgeReaperPoller.initPoolWedgeReaper`,
  now deleted) required a **runtime-verified genuinely-direct** `:5432`
  connection before it would ever run `pg_terminate_backend` — verified by
  connecting with `application_name='rw-wedge-reaper'` and confirming
  `SELECT current_setting('application_name')` echoes that value back exactly.
  Any other result (including Supavisor's flattened `'Supavisor'`) means the
  connection is pooled, not direct, and the reaper disables itself
  (previously: raises a Sentry `warning` and never sweeps).
- **Railway's outbound network is IPv4-only. Supabase's direct `:5432` host
  is IPv6-only.** The verified-direct precondition can never pass from a
  Railway-hosted worker against the current Supabase network topology. Even
  fully enabled, the reaper would sit permanently `transient` and never fire
  — it never fired live in production or staging.
- Keeping unreachable dead code "dormant" only adds maintenance burden (its
  own test suite, env vars, config surface) for a code path that provably
  cannot execute. #505 deleted it and moved the reasoning here instead.

Separately, #505 shipped the **boot-readiness cure** (ADR 0008) as a
different mitigation strategy: instead of reaping a wedge after it forms,
spread the boot-window concurrency so the leading (still-unproven) trigger
for wedge formation is reduced. The #502 client-side bulkhead (dedicated
health-check client, `max:2`, recycle-on-timeout) remains as the sole
server-side-observable self-heal.

## Why this is tied to #477, not opened standalone

#477 is the future ticket for splitting worker-vs-dashboard Postgres pool
usage. Re-arming the reaper requires the **same** underlying capability #477
needs: a connection path to Postgres that is provably *not* flattened by
Supavisor pooling — i.e. a genuine direct route, or an equivalent mechanism
that lets a worker-side process distinguish and act on its own backends from
outside the normal query path. Solving "how does a Railway-hosted process get
a genuinely direct (or equivalently attributable) Postgres connection" once,
for #477, is the natural point to also re-arm the reaper — building a
reaper-specific direct-route workaround first would duplicate that
investigation.

## Precondition to verify before re-arming

**A genuine, reachable, non-pooler path from Railway to Supabase Postgres —
or an equivalent mechanism that survives Supavisor's flattening and lets a
worker process reliably identify/terminate its own wedged backends.**
Candidates to evaluate under #477 (not pre-decided here):

- An IPv6-capable egress path from Railway (if/when Railway ships one), so
  the existing direct `:5432` host becomes reachable as originally designed.
- A Supabase-side IPv4 direct endpoint, if one becomes available (today only
  the pooler has an IPv4-reachable address from Railway).
- A different pooler mode/tenant-separation feature that preserves backend
  attribution without needing a fully direct route (see ADR 0007's
  consequence #3 — a Supavisor-level pool/tenant split is one of the
  named options).

Do **not** re-arm on the pooler itself. The whole point of the
verified-direct check (preserved below) is that reaping over the pooler
would let the reaper kill a backend that isn't provably its own.

## Knowledge to preserve and restore (do not re-derive)

**ADR 0007's core finding, still accurate and still Superseded-not-deleted:**
Supavisor flattens *every* pooled client's `application_name` to the literal
`'Supavisor'` server-side — verified on staging 2026-07-18. Backend identity
through the pooler cannot be established via `application_name`. Any future
attribution scheme (reaper or #477) must anchor on something that survives
the pooler: a query-comment marker (the pattern this codebase already used —
`/* rw-reapable */`, matched anchored via `query LIKE '/* rw-reapable */%'`,
never a bare substring match), a genuinely direct route, or a
Supavisor-level pool/tenant separation feature.

**What to restore, once the precondition is verified** (git history at the
#505 merge commit has the full deleted implementation to resurrect, not
rewrite from scratch):

- `worker/background/pollers/pool-wedge-reaper/**` (the poller + its
  `reaper-query.ts` — note its two documented postgres.js 3.4.9 terminate-query
  traps, preserved in `.claude/reference/lab-notes.md`: (1) a row-value
  `IN ${tuples}` list mis-renders — join `(pid, backend_start)` pairs via
  `unnest(${pids}::int[], ${backendStarts}::timestamptz[])` instead; (2)
  `timestamptz` decodes to a millisecond JS `Date`, truncating Postgres
  microseconds — project both timestamps as `::text` and cast back with
  `::timestamptz[]` to keep `backend_start` equality microsecond-exact).
- `worker/background/pollers/PoolWedgeReaperPoller.ts` + its `__tests__`.
  `startPoolWedgeReaperPoller` wiring back into `worker/index.ts`'s start
  list and shutdown stop list.
  The reaper closer back into `src/lib/db/server.ts`'s
  `closeAllPostgresClients` (alongside the kept `closeHealthSql`).
- All five `POOL_WEDGE_REAPER_*` env vars + the `DIRECT_URL` config exposure,
  re-added to `worker/config/worker.ts`, `worker/config/startup-assert.ts`,
  and documented in `.claude/reference/env-vars.md` (the entries were removed
  by #505, not just left undocumented — write fresh entries, don't assume the
  old ones are still accurate against whatever routing mechanism #477 lands
  on; the original `DIRECT_URL` doc claim "used for migrations" was already
  found stale/aspirational during #505's deletion — zero non-reaper consumers
  existed — so do not resurrect that claim without re-verifying it).
- The `/* rw-reapable */` marker back onto the six original query sites (5×
  `health-alert/checks.ts` + 1× `src/lib/shared/backlog-depth.ts:37`), plus
  the comment refs in `health-db.ts` and `CONTEXT.md`, plus a re-added
  `health-alert-markers.test.ts`.
- Update ADR 0007's Status back from "Superseded by #505" to "Accepted" (or
  write a new ADR that supersedes 0007 with the new route mechanism, if the
  re-arm changes how the direct-route self-check works) — whichever the
  concrete #477 design calls for.

## Verification before re-arming (do not skip)

Before flipping the reaper back on in any environment, re-run the same
runtime self-check ADR 0007 relied on: connect via the candidate route with
`application_name` set to a distinguishing value, run
`SELECT current_setting('application_name')`, and confirm it echoes back
exactly (not `'Supavisor'`) on **both** staging and production before trusting
the route in either. A route that works from a local machine or a different
network posture does not prove it works from the Railway worker's actual
egress.
