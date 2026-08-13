# Handoff — #773 close-out: admission chokepoint, over-pool proof, monitoring

**Written:** 2026-08-13 · **Status:** ready to start · **Owner action required:** merges, staging pushes

This hands off the final three steps that would let #773 be closed honestly.
Everything before them is done and evidenced. Read "Established facts" before
designing anything — several of those cost a full staging campaign to learn and
one of them overturns a comment that is still in the codebase.

---

## 1. Where things stand

### Merged / open

| Item | State |
|---|---|
| PR **#809** `fix/773-flagged-single-inflight` | OPEN. Sequences `listOpenFlaggedResponses`. Proven on staging. |
| PR **#810** `fix/773-admin-fanout-siblings` | OPEN. Sequences the 5 sibling admin read services + cross-cutting test. |
| Branch `codex/773-vercel-capacity-decision` | Capacity-decision campaign. **Uncommitted** docs in its worktree. Holds the authoritative evidence file. |
| Issue **#773** | OPEN, and must stay open until step B below passes. |

Owner said: **"We'll merge once everything is fixed."** So #809/#810 are
deliberately unmerged; do not merge without asking.

### Worktrees (sibling, blessed layout)

```
/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/
  fix-773-flagged-single-inflight/      → PR #809  (commit 739c6cd9)
  fix-773-admin-fanout-siblings/        → PR #810  (commit 5e5a2e23)
  codex-773-vercel-capacity-decision/   → evidence, ARMED edit-surface guard, docs-only intake
```

There is also a **draft PR #808** (`fix/773-disable-postgres-pipelining`) which
records the ruled-out pipeline-depth mitigation. It is evidence, not a fix —
close or land it as a documented dead end; do not resurrect the approach.

### Authoritative evidence

`docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md`
— on branch `codex/773-vercel-capacity-decision`, **uncommitted in that
worktree**. Full campaign: 1280 observer samples, both wedge events, treatment
decision, deviations D1–D5.

Protocol lives in `docs/runbooks/pool-wedge-burst-drill.md` **Part C** (same
branch, uncommitted).

### Staging right now

