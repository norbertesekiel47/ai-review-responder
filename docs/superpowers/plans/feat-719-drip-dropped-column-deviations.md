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

**Verdict: ACCEPT.** The amendment did what it claimed — `resolveDashboardUrl` replaced a pair
composed verbatim at three call sites and removed `Array<{exists: number}>` from the interface.
The containment paragraph went stale (see the note above) and the collapse became inseparable
from the fix, which is a documentation defect rather than a scope one: the two files named are
exactly the two files edited.

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

**Verdict: ACCEPT.** The predicted risk did not materialise — `pnpm ci:live-db-suites` passed on
the first run with the new `seedLocation`/`cleanupLocation` helpers in scope, and passed again on
both green gate runs. The rebase onto `bea12e68` cost nothing: zero conflicts, and #720 remains an
ancestor.

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

**Verdict: ACCEPT.** As built, `worker/job-failure-sink.ts` writes nothing to `job_outbox` and
`src/lib/shared/outbox.ts` is untouched. The reversal returned scope to what was signed off
rather than removing signed-off scope, which is the check that mattered — had it invalidated a
locked decision, the abort criteria applied. The stated cost stands and is now documented in
CONTEXT.md's **Watchdog** entry and the lab notes: a terminal row still reads the reclaim text,
and the diagnosis lives in Sentry. The `OutboxPoller.ts` follow-up is filed.

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

**Verdict: ACCEPT.** The sink imports `isTerminalAttempt` and defines no duplicate; Task 5
additionally declined to import `errorMessage` because it had no use for it. Promoted to lab
notes as a grep-first rule, with the `>= max || +1 >= max` subtlety recorded — that predicate
difference is the part that would have shipped as a silent behaviour change.

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

**Verdict: ACCEPT — and this is the single highest-value deviation in the file.** All 25 titles
were verified red before their implementing task and green after (24 red + the infrastructure
sentinel green by design). The v1 eval would have shipped four already-passing tests, no live
day_7 coverage, and a suite that could skip silently. Judged against outcome rather than
intent: the eval caught the real `42703` against live Postgres at titles 8–11, which is the
proof no unit suite in this repo could have produced.

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

**Verdict: ACCEPT.** Both intake copies carry the corrected `goal` and re-diff byte-identical;
`intakeSha256` was refreshed by `set-phase`. The correction is now load-bearing for step 7: a
reviewer diffing the implementation against the contract's headline finds agreement rather than
an unmet promise with its refutation buried two fields lower.

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

