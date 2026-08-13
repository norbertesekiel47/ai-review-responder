# Evidence — #773 authenticated Vercel capacity decision

Runbook: `docs/runbooks/pool-wedge-burst-drill.md` Part C

## Environment

- **Environment:** staging
- **Supabase staging:** `RepWorth-staging` / `kubdiqdhqbhwmqfditeg`
- **Supabase production:** `udeyaqnvpojbwgoaxwdg` — **NEVER touched**
- **UI:** `https://staging.repworth.net`
- **Git SHA at start:** `ee31a35d9de28c25f030a846ddab3ed073f942ec`
- **UTC start:** `2026-08-13T04:39:05Z` (preflight) / `2026-08-13T07:13:01Z` (load session)
- **UTC end:** `2026-08-13T07:57:24Z`
- **Staging deployment ID:** `dpl_285m4dNKZhRvpECh1G2G8FVC6i6p`
- **Staging deployment commit:** `343d97ac527cf18f08a98559998306e3c354607b`
- **Staging deployment state/region:** `READY` / `iad1`
- **Deployment identity re-confirmed twice mid-campaign** (07:33Z, 07:46Z):
  same `dpl_285m4dNKZhRvpECh1G2G8FVC6i6p`, `● Ready`, target `staging`, alias
  `https://staging.repworth.net`, built `2026-08-11`. **One deployment served
  the entire recorded window** — no mixed-deployment samples.
- **Authentication posture:** existing sessions only; owner lane on the owner
  session, admin lane after an explicit user-driven login boundary (MFA never
  automated). Cookies/tokens/bodies never exported or recorded.
- **Mutation posture:** no database/schema/config/flag/deployment mutation;
  read-only application requests and aggregate database observation only.

## Preflight

| Check | Result | UTC |
|---|---|---|
| Evidence file and teardown ledger opened before load | ✅ | 2026-08-13T04:39Z |
| Approved intake and three-round plan review | ✅ Round 3 APPROVED | 2026-08-13T04:27Z |
| Browser integration operational | ✅ Claude in Chrome connected (`Browser 1`, user-selected); deviation **D1** | 2026-08-13T07:15Z |
| Current owner role/session | ✅ `GET /api/dashboard?window=7d` → `200`, full body drained | 2026-08-13T07:16Z |
| Current AAL2-admin role/session | ✅ after user-driven login boundary: `GET /api/admin/flagged` → `200` (route is gated by `requireAdminWithAal2`, so `200` **is** the AAL2 proof) | 2026-08-13T07:46:02Z |
| One current staging deployment pinned | ✅ `dpl_285m4dNKZhRvpECh1G2G8FVC6i6p` | 2026-08-13T04:42Z |
| Direct observer baseline (`active_client_read=0`, total <46) | ✅ `total=17, active=0, idle=10, iit=0, active_client_read=0, oldest=0` | 2026-08-13T07:13:01Z |
| Vercel staging health baseline | ✅ no error/fatal runtime logs during `03:42:05Z`–`04:42:05Z` | 2026-08-13T04:42Z |

### Preflight verdict

**PASS.** Both role lanes were reachable; the prior run's Chrome blocker cleared.

## Continuous database observer

Single persistent direct (`:5432`) staging session, `psql … \watch 2`, running
`2026-08-13T07:16:36Z` → `07:58:16Z`, **1280 samples**, aggregates only, no query
text. Never used the transaction pooler; **no backend was ever terminated**.

| Metric | Preflight | Campaign peak | Abort threshold | Result |
|---|---:|---:|---:|---|
| Total backend sessions | 17 | **25** | 46 of 57 usable | 54% of threshold — never approached |
| `active` | 0 | 4 | — | — |
| `idle in transaction` | 0 | **0** | — | never non-zero |
| `active_client_read` | 0 | 4 | growing signature | **wedge observed twice** |
| `oldest_active_client_read_seconds` | 0 | **374.53** | ≥10s = wedge | **THRESHOLD BREACHED** |

## Measurements — owner lane (`GET /api/dashboard`)

Every request: `cache: 'no-store'`, `credentials: 'same-origin'`,
`AbortSignal.timeout`, timed `fetch()` → completed `response.text()`, body
discarded in page. Warm-ups excluded.

