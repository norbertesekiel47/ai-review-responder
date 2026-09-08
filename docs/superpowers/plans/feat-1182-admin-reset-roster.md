# #1182 — admin roster, both Supabase projects (read-only, 2026-09-08)

Enumerated with the Supabase MCP `execute_sql` against each project, SELECT
only. Nothing was written to either project by the query below.

```sql
SELECT u.id::text, u.email, u.name, u.account_id::text, u.auth_id::text, u.created_at,
       (au.id IS NOT NULL) AS auth_row_present, au.banned_until, au.deleted_at,
       au.last_sign_in_at, au.confirmed_at,
       (SELECT count(*) FROM auth.mfa_factors f WHERE f.user_id = au.id) AS factors_total,
       (SELECT count(*) FROM auth.mfa_factors f WHERE f.user_id = au.id
          AND f.status = 'verified')                                     AS factors_verified
FROM public.users u
LEFT JOIN auth.users au ON au.id::text = u.auth_id::text
WHERE u.role = 'admin'
ORDER BY u.created_at;
```

`users.auth_id` is `varchar` and `auth.users.id` is `uuid`, so the join needs
the explicit `::text` cast on both sides — without it Postgres raises
`42883 operator does not exist: uuid = character varying`.

## Staging — `kubdiqdhqbhwmqfditeg` (RepWorth-staging)

5 admin rows. Every one had `banned_until = NULL`, `deleted_at = NULL` and
`account_id = NULL` at the time of the read.

| # | email | `users.id` | `auth_id` | verified factor | last sign-in | disposition |
|---|---|---|---|---|---|---|
| 1 | `norbertesekiel@gmail.com` | `6b7a3503-1257-4f79-8e5e-6af46527f0a9` | `728769a7-…-40361d1c38ca` | 1 of 1 | 2026-09-07 01:56Z | **the owner** — revoke, then restore |
| 2 | `yoknyei@repworth.net` | `01a0685d-9739-743b-aa69-c8888b455cfc` | `76036fff-…-aa1161908e54` | 1 of 1 | 2026-09-04 22:57Z | **the developer** — revoke, then restore (see the finding below) |
| 3 | `daoni@repworth.net` | `a2053f26-5713-4dad-92b5-737ce786a8bf` | `fba093fc-…-06332c3b46dd` | 1 of 1 | 2026-09-07 18:30Z | revoke, stays revoked |
| 4 | `gate-a-admin-20260907@repworth.net` | `7a5bbf52-456a-453e-bc83-8c1ba278c6aa` | `58e46997-…-90274c584e77` | 1 of 1 | 2026-09-08 05:57Z | revoke, stays revoked — **Gate A e2e fixture, see below** |
| 5 | `mint-admin-smoke-20260907@repworth.net` | `62252ad0-7b25-44f7-b697-c032e995b49b` | `d6751afb-…-448b0070b8ff` | 0 of 0 | never | revoke, stays revoked — #1178's smoke identity |

## Production — `udeyaqnvpojbwgoaxwdg` (RepWorth)

1 admin row. **Read only. Nothing on this project is written in this run.**

| # | email | `users.id` | `auth_id` | verified factor | last sign-in |
|---|---|---|---|---|---|
| 1 | `norbertesekiel@gmail.com` | `01a0596a-4cd3-7248-aa02-27fba8886d5a` | `506fa3c7-…-461b0a80779b` | 1 of 1 | 2026-09-02 05:14Z |

`banned_until`, `deleted_at` and `account_id` are all NULL.

## Findings the roster forces

1. **`yoknyei@repworth.net` already has a staging admin row** (created
   2026-09-03, verified factor, signed in 2026-09-04). The orchestrator's plan
   was to MINT it fresh with `scripts/mint-admin.ts`; that is impossible —
   `mintAdmin` refuses on the read-only pre-check with
   `REFUSED (users_row_exists)` and exit code 3 before any Auth call. The
   developer's account is therefore re-established the same way the owner's is:
   revoke, then `--restore`. Nothing is minted on staging in this run.
2. **The owner's row is unambiguous.** Exactly one `norbertesekiel@gmail.com`
   admin exists on each project, so there is no "which row is the owner's"
   question to escalate.
3. **`daoni@repworth.net` is a live third admin** — created 2026-09-06 and
   signed in 2026-09-07 18:30Z, i.e. the day before this run. The owner's
   decision on #1182 is that every existing admin loses access now, so it is
   revoked and left revoked. Restoring it is one command
   (`--restore --email daoni@repworth.net`).
4. **`gate-a-admin-20260907@repworth.net` is the Gate A (#1196) e2e fixture in
   `RepWorth/admin-app`.** Revoking it turns that CI job red until the identity
   is restored or re-minted. It is revoked, not skipped: Gate B (#1197) proves
   the handshake with the owner's and the developer's accounts, so the fixture
   is not the only path Gate B needs. Restore it with
   `--restore --email gate-a-admin-20260907@repworth.net` when the Gate A job
   is next required.
5. **The production admin set is one row deep**, and it is the owner's own. The
   production plan therefore has no "revoke everyone" step worth batching: it
   is one revoke, one flag flip and one restore, each gated on the owner's go.
