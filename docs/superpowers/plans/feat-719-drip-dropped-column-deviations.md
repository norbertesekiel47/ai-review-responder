# feat-719-drip-dropped-column — deviations

Entries the plan did not anticipate. Every entry gets a triage verdict (ACCEPT / RE-PLAN)
logged inline at step 6, before any review agent sees this file.

---

## D1 — `allowed_edit_surface` amendment (auto-approved, step 2 rule)

**When:** step 3, before planning completed.

**What:** added `worker/jobs/WeeklySummaryWorker.ts` and `worker/jobs/MonthlyImpactWorker.ts`
to `allowed_edit_surface` in both intake copies.

**Why:** the `codebase-design` pass found that `ownerHasDashboardAuth` and `buildDashboardUrl`
are composed verbatim at every call site (`WeeklySummaryWorker.ts:213-216`,
`MonthlyImpactWorker.ts:294-297`), and the drip worker would have been the third. Collapsing
them into one `resolveDashboardUrl` removes `Array<{exists: number}>` from the interface and is
net-negative, but it edits the two sibling call sites.

**Rule applied:** step 2's auto-approve clause — exactly 2 files, both inside `worker/jobs/`,
a tree the surface already covers. Recorded, not escalated.

**Amendment count: 1.** A second amendment triggers the step 5 abort criteria.

**Containment:** the collapse is isolated as Task 4, blocked on Task 3, and turns no promised
test green. It can be dropped without touching the correctness fix.

**Verdict:** _(pending step 6)_

---

## D2 — `origin/main` moved mid-setup

**When:** step 2, before `pnpm worktree:new`.

**What:** the branch is based on `39c94ed1` (#720, "audit live-DB helpers, not just suites"),
which landed after this session started, not on the `main` the parent checkout had.

**Why it matters:** #720 hardened `ci:live-db-suites` to audit helper files, not only
`*.integration.test.ts` suites. Task 1 adds `seedLocation` / `cleanupLocation` to
`src/lib/shared/__tests__/live-db-tenant.ts` — a helper file now inside that audit's scope.
The helpers contain INSERTs only and no DDL, so they should pass, but Task 1 Step 7 runs
`pnpm ci:live-db-suites` explicitly rather than assuming it.

**Verdict:** _(pending step 6)_

---

## D3 — the sink's `job_outbox.last_error` write was cut (my scope creep, not the owner's scope)

**When:** step 3 gate, Codex plan-review round 1 (`docs/reviews/.../plan-round-1.md` findings 1-5).

**What:** the **Job-failure sink** now raises a Sentry issue and writes **nothing** to `job_outbox`.
`recordOutboxLastError` is not added; `src/lib/shared/outbox.ts` is removed from
`allowed_edit_surface`.

**Why:** four independent reasons, all verified by direct read rather than taken from the agent.
(a) `OutboxPoller.ts:140-143` sets `last_error` **unconditionally** when the watchdog terminalizes,
so the sink's text is destroyed by the exact generic message it existed to replace. (b) Preserving
it means editing `OutboxPoller.ts` — outside the surface, and a 2nd amendment trips the step-5
abort rule. (c) `worker/jobs/csv-ingest/failed-hook.ts:34` sets an explicit PII contract: only the
bounded error CLASS may be persisted or logged, because driver messages can embed contact handles.
(d) `worker/jobs/solicitation-batch/generate-failed-hook.ts:263` deliberately leaves retryable
exhaustion `dispatched` carrying its own `last_error`, which a generic `status='dispatched'` guard
would overwrite.

**Does this invalidate a locked intake decision?** No — and this is the load-bearing check, because
if it did, the abort criteria would apply. The owner approved *"make job failures capture to Sentry
with the real error"*. The `last_error` write was added by me afterward while drafting the intake;
it is scope I invented, not scope that was signed off. Cutting it returns to what was approved. The
one intake `observability` bullet asserting it has been rewritten to state the opposite explicitly,
so the contract does not silently disagree with the code.

**Cost, stated plainly:** a terminal `job_outbox` row still reads
`'Stale dispatched entry exceeded max_attempts'`, which names the reclaim and not the fault.
Mitigated by saying so in CONTEXT.md's **Watchdog** entry and the lab notes, and filed as a
follow-up against `OutboxPoller.ts`.

**Verdict:** _(pending step 6)_

---

## D4 — two existing helpers were about to be reinvented

**When:** step 3 gate, round 1 (finding 3).

**What:** `recordOutboxTransientError` (`src/lib/shared/outbox.ts:183`) and `isTerminalAttempt`
(`:210`) already exist and do what the v1 plan proposed to add. The sink imports `isTerminalAttempt`
instead of defining its own.

**Why it matters beyond this ticket:** I had read `outbox.ts:1-150` and stopped, so I never saw
them. `isTerminalAttempt` is also deliberately `attemptsMade >= max || attemptsMade + 1 >= max`,
not the naive `>=` I had written — a subtle behavioural difference I would have shipped. Promoted
to lab notes in Task 6 as a grep-first rule.

**Verdict:** _(pending step 6)_

---

## D5 — `tests_to_add` retitled 16 → 25

**When:** step 3 gate, round 1 (findings 6-13).

**What:** the eval grew from 16 to 25 tests and most titles changed;
`estimated_test_lines` ±500 → ±800.

**Why:** round 1's leading question found ten ways all 16 could pass while the feature stayed
wrong — four already passed before any fix, day_7 had no live coverage, the live suites could
silently skip entirely, and every negative scheduler assertion was satisfiable by a crashing query.

**Classification:** a **deviations entry, not an amendment** — per the step-5 rule, `tests_to_add`
retitles and `verification_commands` corrections do not count against the amendment budget.
Amendment count remains **1** (D1). Both intake copies updated; all 25 titles verified present
verbatim in plan v2.

**Verdict:** _(pending step 6)_
