# Paste-ready prompt for the next session

> Copy everything below the line into a fresh session.

---

Continue the RepWorth beta launch. G.3 is 8 of 10 and the last session ended at
2026-09-01T21:00Z. Work in this order:

1. The PITR restore drill
2. The secret rotation
3. Phase H

Start by reading these, in order:

- `docs/superpowers/plans/2026-09-01-phase-h-handoff.md` — the pointer. State, the eight new
  traps, what is blocked and why. **It supersedes the 2026-09-01 G.3 handoff entirely.**
- `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md` — the campaign
  record. Read **Session 3** and its verdict first, then deviations D-10 … D-18. The teardown
  ledger is fully closed; staging is clean.
- `docs/runbooks/pitr-restore-drill.md` — the next task, start to finish.
- `.claude/reference/lab-notes.md`, entries dated **2026-09-01** — six reusable lessons.
- `docs/runbooks/beta-production-standup.md` §§G–H — the protocol. Phase H is the finish line and
  has not started.

The full launch record is published at:
⧉ https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c
Read it with the Artifact tool before proposing any step. It now carries **15** numbered traps.

**Situation in one line:** G.3's two remaining drills are both blocked outside our code — §4.8 on
a proven Sentry defect, §4.7 on DNS — so the next real work is the PITR drill, then the rotation,
then Phase H.

**Step 0:** check for open PRs and merge before making new changes, then `git pull --ff-only`.
`main` is protected — land everything via PR. **PR #646 is conflicting and obsolete — recommend
closing, do not merge.**

## Do NOT re-run §4.8, and do not "fix the threshold"

Two earlier handoffs said to open the cron monitor and set an issue-creating failure threshold.
**That instruction is inert — it is already 1**, and Sentry's own UI calls it *"consecutive missed
or error check-ins"*. The 20:15–20:32Z re-run closed every alternative before the worker stopped:
three missed check-ins, environment `ok` → `error`, no issue created, and no regression of the
resolved one. **The next step is a Sentry support ticket**, with monitor
`e925e758-10ec-455e-b2f1-aeb47a8a261c`, tolerance 1, the three miss timestamps, zero issues.
Rules `3930310` and its sibling are broken on purpose — they are the D-17 reproduction case. Do
not delete them and do not read them as alerting.

## Before the PITR drill, get two answers

1. **Confirm the spend.** $10/month base for a new Supabase project in org `Startups` (pro plan);
   §3 warns the clone mirrors the source's compute, so it may be more; §6 deletes it, so the real
   charge is prorated.
2. **`pitr_enabled` is unverified.** The Supabase MCP has no backups tool — it needs a PAT against
   `/v1/projects/{ref}/database/backups`.

Do **not** reorder the drill before F.4. F.4 is done, and its one real cancelled account is what
stops §4's row-count checks passing vacuously.

## Rotating secrets

`RESEND_API_KEY`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`. Rotating `ZERNIO_WEBHOOK_SECRET`
must `PUT` subscription `6a95315320358f33c89599e5`'s `secret` **in the same change**, or ingest
breaks. Every vault write is a deploy on every synced platform.

## Rules that matter here

- `search_issues` defaults to `is:unresolved`. **An absence it reports is not evidence of
  absence.** Query with no `is:` term to prove nothing exists.
- Sentry's `Issue occurrences: N` filter is **cumulative with no interval** and fires at **N+1**.
  For a rare-condition detector, prefer no occurrence filter and let the 60-minute throttle carry
  the volume. A real rate condition is a **metric** alert.
- Filter monitor issues on **`Issue category = outage`**, never `monitor.slug` — a slug equality
  works for one monitor and silently excludes every monitor added later.
- **After `railway down`, a bare `redeploy` restores a STALE COMMIT.** Always `--from-source`, and
  **verify the new deployment's commit hash** against the branch tip.
- **Sentry's monitor-alert UI cannot create a working rule.** Rule work that must stick goes
  through the API with a PAT.
- `railway variables` and the MCP's `list-variables` return **plaintext values for every
  variable**. Use `get-service-config` for names and
  `railway run --service repworth-worker --environment staging -- node -e "console.log(process.env.X)"`
  for one value.
- `infisical secrets` prints secret **values** by default; its own `--show-values` help is wrong.
- `repworth-worker` is **ONE service shared by staging AND production**. Always pass
  `environmentId`.
- **Staging auto-deploys on push to `staging`.** Check for concurrent work before any drill that
  stops the worker.
- `psql` rejects the pooler URL's `?pgbouncer=true`. Strip it, or use the Supabase MCP.
- **Another session may commit onto your branch.** It happened twice on 2026-09-01. Check
  `git log` before pushing; cherry-pick onto a clean branch rather than absorbing or rewriting
  their work.
- Invoke the **`runbook`** skill before the first fixture, and **`flag-flip`** before changing any
  env var.
- **Do not touch** `docs/marketing/*`, `docs/help/marketing/`, or `docs/roadmap/2026-08-29-*` —
  uncommitted work from another session.

## How to verify anything

Read the check predicate verbatim from source before waiting, so a non-firing poller is
distinguishable from a non-matching fixture. Then the log, then the API. **Write the prediction
down before the run** — that is the only reason this session caught an off-by-one in a documented
filter.

I will run browser steps and confirm Discord. Tell me exactly what to click and what to record,
and verify everything else from the API and the database yourself. Batch the confirmations.

## Three things that are easy to lose

1. **The three hard blockers are PITR, lawyer review, insurance binding.** Never tick an
   incomplete box. Two cannot finish quickly, which makes proceeding an explicit, recorded owner
   decision — a dated block in `docs/launch-checklist.md`.
2. **Phase H §9.6 is one deliberate first post, clicked by a human**, with
   `ZERNIO_PUBLISHING_ENABLED=false` ready as the kill switch. No approve click before it.
3. **§4.7 needs DNS, not a drill.** Sentry refuses `*.railway.app` — that shared domain has hit a
   platform-wide cap of 1000 uptime monitors. Give the staging worker its own custom domain, then
   create the monitor, then the drill runs.
