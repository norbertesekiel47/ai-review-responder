# Deviations — feat-632-review-attributed-shadow

Entries the plan did not anticipate. Step 6 reads this end to end before review
and logs an ACCEPT / RE-PLAN verdict on each.

---

## D1 — `attribution_rule TEXT` replaces the intake preview's `attribution_score NUMERIC(4,3)`

**Stage:** planning (step 3), before any code.
**What changed:** the migration-114 column set.
**Why:** the intake question's schema preview was written before the match-rule
fork was answered. The owner then locked the strict two-rule matcher with **no
scored fallback**, so a score column would have shipped with no writer — dead
schema on a table the whole send lane reads. The rule name is what May §6.4's
M3 precision bar will slice by, so it carries the information a score would
have.
**Scope impact:** none. Same column count, same migration, same CHECK arity.
**Verdict:** _pending step 6._

---

## D2 — `attribution_detail` carries no personal data

**Stage:** planning (step 3).
**What changed:** the JSONB evidence shape. No `reviewer_name`, no
`contact_name`.
**Why:** both names already live in their own tables and the owner surface
joins for them. Denormalizing the reviewer name would make it **survive the
review's deletion** — migration 114's FK is `ON DELETE SET NULL`, so the row
persists. That is exactly the retention leak the **Body redaction** discipline
exists to prevent, and it would have created a copy no sweep reaches.
**Scope impact:** none.
**Verdict:** _pending step 6._

---

## D3 — the enqueue guard is time-unbounded, and the payload drops `account_id`

**Stage:** planning (step 3), found by the orchestrator while round 1 ran.
**What changed:** three things in Task 4, all forced by the same reading.

1. The planned guard `sent_at > NOW() - 14 days` is **not** the superset the
   plan claimed. The candidate window is anchor-relative
   (`LEAST(review_date, detected_at)`), so a review posted 13 days ago and
   detected today makes an ask sent 20 days ago a legitimate candidate — while
   the `NOW()`-relative guard is false and no job is ever enqueued. Silent data
   loss. The guard is now `delivery_status = 'sent' AND attributed_review_id IS
   NULL` with no time bound, which is provably a superset of every candidate.
2. That removes the `eligibilityWindowDays` parameter, so
   `src/lib/shared/job-outbox-helpers.ts` needs neither a window constant nor a
   domain import. The layering workaround the plan designed dissolves.
3. `accountId` is not in scope at the enqueue site —
   `src/lib/reviews/process-review.ts` resolves it inside `startReviewRun`
   (line 203), not at the caller. The payload therefore carries `review_id` +
   `business_id` only, and `attributeReview` resolves the account inside its own
   transaction, as `startReviewRun` and `maybeEnqueueFirstReviewIngested`
   already do. Removes any way a wrong account id could ride a payload.

**Scope impact:** net simpler. One fewer parameter, one fewer payload field, one
fewer cross-module import.
**Verdict:** _pending step 6._

---

## D4 — the plan cited `reviewTimeAnchor(sql, 'bare')`; the real signature is `'' | 'r.'`

**Stage:** planning (step 3), cited-artifact check.
**What changed:** the candidate CTE aliases the reviews row as `r` and passes
`'r.'`. `src/lib/kpi/fragments.ts:44` defines `ReviewsPrefix = '' | 'r.'`.
**Why it matters beyond the typo:** the plan had marked this call as unverified
and told the implementer to check it. It was wrong, which is the argument for
keeping that instruction in future plans rather than guessing a signature.
**Scope impact:** none.
**Verdict:** _pending step 6._

---

## D5 — migration 114 must add a per-topic `job_outbox` in-flight index

**Stage:** planning (step 3), cited-artifact check.
**What changed:** migration 114 gains
`job_outbox_solicitation_attribution_inflight`.
**Why:** the `job_outbox` in-flight unique indexes are **per topic**, not
generic — `job_outbox_solicitation_send_inflight` (091:541),
`job_outbox_generate_solicitation_asks_inflight` (091:546),
`job_outbox_solicitation_veto_notice_inflight` (113:24). A new topic with no
index gives the helper's `ON CONFLICT … WHERE topic = … AND status IN (…)` no
constraint to infer, and the INSERT throws at runtime — inside the review-ingest
transaction, which is the one place this feature promised never to break. The
plan had this as an open item; it is now resolved and closed.
**Scope impact:** +6 lines of migration. No change to the migration count or the
in-flight slot.
**Verdict:** _pending step 6._

---