| Lane | Cache posture | Conc. | n | Statuses | Failures | Timeouts | min | p50 | p95 | max | UTC window |
|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
| owner-hit-c1 | Redis hit, one key, inside 45s TTL | 1 | 20 | 200×20 | 0 | 0 | 806 | 921 | 2156 | 2156 | 07:17:06.160Z–07:17:26.523Z |
| owner-hit-c4 | Redis hit, re-warmed, 10 waves of 4 | 4 | 40 | 200×40 | 0 | 0 | 764 | 962 | 1998 | 2939 | 07:17:27.286Z–07:17:42.155Z |
| owner-miss-c1 | Forced miss, 5 rounds × 4 distinct keys | 1 | 20 | 200×20 | 0 | 0 | 2732 | 3054 | 4265 | 4265 | 07:18:41Z–07:22:09Z |
| owner-miss-c4 | Forced miss, 10 waves × 4 distinct keys | 4 | 40 | 200×40 | 0 | 0 | 1195 | 3374 | 4842 | 5193 | 07:22:55Z–07:30:03Z |

**Owner totals: 120 samples, 120 × HTTP 200, 0 failures, 0 timeouts.**
Peak `oldest_active_client_read` across all owner lanes: **0.0761s** — no wedge.

Cache discipline corroborated independently: the Vercel log shows the ten
concurrency-4 waves at 07:22:55, 07:23:42, 07:24:29, 07:25:16, 07:26:03,
07:26:50, 07:27:37, 07:28:24, 07:29:11, 07:29:58Z — **47s apart, ten waves
exactly**, satisfying the 46s TTL rule. Forced-miss p50 (3054ms) is **3.3×**
cache-hit p50 (921ms), proving the miss lanes executed the real server path.

## Measurements — AAL2-admin lane (`GET /api/admin/flagged?limit=20&offset=0`)

| Lane | Conc. | n | Statuses | Failures | Timeouts | min | p50 | p95 | max | UTC window |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
| admin-c1 | 1 | 20 | 200×20 | 0 | 0 | 724 | 825 | 1130 | 1130 | 07:46:26.411Z–07:46:43.447Z |
| admin-c4 | 4 | **12 of 40 — ABORTED** | 200×10, **TIMEOUT×2** | 2 | **2** | 780 | — | — | 49959 | 07:46:44Z–07:47:37Z |

**The admin concurrency-4 lane aborted on wave 3** per the Part C stop rule
(any timeout or non-2xx). Waves 1–2 (8 requests) were clean; wave 3 returned
two `200`s and **two requests that never delivered a body**.

## THE WEDGE — reproduced, three independent corroborations

### Event 1 — during admin-c4 wave 3

| Source | Evidence |
|---|---|
| Client | 2 × `TimeoutError`, no body, elapsed 49952ms / 49959ms |
| Vercel | wave at `07:46:47.48Z`: two entries `200`, **two entries with NO status recorded** — invocations that never produced a response |
| Database | one backend `state=active, wait_event=ClientRead`, age growing monotonically |

Database series (2s samples):

```
07:46:46Z  CR=1  oldest=0.031
07:46:48Z  CR=1  oldest=0.573
07:46:50Z  CR=1  oldest=2.576
07:46:52Z  CR=1  oldest=4.574
07:46:54Z  CR=1  oldest=6.573
07:46:56Z  CR=1  oldest=8.582
07:46:58Z  CR=1  oldest=10.573   ← wedge threshold crossed
07:47:00Z  CR=1  oldest=12.575   ← second consecutive sample ≥10s
07:47:02Z  CR=1  oldest=14.576
07:47:04Z  CR=1  oldest=16.576
07:47:06Z  CR=0  oldest=0        ← self-cleared
```

### Event 2 — single concurrency-1 recovery probe re-wedged the route

One sequential request at `07:49:21Z` hung and produced a **persistent** wedge:

```
07:49:22Z  CR=1  oldest=0.530
07:50:00Z  CR=1  oldest=38.533
07:51:00Z  CR=1  oldest=98.535
07:53:00Z  CR=1  oldest=218.539
07:55:36Z  CR=1  oldest=374.535   ← PEAK
07:55:38Z  CR=0  oldest=0         ← cleared, 6m16s total
```

During the entire 6m16s wedge, **total backend sessions stayed at 21–22** and
`idle in transaction` remained 0. Server-side `statement_timeout` never fired,
which is expected: `ClientRead` is a *wait* state, not a running statement.

