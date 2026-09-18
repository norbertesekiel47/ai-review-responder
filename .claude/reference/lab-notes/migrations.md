# Lab notes — Indexes / migrations

## Summary

- **Indexes / migrations** — **"Migration lockstep audit" (2026-08-14) is the entry point for "is migration N applied in env X?"** — there is no ledger, three docs asserted the opposite of reality for 077, migration 005 sat unapplied in prod for ~4 months undetected, and `ci:rls-audit` is a floor that cannot see unrequested RLS (prod's `ensure_rls` trigger, removed by 107); it also carries the re-runnable introspection method and its two traps (`DO $$` bodies hide DDL from parsers; a re-ADDed CHECK exists in both envs while differing in content). Also: STABLE-in-predicate, ON CONFLICT byte-for-byte, column-level REVOKE, pg_constraint relation scoping, CHECK passes NULL (pair NOT NULL + NULL-safe preflights), hung ALTER TABLE = lock queue behind a long-lived Supavisor session (cancel stalled backend, verify clean, retry); a hash column's invariant asserted only in a COMMENT is unenforced — pair it with a format CHECK (`token_hash ~ '^[a-f0-9]{64}$'`, migration 056's pattern) and mutation-verify it; `migration-immutability-guard.sh` keys on the migrations-log HEAD rather than "applied", so amending a local-only migration after the log bump is a guaranteed false positive (escape hatch `MIGRATION_GUARD_DISABLE=1` is launch-time only); **verify a migration by introspection and never by reading the terminal** — a `psql -f` that prints NOTHING has not run (a silent quoting failure was reported as success at #629, 2026-08-17), and on PRODUCTION prefer **definition-equivalence against an already-probed twin** (`pg_get_constraintdef` byte-identical to staging's) over re-probing, since an INSERT in a rolled-back transaction is still a write; a constraint probe's `check_violation` handler catches whichever CHECK fires FIRST, so enumerate `pg_constraint … contype='c'` and satisfy every SIBLING check before trusting a rejection (a wrong-constraint rejection flatly contradicted `pg_get_constraintdef` at #629), suppress FKs with `SET LOCAL session_replication_role = replica`, and prove BOTH directions or you have shown permissiveness rather than widening; a `CROSS JOIN LATERAL (SELECT EXISTS (…))` consumed by two `COUNT(*) FILTER`s does NOT share one evaluation — Postgres pulls the single-row LATERAL up and plans one correlated SubPlan per reference (~81–261× planner cost, ~137× buffers vs `LEFT JOIN … AND status='posted'` + `FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`, which is the shape that ships), and never justify a SQL shape with an unverified planner claim in a comment (#731, 2026-08-09) **A new tenant table forces a FOUR-registry chain (2026-08-30, #1008)**, and Postgres always deparses an implicit `CASE` fall-through as `ELSE NULL::boolean` — assert its PRESENCE, never its absence. **A migration's guard suite must EXECUTE the file, never parse it (2026-09-07, #1171)** — five red-team passes found nine P0s in a regex guard and none in the migration, each fix closing one lexical class before the next pass found another (`SELECT 1; REVOKE …` on one line, `CREATE\nPOLICY`, `DISABLE/**/ROW LEVEL SECURITY`, `--` inside a string literal, a comment as evidence, `'GRA' || 'NT'` in a `DO` block); the shape that holds is `MIGRATION_SHAPE_FILES` + degrade → assert the degrade landed → apply verbatim via `db.unsafe` → diff the catalogue, snapshotting EVERY `public` table because a case reading only its own lets `GRANT … ON <other table>` pass. And **"unchanged" needs a BEFORE**: `has_table_privilege` is unconditionally true for a superuser (the CI owner IS one), `aclexplode` on grantee NAME misses `PUBLIC` (OID 0) and role inheritance, `has_table_privilege` never sees column grants, and `TRUNCATE` is exempt from row policies entirely — derive privilege lists from `acldefault('r', …)` since the container is PG16 (7 types) and both projects are PG17 (8).

## Canonical entries

## 2026-08-14 — migration lockstep audit: staging vs prod

### Migration lockstep audit

Triggered by sessions repeatedly contradicting each other on "is 077 applied in
prod?". Full probe of both Supabase projects (staging `kubdiqdhqbhwmqfditeg`,
prod `udeyaqnvpojbwgoaxwdg`) against all 107 migration files. Result: staging at
head; prod missing **005** (unknown drift), **078** (by design), **105** (held on
a premise that had already expired).

- **[2026-08-14] Three docs asserted 077 was absent from prod → it had been
  applied for weeks → never state an environment's schema state from a doc;
  introspect it.** `.claude/CLAUDE.md`, `migrations-log.md` and
  `ws8-tier-cutover.md` §5 all kept saying "deliberately absent". Every session
  that trusted them inherited a false premise, and every session that checked the
  DB disagreed — that oscillation was the reported symptom, not a memory bug.
  **The prod cutover is executed through §5; resume at §6.** The lesson stands;
  its stated cause did not — see the correction below.

- **[2026-08-30] The 2026-08-14 audit wrote "077 landed unrecorded / no evidence
  file records it" → it was recorded, 66 minutes further down the same file →
  read a long evidence file to its END before asserting what it does not say.**
  `docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md` verifies
  `price_variant` **absent** at 01:11:05Z in its "Prod DB findings" section, then
  records 077 **applied and verified at 02:17:11Z** in a later section, plus PR
  #469 merged at 02:40:15Z. The audit stopped at the first read, concluded the
  session had ended there, and re-derived from the database what the record
  already stated — then wrote down that the record was silent. `git log` on that
  file returns one commit (`d1d227e4`) and `git diff d1d227e4 HEAD` on it is
  empty, so the 077 record was present from its first and only commit. The false
  sentence then propagated to six live surfaces before being caught.
  **Two rules:** (a) an evidence file is appended to during a run — its
  chronology runs top to bottom and the outcome is at the BOTTOM, so never quote
  a mid-file reading as the terminal state; (b) "no record exists" is a claim
  about absence — verify it with `git log`/`git diff` on the file, not by reading
  part of it. What was actually true is narrower and is already the standing
  rule: the **Supabase migration-history table** lacks 077 because the SQL editor
  does not write there.

- **[2026-08-30] A launch blocker recorded only in an evidence file vanished for
  six weeks → evidence files are logs, not tracking surfaces → copy every item
  still owed at a pause into `launch-checklist.md` before the session closes.**
  The 2026-07-17 record closed with four "post-merge launch tasks, recorded so
  they don't vanish". Three reached `beta-production-standup.md`. The fourth —
  Stripe live activation, `charges_enabled=false`, "no live payment (incl. prod
  smoke checkout) until complete" — reached no checklist, no phase and no launch
  doc, and would have failed WS8 §6 smoke and the entire beta coupon path with
  nothing predicting it. Caught 2026-08-30 only by reading the predecessor
  evidence file end-to-end during the resume.

