# Handoff — #505 Connection wedge: what shipped, what is still unverified (2026-08-10)

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

---

## 5. Also open

- **#768** — 101 `job_outbox` rows in terminal `failed` on staging. Never
  investigated. Terminal means the watchdog will not reclaim them, so that work is
  dropped. Unknown whether prod has the same.
- **#769** — remaining #505 suspects: `past-replies/load-replies.ts:167`,
  `settings/locations/page.tsx:34`, `kpi/service.ts:209,:314` (believed safe on
  `sqlRead` `max:8` — confirm). The deciding question per site is **which client
  the caller passes**, since these are `sql`-injected domain modules.
- **#773 — cross-request concurrency, genuinely unresolved.** During the admin soak one
  wedge appeared in `listOpenFlaggedResponses`, a **2-query** fan-out that is
  *under* the pool of 3. The likely explanation is that Fluid Compute reuses an
  isolate across concurrent requests, so several requests sharing one pool can
  exceed it even when each stays under. If that holds, **per-request sequencing is
  necessary but not sufficient**, and the real fix is a capacity decision (pool
  sizing / `sqlRead` routing) gated by the ADR 0009 burst drill. It did not
  reproduce during the dashboard soak — absence is not proof.

---

## 6. Prompt for the next session

Paste this into a fresh session:

> Continue issue #769 (the #505 pipelining-wedge sweep) in the RepWorth repo.
> Read `docs/superpowers/plans/2026-08-10-505-wedge-soak-handoff.md` first — it has
> the full context; this session does not need the previous conversation.
>
> **Priority 1 — soak the aggregate wave.** `fetchPerLocationAggregateSlices`
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
> **Priority 2 — finish the #769 sweep.** For each remaining suspect
> (`past-replies/load-replies.ts:167`, `settings/locations/page.tsx:34`,
> `kpi/service.ts:209,:314`), trace which client the caller passes: fan-out > pool
> wedges, fan-out ≤ pool is the proven-safe shape. Fix with the sequential idiom (or
> `settledInOrder` where a degradation contract exists); where already safe, add a
> comment naming the fan-out count and the client's `max`. Guard with a
> peak-in-flight-concurrency === 1 test including a guards-the-guard case, and
> red-check it. Do not fix by analogy — the audit ticket is explicit that
> concurrency > pool is necessary but not sufficient.
>
> **Priority 3 — settle the cross-request question**, tracked as issue #773. If concurrent requests
> sharing a Fluid Compute isolate can exceed `DB_POOL_MAX` even when each request
> stays under it, then per-request sequencing is not a complete fix and the answer is
> a capacity change gated by the ADR 0009 burst drill. Establish this one way or the
> other before anyone concludes #505 is closed.
>
> Watch out: sequentializing a wave **changes query dispatch order** and breaks
> order-seeded fixtures with errors that read like data bugs; adding comment lines
> shifts line-anchored CI allowlist pins (`ci:static-policy`); and `fallow`'s
> unused-exports gate fires when you remove the last consumer of an export — run
> `npx fallow audit --gate new-only --fail-on-issues --base origin/main` before
> pushing.
