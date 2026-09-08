# Runbook — minting a RepWorth admin

**Run every command from the repo root.** `.env.local` and `.env.staging.local`
are resolved relative to the current working directory — running from anywhere
else fails or, worse, silently resolves a different file.

**When to use:** you need a new RepWorth admin account (`users.role='admin'`,
`account_id IS NULL`) on staging or, at go-live, on production. This replaces
the hand process recorded at
`docs/runbooks/completed_runbooks/signup-test-runbook.md:25` — create the auth
user in the Supabase dashboard, then insert the `users` row and link `auth_id`
by hand. Never do that again: it half-succeeds, and the database has no
guardrail against two admin identities for one human (`users_email_key` and
`users_auth_id_key` are unique per VALUE, not per person).

**Sibling runbook:** `docs/runbooks/mfa-factor-reset.md` for an admin who has
lost their authenticator. This one creates identities; that one repairs them.

**Removing an admin's access is the other half of this file** — see
§ "Revoking and restoring an admin" below. It is a REVOKE (`scripts/revoke-admin.ts`),
never a row deletion.

## Before you mint

- [ ] The person is authorised to hold RepWorth admin — full access to every
      tenant's data, the impersonation surface, and the admin control plane.
      This is not a reversible convenience.
- [ ] You know which project you mean. `--confirm-ref` must be the FULL
      twenty-character Supabase project ref, and it must match the ref parsed
      out of both the Supabase URL and the database connection.
- [ ] **Production needs TWO independent things, and neither is sufficient
      alone**: the explicit `--env production` selector, AND a matching
      `--confirm-ref`. No other mode can reach a production project, nothing
      defaults to production, and a mistyped ref can never get there — the
      selector is not a value. `--dry-run` works against production too, and
      you should always use it first.
- [ ] `MFA_ENFORCEMENT_ENABLED` — a new admin enrols in MFA at first sign-in
      once that flag is on. Check its state for the target environment; see
      `.claude/rules/env-flags.md`.

## Environment selection

The script needs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DATABASE_POOL_URL`
and `NEXT_PUBLIC_APP_URL` for the target.

| Target | How |
|---|---|
| **Staging** | `--env staging`. Parses `.env.staging.local` and maps `STAGING_X` → `X`, including the empty-`STAGING_SUPABASE_URL` fallback. Both facts are owned, with dates and evidence, by `docs/runbooks/mfa-factor-reset.md` § step 2 "Environment matters" — read it there; this runbook does not keep a second copy. |
| **Local** | `--env local`. Parses `.env.local` with no prefix. |
| **Production** | `--env production`. Reads the AMBIENT environment (the selector grants target permission; it does not name a config file), so export the four variables in a production-scoped shell — e.g. `railway run`. Production secrets never live in a repo file. |

The script parses the file with `dotenv.parse` and never shells out, so the
`source` hazard `mfa-factor-reset.md` documents does not arise here — there is
no step in this runbook that sources an env file. Never pass a key or a
database URL as a command argument: it lands in shell history.

## 1. Dry run, always

```bash
pnpm tsx scripts/mint-admin.ts \
  --email new.admin@repworth.net --name "New Admin" \
  --env staging --confirm-ref <staging-project-ref> --dry-run
```

It prints `TARGET:` (project ref, Supabase host, `user@host:port` — never a
password or key) and runs every refusal check without writing anything.

**Read the TARGET line before continuing.** It is the only thing standing
between you and the wrong project.

If it prints `WARNING: auth.users is not readable on this target`, the dry run
could not check the Supabase Auth half. That is expected against a local test
database and never expected against a real Supabase project — if you see it
against staging or production, stop and find out why the service identity
cannot read `auth.users`.

## 2. Mint

Drop `--dry-run`. On success:

```
MINTED: users.id=<uuid> auth_id=<uuid>
Send the new admin this single-use link. …
https://staging.repworth.net/api/auth/callback?token_hash=…&type=recovery&flow=admin&next=%2Fadmin%2Freset-password
```

**No password is ever generated or printed.** The new admin sets their own
through that link. The link is single-use, it expires, and it grants a session
— treat it as a credential: send it over a channel you already trust, and do
not paste it into a ticket.

## 3. Verify both halves

```sql
SELECT u.id, u.email, u.role, u.account_id, u.auth_id,
       a.event_type, a.created_at