### What this establishes

1. **The #773 wedge is real and reproducible on the admin surface.** It is not
   an artifact of the 2026-08-10 observation.
2. **It is NOT backend capacity exhaustion.** Peak backend usage was 25 of 57
   (54% of the 46 abort threshold) and was 21–22 while wedged. ADR 0009's
   57-backend budget was never the binding constraint.
3. **The binding constraint is the per-isolate `postgres.js` pool**
   (`DB_POOL_MAX=3` on Vercel) against simultaneous in-flight queries. Once a
   slot is stuck, later requests queue behind it inside the isolate — which is
   why a **single** request at concurrency 1 (Event 2) hung while the database
   showed 21 total sessions and ample headroom.
4. **Route shape is the discriminator.** Same deployment, same isolate, minutes
   apart:
   - `/api/dashboard` — sequentialized by #761/#767/#779 — **120/120 clean at
     concurrency 4**, max ClientRead age 0.076s.
   - `/api/admin/flagged` — `listOpenFlaggedResponses`, a 2-query
     `Promise.all` — **wedged at concurrency 4**.
5. **Client-side pool damage outlives the backend signature.** Event 2's wedge
   persisted 6m16s with no load applied, consistent with the documented
   ~40-minute isolate-reap behaviour rather than any server-side timeout.

## Vercel correlation

Obtained via `vercel logs` CLI — see deviation **D3**.

| Signal | Owner window | Admin window |
|---|---|---|
| Buffer coverage | 07:21:07Z–07:32:07Z | 07:46:28Z–07:49:21Z |
| `/api/dashboard` | 98 entries, all `200` | — |
| `/api/admin/flagged` | 2 × `403` (pre-login, expected) | 95 × `200`, **1 with no status** |
| 5xx / fatal | 0 | 0 |
| Function timeouts reported | 0 | 0 (the hung invocations record **no status**, not a timeout) |
| Region | `iad1` | `iad1` |

Entries are emitted per request pair, so counts are ~2× request count.

## Recovery

| Check | Result | UTC |
|---|---|---|
| Owner-lane recovery: `active_client_read=0`, band-normal, ≥2 consecutive | ✅ 8 consecutive at `total=20, active=0, CR=0` | 07:31:34Z–07:31:48Z |
| Owner sequential full-body recheck | ✅ `200` in 4235ms | 07:32:02Z |
| Admin-lane wedge cleared | ✅ peak 374.53s → 0 | 07:55:38Z |
| Post-wedge stability, ≥2 consecutive | ✅ **18 consecutive** clean samples | 07:55:38Z–07:56:36Z |
| Admin sequential full-body recheck | ✅ `200` in 3403ms, full body | 07:56:54Z |
| Post-recheck observer clean | ✅ transient CR 0.007–0.022s only | 07:57:02Z–07:57:24Z |
| Recovery inside 45-minute bound | ✅ 6m16s | — |
| Vercel health re-read | ✅ no 5xx/fatal | 07:57Z |

**Recovery is CLOSED.** No backend was terminated at any point.

## Deviations log

- **D1 — browser integration substituted.** The plan names the *Codex* Chrome
  Extension (it was authored for a Codex session). This run used *Claude in
  Chrome* against a user-selected browser. Every stated constraint preserved:
  an existing authenticated session driven in place, no cookie/token read or
  exported, no alternate-profile scraping, no unauthenticated substitute, role
  validated by HTTP status immediately before each lane, MFA never automated.
- **D2 — per-sample client timestamps not retained.** Aggregates record lane
  start/end only. `owner-miss-c1`'s window is bounded by observed round
  boundaries; `owner-miss-c4` and both admin lanes have exact timestamps
  recovered from the Vercel log and the observer.
- **D3 — Vercel MCP unavailable.** `list_teams`, `get_deployment`, and
  `get_runtime_logs` each returned HTTP 500 for every call this session.
  Deployment identity and invocation health came from the `vercel` CLI instead.
  Consequence: the retrievable buffer is ~100 entries, so the 07:17 owner hit
  lanes fall outside Vercel-side telemetry. Client-side status/latency for those
  lanes is complete; Vercel-side corroboration for them is a **gap**, not
  substituted by latency alone.
