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

## D16 — 20 sibling tables share the same shape (recorded, not fixed)

Red team found 20 tables on both projects with RLS on, zero policies, and the
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

---

## D18 — RED TEAM ROUND 2: the ACL guard filtered on grantee NAME (P0), plus two P2s

Round 2 confirmed round 1's five findings CLOSED and found three new ones, all
in the D8/D9/D12 fix hunks. This is the round-2 protocol working exactly as
intended: the fixes were the subject, and the fixes carried the defects.

### RT-7 (P0) — `GRANT … TO PUBLIC` sailed past the new guard

**What happened.** D8's replacement filtered on `acl.grantee::regrole::text IN
('anon','authenticated')`. `PUBLIC` is grantee OID **0** and renders as `-`, so
`GRANT SELECT, INSERT ON job_outbox TO PUBLIC` left the suite **6/6 green**
while `has_table_privilege('anon', …, 'SELECT')` returned true. A grant
reaching `anon` through role membership escaped identically. The suite header
positively claimed the opposite.

**Why it graded P0.** Round 2 first graded it P1 on likelihood — neither
project carries a PUBLIC ACL entry today and no repo migration emits one — then
re-graded when the taxonomy refused it: a confirmed, executed, provably
non-equivalent survivor has no non-blocking classification. The correct call.
Likelihood is not the axis; the guard either holds or it does not.

**What changed.** Title 4 now asks the question TWICE, because two rounds
proved either half alone leaves a hole.
- **Arm A** (ACL, `relacl` + `attacl`) now admits `acl.grantee = 0` alongside
  the two named roles. It answers *who is NAMED*, across every privilege type
  and both table and column.
- **Arm B** is new and answers *what the roles can actually DO*:
  `has_table_privilege` for `anon` and `authenticated` over a privilege list
  **derived from `acldefault('r', owner)`**, never spelled. That derivation is
  load-bearing across environments — the local container is PostgreSQL 16
  (7 privilege types) and both Supabase projects are 17 (8, `MAINTAIN` added),
  so a hardcoded list would either miss one there or raise `unrecognized
  privilege type` here. `has_table_privilege` is sound for these two roles even
  though it was the wrong tool for the OWNER: the superuser short-circuit
  behind D8 does not apply to `anon` or `authenticated`, which are NOLOGIN
  non-superuser roles.

**Proof.** The exact round-2 mutation, run against the test container:
`GRANT SELECT, INSERT ON job_outbox TO PUBLIC` → suite **1 failed, 5 passed**.
`REVOKE ALL ON job_outbox FROM PUBLIC` → suite **6/6**. Before the fix the same
mutation left it 6/6.

**Verdict: ACCEPT.**

### RT-8 (P2) — a self-cancelling `DISABLE` was not forbidden

Appending `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY;` passed every
case: the text guard forbade `GRANT`, `CREATE POLICY` and `FORCE`, but not a
`DISABLE` that undoes the file's own `ENABLE`. One assertion added.
**Verdict: ACCEPT.**

### RT-9 (P2) — a GRANT assembled by string concatenation

`DO $$ … EXECUTE 'GRA' || 'NT ALL ON job_outbox TO anon' … $$;` evades both
text checks and really grants `anon` ALL (round 2 verified it on a clone).
No text guard can see it, and D17's belt cannot either.

**Verdict: ACCEPT — and already closed by RT-7's Arm B.** The grant genuinely
happens, so the catalogue sees it once `pnpm test:db:setup` applies the
migration. This is the argument for having a catalogue arm at all: text guards
bound what the file may SAY, and only the catalogue bounds what it DOES.

### RT-6 (P2) — carried forward, confirmed accurately recorded

The sibling tables. Confirmed recorded as a non-goal in D16, nothing more. A
later independent pass re-counted them as 20, not 19, and added that all 20
grant TRUNCATE to `anon`; corrected above.

### What round 2 also proved about the D12 fix

The guarded ALTER is not decoration. Under a concurrent `AccessShareLock`
holder, the guarded file completes in **64 ms**; the same ALTER issued
unconditionally dies at `lock_timeout` after **5090 ms**. Round 2 also
confirmed no NULL hazard (the `::regclass` cast errors rather than returning
NULL), no nested-transaction hazard (14 other migrations wrap, including 116),
and that a behind-head container fails FIRST with the intended
`run pnpm test:db:setup` message.

---

## D19 — FRESH INDEPENDENT PASS (3rd): three more P0s, all in the same artifact

The owner authorised a fresh pass against the fixed tree after round 2's P0 was
closed only by the root's own evidence. It found three P0s, and the pattern is
now the finding: **three passes, three P0s, all in the privilege/text guard,
none in the migration.** Every pass has confirmed the migration itself correct.

### P0-a — a COLUMN grant to a role `anon` INHERITS escaped both arms

**What happened.** Arm A reads `attacl` but filters on grantee NAME, so a grant
to some role `R` is named `R`, not `anon`. Arm B's `has_table_privilege` does
not consider column privileges at all. So the intersection — a column grant to
a role `anon` inherits — was invisible to both. `anon` and `authenticated` are
`rolinherit = true` on the container and on both Supabase projects.

**Reproduced before fixing.** `CREATE ROLE rt_probe_role; GRANT rt_probe_role TO
anon; GRANT SELECT (payload) ON job_outbox TO rt_probe_role;` → Arm A reported
`(nothing)`; the new arm reports `anon | payload | SELECT`. Restored.

**What changed.** **Arm C**: `has_column_privilege` for both client roles across
every column × the column-applicable privileges. The column set is intersected
rather than derived — `acldefault('c', …)` is EMPTY, because columns have no
default privileges — and the four are fixed by the SQL standard while the table
set is not. A count assertion means a PostgreSQL that ever adds a fifth fails
loudly rather than under-covering silently.

### P0-b — `DO $tag$ … EXECUTE 'REVO' || 'KE …' … $tag$;` passed every text check

Two holes at once: `topLevelStatements` masked only UNTAGGED `$$`, and no
guard can match a concatenated identifier. **What changed**: the mask now
handles tagged dollar quotes by backreference, and — the real fix — the suite
forbids `EXECUTE` anywhere in the executable text and pins exactly one `DO $`.
Chasing spellings is unwinnable; bounding the only construct that runs dynamic
SQL is not.

A first attempt matched DO blocks with a backreferenced tag and **collapsed two
blocks into one match**, which would have let an `EXECUTE` in the second block
through. Caught by running it; the assertion no longer depends on that regex.

### P0-c — the phrase guards were whitespace-literal

`/CREATE POLICY/i`, `/FORCE ROW LEVEL SECURITY/i` and
`/DISABLE ROW LEVEL SECURITY/i` ran against raw text, so `CREATE\nPOLICY` —
valid SQL — evaded all three. This is the D17 pattern for the third time: D9
normalised whitespace, RT-8's guards were added later and did not.

**What changed.** A `normalizedSql()` helper collapses whitespace, and every
phrase guard reads it. Fixing that immediately produced its own bug: collapsing
whitespace first removes the newlines `--[^\n]*` needs, so comment stripping
deleted from the first `--` to end of file and every count read zero. It failed
loudly only because `.match()` returns null — **a count-based guard written the
other way round would have passed while checking nothing.** Split into
`normalizedSql()` and `executableSql()`, with the ordering constraint stated on
both.

### The P2s

| # | Finding | Disposition |
|---|---|---|
| a | Arm B fails OPEN if the derived privilege list is ever empty (`acldefault('r',NULL)` → 0 rows → vacuous pass). Unreachable today. | FIXED — asserts ≥ 7 privilege types |
| b | Sibling tables are **20**, not 19, and all 20 grant TRUNCATE to `anon`. | FIXED in D16 |
| c | 55/78 reproduce only under an unstated scope; repo-wide the identifier is in 591 tracked files. | FIXED — scope now stated in both documents |
| d | The registry case asserted on prose (`/[Tt]ransactional outbox/`) rather than membership. | FIXED — asserts the entry exists |
| e | Six OTHER suites (117, 048, 049, 051, 053, 057) repeat the whitespace-literal guard, and no suite reads `118_poller_heartbeats.sql` at all. | **REJECTED for this branch** — outside `allowed_edit_surface`, and fixing six suites is its own change. Carried to the follow-up issue. |

**Verified independently by this pass**: the 54-table drift claim, PostgreSQL 16
(7 privileges) vs 17 (8, `MAINTAIN`) on both projects, zero `from('job_outbox')`
matches, "10 of 11 `SET LOCAL` migrations wrap, 088 the sole exception", and the
lock measurement reproduced at 53 ms guarded vs 5066 ms unconditional.

**Verdict: ACCEPT** (P0-a, P0-b, P0-c, P2-a–d). **REJECT** (P2-e, to the
follow-up issue).

**The honest read.** None of these nine P0s was a defect in what ships to the
database. All were gaps in a test's ability to detect a hypothetical FUTURE bad
migration. The guard is now materially stronger than any sibling suite in the
repo — this pass found the same whitespace weakness in six of them, and found
that migration 118 has no suite reading it at all.

---

## D20 — the guard is rebuilt as APPLY-AND-ASSERT; the text guards are deleted

**Surface amendment #2**, owner-authorised. This trips the workflow's abort
criteria by construction, and the owner took the decision explicitly rather
than the root routing around it.

### Why the approach changed, not just the code

Pass 4's verdict was the finding: *"the approach is wrong, not merely
incomplete — every P0 is a new lexical instance of a defect class a previous
pass already closed (whitespace → `/**/`; comment-order → `--` inside a string;
comment-stripping → comment-as-evidence), and a hand-rolled regex approximation
of a SQL lexer will keep losing to the next construct nobody enumerated."*

Four passes, four defeats of the same idea. The recommendation — execute the
file and assert the catalogue — is what the suite now does.

### What the root verified before accepting the severity

Pass 4 graded three findings P0. The root mutated the migration with pass 4's
own `DISABLE/**/ROW LEVEL SECURITY` vector, re-provisioned, and ran the suite:
`relrowsecurity` came back `f` and title 1 FAILED. So two of the three P0s were
already caught by the catalogue arms, because `pnpm test:db:setup` applies every
migration — the catalogue arms were already apply-and-assert by another name.
Only the `--`-in-string vector hiding a `service_role` revoke was genuinely
invisible, because nothing asserted anything about `service_role` or the owner.
That correction is recorded rather than the pass's grading taken at face value.

### The design

`scripts/ci/live-db-suites-audit.ts` gains one line: the suite joins
`MIGRATION_SHAPE_FILES`, the existing escape for suites where APPLYING the
migration IS the subject (074, 076, 077, 078, 088). It already holds the
cross-process live-DB lock, which is what that allowlist requires and what makes
the ACCESS EXCLUSIVE safe.

The case then: **degrade → prove the degrade landed → apply the file verbatim →
diff the catalogue.**

1. Degrade `job_outbox` to the pre-119 posture — RLS off, client roles holding
   Supabase's defaults — which is exactly what staging carried.
2. Assert the vulnerable state EXISTS. Without this the case passes vacuously
   against a no-op migration, which is the failure mode every earlier form of
   this guard actually had.
3. `db.unsafe(<the checked-in file>)`. No stripping, no rewriting.
4. Assert `rls`, `force`, policy count and client privileges.
5. Assert the owner's and `service_role`'s ACL is **unchanged**.

Step 5 is what dissolves D2. D2 recorded that those roles are
environment-dependent and so "intact" was unassertable from a post-state read —
which is why the guarantee had been pushed onto a text guard in the first place.
With a BEFORE, "unchanged" is a diff rather than a claim.

### Two defects the root found in its own rebuild, by running it

- **`max: 2` broke the apply.** postgres.js refuses a transaction-bearing
  `unsafe` on a pooled client (`UNSAFE_TRANSACTION`), because it cannot
  guarantee the statements land on one backend. Set to `max: 1`.
- **The `service_role` diff was a local no-op.** `service_role` holds nothing on
  this container, so revoking it changed nothing and the P4-1 vector still
  passed 5/5. The degrade now grants `service_role` too, constructing the
  baseline the real projects actually have. Measured: the vector passed until
  that line was added, and fails after it. The `finally` had to gain a matching
  `REVOKE … FROM service_role`, or the grant would outlive the case and leave
  the container holding a privilege it began without.

### Result — every vector from all four passes, re-run against the new guard

| Vector | Origin | Result |
|---|---|---|
| baseline, unmutated | — | **5 passed** |
| `--` in string hides `service_role` revoke | pass 4 P0 | KILLED |
| `DISABLE/**/ROW LEVEL SECURITY` | pass 4 P0 | KILLED |
| `CREATE/**/POLICY` | pass 4 P0 | KILLED |
| `FORCE/**/ROW LEVEL SECURITY` | pass 4 P0 | KILLED |
| comment-as-evidence inside `DO` | pass 4 P0 | KILLED |
| tagged-`$$` concatenated `GRANT` | pass 3 P0 | KILLED |
| `REVOKE` deleted entirely | pass 1 | KILLED |
| column grant to an inherited role | pass 3 P0 | KILLED |

Container verified `true|0` after the matrix; working tree clean.

### What was deleted

`topLevelStatements`, `normalizedSql`, `executableSql` and all four regex
guards. They protected a file that **cannot be edited** — a migration is
immutable once applied, hook-enforced — and three independent passes proved
them unsound. Replacing them with execution is a net deletion.

The DB-free registry case stays: it asserts a registry decision, not SQL text.

**Verdict: ACCEPT.**

---

## D21 — FIFTH PASS: the rebuild was strictly WEAKER off-target than what it deleted

Pass 5 ran against the staging-applied branch. It found that D20's rebuild —
correct on everything it looked at — introduced a regression on everything it
did not.

### P0 — off-target DDL passed

**What happened.** The apply-and-assert case read only `public.job_outbox`. So
migration 119 could harden that one table and do arbitrary damage elsewhere.
Proven: appending `GRANT ALL ON admin_audit_log TO anon;` passed the whole
suite, and the grant really landed on the container. A second mutant,
`ALTER TABLE accounts FORCE ROW LEVEL SECURITY;`, also survived and really set
the flag.

**Why it is mine, not an inherited gap.** The deleted regex guard's blunt
`expect(executable.match(/\bGRANT\b/gi)).toBeNull()` KILLED that exact mutant.
D20 removed it as unsound — which it was, for the widening class it was written
for — and did not notice it was also the only thing watching the rest of the
schema. A fix that is stronger in the direction you are looking can be weaker
in every other direction.

**What changed.** `readSchemaPosture()` snapshots EVERY table in `public` —
`relrowsecurity`, `relforcerowsecurity`, the table ACL, the column ACLs and the
policy count — before and after the apply, and asserts they are identical
except for `job_outbox`. Strictly stronger than the regex ever was: it catches
the EFFECT rather than the spelling, so it also sees a grant written as
`GRA' || 'NT`, one made by a function the migration calls, or an RLS flag
flipped anywhere else.

**Proof.** Baseline 5 passed. `GRANT ALL ON admin_audit_log TO anon` → 1
failed. `ALTER TABLE accounts FORCE ROW LEVEL SECURITY` → 1 failed. Regression
checks still hold: `REVOKE … FROM service_role` → 1 failed;
`GRANT SELECT … TO PUBLIC` → 1 failed. Container verified clean afterwards.

### P0 — the header documented the code it replaced

The suite header still said "No DDL (`ci:live-db-suites` R2)" while the suite
now runs `ALTER`/`GRANT`/`REVOKE`; still named `topLevelStatements` as "the
ONLY environment-independent guard"; still cited a title-3 assertion that no
longer existed; and still claimed "never a silent skip" of cases that sit
behind `describeWithDb`. Rewritten in full. A header that describes deleted
code is worse than no header — it is the artefact a later reader trusts.

**Verdict: ACCEPT** (both P0s).

### The P1s

| # | Finding | Fix |
|---|---|---|
| a | The `finally` unconditionally revoked `service_role`. Measured: on a localhost DB legitimately holding `service_role=arwdDxt` — the posture of BOTH real projects — the suite passed green and left it STRIPPED. `assertLocalTestDatabaseUrl` checks hostname only, so a tunnel or a restored staging dump satisfies it. | FIXED — the restore now reads the posture taken before step 1 and re-grants only what was there. |
| b | The behind-head detector is one-shot: title 3 repairs `job_outbox` itself, so a second run with no re-provision goes green. | ACCEPTED, documented in the header. The signal is real on the first run and names `pnpm test:db:setup`. |
| c | Migration header: "the ALTER is the only lock this migration acquires" is FALSE — `COMMENT ON TABLE` takes `ShareUpdateExclusiveLock`, and on production, where the ALTER is a no-op, it is the ONLY relation lock 119 takes. | Correction recorded in the migrations-log. **The migration file itself is immutable** — it is applied to staging — so the fix is the record, not an edit. |
| d | "the lock is held, so no sibling holds row locks" overstated it: 18 live-DB suites bind `job_outbox` and none takes that lock; the exclusion is vitest's `fileParallelism: false`. No deadlock cycle is reachable; the exposure is a lock-queue stall bounded by `statement_timeout`. | FIXED — the comment now says what actually excludes them. |
| e | `expect(after?.acl_is_default).toBe(before?.acl_is_default)` was a tautology: step 1's GRANT materialises `relacl` and it never returns to NULL, so both sides are always `false`. | FIXED — assertion removed. |

### The P2s

- The guard predicate is schema-qualified (`'public.job_outbox'::regclass`)
  while the three statements it guards are not. Cosmetic given `search_path`,
  and the file is immutable. Recorded.
- The `finally` does not restore from the `before` snapshot wholesale; a failing
  run could leave `force=true` on the container. Loudly caught by the next run's
  title 2. Recorded.
- **Sibling scope, re-measured:** 20 tables on staging and 21 on production
  still carry the pre-119 posture, and `anon` holds TRUNCATE on **49 of 50**
  tables. Far larger than D16's original note. Explicit `non_goals[3]`; carried
  to the follow-up issue with the counts.

### What pass 5 confirmed

The migration is sound — fifth independent confirmation. The staging evidence
reproduces **9 of 9** against the live project, and the applied `COMMENT` is
byte-identical to the committed one (md5 `7b88d544…`, 228 bytes). Production is
confirmed untouched: `anon` there still holds INSERT and TRUNCATE on
`job_outbox`.

**Verdict: ACCEPT.**
