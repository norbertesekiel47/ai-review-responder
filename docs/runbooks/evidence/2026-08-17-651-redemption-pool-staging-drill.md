# #651 Dedicated Redemption Pool — Staging Drill Evidence

**Date:** 2026-08-17  
**Reviewed artifact:** `feat/651-unsubscribe-redemption-pool` @ `8361e72b`  
**Staging Supabase:** `kubdiqdhqbhwmqfditeg`, `max_connections = 60` (57 usable)  
**Runner:** single-process. Raw tokens lived in memory only — never logged,
never written to disk, never used as a query parameter. `pg_stat_activity.query`
was never read. No backend was terminated.

**Result: PASS.** Every arm of the ADR 0009 addendum release gate ran and
passed, across three independent redemption passes and one real worker overlap.

## Deployments exercised

| Deployment | Commit | Note |
|---|---|---|
| `6e51c14a` | `8361e72b` | #651 alone — **clean, uncontaminated pass** |
| `30ee8b1b` / `ad345eec` | `ed493612` | staging merge riding #629 alongside #651 |
| (final redeploy) | `ed493612` | the captured old/new overlap |

**Confound recorded honestly.** Mid-drill, the #629 session merged its branch
into `staging`, producing `ed493612` ("merge(staging): ride #629 owner approval
lane alongside #651"). `8361e72b` is an ancestor of it, so #651 was deployed
throughout. Passes 2 and 3 therefore ran against #651 **plus** #629. Pass 1 ran
against #651 alone and is the clean result. Verified that #629 changes nothing
under `src/lib/db/`, `worker/index.ts`, or `worker/queues.ts` — no added
Postgres client, no concurrency change, no pool sizing change — so the 24-slot
capacity model in the ADR addendum is unaffected.

## Arm (a) — held-row proof: two admitted, one queued · PASS ×3

The positive proof the plan demands, replacing the rejected "fire three fast
requests" heuristic. Run three times: clean (09:11), under worker load (09:22),
post-overlap (09:33).

| Step | Observation (all three passes) |
|---|---|
| Two rows locked in direct sessions | locker PIDs recorded per pass |
| Two redemptions started against locked rows | `pg_blocking_pids` → **exactly 2** blocked request backends |
| Third distinct token started | request stayed **pending**; blocked count **stayed at 2** |
| Locks released < 15 s (deadline is 30 s) | all three → **HTTP 200** |

Latencies, pass 1 / 2 / 3 — `locked-0`: 5498 / 5361 / 5339 ms · `locked-1`:
5495 / 5362 / 5340 ms · `third-queued`: 2616 / 2495 / 2425 ms.

**Why this is the proof.** A third *blocked backend* would mean the third
request reached the raw pool. It never appeared in any pass. The third request
waited at the two-slot `withAdmissionControl` gate on `sqlUnsubscribe` and
completed only once a slot freed. This is also the empirical confirmation that
`DB_ADMISSION_ENABLED` is active on the deployed worker: with the kill switch
off, the third request would have pipelined onto a busy connection and appeared
as a third blocked backend.

## Arm (b) — same-token replay · PASS ×3

| Concurrency | Pass 1 | Pass 2 | Pass 3 |
|---|---|---|---|
| 2 | 2/2 · 253 ms | 2/2 · 242 ms | 2/2 · 201 ms |
| 8 | 8/8 · 258 ms | 8/8 · 263 ms | 8/8 · 210 ms |
| 32 | 32/32 · 287 ms | 32/32 · 287 ms | 32/32 · 217 ms |

All HTTP 200. Zero failures, zero timeouts. #644's per-token single-flight still
collapses replays to one transaction on the dedicated client.

## Arm (c) — 1,000-row worker headroom arm · PASS

`scripts/burst-drill-load.ts inject`, tags `drill651-compound` (1,000 events /
3 min) and `drill651-overlap` (800 events / 3 min). Unrelated shared-pool writes
were active throughout passes 2 and 3 and across the overlap. Total 1,800 rows,
all drained to `completed`.

## Arm (e) — real two-worker rolling overlap · PASS

Redeploy triggered via `railway redeploy` (same git artifact, not a tarball
upload), sampled every ~4 s from the trigger. Worker restart captured at
**02:28:36** — uptime reset 287 s → 10 s.

| Signal through the overlap | Observation |
|---|---|
| Unrelated outbox drain | **continued without interruption** across the restart: 1685 → 1709 → 1731 → 1759 → 1781 completed |
| Backend sessions | 12 → 11 → 10; never above 12 |
| `ClientRead` count | 0 for the great majority of samples |
| Oldest `ClientRead` age | max **0.019 s** |
| Worker health | never unreachable; no `DOWN` sample |

An earlier redeploy was triggered but its transition completed before sampling
began (uptime climbed 82 → 217 with no reset), so it is **not** counted as the
overlap arm. The arm above is the one that captured the reset.

## Gate thresholds

| Signal | Peak observed | Abort threshold | Verdict |
|---|---|---|---|
| Backend sessions | **14 / 57** | ≥ 46 | PASS |
| Oldest `ClientRead` age | **0.019 s** | growing > 1 s | PASS |
| Redemption failures / timeouts | **0** | any | PASS |
| Outbox drain through overlap | continuous | must continue | PASS |
| Residual drill rows | **0** | any | PASS |

Control: a forged token returned **503 at the HMAC gate** in every pass and
opened no connection, confirming the §1.4a gate still precedes all database work.

## Cleanup

Per pass, by drill tag only: 4 `solicitation_unsubscribe_tokens` + 4
`solicitation_suppressions` rows deleted, residual verified zero. Burst rows
released by tag; harness inventory reported clean for both tags. Final state:
1,800 drill outbox rows `completed`, **0** non-completed, **0** residual tokens
or suppressions, 10/57 sessions.

## Arm not run

**Authenticated Vercel dashboard pressure arm at concurrency 40.** Not executed —
it requires a staging owner session this run did not hold. Consequence: the
Vercel half of the compound Max-Clients case (13-isolate rollout bound,
`48 + 13×11 = 191`) is **unmeasured**. It remains arithmetic, as the ADR
addendum itself states. The worker half was measured and stayed at 14/57 against
a 46 abort line — 32 sessions of headroom — so the untested Vercel multiplication
would need to add more than 30 concurrent backend sessions to approach the
threshold.

## Operational papercut found (not #651's scope)

`scripts/burst-drill-load.ts` imports `src/lib/db/server`, which constructs
`supabaseServer` at module load. It therefore needs `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` in addition to the documented `DATABASE_POOL_URL`, and
fails with a bare `supabaseUrl is required.` when they are absent. Separately,
`STAGING_SUPABASE_URL` is **empty** in `.env.staging.local` — the live value is
in `STAGING_NEXT_PUBLIC_SUPABASE_URL`. Worth a follow-up ticket.