- **D4 — edit tool.** The resume instruction specified `apply_patch`; this
  session used the harness `Write`/`Edit` tools, functionally equivalent.
- **D5 — recovery probe induced a second wedge.** The Part C recovery step
  ("one sequential full-body request per role") at 07:49:21Z itself triggered
  Event 2. This was protocol-compliant, not an extra load lane, and it produced
  the campaign's most decisive evidence: the failure reproduces at
  **concurrency 1** once an isolate pool slot is damaged. No further requests
  were sent until recovery closed.

## Teardown ledger

| Fixture or external change | Identifier | Removal / restoration | Status |
|---|---|---|---|
| Durable fixtures / remote config | none created | n/a | ✅ nothing to remove |
| Read-only observer session | single `psql \watch` | terminated at campaign end | ✅ closed |
| Browser tab | MCP tab group tab | closed at session end | ✅ closed |
| Wedged staging backends | 2 events, both self-cleared | never terminated by this run | ✅ resolved without intervention |

No database, schema, data, flag, config, or deployment mutation occurred. The
only writes were to this repository's documentation.

## Unproven paths

- [x] Existing authenticated owner session and role validated.
- [x] AAL2-admin session and role validated across an explicit user-driven login boundary.
- [x] Owner Redis-hit concurrency-1 and concurrency-4 full-body latency.
- [x] Owner forced-miss concurrency-1 and concurrency-4 pressure.
- [~] AAL2-admin concurrency-1 complete (n=20); **concurrency-4 partial (n=12 of
  40), terminated by the protocol abort.** The abort is itself the finding; the
  remaining 28 samples were deliberately not collected.
- [x] Two-second direct database correlation and post-lane recovery, both lanes.
- [x] Pre-load Vercel deployment identity and one-hour health baseline.
- [~] Exact-window Vercel invocation health — complete from 07:21:07Z onward;
  **gap** for the 07:17 owner hit lanes (D3).
- [x] One treatment selected with all alternatives dispositioned.
- [ ] **Cross-request residual risk bounded** — see the decision below. Option 1
  is explicitly NOT claimed as a complete class-wide cure.

## Treatment decision

Compared in the plan's mandated order.

### SELECTED — Option 1: reduce `listOpenFlaggedResponses` to one query in flight

Prefer a single page query carrying a window total (e.g. `COUNT(*) OVER ()`)
when its semantics remain exact; otherwise sequence the page read and the count
read.

**Why, from this campaign's evidence:**
- It targets the exact anomaly that reproduced. The plan requires this option be
  compared first for `listOpenFlaggedResponses`, and the measurement puts the
  failure precisely there.
- The discriminator is route shape, not load. The owner surface sustained
  identical concurrency-4 pressure with 120/120 clean while carrying *heavier*
  per-request work (forced-miss p50 3054ms vs admin p50 825ms). The difference
  is that the owner route was already sequentialized and the admin route was not.
- It removes the mechanism rather than raising the threshold. Halving in-flight
  demand per request (2 → 1) is the same change that made the owner route safe.

**Implementation acceptance criteria (for the separate guarded feature):**
1. `listOpenFlaggedResponses` issues at most one query in flight per request.
2. Pagination totals remain exact — no approximation of the count.
3. Re-run Part C's admin lane in full: 20 sequential + 10 waves of four, with
   60/60 `200`, zero timeouts, and no `oldest_active_client_read` above 1s.
4. The re-run must reach wave 10; a repeat abort fails the treatment.

### REJECTED — Option 2: route the surface to `sqlRead`

Not selectable on this evidence. The plan forbids choosing it merely because a
route is read-only, and requires proving the caller's injected client and peak
fan-out `<= 8`. More decisively, it does not remove the simultaneous-in-flight
shape — it moves it to a larger pool, raising the concurrency needed to wedge.
Event 2 wedged at **concurrency 1**, so a bigger pool would not have prevented it.

### REJECTED — Option 3: raise Vercel `DB_POOL_MAX`

Not ruled out by the ≥46/57 rule (peak was 25/57), but rejected on mechanism:
the wedge occurred with 21–22 backend sessions and ample headroom, so pool size
was never the binding constraint. Raising it multiplies per-isolate clients
across warm isolates against ADR 0009's ~200-client and 57-backend ceilings
while only shifting the threshold. Per the plan, non-reproduction at a higher
threshold never proves the class closed.

