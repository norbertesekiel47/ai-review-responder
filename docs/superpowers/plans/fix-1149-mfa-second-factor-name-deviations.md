# Deviations — fix/1149-mfa-second-factor-name

## D1 — [2026-09-21] Gate `test` row red on the guard self-test, caused by the session's containment escape

Full gate's `test` row failed on `scripts/ci/__tests__/edit-surface-guard-worktree.test.ts` (4 assertions expecting exit 2, got exit 0) → this session's environment carries `WORKTREE_EDIT_GUARD_DISABLE=1` (the documented escape the owner applied because the swarm root session is itself a linked worktree). That var is not `GIT_`-prefixed, so it survives the test's own env filtering and leaks into the `pnpm test` subprocess tree, neutering the guard the test exercises. Confirmed by: (a) `git diff --stat` shows none of the guard scripts or their test are touched by this branch; (b) running the same test file with the var explicitly unset (`env -u WORKTREE_EDIT_GUARD_DISABLE`) turns all 4 failures green; (c) a from-scratch manual repro of the guard outside vitest reproduces the same exit-0-instead-of-2 only with the var set. Not a defect in this change or in the codebase at HEAD. What was done: the second and third full/fast/review gate invocations ran as `env -u WORKTREE_EDIT_GUARD_DISABLE bash scripts/verify-gate.sh ...` — scoped to that one subprocess tree only, not unsetting the var in the session itself (the harness's PreToolUse hook still needs it for any further edit). This is a gate-invocation change, not a code or intake change; no locked decision is affected.

**Verdict:** ACCEPT — environmental, not a branch defect. CI never sets the variable, and the gate evidence was produced with it unset, which is the CI-equivalent condition. The root runs every later gate the same way. Lesson to promote after merge (lab-notes/ci-tooling.md): a `/feature-swarm` root in a linked worktree needs the escape for edits and `env -u` for gates.

## D2 — [2026-09-21] Three T1 test titles first written as nested describe + short `it()` strings

The `promised-tests` row greps one literal string per title, so a `describe('nextFactorFriendlyName')` + short `it()` split was invisible to it. Self-corrected in the same round: the three `it()` strings are now the verbatim promised titles.

**Verdict:** ACCEPT — no behavior change; the titles now match the intake verbatim.

## D3 — [2026-09-21] Surface amendment 1: `.claude/reference/arch-review-log.md`

The root committed the work (`aa0435c85`) and re-ran the review gate; the `merge-ledger` row went RED: the branch changes two production files and adds no line to the ledger. The lead's gates passed that row vacuously, because the audit reads the COMMITTED range and the lead made no commits. The intake did not list the ledger file, and it is not an always-allowed path of the edit-surface guard. Owner approved the amendment on 2026-09-21 (one question covered all three swarm runs). Both intake copies updated, `incr-amendment` counted (surfaceAmendments=1), one ledger line added.

**Verdict:** ACCEPT — process-ledger path required by a CI audit; owner-approved; no locked decision changes. Intake-authoring lesson: every intake whose diff touches `src/`, `worker/`, `supabase/` or the governance surface lists the ledger file at step 0.

## D4 — [2026-09-21] Review round 1: the fix removes the cap on abandoned unverified factors (owner decision: measure on staging)

Spec F2 and Codex F1, independently: before this branch the name conflict capped abandoned unverified factors at one per user; now every start → cancel banks another (`RepWorth`, `RepWorth 2`, …). If GoTrue counts unverified factors against its enrolled-factor limit and does not expire them, a first-time user can block their own enrollment, and the new factor-limit copy points at an unenroll the route gates behind AAL2. No reviewer could verify GoTrue's expiry behavior offline. This touches the locked non-goal "no cleanup of abandoned unverified factors", so on a RISK = high run it was the owner's call.

Owner decision 2026-09-21: keep the non-goal; during the staging ride, start and cancel enrollment several times, wait, and read the factor list to establish whether GoTrue expires unverified factors and whether they count against the limit; record the result here and in the PR. If they do not expire, file a ticket for an audited server-side cancel operation and the PR waits for the owner.

The staging measurement, sharpened by the Codex round-2 verification (a few successful starts prove nothing about the limit), must record all four:

1. **Real capacity** — from an account with ZERO verified factors at AAL1, start and cancel through the configured limit; record the count reached and the exact rejection code.
2. **Expiry timing and trigger** — record factor ages over a defined window; distinguish passive expiry from cleanup triggered by a later enrollment.
3. **Recovery AT capacity** — after the expected expiry interval, start an enrollment while full, then complete verification. Expiry below capacity alone does not prove recovery.
4. **Blocked interval** — how long a first-time owner stays unable to enroll, and whether recovery needs AAL2, removal of a verified factor, or an operator.

The PR stays on hold for an INCONCLUSIVE result or a failed recovery as well as for non-expiry, and any measured temporary blockage needs the owner's explicit acceptance.

**Verdict:** ACCEPT — owner-decided; the residual risk is named, bounded by a concrete staging measurement, and gates the PR.

## D5 — [2026-09-21] Review round 1 fixes (triage: `docs/reviews/fix-1149-mfa-second-factor-name/triage.md`)

Applied: the invariant property now draws names from the `RepWorth N` sequence and lives in a `nextFactorFriendlyName invariants` block, with a second property (the result is the FIRST unused name) — proved against the red-team mutant `return 'RepWorth'` (RED at `mfa.test.ts:206`). The start → cancel → start fixtures now use the payload auth-js 2.106.2 really emits (unverified factor only in `all`) — proved by deleting the `all` arm of `collectFactors` (RED at `useMfaEnrollment.test.tsx:169`). One test beyond the intake's list: `does not surface provider text that would trigger the step-up link`. `docs/directory/lib-platform.md` names the new export and its caller obligation.

Named debt: `enrollmentErrorMessage` carries a local copy of the `/sign in again/i` pattern that `SecuritySections.tsx` `isStepUpRequiredError` owns, because the presentation file is a non-goal and outside the surface. The honest design is an explicit step-up discriminator on the hook's return value instead of string sniffing; recorded for the change ledger.

Behavior note (round-2 verification N2): the step-up guard carves one exception into the locked `user_visible_behavior` bullet "for any other enrollment error with a non-empty message, the page shows `Could not start MFA enrollment: <Supabase message>`" — a provider message that matches `/sign in again/i` shows the generic text instead. The exception exists only to keep provider text from switching on the AAL2 step-up link.

**Verdict:** ACCEPT — every change traces to an accepted finding; the two test-strength fixes carry mutation proof.

## D6 — [2026-09-21] Review round 2 and the owner-authorized third red-team round

Round 2 closed RT-1149-F1 and F2 (the round-1 mutant survivor is killed) and left one stale line reference in the `lib-platform.md` row this branch rewrote (P1 by the red-team skill's line-number rule) plus two test-strength items (P2). Any fix moves the tree past the round-2 sidecar's `head_sha`, and the skill caps the red team at two rounds. The owner authorized a third round on 2026-09-21, scoped to the round-3 fix hunks; the grant is recorded verbatim in the sidecar's `authorizations`.

**Verdict:** ACCEPT — owner-authorized; the alternative was leaving known defects unfixed.
