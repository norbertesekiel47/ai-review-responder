# Handoff — #505 Connection wedge: what shipped, what is still unverified (2026-08-10)

> **Update 2026-08-11 (#779).** The site sweep **#769 is closed** — all three
> remaining suspects were resolved against the live staging env; see §5. The same
> PR also settled #773's mechanism question **from postgres.js source**: the answer
> is **yes**, concurrent requests sharing a Fluid Compute isolate do share the pool,
> so per-request sequencing is **necessary but not sufficient**. #773 stays open as
> the capacity decision. Nothing here is a code-site sweep any more.

Written at the end of a long session. Everything below is either merged or filed.
The one open item that needs real work is **the aggregate wave**, §4.

---

## 1. What started it

The staging admin portal "loaded nothing" while **every request showed 200** and
Vercel logged zero errors. Both facts are explained by streaming: a Next.js
server component flushes headers and the `loading.tsx` skeleton immediately, so
the status is decided long before the body. A render that hangs mid-stream is a
**permanent 200 with no body**.

Root cause was the #505 **Connection wedge**: fan-out wider than the postgres.js
pool makes it pipeline the excess onto already-open connections over the Supavisor
TRANSACTION pooler; the pipelined response parks in `state=active,
wait_event=ClientRead` and is never read. `statement_timeout` can never fire —
in `ClientRead` the statement is not executing. Each render leaks a pool slot
until the pool starves. Vercel sets `DB_POOL_MAX=3`.

Diagnostic shortcuts worth reusing:

- **Discriminator:** admin *API routes* worked while admin *pages* hung. Routes
  finish their body; pages stream theirs.
- **Confirmation:** `pg_stat_activity` filtered to `state <> 'idle'` — wedged
  backends sit at `active`/`ClientRead` with a rising `now()-query_start`.
- **The evidence is TRANSIENT.** Isolate teardown eventually reclaims wedged
  backends (observed clean ~40min later, unprompted). Capture while the surface
  is actually broken; an hour later it looks fine.

---

## 2. Merged

| PR | What | Verified |
|---|---|---|
| **#761** | Admin surface: `overview-service` (7), `business-detail/queries` (7 + 6), `cost-report-service` (5), costs page/route (4) → sequential | Soaked on staging: 14/14 pages returned full bodies where 7 previously hung forever; 0 wedged |
| **#770** | 7 admin pages imported `PAGE_SIZE` from `'use client'` siblings → server got a client-reference stub bound as a SQL param | All 7 render; verified visually + by size delta (jobs 21.2KB → 74.8KB) |
| **#767** | Owner dashboard: `getActiveDashboardData` (13), `fetchPerLocationAggregateSlices` (8), `fetchReputationRows` (5) → sequential | Main wave soaked, see §3. **Aggregate wave NOT soaked, see §4** |
| **#779** | Locations settings: `settings/locations/page.tsx` (4 > pool 3) → sequential, wave extracted to `src/lib/locations/settings-view.ts` for a testable seam. Closes the #769 sweep | Pool numbers read off the live staging env, not source comments. Guard red-checked (`Promise.all` → "expected 4 to be 1") |

Shared cure: the proven #505 sequential idiom. Waves with a real degradation
contract keep per-member settled results via `src/lib/shared/settled-in-order.ts`
(members are THUNKS — a promise argument is already in flight before the runner
sees it). Sites left concurrent at fan-out 3 = pool 3 carry a comment naming both
numbers, so a future 4th query is a visible decision.

Guards, all red-checked: peak-in-flight-concurrency === 1 suites for the admin and
dashboard waves, plus a static guard against server pages importing non-component
values from client modules. Each carries a **guards-the-guard** case — without it
a silently-broken harness makes every other assertion vacuous.

---

## 3. Soak results (owner dashboard, staging `8a561201`)

| Round | Load | Result | Wedged |
|---|---|---|---|
| 1 | 4 concurrent cache misses | 4/4 · 4.0–4.4s | 0 |
| 2 | 4 concurrent misses after TTL | 4/4 · 1.4–3.3s | 0 |
| 3 | 8 concurrent (API + page renders) | all 200 | 0 |
| 4 | 12 concurrent × 2 bursts | 24/24 | 0 |

Cache misses were forced by cycling `?window=` — the key is
`dashboard:location:{id}:{window}:{rep}`, TTL 45s. Without that you measure Redis,
not the wave.

**Latency:** miss ~3.0–4.4s vs hit ~1.0–1.6s → the sequential wave costs ~2–3s,
only on a miss. Staging dataset is small; treat as indicative.

---

## 4. OPEN — the aggregate wave was never exercised against the pooler

`fetchPerLocationAggregateSlices` (`src/lib/dashboard/aggregate-queries.ts`) is an
**8-member wave** that only runs for **multi-location accounts**. Staging has
**zero** accounts with more than one active location, so it has never run against
the real Supavisor pooler — only unit tests and the concurrency guard.

It is also the most intricate of the three conversions:

- It uses `settledInOrder`, not plain awaits, because its degradation contract
  lets individual slices fail while the **baseline read stays FATAL**.
- **Dispatch order changed** and two suites had encoded the old order. Two distinct
  causes, both now documented in the fixtures and lab notes:
  1. `getPendingApprovalCountsForAccount` is an `async` function whose body ran
     **eagerly during array construction**, so it dispatched *first*; as a thunk it
     now runs last.
  2. A sequential wave **stops front-loading its siblings**, so
     `getAccountRecentReviews` (called on the next line in `aggregate-service.ts`)
     moved from 10th to 3rd.

Verifying it needs a multi-location account on staging (an admin data mutation —
not done, deliberately). See §6 for the prompt.

**#779 unblocked step 1 of that prompt.** The page an owner uses to *add* a
location was itself the wedge (fan-out 4 > pool 3), so creating the second staging
location was hazardous before that fix. It is now safe to drive.

---

## 5. Also open

- **#768** — 101 `job_outbox` rows in terminal `failed` on staging. Never
  investigated. Terminal means the watchdog will not reclaim them, so that work is
  dropped. Unknown whether prod has the same.
- **~~#769~~ — CLOSED 2026-08-11 by PR #779.** All three suspects resolved by
  tracing which client the caller actually passes, against the live staging env
  (`DB_POOL_MAX="3"`; `DB_READ_POOL_MAX` unset → `sqlRead` clamps to
  `WEDGE_SAFE_READ_MIN` = 8):

  | Site | Client | Fan-out | Pool | Verdict |
  |---|---|---|---|---|
  | `settings/locations/page.tsx:34` | `sql` singleton | 4 | 3 | **wedge — fixed** |
  | `past-replies/load-replies.ts:167` | `sql` singleton | 2 | 3 | safe — comment added |
  | `kpi/service.ts:209` | `sqlRead` | 5 | 8 | safe — comment added |
  | `kpi/service.ts:314` | `sqlRead` | 5 (+gate = 6 peak) | 8 | safe — comment added |

  The two safe sites carry comments naming the fan-out **and** the client's `max`,
  so a future extra query is a visible decision rather than a silent regression.

- **#773 — mechanism ANSWERED, capacity decision still open.** The admin-soak
  anomaly was a wedge in `listOpenFlaggedResponses`, a **2-query** fan-out that is
  *under* the pool of 3 — which the "fan-out > pool" model cannot explain. #779
  settled it **from postgres.js@3.4.9 source**, not inference: `handler()`
  (`src/index.js:329`) never queues on pool exhaustion — it falls through to
  `go(busy.shift(), query)`, pipelining onto an already-busy connection, and
  `go()` → `c.execute(q)` keeps accepting until `sent.length < max_pipeline`
  fails at **100** (`connection.js:176`). So `max` caps **TCP connections, not
  concurrency**, and `handler()` has no concept of a request. The pool is a module
  singleton and Fluid Compute reuses one isolate across concurrent requests, so
  **N requests each staying under the pool still exceed it together** (2 requests
  × 2 queries = 4 > 3).

  Consequence: **per-request sequencing is necessary but not sufficient.** #761 /
  #767 / #779 lower per-request demand to 1, which raises the bar from ≥2 to ≥4
  concurrent requests per isolate — a real risk reduction, not a closure of the
  class. What remains is a **capacity** decision (raise `DB_POOL_MAX`, route more
  reads onto `sqlRead` `max:8`, or accept + monitor), and per ADR 0009 that
  requires re-running the burst drill against the **Vercel** surface rather than
  the worker. Do not declare the #505 class closed on a green soak — the dashboard
  soak was 24/24 clean while this mechanism was live.

---

## 6. Prompt for the next session

Paste this into a fresh session:

> Finish the #505 pipelining-wedge work in the RepWorth repo. The code-site sweep
> (#769) is **closed** — what is left is one soak and one capacity decision.
> Read `docs/superpowers/plans/2026-08-10-505-wedge-soak-handoff.md` first — it has
> the full context; this session does not need the previous conversation.
>
> **Priority 1 — soak the aggregate wave** (§4; belongs to PR #767, not #769). `fetchPerLocationAggregateSlices`
> (`src/lib/dashboard/aggregate-queries.ts`, 8 members via `settledInOrder`) shipped
> in PR #767 but has **never run against the real Supavisor pooler**, because staging
> has no multi-location accounts. To verify it:
> 1. Add a second location to the staging owner account
>    (`norbertliverpool+e7@gmail.com`, account `019fd4b6-6ff1-71bb-b329-087f7077b692`)
>    via the admin UI — `MULTI_LOCATION_ENABLED=true` on staging. **Ask me before
>    mutating staging data.**
> 2. Log in as that owner and load the All-Locations aggregate view. I have to do the
>    login — do not handle credentials.
> 3. Drive concurrent cache misses by cycling `?window=` over `7d/30d/90d/12w` (key is
>    `dashboard:location:{id}:{window}:{rep}`, TTL 45s), then check
>    `pg_stat_activity` for `state='active' AND wait_event='ClientRead'` after each
>    round. Capture WHILE broken — the evidence self-heals within ~40 minutes.
> 4. Confirm correctness too, not just absence of wedges: the aggregate must still
>    degrade per-slice (one failing slice empties its column) while the **baseline
>    read stays FATAL**. Dispatch order changed in #767 — see §4.
>
> **Priority 2 — the capacity decision, issue #773.** The *mechanism* question is
> already answered (§5): concurrent requests DO share one isolate's pool, so
> per-request sequencing is necessary but not sufficient. Do not re-derive it. What
> is open is the cure — raise `DB_POOL_MAX`, route more of the read surface onto
> `sqlRead` (`max:8`), or accept the residual with monitoring. Per ADR 0009 that is
> a capacity change requiring the burst drill (`scripts/burst-drill-load.ts`,
> `docs/runbooks/pool-wedge-burst-drill.md`) to be re-run against the **Vercel**
> surface rather than the worker, and the per-isolate connection budget re-derived.
> Note isolate identity is not exposed in `pg_stat_activity` — Supavisor flattens
> `application_name` to `'Supavisor'` (ADR 0007), so attribution needs another signal.
>
> Watch out: sequentializing a wave **changes query dispatch order** and breaks
> order-seeded fixtures with errors that read like data bugs; adding comment lines
> shifts line-anchored CI allowlist pins (`ci:static-policy`); and `fallow`'s
> unused-exports gate fires when you remove the last consumer of an export — run
> `npx fallow audit --gate new-only --fail-on-issues --base origin/main` before
> pushing.
