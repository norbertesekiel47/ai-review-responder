# Migration 122 — production apply, 2026-09-17

- Owner approval: "Yes proceed with the remaining steps please." (2026-09-17), after the staging apply and its watch.
- Project: production Supabase `udeyaqnvpojbwgoaxwdg`, PostgreSQL 17 (`server_version_num` 170006)
- Applied by: `psql` as `postgres` (`current_user` = `session_user` = `postgres`, owner of all 58 `public` tables), through the **session** pooler (port 5432)
- File: `supabase/migrations/122_client_role_grant_sweep.sql`, byte-identical to branch HEAD and to the file applied on staging, sha256 prefix `441aac16c3ffe63d`
- Applied: 2026-09-17T14:07:59Z, 62 minutes after staging. `psql -v ON_ERROR_STOP=1` exit 0; statements `BEGIN, SET, DO, REVOKE, REVOKE, ALTER DEFAULT PRIVILEGES, DO, COMMIT`.

## Connection safety (why port 5432, not 6543)

`DATABASE_POOL_URL` points at the **transaction** pooler (6543). A session-level `SET` sent through a transaction pooler can persist on a server connection the application later reuses. The 2026-09-16 posture read used `SET default_transaction_read_only = on` through that pooler. Sentry shows no read-only or permission errors in the following days, so no harm is evident, but every read here instead used `BEGIN READ ONLY … COMMIT` and the session pooler. Lesson promoted to the lab notes.

## 1. Snapshot (rollback source)

`pre-apply-acl-snapshot.txt`, taken read-only before the apply: 766 client-role table ACL rows, 12 client column rows, 300 `pg_default_acl` rows, 98 TRUNCATE entries (49 tables × 2 roles).

**It is byte-identical to staging's pre-apply snapshot**, so both projects started from the same posture and one inverse serves both. Any migration 123 is generated from this file, never from `GRANT ALL`.

## 2. Preflight — global defaults

Global (`defaclnamespace = 0`) rows for `postgres`, relations, client roles, the four rights: **0**. Global rows of any kind: **0**. PASS.

## 3. Post-apply verification (introspection, twice)

Run immediately after the apply and again at 2026-09-18T01:10Z, about 11 hours later. Identical both times:

| Check | Expected | Result |
|---|---|---|
| (anon, authenticated) × (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) × every `public` table | 0 | **0** |
| Deny-all tables still granting client DML | 0 | **0** |
| Tables with RLS off / total | 0 / 58 | **0 / 58** |
| `authenticated` SELECT on `users` | true | **true** |
| Rolled-back new-table probe: four rights / DML | 0 / 8 | **0 / 8** |
| Probe table gone after ROLLBACK | true | **true** |

**Lockstep proven:** the production post-apply snapshot is byte-identical to staging's post-apply snapshot (`post-apply-acl-snapshot.txt` in both folders). Nothing is left behind on either project.

## 4. Behavior probes (production anon key)

| Table | Result |
|---|---|
| `auto_approval_policies` | 401, `42501` permission denied |
| `refusal_events` | 401, `42501` permission denied |
| `solicitation_consent` | 401, `42501` permission denied |
| `users` | 200, `[]` (RLS filters rows; privilege kept) |
| `reviews` | 200, `[]` (RLS filters rows; privilege kept) |

## 5. Soak

The production worker (`repworth-worker`, deployment `07d2a2f4`) logged a `SolicitationReleasePoller` cycle every minute from the apply through 2026-09-18T01:08Z, about 11 hours, with no error, warning, permission-denied or read-only log line. Sentry: no issues at all in the last 12 hours, in either environment. The staging soak (13:06Z → 14:06Z) was likewise clean.

## Rollback

Not needed and not used. If it becomes necessary, migration 123 re-grants exactly the entries in `pre-apply-acl-snapshot.txt` that are absent from `post-apply-acl-snapshot.txt`, with grant options preserved, plus the removed `pg_default_acl` entries.
