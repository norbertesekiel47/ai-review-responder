# Evidence — PITR / physical-backup restore drill (first execution)

Runbook: [`docs/runbooks/pitr-restore-drill.md`](../pitr-restore-drill.md)
Campaign: the first of the three hard launch blockers (`docs/launch-checklist.md` line 39).

---

## Environment

| Field | Value |
|---|---|
| Source project | **production** `RepWorth` — ref `udeyaqnvpojbwgoaxwdg`, region `us-west-2`, Postgres `17.6.1.104` |
| Staging project | `RepWorth-staging` — ref `kubdiqdhqbhwmqfditeg` — **NOT touched by this drill** |
| Organization | `Startups` — `yommkwhrrlvqvpxmsdbu`, plan `pro` |
| Restore mechanism | **Restore to a New Project** (clone). Non-destructive. The source is never written. |
| In-place restore | **Never used.** `POST …/database/backups/restore-pitr` is not called in this drill. |
| Git SHA at start | `23facb7bf2371023e748a4918599299149c23b2f` (`main`) |
| Migrations head | **116** (`116_refusal_events.sql`) |
| UTC start | **2026-09-01T21:20:11Z** |
| Owner | @norbertesekiel — runs every Dashboard click |
| Spend approved | **$10/month, billed hourly, prorated.** Confirmed by the owner 2026-09-01T21:1xZ before any project was created. |

### Posture constraints

- Production is the **source**, not the target. Nothing in this drill writes to `udeyaqnvpojbwgoaxwdg`.
- The clone is a scratch project. It is deleted in §6 and the deletion is verified, not assumed.
- No flag is flipped. No worker is stopped. Staging is untouched, so a concurrent
  push to `staging` cannot collide with this run.

---

## Preflight

| # | Check | Result | UTC | Evidence |
|---|---|---|---|---|
| P1 | Supabase CLI is authenticated (no PAT needed) | ✅ | 21:12Z | `supabase projects list` returned 5 projects across 2 orgs |
| P2 | `pitr_enabled` on production | ⚠️ **false** | 21:14Z | `supabase backups list --project-ref udeyaqnvpojbwgoaxwdg -o json` → `{"pitr_enabled": false, "walg_enabled": true}` — see **D-2** |
| P3 | `pitr_enabled` on staging | ⚠️ **false** | 21:14Z | same command, ref `kubdiqdhqbhwmqfditeg` → identical |
| P4 | Physical backups exist and are `COMPLETED` | ✅ | 21:14Z | 8 daily physical backups, `2026-08-25T11:25:10Z` → `2026-09-01T11:24:14Z`, every one `status: COMPLETED`, `is_physical_backup: true` |
| P5 | "Restore to a New Project" is available on this plan | ✅ | 21:18Z | Supabase docs `guides/platform/clone-project`: needs a **paid plan** + **physical backups enabled**. Org is `pro`; `walg_enabled: true`. **PITR is not a precondition.** |
| P6 | Clone cost, from the API not from memory | ✅ | 21:13Z | `get_cost(type=project, org=yommkwhrrlvqvpxmsdbu)` → `{"recurrence":"monthly","amount":10}` |
| P7 | Source database size (bounds the restore time) | ✅ | 21:15Z | `pg_database_size` → **17 MB** |
| P8 | F.4 left real data, so §4 is not vacuous | ✅ | 21:22Z | 1 `accounts`, 1 `businesses`, 2 `users`, 2 `auth.users`, 4 `job_outbox`, 2 `account_audit_log`, 1 `api_costs` |
| P9 | The chosen backup post-dates every production write | ✅ | 21:22Z | newest write anywhere in production is `2026-08-31T20:46:02.070703Z`; the backup is `2026-09-01T11:24:14.800Z`. **Therefore the clone must match the source EXACTLY — there is no post-backup write to excuse a difference.** |
| P10 | No public Management API endpoint for the clone | ⚠️ | 21:19Z | `POST /v1/projects/{ref}/restore` restores a **paused project**, not a clone. The clone is Dashboard-only (Beta). The owner runs it in the browser; every verification below is API or SQL. |

