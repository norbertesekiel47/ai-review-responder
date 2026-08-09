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

> **STALE as of plan v2.1 — do not act on the containment paragraph above.** It describes v1's
> 7-task graph. In v2.1 the collapse **is** Task 2 (blocked on T1, not T3), it turns titles 2–7
> green, and Task 3 depends on it. The collapse is therefore **no longer droppable** — it is now
> inseparable from the correctness fix. Recorded rather than rewritten so the read-back at step 6
> sees what was claimed at amendment time and what it became. The amendment itself (the 2 files)
> is unaffected; **amendment count remains 1**.

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

**Follow-on at step-4 entry:** `origin/main` moved twice more (#721 docs sweep, #722 landing-scroll)
and the branch was rebased onto `bea12e68` while still docs-only. #720 remains an ancestor, so the
`ci:live-db-suites` reasoning above is unchanged. The rebase was taken now specifically because
#721 edited `.claude/reference/lab-notes.md` — the file Task 6 appends to — and rebasing before
any code lands is cheaper than resolving that append twice.

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

---

## D6 — the intake `goal` still promised the `last_error` write D3 cut

**When:** step 4 entry, at `/feature-resume` reconciliation.

**What:** the intake `goal` field read "durably visible in Sentry **and on the job_outbox row**
instead of being masked by the Watchdog's generic reclaim message." Rewritten in both copies to
say Sentry only, naming D3 and pointing at the `observability` bullets that already said so.

**Why it was missed:** D3 rewrote the one `observability` bullet that asserted the write and
recorded the reasoning at length, but left the `goal` sentence — the same claim, one field higher.
So the locked contract disagreed with itself: its headline promised a `job_outbox` write the code
will deliberately never make, while its evidence list explained why that write is wrong. Left
alone, the step-7 review diffs the implementation against the contract's headline and reports a
promise unmet, with the refutation two fields below.

**Classification:** a **deviations entry, not an amendment.** `feature.md:235-236` is explicit —
"only `allowed_edit_surface` changes count, other intake-field corrections are deviations-file
entries." No surface change; **amendment count remains 1** (D1). `intakeSha256` in
`.feature/state.json` refreshed by `set-phase`; both copies re-diffed byte-identical after the edit.

**The lesson, which is the durable part:** a design reversal has to sweep **every** field of the
contract that asserts the reversed fact, not just the one the review finding cited. D3 corrected
the bullet the reviewer pointed at and stopped there.

**Verdict:** _(pending step 6)_

---

## D7 — five things Task 1 met that the plan's eval spec did not model

**When:** Task 1, writing the 25-test eval.

**What / Why**, in the order they bite:

1. **`assertSchemaReady` takes TWO arguments.** The plan's sentinel snippet calls
   `assertSchemaReady(probe)`; the real signature is `(db, requirements: readonly SchemaRequirement[])`.
   The objects this eval reads span the base schema and 034 rather than one migration, and
   `schema-ready.ts` exports no requirement covering them. Rather than add an export to
   `schema-ready.ts` (in surface, but outside Task 1's four-file list), the requirement is declared
   **locally** in each live suite and paired with `MIGRATION_100_IMPORT_CONSENT` as the near-head
   proof — so a stale container still fails with the actionable `pnpm test:db:setup` message.

2. **Title 4's `role='staff'` is unrepresentable.** The live `users_role_check` admits `'owner'`
   and `'admin'` only, so the prescribed staff row cannot be inserted. Seeded as an `admin` user
   carrying the tenant's `account_id` and an `auth_id` instead. The discriminator is unchanged and
   arguably sharper: a query that drops `u.role = 'owner'` still matches this row and hands back a
   dashboard URL the email's recipient cannot use. Title text untouched.

3. **Title 14's "0 rows" had to be scoped to `day_1`.** With grace = 3, the `asOf - 10 days`
   fixture's **day_7** sits exactly on its own grace boundary, so title 12's locked "send AT the
   boundary" rule REQUIRES it to be queued. A global "0 rows for this business" assertion would
   have been unsatisfiable by a correct implementation. Both assertions therefore read
   `pendingDripCount(businessId, 'day_1')`, which is also what the suite's contamination rule asks
   for. The `tooLate` delta of 0 the title is actually about is unaffected and asserted as written.

4. **The three missing seams are loaded dynamically so `pnpm typecheck` stays GREEN while every
   test is RED.** `resolveDashboardUrl` (T2), `runOnboardingDripCycle` (T4) and
   `worker/job-failure-sink.ts` (T5) do not exist yet. A static import of a missing NAME is a TS
   error and of a missing MODULE is `TS2307`; either would have broken `pnpm typecheck` for Tasks
   2-5, which run in parallel and each gate on it — a Task-1 artefact failing another task's gate.
   Each seam is instead read through a dynamic import cast to an optional-property view, with an
   accessor that throws a named "not exported yet (#719 Task N)" error. The sink's specifier is
   held in a `const` so TS cannot resolve it statically; that resolution was **verified**, not
   assumed, by temporarily pointing the variable at an existing sibling module and confirming the
   import succeeds — otherwise the suite could have been one that never goes green.

5. **`sql.json()` rejects a declared interface.** `OnboardingDripPayload` is an `interface`, which
   gets no implicit index signature, so postgres.js' `JSONValue` parameter refuses it. Passed as
   `{ ...payload }`, whose inferred type is accepted. Noted at the call site.

**Classification:** none of these is a surface change — all five land inside Task 1's four files.
**Amendment count remains 1** (D1).

**Verdict:** _(pending step 6)_

---

## D8 — deleting `buildDashboardUrl` orphans a unit test outside Task 2's surface

**When:** Task 2, step 3 (orphan sweep) — confirmed by `pnpm typecheck` at step 5.

**What:** `worker/jobs/__tests__/summary-report-helpers.test.ts` imports `buildDashboardUrl`
(`:15`) and asserts it in one `it` block (`:52-58`). Task 2 deletes that export, so the file
no longer compiles:

```
worker/jobs/__tests__/summary-report-helpers.test.ts(15,3): error TS2305:
  Module '"../summary-report-helpers"' has no exported member 'buildDashboardUrl'.
```

Task 2's file list does not include it, and the plan's File Structure table never names it —
D1 amended the surface for the two sibling **call sites** (`WeeklySummaryWorker`,
`MonthlyImpactWorker`) and stopped there, because the `codebase-design` pass read call sites,
not test importers. The plan is therefore internally unsatisfiable as written: "delete
`buildDashboardUrl`" and "leave every other file alone" cannot both hold.

**Why it was NOT fixed in Task 2:** the task brief's closing rule is explicit — *"Do not widen
the allowed edit surface. If a file outside your list must change, STOP and report instead."*
A third surface amendment is also the trigger the step 5 abort criteria watch for (D1 set the
count at 1), so this is an owner decision rather than an agent one. Task 2 stopped at the
boundary and reported.

**Shape of the fix, when authorized** (~7 lines, no behaviour change): drop `buildDashboardUrl`
from the import block at `:15` and delete the `it('only builds dashboard URLs when the owner has
auth and app URL is configured', …)` block at `:52-58`. The coverage it provided is not lost —
it is strictly superseded by live-schema titles 2, 3 and 6 in
`worker/jobs/__tests__/onboarding-drip.integration.test.ts`, which assert the same three cases
(owner with auth → URL, no owner match → null, no app URL → null) against a real Postgres
instead of a hand-built `Array<{exists: number}>` that could never have caught the 42703.

**State left behind:** Task 2's four files are committed, lint-clean, and titles 1–7 are green.
Repo-wide `pnpm typecheck` is RED on this one error until the fix above is authorized. (It is
also transiently red on `worker/__tests__/job-failure-sink.test.ts`, which is Task 5's in-flight
work, not this.)

**Verdict:** _(pending step 6)_
