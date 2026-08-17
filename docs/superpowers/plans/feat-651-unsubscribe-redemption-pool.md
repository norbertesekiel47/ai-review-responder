# #651 Dedicated Unsubscribe Redemption Pool — Implementation Plan

**Ticket:** #651  
**Intake:** `.feature/intake.json`  
**Classification:** standard · high risk · backend · database-touching  
**Fixed merge base:** `a6e38fe9b1fbc14da340947319976615eccebe5b`

## Outcome

`POST /ingress/unsubscribe/:token` will begin its current caller-owned
transaction on a dedicated Postgres.js client with a fixed local pool of two
connections. Valid-token replay traffic
therefore cannot consume the shared worker client's 20 local slots used by jobs
and provider ingress. The existing HMAC gate, per-token single-flight,
transaction semantics, response mapping, redaction, and retryable failure shape
remain unchanged.

This is local-slot isolation only. The clients still share the same Supavisor
and Postgres backend capacity, so the release remains gated on a staging burst
drill and backend-session observation.

## Material decision — approved 2026-08-16

Issue #651 says the route must introduce no admission control or busy shed path.
That wording predates #773, which proved that raw Postgres.js clients pipeline
onto busy connections and can permanently wedge even when backend capacity is
healthy. The current project rule is explicit: every shared singleton client
must be wrapped by `withAdmissionControl`; never unwrap it.

The owner approved this interpretation after plan-skeptic round 1:

- no rate limit, immediate pool-full response, semaphore rejection, or bounded
  request-count bulkhead;
- use the mandatory client-level admission chokepoint at `cap === pool max` so
  excess transactions wait rather than pipeline;
- retain the chokepoint's existing 30-second slot deadline. If that expires,
  the existing unsubscribe error path returns sanitized retryable `503`, the
  same shape used for every database infrastructure failure.

The rejected alternatives are a raw pool, which reintroduces the proven #773
wedge, and an unbounded queue, which converts a genuine-token list compromise
into unbounded request memory and indefinite hangs. The approved clarification
is now folded into the intake.

## Capacity re-derivation

The new pool maximum is a code constant, `UNSUBSCRIBE_POOL_MAX = 2`; there is no
environment override and therefore no silent capacity expansion.

- Railway worker: shared write 20 + health 2 + unsubscribe 2 = **24** potential
  local client connections. `sqlRead` remains lazy and unused by worker paths.
- One fully expanded Vercel isolate remains write 3 + read 8 = **11** potential
  local connections. The unsubscribe client is constructed lazily but never
  queried by a Vercel composition root.
- Supavisor Max Clients steady-state model: `24 + isolates × 11 < 200`. The
  bound is **15 warm isolates** (`24 + 15×11 = 189`), leaving 11 client slots
  of headroom. Sixteen equals the approximate 200-client ceiling.
- A normal zero-downtime Railway rollout can overlap two 24-slot workers. Its
  model is `48 + isolates × 11 < 200`, so the deployment-safe bound is **13
  aggregate warm Vercel isolates** (`48 + 13×11 = 191`). Fourteen reaches 202.
  Fifteen is a steady-state bound only and must never authorize a rollout.
- Backend ceiling remains **57 usable sessions**. Client maxima are not proof
  of simultaneous backend consumption. ADR 0009's prior untested compound case
  was about 52/57; adding two worker slots makes the conservative case about
  **54/57 (~95%)**. Staging must combine redemption, worker, and Vercel pressure
  while recording total, active, idle, idle-in-transaction, and oldest
  `ClientRead` age. Crossing the 46-of-57 abort threshold fails the release gate
  and requires a Supabase compute increase before production.

No pool-size environment variable changes in this feature. Raising any pool
remains a separate capacity decision.

## Tracer bullet 1 — Own the bounded client and lifecycle in the database module

**Observable behavior:** the database module exports a lazy client distinct
from `sql` and `sqlRead`, fixed at two connections, admission-gated at two, and
closed best-effort before the shared client during worker shutdown.

**Test seam:** public exports from `src/lib/db/server.ts`, Postgres.js `.options`,
`admissionStats`, and `closeAllPostgresClients`.

**Exact tests:**

- `exports a fixed two-connection unsubscribe pool distinct from sql and sqlRead`
- `gates the unsubscribe client at its fixed pool size`
- `closes the redemption client during closeAllPostgresClients without weakening shared-client shutdown failure propagation`