- **[2026-08-14] Migration 005 was never applied to prod and nothing detected it
  for ~4 months → there is no migration ledger here, and no CI check compares the
  two databases → the only proof of application is schema introspection, and
  nothing runs it on a schedule.** `review_exceptions.review_id` was still
  `NOT NULL` and `idx_review_exceptions_collision_dedup` absent. That index is the
  exact `ON CONFLICT` target in `worker/jobs/zernio/zernio-ingest-shared.ts` and
  `ingest-failed-hook.ts`, so the Zernio ingest exception path would have failed
  in prod twice over — `42P10` (no index matching the conflict target) and
  `23502` (NOT NULL). It never fired only because the prod worker has never been
  deployed and the table holds 0 rows. **A migration whose objects no later
  migration touches is invisible to every existing gate; only a full catalog diff
  finds it.**

- **[2026-08-14] Prod auto-enabled RLS on every new table for four months and no
  audit could see it → `ci:rls-audit` enforces a FLOOR, not equality → a checker
  that only asserts "required tables HAVE RLS" can never fail on RLS nobody
  asked for.** Prod carried a Supabase-template DDL event trigger `ensure_rls` →
  `public.rls_auto_enable()` firing `ENABLE ROW LEVEL SECURITY` after every
  `CREATE TABLE` in `public`; the staging project, created 8 weeks later, never
  had it. Removed by **migration 107**. Its only surviving output, `job_outbox`
  RLS-on-with-zero-policies in prod, was deliberately left alone (inert — owner
  connection + `service_role` BYPASSRLS; disabling it is a security-loosening
  change that deserves its own migration). **Neither object appeared in any
  migration file, so nothing in the repo explained the difference.**

