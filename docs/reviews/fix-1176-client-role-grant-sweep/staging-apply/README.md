# Migration 122 — staging apply, 2026-09-17

- Owner approval: "Go ahead and apply it to staging." (2026-09-17)
- Project: staging Supabase `kubdiqdhqbhwmqfditeg`, PostgreSQL 17 (`server_version_num` 170006)
- Applied by: `psql` connected as `postgres` (`current_user` = `session_user` = `postgres`, owner of all 58 `public` tables)
- File: `supabase/migrations/122_client_role_grant_sweep.sql` at branch HEAD `92bf95797`, byte-identical to the working copy, sha256 prefix `441aac16c3ffe63d`
- Applied: 2026-09-17T13:06:16Z. `psql -v ON_ERROR_STOP=1` exit 0; statements `BEGIN, SET, DO, REVOKE, REVOKE, ALTER DEFAULT PRIVILEGES, DO, COMMIT`.

## 1. Snapshot (rollback source)

`pre-apply-acl-snapshot.txt` — read-only, taken before the apply. Rows:

| Kind | Rows |
|---|---|
| `table` — `anon`/`authenticated` table ACL entries in `public` | 766 |
| `column` — client-role column ACL entries | 12 |
| `default` — every `pg_default_acl` entry, all roles and scopes | 300 |

98 `TRUNCATE` entries = 49 tables × 2 roles, matching the 2026-09-16 baseline. Any migration 123 inverse is generated from this file, never from `GRANT ALL`.

## 2. Preflight — global defaults

| Check | Result |
|---|---|
| Global (`defaclnamespace = 0`) rows for `postgres`, relations, client roles, the four rights | 0 |
| Global rows of any kind | 0 |

PASS. The schema-level entry for `postgres`/`public`/tables held all eight rights for both client roles — the entry 122 edits.

## 3. Post-apply verification (introspection)

| Check | Expected | Result |
|---|---|---|
| (anon, authenticated) × (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) × every `public` table where `has_table_privilege` is true | 0 | **0** |
| Deny-all tables (RLS on, 0 policies) still granting client DML | 0 | **0** |
| Tables with RLS off / total | 0 / 58 | **0 / 58** |
| `authenticated` SELECT on `users` | true | **true** |
| Rolled-back `CREATE TABLE` probe: client roles holding the four rights | 0 | **0** |
| Same probe: client DML rights (2 roles × 4) | 8 | **8** |
| Probe table gone after ROLLBACK | true | **true** |
| `post-apply-acl-snapshot.txt` equals pre-apply minus (the twenty deny-all tables' client entries, the four rights everywhere, the `postgres`/`public`/tables default entries for those rights) | equal | **equal** (1080 → 526 rows, 0 unexpected, 0 missing) |

## 4. Behavior probes

PostgREST with the staging anon key, `GET /rest/v1/<table>?select=*&limit=1`:

| Table | Result |
|---|---|
| `auto_approval_policies` | 401, `42501` permission denied |
| `refusal_events` | 401, `42501` permission denied |
| `solicitation_consent` | 401, `42501` permission denied |
| `users` | 200, `[]` (RLS filters rows; privilege kept) |
| `reviews` | 200, `[]` (RLS filters rows; privilege kept) |

## 5. Worker health

Railway staging `repworth-worker` (deployment `4f51871b`): `SolicitationReleasePoller` completed a cycle at 13:06:50Z, 34 s after the apply. No log lines matching `42501`, `permission denied` or level `error` from 13:00Z to the check.

## Not done here

- The one-hour watch for new `42501` events in Sentry and the staging worker logs — due after 14:06Z, before production.
- A browser owner sign-in on staging. The privilege it needs (`authenticated` SELECT on `users`) is verified above.
- Production. It needs its own approval, the same snapshot and preflight, and then this checklist.