---

## Deviations

### D-1 (2026-09-01T21:21Z) — the runbook's §4 integrity SQL does not run. `reviews` has no `created_at`.

The runbook prescribes `select max(created_at) as latest_review from reviews;`.
Executed against production it fails:

```
ERROR:  42703: column "created_at" does not exist
HINT:  Perhaps you meant to reference the column "reviews.triaged_at".
```

`reviews`' timestamp columns are `review_date, detected_at, external_reply_ingested_at,
sentiment_classified_at, triaged_at`. There is no `created_at`. `responses` **does**
have one, so the second half of the runbook's pair is correct and only the first is wrong.

**Correct anchor: `detected_at`** — the ingestion timestamp, and the column CLAUDE.md
names as the anchor for workflow metrics. Fixed in the runbook in this session per
contract step 7.

**Why it matters beyond a typo:** production currently holds 0 reviews, so the wrong
query would have returned `null` from a *broken* column just as a working query returns
`null` from an *empty* table — except it does not, it raises. Had the table been
non-empty the drill would have aborted mid-verification.

### D-2 (2026-09-01T21:14Z) — `pitr_enabled` is **false** on both projects. The launch checklist asserts it is enabled.

`docs/launch-checklist.md` line 39: *"**First PITR restore drill** (Spec 08) — PITR is
*enabled* but has **never been restored end-to-end**"*. The first half is false.

| Project | `pitr_enabled` | `walg_enabled` | Backups held |
|---|---|---|---|
| `udeyaqnvpojbwgoaxwdg` (prod) | **false** | true | 8 daily physical, 7-day window |
| `kubdiqdhqbhwmqfditeg` (staging) | **false** | true | 8 daily physical, 7-day window |

Two consequences, and they pull in opposite directions:

1. **The real RPO is up to 24 h, not ~2 minutes.** Every write since the last daily
   backup is unrecoverable. That is a posture fact the checklist currently hides.
2. **The drill still runs, unchanged.** `clone-project` requires a paid plan and
   *physical backups*, not PITR. Both hold. What the drill proves is
   restore-and-integrity; what it cannot prove is second-granularity recovery,
   because that mechanism is not bought.

**Owner decision, 2026-09-01:** run the drill on the daily physical backup now; do
**not** buy the PITR add-on before it. The add-on is ~$100/month for 7-day retention
(hourly $0.137) and is **not covered by the Spend Cap**. It is recorded as a separate
open decision, not as part of this drill.

**Checklist correction owed in the same change as this evidence file.**

### D-3 (2026-09-01T21:26Z) — the approved spend was 20× the real one. The API's estimate and the dialog's disagree.

The owner approved **$10/month prorated**, the figure returned by the Supabase
`get_cost` API for a new project in this organization. The Dashboard's own
confirmation dialog, shown at the moment of creation, reads:

| Line | Amount |
|---|---|
| Additional Monthly Compute | **$0** |
| Additional Monthly Disk | **$0.50** |
| **Total** | **$0.50** |

**The dialog is authoritative and the API estimate is not.** `get_cost` prices a
*generic* new project; the clone inherits the source's compute size, which the
organization's existing Pro compute credit already absorbs, so only the disk is
incremental. Over the ~1 h this project lives, the real charge is on the order of
**$0.0007**.

The error was in the safe direction, but it is still an error in a number presented
to an owner for approval. **General shape: a platform's cost *estimator* and its
cost *confirmation* answer different questions.** Quote the confirmation dialog, and
where a decision must be made before it appears, say which of the two is being quoted.

The same dialog carries one fact the runbook does not mention: **the clone's disk is
provisioned at 1.5× the source's**, deliberately, so the restore has headroom. The
clone is therefore a mirror of the source's *data*, not of its *infrastructure*.

---

---

## The prediction, written before the restore

Recorded at **2026-09-01T21:24Z**, before any project exists. P9 establishes that the
backup post-dates every production write, so the honest prediction is **exact equality**,
not "within the RPO".

| Assertion | Predicted result |
|---|---|
| A1 Every row count in the clone | **identical** to the source table below |
| A2 `auth.users` in the clone | **2**, with the same id checksum |
| A3 Schema fingerprint | **identical** — same table count, column count, and md5 |
| A4 Head-schema object (`refusal_events`, migration 116) | **present** in the clone |
| A5 `max()` timestamps | **identical**, incl. the three `null`s |
| A6 Measured RTO for a 17 MB database | **10–25 min**, dominated by project provisioning, not by data volume |
| A7 The clone's own `pitr_enabled` | **false** — it mirrors the source's add-on state |

A failure of A1–A5 is a **restore defect**. A miss on A6 is a datum, not a failure —
the runbook sets no RTO target, and this drill is what establishes one.

### Source baseline — production, captured 2026-09-01T21:22Z

| Table | Rows | `max()` timestamp |
|---|---|---|
| `accounts` | 1 | `2026-08-31 20:14:07.54351+00` |
| `businesses` | 1 | `2026-08-31 20:14:07.54351+00` |
| `users` | 2 | `2026-08-31 20:14:07.54351+00` |
| `auth.users` | 2 | `2026-08-31 20:14:08.449559+00` |
| `reviews` | 0 | `null` (anchor `detected_at`, per D-1) |
| `responses` | 0 | `null` |
| `approval_links` | 0 | `null` |
| `job_outbox` | 4 | `2026-08-31 20:46:02.070703+00` |
| `api_costs` | 1 | `2026-08-31 20:29:30.65503+00` |
| `account_audit_log` | 2 | `2026-08-31 20:46:02.070703+00` |

### Source fingerprints — production, captured 2026-09-01T21:23Z

| Fingerprint | Value |
|---|---|
| `public` base tables | **52** |
| `public` columns | **764** |
| `public` indexes | **278** |
| Schema md5 (`table.column:type`, ordered) | `564fe5e8944da0a54757a3c840cbdc1c` |
| `accounts` id checksum | `8ba733c315133ab80b09ffe0f780b6e3` |
| `businesses` id checksum | `a428180a248ab959cabf38e894d221f3` |
| `users` id checksum | `861fe2a7b75d88c6139764b316571290` |
| `job_outbox` id checksum | `16711043ab85d0c83cdbc2b59c506c2e` |
| `account_audit_log` id checksum | `85fba7a05e516504dd550569455d805e` |
| `auth.users` id checksum | `c20d01ba18ea7f5b2ad2fb7b74ea04e7` |

> A row count proves arity. A checksum over ordered ids proves **identity** — that the
> same rows came back, not merely the same number of them. With a 1-row `accounts`
> table the count alone is nearly worthless, which is why both are recorded.

---

## Teardown ledger

Written **before the first fixture exists**, per the runbook contract.

| # | Fixture | Identifier | How to remove | UTC created | Done |
|---|---|---|---|---|---|
| T1 | Cloned scratch Supabase project | name `repworth-pitr-drill-20260901`, ref **`zcqvxslotrurulisiqxi`** | Dashboard → `https://supabase.com/dashboard/project/zcqvxslotrurulisiqxi/settings/general` → Delete project. Verify with `supabase projects list` that the ref is gone. | **2026-09-01T21:26:37Z** | **[x] 21:33:29Z** |

