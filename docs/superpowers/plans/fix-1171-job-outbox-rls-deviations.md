# Deviations — `fix-1171-job-outbox-rls`

Things the locked intake did not anticipate. One entry per surprise, each
carrying a resolved **Verdict:** before the review wave (step 6 read-back).

Surface amendments: **0**. Every deviation below is a `tests_to_add` retitle or
a within-surface correction, which `intake-contract.md` classifies as a
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