**Blocking edges:** none. The owner approved the #773 admission clarification.

**Precedent:** `sqlRead` construction and lifecycle in
`src/lib/db/server.ts`; admission application pinned in
`src/lib/db/__tests__/server.test.ts`.

**Allowed files:**

- `src/lib/db/server.ts`
- `src/lib/db/__tests__/server.test.ts`

**Red → green evidence:** run
`pnpm exec vitest run src/lib/db/__tests__/server.test.ts` before and after the
minimal implementation.

**Implementation shape:** add only `UNSUBSCRIBE_POOL_MAX` and
`sqlUnsubscribe`. Reuse `createDedicatedPostgresClient` and
`withAdmissionControl`; do not add a factory, interface, environment reader, or
generic pool registry. `closeAllPostgresClients` owns `sqlRead` and
`sqlUnsubscribe` directly because both are module singletons.

## Tracer bullet 2 — Route one-click redemption through the dedicated client

**Observable behavior:** a well-formed one-click POST begins its redemption
transaction on `sqlUnsubscribe`; malformed tokens still stop before any
transaction; same-token replays still share exactly one committed result; all
outcome-to-status mappings and sanitized failure reporting remain byte-for-byte
equivalent.

**Test seam:** Fastify injection through the existing unsubscribe ingress test
harness with the database module mocked at its exported client interface.

**Exact tests:**

- `routes a well-formed one-click redemption through the dedicated unsubscribe client rather than the shared sql client`
- `keeps malformed-token rejection before every redemption-client transaction attempt`
- `routes three distinct well-formed tokens into three unsubscribe-client transaction attempts rather than collapsing them through single-flight`
- existing `returns 200 only after the suppression row commits`
- existing single-flight concurrency, rejection-release, and cap-bypass tests

**Blocking edges:** tracer bullet 1 establishes the export and test precedent.
#651 has final edit/landing priority over the paused #652 worktree (deviation D1).

**Precedent:** the current `redemptionSingleFlight` dependency in
`worker/ingress/unsubscribe.ts` and its adapter tests.

**Allowed files:**

- `worker/ingress/unsubscribe.ts`
- `worker/ingress/__tests__/unsubscribe*.test.ts`

**Red → green evidence:** run the intake's exact five unsubscribe suites before
and after changing the composition-root import. The production edit is only
`sql.begin` → `sqlUnsubscribe.begin`, plus now-stale explanatory comments and
test adapters. After #651 lands, #652 will preserve this client selection while
moving transaction ownership into `redeemUnsubscribeToken`.

## Tracer bullet 3 — Pin the capacity contract and staging decision gate

**Observable behavior:** maintainers can see that unsubscribe redemption owns
two local slots, that the worker's potential local-client total is 24, and that
release requires distinct-token saturation plus same-token replay concurrent
with unrelated worker and Vercel pressure while backend pressure is observed.

**Test seam:** deterministic documentation/config assertions plus the existing
staging load harness; no production mutation occurs in this feature run.

**Deterministic checks:**

- the db-server tests pin `UNSUBSCRIBE_POOL_MAX === 2` and admission cap 2;
- `src/lib/db/__tests__/server.test.ts` carries the verbatim deterministic test
  `pins the revised 15-isolate steady-state and 13-isolate rollout ADR-0009 Max-Clients bounds, the roughly 54-of-57 compound backend case, and the fixed redemption-pool maximum`;
- `docs/adr/0009-split-postgres-pools.md` records the 15-isolate steady-state
  and 13-isolate rolling-deployment bounds, the roughly 54/57 steady-state
  compound case, and the 46-of-57 staging abort threshold;
- `docs/directory.md` names `sqlUnsubscribe` and the unsubscribe ingress's pool
  ownership;
- this plan records the exact post-review staging drill below.

**Blocking edges:** tracers 1 and 2 green; staging execution additionally
requires separate `push` and `staging_deploy` approval.

**Precedent:** ADR 0009's prior worker-pool and Vercel multiplication drills;
`scripts/burst-drill-load.ts` for unrelated worker load.

**Allowed files:**

- `docs/adr/0009-split-postgres-pools.md`
- `docs/directory.md`
- this plan and review artifacts

**Completion evidence:** `pnpm ci:directory-map`, `pnpm ci:db-imports`, and the
verified review gate.

