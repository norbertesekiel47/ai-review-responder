# Handoff — G.3's remainder, then the last two items before Phase H

> **SUPERSEDED IN PART by session 3, 2026-09-01T06:25Z.** §4.6 and §4.10 are **done and
> passing**; G.3 is **8 of 10**. §4.8 is still open and now needs **two** fixes, not one —
> see D-14. Sections 1 and 3 below are historical; read the evidence file's **Session 3**
> block for current state.

> **Written:** 2026-09-01T05:50Z · **Owner:** @norbertesekiel
> **Supersedes** `2026-08-31-remaining-three-handoff.md` for the G.3 portion only. That file's
> item 2 (PITR drill) and item 3 (secret rotation) are unchanged and still authoritative.
>
> **This is a pointer, not a source of truth.** If it disagrees with an owning file, the owning
> file wins — and fix this one in the same change.

---

## The one-line situation

**G.3 is 8 of 10** (was 6 at the time of writing; §4.6 and §4.10 passed in session 3). Two
remain, and neither is a code problem. **§4.8 is a qualified fail that matters more than any
pass** — the dead-man switch detects a stopped worker and pages nobody, and session 3 found a
**second** break downstream of the first (D-14), so it now needs a monitor fix **and** a cron
routing rule in each project. **§4.7 is infrastructurally blocked** (D-6) until the staging
worker has a custom domain.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md` | **The campaign record.** Read **Session 2** and the **verdict** first; D-5 … D-9 are in the deviations log |
| 2 | `docs/runbooks/beta-launch-alerting.md` §4 | The drills. Read §4's **precondition** box and the **§4.8** entry before running anything |
| 3 | `.claude/reference/lab-notes.md`, entries dated **2026-09-01** | Three reusable lessons, two of which are corrections |
| 4 | `docs/runbooks/beta-production-standup.md` → Phase G, G3 | The protocol box, now current |

---

## State of the drills

| Drill | Verdict | Note |
|---|---|---|
| §4.2 Failed publish | ✅ PASS | session 1 |
| §4.3 Zero-delivery | ✅ PASS | session 1 |
| §4.5 Send-breaker re-page | ✅ PASS | 2 pages 65 min apart, 13 emissions |
| §4.4 Cost-cap | ✅ PASS | terminal at 1/5 attempts, **zero provider spend** |
| §4.1 Stuck outbox | ✅ PASS | **D-1 called it unrunnable. It was not** — see D-7 |
| §4.9 Backlog depth | ✅ PASS | fires **and** clears |
| **§4.6 Unattributed suppression** | ✅ **PASS** | session 3 — rule 6 fired at 06:07:44Z; one permanent ledger row |
| **§4.10 Capacity headroom** | ✅ **PASS** | session 3 — peak pending 50 / 1500, drained in 13 min, no false alarm |
| **§4.8 Probe stopped** | ⚠️ **QUALIFIED FAIL** | detects, pages nobody — **and D-14 found a second break** |
| §4.7 Killed worker | ❌ BLOCKED | D-6, needs a custom domain |

---

## The traps that will bite this session

**All eleven from the launch artifact still apply.** These are the ones added or sharpened
overnight:

1. **`search_issues` defaults to `is:unresolved`.** An absence it reports is not evidence of
   absence — this invalidated a §4.8 conclusion once already. Query `detector:<id>` or
   `monitor.slug:<slug>` with **no** `is:` term when you need to prove nothing exists.
2. **The frequency condition is a FILTER, not a trigger.** "Issue frequency" under *Filter by
   issue attributes*, stored as `Issue occurrences`. Looking only in the trigger dropdown makes
   it look deleted. Rules 4, 5 and 6 are all buildable.
3. **A new Sentry alert ships with four state-change triggers pre-populated.** Delete them for
   any frequency rule, or `First seen event` fires on occurrence one and the filter is moot.
4. **The Sentry MCP has no create/update tool for alert rules.** Read tools only. Rule work is
   browser work. The `/crons/<project>/<slug>/` URL 404s; monitors live at `/monitors/`.
5. **`railway variables` and the MCP's `list-variables` return PLAINTEXT values for every
   variable.** Use `get-service-config` for names, and `railway run … -- node -e "console.log(process.env.X)"`
   to read one value.
6. **Staging auto-deploys on push to the `staging` branch**, and another session did exactly
   that mid-drill overnight, silently ending a worker-stop. **Check for concurrent staging work
   before any drill that stops the worker.**
7. **A variable write needs an explicit `redeploy --from-source` afterwards.** Overnight, an
   unrelated auto-deploy landed *between* the write and the drill and would have run it against
   the old value. Confirm the flip **at runtime**, not from config.

---

## 1. §4.6 — ✅ DONE, session 3. (Historical below; note the probe defect it did NOT catch.)

**Rule 6 exists and is verified:**

| | Staging | Production |
|---|---|---|
| Rule | `3927243` | `3927261` |
| Trigger | `Every event` only | `Every event` only |
| Filter (`all`) | `Issue occurrences ≥ 4` AND `feature eq solicitation_lane` | identical |
| Discord | `1517968864724385822` | `1544045194264051842` |

**Probe script:** written and ready at the session scratchpad path recorded in the evidence
file's prep section; re-create it from that section if the scratchpad is gone. It POSTs
svix-signed `email.complained` events to the staging worker's `/ingress/resend`.

**Run it as:**
```
railway run --service repworth-worker --environment staging -- node g3-46-probe.mjs 1
```
one at a time, checking after each.

**The assertion is a NEGATIVE first.** POSTs 1–3 must produce **no** Discord message. Only the
4th may. A page on POST #1 means the rule's state-change triggers were not removed.

⚠️ **This writes ONE permanent `solicitation_suppressions` row.** No expiry, no ordinary delete
path, by design — the admin Correction path is a compliance surface, not cleanup. The script
uses an obviously fictional `.test` recipient. **Leave the row.** Baseline before you start.

## 2. §4.8 — the finding that outranks the rest

> **UPDATED session 3 (D-14): there are TWO breaks, and the monitor fix alone is not enough.**
> A Sentry cron-monitor issue is generated by Sentry, not our SDK, so it carries none of
> `subsystem` / `cost_event` / `feature`. Staging's `3608329` was scoped at 05:35Z to four
> `Tagged event` equalities on exactly those keys under `any-short` logic, and it is the only
> Discord rule in the staging project — **so there is now no routing path at all**, even once
> the monitor creates an issue. Production additionally has the unfiltered `3920752`
> (New/Existing high-priority issue → Discord), a candidate path contingent on Sentry
> classifying the cron issue high priority, which is unverified.
> **Fix both, in order: (a) the monitor's failure threshold + notification target in the UI;
> (b) a DEDICATED cron rule per project — do not widen `3608329`/`3925256` and undo their
> deliberate scoping.** Only then spend a worker stop on the re-run.

**Do not re-run the drill until the monitor is fixed.** The chain breaks at issue creation:
detection works, no issue is created, so no rule can fire.

> **CORRECTED session 3 (D-16): do NOT set the failure threshold — it is already 1.**
> `REPWORTH-STAGING-8` embeds the monitor's own config:
> `{"failure_issue_threshold": 1, "recovery_threshold": 1, "checkin_margin": 5, "max_runtime": 5}`.
> That issue also proves the monitor CAN create issues (225 occurrences, 2026-06-26, *"A missed
> check-in was detected"* — so a **missed** check-in does count), and lists its complete tag
> set: `environment`, `interface_type`, `level`, `monitor.id`, `monitor.incident`,
> `monitor.slug`. The gap is the monitor's **notification target / owner**, which
> `recordProbeCheckIn`'s upsert cannot set — it passes only `schedule`, `checkinMargin`,
> `timezone`, and `find_monitors` reports `owner: null` on both. **Best lead:** the only cron
> issue this monitor ever made is tagged `environment: production` on a staging project (the
> stale environment §2a cleans up); the `staging` environment has never made one.

**Owner action, UI only** (`https://repworth-nv.sentry.io/monitors/` → `health-alert-poller`,
staging): **verify** the failure threshold reads 1, attach a notification target/owner, and
check the environment list for a stale `production` entry. **Repeat on production** — it runs
the identical monitor and has never produced a cron issue either. Then re-run: stop the worker
~12 minutes.