No other fixture is created by this drill. No flag is flipped, no worker is stopped,
no row is written to any RepWorth database. If this run is interrupted, **T1 is the
entire cleanup surface** — and until it carries a ref, nothing has been created.

> **Deletion guardrail.** The clone's ref must equal neither `udeyaqnvpojbwgoaxwdg`
> nor `kubdiqdhqbhwmqfditeg`. Confirm the ref in the URL before clicking Delete.
> Deleting a project also destroys its backups, and is irreversible.

---

## Unproven paths

Open until closed with evidence:

| # | Path | Status |
|---|---|---|
| U1 | A restore actually completes and yields a reachable database | ✅ **closed** — `ACTIVE_HEALTHY` 21:31:31Z; 26 values read back over the Management API |
| U2 | The restored data is identical to the source (A1–A5) | ✅ **closed** — 10 row counts, 5 time anchors, 6 id checksums, 4 schema properties: all identical |
| U3 | A measured RTO exists for this database size | ✅ **closed** — **4 min 44 s** for 17 MB |
| U4 | The scratch project is deleted and the deletion is verified | ✅ **closed** — 21:33:29Z, verified by absence at 21:33:46Z |
| U5 | Second-granularity recovery (true PITR) | ❌ **out of scope by owner decision — the add-on is not bought.** Recorded, not proven. |

