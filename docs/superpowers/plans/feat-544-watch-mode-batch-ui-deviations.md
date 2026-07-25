# #544 watch-mode batch UI — deviations from the locked plan

Append-only. Each entry: what the plan said, what was actually true, what was done.

---

## 2026-07-25 — Task 1

### 1. `REPEATABLE READ, READ ONLY` is real, but only proven on direct Postgres

**Plan (rev 3→4 carry-over):** "`rg` finds zero prior uses of `ISOLATION LEVEL` …
T1's wrapper must be **proven** against the live staging pool during T1 step 9."

**What happened:** implemented verbatim — `sql.begin()` then
`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` as the first
statement. `batch-view.integration.test.ts` now asserts it directly:

```
current_setting('transaction_isolation') = 'repeatable read'
current_setting('transaction_read_only') = 'on'
```

That test **passes**. Two limits on what it proves:

- The integration suite's local-host guard (copied from
  `contacts-repo.integration.test.ts`) *refuses* any non-localhost URL, so it
  cannot be pointed at the staging pooler. It proves the SQL, **not**
  PgBouncer/Supavisor transaction-pooling behaviour.
- The argument that pooling is safe is structural, not measured:
  `SET TRANSACTION` is transaction-scoped, and transaction pooling pins a whole
  `BEGIN…COMMIT` to one server connection. The documented pooler hazard is
  *session*-scoped `SET`, and CLAUDE.md's `SELECT … FOR UPDATE` gotcha is
  explicitly about statements **outside** `sql.begin()`. Neither applies here.

**Remaining action for the human:** confirm on staging (T1 ship step) by reading
`transaction_isolation` through the pooled `DATABASE_POOL_URL`. Until then, treat
the purge-race protection as argued-but-unmeasured under PgBouncer.

### 2. The perf escalation trigger rested on a false premise

**Plan (T1 step 9):** "every ask index leads on `business_id`, not `batch_id`
(`migration 088:200-211`) … **If it seq-scans, stop and add a `(batch_id)`
index — that is a migration** … it must come back to the human."

**What is actually true:** migration 088 already creates
`solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id)` — a
batch_id-leading index. Verified against the live schema
(`pg_indexes` on `solicitation_asks`). **No migration is needed**, so the plan's
escalation trigger does not fire and `db_touching` stays false.

The 5,000-ask case does plan a `Seq Scan on solicitation_asks`, but on a table
holding one tenant's 5,000 rows that is the planner's *correct* choice
regardless of available indexes — the proxy misfires, it does not signal the
risk. The test therefore asserts the two things that carry meaning:

- wall clock: the full read completes in **~7.3 ms** (budget 5 s, statement
  timeout 30 s);
- structure: a batch_id-leading index still exists, with an escalate-don't-fix
  failure message if it is ever dropped.

The `EXPLAIN (ANALYZE, BUFFERS)` output is still printed on every run, as the
plan required.

### 3. Q3 reshaped so `ci:tenant-scope` can see the scope check

**Plan:** a `WITH scoped AS (SELECT … WHERE a.account_id = … AND a.business_id = …)`
CTE feeding `totals` and `ranked`.

**What happened:** `scripts/ci/tenant-scope-audit.ts` strips every `( SELECT …)`
before looking for predicates, so **all** CTE bodies are invisible to it. The
plan's shape fails the audit for both `solicitation_asks` and
`solicitation_contacts` even though it is correctly scoped. Confirmed by running
the audit's own exported `auditSqlText` against the literal SQL.

The allowlist mechanism (`scripts/ci/tenant-scope-allowlist.ts` + an
`ALLOWLIST_BASELINE` bump) is outside `allowed_edit_surface`, so instead the
statement was reshaped — still **one statement**, so snapshot consistency and the
"hero and ledger cannot disagree" invariant are untouched:

- `ranked` now selects **ids and rank only**; the payload columns (evidence
  JSONB, contact name) are joined back for the ≤ 60 surviving rows instead of
  being dragged through the window sort.
