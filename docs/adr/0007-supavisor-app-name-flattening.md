# ADR 0007: Supavisor flattens client `application_name` → backend identity for reaping is a query-comment marker, not `application_name`

## Status

Superseded by #505 — 2026-07-18 (ticket #500, map #472)

> **#505:** the `PoolWedgeReaperPoller` this ADR was written for was deleted under #505 (its verified-direct precondition is architecturally unreachable from Railway's IPv4-only egress against Supabase's IPv6-only direct `:5432` host, so it never fired live; replaced by an explicit boot-readiness cure) — the app-name-flattening + genuine-direct-route reasoning below remains accurate and is preserved for a future re-arm under #477.

## Context

The pool-wedge self-heal (#500) needs to identify RepWorth's own Postgres
backends from *outside* the process: the `PoolWedgeReaperPoller` runs `SELECT …
FROM pg_stat_activity` and `pg_terminate_backend(pid)` to kill a connection
wedged in `state=active, wait_event=ClientRead`. The obvious anchor for "this is
one of ours" is `application_name`. It does not survive the pooler.

**Verified on staging 2026-07-18.** A pooler-routed connection (Supavisor
transaction pooler, `:6543`) that set a custom `PGAPPNAME` showed
`application_name='Supavisor'` server-side in `pg_stat_activity`; a direct
`:5432` psql session with `application_name=psql` showed `'psql'`. Supavisor
flattens EVERY client's `application_name` to the literal `'Supavisor'` on the
backend side. A table name is no better as an ownership proof: Vercel dashboard
reads and other worker queries hit the same tables through the same pooler and
also appear as `'Supavisor'`.

## Decision

Backend identity for reaping is a cooperative **query-comment marker**, not
`application_name`. RepWorth injects the anchored prefix `/* rw-reapable */` into
the query TEXT of any query that opts into reaping. The query text rides
verbatim through Supavisor and is exposed by `pg_stat_activity.query`, so the
marker survives the pooler and appears ONLY on queries we deliberately tag. The
reaper matches it anchored to the query prefix (`query LIKE '/* rw-reapable */%'`,
not a substring), so a marker buried in another query's string/comment can't
match. Today only the five read-only health-check queries carry it.

## Consequences

1. **You cannot identify RepWorth backends by `application_name` through the
   pooler.** Identity is the `/* rw-reapable */` marker. This is cooperative
   opt-in **SCOPE, not authentication** — the marker is forgeable and
   `LIKE`-matchable, so the honest guarantee is "the reaper never terminates an
   **unmarked** backend", NOT "never another service". Only RepWorth code injects
   it, and writes (publisher/approval/billing) are never marked — safe by
   construction, not by trust.

2. **The same flattening is REUSED as the reaper's runtime direct-route
   self-check.** The reaper must run on a genuinely-direct `:5432` connection
   (killing backends through the pooler it is meant to heal would be
   self-defeating), and a URL/host heuristic is only a weak second source of
   truth. Instead the reaper connects with `application_name='rw-wedge-reaper'`
   and runs `SELECT current_setting('application_name')`: a direct route echoes
   `'rw-wedge-reaper'` back exactly; the pooler swallows it to `'Supavisor'`.
   Only an exact echo counts as verified-direct — anything else (including
   `'Supavisor'`) means not-direct, so the reaper **disables itself and raises a
   Sentry `warning`** rather than ever run on the pooler
   (`PoolWedgeReaperPoller.initPoolWedgeReaper`). The flattening that broke
   identity is thus turned into a reliable "am I direct?" probe.

3. **Consequence for #477 (the future worker-vs-dashboard pool split).**
   Any plan to attribute or segregate connections by `application_name` through
   the Supavisor pooler will not work — every pooled backend reads back as
   `'Supavisor'`. #477 must anchor attribution on something that survives the
   pooler (a query-comment marker, a distinct direct route, or a Supavisor-level
   pool/tenant separation), not on `application_name`.
