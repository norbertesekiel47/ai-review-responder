# Deviations — fix/1301-migration-guard-execution

Every entry is something the intake or plan did not anticipate. Step 6 reads
this file end to end and records a one-line **Verdict:** ACCEPT or RE-PLAN per
entry before any review agent is dispatched.

---

## D1 — one promised test title claimed an assertion the pattern cannot make

**When:** step 3, during the design pass, before any code was written.

**What the intake said.** `tests_to_add` carried
`re-applying 051 restores the guarded indexes and check constraints after they
are dropped`.

**Why it is wrong.** Migration 051's `CHECK` constraints on `source`,
`severity` and `status` are declared inside its `CREATE TABLE IF NOT EXISTS`.
The table already exists at head, so a verbatim re-apply skips that statement
entirely. A degrade that dropped those constraints could never be repaired by
re-applying the file, and the case would fail for a reason that is not a
regression.

**What changed.** The title is now
`re-applying 051 restores the guarded indexes after they are dropped`.
Both intake copies were updated and `.feature/state.json` re-recorded the
arming copy's hash.

**Class.** A `tests_to_add` retitle. Not a surface amendment — the edit surface
did not move, so the amendment counter was not incremented.

**Generalised into the plan.** The same limit applies to 048, 051 and 117: a
verbatim re-apply restores indexes, row security and `GRANT`/`REVOKE`, never
the `CREATE TABLE` body. Each suite states its own limit in its header, the way
`migration-119-job-outbox-rls.integration.test.ts` states its two.

**Verdict:** ACCEPT

---

## D2 — the local PostgreSQL 17 container was added beside the 16 container, not swapped for it

**When:** step 2, setup.

**What the intake implied.** The owner chose "recreate the local test container
on postgres:17", which reads as replacing the existing container.

**What the container actually held.** `repworth-testdb-recovery-20260914`
(postgres:16, port 5499) serves seven databases — `test`, `test_ws4`,
`test_629`, `test_1010`, `test_1011`, `test_1012`, `test_ws5` — for other
worktrees, including the in-flight `fix/batch-e-screens-vs-runtime`. Replacing
it would have broken their gates.

**What was done instead.** A second container `repworth-testdb-pg17`
(postgres:17.11, port 5500, database `test_1301`) runs alongside it. This
worktree's `.env.local` points at it; the previous value is kept at
`.env.local.pg16-backup`. The 16 container is untouched and still serving.
`pnpm test:db:setup` provisioned the new database to head with zero `ERROR:`
or `FATAL:` lines, and migration 122's post-apply MAINTAIN query returns 0.

**Class.** An environment decision that made the owner's choice safe. Strictly
less destructive than what was approved.

**Verdict:** ACCEPT

---

## D3 — the test-line estimate grew 1.8× during plan review, before any code

**When:** step 3, across plan review rounds 1 to 3.

**What changed.** `estimated_test_lines` went 1,250 → 1,700 → 2,100 → 2,250,
and `tests_to_add` went 37 → 51 → 55 → 58. `estimated_prod_lines` did not move.

**Why.** Every increase came from an accepted review finding, not from scope
creep. The three largest:

- **F4** — the self-comparison oracle is circular on a freshly provisioned
  database, so every suite gained a second oracle of pinned literals.
- **F1, across all three rounds** — the vacuity check needed to be per named
  object, with exact-name matching, and with a second polarity for degrades
  that add rather than remove.
- **F10** — 051 needed a real four-table fixture chain, because a row count is
  vacuous on an empty table.

**Why this is recorded rather than acted on.** The re-classification trigger in
step 5 fires when an **actual** bucket exceeds ~2× its estimate. Estimates
moving during review is the review working. The trigger is now measured against
2,250, and if the implemented tests exceed roughly 4,500 lines the run returns
to step 0 with real numbers.

The size axis was re-checked against `execution-lanes.md` § Classification and
stays `standard`: still eight tracers, still one tight surface, no new risk
domain. Nothing here makes it an epic.

**Class.** Estimate correction driven by review findings. Not a surface
amendment; the surface moved once, separately, and is counted as amendment 1.

**Verdict:** ACCEPT

---

## D4 — surface amendment 2 collided with the abort criteria; the owner waived the trigger

**When:** step 4, immediately after T1 completed.

**What happened.** T1 moved the CI and e2e database services to
`postgres:17`. A sweep for every remaining current claim about the major found
five hits. Two were genuinely stale, three were not:

| File | Verdict |
|---|---|
| `src/__tests__/ci-audit-wiring.test.ts:135` | STALE — inside T1's own lease, fixed by a follow-up dispatch |
| `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:14` | STALE — outside the surface; this entry |
| `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:961` | NOT stale — "a reviewer proved exactly that on postgres:16" is a true historical statement |
| `scripts/ci/__tests__/revoke-admin.integration.test.ts:75` | NOT stale — "no GoTrue in a postgres container" holds for any major |
| `scripts/ci/__tests__/mint-admin.integration.test.ts:85` | NOT stale — same |

**The rule conflict.** The 122 suite's header states "the MAINTAIN branch
cannot execute on the PG16 container (`.github/workflows/ci.yml` pins
`postgres:16`)". T1 makes that false, and it is the precise gap #1307 RT-4
closes. `.claude/CLAUDE.md` requires cleaning every cross-reference in the same
change. But that file sits outside `allowed_edit_surface`, and
`/feature`'s abort criteria treat a **2nd surface amendment** as a
stop-patching trigger: postmortem, tear down, restart at step 1.

**Resolution.** Surfaced to the owner with all three options — amend with a
waiver, defer to a follow-up issue, or abort. The owner chose to amend and
waive the trigger. The reasoning recorded with the amendment: the trigger
exists to stop scope creep, and this is one sentence made false by this
branch's own change, not new scope.

**Evidence the fix is correct, not merely plausible.** The 122 suite passes
8 of 8 on the `postgres:17` container. `acldefault('r', <owner>)` there yields
eight privileges including `MAINTAIN`, against seven without it on the
`postgres:16` container. Because that suite derives its revoked-rights set from
`acldefault` rather than a spelled list, the `MAINTAIN` branch is now genuinely
asserted rather than skipped.

**Budget after this.** `surfaceAmendments = 2`, with the 2nd carrying an
explicit owner waiver. `gateFailRounds = 0`. A **third** amendment has no
waiver behind it and returns to the abort criteria as written.

**Verdict:** ACCEPT

---

## D5 — the plan gave the catalogue reader no test of its own

**When:** step 4, T2's spec check.

**What the plan specified.** T2 was to create the harness plus two test files:
a pure file with 14 cases over hand-built `PublicCatalogue` fixtures, and an
integration file with exactly one case, for `withRolledBackTransaction`.

**What that leaves untested.** `readPublicCatalogue` is the most complex
function in the module — seven catalogue dimensions across every table in
`public` — and nothing exercised it against a real database. The subagent
implemented the plan exactly and flagged the gap in its own report. This is a
plan defect, not an execution defect.

**Why it is serious rather than cosmetic.** The pure fixtures are hand-built,
so they cannot detect the reader omitting or mis-rendering a dimension. A
reader that silently dropped `columnComments` would leave all 14 pure cases
green, `ci:live-db-suites` green, and all six migration guard suites blind to
that dimension — each still reporting pass. Three plan-review rounds found this
exact class three separate times (F5 column defaults and comments, F6 policy
definitions, F7 grant options and grantor). The reviewer closed the gaps in the
reader's *specification*; nothing was closing them in its *behaviour*.

**Fix.** One case added to the existing integration file, with the title
`readPublicCatalogue reports every catalogue dimension for a known table`. It
asserts on CONTENT for all eleven `CataloguedTable` fields — never merely that
a field is defined — using `poller_heartbeats` (table comment, column comment,
`now()` default, deny-all RLS, natural-key index, no client grants) and
`flagged_responses` (partial unique index with predicate, plain index, three
CHECKs, five FKs including `ON DELETE SET NULL`). Its teeth are proven by
dropping one dimension from the reader, watching the case fail, and restoring.

**Sequencing.** Run before T3–T8 fan out, not alongside them. Six suites were
about to be built on an unvalidated reader, and finding a defect after six
parallel agents had finished would waste all six.

**Class.** A `tests_to_add` addition. Not a surface amendment — the file was
already in the surface, so the amendment counter stays at 2.

**Verdict:** ACCEPT

---

## D6 — the plan miscounted `flagged_responses`' foreign keys, and the evidence was already in hand

**When:** step 4, the T2 foundation check.

**What the plan said.** T5's oracle A section required pinning "the five
foreign-key definitions including `api_cost_id … ON DELETE SET NULL`", and the
row-preservation paragraph repeated the figure.

