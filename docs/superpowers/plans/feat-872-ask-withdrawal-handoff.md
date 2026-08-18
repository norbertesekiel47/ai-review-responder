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
- Step 7 — IN PROGRESS. `blast-radius.md` written; `branchReviewRounds` = 1
  (counter incremented BEFORE dispatch). Round 1 = three parallel axes:
  spec & correctness → `docs/reviews/feat-872-ask-withdrawal/branch-round1-spec.md`;
  standards & maintainability → `…/branch-round1-standards.md`;
  adversarial approach (codex, RESUMED thread `01a01383-9393-7fc1-ac89-867399b6c9bd`,
  brief in the session scratchpad `codex-872-branch-review-round1-brief.md`,
  JSONL `codex-872-branch-round1.jsonl`) → to be extracted into
  `…/branch-round1-codex.md`. Triage verdicts go INTO each report's `triage`
  column; then re-run the gate; then `set-phase reviewed`. Rounds 2–3 (if any)
  are verification-only; after round 3 STOP and surface to the owner.
- Rebase note (D1 stands): feat-865 has NO PR yet (parked at its step 8), so the
  agreed merge order — feat-865 lands first, #872 rebases onto it at step 8 —
  is unchanged. #872's `approval.ts` diff is header + append only (`haltBatch`
  byte-identical to base at `12a6e4bb`), so the rebase should be clean.

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
