# feat-872-ask-withdrawal — handoff

Resume with `/feature-resume feat-872-ask-withdrawal`. State lives on disk; this
file points at it and restates nothing.

## Where everything is

| What | Path |
|---|---|
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-872-ask-withdrawal` (branch `feat-872-ask-withdrawal`, base `d89c112f` = `origin/main` at arming) |
| Phase record | `.feature/state.json` (`scripts/feature-state.sh`) |
| Intake (armed + committed audit copy) | `.feature/intake.json` == `docs/superpowers/plans/feat-872-ask-withdrawal-intake.json` |
| Plan (revision 3) | `docs/superpowers/plans/feat-872-ask-withdrawal.md` — 5 tasks; Task 1 is the eval; Tasks 3 and 4 are mutually independent |
| Deviations | `docs/superpowers/plans/feat-872-ask-withdrawal-deviations.md` (D1 merge order vs feat-865; D2 sessions-file unbinding; D3 intake corrections after review round 1; D4 Task 4 render-time disarm + `btn-secondary`) |
| Decision record | `docs/adr/0021-ask-withdrawal-is-restraint-not-reapproval.md` (+ ADR 0020 Consequences amended) |
| Glossary | `CONTEXT.md` → **Ask withdrawal** (LOCKED); **Owner approval** and **Ask exclusion** entries cross-reference it |
| Plan reviews | `docs/reviews/feat-872-ask-withdrawal/plan-round{1,2,3}-codex.md` — each carries its triage table |
| Source ticket | GitHub #872 (`gh issue view 872`) |
| Pull request | **#883, DRAFT** (`gh pr view 883`) — opened at step 8 with the D5 / review-rejection positions in its body; stays draft until feat-865 lands, the rebase + gate re-run, and the staging ride (see NEXT below) |

## Owner-locked decisions (do not re-litigate; reasoning in the intake + ADR 0021)

1. Reason value `owner_withdrawn` + migration 109 (not `owner_excluded` reuse).
2. Withdrawable states = `veto_window`, `approved`, `sending` (halt-cancellable + approved); row `rendered`/`queued`, never `sending`.
3. Last live row withdrawn → `closeBatchIfSettled` settles the batch (`exhausted`, parent `completed`).
4. Request keys on `{ batchId, askId }`; the verb resolves the live row under the lock.
5. Per-row `Withdraw` behind an inline two-tap confirm; withdrawn rows leave the list.
6. Merge order: feat-865 lands first; #872 rebases onto it (deviations D1).
7. This session's id was removed from feat-865's `.feature/sessions` (deviations D2).

## Codex review thread

Rounds 1–3 ran in ONE thread so each round verified its own prior findings:

```
thread id: 01a01383-9393-7fc1-ac89-867399b6c9bd
```

Invocation (global flags BEFORE `resume`):

```
codex exec --sandbox read-only --json --cd "$W" resume 01a01383-9393-7fc1-ac89-867399b6c9bd "$(cat brief.md)"
```

Reports are extracted from the JSONL by concatenating every `item.completed`
event whose `item.type` is `agent_message`. The plan-review counter is spent
(3/3); this thread is the right one to resume for a BRANCH review at step 7
(its own counter, `branchReviewRounds`).

## Current step

_(updated below as the run advances)_

- Step 3 (plan) — rounds 1–3 run; see the verdict line in `plan-round3-codex.md`
  and the "Plan lock" note appended to this file.
- Step 4 (execute) — COMPLETE. Tasks 1–5 landed (ledger below); the enforcement
  spot check passed at Task 1 (4 files, all in surface, 18/18 titles verbatim,
  tree clean).
- Step 5 — DONE at `09ca11c9`: `verify-gate.sh --review` GREEN, full mode
  (28 PASS; integration suite RAN against the local DB; `diff-coverage` PASS)
  with ONE WARN: `reclassify` (production 1020 vs ±400) → deviations **D5**
  (step 0 re-run: RISK = high, lane holds; WARN left standing on purpose).
- Step 6 — DONE at `621aee35`: D1–D5 all ACCEPT with reasoning.
- Step 7 — COMPLETE (phase `reviewed`; `branchReviewRounds` = 2 of 3, no
  round 3 needed). Reports + triage, all committed under
  `docs/reviews/feat-872-ask-withdrawal/`:
  - Round 1 (three axes, RISK = high): `branch-round1-codex.md` — adversarial,
    RESUMED thread `01a01383-9393-7fc1-ac89-867399b6c9bd`, **empty findings
    table, promise audit 12 KEPT / 1 CHANGED (D4a), `VERDICT: APPROVED`**;
    `branch-round1-spec.md` — 1 minor ACCEPTED (disabled-in-flight test);
    `branch-round1-standards.md` (thermo-nuclear ran) — 11 findings: **9
    ACCEPTED** (S3–S11: docblocks, `useArmedWithdrawal` hook, `WithdrawControl`,
    `armedAskId` rename, CSS selector lists, glossary wording, directory row) and
    **2 REJECTED with reasoning** — #1 (major: `ApprovalPanel.tsx` crossed 1,000
    lines → extract `lane-writes.ts`) rejected as a blocker ON THIS BRANCH
    (94/1,076 lines are #872's; new file outside surface; feat-865 lands first
    and edits the same file → guaranteed rebase conflict) and ACCEPTED as a
    follow-up ticket after both land; #2 (`WithdrawalDecision` parallel union)
    rejected — plan-locked pure decision, promise-audited KEPT. **Both positions
    go in the PR description; the owner sees them at the merge pause.**
  - Fix commits: `062439fd` (docblocks/route/directory), `6a284617` (UI:
    hook, subcomponent, rename, CSS, +1 test), `0e3966b1` (mobile `@media`
    mirror for `.rq-ask-withdraw` — a Task-4 omission the fix agent flagged).
  - Round 2 (verification-only): `branch-round2-standards.md` 9/9 + mirror
    ADDRESSED, no fix-introduced defect, APPROVED; `branch-round2-spec.md`
    ADDRESSED, every panel behaviour re-verified after the refactor, APPROVED.
    Residue fixed in the round-2 commit: read-only `AskList` docblock +
    directory phrase no longer paraphrase **Settled batch**.
  - Gate after fixes: GREEN full mode at `0e3966b1` (same single `reclassify`
    WARN, now 1125 — D5 reasoning unchanged). Final gate re-run at the
    round-2 commit (see `.feature/gate-status.json`).
- Rebase note (D1 stands): feat-865 has NO PR yet (parked at its step 8), so the
  agreed merge order — feat-865 lands first, #872 rebases onto it at step 8 —
  is unchanged. #872's `approval.ts` diff is header + append only (`haltBatch`
  byte-identical to base at `12a6e4bb`), so the rebase should be clean. Codex
  round 1 confirmed feat-865's `latchHalt` keeps the identical
  `rendered`/`queued` predicate — no rebase defect, only a future drift watch.

## NEXT — step 8 (SHIP, RISK = high lane) — needs the owner at two points

Precondition: **feat-865 must land on `main` first (D1).** If it has not, STOP
and wait — do not merge ahead of it, do not rebase onto its unmerged branch.
**Done so far (2026-08-18):** branch pushed to `origin/feat-872-ask-withdrawal`
(lefthook pre-push green) and **draft PR #883** opened; nothing pushed to
`staging`; migration 109 NOT applied anywhere but the local test DB. The
session parked here because feat-865 had no PR yet.

1. `git fetch origin && git rebase origin/main` (after feat-865 merges).
   Expected conflict surface: none in `approval.ts` (append after
   `requestAskRegeneration`); possibly `ApprovalPanel.tsx` (feat-865's
   `HALT_BODY` totality change) — resolve keeping BOTH; `docs/directory.md`
   rows; `.claude/CLAUDE.md` lane row (feat-865 may add `adminHaltBatch`).
   Re-run `bash scripts/verify-gate.sh --review` after the rebase (integration
   suite must RUN — both DB vars to `localhost:5499`).
2. **Ride staging**: push the branch onto `staging`; apply migration **109** to
   the STAGING Supabase project FIRST (`new-migration` skill; verification query
   in the migrations-log 109 entry — `owner_withdrawn` appears once, in the
   cancelled arm); smoke the touched path (approve a batch on staging → Withdraw
   one row → "Withdrawn. N messages left to send." → withdraw the last → settled
   mode; retry → 200 no-op). Record evidence per the `runbook` skill.
3. `gh pr create --draft` → `gh pr ready`; wait for every CI check green (incl.
   fallow, React Doctor since SURFACE = ui). PR description carries: the D5
   reclassify WARN + step-0 re-run; review #1/#2 rejections with both positions;
   the follow-up list below.
4. **PAUSE for the owner's explicit merge approval.** At promotion, apply 109 to
   PROD Supabase in lockstep and remove the LOCAL-ONLY marker from the
   migrations-log entry.
5. After merge: `git pull --ff-only` on `main`; realign `staging`
   (`git reset --hard origin/main` + `--force-with-lease` after a squash merge —
   NOT a sync merge); `bash scripts/feature-cleanup.sh` (dry run, then
   `--apply`); promote lessons (below) to lab-notes; `document-feature`;
   domain sweep; increment the arch-review-log merge counter.

**Follow-up tickets to file after merge (do NOT file before):**
- Extract `ApprovalPanel.tsx`'s `── The write ──` section into `lane-writes.ts`
  (standards round-1 #1; do it after #865 AND #872 land).
- One-line ADR 0012 → "#629 round-2 F10" cite fix in `halt/route.ts:26` and
  `approve/route.ts:104` (D3).
- `scripts/blast-radius.sh` substring over-match ("82 importers" for any
  `route.ts`).
- Optional: `WithdrawalDecision` shape (standards #2) — only if the owner wants it.

**Lessons to promote to lab-notes at step 8** (deviations D2, D5; handoff Gate):
- Record a cross-worktree collision in your OWN deviations file only (D2).
- A plan-review re-estimate must revise BOTH intake buckets, or the gate's
  `reclassify` fires on a stale production estimate (D5).
- The local test DB is shared by every sibling worktree — another session's
  `test:db:setup` can reset it under a running review; re-provision from the
  worktree you are testing.
- `react-hooks/set-state-in-effect` is `error` repo-wide: "clear state when a
  prop disappears" is a GUARDED render-time adjust (`ToneChipPicker.tsx`
  precedent), never a `useEffect` (D4a).

## Task ledger

| # | Task | Status | Commit |
|---|---|---|---|
| 1 | Eval — 18 promised titles + extra cases, failing | **done** (red by design: integration `beforeAll` needs 109; routes file fails to load until Task 3; 8/9 panel cases red) | `40acd7e5` |
| 2 | Migration 109 + `ask_withdrawn` + `withdrawAsk`/`classifyWithdrawal` | **done** — integration 46/46 RAN against the local DB, unit 7/7; `haltBatch` byte-identical to base; 109 applied LOCAL-ONLY (not staging/prod) | `12a6e4bb` |
| 3 | `readBatchAsk` + withdraw route + directory rows | **done** — routes 26/26; `readBatchAsk` shared with regenerate; directory row | `8d89bcc4` |
| 4 | Panel: `WithdrawableAskList` + lane write + copy + CSS | **done** (D4: render-time disarm, `btn-secondary`) — requests `__tests__` 82/82; react-doctor clean | `cdca4165` |
| 5 | Docs sweep + handoff | **done** | (this commit) |

## Gate

Docs-only checkpoints have been GREEN at every commit (`.feature/gate-status.json`,
`mode: docs_only`). The full gate (`scripts/verify-gate.sh --review`) is
mandatory before step 7; the integration suite must RUN (not SKIP) — export
`TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` (BOTH to the local
`localhost:5499` URL — `.env.local`'s `DATABASE_POOL_URL` points at a remote
Supabase pooler and must never receive `test:db:setup`).

**Hazard (seen 2026-08-18 02:27):** the local test DB is SHARED by every
sibling worktree. Another session's `pnpm test:db:setup` reset it to head 108
between this branch's gate (which provisioned 109 at 02:16) and the review
agents' runs; the spec agent re-applied 109 (additive) to run the suite. The
gate provisions serially and is authoritative for its own run; a `beforeAll`
"behind head" failure outside the gate is this drift, not a code defect —
re-run `pnpm test:db:setup` from THIS worktree. Promote to lab-notes at step 8.

## Plan lock

Round 3 returned `VERDICT: APPROVED` (2026-08-18). Plan revision 3 is the
executable spec. Phase → `plan_approved` at this commit; step 4 begins next.
