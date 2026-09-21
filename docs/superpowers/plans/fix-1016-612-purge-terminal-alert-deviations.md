# Deviations — fix/1016-612-purge-terminal-alert

## 2026-09-21 — RT-05's "no rule routes the signal at all" is not exactly true at HEAD

**What.** The intake background states that no rule in the alerting runbook
routes the purge-failure signal (RT-05). At current HEAD that is true of the
Sentry `captureMessage` itself, but NOT of the failure as a whole: the terminal
path calls `markOutboxFailed`, and `checkFailedOutboxByTopic`
(`worker/background/pollers/health-alert/checks.ts`) has had an OPEN topic list
since #1378 — it reports every topic whose failed count exceeds
`HEALTH_ALERT_FAILED_THRESHOLD` (default `0`) inside
`HEALTH_ALERT_FAILED_WINDOW_S` (default `3600`). So
`outbox_failed:account_offboarding_purge` is a `subsystem:health_alert` finding
that rides rule 1 today.

**Why it matters.** Every claim in the runbook must be true at HEAD. Writing
"nothing routes this" would have been a false claim in the one document an
operator configures rules from.

**What I did.** Wrote the truth instead: rule 16's prose states that rule 1
carries the AGGREGATE handle (a topic and a count, never the offboarding id)
and that rule 16 carries the per-offboarding handle, so the two are
complements, not substitutes — the same framing the file already uses for
rules 9/1. Also noted that rule 1's own §1 box is still unchecked. No change to
`HealthAlertPoller` or its checks (explicit non-goal); the poller was read, not
touched.

**Verdict:** ACCEPT — root verified the claim at HEAD (`checks.ts:115-135`: no
topic filter, `failedThreshold` default 0 at `checks.ts:78`). The intake's goal
and every locked decision survive: the aggregate finding carries a topic and a
count, never the offboarding id, and RT-08 (one shared Sentry issue) is
untouched by #1378. The ticket premise "pages nobody" is stale and the owner is
told so in the run report and the PR body.

## 2026-09-21 — the session's worktree-guard escape turned 6 unrelated tests red

**What.** Gate round 1 came back RED on the `test` row with 6 failures, none of
them in this change's files: 4 in
`scripts/ci/__tests__/edit-surface-guard-worktree.test.ts` and 2 in
`scripts/ci/__tests__/red-team-mutation-runner.test.ts`.

**Why.** This session runs with `WORKTREE_EDIT_GUARD_DISABLE=1` — the owner's
documented escape from the RESUME NOTE, which unblocked editing into this
worktree. `.claude/hooks/edit-surface-guard.sh:67` short-circuits on it, and the
guard tests inherit `process.env` (minus `GIT_*`), so assertions that the guard
BLOCKS (exit 2) saw ALLOW (exit 0). `git diff --stat HEAD -- scripts/ .claude/`
is empty: this change touches neither tree.

**What I did.** Proved it rather than assumed it — `env -u
WORKTREE_EDIT_GUARD_DISABLE` over those two suites passes 257/257 — and ran the
review gate with the variable unset for that subprocess only. CI never sets it,
so this is the CI-faithful environment, not a relaxed one. No settings, hook or
`scripts/` file was touched.

**Verdict:** ACCEPT — environmental, same cause and same handling as the
sibling run fix/1149. The root runs every later gate with the variable unset
for the gate subprocess only.

## 2026-09-21 — one locked test title would have passed on first run

**What.** `the terminal purge path marks the outbox failed and does not throw`
describes behavior that already existed (the existing verification-remnants
test at PurgeWorker.test.ts covers the same control flow), so as a bare
control-flow assertion it would have been green before any production change —
a TDD-contract violation.

**Why.** The title is locked by the intake and could not be renamed.

**What I did.** Kept the title and made the test pin what is actually new ON
that path: exactly ONE `captureMessage`, carrying the terminal fingerprint,
alongside the no-throw and `markOutboxFailed` assertions. It failed RED with
the other four for the missing fingerprint, and it now pins the owner's
"one failure, one report" decision rather than restating a covered assertion.

**Verdict:** ACCEPT — the title is unchanged and the test is stronger than the
intake asked for; it pins the owner's no-double-report decision.

## 2026-09-21 — `reclassify` WARN: production bucket 68 lines against an estimate of 25

**What.** The gate counts runbook prose as production lines. Measured split:
27 lines of code (inside the 2x band) and 41 lines of runbook prose. Test
bucket 182 against 130 (inside the band).

**Why.** The intake estimated code only and did not budget the six-facet rule
row, the §1a-do entry and their precedent-shaped prose, which the intake itself
mandates.

**What the root did.** Re-ran step 0 with the real numbers: size stays `small`
(one seam, five files, about 250 changed lines with tests), risk stays `high`,
surface unchanged, no amendment. The estimate was wrong, not the scope.

**Verdict:** ACCEPT — estimation error on a docs bucket; classification and
lane are unchanged.

## 2026-09-21 — Surface amendment 1: `.claude/reference/arch-review-log.md`

**What.** `ci:merge-ledger` requires one added ledger line from any branch that
changes a production file. The intake did not list the ledger file and the
edit-surface guard does not always-allow it. The lead's gates passed the row
vacuously: the audit reads the COMMITTED range and the lead made no commits.
The sibling run fix/1149 surfaced it on its first post-commit gate.

**What the root did.** Owner approved the amendment on 2026-09-21 (one question
covered all three swarm runs). Both intake copies updated, `incr-amendment`
counted (surfaceAmendments=1), one ledger line added.

**Verdict:** ACCEPT — process-ledger path required by a CI audit;
owner-approved; no locked decision changes.