**The truth.** Six. `response_id`, `account_id`, `business_id` and `review_id`
are `NOT NULL` with `ON DELETE CASCADE`; `api_cost_id` is nullable with
`ON DELETE SET NULL`; `reviewed_by_user_id` is nullable with no action.
`grep -c REFERENCES supabase/migrations/051_flagged_responses.sql` returns 6,
and `pg_constraint` returns 6.

**Why this one is worth recording rather than quietly fixing.** The correct
count was in a `pg_constraint` query this session ran BEFORE writing the plan
sentence — all six rows were printed and read as five. The plan was not missing
evidence; it misread evidence it had. A pinned-literal oracle written from that
sentence would have asserted five FK definitions and silently ignored
`reviewed_by_user_id`, so a migration that dropped that FK would have passed
the guard.

**The generalisable rule, now stated in the plan.** Read the count from the
catalogue, never from the plan's prose. T5's section says so explicitly, and
`.feature/oracle-a-literals.txt` holds the machine-generated renderings the
suites paste from, so no tracer needs to trust a number typed by hand.

**Class.** Plan correction. Not a surface amendment, not a title change — the
promised titles never named a count.

**Verdict:** ACCEPT

---

## D7 — pinned catalogue literals are coupled to PostgreSQL's deparse output

**When:** step 4, raised by the T2 foundation check as a concern rather than a
defect.

**The trade.** Oracle A's strength is exactness: it pins strings like
`CREATE UNIQUE INDEX idx_flagged_responses_open_response ON
public.flagged_responses USING btree (response_id) WHERE (status =
'open'::text)` and the `users_self_select` policy expression. Those are
PostgreSQL's own deparse renderings, and a future major version may render the
same object differently.

**Why it is accepted, not fixed.** Loosening the assertions to tolerate
rendering drift is precisely the weakening that produced #1171's five failed
red-team passes. Exactness is the deliverable. The maintenance cost is
re-baselining a handful of strings on a major-version bump, and this run has
just demonstrated how: `.feature/oracle-a-literals.txt` is generated by query,
so re-baselining is re-running it, not hand-editing tests.

**What makes it safe today.** Local and CI now run the same major — that is
what T1 delivered — so a rendering difference cannot appear between a
developer's machine and CI. Before T1 it could have.

**Follow-up worth having, not in this run's scope.** A note in
`.claude/reference/lab-notes/live-db-test-suites.md` saying that a CI Postgres
major bump requires re-baselining the pinned catalogue literals, and naming the
query that regenerates them. Step 8's deviations promotion is the right place
for it.

**Verdict:** ACCEPT

---

## D8 — the same text-guard weakness exists in twenty-two suites outside #1301's scope

**When:** step 4, while surveying which suite files existed after three tracers
had landed.

**What the survey showed.** #1301 names seven migrations. The same
`expect(sql).toMatch(...)` text-guard pattern — the one that lost five red-team
passes on #1171 — is also carried by further suites the ticket does not name.

**The first count of this was wrong.** Step 4 said "at least fourteen" and
listed twelve. RT-9 caught it in review round 1. The count is now MEASURED, on
a stated definition: a file under `src/lib/shared/__tests__/` that reads a file
from `supabase/migrations/`, asserts on that text with `toMatch`/`toContain`,
and opens no database (no `postgres(`, no `acquireLiveDbLock`). By that
definition the remainder is **twenty-two**:

`migration-034-structure`, `migration-035-rls-policies`,
`migration-038-structure`, `migration-039-structure`,
`migration-040-rls-tightening`, `migration-043-structure`,
`migration-044-approval-audit-snapshot`, `migration-045-onboarding-demos-rls`,
`migration-046-analytics-events`, `migration-047-backfill-past-due-at`,
`migration-050-structure`, `migration-052-structure`,
`migration-054-structure`, `migration-055-auto-approval-policy`,
`migration-056-account-offboarding`,
`migration-058-offboarding-analytics-events`,
`migration-060-account-offboarding-reactivation-claim`,
`migration-061-remove-sms-schema`, `migration-069-trial-subscription`,
`migration-089-competitor-rival-pick`,
`migration-094-consent-analytics-events` and
`migration-097-suppression-analytics-events`.

