# Deviations — `fix-1171-job-outbox-rls`

Things the locked intake did not anticipate. One entry per surprise, each
carrying a resolved **Verdict:** before the review wave (step 6 read-back).

Surface amendments: **1** (D6, auto-approved: one file inside a tree the
surface already covers). Every other deviation is a `tests_to_add` retitle or a
within-surface correction, which `intake-contract.md` classifies as a
deviations entry rather than an amendment.

---

## D1 — the local test container has no role named `postgres`

**What happened.** The first draft of the privileges case spelled the owner
literally: `has_table_privilege('postgres', 'public.job_outbox', 'SELECT')`.
It failed with `PostgresError: role "postgres" does not exist`. The owner is
`postgres` on both Supabase projects but not in the local container.

**Why the plan missed it.** The intake named `information_schema.role_table_grants`
as the test seam and reasoned about the two Supabase projects, where the owner
is always `postgres`. The local container is the third environment and the only
one the suite actually runs against.

**What changed.** The owner is now DERIVED from the catalogue —
`pg_get_userbyid(cls.relowner)` joined as a subquery — never spelled. This is
strictly better than the original: the property under test is "the role that
owns the table keeps its privileges", not the spelling of its name.

**Verdict: ACCEPT.** The fix removes an environment assumption rather than
adding one. No production code is involved.

---

## D2 — `service_role` privileges are environment-dependent, so the promised title was unassertable

**What happened.** The case then failed a second time. `service_role` holds
Supabase's default table privileges on both projects (introspected 2026-09-07)
and **none** in the local container, because
`scripts/ci/test-db-bootstrap.sql` grants it schema `USAGE` and nothing on any
table.

**Why it matters.** The promised title was *"migration 119 leaves the postgres
owner and service_role privileges on job_outbox intact"*. "Intact" means
"unchanged by this migration", and no single post-state read can establish
that. Pinning either value would encode one environment's accident as a
guarantee — a false green in whichever environment it did not describe.

**What changed.**
1. The `service_role` arms were dropped from the catalogue assertion. The
   guarantee that survives everywhere is the file-text case: exactly one
   `REVOKE` line, naming neither the owner, nor `service_role`, nor `PUBLIC`.
   That is the guard against the dangerous mutation here, which is a WIDER
   revoke rather than a missing one.
2. `tests_to_add[3]` was retitled to *"migration 119 leaves the job_outbox
   owner's privileges intact and denies the client roles"* in both intake
   copies (`.feature/intake.json` and the uncommitted audit copy) plus the
   parent draft.

**Verdict: ACCEPT.** A retitle, not a surface amendment. The invariant
"`service_role` privileges are unchanged" still stands in the intake; it is now
guarded by file text instead of by an assertion that could only be true in one
environment.

---

## D3 — `SET LOCAL lock_timeout` is silently inert in the test-DB apply path

**What happened.** `pnpm test:db:setup` emitted
`WARNING: SET LOCAL can only be used in transaction blocks` for
`119_job_outbox_rls.sql`. `scripts/test-db-setup.sh` applies each migration
file through `psql` outside a transaction block, so `SET LOCAL` warns and does
nothing.

**Why it matters.** `ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY` takes an
`ACCESS EXCLUSIVE` lock on the busiest table in the schema. The lock bound is
the whole reason the statement is there. A bound that vanishes in one
application path is worse than no bound, because it reads as present.

**What changed.** Switched to session-scoped `SET lock_timeout = '5s'`, the
092/101 precedent, rather than the `SET LOCAL` of 088/109/114. The warning is
gone from the provisioning output; 088's own pre-existing warning remains and
is not this branch's.

**Verdict: ACCEPT.** The migration is stricter after the change, and the
mechanism now works in every application path rather than only under
`apply_migration`.

---

## D4 — `assertSchemaReady` cannot gate a migration that creates no object

**What happened.** Migration 119 adds no relation, column, index or constraint.
`SchemaRequirement` has nothing to name beyond `job_outbox` itself, which has
existed since 001, so a container provisioned BEFORE 119 passes the
precondition and the suite then fails on the RLS assertion with a confusing
message instead of an actionable one.

