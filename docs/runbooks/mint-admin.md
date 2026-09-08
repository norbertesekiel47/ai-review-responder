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

## Before you mint

- [ ] The person is authorised to hold RepWorth admin — full access to every
      tenant's data, the impersonation surface, and the admin control plane.
      This is not a reversible convenience.
- [ ] You know which project you mean. `--confirm-ref` must be the FULL
      twenty-character Supabase project ref, and it must match the ref parsed
      out of both the Supabase URL and the database connection. A production
      ref is refused outright by this script (production minting is #1179).
- [ ] `MFA_ENFORCEMENT_ENABLED` — a new admin enrols in MFA at first sign-in
      once that flag is on. Check its state for the target environment; see
      `.claude/rules/env-flags.md`.

## Environment selection

The script needs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DATABASE_POOL_URL`
and `NEXT_PUBLIC_APP_URL` for the target.

| Target | How |
|---|---|
| **Staging** | `--env staging`. Parses `.env.staging.local` and maps `STAGING_X` → `X`. `STAGING_SUPABASE_URL` is empty in this repo's copy, so it falls back to `STAGING_NEXT_PUBLIC_SUPABASE_URL`, which the file's own comment and `.env.example` document as the same value. |
| **Local** | `--env local`. Parses `.env.local` with no prefix. |
| **Production** | No `--env`. Export the four variables in a production-scoped shell (e.g. `railway run`). **The script refuses a production project ref today** — that is ticket #1179, and lifting the refusal is a deliberate change, not an operator flag. |

Never `source .env.staging.local`: it holds at least one unquoted value
containing `<`/`>`, which a shell reads as redirections. The script parses it
with `dotenv.parse` instead. Never pass a key or a database URL as a command
argument — it lands in shell history.

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
| `REFUSING TO RUN: … PRODUCTION project ref` | The target or the confirmation is production. | Nothing. Production minting is #1179. |
| `REFUSING TO RUN: --confirm-ref must be a complete Supabase project ref` | A partial ref was passed. | Pass the full twenty-character ref. |
| `REFUSING TO RUN: the Supabase URL / database target resolves to project ref X, not the confirmed Y` | Either you named the wrong project, or your Supabase URL and database URL belong to DIFFERENT projects. | Fix the environment. Do not "correct" `--confirm-ref` to match — that defeats the check. |
| `REFUSED (users_row_exists)` | A `users` row already holds that email, in any role. | Nothing was written. Decide deliberately whether that person should be an admin; never convert an owner row by hand. |
| `REFUSED (auth_user_exists)` | See the next section. | |
| `REFUSED (auth_id_taken)` | Another `users` row is already linked to the freshly created Auth identity. Effectively impossible; if you see it, something is very wrong. | The Auth identity was NOT deleted — deleting it would revoke that other admin's login. Escalate. |

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

To resolve one:

1. Wait a few seconds — an in-flight transaction may still commit.
2. `SELECT id, email, role FROM users WHERE auth_id = '<auth-uuid>';`
3. **A row exists** → the mint succeeded. Re-issue a recovery link (below).
   Do **not** re-run the script.
4. **No row** → the Auth identity is genuinely orphaned. Delete it via
   `auth.admin.deleteUser`, then re-run the mint.

## Re-issuing a recovery link

When the mint committed but the link could not be generated
(`WARNING: the mint COMMITTED but the recovery link could not be generated`),
or when a link expired: generate a fresh `recovery` link for that email and
rebuild the callback URL exactly as `buildAdminRecoveryUrl` does
(`type=recovery`, `flow=admin`, `next=/admin/reset-password`). **Never re-run
the mint to get a new link** — it will refuse, correctly, and if it did not it
would create a second identity.

## Related

- `docs/runbooks/mfa-factor-reset.md` — lost authenticator, break-glass.
- `.claude/rules/admin-portal.md`, `.claude/rules/supabase-auth.md`.
- Ticket #1178 (this script), #1182 (admin reset — revoke, never delete),
  #1179 (the production admin account at go-live).
