# Deviations — #1374 secret scan

Dated entries only. No Verdict line — the root triages.

## 2026-09-21 — `gate-fingerprint.mjs check` needed an explicit `write` first

`node .agents/skills/feature/scripts/gate-fingerprint.mjs check` (as briefed,
immediately after a green `--review` gate) failed: `missing
.feature/codex-gate-fingerprint.json; run verified-gate.sh`. This repo has
`scripts/verify-gate.sh` only — no `verified-gate.sh` wrapper exists to auto-run
`gate-fingerprint.mjs write` after a green gate, so the error message's own
remedy doesn't resolve on this checkout. `write` recomputes the same evidence
`check` re-derives (git diff/status hashes, gate-status hash, intake hash;
`.feature/codex-gate-fingerprint.json` itself is excluded from every hash it
takes) and is local `.feature/` bookkeeping only — no tracked file, no commit.
Ran `write` once, immediately followed by `check`, which then matched.

**Second-order effect, caught by `progress.mjs step execute done`'s own "gate:
stale (edits since fingerprint)" note:** the FIRST `write` ran before this
deviations file carried the paragraph you are reading now, so writing that
paragraph (docs-only, `.feature/`-exempt, reclassify-skip-bucketed — but the
fingerprint hashes `git status`/diff over the WHOLE tree with no path
exemptions besides its own file) staled the fingerprint immediately. Fixed by
treating "finish every edit, including this file" as the actual precondition
for `write` — re-ran `write` once more after this paragraph was the last edit,
then `check`, with nothing touched after. No gate row re-run was needed (no
code changed, only this doc), so this did not consume a gate round.

**Verdict:** ACCEPT — with one correction: the wrapper DOES exist, at
`.agents/skills/feature/scripts/verified-gate.sh` (the lead looked under
`scripts/`). It runs `verify-gate.sh`, then `gate-fingerprint.mjs write` and
`check` — the same sequence the lead ran by hand, so the evidence is
equivalent. The root's brief named `verify-gate.sh`; that was the root's error.
The root re-derives all evidence on the committed HEAD anyway.

## 2026-09-21 — root re-ran step 0 with the real reclassify numbers

Root decision on the `reclassify` WARN below: **accepted**. Root re-ran step
0 with the real numbers (397 prod / 136 test): size reclassifies from
`small` to `standard`; risk stays `normal`; `allowed_edit_surface` unchanged;
no trim. The 110/120 intake estimate was wrong, not the implemented scope.
Execution resumes toward the `--review` gate under this reclassification.

**Verdict:** ACCEPT — the root's own decision, recorded faithfully. Consequence
for step 7: the production diff is above 300 lines, so the standards axis joins
the wave beside spec/correctness.

## 2026-09-21 — `reclassify` WARN: production bucket 397 > 2x estimate (220)

Fast gate (round 1) came back GREEN on every row except `reclassify`:

```
RECLASSIFY: production 397 > 2x estimated_prod_lines (110) changed lines
(workflow artifacts excluded) — re-run step 0 (re-classification trigger).
```

Per the working rules this is a mechanical STOP-and-report trigger, not
something to patch around — recorded here and the run halted before the
`--review` gate rather than proceeding past it. Test bucket is unaffected:
136 vs 2x estimated_test_lines (120) = 240 — no warning.

**Full split** (`reclassify_bucket`'s own rule: `__tests__/`/`*.test.ts(x)`/
`e2e/` → test, `docs/superpowers/plans/**` + `docs/reviews/**` +
`docs/runbooks/evidence/**` → skipped as the run's own mandated paperwork,
everything else → production — doc prose counts as production here):