- The final `SELECT` re-asserts `a.account_id`/`a.business_id` on the ask join
  and `c.business_id` on the contact join. These are real predicates (they are
  the composite-FK keys), not linter decoration, and they sit outside any
  subquery, so the audit sees them. `ci:tenant-scope` passes with the baseline
  unchanged at 405.

### 4. GET log sampling is unconditional-skip while building, not "first + on change"

**Plan (T1 step 7):** "while building, log the first response and then only on
state change."

**Why not:** a route handler is stateless per request; it has no memory of a
previous response, and adding cross-request state to a Vercel serverless route
to sample a log line is not worth the machinery. The route logs
`batch_view_read` for every non-`building` response and stays silent while
building — which achieves the plan's stated goal (a 5-minute build no longer
emits ~150 identical lines) and keeps the signal the observability section
actually asks for (`hasBatch:false` next to a batch row in Postgres).

### 5. `TEST_DATABASE_POOL_URL` was available after all

The handoff said the live-DB suite could not be run. `.env.local` in this
worktree carries a localhost `TEST_DATABASE_POOL_URL`, so
`batch-view.integration.test.ts` was written **and executed**: 8/8 pass.

---

## Triage (step 6.5, orchestrator, 2026-07-25)

Every entry read end to end before review. Verdicts:

1. **ACCEPT — with a carried action.** The structural argument is sound: the
   documented pooler hazard is *session*-scoped `SET`, and CLAUDE.md's
   `SELECT … FOR UPDATE` gotcha is explicitly about statements **outside**
   `sql.begin()`; neither applies to a transaction-scoped `SET` inside one.
   But argued ≠ measured. **Staging must read `transaction_isolation` through
   the pooled URL before anyone calls the purge race closed.** This is now a
   named step in the ship lane, not a footnote.
2. **ACCEPT.** Verified independently against migration 088:159 —
   `solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id)` is a
   batch_id-leading index. The escalation trigger I wrote rested on my own
   misreading of the index list; the subagent was right to kill it rather than
   escalate a non-problem. `db_touching` stays false and the ship lane is
   unchanged.
3. **ACCEPT.** The reshape preserves the one property that mattered — still a
   single statement, so the "hero and ledger cannot disagree" invariant holds —
   and it fixes a real audit blind spot rather than working around it with an
   allowlist bump that was out of surface anyway. **Durable lesson for
   lab-notes:** `scripts/ci/tenant-scope-audit.ts` strips every `( SELECT …)`
   before looking for predicates, so **CTE bodies are invisible to it**; a
   correctly-scoped CTE fails the audit. Scope predicates must appear outside
   any subquery to be seen.
4. **ACCEPT.** A Vercel route handler is stateless per request; adding
   cross-request state purely to sample a log line would be machinery in
   service of nothing. Skipping the log entirely while `building` achieves the
   stated goal (no ~150-line spam per build) and preserves the
   `hasBatch:false` signal the observability contract asks for.
5. **ACCEPT.** Informational, and it materially improved the evidence — the
   live-DB suite ran (8/8, 5,000-ask read ~6–7 ms) instead of being deferred.

**No RE-PLAN verdicts. Abort criteria not triggered** (one surface amendment,
one non-surface correction to a broken `verification_commands` placeholder, zero
gate-fail rounds caused by the implementation itself).

---

## 2026-07-25 — verify-gate races itself on the shared local Postgres (BLOCKER, environmental)