`055` and `056` also have an `.integration.test.ts` sibling; only their
`.test.ts` half is counted. **`094` and `097` are themselves named
`.integration.test.ts` and open no database** — a filename pattern is not
evidence of an executing oracle, and a count filtered on the name misses them.
That is how the first survey lost eight of the twenty-two.

Three are worth naming specifically. **035**, **040** and **045** guard RLS
posture — the same security property class as 049, 051, 117, 118 and 119, and
therefore the same blast radius if their guard passes vacuously. The first
survey named two of the three and missed `035`, the largest of them. **046**
created `analytics_events` without RLS in the first place, which is the defect
049 exists to fix.

**Why this is NOT absorbed into this run.** It would roughly triple the diff,
it is not what the ticket asks for, and the abort criteria already flagged one
surface amendment as a stop-and-think point. Widening scope by twenty-two files
on my own initiative is exactly the creep the surface discipline exists to
prevent.

**Why it is recorded rather than left unsaid.** This run builds the harness
(`migration-guard.ts`) and proves the pattern on seven suites. The marginal
cost of converting the remaining twenty-two is now much lower than it was before
this branch, and whoever picks it up should know the harness exists rather than
rediscovering the problem. That is a follow-up issue for the owner to file or
decline, and step 8 is where it gets raised.

**Not a deviation from the plan.** The plan's `non_goals` already says
"Rebuilding migration guard suites outside the #1301 list". This entry records
the scale of what that non-goal defers, which the intake did not quantify.

**Verdict:** ACCEPT

---

## D9 — `DegradeTarget` still permits the weak contract round 2 rejected

**When:** step 4, T5's spec check. Surfaced by T5 reporting that the boolean
call needed `absent: []` to satisfy the type.

**The shipped type.**

```ts
export type DegradeTarget =
  | { table: string; property: 'presence' }
  | { table: string; property: keyof CataloguedTable; absent: readonly string[] }
  | { table: string; property: keyof CataloguedTable; present: readonly string[] };
```

**The hole.** `readonly string[]` admits the empty array. So
`{ property: 'indexes', absent: [] }` type-checks, and
`assertDegradeLanded` then reduces to "the property differs somehow" — which
is EXACTLY contract 2 of the three that §3 records as rejected, and exactly
what round 2 marked F1 PARTIAL. A degrade that dropped one of four indexes
would satisfy it while the other three were never challenged.

**Current call sites are all correct.** Three pass `absent: []`, and all three
are for `rowSecurity`, a boolean with no object list, where the value
comparison alone is the proof:
`migration-048…:161`, `migration-049…:187`, `migration-051…:310`.

So this is a latent hole, not a live defect. It is worth closing anyway,
because the whole point of the `absent`/`present` selectors is to make the weak
form unavailable, and a type that permits it leaves the guarantee resting on
reviewer attention instead of the compiler.

**Fix.** Split the boolean properties into their own variant and require the
object lists to be non-empty:

```ts
type CatalogueListProperty = Exclude<keyof CataloguedTable,
  'table' | 'comment' | 'rowSecurity' | 'forceRowSecurity'>;

export type DegradeTarget =
  | { table: string; property: 'presence' }
  | { table: string; property: 'rowSecurity' | 'forceRowSecurity' }
  | { table: string; property: CatalogueListProperty; absent: readonly [string, ...string[]] }
  | { table: string; property: CatalogueListProperty; present: readonly [string, ...string[]] };
```

`readonly [string, ...string[]]` makes an empty list a compile error, and the
boolean variant removes the need for the `absent: []` placeholder that made the
hole visible in the first place.

**Sequencing.** Deferred until T6 and T8 land. Both call
`assertDegradeLanded`, so tightening the type mid-flight would collide with
their leases. It is then one mechanical pass over the harness and every call
site.

**Class.** A constraint tightening found during execution. Not a surface
amendment; not a title change. It makes an existing contract enforceable rather
than adding a new one.

**Verdict:** ACCEPT

---

## D10 — a deferred foreign key blocks `ALTER TABLE` after seeding, and nothing documented it

**When:** step 4, T6. It was that suite's first real failure.

**What failed.** T6 seeds three `users` rows inside the rolled-back
transaction, then applies migration 053, which runs
`ALTER TABLE users ADD CONSTRAINT users_role_check`. PostgreSQL refused it:

    cannot ALTER TABLE "users" because it has pending trigger events