**Why the plan missed it.** The intake modelled the suite on migration 116 and
117, which both create tables. `assertSchemaReady`'s own header names 090 (a
CHECK constraint) as the thinnest case it supports; 119 is thinner still.

**What changed.** No helper change — extending `assertSchemaReady` with an
`rlsEnabled` requirement kind would have needed a surface amendment for a
single caller. Instead the RLS case carries the actionable message itself
(`job_outbox RLS posture is not at migration head — run pnpm test:db:setup`),
and the suite header records why the precondition is weak here.

**Verdict: ACCEPT.** Correct call under "no abstraction before the second use".
If a second object-free migration ever needs the same guard, the helper change
is the right response then.

---

## D5 — the local privilege assertion for `anon`/`authenticated` is vacuous

**What happened.** The local container grants `anon` and `authenticated`
nothing on any table, so the catalogue assertion `anon_select: false` passes
whether or not the REVOKE exists.

**Why it matters.** This is the only case in the suite whose local green does
not prove the thing it appears to prove. Left unstated it would read as
coverage the branch does not have.

**What changed.** Nothing in the code — the vacuity is a property of the
container, not a defect. It is stated three times so a reader cannot miss it:
in the suite header, beside the assertion, and in the migrations-log entry
under "Known limit of the local guard". The REVOKE's real proof is the
file-text case plus post-apply introspection of both Supabase projects,
recorded on the PR.

**Verdict: ACCEPT.** Documented limit, not a silent gap. The compensating
evidence is named and will be produced at the staging and production applies.

---

## D6 — `ci:merge-ledger` requires a file the surface did not declare

**What happened.** The first full gate came back RED on one row:
`merge-ledger-audit: this PR changes 1 production file(s):
supabase/migrations/119_job_outbox_rls.sql, and adds no line to
.claude/reference/arch-review-log.md`. The edit-surface guard then correctly
BLOCKED the fix, because `arch-review-log.md` was not in
`allowed_edit_surface`.

**Why the plan missed it.** The intake was built from the `new-migration`
skill's checklist, which names the migrations-log, the retention table and the
four tenant registries. The arch-review-log row is owed by `/feature` step 8,
not by the migration skill, and no single document names both obligations.
`ci:merge-ledger` is the mechanism that makes the gap visible rather than
silent — it did its job.

**What changed.** `.claude/reference/arch-review-log.md` added to
`allowed_edit_surface` in both intake copies, `bash scripts/feature-state.sh
incr-amendment` run (`surfaceAmendments=1`), and the pre-merge entry written.

**Verdict: ACCEPT.** Auto-approved under the amendment rule: ONE file, inside
`.claude/reference/`, a tree the surface already covers via
`migrations-log.md`. No owner sign-off required, and the amendment budget now
stands at 1 of 2.

---

## D7 — both diff buckets exceeded 2× their estimate; step 0 re-run

**What happened.** The gate's `reclassify` row fired WARN:
`production 146 > 2x estimated_prod_lines (45); test 255 > 2x
estimated_test_lines (90)`. Measured split at the merge base:

| Bucket | File | Lines |
|---|---|---|
| production | `supabase/migrations/119_job_outbox_rls.sql` | 92 |
| production | `.claude/reference/migrations-log.md` | 54 |
| production | `.claude/reference/arch-review-log.md` | 1 |
| test | `migration-119-job-outbox-rls.integration.test.ts` | 255 |

**Step 0 re-run, per the re-classification trigger.** SIZE measures
implementation BREADTH, and the breadth did not move: three effective SQL
statements in one file, one new test file, two documentation entries, one seam,
zero production TypeScript, no dependency, no flag. The overrun is
documentation density, which house style mandates rather than tolerates — 117's
migrations-log entry runs 40 lines and 118's runs 33, and roughly 78 of the
migration's 92 lines and 110 of the suite's 255 are header comment carrying the
provenance, the FORCE trap and the three stated limits. Estimating 45/90 was a
failure to budget for that, not evidence of a larger change.

