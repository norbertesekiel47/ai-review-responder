# Paste-ready prompt for the next session

> Copy everything below the line into a fresh session.
>
> **Superseded twice on 2026-09-01.** The earlier version of this file pointed at the PITR drill
> and the secret rotation. **Both are done and merged.** Phase H is what remains.

---

Continue the RepWorth beta launch. **Phase H is the only item left before beta tester one — and
it cannot start yet.** The last session ended at 2026-09-01T22:45Z. Do not trust any SHA quoted in
a handoff — other sessions merge to `main` in parallel, and two did on 2026-09-01. Pull first.

Start by reading these, in order:

- `docs/superpowers/plans/2026-09-01-phase-h-execution-handoff.md` — the pointer. State, the
  prerequisite that blocks Phase H, the six new traps, what is owed.
  **It supersedes `2026-09-01-phase-h-handoff.md` entirely.**
- `docs/runbooks/deployment-guide.md` **§8 → §9 → §10** — Phase H's real content.
  **§10 is operational discipline and tells you to read it twice.**
- `docs/runbooks/evidence/2026-09-01-pitr-restore-drill-evidence.md` and
  `docs/runbooks/evidence/2026-09-01-secret-rotation-evidence.md` — what last session proved.
- `.claude/reference/lab-notes.md`, entries dated **2026-09-01** — eight reusable lessons.

The full launch record is published at:
⧉ https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c
Read it with the Artifact tool before proposing any step. It now carries **21** numbered traps.

**Step 0:** check for open PRs and merge before making new changes, then `git pull --ff-only`.
`main` is protected — land everything via PR.

## ⛔ Phase H is blocked, and the block is not technical

Production has **zero connected Google Business Profiles** and **zero accounts with full access**.
Measured 2026-09-01T22:40Z: `zernio_connections = 0`; the one business is `Tanicia Resort` with
`subscription_status = 'cancelled'`. §9.2 opens with *"Wait ~30s after §8 connect"*, and §9.4 and
§9.6 both read a live profile.

Two independent blocks — **fixing one does not fix the other**:

1. **No connected location.** That is `deployment-guide.md` §8, and it needs a real person: a
   friendly GBP whose owner has agreed to the test.
2. **The only account is `cancelled`**, which invariant #11 makes a no-op in both
   `NotificationWorker` and `ResponsePublisherWorker`. Gate on
   `subscriptionGrantsFullAccess(status)`, never a raw `=== 'active'`.

**Do not reactivate the F.4 test account without deciding what it is for** — that row is also the
one real record that keeps a future restore check from passing vacuously.

**So the first question is not a command: whose Google Business Profile is this, and have they
agreed?** Ask me before planning any step past §9.1.

## Two things finished last session, do not redo them

- **The PITR restore drill PASSED.** RTO **4 min 44 s**. It also proved **PITR was never enabled**
  — the real RPO is up to 24 h. The drill's box is ticked; a **new 🔴 blocker** stands in its
  place: buy the add-on (~$100/month, **not** Spend-Cap covered, and it **stops** daily backups),
  or record a dated decision to accept 24 h. That is an owner decision and is still open.
- **The three E-F1 secrets are ROTATED** and every old credential is verified dead.
  ⚠️ **`RESEND_WEBHOOK_SECRET` was NOT rotated and is still live** — provider-issued, its own change.

## Do NOT re-run §4.8, and do not "fix the threshold"

It is already 1. The 20:15–20:32Z re-run closed every alternative: three missed check-ins,
environment `ok` → `error`, no issue created, no regression of the resolved one. **The next step is
a Sentry support ticket**, with monitor `e925e758-10ec-455e-b2f1-aeb47a8a261c`, tolerance 1, the
three miss timestamps, zero issues. Rules `3930310` and its sibling are broken on purpose — the
D-17 reproduction case. Do not delete them and do not read them as alerting.

**§4.7 needs DNS, not a drill.** Sentry refuses `*.railway.app` — that shared domain hit a
platform-wide cap of 1000 uptime monitors. Give the staging worker a custom domain first.

## Rules that matter here

- **Never put a secret in a command — including one I type.** A `!` command is echoed into the
  transcript verbatim. Use `umask 077 && pbpaste | tr -d '\n' > f && wc -c < f`. This exact
  mistake happened last session, during the remediation of the same class of incident.
- **A command that WRITES a secret to disk creates a fixture** — teardown row first,
  `vercel env pull` included. Gitignore protects the repository, not the disk.
- `search_issues` defaults to `is:unresolved`. **An absence it reports is not evidence of absence.**
- Sentry's `Issue occurrences: N` is **cumulative with no interval** and fires at **N+1**.
- Filter monitor issues on **`Issue category = outage`**, never `monitor.slug`.
- **After `railway down`, a bare `redeploy` restores a STALE COMMIT.** Always `--from-source`, and
  verify the commit hash against the branch tip.
- **`vercel env ls`'s age column does not track a synced write.** Measure the value.
  `vercel redeploy` takes no `--yes`, needs `--scope`, and must be followed by an **alias check**.
- **Sentry's monitor-alert UI cannot create a working rule.** Use the API with a PAT.
- `railway variables` and the MCP's `list-variables` return **plaintext values**. Use
  `get-service-config` for names, and `railway run … -- node -e "…"` for one value.
- `infisical secrets` prints secret **values** by default; its own `--show-values` help is wrong.
- `repworth-worker` is **ONE service shared by staging AND production.** Always pass the environment.
- **Staging auto-deploys on push to `staging`.** Check for concurrent work before any drill.
- `psql` rejects the pooler URL's `?pgbouncer=true`. Strip it, or use the Supabase MCP.
- **Another session may commit onto your branch.** Check `git log` before pushing; cherry-pick onto
  a clean branch rather than absorbing their work.
- Invoke the **`runbook`** skill before the first fixture, and **`flag-flip`** before changing any
  env var.
- **Do not touch** `.agents/skills/feature/*`, `.claude/commands/feature*.md`,
  `.claude/reference/arch-review-log.md`, `docs/marketing/*`, `docs/help/marketing/`, or
  `docs/roadmap/2026-08-29-*` — uncommitted work from other sessions. Commit **named paths only**.

## How to verify anything

Read the check predicate verbatim from source before waiting, so a non-firing poller is
distinguishable from a non-matching fixture. Then the log, then the API. **Write the prediction
down before the run.**

I will run browser steps and confirm Discord. Tell me exactly what to click and what to record,
and verify everything else from the API and the database yourself. Batch the confirmations.

## Three things that are easy to lose

1. **Phase H §9.6 is one deliberate first post, clicked by a human**, on an old uncontroversial
   4–5★ review, with the profile owner's explicit agreement to *that specific review*, and
   `ZERNIO_PUBLISHING_ENABLED=false` ready as the kill switch. **No approve click before it** —
   §9.5 renders the page and you close the tab.
2. **§9.4 closes the rotation's last open proof.** The new Resend key is proven against the Resend
   API, but no production email has been sent under it. The approval email is that test.
3. **The hard blockers are RPO decision, lawyer review, insurance binding.** Never tick an
   incomplete box. Two cannot finish quickly, which makes proceeding an explicit, recorded owner
   decision — a dated block in `docs/launch-checklist.md`.