**Why it matters most:** every other §4 signal is emitted **by** the `HealthAlertPoller`. If
that poller dies they all stop silently, and this monitor is the only thing that would say so.

## 3. §4.10 — ✅ DONE, session 3 (historical below; and see D-15 on its cleanup)

`scripts/burst-drill-load.ts inject --events 1000 --duration-min 10 --confirm-staging kubdiqdhqbhwmqfditeg`
(default `--available-in-min 0`, the headroom arm). Watch `backlog.job_outbox` climb and drain
within 30 min and confirm **no** `backlog_depth` warning fires. Run under `railway run` so the
staging DB URL never transits the transcript. **Check for concurrent staging pushes first.**

## 4. §4.7 — blocked, and the remedy is DNS

Sentry rejects `*.railway.app`: that shared domain has hit a **platform-wide** cap of 1000
uptime monitors across all customers. Production is monitorable only because Phase A gave its
worker `worker.repworth.net`. **Give the staging worker its own custom domain** (e.g.
`worker-staging.repworth.net`), then create the monitor, then the drill runs.

---

## Then the two unchanged items, then Phase H

**PITR restore drill** — `docs/runbooks/pitr-restore-drill.md`. Still never run; still a hard
blocker. **Confirmed cost: $10/month base** for a new Supabase project in org `Startups`
(pro plan) — but §3 warns the clone mirrors the source's compute, so it may be more; §6 deletes
it, so the real charge is prorated. **`pitr_enabled` is still unverified** — the MCP has no
backups tool, so it needs a PAT against `/v1/projects/{ref}/database/backups`. Ordering was
corrected in the previous handoff and is unchanged: run it **after** F.4, because zero-state
makes §4's row-count checks pass vacuously.