**Symptom:** `scripts/verify-gate.sh --review` intermittently reports `test` FAIL
plus a cascading `diff-coverage` FAIL, naming one of several **pre-existing**
live-DB suites — observed on
`src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts`
(#543), `src/lib/solicitation/__tests__/batch-builder.integration.test.ts` (#543),
and `worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts`.
None is touched by this branch.

**Root cause:** the gate runs its checks in parallel and exports
`TEST_DATABASE_POOL_URL` for the whole run so the `integration-suites` row can
execute. That makes **every** live-DB suite run at once — concurrently with the
intake's `verification_commands` entry, which independently runs
`batch-view.integration.test.ts` against the **same** local Postgres
(`localhost:5499`, container `repworth-testdb`). They seed and truncate
overlapping tables and clobber each other. Whichever loses reports a bogus
failure; because vitest exits non-zero it never writes `coverage/coverage-final.json`,
so `diff-coverage` fails as a pure cascade.

**Evidence it is contention, not a defect:**

| Run | Result |
|---|---|
| `batch-view.integration.test.ts` alone | 8/8 pass (5,000-ask read ~6 ms) |
| `migration-088-…integration.test.ts` alone | 6/6 pass |
| intake `verification_commands` alone | 8/8 pass |
| inside the gate | 9,356 tests pass, exactly one FILE fails, always a pre-existing suite |
| same `--review` gate at `94b8c115` | fully GREEN when timing avoided the collision |

**Not worked around.** The gate was deliberately NOT re-rolled until it came up
green: a pass obtained by retrying a race is not evidence. The branch's own
verification stands on the isolated runs above.

**Follow-up (own ticket, outside this edit surface):** either serialise the gate's
DB-touching checks, or give the `verification_commands` lane its own database.
`scripts/verify-gate.sh` is not in `allowed_edit_surface` for #544.

## Orchestrator decisions at gate-green (2026-07-25)

### Task 6 (access-policy rename) — DROPPED

It was sequenced last and marked droppable precisely for this situation. It
delivers **zero** user-visible behavior and would rewire four working contacts
routes on a branch already 4.5× its estimated size. The cost of keeping it:
`requireContactsLocationScope` / `requireContactsWriteAccess` are now imported by
the solicitation route family too, so the names undersell their scope. Filed as a
follow-up rather than carried — a reviewer flagging the naming is correct, and
the answer is "yes, and it has a ticket."

### Re-classification trigger — FIRED, lane unchanged

`reclassify` WARN: 4,269 changed lines vs. a `+950 / -40` estimate (~4.5×).
Step 0 re-run against real numbers:

- **RISK stays `high`** — unchanged drivers (staging flag flip, tenant-scoped
  reads). Still no migration; `db_touching` confirmed false by deviation 2.
- **SURFACE stays `mixed`.**
- **NOT an epic.** Checked against every epic criterion: the edit surface *was*
  declared tightly and held (first-task spot check clean, `feature-surface`
  audit green all run); it spans one risk domain, not several; it decomposed
  into 6 tickets, not >8; and no investigation questions remain open.

So the lane was right and the **estimate was wrong**. Root cause: I sized the
feature by its production code (~1,100 lines) and ignored test volume, which came
in at ~2,900 lines — TDD plus 14 verbatim contract titles plus a live-DB suite
means tests run ~2.5× production code on this kind of feature. `estimated_diff_size`
is deliberately **left at its original value** so the WARN stays visible in the
record; silently rewriting it to match reality would erase exactly the signal the
trigger exists to produce.

## 2026-07-25 (resume) — CORRECTION: the blocker was ours, not environmental

**Supersedes "verify-gate races itself on the shared local Postgres (BLOCKER,
environmental)" above.** That entry's evidence was sound and its per-suite
isolation runs stand. Its *conclusion* was wrong in a way that mattered: it
classified the failure as a `scripts/verify-gate.sh` defect outside
`allowed_edit_surface` and filed it as someone else's follow-up. The defect was
in this branch's own test file, inside the edit surface, and is now fixed.

**Actual root cause.** Feature #543 already established a cross-process
serialisation protocol for live-DB suites on the shared local Postgres: a
session-scoped advisory lock,
`pg_advisory_lock(hashtext('repworth_feature_543_integration'))`, in
`src/lib/shared/__tests__/helpers/feature-543-database-lock.ts`.
`batch-builder.integration.test.ts` acquires it in `beforeAll` and releases it in
`afterAll`. `batch-view.integration.test.ts` — added by **#544, this branch** —
never enrolled: it read `process.env.TEST_DATABASE_POOL_URL` and connected
directly. Two unsynchronised writers then seeded and truncated overlapping
`solicitation_*` tables concurrently, and Postgres reported
`PostgresError: deadlock detected` in whichever suite lost.