**Why.** `users.fk_users_account` is `DEFERRABLE INITIALLY DEFERRED`. Every
seeded row queues a deferred FK trigger event, and those events remain pending
until the transaction commits or constraints are set immediate. `ALTER TABLE`
refuses to run against a relation with pending trigger events. Because this
suite's transaction NEVER commits by design, the events would have stayed
pending forever.

**The fix, and why it is not a weakening.** `SET CONSTRAINTS ALL IMMEDIATE`
after seeding, wrapped in a named `settleDeferredFkEvents` helper with a
comment. It forces the deferred checks to run NOW — so the fixture's foreign
keys are genuinely validated rather than skipped, and they pass because every
fixture row leaves `account_id` NULL. It restores the production condition
instead of relaxing it. It is also not a DDL verb, so it adds no
`ci:live-db-suites` finding.

**Why it generalises.** ANY suite that seeds a table carrying a deferred FK and
then applies a migration touching that table hits this. It is invisible from
reading either the migration or the suite: the deferability lives in a third
place, the `pg_constraint` definition. T5 also seeds `users`, but its migration
alters `flagged_responses`, so pending events on `users` never blocked it —
which is exactly why this could have stayed hidden until the next suite that
happened to combine the two.

**Promote at step 8.** This is a lab-note entry, not a deviations-only fact:

`- [2026-09-20] Seeded users rows then applied a migration that ALTERs users →`
`"cannot ALTER TABLE because it has pending trigger events", because`
`users.fk_users_account is DEFERRABLE INITIALLY DEFERRED and a never-committing`
`test transaction leaves its events pending → SET CONSTRAINTS ALL IMMEDIATE`
`after seeding; it validates the FKs rather than skipping them.`

Target: `.claude/reference/lab-notes/live-db-test-suites.md`, plus a dated entry
in the newest `lab-notes/history/*.md` per the "How to add a lab note"
procedure.

**Class.** An implementation obstacle the plan did not anticipate, resolved
without changing any contract. No surface amendment, no title change.

**Verdict:** ACCEPT

---

## D11 — the test bucket hit 2.03× its estimate; the owner waived the re-classification trigger

**When:** step 4, after all eight tracers landed, measured before the gate.

**The measurement**, with workflow artifacts excluded as the intake contract
requires (`git diff --numstat` against merge-base `d79bc765`, classifying
`docs/` and `.claude/` as artifacts):

| Bucket | Estimated | Actual | Ratio |
|---|---|---|---|
| Production code | 60 | **50** | 0.83× |
| Tests | 2,250 | **4,558** (4,301 added, 257 removed) | **2.03×** |
| Docs, plan, review reports | — | 2,431 | excluded |

Production code is four files: `scripts/ci/live-db-suites-audit.ts` (+44, the
seven registry entries), `.github/workflows/ci.yml` (+2), `e2e.yml` (+2), and a
two-line comment in `vitest.config.ts`.

**A first measurement was wrong and is recorded so the method is not repeated.**
The naive `awk` filter used by the workflow's own threshold command classifies
anything not matching `__tests__/|\.test\.|\.spec\.` as production. That
counted the 1,000-line plan, three review reports and this deviations file as
production code, yielding 2,481 — a 41× overshoot. The intake contract says
"Exclude workflow artifacts"; the command does not do that by itself. Any
future run using that command on a documentation-heavy branch must classify
`docs/` and `.claude/` out first.

**Where the test lines went**, largest first: 053 (629, nine cases including
two decoys and three-row DML), 118 (621, eight cases including the default-ACL
challenge), the shared harness (549), 117 (446, seven preserved plus six new),
051 (404, five cases and a four-table row fixture), 057 (360, three tables),
the harness's two test files (654), 048 (277), 049 (212).

**Why the trigger fired and what it means.** The trigger exists to catch scope
creep. Scope did not move: still seven suites and one CI lane, exactly what
#1301 and #1307 RT-4 asked for, and production code came in UNDER estimate.
What grew is depth per suite, and every increment traces to a specific accepted
review finding — oracle A's pinned literals across seven suites (F4),
per-object selectors (F1), a real row fixture instead of a count (F10), two
decoys instead of one (F9), and 118's permissive-default-ACL challenge (F2).

**Why it was surfaced rather than waived silently.** The rule is deliberately
mechanical so that the person who grew the estimate is not the person who
decides the growth was acceptable. Presented to the owner with the measured
numbers and four options — continue and record, re-run step 0, split the
branch, or abort. The owner chose to continue and record.

