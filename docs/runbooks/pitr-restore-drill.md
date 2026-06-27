# Database Restore Drill Runbook (PITR / physical backups)

How to **prove a Supabase restore actually works** and measure the recovery time
(RTO) — before real customer data exists. This is the database half that
`rollback.md §4` defers to ("For catastrophic data loss, restore from Supabase
backups / PITR"). `rollback.md` covers rolling back *code*; this covers bringing
*data* back.

> **Why this runbook exists.** An untested backup is a hope, not a backup. The
> point of the drill is to discover the failure modes (missing add-on, wrong
> plan, custom-role passwords, surprise downtime) on a throwaway copy now, while
> a mistake costs nothing — not during a real incident with paying customers.

**Concrete IDs** (from `deployment-guide.md`):

| Project | Ref | Region | Postgres |
|---|---|---|---|
| Production | `udeyaqnvpojbwgoaxwdg` | us-west-2 | 17.x |
| Staging | `kubdiqdhqbhwmqfditeg` | us-west-2 | 17.x |

Both run Postgres 17, so **physical backups are on by default** and
**Restore to a New Project** (the non-destructive drill path, §3) is available.

---

## Two restore mechanisms — know which one you're invoking

| Mechanism | What it does | Destructive? | Use for |
|---|---|---|---|
| **Restore to a New Project** (clone) | Spins up a brand-new project from a backup / PITR timestamp. Database-only copy, fully independent. | **No** — source untouched | **The drill** (§3). Also: forensic analysis, pulling specific lost rows back into prod. |
| **In-place PITR / daily restore** | Rewinds the *same* project to a point in time. | **Yes** — overwrites the project, causes downtime, and you cannot move forward past the restore point | A real disaster on prod (§5), last resort only. |

> **Never run an in-place restore as a test.** It takes the project offline for
> the duration (downtime scales with DB size) and discards everything written
> after the restore point. The drill MUST use *Restore to a New Project* so prod
> is never touched. This supersedes the older "restore on prod" framing — see
> `rollback.md §4` and `deployment-guide.md §12`.

---

## §0. Prerequisites — verify the backup mechanism BEFORE trusting it

The launch checklist asserts PITR is *enabled*. Confirm it rather than assume —
this check is itself part of the drill.

1. **Dashboard:** project → **Database → Backups**. You should see either a
   **Point in Time** tab (PITR add-on active) or a **Scheduled** tab (daily
   backups only). Note the **earliest** and **latest** recovery points.
2. **Or via Management API** (token from
   <https://supabase.com/dashboard/account/tokens>):

   ```bash
   export SUPABASE_ACCESS_TOKEN="<pat>"
   export PROJECT_REF="udeyaqnvpojbwgoaxwdg"   # prod
   curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
     "https://api.supabase.com/v1/projects/$PROJECT_REF/database/backups" | jq
   ```

   - `pitr_enabled: true` → PITR is live; restore granularity is to-the-second
     within the retention window (RPO ≈ 2 min, the WAL backup cadence).
   - `pitr_enabled: false` → only daily physical backups exist (RPO ≈ up to 24 h).
     Either is restorable; the drill below works for both.

**Plan/add-on facts to know:**
- PITR is a **paid add-on** (Pro+), requires **≥ Small compute**, and **is not
  covered by the Spend Cap**. Enabling PITR **stops daily backups** (PITR
  supersedes them).
- **RepWorth uses no Supabase Storage** (verified: no `.storage.` call sites), so
  the standard "storage objects are not copied / not restored" caveat is **N/A**
  here. The Postgres database is the entire recovery surface.

---

## §3. The drill — Restore to a New Project (non-destructive)

Run against **prod** (`udeyaqnvpojbwgoaxwdg`) while it is still empty, OR against
**staging** if you'd rather not touch prod at all. The goal is a measured,
verified restore — **start a stopwatch when you click Restore.**

1. Dashboard → source project → **Database → Backups → Restore to a New Project**.
2. Pick the recovery point:
   - **PITR:** use the date/time picker (must fall within earliest/latest).
   - **Daily:** select the most recent daily backup.
3. Review the cost estimate (the clone mirrors the source's compute/disk → real
   monthly cost until you delete it — see §6) and confirm.
4. Supabase provisions a new project automatically (same region for data
   residency). **Record the wall-clock time** from click to
   `ACTIVE_HEALTHY` — **this is your measured RTO.**

> **API equivalent** (in-place PITR rewind — for reference only, do **not** run on
> prod as a test): `POST /v1/projects/{ref}/database/backups/restore-pitr` with
> `{"recovery_time_target_unix": <ts>}`. There is no "wrong button" safety net on
> this endpoint; it rewinds the named project.

---

## §4. Integrity verification — prove the data actually came back

Connect to the **new (cloned)** project (Dashboard → SQL Editor, or `psql` via its
connection string) and confirm the data matches the source. Compare each number
against the same query run on the source project.

```sql
-- Row counts on the tables that carry customer + billing state
select 'accounts'           as t, count(*) from accounts
union all select 'businesses',        count(*) from businesses
union all select 'reviews',           count(*) from reviews
union all select 'responses',         count(*) from responses
union all select 'approval_links',    count(*) from approval_links
union all select 'job_outbox',        count(*) from job_outbox
union all select 'api_costs',         count(*) from api_costs;

-- Auth users survived (clone copies the auth schema + hashed passwords)
select count(*) as auth_users from auth.users;

-- Most-recent customer activity is present (not truncated at an old WAL point)
select max(created_at) as latest_review   from reviews;
select max(created_at) as latest_response from responses;
```

Then **spot-check the schema head**: confirm the most recent migration's object
exists (authoritative head + what it added: `.claude/reference/migrations-log.md`).
For example, verify a recently-added column is present:

```sql
select column_name from information_schema.columns
where table_name = 'accounts' and column_name = 'onboarding_wizard_completed_at';
```

Pass criteria: counts match the source (allowing for the ≤ RPO of writes after
the restore point), auth users present, latest timestamps recent, head schema
object present.

> **Note on the migrations ledger.** Prod applies migrations directly (Management
> API / `psql`), not always through the `supabase_migrations` ledger — so verify
> schema by **checking for the actual object** (column/index/table), not by
> reading a migrations table that may be incomplete.

---

## §5. Real incident — in-place restore on prod (last resort)

Only when prod data is genuinely lost/corrupted and rolling back code (`rollback.md`)
plus a forward data-fix can't recover it. **Stop the bleeding first** (flag-off /
kill-switch per `rollback.md §1`), then:

1. **Accept the cost:** the project goes **offline** for the restore (downtime
   scales with DB size), and **everything written after the chosen point is
   discarded** (≤ RPO of acceptable loss). Announce downtime first.
2. Dashboard → **Database → Backups** → pick the point **just before** the
   incident → confirm. (API: `restore-pitr`, §3.)
3. **Post-restore fixups:**
   - **Custom-role passwords are not restored** — reset any custom DB roles
     afterward.
   - **Replication slots / subscriptions** must be dropped before and recreated
     after (Supabase handles the Realtime slot automatically).
   - Re-run the §4 integrity checks against prod.
   - Re-verify the worker reconnects and the **outbox drains** (`/admin/jobs`).
4. **Prefer "Restore to a New Project" even here** when you only need to recover
   *specific* lost rows: clone to a scratch project (§3), copy the missing rows
   back into prod inside one `BEGIN … COMMIT` (account-status changes via
   `writeAccountAuditLog`, per CLAUDE.md), then delete the scratch project. This
   avoids prod downtime entirely.

---

## §6. Cleanup — delete the scratch project

The cloned project bills monthly like any project. **Delete it as soon as the
drill is verified and recorded.**

1. Confirm you are in the **scratch/cloned** project, not prod or staging
   (triple-check the ref — deletion is irreversible and wipes its backups too).
2. Dashboard → **Settings → General → Delete project**.

> **Cost note:** a forgotten clone is a silent recurring charge. The drill isn't
> "done" until the scratch project is gone.

---

## §7. Record the result

Drills only count if the outcome is written down:

1. Log in this runbook's history (or `docs/runbooks/`): **date run, source
   project, recovery point used, measured RTO, RPO observed, pass/fail, and any
   surprises.**
2. Tick **"First PITR restore drill"** in `docs/launch-checklist.md` only after a
   verified pass — and close GitHub issue **#287**'s PITR item.

| Date | Source | Method | Measured RTO | Result | Notes |
|---|---|---|---|---|---|
| _pending first drill_ | | | | | |

---

## Guardrails

- **Never use in-place restore as a test** — it rewinds and downs the named
  project (§5). Drills use *Restore to a New Project* (§3).
- **Never restore into prod or staging by accident** — verify the project ref
  before every restore/delete.
- **Always delete the scratch clone** when done (§6) — it bills until you do.
- **RepWorth has no Storage objects to worry about**, but the DB restore excludes
  Edge Functions, API keys, and project config — those are reconfigured from
  code/env, not from a DB backup.
- **A code rollback must never need a schema rollback** (`rollback.md §4`): this
  runbook is for *data loss*, not bad deploys.