---

## Execution log

_Steps append below as they run._

### §3 — Restore to a New Project. Started 2026-09-01T21:26:47Z.

**Path taken:** Dashboard → production → Database → Backups → **Restore to a New
Project**. The destructive **Scheduled backups** in-place tab was not opened.
Confirmed against the runbook's guardrail: *"Never use in-place restore as a test."*

| Field | Value |
|---|---|
| Recovery point | the daily physical backup at **`2026-09-01T11:24:14.800Z`** (`id: 1545702308`, `status: COMPLETED`) |
| Mechanism | daily physical backup — **not** a PITR timestamp, because PITR is off (D-2) |
| New project name | `repworth-pitr-drill-20260901` |
| New project ref | **`zcqvxslotrurulisiqxi`** |
| Region | `us-west-2` — same as source, data residency preserved |
| Restore click (RTO stopwatch start) | **2026-09-01T21:26:47Z**, from the Dashboard's own `Previous restorations` row, displayed `(+0000)` |
| Project record created | `2026-09-01T21:26:37.974070Z` — the API row precedes the click by ~10 s |
| First observed status | `COMING_UP` at 21:28:00Z |

**Observation recorded at creation, not at verification:** the clone's Postgres is
**`17.6.1.166`**; the source's is **`17.6.1.104`**. A restore-to-new-project provisions
the *current* platform image and replays the backup into it. This is normal and is what
a real recovery would also do — but it means the drill proves *"the data restores onto
today's Postgres"*, not *"the exact byte image comes back"*. Stated here so the verdict
cannot be read as the stronger claim.

**Status timeline, from `supabase projects list` polled every 20 s:**

| UTC | Status |
|---|---|
| 21:26:37 | project row created |
| 21:26:47 | **Restore clicked — RTO stopwatch starts** |
| 21:28:00 | `COMING_UP` |
| 21:30:05 | `RESTORING` |
| 21:31:10 | `RESTORING` (last observation before the flip) |
| **21:31:31** | **`ACTIVE_HEALTHY` — RTO stopwatch stops** |

### **Measured RTO: 4 min 44 s** for a 17 MB database.

Poll granularity is 20 s, so the true value lies between **4 min 24 s** and
**4 min 44 s**. The larger figure is recorded, because an RTO must never be
reported optimistically.

**A6 was wrong, and the miss is worth keeping.** The prediction was 10–25 min. The
reasoning — "provisioning dominates, not data volume" — was right; the estimate of how
long Supabase takes to provision was simply too pessimistic, by roughly 3×. A drill that
only ever confirms its predictions is not measuring anything. **This is now RepWorth's
first real RTO datum, and it replaces an assumption with a number.**

> **Do not generalise this figure past its evidence.** 17 MB is effectively no data.
> Restore time grows with volume, and the runbook says so. What 4 min 44 s establishes
> is the **floor** — the fixed provisioning cost that any future restore pays before it
> starts moving bytes.

