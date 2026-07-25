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