**Recorded, not just waived.** Both intake copies now carry the measured
`estimated_prod_lines: 50` and `estimated_test_lines: 4558`, so the next
comparison is against reality rather than a stale guess.

**Verdict:** ACCEPT

---

## D12 — closing the D9 hole needed a checked narrowing, and left two sites runtime-checked

**When:** step 4, the D9 fix.

**What shipped.** `DegradeTarget` now carries a selector-free variant for the
boolean properties and requires `readonly [string, ...string[]]` for the object
lists, so an empty selector is a compile error. A runtime guard throws on an
empty list as well, for JavaScript callers and for anyone who casts past the
type. Both halves are load-bearing: the type stops the mistake being written,
the guard stops it being smuggled in.

**The proof the hole was real.** With the new test case added but the type still
`readonly string[]`, `pnpm typecheck` failed with
`TS2578: Unused '@ts-expect-error' directive` — the empty literal type-checked,
so the directive had nothing to suppress. After tightening, the directive is
consumed and typecheck is clean.

**No shipped suite was relying on the weak contract.** Every empty list in the
tree was on a boolean property, where the value comparison is the proof. So
this closed a latent hole, not a live gap.

**The residue, flagged rather than hidden.** Two call sites pass a COMPUTED
`string[]` that a non-empty tuple cannot accept — 048's
`Object.keys(GUARDED_INDEX_DEFINITIONS)` and 117's `clientGrantNames()`. Rather
than cast, the fix added an exported `nonEmptyNames()` helper that throws on
empty: a checked narrowing, not a cast. Those two sites are therefore
runtime-checked rather than statically non-empty.

**Accepted as-is.** Typing those two sources as non-empty tuples at their
definitions would make them static too, and that is a genuine improvement. It
is also a change to two suites' data definitions rather than their call sites,
for a case the runtime guard already covers. Left as a note for the review wave
to weigh rather than actioned unilaterally.

**Also swept:** three suite headers still described the retired `absent: []`
placeholder as the prescribed convention for a scalar property. A comment-only
correction followed, because a header that documents a convention the compiler
now rejects is worse than no header.

**Verdict:** ACCEPT

---

## D13 — two agents reported opposite facts about the same four lines; the tree was broken

**When:** step 4, after the D9 type tightening and the comment sweep.

**The contradiction.** The D9 agent reported that it had removed all four
`absent: []` placeholders — naming `048:167`, `049:184`, `051:307`,
`117:582` — and that `pnpm typecheck` was clean with 48 suite tests passing.
The comment-sweep agent, run afterwards over three of the same files, reported
that three placeholders REMAINED at `049:187`, `051:310`, `117:581` and were
blocking typecheck.

**Ground truth: the tree did not compile.** `pnpm typecheck` returned four
errors:

```
migration-049-…(187,11) TS2353  'absent' does not exist in type
                                '{ table; property: "rowSecurity" | "forceRowSecurity" }'
migration-051-…(310,11) TS2353  same
migration-117-…(565,47) TS2345  '{ property: "grants"; present: string[] }'
                                not assignable to DegradeTarget
migration-117-…(581,11) TS2353  same as the first two
```

Only `048:167` carried the correct selector-free form. The comment agent was
right; the D9 report was wrong on two separate counts.

**The likely mechanism, and why it matters beyond this incident.** The comment
agent edited header prose at `049:179-183`, `051:306-308` and `117:575-578` —
lines IMMEDIATELY ADJACENT to the call sites at `186-187`, `309-310` and
`580-581`. An `Edit` whose `old_string` spanned both, taken from a read that
predated the D9 fix, would correctly update the comment while silently
restoring the pre-D9 call site. The fourth error, `117:565`, was never adjacent
to any comment edit — so that one the D9 agent simply did not fix, despite
listing a nearby line as fixed.

**Two lessons, both already rules that this run can now evidence.**

1. **"Read the diff, not the summary" earns its keep.** The D9 report was
   confident, detailed, internally consistent, and specific about line numbers
   — and claimed a clean typecheck on a tree that does not compile. A root that
   trusted it would have committed a broken branch.

2. **"Comments only" is not a lease boundary.** Six suite tracers with genuinely
   DISJOINT file sets produced no conflict of this kind. Two agents sharing
   three files did, even though the second was restricted to comment text,
   because an `Edit`'s `old_string` can span a boundary that the instructions
   describe but the tool does not enforce. A sweep over files another agent just
   changed should either re-read immediately before each edit, or be merged into
   that agent's own task.