---

## §4 — Integrity verification. Clone vs. source, same query, both databases.

Run at **2026-09-01T21:31:5xZ** against `zcqvxslotrurulisiqxi`, compared to the
baseline captured from `udeyaqnvpojbwgoaxwdg` at 21:22–21:23Z, before the clone existed.

### Row counts and time anchors — A1, A5

| Table | Source | Clone | Match |
|---|---|---|---|
| `accounts` | 1 | 1 | ✅ |
| `businesses` | 1 | 1 | ✅ |
| `users` | 2 | 2 | ✅ |
| `auth.users` | 2 | 2 | ✅ |
| `reviews` | 0 | 0 | ✅ |
| `responses` | 0 | 0 | ✅ |
| `approval_links` | 0 | 0 | ✅ |
| `job_outbox` | 4 | 4 | ✅ |
| `api_costs` | 1 | 1 | ✅ |
| `account_audit_log` | 2 | 2 | ✅ |
| `max(accounts.created_at)` | `2026-08-31 20:14:07.54351+00` | identical | ✅ |
| `max(reviews.detected_at)` | `null` | `null` | ✅ |
| `max(responses.created_at)` | `null` | `null` | ✅ |
| `max(job_outbox.created_at)` | `2026-08-31 20:46:02.070703+00` | identical | ✅ |
| `max(account_audit_log.created_at)` | `2026-08-31 20:46:02.070703+00` | identical | ✅ |

**Microsecond precision survived the restore.** `.54351` and `.070703` came back byte-for-byte,
which matters here specifically: lab-notes #520 records that a µs-truncating round-trip is a live
failure mode in this codebase. A restore that silently truncated to milliseconds would have
been invisible to a row count and fatal to the outbox window logic.

### Identity checksums — A1 proper

A row count proves arity. These prove the **same rows** came back.

| Checksum, `md5(string_agg(id ordered))` | Source | Clone | Match |
|---|---|---|---|
| `accounts` | `8ba733c315133ab80b09ffe0f780b6e3` | identical | ✅ |
| `businesses` | `a428180a248ab959cabf38e894d221f3` | identical | ✅ |
| `users` | `861fe2a7b75d88c6139764b316571290` | identical | ✅ |
| `job_outbox` | `16711043ab85d0c83cdbc2b59c506c2e` | identical | ✅ |
| `account_audit_log` | `85fba7a05e516504dd550569455d805e` | identical | ✅ |
| **`auth.users`** | `c20d01ba18ea7f5b2ad2fb7b74ea04e7` | identical | ✅ |

**A2 — the auth schema came back.** Two users, same ids. Supabase's clone docs
promise "auth user data, hashed passwords, authentication records"; this is that
promise checked rather than quoted. It matters because `users.auth_id` → Supabase
Auth identity is architecture invariant #8 — a restore that dropped `auth.users`
would return a database in which every owner is locked out of their own account.

### Schema — A3, A4

| Property | Source | Clone | Match |
|---|---|---|---|
| `public` base tables | 52 | 52 | ✅ |
| `public` columns | 764 | 764 | ✅ |
| `public` indexes | 278 | 278 | ✅ |
| Schema md5 | `564fe5e8944da0a54757a3c840cbdc1c` | identical | ✅ |
| `refusal_events` present (head **116**) | yes | yes | ✅ |
| `pg_database_size` | 17 MB | 17 MB | ✅ |

**A4 used the method the runbook demands** — check for the *object*, not the ledger.
`refusal_events` is what migration 116 added, and it is the newest thing in the schema.
Its presence dates the restored schema at head, without trusting `supabase_migrations`,
which prod does not reliably populate.

### A7 — the clone's own backup posture

```
supabase backups list --project-ref zcqvxslotrurulisiqxi -o json | jq 'del(.backups)'
{ "pitr_enabled": false, "walg_enabled": true, "region": "us-west-2" }
```