**Outcome: classification UNCHANGED — `small` · `high` · `backend`.** The lane
does not move, so no work is redone. `estimated_prod_lines` and
`estimated_test_lines` were corrected to 150 / 260 in both intake copies so the
record matches the measurement, and the correction is logged HERE rather than
made silently — an estimate quietly rewritten to match its own actual is the
one move that would make this trigger worthless.

**Verdict: ACCEPT.**

---

## D8 — the privilege assertion could not fail: the container owner is a superuser (RED TEAM P0)

**What happened.** Red team ran `REVOKE ALL ON job_outbox FROM <owner>` against
a throwaway clone. `relacl` became `{}`. The test still **PASSED**. The local
and CI table owner is the bootstrap superuser (`POSTGRES_USER: test`,
`.github/workflows/ci.yml:251`), and `has_table_privilege` is unconditionally
true for a superuser.

**Why it is a P0 and not a nit.** D2 had already dropped the `service_role`
arms. That left the owner arms as the suite's ONLY detector of a widened
REVOKE, and `ci:rls-audit` does not cover this table. So the branch's stated
guard for its own most dangerous mutation did not exist. Worse, the comment
beside it asserted the opposite in as many words: "NOT vacuous on any
container". D5 and the migrations-log "Known limit" paragraph both omitted it.

**What changed.** The case was rewritten around `pg_class.relacl` and
`pg_attribute.attacl` read through `aclexplode`, asserting that `anon` and
`authenticated` appear NOWHERE — table or column, every privilege type. The
ACL is the ground truth a superuser's implicit privileges cannot mask. The
owner and `service_role` arms are gone entirely; their guarantee now lives in
D9's exact-match statement assertion, which holds in every environment. The
case was retitled to match what it actually proves.

**Proof, not assertion.** Measured on the test container:
`GRANT TRUNCATE ON job_outbox TO authenticated` → old form returns `f, f` and
passes; new form returns `authenticated | TRUNCATE | table` and fails. The
grant was restored.

**Verdict: ACCEPT.** Found independently by three axes — red team by mutation,
Codex via TRUNCATE, spec-and-correctness via the 117 precedent's four verbs.

---

## D9 — the file-text guard counted line starts, not statements (RED TEAM P1)

**What happened.** The regex was `/^\s*REVOKE\b.*$/gim`, then a negative list
forbidding `postgres|service_role|PUBLIC`. Red team appended
`SELECT 1; REVOKE ALL ON job_outbox FROM service_role;` to an existing line and
survived BOTH guards. The standards axis separately noted the negative list was
case-sensitive, missing `SERVICE_ROLE`, `Postgres` and lowercase `public` — 3
of 5 realistic mutations.

**What changed.** Two corrections, both structural rather than patched.
1. The file is now parsed into top-level STATEMENTS (dollar-quoted bodies and
   string literals masked, line comments stripped, split on `;`), so a second
   statement sharing a line cannot hide.
2. The revoke is pinned by EXACT match —
   `/^REVOKE ALL ON job_outbox FROM anon, authenticated$/i` — not by a list of
   forbidden names. A negative list must anticipate every spelling; an exact
   match admits one statement and cannot be widened at all. A `GRANT`-free
   assertion was added alongside, closing the re-grant path Codex named.

**A bug in the fix, found by running it.** The first parser masked string
literals BEFORE stripping comments, so prose apostrophes in the 80-line header
("the table's owner", "Supabase's") read as string delimiters and swallowed
every statement between two of them. It found ZERO revokes in a file that
plainly contains one. Order corrected, and the constraint is now a comment on
the helper, because it reads as arbitrary otherwise.

**Proof.** All six mutations killed, unmutated passes: same-line second REVOKE,
`SERVICE_ROLE`, `Postgres`, lowercase `public`, appended `GRANT`, deleted
REVOKE.

**Verdict: ACCEPT.**

---

## D10 — "production has run this exact posture" was false (FOUR AXES)

**What happened.** The migration header, the migrations-log entry and the
arch-review-log entry all leaned on production having run "this exact posture"
without incident for five months, and called it the strongest safety evidence
the change has. Production has run the RLS half only: `anon` and
`authenticated` hold `arwdDxtm` there today (introspected). The post-119
posture has run in NO environment.