**Secret rotation** — unchanged. `RESEND_API_KEY`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`.
Rotating `ZERNIO_WEBHOOK_SECRET` must `PUT` subscription `6a95315320358f33c89599e5`'s `secret`
in the same change or ingest breaks. Every vault write is a deploy.

**Phase H** — not started. §9.1 sanity → §9.2 read-only backfill → §9.3 cost sanity → §9.4
approval email → §9.5 approval page (**no approve click**) → §9.6 one deliberate first post,
clicked by a human, with `ZERNIO_PUBLISHING_ENABLED=false` ready.

---

## Also owed, none blocking

| Item | Note |
|---|---|
| **Two §1 signals have no rule in either project** | `subsystem:refusal_ledger`, `subsystem:autonomy_governor`. Both stopped paging on staging when `3608329` was scoped — that was recorded in advance, not a regression |
| **Close PR #646** | Conflicting, and its five glossary terms already exist in `CONTEXT.md` in later form |
| **Issue #1054** | Billing plan-switch labels derive tier order from price; both tiers are $19 so Autopilot→Copilot reads "Upgrade" |
| **Dependabot advisory** | 1 high on `main` — `security/dependabot/56` |
| Record the no-cancellation decision | F4-F4, a dated line in `launch-checklist.md` |
| `PAST_REPLIES_VIEW_ENABLED` | Read by no code; vault (web UI) first, then Vercel |
| IaC migration | Due 2026-12-01; `railway config migrate` output is unsafe as generated |

## The three hard blockers

PITR restore drill · lawyer review · insurance binding. **Never tick an incomplete box.** Two
cannot finish quickly, which makes proceeding an explicit, recorded owner decision — a dated
block in `docs/launch-checklist.md`.

---

## What this session taught, in one line

**Three of the five deviations were corrections to the campaign's own earlier conclusions, two
of them to claims made hours before.** A drill recorded as impossible was merely mis-fixtured;
a capability recorded as removed had moved one dropdown; an absence recorded as proof was a
default filter. **Re-derive a blocking conclusion before building on it** — the cost of
re-checking is minutes, and the cost of inheriting a wrong one is a checklist item that never
closes.