Predicted `false`, observed `false`. The clone mirrors the source's add-on state.
A restored project does **not** silently acquire PITR.

### An unpredicted check, run because the docs warn about it — and it clears

Supabase's `clone-project` documentation carries a hazard the runbook does not mention:

> *"If the source project included extensions that are configured to carry out external
> operations — for example `pg_net`, `pg_cron`, `wrappers` — these should be disabled once
> the copy process has completed to avoid any unwanted actions from taking place."*

A clone that inherits `pg_cron` starts running the source's schedules **against its own
copy of live data**, from a project nobody is watching. Checked before touching anything:

| Extension in the clone | Present? |
|---|---|
| `pg_net` | **no** |
| `pg_cron` | **no** |
| `wrappers` | **no** |
| `http` | **no** |
| `pg_stat_statements` `1.11`, `pgcrypto` `1.3`, `supabase_vault` `0.3.1`, `uuid-ossp` `1.1` | yes — all inert |

**RepWorth carries no externally-acting Postgres extension, so this hazard does not
apply to it.** Recorded as a standing fact rather than a one-off: it is what makes
clone-to-scratch safe for forensics here, and it is a fact that a future migration adding
`pg_cron` would silently invalidate.

### Source untouched, verified rather than assumed

At 21:29:47Z, mid-restore, production read back: 1 `accounts`, 1 `businesses`,
4 `job_outbox`, `max(account_audit_log.created_at) = 2026-08-31 20:46:02.070703+00` —
identical to the 21:22Z baseline. Production and staging both remained
`ACTIVE_HEALTHY` throughout. **The non-destructive claim is measured, not inferred.**


---

## §6 — Teardown. Executed and verified.

The clone was deleted **6 min 52 s** after it was created. It was never left running
past its verification, which is the runbook's own standard: *"a forgotten clone is a
silent recurring charge. The drill isn't 'done' until the scratch project is gone."*

**Three programmatic guards ran before the delete command**, because the same verb
that removes a scratch project removes production:

| Guard | Assertion | Result |
|---|---|---|
| G1 | ref ∉ {`udeyaqnvpojbwgoaxwdg`, `kubdiqdhqbhwmqfditeg`} | pass |
| G2 | the ref's **live** name equals `repworth-pitr-drill-20260901` | pass — read from the API at delete time, not from this file |
| G3 | the ref's `created_at` falls inside this drill's minute (`2026-09-01T21:26`) | pass |

G2 is the load-bearing one. A ref typed from memory is the failure mode; a ref whose
**current** name is read back from the API and compared cannot be a different project.

```
guards pass — deleting zcqvxslotrurulisiqxi (repworth-pitr-drill-20260901) at 2026-09-01T21:33:29Z
Deleted project: repworth-pitr-drill-20260901
```

**Verified gone at 2026-09-01T21:33:46Z** — not assumed:

```
$ supabase projects list -o json | jq 'map(select(.id=="zcqvxslotrurulisiqxi")) | length'
0
```

Remaining RepWorth projects, both untouched by this drill:

| Ref | Name | Status |
|---|---|---|
| `udeyaqnvpojbwgoaxwdg` | RepWorth | `ACTIVE_HEALTHY` |
| `kubdiqdhqbhwmqfditeg` | RepWorth-staging | `ACTIVE_HEALTHY` |

> **One deviation from the runbook's procedure, deliberate.** §6 prescribes the
> Dashboard. The CLI was used instead, behind the three guards above, because a guard
> that a script enforces is stronger than a guard that says "triple-check the ref".
> `supabase projects delete <ref> --yes` — the bare form prompts interactively and the
> per-command `--help` does not list `--yes`; it is a global flag. Recorded so the next
> operator does not conclude the CLI cannot do this.

---

# Verdict — 2026-09-01T21:34Z

## ✅ **PASS.** The first restore drill in RepWorth's history. Every predicted assertion held.