**Why "unset the env var and the collision goes away" does not work.** The #543
helper's `resolveFeature543TestDatabaseUrl()` deliberately falls back to reading
`.env.local` when the shell variable is absent, so `batch-builder` runs
*regardless* of the shell environment. A gate run with
`env -u TEST_DATABASE_POOL_URL` still put two writers on the database — this was
tried on resume and reproduced the same red gate, with `deadlock detected`
naming the mechanism outright. Serialising by withholding the variable is not
available; enrolling in the lock is the only correct fix.

**Fix (in surface — `src/lib/solicitation/**`).** Two suites needed enrolling,
not one. Each now acquires the lock before opening its pool and releases it in a
`finally` chain in reverse acquisition order, on every path including a
`beforeAll` that failed after taking it (a leaked advisory lock would block every
other live-DB suite for the life of the session). Both hooks carry
`FEATURE_543_DATABASE_LOCK_HOOK_TIMEOUT_MS`.

- `batch-view.integration.test.ts` — added by #544.
- `contacts-repo.integration.test.ts` — pre-existing, and the partner in the
  surviving deadlock. It writes `solicitation_contacts` / `solicitation_visits` /
  `contact_csv_uploads`, exactly the tables `batch-view` seeds, and had never
  been enrolled. Enrolling `batch-view` alone moved the gate from two red DB
  rows to one; the second round found this and closed it.

**Verification — the previously failing scenarios, run directly:**

| Run | Before | After |
|---|---|---|
| `batch-view` ‖ `batch-builder` | `deadlock detected`, one suite red | 8/8 and 12/12 green |
| all four solicitation suites concurrent | `deadlock detected` | 8/8, 12/12, 2/2, 9/9 green — zero deadlock lines |

That is reproduce-then-fix evidence, not a gate re-roll: the suites were run
against each other on purpose, which is the collision the gate creates by
accident.

