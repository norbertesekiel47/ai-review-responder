# Lab notes — Postgres.js / JSONB / PgBouncer

## Summary

- **Postgres.js / JSONB / PgBouncer** — JSONB string-wrapping, v3 double-encoding, statement_timeout, FOR UPDATE under PgBouncer; the AUTHORITATIVE production JSONB parse-site allowlist (2026-08-03); every error class reachable from a query carries a STRING `code` (`PostgresError`, `57014`, `CONNECTION_*`, Node `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`) — narrow a swallow-catch on that shape, NEVER on `instanceof PostgresError`, which rethrows transient blips into the caller (#679, 2026-08-08); a BACKTICK inside a `--` SQL comment terminates the enclosing `sql``` template — prose only (no backticks, no `${`) or you get `TS1005` several lines from the line you edited (#665, 2026-08-18); three worker transactions hold a lock across an external call BY DESIGN and one (the admin-alert claim) was moved to claim-before-send — #413 closed as superseded by #505/#773/#500/#414 (2026-09-06)

## Canonical entries

### [2026-08-03] PgBouncer JSONB parse-site allowlist — AUTHORITATIVE (moved from CLAUDE.md, context diet)
CLAUDE.md keeps the guard rule (`typeof x === 'string' ? JSON.parse(x) : x`, then narrow; never paper over with `: any`); this entry owns the site enumeration. **Exactly 23 production JSONB field-to-parser sites today:**
- `job_outbox.payload` (2): `worker/background/pollers/OutboxPoller.ts`; `src/app/api/dashboard/past-replies/draft-status/route.ts`.
- `businesses.tracked_keywords` (1): `src/lib/admin/business-detail/mappers.ts` (the `trackedKeywords` call through `parseDbArray`; its sibling calls parse `TEXT[]`, not JSONB). `RankingTrackingWorker` no longer parses this column — it reads the primary keyword via `primaryTrackedKeywordSql` (#572), which resolves it in SQL.
- `accounts.flags` (2 shared parser sites): `src/lib/shared/past-due-recovery.ts`; `worker/background/pollers/billing-reconciliation/account-flags.ts`.
- Demo snapshots (4): `prospect_demos.reviews_snapshot` + `.generated_responses` in `src/app/(public)/demo/[slug]/page.tsx`; the same two `onboarding_demos` fields, server-projected into `src/app/onboarding/demo/PaywallWithDemoClient.tsx`.
- Run spine (2): `agent_runs.error` + `agent_run_steps.detail` in `src/lib/agents/read.ts`, through `parseJsonbObject` — the ONE object parser for the whole agents surface, owned here and re-exported from `operator/schema.ts` (it was a byte-identical copy in both files until the fallow duplication gate caught it).
- `solicitation_outreach` (3): `.lint_detail` + `.moderation_detail` + `.interpolation_inputs` through the shared parsers `parseOutreachLintDetail`/`parseOutreachModerationDetail`/`parseOutreachInterpolationInputs` in `src/lib/solicitation/outreach.ts` (consumed by the Requests read model in `src/lib/solicitation/batch-view.ts`; each narrows and throws on a shape the writers cannot have produced — the `parseEvidence` posture).
- Owner Operator (4): `agent_turns.reply` through `parseReplySegments` (called in `context.ts` and twice in `turns.ts`), and `agent_proposals.input` + `.before` + `.after` through the shared `parseJsonbObject` (called in `proposals.ts`), both reached from `src/lib/agents/operator/schema.ts` (`parseReplySegments` is defined there; `parseJsonbObject` is re-exported from `agents/read.ts`) — each narrows and throws on a shape the writers cannot have produced, the `parseEvidence` posture. `agent_proposals.prepared_version_token` and `.receipt` are WRITTEN in Run A and read by nobody: their parse sites arrive with Apply in Run B and join this count then.
- One each (5): `analytics_events.properties` in `worker/background/pollers/AnalyticsDispatchPoller.ts`; `review_exceptions.payload` in `worker/jobs/AdminExceptionWorker.ts`; `account_offboardings.provider_dispositions` through the shared parser in `src/lib/account-offboarding/provider-disposition.ts`; `contact_csv_uploads.report` through the shared parser `parseIngestReportValue` in `src/lib/solicitation/ingest.ts` (consumed by `getUploadStatus` in `uploads.ts` and the worker's terminal-status re-read); `solicitation_asks.evidence` through `parseEvidence` in `src/lib/solicitation/batch-view.ts` (the Requests read model — a non-object or discriminant-less value throws rather than rendering a blank spoilage row).

Any new production JSONB field-to-parser site must be added HERE. Do **not** add HTTP/request bodies, provider responses, LLM output, Redis/cache/connect-state values, local storage, JSON structured clones, or `TEXT[]` reads — those are different parsing boundaries, not this PgBouncer JSONB carve-out.

## 2026-08-13 — #773 admission chokepoint (step A)

- [2026-08-13] The `max_pipeline` dial looked like the obvious cure for the #773
  wedge and is a **dead end at every value** → `max_pipeline: 0` breaks EVERY
  `sql.begin()` (`connection.js:170-178` short-circuits on
  `sent.length < max_pipeline` *before* invoking `q.options.onexecute`, the only
  hook that binds a transaction to its connection → `UNSAFE_TRANSACTION` across
  192 call sites), and `max_pipeline: 1` still admits **two** queries in flight
  (the first query is `query`, not in `sent`, so `sent.length === 0 < 1` passes)
  and wedged 6/6 on staging, indistinguishable from the default 100. CORRECT →
  bound admission in application code above postgres.js. `src/lib/db/admission.ts`
  wraps the `sql`/`sqlRead` singletons at cap == pool, which is exactly the
  no-pipelining condition: with N ≤ max in flight `handler()` always finds an
  `open` or `closed` connection and never reaches `go(busy.shift(), query)`.
  (#651 added a third module-owned singleton, `sqlUnsubscribe`, gated the same
  way at its fixed cap of 2 — every db/server client export is wrapped; a new
  one must also join `DB_SERVER_SQL_TAG_SOURCE_NAMES` in
  `scripts/ci/tenant-scope-audit.ts` or its tagged queries escape that audit.)
- [2026-08-13] Wrapping a postgres.js client is NOT a matter of proxying the
  returned query — a Proxy over the `Query` breaks `.raw()`/`.values()`/
  `.simple()`/`.forEach()` chaining, and gating at call sites is not an option
  either (`src/app/**` alone has **153** files importing `sql`, so coverage is
  unenforceable). WHY the seam exists → `Query` is LAZY: the constructor only
  stores `handler`, and dispatch happens in `handle()`, called from
  `then`/`catch`/`finally`/`forEach`/`execute`. CORRECT → replace `handler` on
  the SAME instance (carrying `handler.debug` over, which `Query.origin` reads)
  and release the slot via `Promise.prototype.then.call(query, release, release)`
  — `handle()` has already run at that point, so it cannot re-dispatch, and
  passing both handlers means a rejected query can't emit an unhandled rejection.
  `.cursor()` is the one shape that cannot be gated: it re-assigns
  `resolve`/`reject` on every iterator step and never settles the Query promise,
  so there is no settlement to release on — it throws rather than leaking a slot
  (zero call sites today).
- [2026-08-13] Counting a slot per QUERY deadlocks; counting per CONNECTION does
  not → `sql.begin()` holds one connection for the whole transaction, so a
  per-query semaphore has a transaction waiting on a slot it is itself holding.
  CORRECT → one slot per transaction for its full duration; queries on the `tx`
  handle are ungated **by construction** (postgres.js hands the callback a
  separate scoped `Sql` with its own handler). The residual hazard — code inside
  a transaction reaching the OUTER `sql` handle — is handled with an
  `AsyncLocalStorage` store carrying WHICH clients' slots are held (not a bare
  flag, so a transaction on `sql` cannot exempt `sqlRead` from its own gate):
  the self-referential case bypasses the gate instead of waiting, which can never
  deadlock, over-subscribes by at most one per in-flight transaction, and is
  counted + warned once so the anti-pattern stays visible.
- [2026-08-13] Binding a wrapped client's methods EAGERLY (`client.unsafe.bind(client)`
  at wrap time) crashed a suite that `vi.mock`s the `postgres` module —
  `Cannot read properties of undefined (reading 'bind')` at import time, from a
  test file that never touches the pool. CORRECT → resolve wrapped methods on
  first ACCESS inside the Proxy `get` trap and memoize them (identity must stay
  stable or `vi.spyOn` breaks); merely constructing a wrapper must never assume
  the wrapped object is real.

- [2026-08-13] Step B — the accepted trade-off is LATENCY, deliberately (moved
  from CLAUDE.md 2026-08-16, context diet). The gate converts over-subscription
  into WAITING, so p95 rises under load: staging measured owner forced-miss p95
  **4.8s at concurrency 8 / 4.3s at 12** against a pool of 3, versus ~1.3s on
  the cached path. That is the deal — a queued request is the price of never
  pipelining, and it replaces a hang that lasted 16.6s–374.5s and killed a pool
  slot permanently. **Do NOT "fix" that latency by raising `DB_POOL_MAX`.** The
  same run measured backend sessions peaking at **44 of 57** at concurrency 12,
  because the gate bounds work per Fluid Compute isolate and does nothing about
  how many isolates Vercel warms (each holding write-3 + read-8). Raising the
  pool multiplies per-isolate sessions against a budget already near its
  ceiling — it is a worse lever after #773 than it was before. Fix slow queries
  or cache instead. Excess callers QUEUE with a 30s deadline
  (`DbSlotTimeoutError`); per-request sequencing (#761/#767/#779/#809/#810) is
  NECESSARY BUT NOT SUFFICIENT — the pool is per Fluid Compute isolate and an
  isolate serves overlapping requests, so a fan-out of 2 wedged a pool of 3.
  Evidence: `docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md`
  (step B addendum, 520 requests, 631 observer samples).

## 2026-09-06 — Locks across external calls (#415) and the scoped #413 closure

- [2026-09-06] #415 listed four worker transactions that `await` an external
  HTTP call while holding a pooled connection (and sometimes row locks). Three
  are DELIBERATE and stay; the rule entry (`.claude/rules/worker-layout.md`
  § Traps) names them, this entry owns the WHY:
  - `worker/jobs/publisher/edit-publish.ts` — `reviews` + `responses FOR UPDATE`
    across Zernio delete → post → (on 409) multi-page verify. The lock is what
    stops `processReview` from superseding the candidate while Google's reply
    slot is empty; releasing it first re-opens the "stale text reaches Google"
    race the 2026-05-01 edit-existing-replies spec closed
    (§ "Why holding locks through external I/O is acceptable here"). Bound:
    ≈ 3 × 15 s Zernio timeouts plus the verify pages; rare (owner edits a
    posted reply).
  - `worker/jobs/billing/UpdateStripeOverageWorker.ts` — billing advisory lock
    + `accounts FOR UPDATE` across a Stripe retrieve + ONE mutation. That lock
    is the same-account serialization guarantee of record for the
    operation-scoped Stripe idempotency keys (`worker/index.ts` boot comment;
    `overage-account-lock.integration.test.ts`, mutation-checked 2026-09-02);
    `concurrency: 1` and the single replica are defense in depth, not the
    guarantee. Honest bound: 2–3 Stripe calls × 20 s × up to 3 attempts
    ≈ 2–3 MINUTES worst case (the issue's "60 s" undercounted), at most one
    connection of ten, and only on a location add/remove. Moving the call out
    would flip the guarantee onto the detected-not-enforced single-replica
    invariant — rejected 2026-09-06.
  - `worker/background/pollers/CleanupAbandonedSignupsPoller.ts` — per-email
    signup lock + `users FOR UPDATE` across Supabase `deleteUser` (10 s bound).
    Releasing first lets a signup that completes in the gap have its Auth
    identity deleted underneath it.
- [2026-09-06] The fourth site, `NotificationFailoverPoller.tryClaimAlert`
  (Resend inside the tx under an advisory lock), had no correctness reason and
  moved to **claim-before-send**: tx1 = advisory lock → 24 h dedup SELECT →
  INSERT claim (`sent_at NULL`) → COMMIT; then `sendFn(claimId)` outside any
  tx; then `UPDATE sent_at/external_message_id`. Two rules came out of the
  Codex review, both non-obvious:
  - **A send exception does not prove non-delivery, so a failed send KEEPS the
    claim.** The Resend SDK folds transport failures — including a broken read
    of a SUCCESSFUL response — into `application_error`, `sendInternalEmail`
    rethrows a generic `Error`, and the 10 s `Promise.race` in `send-email.ts`
    cannot cancel the orphaned request. Any "delete the claim on definite
    failure" branch is therefore a duplicate-send path. Cost accepted: a real
    rejection waits for the 24 h window instead of the next 2 h cycle
    (admin-only alerts).
  - **Key the provider idempotency on the committed claim id, not on the dedup
    tuple.** The DB dedup window and Resend's key TTL are both 24 h but do not
    start together; a tuple-derived key can hand a NEW claim the previous
    claim's message id (or a payload conflict) at the boundary.
    `adminAlertIdempotencyKey(claimId)` decouples them.
  - Accepted degradation: crash-in-gap / any send failure / failed post-send
    UPDATE ⇒ that alert is suppressed ≤ 24 h. Only the owner-unreachable arm
    has an independent health check (`checkOwnerUnreachable`);
    `checkZeroDeliveryNotifications` does NOT cover the all-failed arm (it
    requires zero delivery rows; all-failed requires failed ones), and nothing
    covers the responsiveness arm.
- [2026-09-06] #413 ("stale pooled connections wedge DB loops", filed
  2026-06-27) closed as SUPERSEDED, scoped to the demonstrated incident. The
  trigger was never stale sockets: #505 proved pipelining onto a busy
  connection over the Supavisor transaction pooler (6/6 vs 0/6). Distinguish
  four mechanisms when citing this: **prevention** — #773 admission at cap ==
  pool, every shared client; **waiter deadline** — the gate's 30 s
  `DbSlotTimeoutError` bounds how long a caller WAITS for a slot, it cancels
  nothing; **recovery** — only the HealthAlertPoller's dedicated `max:2` client
  is end+rebuilt on timeout (#500/#502), sequential checks (#505);
  **containment** — #414's `createGuardedPoll` lets a timed-out cycle run
  detached so the loop survives. Residual: a hung operation on the SHARED
  client is not reclaimed by the app layer (tracked #504 — the #477 pointer
  was stale; #477 closed 2026-07-20 without the re-arm). Keepalive was never
  the gap — postgres.js 3.4.9 defaults `keep_alive: 60`. Signal at closure:
  Sentry 30 d, staging + prod, zero "timed out after" / `DbSlotTimeoutError`;
  health alerts firing again.

## History

- history/2026-04.md § "Postgres.js NUMERIC/DATE decoding (not the JSONB carve-out)"
- history/2026-04.md § "Postgres.js + PgBouncer JSONB string wrapping"
- history/2026-04.md § "Supabase PgBouncer statement_timeout"
- history/2026-04.md § "Postgres.js v3 JSONB double-encoding"
- history/2026-05.md § "`SELECT … FOR UPDATE` outside `sql.begin()` is a no-op under PgBouncer"
- history/2026-05.md § "`postgres.TransactionSql` has no `.begin` in its types — make the outbox helper caller-owned"
- history/2026-05.md § "Postgres.js does NOT parameterise every tagged-template substitution — a nested `Query` is spliced as raw SQL"
- history/2026-06.md § "[2026-06-26] A transient Postgres statement-timeout took down the ENTIRE worker (postgres.js connection-layer unhandledRejection)"
- history/2026-07.md § "2026-07-18 — #500 pool-wedge self-heal"
- history/2026-07.md § "[2026-07-18] An `active+ClientRead` postgres.js connection is a socket wedge no server-side timeout heals — reclaim it client-side (end+rebuild); a server-side backstop needs a genuinely-reachable direct route (tracked #477, not live)"
- history/2026-07.md § "[2026-07-18] Concurrent `Promise.all` queries on a shared postgres.js client over the Supavisor TRANSACTION pooler pipeline onto shared connections and wedge PERMANENTLY in `ClientRead` — #505 proved the #500 wedge's actual trigger"
- history/2026-07.md § "[2026-07-23] Governor never re-suspended any account after its first unsuspension — postgres.js `timestamptz`→JS `Date` truncates microseconds, so the window's own source row compared as "newer" (SECOND subsystem bitten by this trap)"
- history/2026-08-08.md § "[2026-08-08] #679 — narrowing an over-wide `catch` is a repo-wide change, and postgres.js's error taxonomy is why `instanceof PostgresError` is the wrong narrowing"
- history/2026-08-09-to-12.md § "[2026-08-09] #729 — postgres.js `TransactionSql` is NOT assignable to `Sql`; fragment helpers must take the union"
- history/2026-08-09-to-12.md § "2026-08-11 — #769 sweep close-out / #773 mechanism"
- history/2026-08-13-to-21.md § "[2026-08-18] A backtick inside a SQL comment terminates the Postgres.js template literal"
- history/2026-09.md § "[2026-09-02] Deferred FKs make a delete order correct only INSIDE a transaction"
- history/2026-09.md § "[2026-09-03] A round trip costs ~70 ms to Supabase and ~0.4 ms to a local Docker Postgres — so a local benchmark understates a batching win by two orders of magnitude"