| Assertion | Predicted | Observed | |
|---|---|---|---|
| A1 Row counts identical | exact equality | 10 of 10 tables identical, and 6 id checksums identical | ✅ |
| A2 `auth.users` restored | 2, same checksum | 2, `c20d01ba18ea7f5b2ad2fb7b74ea04e7` | ✅ |
| A3 Schema fingerprint identical | same md5 | `564fe5e8944da0a54757a3c840cbdc1c`, 52 tables / 764 columns / 278 indexes | ✅ |
| A4 Head-schema object present | `refusal_events` | present | ✅ |
| A5 `max()` timestamps identical | incl. three `null`s | identical to the microsecond | ✅ |
| A6 RTO | 10–25 min | **4 min 44 s** | ⚠️ **miss — 3× faster** |
| A7 Clone `pitr_enabled` | `false` | `false` | ✅ |

**A6 is the only miss, and it is a datum rather than a failure** — the runbook sets no
RTO target, and establishing one was the point.

## What this drill proves, stated no more strongly than the evidence supports

**Proven:**
- A Supabase physical backup of RepWorth production restores, completely, into a working project.
- The restored data is **identical**, not merely similar — same rows by id, same schema, microsecond timestamps intact.
- `auth.users` survives, so owners are not locked out of a restored database (invariant #8).
- The clone path is genuinely non-destructive: production served reads throughout and its state was unchanged afterwards.
- **RTO floor: ~5 minutes**, dominated by provisioning.
- RepWorth runs no externally-acting Postgres extension, so a forensic clone cannot fire the source's side effects.

**NOT proven, and not claimed:**
- **Second-granularity recovery.** PITR is not enabled (**D-2**). The real **RPO is up to 24 h**.
- **Restore time at real data volume.** 17 MB is effectively no data. 4 min 44 s is a floor, not a forecast.
- **Byte-identical infrastructure.** The clone provisioned Postgres `17.6.1.166` against the source's `17.6.1.104`, on a disk **1.5×** larger. The *data* is mirrored; the *machine* is today's platform image. This is what a real recovery would also do.

## Deviations: D-1, D-2, D-3 — and all three were pre-existing claims, not run-time surprises

| # | Correction |
|---|---|
| **D-1** | The runbook's own §4 integrity SQL **does not execute** — `reviews` has no `created_at`. Fixed in the runbook this session. |
| **D-2** | `pitr_enabled` is **false** on both projects. `launch-checklist.md` asserted it was enabled. Corrected in three files. |
| **D-3** | The API's cost estimate ($10/mo) was **20×** the dialog's actual ($0.50/mo). |

**The pattern is the same one session 3 of G.3 recorded:** every deviation here corrected
a claim that was already standing in a checked-in document, and none of them was
discovered by the drill failing. They were discovered by **executing the document
instead of reading it**. D-1 in particular had survived the runbook's authoring, its
review, and two handoffs citing it as ready to run.

## Cost

| Item | Amount |
|---|---|
| Approved before the run | $10/month prorated |
| Actually quoted at creation | **$0.50/month** — Compute $0, Disk $0.50 |
| Project lifetime | **6 min 52 s** |
| **Real charge** | **≈ $0.0007** |

## Open items this drill created

1. **The PITR add-on decision is now explicit and priced.** ~$100/month for 7-day
   retention, hourly $0.137, **not covered by the Spend Cap**. Accepting a 24 h RPO
   through beta is defensible; *believing* the RPO is 2 minutes is not. Tracked as its
   own unticked line in `launch-checklist.md`.
2. **Re-measure RTO once real data exists.** This figure is a floor.

## Teardown

**Complete.** T1 executed at 21:33:29Z and verified by absence at 21:33:46Z. No fixture
survives this run. No flag was flipped. No worker was stopped. Nothing was written to
production or staging.

**UTC start 2026-09-01T21:20:11Z · UTC end 2026-09-01T21:34Z · elapsed 14 min.**