**Promote at step 8.** Lesson 2 belongs in the lab notes as a delegation trap,
not only here:

`- [2026-09-20] A "comments only" subagent silently reverted an adjacent code`
`fix → its Edit old_string spanned comment and call site from a stale read →`
`give sequential agents on shared files disjoint LINE ranges, or fold the sweep`
`into the task that changed the code.`

**Fix.** A narrow repair agent, handed the four verbatim compiler errors with
exact coordinates and told to paste real command output rather than summarise
it. The root re-verifies `pnpm typecheck` independently of its report.

**Class.** An execution defect caught by the root's spec check, not by any
agent's self-report. No contract changed; no surface amendment.

**Verdict:** ACCEPT

---

## D14 — migration 118 does not restore the schema default ACLs, and its suite implied it did

**When:** review round 1, fixing RT-4. Teaching `assertOnlyTablesMoved` to
compare `pg_default_acl` turned an invisible into a failure, and the failure
was not the one expected.

**What the new check found.** 118's off-target case runs a degrade that
performs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
anon, authenticated`, then re-applies 118 and asserts nothing outside
`poller_heartbeats` moved. With `pg_default_acl` now read, the assertion after
the re-apply failed.

**Measured through the whole cycle on PostgreSQL 17.11**, outside the suite:

| Point | `pg_default_acl` for `public` |
|---|---|
| before | empty |
| after the degrade | 8 privileges each for `anon` and `authenticated` |
| after re-applying 118 | **the same 16 entries — unchanged** |

**What it means.** 118's `REVOKE` reaches what its own TABLE inherited from the
permissive defaults, which the case "re-applying 118 revokes every client
privilege inherited from permissive default ACLs" proves directly. The
SCHEMA-level default is a different object, and it is migration 122's subject —
122 removes client-role privileges from the table-owning role's schema-level
default table privileges. 118 never claimed the schema default in its SQL; the
SUITE implied it by asserting "nothing else moved" with a guard that could not
see the one thing that had.

**What changed.** Both `assertOnlyTablesMoved` calls in that case now declare
`{ schemaDefaultAcls: 'changed' }`, with the measurement recorded inline. The
option is not an exemption: `'changed'` THROWS when the default ACLs did NOT
move, so a case claiming a widening must still prove one.

**Not a migration change.** No SQL under `supabase/` is touched, so both
Supabase projects stay in lockstep and no apply is owed. The finding is about
what the suite ASSERTED, not about what 118 does.

**Verdict:** ACCEPT

---

## D15 — the rollback licence is detected, not predicted; the text check was rejected

**When:** review round 1, fixing the adversarial P1.

**The hole.** `withRolledBackTransaction` rolls back by throwing a sentinel
AFTER the callback returns. A migration carrying its own `BEGIN … COMMIT` ends
the wrapper's transaction early, so everything before that `COMMIT` is already
durable when the sentinel fires. Migration 119 carries its own `BEGIN`/`COMMIT`
today, so the condition is one migration away, not hypothetical.

**Why option 1 was rejected.** Triage offered refusing a migration whose text
contains a transaction-control statement. It cannot be written without a SQL
lexer: `DO $$ BEGIN … END $$` is ordinary PL/pgSQL and migration **053 uses
it**, so any `\bBEGIN\b` check refuses a migration this branch guards. A
hand-rolled SQL lexer is the approach that lost five red-team passes on #1171
and that this whole module exists to replace. Shipping one as the fix for a
review finding would have been the branch contradicting itself.

**What shipped.** Option 2. `readLeakSentinel` fingerprints, OUTSIDE any
transaction, the relation set with each relation's kind, ACL and row-security
flags plus every `pg_default_acl` entry. `withRolledBackTransaction` reads it
before and after and throws when it moves. Proven by a case that genuinely
commits — it is the only way to prove a leak detector — under the shared
advisory lock, with a defensive pre-clean and a `finally` cleanup, and it
asserts the container is back where it started.

**Stated bound.** The sentinel does not fingerprint columns, indexes, policies
or rows: a full catalogue read on every call would roughly triple the family's
runtime. A leak large enough to matter moves the relation set or the default
ACLs — the two things 118's own degrade performs.

**Verdict:** ACCEPT
