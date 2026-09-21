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

## 2026-09-21 — Review round 1 changed two locked intake decisions (owner-decided)

**What.** (1) Codex A1: the intake locked a two-member terminal fingerprint, so
every terminal failure shared ONE Sentry issue and the rule's per-issue
60-minute throttle would suppress a second account's page. (2) Red team
RT16-01 (P0) and spec F1: the runbook's operator action prescribed a re-drive
that no code path can perform — a terminally failed purge has no recovery path
in the product at all.

**What the root did.** Took both to the owner (RISK = high). Decisions of
2026-09-21: the terminal fingerprint becomes
`[account_offboarding_purge_failed, terminal, <account_offboarding_id>]`
(retry stays shared); the runbook says the truth (no supported re-run; live
PII until fixed) and the recovery mechanism is issue #1411. Both intake copies
corrected (behavior text only — not a surface amendment). Pre-existing sibling
gaps went to issues #1412 and #1413 instead of into this branch.

**Verdict:** ACCEPT — owner-decided; the alert ships with a true procedure, and
the missing recovery path is tracked rather than papered over.

## 2026-09-21 — Review round 1 fixes (triage: `docs/reviews/fix-1016-612-purge-terminal-alert/triage.md`)

**What.** The doc pin now slices the runbook to rule 16's block and asserts on
the rule's own table row (filter, level, trigger, both fingerprints) — proved
against the red-team survivor's exact corruption (RED at
`PurgeWorker.test.ts:941`). The §1 bullet is cut to identity + pointer (one
owner per fact); three false or overstated runbook claims are corrected; the
paths rule 16 does not cover are named. The #612 scan now skips comment lines
(the regex is unchanged), so the intake's first resolution — rewording the
`purge-stages.ts` comment — is superseded and that file is back to its
merge-base content, out of the diff; proved by a temporary CODE respelling of
the key inside `purge-stages.ts` (RED at `ingest.test.ts:167`). The guard's
comment now states its real limit: a key built by other string means is not
detected.

**Verdict:** ACCEPT — every change traces to an accepted finding; both
test-strength fixes carry mutation proof.

## 2026-09-21 — `reclassify` WARN after the review fixes: production 64, test 339

**What.** Test bucket 339 against an estimate of 130 (over 2x); production 64
against 25 (34 lines of code, 30 of runbook prose).

**Why.** The review's accepted findings were almost all TEST-STRENGTH findings:
the rule-scoped doc pin, the per-offboarding fingerprint tests and the
comment-skipping scan account for the growth. Lab notes already record this
shape: "`reclassify` fires on exactly the branches whose review worked".

**What the root did.** Re-ran step 0 with the real numbers: size moves from
`small` to `standard` (about 400 changed lines with tests); risk stays `high`;
surface unchanged; no second amendment. The heavier lane's extra control is the
review wave, and this branch already ran the full high-risk wave (four axes
plus red team) and owes the scoped round 2.

**Verdict:** ACCEPT — growth is review-driven test rigor, not scope drift.