## D6 — the eight parked integration suites carry NO `assertSchemaReady` import

**Stage:** execution (step 4), Task 0.
**What changed:** the plan's Step 2 tells every `*.integration.test.ts` to import
`assertSchemaReady` from `@/lib/shared/__tests__/helpers/schema-ready`. Task 0
did not add that import to the eight suites whose every case is parked.
**Why:** a suite with no runnable body has nothing to guard, and the import would
be unused. `@typescript-eslint/no-unused-vars` is configured as an **error**
(`eslint.config.mjs:122`), so the import would fail `pnpm lint` and take the
gate's `lint` row red — a self-inflicted red that says nothing true about the
code. The plan's instruction is right for a suite that RUNS; it is premature for
one that is entirely parked.
**How the instruction survives:** each of the eight files carries a header
comment naming the exact scaffolding its unparking task must add —
`resolveTestDatabaseUrl` + `describeWithDb`, the cross-process live-DB lock,
`assertSchemaReady`, the shared outreach fixtures — and states that migration 114
is **asserted, never applied**.
**Residual risk:** an unparking task that ignores its own file header ships a
live-DB suite with no schema guard. It then fails loudly against a behind-head
database rather than silently self-healing, which is the documented intent.
`ci:live-db-suites` does not catch it today, because it only scans files that
actually reach the live DB and these do not yet.
**Scope impact:** none. No file added or removed.
**Verdict:** _pending step 6._

---

## D7 — the eval-contract test's COMMENT prose was paraphrased

**Stage:** execution (step 4), Task 0.
**What changed:** the plan's Step 0 code block contains comment lines that
literally spell parked-form names. Those sentences were rewritten to refer to the
forms abstractly. Every line of **executable** code is byte-identical to the plan.
**Why:** the round-4 whole-line comment filter would have dropped those lines
safely, so this is belt-and-braces rather than a correction. It removes the last
way a future edit — moving a comment onto a code line, say — could resurrect the
round-3 false-green. Simulating the check over the real corpus finds 43 parked
forms, all `it.todo`, and zero comment false positives.
**Scope impact:** documentation wording only.
**Verdict:** _pending step 6._

---

## D8 — a `describe('architecture', …)` wrapper around the single `architecture:` title

**Stage:** execution (step 4), Task 0.
**What changed:** the one `architecture:` title sits inside a `describe` group,
for symmetry with its neighbours.
**Why / why it is safe:** title discipline forbids SPLITTING a title across a
`describe` prefix, not grouping. The full promised title stays inside the
`it.todo(...)` string
(`attribution.test.ts:217`), and the verbatim check finds all 54 titles present
exactly once.
**Scope impact:** none.
**Verdict:** _pending step 6._

---

## Open item pinned to Task 1 — `MIGRATION_SHAPE_FILES` enrolment

`src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`
is **not** in `MIGRATION_SHAPE_FILES` (`scripts/ci/live-db-suites-audit.ts:110`).
Every prior migration-shape suite — 074, 076, 077, 078, 088 — **is**.

Task 1 must resolve this **with evidence, not by pattern-matching the precedent**:

- If the suite executes DDL, it needs the allowlist entry, and the audit then
  enforces its cross-process lock enrolment.
- If it only reads — `assertSchemaReady` plus catalogue queries — it must NOT be
  added. The allowlist exists for suites where applying the migration IS the
  subject, and CLAUDE.md's convention is that live-DB suites assert their schema
  rather than apply it.

Decide from what the suite actually does once Task 1 writes its body.

---

## D9 — the consistency CHECK is wrapped in `IS TRUE`

**Stage:** execution (step 4), Task 1.
**What changed:** the plan's bare disjunction became
`CHECK ((attributed_review_id IS NULL OR (…)) IS TRUE)`.
**Why — the plan's SQL had a real NULL hole.** Set `attributed_review_id`,
`attributed_at` and `attribution_detail`, and leave `attribution_rule` NULL.
Then `attribution_rule IN (…)` is NULL, the conjunction collapses to NULL, and
`FALSE OR NULL` is NULL. **A CHECK accepts NULL.** The row is admitted with a
provenance record that names no rule. This is the exact incident the
`new-migration` skill lists, and every neighbouring constraint on this table
(091, 110) wraps for the same reason. Test 2 pins the wrapper, so a future edit
that drops it goes red.
**Scope impact:** none.
**Verdict:** _pending step 6._

---

## D10 — the migration runs inside `BEGIN … COMMIT` with `SET LOCAL lock_timeout = '10s'`

