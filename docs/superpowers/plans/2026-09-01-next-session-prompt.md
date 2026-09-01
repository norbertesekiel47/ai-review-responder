# Prompt for the next session

> Paste everything below the line into a fresh Claude Code session in this repo.

---

Continue the RepWorth beta launch. G.3 is **6 of 10** and the last session ended
at 2026-09-01T05:50Z. Work in this order:

1. G.3's remainder — §4.6, then §4.10, then §4.8's re-run
2. The PITR restore drill
3. The secret rotation
4. Phase H

Start by reading these, in order:

1. `docs/superpowers/plans/2026-09-01-g3-remainder-handoff.md`
   — the pointer. State, the seven traps, what is ready and what is blocked.
     It supersedes the 2026-08-31 handoff for G.3 only; that file's PITR and
     rotation items are unchanged and still authoritative.
2. `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md`
   — the campaign record. Read **Session 2** and the **verdict** first, then
     deviations D-5 … D-9. Read the **teardown ledger** before creating any
     fixture; T7–T11 are closed and staging is clean.
3. `docs/runbooks/beta-launch-alerting.md` §4
   — the drills. Read §4's **precondition** box and the **§4.8** entry before
     running anything.
4. `.claude/reference/lab-notes.md`, entries dated **2026-09-01**
   — three reusable lessons, two of which are corrections to earlier claims.
5. `docs/runbooks/beta-production-standup.md` §§G–H
   — the protocol. Phase H is the finish line and has not started.

The full launch record is published at:
⧉ https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c
Read it with the Artifact tool before proposing any step. Its eleven traps still
apply; the handoff adds seven more.

Situation in one line: four drills passed overnight with owner-confirmed Discord
delivery, rule 6 now exists in both Sentry projects and closes a live production
gap — but the cron dead-man switch detects a dead worker and pages nobody, and
production runs the identical monitor.

Step 0: check for open PRs and merge before making new changes, then
`git pull --ff-only`. `main` is protected — land everything via PR. **PR #1053
carries this work and may still be open; merge it first.** PR #646 is
conflicting and obsolete — recommend closing, do not merge.

Rules that matter here:

- `search_issues` defaults to `is:unresolved`. An absence it reports is NOT
  evidence of absence — this invalidated a §4.8 conclusion once already. To
  prove nothing exists, query `detector:<id>` with **no** `is:` term.
- Sentry's frequency condition is a **filter**, not a trigger: "Issue frequency",
  stored as `Issue occurrences`. Looking only in the trigger dropdown makes it
  look deleted. A new alert also ships with four state-change triggers
  pre-populated — delete them, or `First seen event` fires on occurrence one.
- The Sentry MCP has **no create/update tool for alert rules**. Rule work is
  browser work. `/crons/<project>/<slug>/` 404s; monitors live at `/monitors/`.
- `railway variables` and the MCP's `list-variables` return PLAINTEXT values for
  **every** variable. Use `get-service-config` for names, and
  `railway run --service repworth-worker --environment staging -- node -e "console.log(process.env.X)"`
  to read one value.
- `infisical secrets` prints secret VALUES by default; its own `--show-values`
  help is wrong. Never let it write to a terminal.
- A vault write is a DEPLOY on every synced platform, and a variable change needs
  an explicit `railway deployment redeploy --from-source --service repworth-worker
  --environment <env> --project ad641d0e-dc01-4250-b71c-db1beedb9c8c --yes`
  afterwards. Confirm the value **at runtime**, not from config. "Online" is not
  evidence.
- `repworth-worker` is ONE service shared by staging AND production. Always pass
  environmentId.
- **Staging auto-deploys on push to the `staging` branch.** Another session did
  exactly that mid-drill last night and silently ended a worker stop. Check for
  concurrent staging work before any drill that stops the worker.
- `psql` rejects the pooler URL's `?pgbouncer=true`. Strip it, or use the
  Supabase MCP.
- Invoke the `runbook` skill before the first G.3 fixture, and the `flag-flip`
  skill before changing any env var.
- Do not touch `docs/marketing/*`, `docs/help/marketing/`, or
  `docs/roadmap/2026-08-29-*` — uncommitted work from another session.

Start with **§4.6**. Everything is ready: rule 6 is built and verified in both
projects, and the probe shape is recorded in the evidence file's prep section.
Two cautions: the assertion is a **negative first** — POSTs 1–3 must produce
**nothing**, and only the 4th may page, so a page on POST #1 means the rule's
state-change triggers were not removed. And it writes **one permanent**
`solicitation_suppressions` row by design — use the fictional `.test` recipient
and leave the row.

The verification method that works: run the check predicate verbatim from source
against the DB before waiting, so a non-firing poller is distinguishable from a
non-matching fixture. Then read the worker log, then the rule's `lastTriggered`
via the Sentry MCP, then ask me to confirm Discord. `lastTriggered` proves Sentry
fired; only a human proves Discord received. Batch the Discord confirmations —
do not interrupt once per drill.

I will run browser steps and confirm Discord. Tell me exactly what to click and
what to record, and verify everything else from the API and the database
yourself.

Four things carried forward that are easy to lose:

1. **§4.8 is the finding that outranks the passes.** The cron monitor detects a
   stopped worker — two missed check-ins, `ok` → `error` — and creates **no
   issue**, so no rule can fire. Its panel says "Detect: One failed check-in", so
   one should have sufficed. Fix the monitor's notification target and threshold
   in the UI **before** re-running, and repeat on production, which runs the
   identical monitor. Every other §4 signal is emitted BY that poller, so if it
   dies they all stop silently and this is the only thing that would say so.
2. **§4.7 is blocked infrastructurally, not by oversight.** Sentry refuses
   `*.railway.app` — that shared domain has hit a platform-wide cap of 1000
   uptime monitors. Production is monitorable only because its worker has
   `worker.repworth.net`. The remedy is a custom domain for the staging worker.
3. **The PITR drill costs $10/month base** for a new Supabase project in org
   `Startups` (pro plan) — confirm the spend before starting. The clone mirrors
   the source's compute so it may be more; §6 deletes it, so the charge is
   prorated. `pitr_enabled` is still unverified and needs a PAT against
   `/v1/projects/{ref}/database/backups`. Do NOT reorder it before F.4 —
   zero-state makes §4's row-count checks pass vacuously.
4. **Rotating `ZERNIO_WEBHOOK_SECRET` must `PUT` subscription
   `6a95315320358f33c89599e5`'s `secret` in the same change**, or ingest breaks.
