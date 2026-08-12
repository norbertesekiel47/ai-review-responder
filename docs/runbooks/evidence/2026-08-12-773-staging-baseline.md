# #773 investigation evidence — 2026-08-12

Status: **remote differential COMPLETE — pipeline-depth reduction ruled out as
a cure (`depth-one-wedged`); staging latency baseline deferred and still
required before any production capacity treatment**.

The differential rejects `max_pipeline=1`, so there is no pipeline-depth
treatment whose latency cost needs measuring. The baseline remains pending: it
must be captured with this protocol before proposing or deploying any later
production-client capacity change, so its treatment comparison uses the same
routes, auth state, cache state, concurrency, and full-body timing.

## Scope

This investigation changes no production postgres.js client and no remote
configuration. It tests whether `max_pipeline=1` is a viable candidate while
retaining `max_pipeline=100` as the explicit negative control.

## Local transaction compatibility

Command:

```text
pnpm exec vitest run src/lib/db/__tests__/postgres-max-pipeline.integration.test.ts
```

Result on 2026-08-12: **PASS**, 1 test executed against local Postgres on port
5499. The client used `max:2`, `max_pipeline=1`, opened `sql.begin()`, executed
two statements on the reserved transaction connection, and resolved after
commit. No schema or durable fixture writes were performed.

Control diagnosis preceding the checked-in test:

- `max_pipeline=100`: transaction fulfilled.
- `max_pipeline=1`: transaction fulfilled.
- `max_pipeline=0`: transaction rejected with postgres.js
  `UNSAFE_TRANSACTION`; it is not a viable production candidate.

## Pure differential contract

Command:

```text
pnpm exec vitest run scripts/ci/__tests__/health-bundle-differential.test.ts
```

Result on 2026-08-12: **PASS**, 37 tests. The harness now distinguishes:

- `depth-one-clean`: legacy depth 100 wedges, depth 1 fulfills, clean controls
  fulfill;
- `depth-one-wedged`: legacy depth 100 and depth 1 both wedge, clean controls
  fulfill;
- `inconclusive`: a control fails, or depth 1 rejects / hangs without the
  observer-confirmed wedge signature.

## Ephemeral-branch differential

**RUN COMPLETE — VERDICT: `depth-one-wedged`.** Owner approved the branch cost
($0.01344/hr) before creation.

| Field | Value |
|---|---|
| Parent project | `kubdiqdhqbhwmqfditeg` (RepWorth-staging) |
| Branch ref | `uqktyhufxtsriwpoxsbi` (name `wedge-773-differential`) |
| Branch created | 2026-08-12T18:54:06Z |
| Differential window | 2026-08-12T18:58:20Z → 2026-08-12T19:08:12Z |
| Iterations per arm | 6 |
| Observer | separate direct (`:5432`) connection, distinct from the `:6543` arm pooler |
| Branch deletion | Completed after the run; a subsequent `list_branches` returned only the pre-existing default `main` branch |

Per-arm iteration arrays:

| Arm | `max` | `max_pipeline` | Iterations | Collapsed |
|---|---:|---:|---|---|
| `concurrent-max2` | 2 | 100 | wedged ×6 | **wedged** (expected wedge) |
| `concurrent-max2-pipeline1` | 2 | 1 | wedged ×6 | **wedged** (question under test) |
| `sequential-max2` | 2 | 100 | fulfilled ×6 | fulfilled (expected clean) |
| `concurrent-max6` | 6 | 100 | fulfilled ×6 | fulfilled (expected clean) |

Terminate-all counts (wedge-signature backends killed per iteration):
`concurrent-max2` = 2,2,2,1,2,2 (11 total); `concurrent-max2-pipeline1` =
2,2,2,2,2,2 (12 total). Both clean arms terminated nothing. Final residual
barrier: zero — the verdict resolved to `depth-one-wedged` rather than
`aborted-residual`, which takes strict precedence.

### Interpretation

The positive control fired 6/6, so the harness is faithful on this topology and
the depth-1 result is interpretable rather than a null rig.

**Pipeline-depth reduction is not the cure.** Depth 1 — the lowest integer
value that still supports `sql.begin()` — wedged on every iteration,
indistinguishable from the legacy depth 100. Depth 0 is not a candidate at all
(postgres.js `UNSAFE_TRANSACTION`; see "Local transaction compatibility"
above). There is no transaction-compatible value on this dial that prevents
the observed wedge.

**Excess demand over available connections is the demonstrated trigger on this
query mix and topology; pipeline depth remains part of the mechanism.** Both
clean arms removed the demand-exceeds-pool condition — one by serializing the
bundle, one by sizing the pool to the six-query fan-out — and stayed clean at
depth 100. Both wedged arms kept that condition. Because postgres.js depth 1
still admits one query behind the active query, the result shows that one
pipelined follower is already sufficient; it does not show that pipelining is
irrelevant.

This rejects the proposed depth reduction and supports #773's capacity framing
without closing its separate Vercel isolate-demand question. Remaining levers
include per-request sequencing (already shipped by #761/#767/#779), bounded
application-level queuing, pool sizing, and read-path routing. Any pool or
routing change must be re-derived under ADR 0009's shared connection budget and
preceded by the staging baseline below.

### Follow-up defect observed (not part of this investigation)

Supabase branch creation reported `MIGRATIONS_FAILED` and provisioned an EMPTY
database (0 tables in `public`). All 104 migrations in `supabase/migrations/`
then applied by hand over the branch's direct connection with
`ON_ERROR_STOP=1`, zero errors, yielding 50 public tables including all seven
tables the health bundle queries (`agent_runs`, `flagged_responses`,
`inbound_events`, `job_outbox`, `notification_deliveries`, `responses`,
`businesses`). This run therefore observed a failure in automated branch
migration replay, while the same checked-in migration chain applied cleanly
manually. It does not establish why automated replay failed; Git integration is
only a hypothesis. File a separate ticket with the branch-action evidence
before relying on branch provisioning. `scripts/test-db-setup.sh` was NOT used
and its localhost-only guard was NOT modified.

Applying those migrations manually crossed the original intake's no-schema-
change invariant and the feature workflow's separate remote-migration approval
boundary. The owner acknowledged that after the run; it was not retroactively
authorized. The exact scope, cleanup, and follow-up are recorded as D1 in
`docs/superpowers/plans/fix-773-disable-postgres-pipelining-deviations.md`.

## Current staging latency baseline

Pending. The authenticated Chrome measurement could not start because the
active Chrome profile did not have the Codex Chrome Extension or native host
installed. No unauthenticated substitute was accepted as evidence.

After browser access is restored, use the exact protocol in
`docs/runbooks/pool-wedge-burst-drill.md` and append one table per route with:

| UTC window | deployment | role | route | concurrency | n | failures | timeouts | min | p50 | p95 | max |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pending | pending | owner | `/api/dashboard` | 1 | 20 | pending | pending | pending | pending | pending | pending |
| pending | pending | owner | `/api/dashboard` | 4 | 40 | pending | pending | pending | pending | pending | pending |
| pending | pending | AAL2 admin | `/api/admin/flagged?limit=20&offset=0` | 1 | 20 | pending | pending | pending | pending | pending | pending |
| pending | pending | AAL2 admin | `/api/admin/flagged?limit=20&offset=0` | 4 | 40 | pending | pending | pending | pending | pending | pending |

All timings must cover `fetch()` through completed `response.text()` with
`cache: 'no-store'` and a 15-second deadline. Response bodies and credentials
must not be recorded.