**Stage:** execution (step 4), Task 1.
**Why:** psql autocommits per statement. On a re-run the
`DROP CONSTRAINT IF EXISTS` could succeed and the `ADD CONSTRAINT` fail, leaving
`solicitation_outreach` with **no** attribution constraint at all — 110 documents
this hazard for the identical DROP/ADD pair. `lock_timeout` bounds the ACCESS
EXCLUSIVE acquisition on a hot send table. Note the consequence: the in-flight
index is a plain `CREATE INDEX`, not `CONCURRENTLY`, which cannot run inside a
transaction. That is recorded in the file.
**Scope impact:** none.
**Verdict:** _pending step 6._

---

## D11 — `SchemaRequirement` is declared locally in the migration-114 suite

**Stage:** execution (step 4), Task 1.
**What changed:** the type lives in the suite instead of being exported from
`src/lib/shared/__tests__/helpers/schema-ready.ts`.
**Why:** Task 1's file scope is two files, and moving it would have been an
out-of-surface edit.
**The debt, and who pays it:** `schema-ready.ts` is the single owner of this
vocabulary. **The moment Task 4's
`job-outbox-helpers-attribution.integration.test.ts` needs the same requirement,
the type MUST move into `schema-ready.ts` rather than be copied.** A second local
copy is the drift this project's single-owner rule exists to prevent. The
suite's own docstring says so.
**Scope impact:** one type declaration, temporarily in the wrong file.
**Verdict:** _pending step 6._

---

## D12 — three extra `COMMENT ON COLUMN` statements, and `isPrimary: false` on the second seeded location

**Stage:** execution (step 4), Task 1. Both trivial.
The comments record the `attributed_at` marker rule, D1 and D2 at the schema, so
a reader of the database learns them without the plan.
`businesses_account_primary_uniq` allows one primary per account, and the plan's
fixture sketch did not cover the two-business case the uniqueness test needs.
**Verdict:** _pending step 6._

---

## RESOLVED — the `MIGRATION_SHAPE_FILES` question pinned to Task 1

**Decision: 114's shape suite is NOT added to the allowlist.** Evidence, checked
independently:

- The suite executes **no DDL**. It reads `information_schema.columns`,
  `pg_constraint` and `pg_indexes`, and writes rows under its own seeded tenant.
  No `.unsafe()`, no `readFileSync` of the migration, no `CREATE`/`ALTER`/`DROP`.
- The allowlist is scoped to suites where applying the migration IS the subject
  (`live-db-suites-audit.ts:104-110`). Its five members all execute DDL.
- **The counter-precedent is the stronger one.** 51 migration-shape suites exist
  under `src/lib/shared/__tests__/`. Only 074, 076, 077, 078 and 088 are
  allowlisted. Every read-only migration suite that landed after them — 079, 082,
  090 through 106 — is absent. 114 follows the dominant and more recent rule.
- Adding it would widen a sanctioned-DDL escape hatch over a file needing no
  escape, and enforce lock enrolment as a side effect rather than on its merits.
- `pnpm ci:live-db-suites` passes with the file absent.

The suite still takes `acquireLiveDbLock` — the lock helper would permit skipping
it, and 105 declines on this shape, but the uniqueness case proves a GLOBAL index
and the file's header names the lock. Reversible if the lane's serialization
budget ever matters.

---

## Bookkeeping debt carried to Task 8 — do not skip it

`.claude/reference/migrations-log.md` still reads `Current head: **113**` and has
no 114 entry. **Task 8 Step 3 owns this** and must move the head to 114 and set
next to 115.

Why it matters beyond tidiness: `.claude/hooks/migration-immutability-guard.sh`
reads that head, so **114 is currently unprotected from edits**. That is
convenient while the branch is in flight and unacceptable at merge. **No CI check
ties the log to the migration set** — only the hook reads it — so nothing goes red
if Task 8 is skipped. This paragraph is the only thing standing between that and
a silent miss.

---

## D13 — Task 2 dropped the plan's four module-level imports

**Stage:** execution (step 4), Task 2.
**What changed:** the plan's Step 1 opens `attribution.ts` with
`import type { Sql, TransactionSql } from 'postgres'`, `recordOutcome` from
`@/lib/agents/run-spine` and `reviewTimeAnchor` from `@/lib/kpi/fragments`. Task 2
wrote the module without them.
**Why:** none is referenced by the Task 2 half of the module. They belong to
`attributeReview` and the candidate query, which are **Task 3**. Left in, all
four are unused bindings and `@typescript-eslint/no-unused-vars` — error-level —
fails `npx eslint` on the file. `tsconfig.json` does not set `noUnusedLocals`, so
typecheck would have stayed green and the failure would have been lint-only.
**Task 3 adds them back with their call sites.** Everything else is the plan's
code verbatim, including the combining-mark range in the normalizer's regex,
which is byte-identical to the test file's own oracle.
**Scope impact:** none.
**Verdict:** _pending step 6._