### REJECTED — Option 4: bounded application-level admission/queuing

The limiting shape is route-local, not aggregate. The owner surface absorbed
identical concurrency cleanly and backend usage never exceeded 54% of the abort
threshold. A global admission mechanism would be disproportionate to a
single-route defect. Reconsider only if the cross-request residual (below)
proves unbounded after Option 1 ships.

### RULED OUT — Option 5: accept residual risk

Explicitly excluded by the plan's decision rule: *"A reproduced wedge, any body
timeout, or write-pool pressure with available read-pool capacity rules out
'accept'."* This campaign produced **both** a reproduced wedge and body timeouts.

### Residual risk that Option 1 does NOT close

Option 1 is **not** a complete class-wide cure and must not be described as one.
With `DB_POOL_MAX=3`, four concurrent single-query requests sharing one Fluid
Compute isolate still present 4 in-flight queries against 3 slots — the same
demand-exceeds-pool condition, merely reached at higher concurrency. This
campaign did not measure that configuration. Bounding it is a separate,
explicitly open question and the natural next guarded feature after Option 1.

## Verdict

**PASS — campaign complete, one treatment selected, recovery closed.**

**#773 is NOT solved by this campaign.** This was a decision campaign: it
measured the two implicated surfaces, reproduced the wedge, identified the
binding constraint, and selected a treatment. The treatment is **not
implemented**, and the cross-request residual above is **not bounded**. The
issue must stay open until the Option 1 implementation lands with its Part C
re-run green and the residual is separately addressed.

---

# Addendum — Step B: Part C re-run ABOVE the pool, on the treated stack

**Date:** 2026-08-13 · **Purpose:** close the residual this campaign named but
did not measure — *"four concurrent single-query requests sharing one Fluid
Compute isolate still present 4 in-flight queries against 3 slots… This campaign
did not measure that configuration."* Run at concurrency **8 and 12**, four times
the pool.

## Stack under test

`integration/773-combined` = `main` (795bb5cb) + **#809** (739c6cd9, flagged
single-inflight) + **#810** (5e5a2e23, five admin fan-out siblings) + **step A**
(d971d43a, the admission chokepoint `src/lib/db/admission.ts`), merged as
**c030f50c** and deployed to staging.

- **Vercel:** `dpl_F7RovQ4cawMd9wrJWBiXsAmNiUrm` — READY, target `staging`, alias
  `staging.repworth.net`, functions `iad1`. **Single deployment id across every
  captured log entry — no mixed-deployment samples.**
- **Railway staging worker:** booted clean under the gate; all background loops
  started, boot readiness cure completed, **zero** admission warnings, slot
  timeouts, or reentrant bypasses.

The chokepoint bounds in-flight `sql` work per process at cap == pool, queueing
excess callers (30s deadline) instead of letting postgres.js pipeline them onto
a busy connection.

## Method

Read-only authenticated GETs from browser page context. Every request
`credentials:'include'`, `cache:'no-store'`, 15s deadline, measured from
`fetch()` through completed `response.text()`, body discarded. Owner and AAL2
admin ran in separate sessions across an explicit user-driven login boundary; MFA
was never automated. Observer: direct `:5432` staging connection
(`kubdiqdhqbhwmqfditeg`; production ref `udeyaqnvpojbwgoaxwdg` asserted absent),
2s sampling. **No backend was terminated.**

Abort criteria armed for the whole window — ClientRead age > 1s, sessions
>= 46/57, observer sample failure. **None fired.**

## Results — 520 recorded requests, zero failures

| Lane | Role | Route | Cache | Conc | n | Statuses | Timeouts | p50 | p95 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| owner-hit-c8 | owner | `/api/dashboard` | warm HIT | 8 | 80 | **200 x80** | 0 | 947 | 1308 | 2855 |
| owner-miss-c8 | owner | `/api/dashboard` | forced MISS | 8 | 80 | **200 x80** | 0 | 3606 | 4770 | 5002 |
| owner-hit-c12 | owner | `/api/dashboard` | warm HIT | 12 | 120 | **200 x120** | 0 | 891 | 1336 | 2770 |
| owner-miss-c12 | owner | `/api/dashboard` | forced MISS | 12 | 120 | **200 x120** | 0 | 3707 | 4250 | 5518 |
| admin-seq | AAL2 admin | `/api/admin/flagged` | none | 1 | 20 | **200 x20** | 0 | 851 | 1031 | 1080 |
| admin-c8 | AAL2 admin | `/api/admin/flagged` | none | 8 | 80 | **200 x80** | 0 | 964 | 1309 | 1377 |
| admin-c12 | AAL2 admin | `/api/admin/flagged` | none | 12 | 120 | **200 x120** | 0 | 863 | 1232 | 1486 |

