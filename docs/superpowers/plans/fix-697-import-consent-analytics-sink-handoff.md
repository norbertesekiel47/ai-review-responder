# Handoff — `fix-697-import-consent-analytics-sink`

**Lane:** SMALL path, RISK = high, SURFACE = backend, `db_touching: false`.
**Status: AWAITING OWNER MERGE APPROVAL on PR #708.** Everything before that is done.

## Where the state lives

| Thing | Path |
|---|---|
| Intake contract (locked) | `docs/superpowers/plans/fix-697-import-consent-analytics-sink-intake.json` (audit copy) + `.feature/intake.json` (arming copy) |
| Review report + triage verdicts + mutation log | `docs/reviews/fix-697-import-consent-analytics-sink/spec-correctness-r1.md` |
| Blast radius | `docs/reviews/fix-697-import-consent-analytics-sink/blast-radius.md` |
| Staging-ride evidence | `docs/reviews/fix-697-import-consent-analytics-sink/staging-ride.md` |
| Phase / round counters | `.feature/state.json` |

There is **no plan file and no deviations file** — the SMALL lane skips steps 3, 4
and 6, and nothing was delegated to a subagent except the single review axis.

## What shipped

One guarded `Sentry.captureMessage` in `emitConsentEvent`
(`src/lib/reviews/import-consent.ts`), `level: 'warning'`, tags
`subsystem: import_consent_analytics` + `event_name`, alongside the pre-existing
`warn`. The capture has its own `try`/`catch`; the `warn` sits **outside** it so
it survives Sentry being unreachable. Precedent followed verbatim:
`src/lib/llm/circuit-breaker.ts:185-205`.

Nothing about the savepoint or the `errorStringProperty(error,'code')` narrowing
changed. A code-less error still rethrows, now **before** any capture.

Two docs carry the routing tag: `docs/runbooks/beta-launch-alerting.md` §1 and
`docs/launch-checklist.md`. Both say to use an **event-frequency** condition, not
"a new issue is created" — the title is a constant so everything groups into one
issue and a new-issue rule would fire once, ever.

## Decisions locked during grilling (do not re-litigate)

1. **Sink = guarded `captureMessage`**, not `reportCaughtError` (fixes level at
   `error` and tags only `endpoint`, which the runbook's rules do not route on)
   and not a HealthAlertPoller counter (needs a cross-lane counter store for
   one-shot events).
2. **#695 is NOT designed together with this.** Different sink, different
   subject, open architectural question. It stays open.
3. **Staging proof is synthetic**, not a constraint drop on the shared database.

## Counters and budgets

- `allowed_edit_surface` amendments: **1 of 2** (`docs/launch-checklist.md`, added
  after review round 1 found a second routing inventory). A second amendment
  fires the abort criteria.
- Branch review rounds: **1 of 3**. Round 1 returned two Low findings, both
  accepted and fixed; no round 2 was needed.
- Gate-fail rounds: **0**.
- Diff vs estimate: prod ~104 vs 60 (1.7x), test ~168 vs 110 (1.5x). Both under
  the 2x re-classification trigger.

## Verification already done

- `scripts/verify-gate.sh --review` GREEN (lint, typecheck, test, 16 `ci:*`
  audits, the changed live-DB integration suite, `promised-tests`,
  `diff-coverage`). Re-run green after the review fixes and again after the
  evidence commit.
- **Five mutations**, each verified to turn the intended title red and only that
  title — table in the review report.
- Staging ride: `1ad175a3..2108c3cc` on `staging`, both deploys green. Sentry
  issue `REPWORTH-STAGING-S` landed with the routable tag, then resolved with a
  synthetic-marker comment. Nothing persisted to the staging database.
- PR #708 to `main`: **all 15 checks pass**, including `fallow`, `e2e`,
  `react-doctor`.

## Remaining — step 8 post-merge, after the owner approves

1. Merge PR #708.
2. `git pull --ff-only` on local `main` (squash-merge lag).
3. Fast-forward `staging` onto `main` (`git merge --ff-only main`).
4. `bash scripts/feature-cleanup.sh` from the main checkout (dry run first, then
   `--apply`). This also sweeps the older merged worktrees.
5. No deviations file to promote from — but DO promote the durable lesson: a
   `warn` that reaches only stdout is not a signal, and the guarded-capture +
   subsystem-tag shape is now used at three sites (`circuit-breaker`,
   `contact-notify`, `import-consent`) and is worth a lab-note.
6. `document-feature` skill sweep; fold nothing new into `CONTEXT.md` — this
   feature coined **no new domain term** (it uses **Import offer**, **Import
   decision**, **Import consent** as already defined).
7. Increment the merge counter in `.claude/reference/arch-review-log.md`. It was
   already at 12 (2.4x the 5-merge threshold) before this one — the architecture
   review is overdue and should be raised with the owner.
8. **Ops follow-up, not code:** configure the Sentry rule for
   `subsystem:import_consent_analytics`. Until that exists the signal is durable
   but unpaged, which is the state both docs now describe.
