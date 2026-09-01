# Handoff — Phase H, the finish line

> **Written:** 2026-09-01T22:45Z · **Owner:** @norbertesekiel · **`main` at `e4338f1c`**
> **Supersedes `2026-09-01-phase-h-handoff.md` entirely.** That file's three tasks are now
> **two done and one open**; its §4.8 and §4.7 findings still stand unchanged.
>
> **This is a pointer, not a source of truth.** If it disagrees with an owning file, the owning
> file wins — and fix this one in the same change.

---

## The one-line situation

**Phase H is the only item left before beta tester one — and it cannot start yet.** Production
has **zero connected Google Business Profiles** and **zero accounts with full access**, and
every step of §9.2 onward reads one. The PITR restore drill and the secret rotation both
**passed** on 2026-09-01. A **new hard blocker** opened in the drill's place: the RPO decision.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/deployment-guide.md` **§8 → §9 → §10** | Phase H's real content. **§10 is operational discipline and says to read it twice** |
| 2 | `docs/runbooks/evidence/2026-09-01-pitr-restore-drill-evidence.md` | Restore drill — PASS, and why the checklist was wrong |
| 3 | `docs/runbooks/evidence/2026-09-01-secret-rotation-evidence.md` | Rotation — PASS, 7 deviations, two of which are the session's real findings |
| 4 | `.claude/reference/lab-notes.md`, entries dated **2026-09-01** | Eight reusable lessons — four from the drill, four from the rotation |
| 5 | `docs/runbooks/beta-production-standup.md` §§G–H | The protocol and the sign-off block |

**Launch record artifact:** `https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c`
— updated 2026-09-01, now carrying **21** numbered traps. Read them before touching anything.

---

## ⛔ Phase H's prerequisite, and nobody has written it down until now

**§9.2 begins "Wait ~30s after §8 connect."** Everything from there reads a live profile.
Measured against production at 2026-09-01T22:40Z:

```sql
zernio_connections        = 0     -- no GBP connected, ever
businesses                = 1     -- 'Tanicia Resort', subscription_status = 'cancelled'
accounts (active|trialing)= 0
```

Two independent blocks, and **fixing one does not fix the other**:

1. **No connected location.** §9.2's backfill, §9.4's approval email and §9.6's post all require
   one. This is `deployment-guide.md` **§8**, and it needs a real person: a friendly Google
   Business Profile whose owner has agreed to the test.
2. **The only account is `cancelled`.** Invariant #11 — `cancelled` is a **no-op** in both
   `NotificationWorker` and `ResponsePublisherWorker`. Even with a connection, no approval email
   would send and nothing would post. Gate on `subscriptionGrantsFullAccess(status)`, never a raw
   `=== 'active'`.