Every lane reached its final wave. Forced-miss waves issued all four window keys
simultaneously (so no response could populate another in-flight request's entry)
with 47s+ between waves (so no key was ever reused warm).

`admin-seq` is significant on its own: established fact 5 is that **once a slot
is stuck the route fails at concurrency 1**. Twenty sequential requests at p95
1031ms is direct evidence no slot was stuck.

## Observer — 631 samples, 0 failed

| Window | Peak total | Peak active | Peak ClientRead | **Max ClientRead age** |
|---|---|---|---|---|
| preflight | 17 | 0 | 0 | 0.000s |
| owner-miss-c8 | 30 | 5 | 4 | 0.056s |
| owner-miss-c12 | 44 | 8 | 8 | **0.132s** |
| admin phase | 43 | 4 | 4 | 0.065s |
| **whole run** | **44 / 57** | 8 | 8 | **0.132s** |

Pass criterion is no `oldest_active_client_read_seconds` above **1s**; observed
maximum **0.132s**, ~8x under the line. ClientRead was continuously PRESENT at up
to 8 concurrent sessions — this is the ordinary protocol behaviour of established
fact 8, not the signature. The signature is a **growing** age, and the age never
grew.

**Recovery:** ClientRead 0, active 0, oldest age 0.000s, totals settling to 33,
sustained across 37 consecutive samples. Verified one sequential full-body
request for the currently-available role (admin, 200 in 996ms); the owner session
was no longer available because the admin login replaced it in the same origin
cookie jar, which is exactly the constraint Part C names.

## Vercel correlation

200 captured log entries across both phases: **200 x HTTP 200**, zero non-200,
zero error-level, single deployment id. The 98 `warn` entries on
`/api/admin/flagged` are the pre-existing supabase-js `getSession()` advisory,
unrelated to this work. **Zero admission-related log lines** — no
`DbSlotTimeoutError`, no reentrant-bypass warnings, on either Vercel or Railway.

## Finding — the chokepoint bounds in-flight work, NOT backend session count

Backend sessions rose from 17 to a plateau of **40–44 of 57** during the
concurrency-12 lane, ~33 of them `idle`. Two short of the abort threshold. Stated
plainly because it qualifies the result:

- The gate bounds in-flight work **per isolate**. It does not change how many
  isolates Vercel warms, and each warm isolate holds its own write-3 + read-8
  pools against the same 57-session backend — ADR 0009's arithmetic exactly.
- Concurrency-12 traffic therefore approaches the session ceiling for reasons the
  chokepoint does not address.
- This **strengthens** established fact 4: raising `DB_POOL_MAX` remains the wrong
  lever, and is now measurably worse than before — it would multiply per-isolate
  sessions against a budget already at 44/57 under this load.

## Verdict

**PASS.** 520/520 HTTP 200 with fully drained bodies, zero timeouts, every lane
reached its final wave at concurrency 8 **and** 12 on both implicated surfaces,
max ClientRead age 0.132s against a 1s bar, backend peak 44/57 below the 46 abort
line, and full recovery to the preflight band.

**What this does and does not establish.** It establishes that the treated stack
survives the specific condition this campaign left unmeasured — sustained
concurrency at 4x the pool on both routes that wedged. It does **not** establish
that the wedge class is closed by observation alone; per the campaign's own rule,
*non-reproduction alone never proves this class closed*. The load-bearing claim is
mechanical, not statistical: postgres.js pipelines only when it runs out of
connections (`handler()` → `go(busy.shift(), query)`), and the chokepoint makes
that state unreachable while it is enabled. The measurement is what shows the
mechanism holds under load without deadlocking — the risk the design actually
carried.

Residual, explicitly open: total backend sessions still scale with warm isolate
count (44/57 observed), which is a capacity question this treatment does not
address.
