# Deviations — feat/stripe-customer-redaction

## D1 — the armed ladder carried a stale classification

**What happened.** `scripts/feature-setup.sh:88` runs
`progress.mjs carry "$PARENT_ROOT"`, which copied the parent checkout's
`.feature/progress.json` into the worktree. That file held `epic·high·ui`
from an earlier, unrelated run, so the armed worktree reported the wrong
lane even though `.feature/intake.json` correctly held
`standard·high·backend`. `.feature/LADDER-NOTE.md` records the same class of
bug from 2026-09-02; renaming the stale file fixed one instance, and the file
was recreated since.

**What I did.** Re-ran `progress.mjs init --size standard --risk high
--surface backend` inside the worktree. The step history survived, because
`init` preserves an existing `steps` object. The intake was never wrong and
was not edited.

**Impact on the feature.** None. The ladder is reporting metadata only.

**Verdict:** ACCEPT

## D2 — my own `verification_commands` broke the gate

**What happened.** The first baseline gate went RED on
`extra-pnpm-test-worker-jobs-account-offboardin-cd840c`:
`offboarding-lifecycle.integration.test.ts:1543` expected a
`solicitation_suppressions` verification issue and instead saw
`accounts`/`businesses`/`users` each with `violationCount: 1`. The tree was
docs-only at the time, so nothing in this branch could have caused it.

**Root cause.** The three `verification_commands` I put in the intake each
spawn a separate `vitest run`, and the gate executes its `extra-*` rows in
PARALLEL. Two of those rows reach live-DB offboarding suites. Vitest's
serialized `integration` project only serializes suites WITHIN a single run,
so three concurrent vitest processes against one Postgres test database
interfere — the class `.claude/CLAUDE.md` warns about under the live-DB suite
conventions. A compounding factor: `scripts/verify-gate.sh:255` provisions the
test DB only when the diff is not docs-only, but lines 247-249 export
`TEST_DATABASE_POOL_URL` unconditionally, so the suites ran against an
unprovisioned database.

**Proof.** Run alone without the DB: 86 passed, 2 skipped. Run alone WITH
`TEST_DATABASE_POOL_URL` exported: 88/88 passed. The suite is green at HEAD;
only the parallel gate run failed it.

**What I did.** Cleared `verification_commands` to `[]` in both intake copies.
The gate's own `pnpm test` row already runs every suite with the correct
serialization, so the three commands added no coverage and actively broke the
gate. This is an intake correction, not a surface amendment, so it does not
count against the amendment budget.

**Impact on the feature.** None on behaviour. It removes a false-red source
from every future gate run on this branch.

**Verdict:** ACCEPT


## D3 — surface amendment 3 was recorded but never applied

**What happened.** `.feature/state.json` logs `surfaceAmendments: 3`, and entry
3 (2026-09-03T11:09:06Z) states that
`worker/background/pollers/health-alert/__tests__/checks.test.ts` joins
`allowed_edit_surface`. Neither intake copy contained that path. The recorded
`intakeSha256` `f8ae6bc7…` matched both copies, so the amendment was logged at
the `plan_approved` transition and the intake edit was dropped in the same
step.

**Why it matters.** `tests_to_add` title 43,
`checkFailedInboundEvents does not count stale_ignored rows`, had no legal home
file. The in-session edit-surface guard blocks the write, and
`ci:feature-surface` blocks it again at merge. Verified with the audit's own
matcher: zero entries matched the path. `*` crosses `/` in that matcher, but
no entry carries a wildcard, so
`worker/background/pollers/__tests__/ArchivalPoller.test.ts` does not cover a
sibling directory. Entry 3's stated reasoning was wrong on that point.

**What I did.** Added the one path to both intake copies, immediately after the
`ArchivalPoller.test.ts` entry. Both copies stay byte-identical
(`5a5b508c…`). Re-recorded `intakeSha256` and `planContractSha256`.

**Why this spends no review round.** Plan rounds are 3 of 3 and RISK is high,
so `contract-changed` reporting CHANGED would normally escalate. It was
escalated: the owner was asked on resume and chose to apply the logged
amendment. Nothing in the design moved. The plan's T4 section already says
this behaviour is pinned by a test rather than assumed, and no plan heading
changed. This is the application of an amendment the owner approved before the
plan locked, not a new one, so it does not consume amendment budget either.

**Impact on the feature.** None on behaviour. It makes the promised test
writable.

**Verdict:** ACCEPT