**Why it matters.** The claim covered the ALTER and silently extended itself to
the REVOKE — the statement carrying whatever residual risk this migration has.
The branch's own `edge_cases[1]` said the REVOKE was a real production change,
so the file contradicted itself.

**What changed.** All three documents now state plainly what the five months
does and does not cover, and name the REVOKE as the risk-bearing statement.

**Verdict: ACCEPT.** Standards, database/security, red team and Codex reached
this independently. A claim four reviewers kill is not a wording nit.

---

## D11 — the rollback plan would have left production LOOSER than before

**What happened.** The plan said: migration 120 with
`DISABLE ROW LEVEL SECURITY` plus `GRANT SELECT, INSERT, UPDATE, DELETE`.

Two defects. It restores 4 of the 8 revoked privileges (omitting TRUNCATE,
REFERENCES, TRIGGER, MAINTAIN). And `DISABLE ROW LEVEL SECURITY` applied to
production drops it BELOW its pre-119 baseline, where RLS was already on —
executing the rollback would manufacture the staging vulnerability on
production, mid-incident, which is the exact outcome migration 107 refused to
ship.

**Root cause.** The plan was written as if the two projects shared a baseline.
They do not: prod is RLS-on + full ACL, staging is RLS-off + full ACL.

**What changed.** `rollback_plan` is now per-environment in both intake copies.
Production: `GRANT ALL` and leave RLS **enabled**. Staging: `GRANT ALL` plus
`DISABLE ROW LEVEL SECURITY`. Staging first, as always.

**Verdict: ACCEPT.** Found by database/security and red team independently.

---

## D12 — the ALTER is not a lock-free no-op on production

**What happened.** The header claimed "The ALTER is a no-op on production
(already enabled)". False at the lock level: `ATExecSetRowSecurity` has no
early-out and `AT_EnableRowSecurity` takes `ACCESS EXCLUSIVE`, so the statement
would block every write to the busiest table in the schema for up to the
`lock_timeout`, in exchange for updating `pg_class` to the value it already
holds. `REVOKE` takes no relation lock, so the ALTER was the migration's only
lock.

**What changed.** The ALTER is now issued inside a `DO` block guarded on
`relrowsecurity`, which makes the file a true no-op on production rather than
an aspirational one. The header states the mechanism and records that an
earlier draft claimed the property while issuing the statement unconditionally.

**Verdict: ACCEPT.** Codex and database/security both found it.

---

## D13 — the `SET LOCAL` deviation (D3) drew the right fix from the wrong reason

**What happened.** D3 observed the `SET LOCAL can only be used in transaction
blocks` warning and concluded session-scoped `SET` was the house answer, citing
092/101 over 088/109/114. Measured: 109 and 114 both wrap in `BEGIN;`/`COMMIT;`
where `SET LOCAL` is fully effective, as do 10 of the 11 `SET LOCAL`
migrations. **088 is the sole unwrapped file and the only source of the
warning.** D3 read one outlier as the rule.

**What changed.** The migration now wraps in `BEGIN`/`COMMIT` with `SET LOCAL`,
which is strictly better than either earlier form: the timeout works, no
session GUC leaks, the lock window is minimal, and — the part neither D3 nor
its fix had — **the ALTER and the REVOKE become atomic**, closing the tear
Codex named where a failure between them leaves row filtering on with the
client grants still live.

**Verdict: ACCEPT.** D3's verdict stands as a record of what was believed at
the time; this entry supersedes its reasoning and its fix.

---

## D14 — smaller corrections, grouped

Each accepted, each one edit, none changes behaviour.