---

## D14 — `ci:directory-map` is RED from Task 2 until Task 8, by plan design

**Stage:** execution (step 4), noticed at Task 2.

`src/lib/solicitation/attribution.ts` is a production file under `src/lib/` with
no row in `docs/directory.md`, so `pnpm ci:directory-map` fails. The plan assigns
both new rows to **Task 8 Step 2**. CLAUDE.md requires the row in the same **PR**,
not the same commit, so the deferral is compliant.

**The cost is signal, not compliance.** A gate row that stays red for six tasks
stops being read. A genuinely different directory-map failure arriving at Task 5
would hide inside the same red row.

**Mitigation, and it is mandatory for every remaining task:** run
`pnpm ci:directory-map` and confirm the failure list contains **only** the known
deferred files. Report immediately if a new path appears or the count changes.
Known deferred, and nothing else may join them without being reported:

- `src/lib/solicitation/attribution.ts` (created by Task 2)
- `worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts` (Task 5)

---

## D15 — Tasks 3 and 4 run SEQUENTIALLY, not concurrently

**Stage:** execution (step 4), orchestrator decision.
**What the plan says:** Task 3 and Task 4 have no blocking edge and touch
disjoint files, so they "may run as concurrent subagents".
**What is actually happening:** they run one after the other.
**Why:** the two agents share ONE worktree, and therefore one `.git/index`.
Concurrent `git add`/`git commit` contend on `index.lock`. The failure is not
silent — the loser sees `Unable to create index.lock` — but it lands inside an
autonomous agent that must then decide what to do, and "retry a git command that
just failed" is not a decision worth delegating. The file-level disjointness the
plan reasoned about is real; the git-level shared resource it did not account for
is also real.
**Cost:** wall-clock only. No correctness or scope change.
**How to actually parallelize, if wall-clock ever matters:** give each task its
own worktree (`isolation: 'worktree'`), which is what makes concurrent commits
safe. That is a heavier setup than this branch needs.

---

## D16 — the plan's SQL comments contained BACKTICKS, which close a tagged template literal

**Stage:** execution (step 4), Task 3. **This is a plan defect four review rounds
did not catch.**

The plan wrote SQL comments like ``-- `attributed_at`, NOT `attributed_review_id` ``
**inside** a postgres.js tagged template. A backtick ends the JS literal.

- In the `UPDATE` it was a hard `TS1005` — loud, caught immediately.
- **In the candidate query it would have silently truncated the SQL and still
  typechecked.** A truncated `WHERE` returns wrong candidates, not an error.

Backticks removed at both sites, with a warning comment left in place. Every
remaining task that copies SQL out of the plan must strip backticks from comments
inside a tagged template.

**Verdict:** _pending step 6._

---

## D17 — four smaller Task 3 corrections

**Stage:** execution (step 4), Task 3.

1. **`o.sent_at` → `o.sent_at::text`.** `CandidateRow.sent_at` is declared
   `string`, but postgres.js decodes bare `timestamptz` to a JS `Date` and
   truncates MICROSECONDS. That value is stamped into `attribution_detail`, so
   `::text` makes the declared type true and honours the µs rule.
2. **Added `AND c.business_id = …`** on the `solicitation_contacts` join.
   Semantically redundant against the join key, but `ci:tenant-scope` reads raw
   template text per table and does not accept a join key as scope evidence.