**Method, if you need to re-run it.** There is no usable ledger — `list_migrations`
does not track the `0xx` series (see the `new-migration` skill). Parse every
migration, replay them in order to compute which objects each one *still owns at
head* (an object a later migration drops or recreates cannot prove its original
author ran), then diff that against a full `pg_class`/`pg_attribute`/`pg_index`/
`pg_constraint`/`pg_proc`/`pg_policy` dump from each database. Migrations with no
surviving structural probe — data backfills, comment-only, `DO $$` bodies, and the
seven successive rewrites of `analytics_events_event_name_check` — need
hand-written probes against constraint *definitions*, column nullability, column
ACLs and row counts. Two traps: a `DO $$ … $$` body hides every DDL statement from
a naive parser (this is why 077/078/105 all read as INDETERMINATE on the first
pass), and a CHECK constraint that is repeatedly DROPped and re-ADDed under the
same name is *present* in both environments while differing in content — compare
`pg_get_constraintdef`, never mere existence.

**Gotcha:** `psql` rejects `?pgbouncer=true`; strip the query string from
`DATABASE_POOL_URL` / `STAGING_DATABASE_POOL_URL` before passing it.

**Gotcha (#1176, 2026-09-17):** `DATABASE_POOL_URL` is the **transaction**
pooler (port 6543). A session-level `SET` sent through it can outlive your
client on a server connection another tenant then gets — a stray
`SET default_transaction_read_only = on` there hands the next caller `25006` on
its writes. Apply migrations and run manual introspection through the
**session** pooler (same host, port **5432**) or a direct connection, and
express read-only intent per transaction (`BEGIN READ ONLY; …; COMMIT;`), never
as a session GUC.

**Lockstep is a BYTE COMPARISON of the two projects, not per-project
verification (#1176).** Per-project checks answer "is this project right?"; they
cannot answer "do the two agree?", which is what lockstep claims. Snapshot the
posture with ONE query per project — every client-role table ACL entry, every
client column entry, every `pg_default_acl` row — and diff the files: 122's
pre-apply snapshots were byte-identical (1080 rows each) and so were the
post-apply snapshots (526 rows each). **Keep the pre-apply file: it is the only
correct rollback source.** A blanket `GRANT ALL` inverse would have WIDENED two
tables, because 055 and 076 had already revoked `authenticated`
INSERT/UPDATE/DELETE on `auto_approval_policies` and `judge_verdicts`.

### Test-DB provisioning: local and CI applied the same "shared recipe" to different schemas

- **[2026-08-14] Two RLS assertions failed locally and passed in CI, and the error
  said the table did not EXIST → the local path drops schema `public` and PG15+
  gives the new one no grant to `PUBLIC`, so `authenticated` could not see any
  relation → restore the grant in the BOOTSTRAP, which is the one file both paths
  run.** `.github/actions/test-db` applies `scripts/ci/test-db-bootstrap.sql` to
  the service container's **pristine** `public`, which still carries Postgres's
  default `GRANT USAGE ON SCHEMA public TO PUBLIC` — so `authenticated` inherited
  USAGE and CI was green. `scripts/test-db-setup.sh` first runs
  `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, which lands at
  `nspacl = NULL`. **Same recipe, different starting schema, different database.**

  The failure mode is what makes it expensive: without USAGE a role cannot see any
  relation, so a table-level privilege probe answers **`42P01` "relation does not
  exist"** instead of **`42501` "permission denied for table"**. Any suite
  asserting the DENIAL MESSAGE (`migration-056-account-offboarding.integration.test.ts`)
  fails locally and passes in CI, which reads as a broken laptop rather than a
  provisioning bug. Attributing it took a full isolation pass — re-provisioning at
  head 106 with the new migration removed to prove the failure was pre-existing.

  **Fix:** the bootstrap now grants USAGE to `PUBLIC` **and** explicitly to
  `anon`/`authenticated`/`service_role`, mirroring a real Supabase project's
  `public` ACL. Redundant no-op on CI's pristine schema, the actual repair
  locally. **ORDER MATTERS in `test-db-setup.sh`:** the reset must come BEFORE the
  bootstrap, or the grant is destroyed again — noted at the call site.

  **Generalise:** when two provisioning paths claim one owner, the owner is only
  real if it is invariant to *where each path starts*. A recipe that assumes an
  untouched schema is not shared with a path that recreates it. And a permission
  bug that surfaces as "does not exist" will be misread as absence every time —
  check `has_schema_privilege(role, schema, 'USAGE')` before believing a `42P01`.

## History

- history/2026-04.md § "Postgres STABLE expressions rejected in partial index predicates"
- history/2026-04.md § "Postgres `ON CONFLICT` must reference partial-index expressions verbatim"
- history/2026-05.md § "Column-level Postgres `REVOKE` does nothing without a table-level revoke first"
- history/2026-05.md § "Migration `034` dropped `users.business_id` outright — no dual-read window"
- history/2026-05.md § "Every public table needs RLS — a new table without it is anon-readable"
- history/2026-05.md § "A `pg_constraint` existence guard must be scoped to its relation"
- history/2026-07.md § "[2026-07-14] A CHECK constraint on a nullable column silently passes NULL — pair NOT NULL with CHECK, and write NULL-safe preflights"
- history/2026-07.md § "[2026-07-14] A hung migration is a lock queue behind a long-lived pooled (Supavisor) session — cancel the stalled backend, verify clean state, then retry staging-first"
- history/2026-08-01-to-07.md § "[2026-08-03] `migration-immutability-guard.sh` keys on the migrations-log HEAD, not on "applied to staging/prod" — so amending a LOCAL-ONLY migration after the log bump is a guaranteed false positive"
- history/2026-08-01-to-07.md § "[2026-08-03] A comment asserting an invariant is not enforcement — and removing a defensive `OR` can HAND BACK tenant-scope allowlist entries"
- history/2026-08-08.md § "2026-08-08 — #680 legacy backfill-counter DROP (migration 103)"
- history/2026-08-08.md § "[2026-08-08] #680 — `SET LOCAL` in a migration is a no-op that only WARNS, because this repo applies migrations one autocommitting statement at a time"
- history/2026-08-09-to-12.md § "[2026-08-09] #731 — a `CROSS JOIN LATERAL (SELECT EXISTS (…))` read by two `COUNT(*) FILTER`s is NOT one shared evaluation"
- history/2026-08-09-to-12.md § "[2026-08-09] #731 — never justify a SQL shape with an unverified planner claim in a comment"
- history/2026-08-09-to-12.md § "The 034 dropped-column class"
- history/2026-08-13-to-21.md § "2026-08-17 — #629 ship: two silent failures, and a probe that lied twice"
- history/2026-08-21-to-31.md § "[2026-08-24] `migration-092`'s EXPLAIN-plan assertion is planner-flaky on a fresh CI database"
- history/2026-08-21-to-31.md § "2026-08-30 — #1008 migration 116 `refusal_events` (five promotions + one corrected)"
- history/2026-08-21-to-31.md § "[2026-08-30] Postgres deparses an implicit `CASE` fall-through as `ELSE NULL::boolean` → assert its PRESENCE, never its absence"
- history/2026-08-21-to-31.md § "[2026-08-30] A new tenant table forces a chain of FOUR registries, discoverable from no single document"
