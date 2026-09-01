# Handoff — the PITR drill, the rotation, then Phase H

> **Written:** 2026-09-01T21:00Z · **Owner:** @norbertesekiel
> **Supersedes** `2026-09-01-g3-remainder-handoff.md` entirely. That file's §4.6 and §4.10 items
> are **done**; its §4.8 remedy is **wrong** and is corrected below.
>
> **This is a pointer, not a source of truth.** If it disagrees with an owning file, the owning
> file wins — and fix this one in the same change.

---

## The one-line situation

**G.3 is 8 of 10, and both remaining drills are blocked on something outside our code.** §4.8 is
a **Sentry defect** — the cron monitor detects an outage and Sentry creates no issue, proven past
argument on 2026-09-01. §4.7 needs **DNS**. Everything else in Phase G is done. **The next work
is the PITR drill, then the rotation, then Phase H — the finish line.**

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md` | The campaign record. Read **Session 3** and its verdict; D-10 … D-18 are the deviations |
| 2 | `docs/runbooks/pitr-restore-drill.md` | The next task, start to finish |
| 3 | `docs/runbooks/beta-production-standup.md` §§G–H | The protocol. **Phase H has not started** |
| 4 | `.claude/reference/lab-notes.md`, entries dated **2026-09-01** | Six reusable lessons |

**Launch record artifact:** `https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c`
— now carries **15** numbered traps. Read them before touching anything.

---

## What is DONE, and what it cost to learn

| Drill | Verdict |
|---|---|
| §4.2, §4.3, §4.5, §4.4, §4.1, §4.9 | ✅ PASS (sessions 1–2) |
| **§4.6 Unattributed suppression** | ✅ **PASS** — owner-confirmed in Discord, one message at 06:07:44Z and **silence** before it |
| **§4.10 Capacity headroom** | ✅ **PASS** — peak pending 50/1500, drained in 13 min of a 30-min target, no false alarm |
| **§4.8 Probe stopped** | ⚠️ **QUALIFIED FAIL — do not re-run it** |
| §4.7 Killed worker | ❌ **BLOCKED** — needs a custom domain |

**Four Sentry rules were rebuilt on 2026-09-01, all verified by API readback:**

| Rule | Change | At |
|---|---|---|
| `3927243` staging | `Issue occurrences` filter **removed** | 18:08:43Z |
| `3927261` production | `Issue occurrences` filter **removed** | 18:09:17Z |
| `3608329` staging | `Issue category = outage` **added** (5th `any` clause) | 19:12:49Z |
| `3925256` production | `Issue category = outage` **added** (5th `any` clause) | 19:19:17Z |

## §4.8 — do NOT re-run it, and do not "fix the threshold"

**Both earlier handoffs told you to open the monitor and set an issue-creating failure threshold.
That instruction is inert. The threshold is already 1**, and Sentry's own UI text describes it as
*"consecutive **missed or error** check-ins"* (D-16).

The 20:15–20:32Z re-run closed every alternative **before** the worker was stopped:

- Three missed check-ins: 20:20:16Z, 20:25:18Z, 20:30:22Z. Environment `ok` → `error` in ~4.5 min.
- **No issue created. The resolved June issue did not regress either** (`monitor.slug:health-alert-poller`, no `is:` term, 24 h **and** 90 d).
- The routing rule exists and was API-verified. Its triggers hold **both** first-seen and regression.
- `origin/staging` was the deployed commit, so nothing else ended the stop.

**One link is broken and it is Sentry's.** Open a support ticket with: monitor
`e925e758-10ec-455e-b2f1-aeb47a8a261c`, Failure Tolerance 1, the three miss timestamps, zero
issues created. **Two orphan rules (`3930310` + sibling) are the reproduction case for D-17 — do
not delete them, and do not mistake them for alerting.**

---

## 1. The PITR restore drill — the next task

`docs/runbooks/pitr-restore-drill.md`. Never run. A **hard blocker**.

- **Confirm the spend first.** $10/month base for a new Supabase project in org `Startups` (pro
  plan). §3 warns the clone mirrors the source's compute, so it may be more. §6 deletes it, so
  the real charge is prorated.
- **`pitr_enabled` is still unverified.** The Supabase MCP has no backups tool — it needs a PAT
  against `/v1/projects/{ref}/database/backups`.
- **Order is deliberate: it runs AFTER F.4, and F.4 is done.** Production now holds one real
  cancelled account, so §4's row-count and `max(created_at)` checks stop passing vacuously
  against an empty database. Do not reorder it.
- Non-destructive: §3 restores to a **new** project, never over production.

## 2. The secret rotation — deliberately last

Rotate `RESEND_API_KEY`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET` (exposed by **E-F1**).

> ⚠️ **Rotating `ZERNIO_WEBHOOK_SECRET` must `PUT` subscription `6a95315320358f33c89599e5`'s
> `secret` in the SAME change, or ingest breaks.**

