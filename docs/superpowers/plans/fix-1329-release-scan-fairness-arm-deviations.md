# fix/1329 release-scan fairness arm — deviations

Everything the locked intake did not anticipate. One entry per surprise, each
with a resolved **Verdict:** line (step 6 read-back parses this file).

## 1. Surface overlap with `refactor/616-fallow-complexity` on `scripts/ci/tenant-scope-allowlist.ts`

`scripts/feature-setup.sh` reported one code-pair collision with the armed
worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-616-fallow-complexity`.

Inspected both diffs against the shared base `eba43bcca`:

- **Theirs** — ONE hunk at line 1799, 9 insertions / 9 deletions: three existing
  entries re-keyed from `worker/jobs/OnboardingDemoWorker.ts` to
  `worker/jobs/onboarding-demo/subscription-guard.ts`. The entry COUNT does not
  move, so `ENTRY_COUNT_BASELINE` is untouched.
- **Ours** — three regions: `ENTRY_COUNT_BASELINE` (~line 40), the
  `RELEASE_CANDIDATE_SCAN_SQL` constant (~line 485), and one ADDED `accounts`
  entry for that statement (~line 3212). The count moves by +1.

No textual overlap between the two sets of hunks. The only shared value is the
baseline, and only ours moves it.

**Agreed merge order: `refactor/616-fallow-complexity` FIRST** — it reached
`gate_green` before this branch existed. This branch then rebases on `main` and
re-derives the baseline from the post-merge count rather than reusing the number
computed here. Evidence produced before that rebase is stale by construction.

The reciprocal note cannot be written into their deviations file from here: that
file lives on their branch, outside this branch's `allowed_edit_surface`, and the
edit-surface guard blocks a cross-worktree write. Their run merges first and does
not need to wait on ours, so the order is recorded here and reported to the owner.

**Verdict:** ACCEPT — coordination only, no change to this branch's design.

## 2. The ticket's "unreachable today" premise for item 1 is FALSE at HEAD

Issue #1329 (and #900's round-2 triage before it) justified leaving the cap arm
bounding with: *"No TypeScript writes `daily_send_cap`; the schema CHECK admits
1..50 and the column is NULL everywhere. The gap opens the day a write path
ships."*

A write path is already shipped and wired:

- `src/lib/auto-approval/solicitation-settings.ts:292` — `upsertSolicitationAccountDefault`
  writes `daily_send_cap` (INSERT … ON CONFLICT DO UPDATE).
- `src/lib/auto-approval/types.ts:78` — `DailySendCapSchema = z.number().int().min(1).max(50).nullable()`,
  so 1..9 is storable: a sub-default cap.
- Door: `src/app/api/settings/auto-approval/route.ts` PATCH →
  `patchAutoApprovalSettings` → `applySolicitationMutation`. The Owner Operator's
  `src/lib/agents/operator/apply.ts` reaches the same module.
- The gate is PARTIAL. Enabling the lane is an exposure *expansion* and needs
  `solicitationSendEnabled() && solicitationAutoApprovalEnabled()` plus the
  Autopilot tier (`solicitation-settings.ts:193`). **Lowering the cap afterwards
  is a contraction and passes no readiness gate at all.**

So the gap was one autonomy-flag flip from live (design doc §8.4's ordered
go-live), not one PR away. Found by building the "no write path" tripwire this
run originally planned: the tripwire fired on the settings module, which is how
the false premise surfaced.

Surfaced to the owner mid-run with four options. **Owner decision 2026-09-19:
close item 1 exactly, by pre-reading the caps and binding them.** Consequences:

- `readAccountDailySendCap` (per-account, per-candidate-account query) is DELETED
  and replaced by `readResolvedAccountCaps`, ONE platform-wide read per tick
  whose rows are resolved through `resolveAccountDailySendCap` in TypeScript. The
  scan binds `(account_id, cap)` pairs via `unnest`, and its arm compares
  `COUNT(*) >= COALESCE(r.cap, DEFAULT_DAILY_SEND_CAP_ACCOUNT)`. `LEAST(configured, 10)`
  still has exactly one spelling, in TypeScript. The lane's per-tick query count
  goes DOWN.
- The planned `ci:static-policy` tripwire was REVERTED. Its premise ("no write
  path exists") is false, and with the arm exact it has no job.
- The reporting-precedence caveat I had written into the scan docstring was
  removed: with an exact cap arm, a sub-default-capped AND unentitled account is
  claimed by the cap arm, which is the gate B6 names first.

**Evidence the exact arm is required, not merely nicer:** with the subscription
arm in place and the cap arm still keying on the constant, the EXISTING locked
test `evaluates the governors in the fixed order breaker then platform ceiling
then account cap then subscription` FAILS — round 3 seeds a configured cap of 1
with one attempt, which the bounding arm cannot see, so the subscription arm
claimed the account and the reported reason flipped from `account_cap` to
`subscription`. Measured by temporarily reverting the `HAVING` to the constant:
2 failures, that test and `excludes an account at its own sub-default cap from
the candidate scan`. Both pass with the resolved cap, fixture unchanged.

**Verdict:** ACCEPT — owner re-decided with the corrected facts; the intake was
amended in the same step (amendment 1, a narrowing: the two `scripts/ci/static-policy-audit*`
paths left the surface).

## 3. Production diff ran 2.47× its estimate; re-classified, SIZE unchanged

`estimated_prod_lines` was 110; the real added count is 272, which trips the
gate's 2× re-classification WARN. Re-ran step 0 with the real numbers:

- 169 of the 272 added production lines are comments or allowlist justification
  prose. Real code added is ~103 lines, against the 110 estimated.
- The overrun is prose explaining the owner's mid-run re-decision (deviation 2):
  the scan docstring's "why exact and not merely bounding" section and the two
  tenant-scope reasons.
- Implementation breadth is unchanged: one CTE, one read function, one deleted
  read function, two counters, one shared constant, one allowlist entry pair.

SIZE stays `small`, RISK stays `high`, SURFACE stays `backend`. The intake's
estimate was updated to 280 so the gate measures against the honest number.

**Verdict:** ACCEPT.