### Post-review staging drill — authority boundary, not executed here

1. Deploy the reviewed branch to staging after explicit authorization. Wait for
   the first rollout to settle, confirm exactly one active Railway worker
   replica, and confirm `SOLICITATION_SEND_ENABLED` remains off.
2. Confirm `DB_ADMISSION_ENABLED` is enabled on the deployed worker. A disabled
   kill switch invalidates the drill because the raw client can pipeline above
   its two-connection pool.
3. Confirm the aggregate warm Vercel-isolate estimate is at most 13 before any
   rolling worker deployment. More than 13 invalidates the rollout budget and
   aborts the drill before a second worker can overlap.
4. Mint and persist three staging-only valid unsubscribe tokens through the
   real application path, plus one token reserved for the replay arm. Keep raw
   tokens only in the in-memory drill runner; never place them in logs,
   evidence, shell history, or checked-in files.
5. In two direct staging sessions, begin transactions and lock the first two
   token rows by their SHA-256 `token_hash`. Record only the two locker backend
   PIDs. Keep the locks open; never log or query by the raw tokens.
6. Start the existing 1,000-row headroom arm from
   `scripts/burst-drill-load.ts` so unrelated shared-pool writes are active.
7. Start ADR 0009's authenticated Vercel dashboard pressure arm at concurrency
   40 so the previously untested compound worker-plus-Vercel case is exercised,
   with one deployment identity and full-body response deadlines.
8. Start POSTs for the two locked tokens and, without reading query text,
   require `pg_blocking_pids` to show exactly two request backends blocked by
   the recorded locker PIDs. Start the third distinct POST; for at least two
   seconds require all three responses to remain pending while the blocked
   backend count remains exactly two. That is the positive proof that the third
   request is waiting at the two-slot admission gate instead of reaching the
   raw pool. Release both locks within 15 seconds (well below the 30-second
   deadline), drain all three bodies, and require three HTTP 200 responses.
9. Replay the reserved token at bounded HTTP concurrency 2, 8, and 32 while the
   worker and Vercel pressure arms remain active. Drain every response body and
   require all responses to be 200 with no timeout.
10. With those pressure arms still active and after separate staging-deploy
    authorization, redeploy the exact reviewed Railway artifact once to create
    a real old/new-worker overlap. Abort if aggregate warm Vercel isolates rise
    above 13 or accepted Supavisor clients reach 192.
11. In parallel, sample queue-health shared-pool wait and direct staging
   `pg_stat_activity`: total, active, idle, idle-in-transaction, `ClientRead`
   count, and oldest `ClientRead` age. Do not read query text and never
   terminate a backend on shared staging.
12. Pass only if the held-row arm proves two admitted plus one queued, unrelated
   outbox work continues draining through the rolling overlap, shared-pool wait
   does not saturate, there are zero redemption failures/timeouts, no growing
    `ClientRead` above 1 second, accepted clients stay below 192, and backend
   sessions stay below 46 of 57.
13. Release only rows carrying the exact drill tag, inventory zero residuals,
   and record the evidence in a separately authorized staging-run artifact.

The held-row arm positively exercises the two-slot admission bound; merely
starting three fast requests is not evidence. The same-token arm verifies the
earlier single-flight protection. Neither substitutes for compound pressure or
the rolling-overlap arm that guards the revised backend and Max-Clients cases.

## Verification and review sequence

1. Run each tracer's red/green command.
2. Run `bash .agents/skills/feature/scripts/verified-gate.sh`.
3. Run `bash .agents/skills/feature/scripts/verified-gate.sh --review`.
4. Confirm `node .agents/skills/feature/scripts/gate-fingerprint.mjs check`.
5. Dispatch independent read-only spec/correctness and maintainability reviews,
   plus the applicable database/async-operations risk review.
6. Root-triage every actionable finding, apply only accepted corrections, and
   rerun the verified gate after any edit.
7. Transition to `reviewed` only with a current fingerprint and stop
   review-ready. Commit, push, staging deployment, and drill execution remain
   separate approval boundaries.

## Rollback

Revert the application deployment. The client is lazy and code-only; there is
no schema or data rollback. Reversion restores the prior shared-client route.
Do not raise another pool to compensate for a failed drill. If the dedicated
client wedges or the staging thresholds fail, leave #651 open and revisit the
admission/timeout decision with the recorded evidence.