**Scope of what is fixed.** 52 live-DB suites exist in this repo; only 7 hold the
lock (5 from #543, plus the 2 enrolled here). The remaining ~45 are still
unsynchronised writers on the shared local Postgres. They do not collide with
this branch because they touch different table families — but the protocol is
opt-in and silent when skipped, so the next suite that touches `solicitation_*`
without enrolling will reproduce this exact blocker. That is a repo-wide gap
outside this ticket's surface; it is named here so the follow-up is not lost.

**The earlier follow-up is withdrawn.** `scripts/verify-gate.sh` needs no change
and no ticket; it was correctly running suites in parallel and surfacing a real
defect in this branch's tests. What remains is a naming point, not a bug: the
helper is still called `feature-543-…` while it is now the shared serialisation
protocol for every live-DB suite. Renaming it touches
`src/lib/shared/__tests__/helpers/**`, which is outside this ticket's edit
surface — same shape as the M2 verdict, so it is filed rather than widened.

## 2026-07-25 (resume) — shipping with one knowingly-red gate row

**Decision (human, at the resume):** file the residual blocker against #543 and
proceed to step 8. Filed as **#573**.

After the lock fix above, the gate reduces to exactly one real failure and one
cascade behind it:

| Row | Status |
|---|---|
| lint, typecheck, build, all 14 `ci:*` audits, promised-tests | PASS |
| all three live-DB lanes | PASS (were FAIL) |
| `test` | FAIL — one test, `batch-builder.integration.test.ts`, `deadlock detected` |
| `diff-coverage` | FAIL — cascade; vitest exits non-zero so `coverage-final.json` is never written |
| `reclassify` | WARN — deliberately left visible, see above |

`batch-builder.integration.test.ts` is **byte-identical to `origin/main`**
(introduced by #543 / PR #571) and fails only under full gate load — it passes
alone and passes concurrently with all three sibling solicitation suites. It is
not #544's code and not #544's regression; it was already failing in this
session's first gate run, before any edit.

**Why shipping anyway is defensible, stated plainly rather than waved past:**
CI never runs the suite (no `.env.local` in CI, so its self-hydration returns
undefined and it skips), so the PR's CI is unaffected and remains the
authoritative gate. The local `gate-status.json` therefore stays RED and the
Stop hook will refuse to call this session "complete" — that is the intended
behaviour of a red gate and is being accepted knowingly, not worked around.
`lastGreenGateSha` is deliberately NOT advanced.

**What would change this call:** if #573 turns out to be a real defect in
`buildSolicitationBatch` rather than in the suite's fixture setup, it is a
production concern and #544's staging ride should stop until it is understood.

## Step 8 ship lane — flag flip record

Per the `flag-flip` skill. `SOLICITATION_WATCH_ENABLED` is not an autonomy
flag, so the §8.4 ordering chain does not apply and it carries no hard couplings;
`env-vars.md` assigns its staging flip to #544.

| Environment | Flag | Value | UTC | Why |
|---|---|---|---|---|
| Railway staging worker (`repworth-worker`, env `staging`) | `SOLICITATION_WATCH_ENABLED` | `false` → `true` | 2026-07-25T22:40:42Z | Enables the completed-ingest trigger so a CSV upload creates one unbuilt batch + one `build_solicitation_batch` outbox row |
| Vercel staging (project `rep-worth`, custom env `staging`) | `SOLICITATION_WATCH_ENABLED` | unset → `true` | flip + redeploy verified by 2026-07-25T23:09:10Z | Un-gates the Requests pages, the batch GET/POST routes, and the nav row |

Verified by reading each value back, not by assuming the write took. Worker
reports Online after the variable-triggered redeploy. The Vercel env change was
followed by an explicit redeploy (`rep-worth-j10i0h908`, Environment=`staging`,
Ready) because a Vercel deployment captures its env at creation time — the
git-sourced deploy from the `staging` push predated the variable by minutes and
would not have seen it.

**The HTTP smoke was inconclusive and was not accepted as proof.** `curl` against
`/dashboard/requests`, `/dashboard/requests/contacts` and
`/api/dashboard/solicitation/batch` all returned 302, which initially read as
"flag on, route exists". A negative control killed that inference: a bogus path
returns 302 as well, because middleware redirects every unauthenticated request
to login before routing. Flag state is simply not observable over unauthenticated
HTTP. Proof came instead from an authenticated browser session (below).

**Smoke — what is actually proven (authenticated, staging.repworth.net):**

- The `Requests` nav row renders. It is hidden unless `layout.tsx` passes
  `solicitationEnabled`, so its presence *is* the flag being on.
- `/dashboard/requests` renders the no-batch ghost pipeline: `Watch-mode ·
  nothing sent` badge, em-dash funnel (candidates evaluated / held back / would
  have been sent), and the `Upload a contacts CSV` CTA.
- The six-reason ledger renders in first-match precedence order: `no_consent`,
  `suppressed`, `already_reviewed`, `stale_visit`, `over_contacted`,
  `velocity_banked`.
- `/dashboard/requests/contacts` renders at its NEW path (the #544 move) with the
  attestation copy and `consent_attestation_v1` recorded on upload.

**Not proven here:** the built-batch funnel hero and spoilage report, which need
a real batch. Reaching that state requires uploading contact data and signing the
consent attestation ("these are real customers … I am authorized"), which is the
owner's assertion to make, not the agent's. Handed to the human. Note #543's own
staging smoke already proved the worker half (batch built, 1 ask, `decision=send`,
parent + child runs), so the untested gap is the UI's built-batch rendering only.

**Correction to session-start memory:** an injected observation claimed this flag
was already enabled on Railway staging from the #543 work. It was `false` when
read. Live state wins; the memory was stale.