3. **Rephrased a docstring.** The plan's prose spelled `LEAST(review_date,
   detected_at)` literally, and `src/lib/kpi/__tests__/fragments.test.ts` runs a
   single-owner audit that scans whole source files INCLUDING comments — so the
   plan's own comment turned that suite red. The comment now names the fragment.
   Test files are exempt from that audit, so the phrase is fine inside a suite.
4. **A third fixture, `sibling`.** The plan's isolation shape used two separate
   accounts, which cannot distinguish an account-only scope from a correct one —
   invariant #8's `business_id` half would have been unproven. `sibling` is a
   second, non-primary location under the SAME account holding a perfectly
   matching decoy.

**Worth keeping: the agent ran negative controls.** Swapping both marker sites to
`attributed_review_id` fails title 8; changing the window floor from `>=` to `>`
fails title 3; dropping the `business_id` predicates fails title 16. Each was
reverted. That is evidence the tests bite, not just that they pass.

**Verdict:** _pending step 6._

---

## D18 — the D11 schema-requirement duplication is ACCEPTED, not fixed. D11's instruction is superseded.

**Stage:** execution (step 4), orchestrator decision after Task 3.

D11 said the `SchemaRequirement` work must MOVE into
`src/lib/shared/__tests__/helpers/schema-ready.ts` rather than be copied. Two
facts checked since make that impossible inside this branch:

1. The `SchemaRequirement` **type** is already exported from `schema-ready.ts`,
   so only the **requirement constant** is duplicated. There are now two copies of
   `MIGRATION_114_SOLICITATION_ATTRIBUTION`, in the migration-114 suite and in
   `attribution.integration.test.ts`.
2. **`schema-ready.ts` is NOT in `allowed_edit_surface`.** Reaching it costs the
   SECOND surface amendment — and a second amendment triggers re-classification
   at step 5.

**Decision: do not spend the amendment.** Two test-local constants are minor
duplication. Re-classifying a feature to relocate one constant is a bad trade.

**File as a follow-up:** move `MIGRATION_114_SOLICITATION_ATTRIBUTION` into
`schema-ready.ts` in a small separate PR that can touch that file freely.

**Binding on Task 4:** do NOT create a third copy. If Task 4's suite needs a
schema guard, declare only what that suite actually needs — the `job_outbox`
in-flight index — which is a DIFFERENT requirement, not another copy of the
columns one.

---

## D19 — the plan's helper return check would have been a FALSE GREEN in the mocked suite

**Stage:** execution (step 4), Task 4. **Second plan defect the review rounds missed.**

The plan wrote the suppressed-enqueue check as `inserted.count === 0 ? null : outboxId`.
Task 4 wrote `rows.length > 0 ? outboxId : null`.

In production the two are identical — postgres.js sets both on an
`INSERT … RETURNING`. **In the mocked unit suite they are not.**
`createMockTx()` resolves a bare `[]` with **no `.count` property**, so
`inserted.count === 0` is `undefined === 0`, which is `false`, and the plan's form
**returns an id for the suppressed case**. The test asserting "enqueues nothing
when the business has never sent an ask" would have passed while the helper
reported a write that never happened.

The chosen form also matches the direct neighbour `enqueueSolicitationSend`.

**Verdict:** _pending step 6._

---

## D20 — "every hand-counted assertion shifts" was OVER-BROAD; only the new-review win path moves

**Stage:** execution (step 4), Task 4. This corrects **D6** and the Task 4 brief.

D6 said the new enqueue shifts "every count and index" in
`process-review.test.ts`, naming paths 3, 5, 6 and 7. Task 4 checked each instead
of trusting it. **Only the new-review win branch gains a transaction call.**

- Changed: happy-path new review `5 → 6`, plus five sibling new-review cases that
  each gained a mock. `capturedJsonbPayloads` `toHaveLength(1) → 2`.
- **Deliberately unchanged, each verified as not reaching the new branch:** the
  race-loss path (3), the stale-marking path (7), the flag-off path (6), the
  posted-response path (6), and every `importReview` count.
- `tx.mock.calls[3]` and `capturedJsonbPayloads[0]` are **unmoved**, because the
  enqueue was placed AFTER `maybeEnqueueFirstReviewIngested` rather than before.
  Same transaction either way; the ordering keeps the diff to counts plus
  additions instead of a reindex.
- **No assertion was weakened. No `expect.any` was introduced.** New positive
  assertions were added: `tx.mock.calls[5]` names the topic, and an exact
  `toEqual` on the attribution payload proves ids-only and correlation passthrough.

D6 was right that the task must run the mocked suite. It was wrong about the
blast radius, and checking beat believing.

**Verdict:** _pending step 6._

---

## D21 — the guard's marker is proved TEXTUALLY, not behaviourally. Stated, not papered over.

**Stage:** execution (step 4), Task 4.

Swapping the enqueue guard's marker to `attributed_review_id IS NULL` fails only
the **mocked** helper test, which asserts `not.toContain('attributed_review_id')`.
No integration test catches it. The two markers diverge only **after a review
delete**, and that is the candidate query's territory — already pinned
behaviourally by Task 3's title `attribution: deleting an attributed review does
not make its outreach row eligible for another review`.

So the guard is a lossless superset whose marker choice is enforced by a string
assertion. That is the honest bound. It is acceptable because the guard
over-enqueueing is harmless by design (the matcher owns the window) and the
under-enqueue case is what the integration titles cover.

**Verdict:** _pending step 6._

---

## D22 — three smaller Task 4 choices

1. **Explicit `::uuid` casts** on the `id`, `aggregate_id` and guard `business_id`
   bindings, following `enqueueValidatePlaceId`, the other `INSERT … SELECT`
   helper. The `SELECT` form resolves parameter types before the target columns;
   the value-list helpers do not need this.
2. **D16 applied.** Every SQL comment copied from the plan into a tagged template
   had its backticks stripped. Only `-- topic-audit-ignore: …` survives inside a
   template; the backticked prose moved to the JSDoc above the function.
3. **D18 honoured minimally.** Each integration suite declares a local
   `MIGRATION_114_ATTRIBUTION_OUTBOX_INFLIGHT` naming only the in-flight index — a
   DIFFERENT requirement, not a third copy of the columns one. Migration 114 runs
   in one `BEGIN … COMMIT` and that index is its last created object, so asserting
   it proves the whole file ran.

**Negative controls run and reverted.** Adding a 14-day bound to the guard fails
the out-of-window title, so D3 bites. Removing the `ON CONFLICT … DO NOTHING`
throws `duplicate key value violates unique constraint
"job_outbox_solicitation_attribution_inflight"` **inside the review-ingest
transaction** — D5's hazard is real and the index is load-bearing.

---

## D23 — Task 5 added a subscription guard the plan omitted, and NO promised test covers it

**Stage:** execution (step 4), Task 5. **This is an open coverage gap, not a
closed deviation.**

The plan's Task 5 handler snippet has **no invariant-#11 subscription check**.
CLAUDE.md invariant #11 requires one in every customer-facing worker, so Task 5
added it: `checkSubscription({ status, pastDueAt, accountFlags, workerType:
'summary' })` at `SolicitationAttributionWorker.ts:105`, over a file-local
`businesses ⋈ accounts` read. `'summary'` is the right workerType — the choice
only moves `pending_payment`, which is exempt for `generator` alone and must not
attribute. No raw `=== 'active'` anywhere.

**The gap:** the intake's 54 promised titles contain **no subscription-guard
case**. Grepping them for `subscri|tier|cancel|past_due|trial|pending_payment`
returns one unrelated hit, `attribution: an unsubscribed outreach row is still a
candidate`. The guard is exercised only indirectly, by an `active` fixture
flowing through the real `checkSubscription`.

**Why this matters.** CLAUDE.md's working rules name subscription guards in the
must-test list. A future edit that flips `workerType` from `'summary'` to
`'generator'` would let a `pending_payment` account attribute reviews, and
nothing in the suite would go red.

**Closing it costs one title and no surface amendment** —
`worker/__tests__/**` is already in `allowed_edit_surface`. It does change
`tests_to_add` from 54 to 55, which is an intake change, so it is the owner's
call. **Raised with the owner; see the decision recorded below when it lands.**

---

## D24 — three smaller Task 5 choices

1. **Per-job logger, not the plan's module-level `const logger`.** The plan
   hoisted `createWorkerLogger('solicitation-attribution')` to module scope, which
   drops `correlation_id` from every line. House style — judge, veto-notice, send
   — builds it per job from `job.data.correlation_id`. Followed the house.
2. **`describeResolution` switch replaces the plan's `match.candidateCount ?? 1`.**
   The plan flagged this itself and predicted the compiler would object. It does;
   the switch is the fix. The `attributed` arm reports `candidateCount: 1`, the
   value the plan intended.
3. **No `try/catch` wrapper around the trailing log.** The only post-side-effect
   work is one `logger.log`, and `createWorkerLogger` is already fail-open twice
   over — it catches both the sanitizer and `JSON.stringify`
   (`src/lib/shared/logger.ts:79-95`). A wrapper here could only hide a real
   regression. The reasoning is documented in the handler.

**Also confirmed by inspection:** outbox completion runs as the FIRST statement
inside the same `sql.begin` as `attributeReview`, so a matcher fault rolls the
completion back and the entry stays redispatchable — round-1 finding A1 closed.
Idempotence keys on `job.data.outbox_id`; the integration suite randomises
`job.id` per call so the key under test can only be the outbox id. Both error
hooks are attached by the shared registration loop, and the registration test
asserts the map entry **and** that both calls remain inside that loop body.
