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

## What was executed on staging (2026-09-08)

Staging only. **Production was read and never written** — no revoke, no flag
flip, no mint. Ordered: dry-run every identity, revoke every identity, flip the
flag, restore the two that stay.

| Step | Evidence |
|---|---|
| Dry runs | All five printed `TARGET: project=kubdiqdhqbhwmqfditeg …` then `DRY RUN (revoke): every refusal check passed; nothing was written`, each naming the `users.id`/`auth_id` this file records. No "auth.users is not readable" warning, so the ban-state probe reached the real schema. |
| Revokes | All five `REVOKED`, exit 0. Read back: `banned_until = 2126-08-15…` (the 100-year ban), `role` still `admin` on every row, exactly one `admin_revoked` audit row each. |
| Idempotency | A second revoke of `mint-admin-smoke-20260907@repworth.net` printed `ALREADY REVOKED … nothing written`, exit 0, no second audit row. |
| Flag flip | `MFA_ENFORCEMENT_ENABLED` `false` → `true` at **2026-09-08T08:57:39Z**, Vercel project `prj_wIMnzHKefoQRdzCeMZesg2mIgNc0`, env-var id `pXwSH5EurhenTy6f`, scoped `target: []` + `customEnvironmentIds: ["env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT"]` — the staging Custom Env and nothing else. That is the ONLY row for this key in the whole project: production has none, so production reads it unset. The Railway staging worker's copy was set to `true` in the same flip for parity (`skipDeploys`), and is inert — the flag has **zero** reads under `worker/**`. |
| Redeploy | Push to `staging` (`8a798628`) auto-deployed the staging Custom Env; that deployment was `READY` before the proof below ran. |
| Restores | `norbertesekiel@gmail.com` and `yoknyei@repworth.net` both `RESTORED`, trail `admin_revoked,admin_restored`, `banned_now = false`, one verified factor each. |
| **The flip, proven behaviourally** | A disposable admin (`mfa-flip-check-20260908@repworth.net`) was minted, given a password, enrolled with a real TOTP factor, then signed in with the password ALONE — `{"currentLevel":"aal1","nextLevel":"aal2"}`. `GET https://staging.repworth.net/admin/overview` with that session: **`307 → /mfa/challenge?next=%2Fadmin%2Foverview`**. The no-session control on the same URL went to `/admin/login?from=…`, so the assertion discriminates. With the flag off, `getAalGate()` returns `ok` before reading anything and that session reaches the page. The disposable identity was revoked immediately afterwards. |

### Final staging admin set

| email | banned | verified factor | audit trail |
|---|---|---|---|
| `norbertesekiel@gmail.com` | no | 1 | `admin_revoked,admin_restored` |
| `yoknyei@repworth.net` | no | 1 | `admin_revoked,admin_restored` |
| `daoni@repworth.net` | **yes** | 1 | `admin_revoked` |
| `gate-a-admin-20260907@repworth.net` | **yes** | 1 | `admin_revoked` |
| `mint-admin-smoke-20260907@repworth.net` | **yes** | 0 | `admin_minted,admin_revoked` |
| `mfa-flip-check-20260908@repworth.net` | **yes** | 1 | `admin_minted,admin_revoked` |

Two admins can sign in, which is what Gate B (#1197) needs. Both hold a verified
factor, so both are challenged at `/mfa/challenge` on their next sign-in — the
intended effect of the flip, not a fault.

## The production plan — NOT executed, each step needs the owner's go

Production holds ONE admin row and it is the owner's own, so the sequence is
short and the owner is both the subject and the approver of every step.

1. `pnpm tsx scripts/revoke-admin.ts --email norbertesekiel@gmail.com --confirm-ref udeyaqnvpojbwgoaxwdg --env production --dry-run`
2. the same command without `--dry-run`
3. flip `MFA_ENFORCEMENT_ENABLED` to `true` in the Vercel **Production** scope —
   **there is no row for the key there today**, so this is a CREATE
   (`POST /v9/projects/prj_wIMnzHKefoQRdzCeMZesg2mIgNc0/env?upsert=true` with
   `target:["production"]`), then redeploy `main`
4. `pnpm tsx scripts/revoke-admin.ts --email norbertesekiel@gmail.com --confirm-ref udeyaqnvpojbwgoaxwdg --env production --restore`

`--env production` reads the AMBIENT environment, never a file in the repo, so
steps 1, 2 and 4 run from a production-scoped shell. Step 3 is what makes the
owner's own production sign-in require the TOTP challenge; the owner must have
their authenticator to hand before step 3, and step 4 must follow step 2 in the
same sitting or production has no admin who can sign in.

## Re-verified against staging with the SHIPPED code

The execution above ran the pre-review-wave script. The review wave changed the
ban-state path substantially (the predicate moved out of SQL into
`classifyBanState`; absence became a refusal; `REVOKE_HORIZON_MS` was added), so
the evidence was re-derived at the final HEAD rather than carried forward. No
staging state changed: three of the four runs are no-ops by design and the
fourth is a dry run.

| check | result |
|---|---|
| dry-run an active admin (`norbertesekiel@gmail.com`) | `DRY RUN (revoke): every refusal check passed; nothing was written.` |
| a 100-year ban (`daoni@repworth.net`) | `ALREADY REVOKED … nothing written.` — the horizon logic reading a REAL `banned_until` of `2126-08-15 08:54:37.317124+00` |
| an active identity restored (`yoknyei@repworth.net`) | `ALREADY ACTIVE … nothing written.` — the NULL `banned_until` arm |
| a production ref without the selector | `REFUSING TO RUN: the --confirm-ref matches a PRODUCTION project ref (udeyaqnvpojbwgoaxwdg), and production was not explicitly selected.` |

Rows 2 and 3 are the ones worth keeping: they exercise the new `banned_until::text`
+ `deleted_at::text` read and the pure classifier against the **real** `auth.users`
schema, which no live-DB suite can reach (the test databases provision schema
`auth` with no `auth.users` relation at all). They also settle empirically that
`Date.parse` handles Postgres's rendering — space separator, six microsecond
digits — which was the review's leading hypothesis for a defect in the fix.

Final staging admin set, re-read afterwards and unchanged: `norbertesekiel@gmail.com`
and `yoknyei@repworth.net` active with 2 reset rows each (`admin_revoked` then
`admin_restored`); the other four banned with 1 row each.