Blast radius is near zero today and stops being zero at the first connected location. Every vault
write is a deploy on **every** synced platform — **trap 11, then trap 2**.

## 3. Phase H — the finish line

Not started. `beta-production-standup.md` §§9.1–9.6:

§9.1 sanity → §9.2 read-only backfill → §9.3 cost sanity → §9.4 approval email → §9.5 approval
page (**no approve click**) → §9.6 **one deliberate first post, clicked by a human**, with
`ZERNIO_PUBLISHING_ENABLED=false` ready as the kill switch.

Only then does beta tester one get an invite.

---

## The traps that will bite. All 15 in the artifact still apply.

These are the ones this session added or sharpened:

1. **`search_issues` defaults to `is:unresolved`.** An absence it reports is not evidence of
   absence. Query with **no** `is:` term to prove nothing exists.
2. **`Issue occurrences: N` is cumulative and fires at N+1.** No interval. The count never resets.
   For a rare-condition detector, prefer **no** occurrence filter and let the throttle carry volume.
3. **Filter monitor issues on `Issue category = outage`, never `monitor.slug`.** A slug equality
   works for one monitor and silently excludes every monitor added later.
4. **After `railway down`, a bare `redeploy` restores a STALE COMMIT.** Always `--from-source`,
   and **verify the new deployment's commit hash** against the branch tip. Observed restoring a
   commit from #230.
5. **Sentry's monitor-alert UI cannot create a working rule (D-17).** Three paths; two report
   success and persist nothing. Rule work that must stick goes through the API with a PAT.
6. **Read the implementation, not the doc comment above it.** The §4.6 probe's HMAC key was wrong
   because the comment described the scheme correctly and said nothing about key derivation.
7. **A cleanup command's success message is scoped to what it deletes.** `burst-drill-load release`
   is `status='pending'`; it printed "inventory clean" with 1000 completed rows still there.
8. **Another session can commit onto your branch.** It happened twice today, and once made the
   pre-push `merge-ledger` hook fail on files that were not mine. Check `git log` before pushing;
   cherry-pick onto a clean branch rather than absorbing or rewriting their work.

## Standing operational rules

- `railway variables` and the MCP's `list-variables` print **plaintext values for every variable**.
  Use `get-service-config` for names; `railway run … -- node -e "console.log(process.env.X)"` for one value.
- `infisical secrets` prints secret **values** by default; its own `--show-values` help is wrong.
- `repworth-worker` is **ONE service shared by staging and production**. Always pass `environmentId`.
- **Staging auto-deploys on push to `staging`.** Check for concurrent work before any drill that stops the worker.
- `psql` rejects the pooler URL's `?pgbouncer=true`. Strip it, or use the Supabase MCP.
- `main` is protected — land everything via PR. Docs-only PRs short-circuit the heavy CI jobs by design.
- Invoke the **`runbook`** skill before the first fixture of any campaign, and **`flag-flip`** before changing any env var.
- **Do not touch** `docs/marketing/*`, `docs/help/marketing/`, or `docs/roadmap/2026-08-29-*` — uncommitted work from another session.

## The three hard blockers

**PITR restore drill · lawyer review · insurance binding.** Never tick an incomplete box. Two
cannot finish quickly, which makes proceeding an explicit, recorded owner decision — a dated
block in `docs/launch-checklist.md`.

## Also owed, none blocking

| Item | Note |
|---|---|
| **Sentry support ticket** | §4.8's only remaining break |
| **Two orphan alert rules** | `3930310` + sibling — no project, no monitor, do not work. Keep as the D-17 repro |
| **Check-ins dropped as rate limited** | The staging monitor shows `3x Rate limited`. A dropped heartbeat on a dead-man switch is a false-alarm source. Uninvestigated |
| **Two §1 signals have no rule in either project** | `subsystem:refusal_ledger`, `subsystem:autonomy_governor` |
| **Close PR #646** | Conflicting and obsolete; its glossary terms exist in `CONTEXT.md` in later form |
| **Issue #1054** | Billing plan-switch labels derive tier order from price; both tiers are $19 |
| **Dependabot advisory** | 1 high on `main` — `security/dependabot/56` |
| Record the no-cancellation decision | F4-F4, a dated line in `launch-checklist.md` |
| `PAST_REPLIES_VIEW_ENABLED` | Read by no code; vault (web UI) first, then Vercel |
| IaC migration | Due 2026-12-01; `railway config migrate` output is unsafe as generated |

---

## What this session taught, in one line

**Six of nine deviations corrected a claim that was already standing** — two written hours
earlier, one a prediction the session made itself, and one an instruction it wrote minutes before
executing it. **Re-derive a blocking conclusion before building on it.** The cost of re-checking
is minutes; the cost of inheriting a wrong one is a remedy that does nothing, repeated across
sessions, while the real gap stays open.