FROM users u
LEFT JOIN admin_audit_log a ON a.actor_user_id = u.id AND a.event_type = 'admin_minted'
WHERE lower(u.email) = lower('new.admin@repworth.net');
```

Expect exactly one row: `role='admin'`, `account_id` NULL, `auth_id` non-NULL,
and one `admin_minted` audit row. **A `users` row with `role='admin'` and no
`admin_minted` row is the silent-failure shape** — investigate rather than
re-run.

The audit row's `actor_user_id` is the minted admin itself. That is deliberate:
`admin_audit_log.actor_user_id` is `NOT NULL REFERENCES users(id)` (migration
117), there may be no other admin at all when this runs (#1182 revokes every
admin and then re-mints), and the operator is recorded in the row's `payload`.

## Refusals, and what each one means

| Output | Meaning | Do |
|---|---|---|
| `REFUSING TO RUN: … PRODUCTION project ref … production was not explicitly selected` | You are pointed at production without `--env production`. | If production is what you meant, re-run with `--env production` AND the production `--confirm-ref`, dry-run first. If it is not, fix your environment — do not add the selector to silence the message. |
| `REFUSING TO RUN: --confirm-ref must be a complete Supabase project ref` | A partial ref was passed. | Pass the full twenty-character ref. |
| `REFUSING TO RUN: the Supabase URL / database target resolves to project ref X, not the confirmed Y` | Either you named the wrong project, or your Supabase URL and database URL belong to DIFFERENT projects. | Fix the environment. Do not "correct" `--confirm-ref` to match — that defeats the check. |
| `REFUSED (users_row_exists)` | A `users` row already holds that email, in any role. | Nothing was written. Decide deliberately whether that person should be an admin; never convert an owner row by hand. |
| `REFUSED (auth_user_exists)` | See the next section. | |
| `REFUSED (auth_id_taken)` | Another `users` row is already linked to the freshly created Auth identity. Effectively impossible; if you see it, something is very wrong. | The Auth identity was NOT deleted — deleting it would revoke that other admin's login. Escalate. |

### Exit codes

A wrapper should branch on these, not on the text.

| Code | Meaning |
|---|---|
| `0` | Minted, or a dry run that passed every check. |
| `2` | Usage error. A missing or malformed flag, **or a required environment variable that is not set for the chosen target** — both raise the same error type and print the usage block. |
| `3` | Refused. Nothing was written, unless the output names an orphaned Auth identity. |
| `4` | Failed, including every target-guard refusal and any uncaught error. Read the output before retrying. |

### Two `FAILED` outputs that are NOT refusals

Both mean the Supabase Auth side is in an **unknown** state — the script says
so rather than claiming nothing was written, because a transport failure can
abort the response after the identity was created:

- `Supabase createUser failed: … Whether an Auth identity was created … is UNKNOWN`
- `Supabase createUser returned no user and no error … is UNKNOWN`

In both cases check the Auth side (below) **before** retrying. A blind retry is
how a second identity for one human gets created.

### An Auth identity with no `users` row

The half-succeeded hand process. Find it:

```sql
SELECT id, email, created_at, last_sign_in_at
FROM auth.users WHERE lower(email) = lower('<email>');
```

If nobody is using that identity, delete it through the Supabase Auth admin API
(`auth.admin.deleteUser`, the same call
`docs/runbooks/mfa-factor-reset.md` step 2 shows how to reach) and re-run the
mint. If somebody IS using it, they already have a login and need a `users` row
instead — that is a different, deliberate repair; escalate rather than
improvise.

## Reconciling an uncertain run

The script creates the Supabase Auth identity first, then writes the `users`
row and its audit row in ONE Postgres transaction. It compensates by deleting
the Auth identity **only when the rollback is confirmed** — a refusal it raised
itself, or a server-raised SQLSTATE in class 22/23/42. When the outcome is
ambiguous (a lost connection, a cancelled statement, a lost COMMIT
acknowledgement) it **preserves the Auth identity on purpose** and tells you:

```
FAILED: The mint transaction failed with an ambiguous outcome (…) …
Orphaned Supabase Auth identity: <auth-uuid>
```

That is the safe direction. An orphan Auth identity is a nuisance; deleting the
identity behind a `users` row that actually committed leaves an admin who can
never sign in.

To resolve one, apply **the same rule the script applies** — do not substitute
a shorter one. Absence plus elapsed time is *not* evidence of a rollback: the
original transaction can still be in flight and commit after you look.

1. Confirm the mint's own row, by BOTH its id and its audit row — "some row
   exists for this `auth_id`" is the wrong test, because another admin's row
   could carry it:

   ```sql
   SELECT u.id, u.email, u.role, a.event_type
   FROM users u
   LEFT JOIN admin_audit_log a
     ON a.actor_user_id = u.id AND a.event_type = 'admin_minted'
   WHERE u.auth_id = '<auth-uuid from the FAILED line>';
   ```

2. **A row whose `id` matches the `users.id` the run printed, with an
   `admin_minted` row** → the mint COMMITTED. Re-issue a recovery link (below).
   Do **not** re-run the script, and do **not** delete the Auth identity.

3. **A row with a DIFFERENT id** → another `users` row is linked to this Auth
   identity. Do **not** delete it — that revokes a different admin's login.
   Escalate.

4. **No row** → you may delete the Auth identity **only once you can show the
   transaction terminated**, not merely that no row is visible. Establish that
   before acting:

   ```sql
   -- Any backend still running this mint's work? An empty result is the
   -- precondition for step 5; a row here means WAIT, not delete.
   SELECT pid, state, wait_event_type, query_start, left(query, 120) AS query
   FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid()
     AND (query ILIKE '%INSERT INTO users%' OR query ILIKE '%admin_audit_log%'
          OR state = 'idle in transaction');
   ```

5. Empty result **and** step 1 still returns no row → the Auth identity is
   genuinely orphaned. Delete it via `auth.admin.deleteUser` and re-run the
   mint. Re-run step 1 immediately before deleting.

If you cannot satisfy step 4, leave the Auth identity in place and escalate. An
orphan Auth identity costs one cleanup; deleting the identity behind a `users`
row that did commit leaves an admin who can never sign in, and that is the
state this whole script exists to prevent.

## Re-issuing a recovery link

When the mint committed but the link could not be generated
(`WARNING: the mint COMMITTED but the recovery link could not be generated`),
or when a link expired: generate a fresh `recovery` link for that email and
rebuild the callback URL exactly as `buildAdminRecoveryUrl` does
(`type=recovery`, `flow=admin`, `next=/admin/reset-password`). **Never re-run
the mint to get a new link** — it will refuse, correctly, and if it did not it
would create a second identity.

## Revoking and restoring an admin

`scripts/revoke-admin.ts` (#1182). Same targeting contract as the mint script,
same exit codes, opposite verb.

```
pnpm tsx scripts/revoke-admin.ts --email <e> --confirm-ref <20-char-project-ref> \
  [--env local|staging|production] [--restore] [--dry-run]