> **Do not "fix" this by reactivating the F.4 test account without deciding what it is for.**
> That row is also the one real record that keeps a future restore check from passing vacuously
> (the drill's §4 relied on it). Decide deliberately; record the decision.

**So the first real question for the next session is not a command. It is: whose Google Business
Profile is this, and have they agreed?** §10's two-person rule, the deliberate choice of an old
uncontroversial 4–5★ review, and the monitoring window all assume a named human.

---

## What is DONE, and what it cost to learn

| Item | Verdict | PR |
|---|---|---|
| **PITR restore drill** | ✅ **PASS** — RTO **4 min 44 s**, every assertion held, cost $0.0007 | #1062 |
| **Secret rotation (E-F1)** | ✅ **PASS** — three secrets rotated, old credentials verified dead | #1063 |
| §4.2–§4.6, §4.9, §4.10 | ✅ PASS (G.3 sessions 1–3) | — |
| §4.8 probe stopped | ⚠️ **QUALIFIED FAIL — do not re-run.** Sentry defect | — |
| §4.7 killed worker | ❌ **BLOCKED** — needs a custom domain | — |

### The restore drill disproved the premise it was scheduled on

**PITR was never enabled.** `pitr_enabled: false` on production **and** staging;
`walg_enabled: true` on both. What exists is daily physical backups on a 7-day window, so the
real **RPO is up to 24 hours**. `launch-checklist.md` had asserted PITR was on — never verified,
and false. Corrected in three files including `rollback.md` §4, which is what an operator opens
during data loss.

**One hard blocker closed and a different one opened.** The drill is ticked; the **RPO decision**
is now its own unticked 🔴 line.

### The rotation reproduced the incident it was remediating

The agent's own "safe handoff" told the owner to paste a live key into a `!` shell command — which
is echoed into the transcript verbatim. **A production key was exposed at the moment of its
creation.** Revoked and replaced before installation; production never ran it, *verified by
hashing both rather than reasoning about the timeline*.

Then a sweep found **18 more** plaintext-secret files on disk from three prior sessions — ten
complete production credential dumps, a live Playwright session — **accumulated by the sessions
remediating E-F1**. All shredded. `.scratch/` is now clean for the first time since 2026-08-29.

---

## 🔴 The hard blockers — still three, but the membership changed

| Blocker | State |
|---|---|
| ~~PITR restore drill~~ | ✅ **closed 2026-09-01** |
| **RPO decision** ← **new** | Buy the PITR add-on (~$100/month, 7-day, **not** Spend-Cap covered, and enabling it **stops** daily backups) — or record a dated owner decision to accept 24 h through beta |
| Lawyer review | Unchanged. `docs/legal/legal-review.md` is a placeholder |
| Insurance binding | Unchanged. $1M E&O + Cyber, placeholder |

**Accepting a 24-hour RPO is a defensible beta posture. Believing the RPO is 2 minutes was not.**
Never tick an incomplete box; a recorded exception is a decision, an unticked box everyone stopped
looking at is not.

---

## Phase H, when the prerequisite clears

`deployment-guide.md` §9. **Everything below the approval click is reversible. The approval click
is the line in the sand.**

| § | Step | Note |
|---|---|---|
| 9.1 | Worker + ingress sanity | `curl https://worker.repworth.net/api/health`; Resend + Zernio test webhooks write `processed` rows; Sentry receives a handled error |
| 9.2 | **Read-only** backfill | Zernio fetches existing reviews. Nothing is posted. Worst case: unapproved drafts |
| 9.3 | Cost + rate sanity | `/admin/costs`, `/admin/jobs`. **If the OpenAI dashboard shows 0 calls, the key is silently broken and Anthropic is doing all the work** — fix before continuing |
| 9.4 | Approval email | **Closes the rotation's last open proof (U5)** — the new Resend key is API-proven but no production email has been sent under it |
| 9.5 | Approval page | **Renders only. Close the tab. Click nothing.** GET is read-only by design so email prefetchers cannot hijack the session |
| 9.6 | **One deliberate post** | The only step that touches a live GBP. Old, uncontroversial, 4–5★ review. Owner agrees to that specific review. `ZERNIO_PUBLISHING_ENABLED=false` ready |
| 9.7 | Edge cases | After §9.6. **Do not run these against the friend's resort** |

**§10's guardrails are not optional.** Two-person rule for the first post. Tell the owner the test
window. Turn off `weekly_summary_enabled` / `monthly_impact_enabled` on their business first — they
send mail on a schedule nobody signed up for.

---

## The traps that will bite. All 21 in the artifact apply. These are the six added today.

16. **Never put a secret in a command — including one a human types.** A `!` command is echoed
    into the transcript verbatim. *"The agent never sees the value"* and *"the value is not
    exposed"* are different claims. Use
    `umask 077 && pbpaste | tr -d '\n' > f && wc -c < f`. `tr -d '\n'` is load-bearing — an HMAC
    keys on the exact bytes.
17. **A command that WRITES a secret to disk creates a fixture.** Give it a teardown row *before*
    running it, `vercel env pull` included. **Gitignore protects the repository, not the disk.**
18. **A rotation is proven by the OLD key failing**, and by a real signed event — not by a write
    succeeding. Capture the **provider's key list** in preflight; a fingerprint cannot say which
    dashboard row the old key was. **Revocations silently fail** — one did.
19. **`vercel env ls`'s age column does not track a synced write.** Measure the value, never the
    metadata. And `vercel redeploy` takes **no `--yes`**, needs an explicit `--scope` even with one
    team, and must be followed by an **alias check** — a `Ready` deployment can serve nobody.
20. **A restore mirrors the DATA, not the MACHINE** — current platform Postgres, 1.5× disk. And a
    clone inheriting `pg_cron`/`pg_net`/`wrappers` runs the source's schedules against its own copy
    of live data. RepWorth has none of the three; one migration revokes that.
21. **An estimator and a confirmation answer different questions.** $10/month vs $0.50 for the same
    act. Quote the confirmation dialog.

### Still true from before

- `search_issues` defaults to `is:unresolved` — **an absence it reports is not evidence of absence**
- `Issue occurrences: N` is cumulative with no interval and fires at **N+1**
- Filter monitor issues on **`Issue category = outage`**, never `monitor.slug`
- After `railway down`, a bare `redeploy` restores a **stale commit** — always `--from-source` and
  verify the hash
- **Sentry's monitor-alert UI cannot create a working rule** — use the API with a PAT
- `railway variables` and the MCP's `list-variables` print **plaintext values**
- `repworth-worker` is **ONE service shared by staging and production** — always pass the environment
- **Staging auto-deploys on push to `staging`** — check for concurrent work before any drill
- `psql` rejects the pooler URL's `?pgbouncer=true`
- **Another session may commit onto your branch.** Check `git log` before pushing

---

## Owed, none blocking Phase H

| Item | Note |
|---|---|
| **Sentry support ticket** | §4.8's only remaining break. Monitor `e925e758-10ec-455e-b2f1-aeb47a8a261c`, tolerance 1, three miss timestamps (20:20:16Z / 20:25:18Z / 20:30:22Z), zero issues. **Evidence is ready; do not re-run the drill** |
| **§4.7 needs DNS** | Sentry refuses `*.railway.app` — platform-wide cap of 1000 uptime monitors. Give the staging worker a custom domain, then create the monitor |
| **`RESEND_WEBHOOK_SECRET` still live** | `799db5754a6eeafc`. Provider-issued (Svix); rotating means recreating the endpoint. Its disk copy was shredded — **a file being gone is not a credential being safe** |
| Two orphan alert rules | `3930310` + sibling. No project, no monitor, do not work. **Keep them — they are the D-17 repro** |
| Check-ins dropped as rate limited | Staging monitor shows `3x Rate limited`. A dropped heartbeat on a dead-man switch is a false-alarm source. Uninvestigated |
| Two §1 signals have no rule | `subsystem:refusal_ledger`, `subsystem:autonomy_governor` |
| Dependabot | 1 open high — `nanoid`, `security/dependabot/56` |
| Issue #1054 | Billing plan-switch labels derive tier order from price; both tiers are $19 |
| Re-measure RTO | 4 min 44 s is a **floor**. 17 MB is effectively no data |
| `PAST_REPLIES_VIEW_ENABLED` | Read by no code; vault (web UI) first, then Vercel |
| IaC migration | Due 2026-12-01; `railway config migrate` output is unsafe as generated |
| Record the no-cancellation decision | F4-F4, a dated line in `launch-checklist.md` |

---

## Do not touch

Uncommitted work from **other sessions** was in the tree throughout 2026-09-01. Branch around it
and commit **named paths only** — never `git add -A`:

- `.agents/skills/feature/*`, `.claude/commands/feature*.md`, `.claude/reference/arch-review-log.md`
- `docs/marketing/*`, `docs/help/marketing/`, `docs/roadmap/2026-08-29-*`
- `docs/superpowers/plans/2026-08-31-refusal-swarm-handoff.md`

---

## How to verify anything

Read the check predicate **verbatim from source** before waiting, so a non-firing poller is
distinguishable from a non-matching fixture. Then the log, then the API. **Write the prediction
down before the run** — that is the only reason the drill caught its own 3× RTO miss honestly, and
the only reason an off-by-one in a documented filter was ever visible.

Invoke the **`runbook`** skill before the first fixture, and **`flag-flip`** before changing any
env var.

The owner runs browser steps and confirms Discord. **Tell them exactly what to click and what to
record, and batch the confirmations.** Verify everything else from the API and the database.

---

## What this session taught, in one line

**A remediation is written by the same hands, in the same session, under the same assumptions that
produced the defect — and it arrives wearing the authority of a fix, so it gets *less* scrutiny
than the thing it repairs.** The restore drill passed while disproving its own premise. The
rotation succeeded while reproducing the incident it was closing. The sweep that followed found a
superset of the original exposure, built by the sessions doing the fixing. **Re-derive the
requirement a remedy is supposed to satisfy, in the remedy's own terms, before executing it.**