| File | +/- | Bucket |
|---|---|---|
| `scripts/ci/secret-scan.ts` (new) | 196/0 | production |
| `docs/runbooks/secrets-rotation-api-keys.md` | 76/0 | production |
| `.gitleaks.toml` (new) | 47/0 | production |
| `docs/audits/2026-07-06-codebase-audit-findings.md` | 19/17 | production |
| `.github/workflows/ci.yml` | 36/0 | production |
| `lefthook.yml` | 5/0 | production |
| `package.json` | 1/0 | production |
| **production total** | | **397** |
| `scripts/ci/__tests__/secret-scan.test.ts` (new) | 130/0 | test |
| `src/__tests__/ci-audit-wiring.test.ts` | 6/0 | test |
| **test total** | | **136** |
| `docs/superpowers/plans/feat-1374-secret-scan-deviations.md` (new) | — | skipped (run's own paperwork) |
| `docs/superpowers/plans/feat-1374-secret-scan-intake.json` (untracked, pre-existing) | — | skipped (run's own paperwork) |

**Assessment, for the root's triage:** every one of the 397 production lines
traces to an explicit locked decision in the intake — none is scope drift.
`scripts/ci/secret-scan.ts` is comparably sized to the named precedent
(`merge-ledger-audit.ts`, 265 lines) once the fail-closed footgun (verified
empirically, §header comment) and the JSON-report finding/error
disambiguation are implemented with the same comment density the precedent
uses. `.gitleaks.toml`'s 47 lines are the required `[extend]` block plus the
two allowlist entries the required advisory pass produced. The CI step is an
inline, checksum-verified binary installer — inherently ~30 lines once
per-arch asset selection and `sha256sum -c` are spelled out, matching the
locked decision's explicit "no composite action" instruction. The runbook's
76 lines are the six required Rotation Log rows plus the two required new
sections (History scrub decision, Secret scan). The audit doc's 36 changed
lines are the required C1 status update. The 110/120 intake estimate reads
as simply too low for what the locked decisions actually specified, not as a
signal that the implementation overshot its contract.

First full gate run failed `test` with 4 failures in
`scripts/ci/__tests__/edit-surface-guard-worktree.test.ts` (expects the
worktree-containment hook to exit 2 on a cross-checkout edit; observed 0).
Root cause, per the coordinator: this session's environment carries
`WORKTREE_EDIT_GUARD_DISABLE=1` (the documented escape used to unblock this
lead's first edit after the prior lead was stopped by the containment hook —
see the RESUME NOTE), and it leaks into the `pnpm test` subprocess, disabling
the guard the test asserts is active. Not caused by anything in this change.
Per the coordinator's instruction: did not unset it session-wide and did not
edit the guard or its test — every subsequent gate invocation is scoped as
`env -u WORKTREE_EDIT_GUARD_DISABLE bash scripts/verify-gate.sh ...` instead.

**Verdict:** ACCEPT — both halves. The overage is an estimation error: the root
inspected the diff and every file traces to a locked decision; 131 of the 397
lines are runbook/audit prose and config. The red `test` row is environmental,
same cause and handling as the two sibling runs.

## 2026-09-21 — `ci:feature-surface` needs new files staged, not merely present

The first full gate run also failed `feature-surface` — 3
`allowed_edit_surface` entries (`.gitleaks.toml`, `scripts/ci/secret-scan.ts`,
`scripts/ci/__tests__/secret-scan.test.ts`) read as matching NO file. Root
cause (read from `scripts/ci/feature-surface-audit.ts`): its "does every
surface entry match a file" check builds its candidate set from
`git diff --name-only <merge-base> HEAD` (committed diff — empty, since this
run makes no commits, per the swarm-lead contract) UNION `git ls-files`
(tracked files, which reads the **index**, not `HEAD`'s tree). A brand-new
file the working tree has never `git add`ed is in neither set, so a File the
guard hooks already accept under `allowed_edit_surface` still reads as
"matches nothing" to this specific audit. The nine `docs/**` surface entries
never hit this, because the audit's `isProcessEntry` exemption skips the
"must match a file" check for anything under `docs/` entirely.

**Fix: `git add` (stage, never commit) the three new non-docs files** —
`git add .gitleaks.toml scripts/ci/secret-scan.ts
scripts/ci/__tests__/secret-scan.test.ts`. Staging puts them in the index,
which `git ls-files` reads, without creating a commit object or moving the
branch ref — consistent with "make no commits… leave your work uncommitted"
(a commit and a stage are different git operations; `git status --porcelain`
still shows them as `A ` — added-to-index, not committed). No content
changed; nothing here is scope drift.

**Verdict:** ACCEPT — staging is not a commit, and the audit's read of the
index is correct behavior. It is an artifact of the swarm's no-commit rule for
leads; the root's commit makes it moot.

## 2026-09-21 — advisory full-tree pass result (edge case, intake §edge_cases)

Ran `gitleaks dir --redact --report-format json` against the whole worktree
(not the commit-range gate — that only ever sees `origin/main..HEAD`, which is
empty on this branch today) to find fixture classes that would trip the scan
if a future commit touched them.

**Before `.gitleaks.toml`'s allowlist (default ruleset only):** 328 findings.

| Rule ID | Count |
|---|---|
| generic-api-key | 320 |
| jwt | 2 |
| telegram-bot-api-token | 1 |
| openai-api-key | 1 |
| private-key | 1 |
| anthropic-api-key | 1 |
| gcp-api-key | 1 |
| stripe-access-token | 1 |

16 of the 328 were in `.env.local` — untracked (`git check-ignore` confirms
`.env*` is ignored) and never read for content, per the working rules on
secret handling. Untracked files never enter `git log`, so they are outside
every past or future `origin/main..HEAD` range and need no allowlist entry.
None of the six rotated 2026-09-20 secrets or their fingerprints were viewed;
this pass only ever reads gitleaks' own `--redact`ed JSON output.

The other 312 were in 43 TRACKED files — almost entirely
`docs/runbooks/evidence/**` run logs, `docs/reviews/red-team/**` findings, and
a handful of test fixtures. Field-name context (from gitleaks' redacted
`Match` prefix, e.g. `client_turn_key": "`, never the value) plus Entropy
3.5–4.5 (hex/UUID range, not high-entropy base64) shows these are Postgres
`uuid` columns mis-caught by the catch-all `generic-api-key` heuristic:

| Field-name class | Count |
|---|---|
| `client_turn_key` | 150 |
| `api_cost_id` | 70 |
| `attempt_token` | 58 |
| `tokenHashPrefix` | 12 |
| `clientTurnKey` | 3 |
| `auth_id` | 3 |
| everything else (SQL fixtures, `idempotencyKey`, `secret_token`, `tokenHash`, `key`, `SOLICITATION_KEY`, …) | 16 |

**Allowlist added to `.gitleaks.toml`** (two `[[allowlists]]` blocks):

1. **Value pattern** (preferred, per the locked decision) — a UUID v4
   (`[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}`) matched against the `generic-api-key`
   rule only (`targetRules`). Covers the `client_turn_key` / `api_cost_id` /
   `attempt_token` / `clientTurnKey` / `auth_id` classes (284 of 312, ~91%).
   Scoped to one rule on purpose: a vendor-specific rule (aws, stripe, openai,
   anthropic, jwt, private-key, gcp, telegram) still fires on a UUID-shaped
   value, since those match a distinct token *shape*, not "looks random".
2. **Path** (reserved for a file that exists solely as a fixture, per the
   locked decision) — the six test files whose whole purpose is
   token/key-shaped literals: `worker/ingress/__tests__/unsubscribe*.test.ts`
   (3 files), `src/lib/notifications/email/__tests__/{send-email,
   solicitation-client}.test.ts`, and
   `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts`.

**After the allowlist:** 20 findings (328 → 20). 16 are still `.env.local`
(unaffected by design — see above). The remaining 4, all pre-existing content
untouched by this branch and therefore outside today's empty
`origin/main..HEAD` range:

| File | Line | Field-name context |
|---|---|---|
| `docs/runbooks/completed_runbooks/phase-4-owner-channels-manual-test.md` | 57 | `secret_token=` |
| `docs/reviews/red-team/codex-owner-operator-run-e-eb15ab/findings.md` | 970 | `tokenHash":"` |
| `docs/runbooks/evidence/owner-operator-run-e-2026-09-15/run-e-cleanup-artifact-sha256.json` | 11 | a sha256 checksum manifest value (the file's own name) |
| `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | 100 | `` key: ` `` |

Entropy 3.7–4.5 on all four — consistent with a hash/fingerprint/hex value,
not a real credential. None look like a live secret; none is a value this
change touches. **Not allowlisted**, deliberately: guessing a broader hex
regex risks hiding a real generic-api-key leak, and the actual gate never
scans these lines unless a future commit touches them — at which point that
PR's own gitleaks run will name the exact line, and the right fix is decided
then (allowlist entry, or genuinely a leak). Recorded here so a future false
positive on one of these four files is recognized as "known, not new."

No real live secret was found anywhere in this pass — nothing in the 328 (or
the 20 residual) findings' field-name context resembles the six 2026-09-20
rotated secrets or any other provider credential shape.

**Verdict:** ACCEPT — the UUID value pattern is scoped to `generic-api-key`
only, and leaving the four residuals un-allowlisted is the safe direction. One
item goes to the review wave as an explicit question, not a settled point: the
path entry covers six TEST SUITES, and the locked decision reserved a path
entry for "a file that exists solely as a fixture". A test suite is not solely
a fixture, and a path entry hides every rule in that file.

## 2026-09-21 — drill result (T3, intake §observability)

Ran the required drill in a `mktemp -d` scratch git repo (never inside `$WT`,
per the secret-handling rules): committed a file containing a FAKE key-shaped
string assembled at runtime from script-local variable pieces (never a real
key, never written to `$WT`), committed its deletion, then ran the same
`gitleaks git --redact` command shape `scripts/ci/secret-scan.ts` uses over
that two-commit range with the repo's own `.gitleaks.toml`.

Command shape: `gitleaks git --log-opts=<oldest>..HEAD --redact --config
.gitleaks.toml --report-format json --report-path - .`

Result: exit code **1**; the JSON report to stdout carried the finding with
`"Secret": "REDACTED"` and `"Match": "...REDACTED..."` — no value ever
appeared in the terminal, a file, or this document. Full detail: the "Secret
scan" section of `docs/runbooks/secrets-rotation-api-keys.md`.

**Verdict:** ACCEPT — the drill ran as specified, outside the worktree, with a
runtime-built fake value, and proves the committed-then-deleted shape is caught.

## 2026-09-21 — `origin/main` empty-range assumption is live on this branch

`origin/main..HEAD` is empty as of this branch's current HEAD (no commits
landed on `feat/1374-secret-scan` yet), so `pnpm ci:secret-scan` exercises the
"reports the scanned commit count when the range is empty" path for real, not
just in the unit tests. Confirmed: exit 0, `secret-scan: passed (0 commit(s)
scanned in origin/main..HEAD)`. Not a deviation from the plan — noted because
it means this run's own gate never scans a fake or real secret in $WT's
actual history; T1's unit tests plus the T3 scratch-repo drill are what
exercise the finding path.

**Verdict:** ACCEPT — and it stops being true the moment the root commits: the
post-commit gate scans this branch's own commits for real, which is the first
non-vacuous run of the scan.

## 2026-09-21 — Surface amendment 1: `.claude/reference/arch-review-log.md`

`ci:merge-ledger` requires one added ledger line from any branch that touches
the governance surface (`package.json`, `lefthook.yml`). The intake did not list
the ledger file and the edit-surface guard does not always-allow it. The lead's
gates passed the row vacuously: the audit reads the COMMITTED range and the
lead made no commits. The sibling run fix/1149 surfaced it on its first
post-commit gate. Owner approved the amendment on 2026-09-21 (one question
covered all three swarm runs). Both intake copies updated, `incr-amendment`
counted (surfaceAmendments=1), one ledger line added by the root.

**Verdict:** ACCEPT — process-ledger path required by a CI audit;
owner-approved; no locked decision changes.

## 2026-09-21 — Review round 1 fixes (triage: `docs/reviews/feat-1374-secret-scan/triage.md`)

The spec axis REPRODUCED a green pass over a real finding: gitleaks 8.30.1
exits 0 with `[]` on stdout when its internal `git log` fails (`ERR [git]
fatal: …`, `INF 0 commits scanned.`), and the first implementation trusted the
empty report. That broke the intake invariant "a gate that cannot see never
passes". The pass condition is now a conjunction: exit 0, stdout `[]`, no
`ERR`/`FTL`/`fatal:` marker on stderr, and gitleaks' OWN `N commits scanned.`
count equal to the scannable-commit count git reports for the same range.

[CORRECTED 2026-09-21 by review round 2 — the first version of this paragraph
recorded a FALSE measurement: "gitleaks counts only commits whose diff ADDS at
least one line". Measured properly in round 2: gitleaks runs `git log -p -U0`
and counts a commit when it yields a hunk on a SURVIVING file — added OR removed
lines. Whole-file deletions, renames, mode-only and binary-only commits are not
counted. See the round-2 entry below for the design consequence.] The expected
count is read from `git log --numstat` rather than `rev-list --count` (which
would fail every push containing a rename-only or whole-file-deletion commit). `--diff-merges=remerge` is passed to both sides, which also
closes spec F6: a secret that exists only in a merge resolution is now scanned
(`-m` double-reports; `--cc`/`-c` find nothing; `--first-parent -m` drops
side-branch commits — each tried in a scratch repository). Each new fail-closed
branch was neutered once to prove its test reddens.

Also: `targetRules = ["generic-api-key"]` on the path allowlist (a runtime-built
fake private-key block at an allowlisted path is now reported); the base ref
comes from `merge-ledger-audit.ts` `baseRefFor()`; the Rotation Log names the
real variables and no longer claims "still-live"; audit C1 step 3 is PARTIAL and
the box is unticked; the drill is reproducible from a construction recipe, never
a literal.

Named risk: the cross-check parses a human-readable gitleaks log line and
depends on what gitleaks chooses to count. A gitleaks release that changes
either FAILS the scan (never passes it) — CI is pinned to 8.30.1 by sha256, a
developer machine is not, so a Homebrew upgrade can block pushes until the
parser is updated (`git push --no-verify` is the escape; CI stays the backstop).

**Verdict:** ACCEPT — the P1 is closed with a reproduction, the design fails in
the safe direction, and its fragility is named.

## 2026-09-21 — `reclassify` WARN after the review fixes: production 656, test 313

Both buckets are over 2x the intake estimate (110 / 120). The branch was already
re-classified `standard` / `normal` before review; these numbers do not move it
again (one seam, one script, a tight surface, no new risk domain). Roughly 480 of
the 656 "production" lines are runbook, audit and config prose plus comments; the
script itself is about 370 lines, most of the growth being the fail-closed
cross-check and its explanation.

**Verdict:** ACCEPT — review-driven growth; classification unchanged since the
first re-run of step 0.

## 2026-09-21 — Review round 2: the branch failed its own scan, and the count model was wrong a second time

**N1 — the scan caught this branch.** The round-1 fix commit (`8092131a4`) added
a drill recipe to the runbook that wrote the literal PEM begin marker and end
marker a few words apart; gitleaks' default `private-key` rule matches across
that prose, so `ci:secret-scan` exited 1 on the post-commit gate. A false
positive — and the first proof the scan is live on a real commit. Because the
scan reads COMMITS, a later commit cannot clear it. The fix commit was never
pushed, so the root undid it with `git reset --soft 6ac36114c` (work kept,
staged) and the recipe is reworded so neither full marker is ever a literal; the
fix lands as one new commit. Lesson for the runbook's own audience: a doc that
EXPLAINS a secret shape must describe it, never spell it.

**N2/N3 — exact count parity was the wrong design.** Round 1's model
(`rev-list --count`) and round 2's ("commits that add a line") were both wrong
about what gitleaks counts, and each error produces a false FAIL that blocks an
honest push — on a line-deletion-only commit, and on a revert. A developer
blocked for no reason learns `--no-verify`, which is worse than no gate. Owner
decision 2026-09-21: a LOWER BOUND. Fail when gitleaks scanned FEWER commits
than the number of commits that add text lines — every measured case agrees
gitleaks always counts those; it may count more. The stderr git-error check
stays the first defense, and it alone catches the round-1 reproduction.

**N4 — a documented limit, not a fix.** A file marked `-diff`/`binary` in
`.gitattributes` yields no text hunk, so gitleaks never reads it and a key
inside it passes. No count can see that. Stated in the script header and the
runbook; the header no longer implies that matching counts prove coverage.

**Verdict:** ACCEPT — owner-decided design; both P1s traced to their cause; the
history rewrite touched only an unpushed local commit.
