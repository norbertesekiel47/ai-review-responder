# Deviations — #500 pool-wedge self-heal

Deviations from `fix-500-pool-wedge-selfheal.md` discovered during implementation.

## T1

### D1 — revalidating terminate uses `unnest(a::int[], b::timestamptz[])`, not a row-value `IN ${tuples}`

**Plan text:** `reaper-query.ts` → "single revalidating terminate … WHERE (pid,
backend_start) IN ${tuples} …".

**What I found (verified against postgres.js 3.4.9 offline):** postgres.js's
dynamic-value builder does **not** render a correct row-value tuple IN list.

- `(pid, backend_start) IN ${sql(tuples)}` renders `IN ($1,$2),($3,$4)` — the
  `in` builder emits the row groups **without** the outer wrap a row-value IN
  needs (`IN ((..),(..))`), producing invalid SQL.
- `(pid, backend_start) IN (${sql(tuples)})` **crashes**: the literal `(` before
  the fragment matches postgres.js's `\(`→`select` builder, which treats the
  tuples as column identifiers (`str.replace is not a function`).
- The only IN form that renders correctly is the surprising no-space `IN(${…})`
  (→ `IN(($1,$2),($3,$4))`), which a later editor adding one space would
  silently break back into the crashing `\(` path — rejected as too fragile
  (design.md: "surprising code is complexity").

**Resolution:** the terminate joins `pg_stat_activity` against the requested
tuples via `JOIN unnest(${pids}::int[], ${backendStarts}::timestamptz[]) AS
req(pid, backend_start)`. postgres.js parameterizes this cleanly
(`$1::int[], $2::timestamptz[]`), it is robust to formatting, and it preserves
the exact invariant: one atomic statement that re-checks the full wedge
signature **and** the `(pid, backend_start)` tuples, idempotent (a vanished or
mutated backend simply doesn't join → not signalled).

### D2 — `backend_start` / `state_change` are projected as TEXT

**Why:** postgres.js decodes `timestamptz` into a millisecond-precision JS
`Date`, truncating Postgres's microsecond precision. Round-tripping a captured
`backend_start` back into the revalidating terminate would then fail the
`req.backend_start = sa.backend_start` equality for any backend whose start time
has sub-millisecond microseconds — the terminate would never match. The candidate
SELECT therefore returns `backend_start::text` / `state_change::text`, and the
terminate casts the text array back with `::timestamptz[]`, preserving exact
equality. (The plan's row-value IN form would have hit the same latent bug.)

### D3 — direct-route pre-filter (host/`:6543`) omitted

The plan notes a cheap host/port pre-filter "can short-circuit" the direct-route
check. Omitted deliberately: the `application_name`-echo self-check is the
authoritative proof, and a URL-parsing heuristic would only add a second, weaker
source of truth (engineering.md: one authoritative owner per fact). No behavior
change — an unverified route still disables + Sentry-alerts.