```

**A revoke is never a deletion.** `users` rows are FK targets —
`businesses.onboarded_by` (`001_initial_schema.sql:107`),
`impersonation_sessions.actor_user_id` NOT NULL (`048`),
`admin_audit_log.actor_user_id` NOT NULL (`117`), plus the `014`/`034` actor
columns — so deleting an admin row either fails loudly or takes a security
trail with it. The script never issues a DELETE or an UPDATE against `users`.

**What it changes, exactly:** the Supabase Auth identity is banned
(`auth.admin.updateUserById(id, { ban_duration: '876000h' })`, Supabase's
documented 100-year ban), so it can no longer sign in or refresh a session.
`users.role` stays `'admin'`, the row stays, and the MFA factors stay — which
is what makes `--restore` (`ban_duration: 'none'`) an exact reversal.

**The one residual, stated rather than hidden:** an access token minted BEFORE
the ban stays valid until it expires (the project's JWT expiry, 1 hour by
default). A ban blocks the sign-in and the refresh, not an already-issued JWT.
Nothing in this repo writes the `auth` schema, and adding the first such write
(`DELETE FROM auth.sessions`) to shorten a one-hour window was judged the worse
trade. If a revoke ever has to be instant, revoke and then rotate the project's
JWT secret — that is the supported lever, and it logs every other session out too.

**Order for a full reset:** dry-run each identity, revoke each identity, flip
`MFA_ENFORCEMENT_ENABLED`, then `--restore` the identities that stay. Restoring
is one command per identity, so a reset is reversible end to end.

### The audit row

One `admin_audit_log` row per state transition — `admin_revoked` or
`admin_restored` — written through `writeAdminAuditLog`, the only sanctioned
writer (migration 117). **Not `account_audit_log`:** its `account_id` is NOT
NULL and an admin's `account_id` is NULL, which is the entire reason 117
exists. The actor is the revoked admin itself (`actor_is_subject: true`,
`attribution: 'bootstrap_self_actor'`), the same self-actor shape
`admin_minted` uses, because a full reset may leave no other admin to name.

### Refusals

| Reason | Meaning |
|---|---|
| `users_row_missing` | No `users` row for that email. Nothing was called. |
| `not_an_admin` | The row exists but its role is not `admin`. This script only reaches admins. |
| `auth_id_missing` | The admin row carries no `auth_id`, so there is no Auth identity to ban. See § "An Auth identity with no `users` row". |
| `auth_identity_missing` | The admin row names an `auth_id` that `auth.users` does not carry — the mirror of the row above, and what `mint-admin.ts`'s compensating delete leaves behind. Nothing was changed. **This refusal is why `--restore` cannot report a false `ALREADY ACTIVE`:** absence is a refusal, never a state. |
| `auth_identity_deleted` | The Auth identity is soft-deleted (`auth.users.deleted_at`). Banning or unbanning it would report success over an identity that cannot sign in either way. |

`ALREADY REVOKED` / `ALREADY ACTIVE` are not refusals: the identity is already
in the target state, nothing is called, nothing is written, exit code `0`.

### `WARNING: the … COMMITTED but the admin_audit_log row FAILED`

The Auth change stands and is NOT rolled back — rolling a ban back to keep the
ledger tidy would restore a login the operator asked to remove. **Do not re-run
the script to "fix" the ledger**: the re-run reads the new ban state, reports
`ALREADY REVOKED` and writes nothing.

Record the row by hand. `admin_audit_log.id` is `UUID PRIMARY KEY` with **no
default** (`117_admin_audit_log.sql:50`) — application code normally supplies a
UUIDv7 — so the id must be supplied here too:

```sql
-- Replace <event> with admin_revoked or admin_restored, and <email> with the
-- admin's address. The actor is the admin itself: the self-actor shape the
-- script uses, because a full reset may leave no other admin to name.
INSERT INTO admin_audit_log (id, actor_user_id, event_type, entity_type, entity_id, payload)
SELECT gen_random_uuid(), u.id, '<event>', 'users', u.id::text,
       jsonb_build_object(
         'source', 'docs/runbooks/mint-admin.md manual recovery',
         'action', CASE WHEN '<event>' = 'admin_revoked' THEN 'revoke' ELSE 'restore' END,
         'email', u.email,
         'auth_id', u.auth_id,
         'ban_duration', CASE WHEN '<event>' = 'admin_revoked' THEN '876000h' ELSE 'none' END,
         'users_row_preserved', true,
         'actor_is_subject', true,
         'attribution', 'bootstrap_self_actor',
         'manual_recovery', true)
FROM users u
WHERE lower(u.email) = lower('<email>') AND u.role = 'admin';
```

`gen_random_uuid()` rather than a UUIDv7 is deliberate for a hand-written
recovery row: it is available in the session, and `manual_recovery: true` marks
the row as not machine-written. Confirm it inserted exactly one row, then note
the incident on the ticket.

### `FAILED: Supabase updateUserById failed`

The Auth outcome is reported as UNKNOWN, deliberately: the SDK surfaces a
transport failure the same way it surfaces a server refusal, so "nothing
changed" is a claim the script cannot make. Re-read the state before retrying:

```sql
SELECT id, email, banned_until FROM auth.users WHERE lower(email) = '<email>';
```

`banned_until` in the future means the ban applied. A retry is safe either way
— the ban is idempotent — but the audit row is written only by the run that
performs the transition.

## Related

- `docs/runbooks/mfa-factor-reset.md` — lost authenticator, break-glass.
- `.claude/rules/admin-portal.md`, `.claude/rules/supabase-auth.md`.
- Ticket #1178 (this script), #1182 (admin reset — revoke, never delete),
  #1179 (the production admin account at go-live).