- `origin/staging` = **739c6cd9** (PR #809's commit only — NOT #810).
- Deployment `dpl_6DE32hLx7BgpwCM5DgjByuPogWQd`, `READY`, `iad1`, alias
  `staging.repworth.net`.
- **Do not push #810's branch to staging alone** — it is cut from `main` and
  would drop #809's fix. Step B needs a *combined* branch.

---

## 2. Established facts — do not re-derive these

Each of these was measured, not reasoned. Several contradict what the codebase
or the older tickets say.

1. **`max_pipeline: 0` breaks every transaction.** In postgres.js 3.4.9,
   `connection.js:170-178` short-circuits on `sent.length < max_pipeline`
   *before* invoking `q.options.onexecute`, which is the only hook that binds a
   transaction to its connection. Result: `UNSAFE_TRANSACTION` on every
   `sql.begin()` — 192 call sites. Reproduced directly.
2. **`max_pipeline: 1` does not help.** The ephemeral-branch differential
   returned `depth-one-wedged`: depth 1 wedged 6/6, indistinguishable from the
   default depth 100, while both clean controls stayed clean. **There is no
   transaction-compatible value on that dial.** Do not revisit it.
3. **Fan-out ≤ pool is NOT sufficient.** `/api/admin/flagged` wedged with a
   fan-out of **2** against `DB_POOL_MAX=3`. The pool is per Fluid Compute
   **isolate** and an isolate serves overlapping requests, so per-request
   fan-out says nothing about in-flight demand. *Comments asserting the old
   #505 rule were corrected in PR #810; if you find more, they are wrong.*
4. **It is not a backend-capacity problem.** Peak was **25 of 57** sessions
   (abort threshold 46), and **21–22** while wedged. ADR 0009's budget was
   never the constraint. Raising `DB_POOL_MAX` only shifts the threshold.
5. **Once a slot is stuck, the route fails at concurrency 1.** A single
   sequential request hung 374s while the database showed 22 healthy sessions.
   The damage is a client-side pool slot inside the isolate, invisible in
   backend counts.
6. **`statement_timeout` never fires on a wedge.** `ClientRead` is a *wait*
   state, not a running statement. The 30s server timeout is irrelevant here.
7. **Wedges self-clear on isolate reap.** Observed 16.6s (transient) and 374.5s
   (6m16s). Never terminate a backend on shared staging.
8. **The wedge signature** is `state='active' AND wait_event='ClientRead'` with
   a **growing** age. Transient sub-100ms `ClientRead` is normal protocol
   behaviour and appeared constantly in clean runs — do not alert on it.

---

## 3. Step A — admission chokepoint

**Goal:** a hard invariant that in-flight `sql` work per isolate never exceeds
the pool, with excess **queued** rather than pipelined.

### Why this and not more sequencing

#809/#810 make each *request* issue one query at a time. They do not bound
*concurrent requests*. Four concurrent single-query requests still present 4
queries against 3 slots. That case is unmeasured and is the last open hole.

### Design options (decide with the owner)

1. **Semaphore helper** *(recommended)* — one module, e.g.
   `src/lib/db/db-slot.ts`, exporting `withDbSlot(fn)` gated at
   `SHARED_POOL_MAX` (already exported from `src/lib/db/server.ts:53`). Applied
   at composition roots. One chokepoint, no per-site release discipline.
2. **`sql.reserve()`** — postgres.js 3.4 built-in; takes an exclusive
   connection and *waits* rather than pipelining. Structurally correct, but
   every call site needs a `finally { release() }` and a leaked reservation is
   its own outage.
3. **Platform concurrency cap** — if Fluid Compute can cap overlapping requests
   per instance at ≤ pool, the condition is unreachable. **Unverified** — treat
   as a lead, confirm against Vercel docs before costing it.

### Subtlety you must resolve before coding

A semaphore counting *queries* is not the same as counting *connections*.
`sql.begin()` holds a connection for the whole transaction while issuing many
queries. Decide explicitly:

- does a transaction take **one** slot for its duration (correct) or one per
  query (wrong, deadlocks)?
- what is the cap — `SHARED_POOL_MAX`, or `SHARED_POOL_MAX - 1` for headroom?
- what happens on queue-wait timeout? postgres.js has **no** queue deadline;
  unbounded waiting is how a wedge becomes a hang.

Get this wrong and you convert a rare wedge into a routine deadlock. It is the
riskiest part of the whole close-out.

### Acceptance

- A test proving in-flight never exceeds the cap. Use the technique already in
  `src/lib/admin/__tests__/admin-read-single-inflight.test.ts`: hold queries
  pending, assert the count. Must be **verified red** without the chokepoint.
- `sql.begin()` still commits — assert against a live DB, not a mock. The
  `max_pipeline: 0` disaster was invisible to mock-only tests.
- lint · typecheck · `pnpm ci:tenant-scope` · `pnpm ci:rls-audit` · full suite.

---

## 4. Step B — Part C at concurrency ABOVE the pool

**This is the load-bearing measurement. Everything else is reasoning.**

### Setup

1. Build a **combined branch**: `main` + #809 + #810 + step A.
2. Push it to `staging` (fast-forward if possible; staging is a disposable
   integration anchor — see `deployment-guide.md` §"Re-sync staging").
3. Confirm one deployment ID serves the whole window; re-confirm mid-run.

### Run

Part C as written, but at **concurrency 8 and 12** — not 4. Both routes:

- owner `GET /api/dashboard` (hit + forced-miss lanes, 46s TTL discipline)
- AAL2 admin `GET /api/admin/flagged?limit=20&offset=0`

Requires a browser session per role; **owner and admin cannot share one cookie
jar** — stop for an explicit user-driven login boundary and never automate MFA.

### Pass criteria

- 100% HTTP 200, full body drained, zero timeouts
- reaches the final wave at both concurrencies
- **no `oldest_active_client_read_seconds` above 1s**
- backend sessions stay below 46 of 57

### If it wedges

That is a real result, not a failure of the run. Record it, do **not** terminate
backends, wait for reap (~6 min observed), and #773 stays open with the
chokepoint design reconsidered.

### Practical gotchas from the last campaign

- **`javascript_tool` has a 45s CDP cap.** Long lanes must be *fire-and-forget*
  in page context (`window.__x = (async () => {...})()`) and then polled with
  short calls. Page JS keeps running through a tool timeout, so no samples are
  lost.
- **Vercel MCP returned HTTP 500 for every call.** Fall back to
  `vercel logs <dpl> --scope norbert-esekiels-projects`; buffer caps ~100
  entries, so pull it promptly after each lane or you lose the window.
- **Observer**: one persistent `psql … \watch 2` on the **direct** `:5432`
  staging URL (`STAGING_DATABASE_URL` in `.env.staging.local`). Never the
  pooler. Assert the target contains `kubdiqdhqbhwmqfditeg` and **never**
  `udeyaqnvpojbwgoaxwdg` (production).

---

## 5. Step C — monitoring signal

**Goal:** a named, permanent alert on the wedge signature.

- Home: `worker/background/pollers/health-alert/checks.ts` (+ its registry and
  `resolveHealthAlertConfig`), runbook
  `docs/runbooks/beta-launch-alerting.md`, ADR 0005.
- Predicate — alert only on **age**, never on presence:

```sql
SELECT count(*)::int AS wedged
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND state = 'active'
  AND wait_event = 'ClientRead'
  AND clock_timestamp() - query_start > interval '10 seconds';
```

- Transient sub-100ms `ClientRead` is normal and constant. Alerting on presence
  would page continuously. **Age > 10s is the signal.**
- The worker's own pool is 10, not 3, so adding a check is not itself a fan-out
  risk — but confirm against `runHealthChecks`' existing concurrency.
- Tests required per CLAUDE.md: this is a poller + alert path.

---

## 6. Constraints

- **Never touch production Supabase `udeyaqnvpojbwgoaxwdg`.**
- Staging traffic: authenticated, read-only GET only. No config, schema, data,
  flag, or deployment mutations beyond the deliberate staging deploy.
- Never terminate a backend on shared staging.
- Commit, push, staging deploy, and **merge** each need explicit owner approval.
- Repo rules that bit this session:
  - `bash-write-guard` blocks `cp`/writes into repo source — use Edit/Write.
  - `static-policy` pins carve-outs by **`file:line`**; any line-shifting edit
    in an allowlisted file must move its entry (hit in PR #810,
    `margin-service.ts:142 → :149`).
  - Local full suite **with the test DB awake** yields 4 pre-existing failures
    (`ECONNREFUSED 127.0.0.1:5432` — suites assume the default port, container
    listens on 5499). Verified against unmodified `main`. Use
    `REPWORTH_DISABLE_LIVE_DB_SUITES=1` for clean whole-repo runs.

---

## 7. Definition of done for #773

1. Step A merged with its invariant test.
2. Step B green at concurrency 8 **and** 12, evidence appended to the campaign
   evidence file.
3. Step C shipped and firing on a synthetic wedge.
4. Evidence file verdict updated; issue closed **referencing the measurement**,
   not the reasoning.

If step B does not pass, #773 stays open and the correct move is to revisit the
chokepoint design — not to raise a limit and re-measure until it looks quiet.
Non-reproduction alone never proves this class closed.