**Verdict: ACCEPT, with one item carried to step 7.** Four of the five were plan-spec errors
corrected without weakening a test (`assertSchemaReady` arity, the `users_role_check` rejection of
`role='staff'`, title 14's day_7-scoping, `sql.json()` on a declared interface) — and the title-14
arithmetic was re-derived by hand at triage: a business activated `asOf − 10 days` has its day_7
due at `asOf − 3d`, inside its own grace window, so a correct implementation MUST queue it and a
global "0 rows" assertion would have been unsatisfiable. The scoping is right.

**Carried forward:** the fifth item — loading three not-yet-existing seams via dynamic import
behind `as unknown as` views — was a **temporary** measure to keep `pnpm typecheck` green for
three parallel tasks, and it silently defeated type-checking against the real signatures (the
views declared `businessId: string` where the real one takes the branded `LocationId`). All three
were converted to static imports by their implementing tasks (T2/T4/T5), each confirming no cast
replaced them. Step 7 should verify that independently rather than take three agents' word for it.

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

---

### Orchestrator resolution — RESOLVED, and **this was never a surface amendment**

The escalation was correct behaviour but rested on a wrong premise, so the premise is corrected
here rather than in a commit message nobody re-reads.

`allowed_edit_surface` contains the glob **`worker/jobs/__tests__/**`**. The orphaned file is
`worker/jobs/__tests__/summary-report-helpers.test.ts`, which matches it. Editing it was
therefore **always inside the locked contract** — no amendment, and the step-5 abort criteria
were never in play. **Amendment count remains 1** (D1), unchanged.

What Task 2 actually collided with was the **task-scoped file list in its own dispatch brief**,
which the orchestrator wrote NARROWER than the surface (four named files rather than the glob).
That narrowing was deliberate — it is what keeps three concurrent agents off each other's files —
but it made an in-surface, in-scope repair look like a contract breach. **The lesson is the
orchestrator's, not the agent's:** a per-task allowlist tighter than `allowed_edit_surface` must
say so explicitly, or a correctly-obedient agent escalates routine work as an abort trigger.

Precedent confirming the repair was always in scope: plan Task 3 Step 3 instructs the repair of
`worker/jobs/__tests__/OnboardingDripWorker.test.ts` — the same class of orphaned-unit-suite fix,
covered by the same glob, and likewise absent from the File Structure table.

**Applied by the orchestrator** (not re-dispatched — a ~7-line edit against lines already read):
`buildDashboardUrl` dropped from the import block; the `it` block replaced by a comment recording
where its coverage went and why the live tests are strictly stronger. `asLocationId` was checked
and retained (still used at `:87/:104/:126`). Suite re-run: **6/6 green**. Orphan sweep clean —
the only surviving matches are that comment and `src/hooks/useDashboardData.ts`, the unrelated
same-named local function the plan predicted.

**One correction to the superseding-titles citation above:** the third case (no app URL → null)
is title **7** (`resolveDashboardUrl returns null without querying when no app URL is
configured`), not title 6. Title 6 is the cross-account isolation case. Titles 2 and 3 are cited
correctly. Recorded because a step-7 reviewer checking the claim against title 6 would find a
mismatch and reasonably doubt the whole justification.

**Verdict: ACCEPT.** Not an amendment — the glob `worker/jobs/__tests__/**` always covered the
file, and the amendment count stayed at 1 through this entry. The coverage claim was checked at
triage rather than accepted: titles 2, 3 and 7 do assert the three cases the deleted `it` block
covered, against live Postgres. The lesson is the orchestrator's — a per-task allowlist tighter
than `allowed_edit_surface` must say so, or an obedient agent escalates routine work as an abort
trigger.

---

## D9 — the seam conversion imports one export, not two (`no-unused-vars` is error-level in tests)

**When:** Task 5, step 3 (dynamic-import seam → static import).

**What:** The step 3 instruction spelled the replacement literally as
`import { reportJobFailure, attachJobFailureSink } from '../job-failure-sink';`. Only
`reportJobFailure` is actually imported. `attachJobFailureSink` is never *called* by
`worker/__tests__/job-failure-sink.test.ts` — title 25 verifies the wiring by reading
`worker/index.ts` as source text, not by invoking the attach helper — and
`@typescript-eslint/no-unused-vars` is registered at `error` for `**/*.ts` with no test
exemption (`eslint.config.mjs:120-127`; the test-file `ignores` at `:169/:184/:222/:242` apply to
the structural `no-restricted-imports` zones, not to this rule). Importing the second name would
therefore have turned `pnpm lint` red.

**Why this does not weaken step 3:** the two things step 3 was closing are both gone —
the variable specifier (`JOB_FAILURE_SINK_MODULE`) that resolved oddly under vitest, and the
`as JobFailureSinkModule` cast whose optional-property view hid signature drift (including the
`WorkerLike` stand-in for the real `Pick<Worker, 'on'>`). `JobFailureSinkModule`,
`loadReportJobFailure` and `WorkerLike` are all deleted and nothing replaced the cast. The
static import now type-checks `reportJobFailure`'s real signature at the call sites, which is
the property the seam was hiding. `attachJobFailureSink` is still statically checked — by
`worker/index.ts`, its only production caller.

**Verdict: ACCEPT.** Declining to import an unused symbol is correct — `no-unused-vars` is
error-level with no test exemption, so the brief's literal instruction would have failed `lint`.
Both hazards the conversion existed to remove (the variable module specifier, the `as` cast) are
gone regardless, and `attachJobFailureSink` remains statically type-checked by its only production
caller in `worker/index.ts`.

---

## D10 — the `worker/jobs/` sweep needs `DATABASE_POOL_URL`, not just `TEST_DATABASE_POOL_URL`

**When:** Task 3, step 4 (full verification).

**What:** Step 4 exports only `TEST_DATABASE_POOL_URL` before `pnpm vitest run worker/jobs/`.
That is sufficient for the three eval suites but not for the directory sweep: one pre-existing
sibling, `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`,
exercises the billing status applier through the `@/lib/db/server` singleton and — unlike the
drip integration suite, which points `process.env.DATABASE_POOL_URL` at the test DB in its own
`beforeAll` — never redirects that variable itself. The singleton therefore bound the postgres.js
default, and its tenth case (`subscription-updated holds entitlement first, projects Copilot,
then publisher downgrades`) hung for 30s and died on `ECONNREFUSED …:5432`, reading as
`1 failed | 1066 passed` on an otherwise clean sweep.

**Why this is not Task 3's:** A/B'd against a clean tree — `git stash push` of the two Task 3
files reproduced the identical `1 failed | 9 passed` in that suite, and the failure also
reproduces with the file run in isolation, so it is neither a Task 3 regression nor a
cross-suite interaction. Exporting `DATABASE_POOL_URL` to the same local test DB turns it
10/10 green and the whole directory to **84 files / 1067 tests passed**. Nothing was edited to
achieve that: the gap is in the step-4 command's environment, not in code. CI is unaffected —
it sets `DATABASE_POOL_URL`. Recorded so the next runner of this sweep exports both variables
rather than re-diagnosing a red that is not theirs.

**Verdict: ACCEPT.** Correctly diagnosed as pre-existing rather than assumed — A/B'd against a
stashed clean tree and reproduced in isolation, which is the right standard for "not my
regression." No code was changed to make it pass. It does not reach the verify gate, which runs
the full suite under `REPWORTH_DISABLE_LIVE_DB_SUITES=1` and gives dedicated processes only to
CHANGED integration suites; this one is neither. Promoted to lab notes so the next runner does not
re-diagnose it.

---

## D11 — the refactor made the scheduler's global scan INVISIBLE to `ci:tenant-scope`

**When:** step 5, first verify-gate run (`tenant-scope` FAIL).

**What:** `ci:tenant-scope` reported three **unused** allowlist entries for
`OnboardingDripScheduler.ts` (`accounts`, `businesses`, `onboarding_drip_log`) and — the part
that matters — **no findings at all** for the file.

**Why that combination is the alarming one, not the reassuring one:** the audit recognizes
postgres.js tagged templates only under the tag names it knows —
`tagNames = new Set(['sql', 'tx', 'db'])` plus db/server import aliases
(`scripts/ci/tenant-scope-audit.ts:712`). Task 4 named the injected client **`exec`** (the
plan's own signature said `exec`, while the plan's test step said `db` — the plan was
internally inconsistent and nobody noticed). Under that name the query is not a recognized SQL
tag, so the audit stopped seeing the scan entirely. The entries did not go stale because the
SQL changed; they went stale because **the query vanished from the audit's view**.

The obvious reading of "unused allowlist entry" is "this exemption is no longer needed — delete
it." Doing that would have removed the audit's only record of a deliberate cross-tenant sweep
and left the file permanently unmonitored, with a green gate certifying it. That is a worse
outcome than the red that surfaced it, and it is a **latent trap for any future refactor**:
renaming a `sql`/`db`/`tx` parameter to anything else silently drops that file's queries out of
tenant-scope coverage.

**Fix:** the parameter is renamed `exec` → `db`, with a comment at the signature stating why the
name is load-bearing. Coverage restored: the audit sees the scan again, matches it to the three
entries, and reports `passed — entries: 412 (baseline: 412)` — the same count as before, so
nothing was exempted that was not already exempted.

**Verdict: ACCEPT — and this one nearly shipped as a silent regression, not a gate failure.**
The failure mode deserves restating because the misreading is the natural one: "unused allowlist
entry" reads as "this exemption is obsolete, delete it," and acting on that would have deleted the
audit's only record of a deliberate cross-tenant sweep, leaving the file unmonitored behind a
green gate. The tell was the *combination* — dead entries AND zero findings for a file that
demonstrably scans `businesses` globally. Coverage is restored (`entries: 412`, baseline
unchanged), the parameter name now carries a comment explaining that it is load-bearing, and the
trap is promoted to lab notes. Root cause is a plan defect: plan v2.1 said `exec` in the Task 4
signature and `db` in the Task 4 test step, and neither review round caught the disagreement.

---

## D12 — surface amendment #2 (`scripts/ci/tenant-scope-allowlist.ts`), owner-waived

**When:** step 5, first verify-gate run.

**What:** `scripts/ci/tenant-scope-allowlist.ts` added to `allowed_edit_surface` in both intake
copies, to refresh `ONBOARDING_DRIP_CANDIDATES_SQL` (`:126`). **This is amendment #2**, and
`feature.md`'s step-5 abort criteria name a 2nd amendment as a teardown trigger.

**Why it is unavoidable:** that constant stores the scheduler's candidate query **verbatim**, and
the audit matches on `normalizeSql(stripSqlComments(...))` equality. Rewriting that query IS the
feature (staleness cap, churn cap, `asOf` seam), so the snippet cannot survive it. There is no
code-side workaround: the exemption is keyed on the SQL text itself.

**What was avoided:** the same gate run also failed `static-policy` on a bare
`subscription_status IN ('active','trialing')` literal. That one did **not** need an amendment —
the literal was pre-existing (originally `:40`, allowlisted by file:line in
`static-policy-audit.ts:208`) and merely moved to `:93` when `runOnboardingDripCycle` was
extracted. Rather than relocate the exemption in a second out-of-surface file, the literal was
**deleted**: the status set is now bound from the enum
(`IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.TRIALING})`), which is the repo's
existing pattern (`CancellationGracePoller.ts:48`, `apply-subscription-state.ts:362`) and leaves
one fewer standing exemption than before #719. `static-policy` has no unused-entry check, so the
stale `:40` line is inert. **The amendment is therefore one file, not two.**

That change broke one pre-existing regression guard —
`OnboardingDripScheduler.test.ts`'s `FIX 1: selects trialing accounts …`, which asserted the raw
SQL text matched `/subscription_status\s+IN\s*\(\s*'active',\s*'trialing'\s*\)/i`. Bound values
are invisible to a text regex. The assertion now reads the **bound values** off the mock
(`arrayContaining([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING])`), which is strictly
stronger: loosening the regex to the bare `IN (` alone would have passed against an empty status
set. The guard's intent — trialing is entitled, invariant #11 — is unchanged and better pinned.

**Owner decision (2026-08-09):** presented with three options (minimal amendment + waiver /
re-run step 0 first / abort per the rule) and chose **minimal amendment + waiver**. The teardown
trigger is explicitly waived for this one file. Recorded here because a waived rule that is not
written down is indistinguishable at review time from a rule nobody noticed.

**Amendment count: 2** (D1, D12). A third would need a fresh decision.

**Verdict: ACCEPT (owner-waived).** The waiver is real and recorded, not inferred: presented with
minimal-amendment / re-run-step-0 / abort, the owner chose minimal amendment on 2026-08-09. Two
things keep this honest at review time. First, the amendment is genuinely **one** file — the
`static-policy` half was solved in-surface by deleting the literal rather than relocating its
exemption, which leaves the repo with one fewer standing carve-out than before #719. Second, the
allowlist edit changed a stored SQL snippet and nothing else: `entries: 412 (baseline: 412)`,
same three entries, same `background-global-scan` category, same reason text. No exemption was
widened. **Amendment count is now 2 of a hard limit of 2** — a third needs a fresh decision, and
a reviewer should treat any further out-of-surface need as a stop, not a formality.

---

## D13 — `estimated_prod_lines` was ~3× under (reclassify WARN), owner-waived

**When:** step 5, first verify-gate run — `RECLASSIFY: production 366 > 2x estimated_prod_lines (120)`.

**What:** the intake estimated "±120 production lines changed, net NEGATIVE outside the one new
module". Actual: **366** at first measurement — `OnboardingDripScheduler.ts` 204,
`job-failure-sink.ts` 58, `summary-report-helpers.ts` 40, `OnboardingDripWorker.ts` 38,
`worker/index.ts` 10, `WeeklySummaryWorker.ts` 8, `MonthlyImpactWorker.ts` 8 — rising to **412**
on the green run, the D11/D12 repairs accounting for the difference.

**Why the estimate missed:** it was written as a *net* figure ("net NEGATIVE outside the one new
module") while the gate measures **changed** lines. Extracting `runOnboardingDripCycle` rewrites
the whole function body, which git counts as a delete plus an add — 204 changed lines for what
is, in net terms, a modest addition. The estimate and the metric were never measuring the same
thing. The lesson is about the estimate's UNITS, not about scope creep: no unplanned work
entered the feature.

**Why it was waived rather than escalated:** `feature.md` sends a >2× bucket to "re-run step 0
with the real numbers — the lane was wrong, and the heavier lane's controls exist for exactly
this feature." This feature is already in the **heaviest** lane (RISK = high: dual review,
staging ride, PR + explicit merge approval). Re-running step 0 with 366/1600 re-derives
RISK = high, SURFACE = backend, db_touching = false — the same lane and the same controls. The
rule's purpose is satisfied by the lane already in force. Owner waived on 2026-08-09.

**Carry-forward:** state `estimated_prod_lines` as CHANGED lines, and count a whole-body
extraction at its full size rather than its net delta.

**Verdict: ACCEPT (owner-waived).** The overage is a measurement-units error, not scope creep —
every line changed traces to a task the plan named, and no unplanned work entered the feature. The
waiver rests on a substantive argument rather than convenience: this feature already sits in the
heaviest lane, so re-running step 0 with 412/1600 re-derives RISK = high / backend /
db_touching = false — the same lane and the same controls the rule exists to invoke. **The row
remains WARN, not PASS, on the green gate**, and it should be read that way at review: the gate is
green because the row is advisory and waived, not because the estimate was met.

---

## Step 6 read-back — summary

Thirteen entries, **all ACCEPT, none RE-PLAN**. That uniformity is worth one sentence of scrutiny
rather than being read as a rubber stamp: the RE-PLAN bar is a deviation that invalidates a locked
intake decision, and the one entry that came closest (D3, cutting the `last_error` write) was
checked explicitly against the owner-signed scope and found to be *returning* to it. The two
entries that mattered most are **D5** (the eval that grew 16 → 25 and is the only reason the real
`42703` was ever pinned) and **D11** (the audit-blindness that would have shipped green). Two
carry-forwards for step 7, both already noted inline: independently verify that no dynamic-import
seam or replacement cast survived (D7), and treat the amendment budget as exhausted at 2 (D12).