| # | Finding | Fix |
|---|---|---|
| a | "78 production files bind it" is an `rg -c` file count; only **55** contain a SQL binding. That number is the evidence for keeping `job_outbox` out of `TENANT_TABLES`, so it must be the number actually measured. | Corrected in all four copies. Conclusion unchanged — 55 bindings is still decisive. |
| b | The `SchemaRequirement` was vacuous and its comment named a "provisioning-marker path" `assertSchemaReady` does not have (`test_meta.provision` is read only by `scripts/ci/rls-audit.ts`). D4 also claimed there was no house answer. There is: `schema-ready.ts` records that migration 097 "gets no requirement of its own … its suite inspects the migration SQL text instead". | Requirement and call deleted. D4's framing superseded. |
| c | The FORCE-off case is vacuous against reversion (`relforcerowsecurity` defaults false) and was absent from the declared limits. | Stated in the suite header and the migrations-log limits paragraph. It guards a future statement, not this migration having run. |
| d | `test_seams[2]` named `information_schema.role_table_grants`; the suite used `has_table_privilege()`, unrecorded. | Moot after D8 — the seam is now `relacl`/`attacl` via `aclexplode`, and `test_seams` records it with the reason. |
| e | The new arch-review-log entry had no blank line before it and rendered glued to its neighbour. | Blank line added. |
| f | The suite header was a fourth verbatim copy of the drift narrative already owned by the migration header, migrations-log and arch-review-log; 116 and 117 do not restate their migration's rationale. | Trimmed to one sentence plus a pointer. |
| g | `COMMENT ON TABLE` restated invariant #2 and the registry decision, both owned elsewhere and liable to go stale. | Cut to the posture facts only. |

**Verdict: ACCEPT** (all seven).

---

## D15 — REJECTED: add a `job_outbox` row to `docs/security/rls-inventory.md`

**The finding** (database/security, low, raised for "knowing re-confirmation"):
the RLS register gains no row for the dispatch spine, while `admin_audit_log` —
the precedent this branch cites four times — is listed there in 119's exact
shape.

**Verdict: REJECT.** Three reasons, in order of weight.

1. It is an explicit `non_goals` entry, taken as an owner decision on
   2026-09-07 after measurement. Reversing it inside the review round would be
   the root overriding the owner on the branch's central scoping call.
2. The register's own preamble scopes its rows: entries are listed "(and in
   `TENANT_TABLES`)" so the audit keeps RLS on them. `job_outbox` is
   deliberately not a member, so a row there would assert a membership the
   branch spent its main decision avoiding.
3. It would spend the final surface amendment (1 of 2 used) on a documentation
   row.

**Not dismissed** — carried to the follow-up issue alongside D16, where the
register and the audit can be reconciled together rather than half-done here.

---

## D16 — 19 sibling tables share the same shape (recorded, not fixed)

Red team found 19 tables on both projects with RLS on, zero policies, and the
client grants never revoked — including `auto_approval_policies` and the
run-spine tables. `job_outbox` was distinguished only by having RLS OFF on
staging, which is what made it an incident rather than a latent gap.

Explicit `non_goals[3]`: "Do not REVOKE anon/authenticated on any other
deny-all table. That is a separate reviewed change." Recorded here and carried
to the follow-up issue with the table list.

**Verdict: ACCEPT** (as a recorded non-goal, not as work for this branch).

---

## D17 — the D9 fix created its own hiding place (found by the root, pre round 2)

**What happened.** D9's statement parser masks dollar-quoted bodies so their
semicolons cannot split a statement. The migration now HAS a dollar-quoted body
— the `DO` block guarding the ALTER (D12). So
`EXECUTE 'REVOKE ALL ON job_outbox FROM service_role'` placed inside that block
is invisible to the statement list, and the exact-match assertion never sees
it. Two accepted fixes combined into a new gap that neither had alone.

**What changed.** A second assertion counts `\bREVOKE\b` and `\bGRANT\b` on
comment-stripped text with the dollar-quoted bodies left INTACT: exactly one
revoke, zero grants. The two checks deliberately disagree about what to mask,
so no construct is invisible to both.

**Proof.** `EXECUTE 'REVOKE … service_role'` inside the DO block → 2 revokes,
fails. `EXECUTE 'GRANT SELECT … TO anon'` inside it → 1 grant, fails.
Unmutated passes. Suite 6/6.

**Verdict: ACCEPT.** Recorded because the lesson generalises: a mutation-proof
guard and a lock-scoping fix were each correct in isolation, and their
interaction was the defect. Round 2 was dispatched against the fixed tree, so
this is a finding the branch caught on itself rather than one round 2 had to.
