# Handoff — `refactor-565-complexity-bundle`, ready for step 8 (ship)

Everything below is on the branch. This is an index, not a restatement.

## Read in this order

1. `docs/superpowers/plans/refactor-565-complexity-bundle-intake.json` — the contract (authoritative).
2. `docs/superpowers/plans/refactor-565-complexity-bundle-plan.md` — decisions D1–D5, the ticket set, and
   the "What measurement changed" table that re-derived scope.
3. `docs/superpowers/plans/refactor-565-complexity-bundle-deviations.md` — triaged, every entry has an
   ACCEPT verdict; also holds the re-classification record and the gate-arming incident.
4. `docs/reviews/refactor-565-complexity-bundle/spec-correctness.md` — **VERDICT: PASS**.
5. `docs/reviews/refactor-565-complexity-bundle/standards-maintainability.md` — no blockers, 8 low
   findings, 7 accepted and fixed, 1 rejected with reasoning.
6. `docs/reviews/refactor-565-complexity-bundle/blast-radius.md` — importers of every changed file.

## What shipped on this branch

| Ticket | Outcome |
|---|---|
| T1 | `acquireCsvIngestLock` exported; `writeTerminalUploadState` owns all 3 `contact_csv_uploads` terminal writes. Closes **#569**, discharges arch findings **S1** + **S2**. |
| T4 | `evaluateBatchGate` + `deleteUnbuiltBatch` own the gate re-check duplicated across `prepareBatch`/`constructBatch`. |
| T5 | `loadCandidateWindow` + `commitAskDecisions` extracted from `constructBatch`; `commitTerminalTransition` in the solicitation-batch failed-hook. Complexity cyc=14/cog=14/CRAP 56.3 → **zero findings**. |
| T6 | `requireSettingsOwner` single owner in `route-helpers.ts`, `sql` injected per invariant #15. |
| former T2 | **DROPPED** on measurement — ingest.ts suppressions guard CRAP-under-coverage, not complexity. Became **#581**. |
| former T3 | **DROPPED** on measurement — uploads-route functions appear in neither findings nor large_functions. |

Production code: **+522 / −361** across 7 files. Tests: **+411 / −4**.

## Gate

`bash scripts/verify-gate.sh --review` → **GREEN**, 24 rows, `reclassify` WARN only (analysed and
recorded in deviations; lane unchanged — still RISK=high / mixed / not epic).

Read the row COUNT, not just the verdict: a short table means the branch is disarmed (see the
gate-arming incident in deviations).

## Step 8 — what remains, and what needs approval

RISK = high (two retry-exhaustion terminalizers with coupled outbox CAS), so the lane is:

1. **Ride `staging` first** — push the branch to `staging`; the full stack auto-deploys.
   *Not yet done. Needs owner approval — it deploys.*
2. **Smoke on staging** (intake `observability`): one CSV upload reaches `status='completed'` with a
   non-null report and `raw_csv IS NULL`, and its Solicitation batch reaches `built_at` non-null with
   unchanged send/withhold counts. No migration to apply — head stays 089.
3. **Open the PR to `main`**, confirm CI green, then **PAUSE for explicit merge approval**.

## After merge

- `git pull --ff-only` on local `main`; fast-forward `staging` onto `main`.
- `bash scripts/feature-cleanup.sh` (dry run first, then `--apply`).
- Promote durable lessons from the deviations file into `.claude/reference/lab-notes.md` — at minimum:
  the purge/ingest unlocked-DELETE race, the fallow CRAP/coverage blind spot (#581), and the
  disarmed-gate row-count signal.
- Close **#569** as absorbed by T1; post the D4 verdict and the measurement table on **#565**.
- Increment the merge counter in `.claude/reference/arch-review-log.md`.

## Open items for the owner

- **The purge/ingest race is still unfiled.** `worker/jobs/account-offboarding/purge-stages.ts:256`
  hard-DELETEs `contact_csv_uploads` by `account_id` without the `csv_ingest_<businessId>` advisory lock,
  so it can delete a row mid-ingest. Benign today — which is exactly why this branch preserves the
  behavior instead of asserting on it — but the lock contract is incomplete, and the next person to read
  `writeTerminalUploadState` will be tempted to "fix" the tolerated 0-row case into an assert. That was a
  blocker in round 1 of this branch's own plan review.
- **#581** (fallow CRAP coverage blind spot) is filed and unowned. It is the reason #565's ingest-lane
  scope was phantom, and it will keep generating phantom debt tickets for every integration-tested
  module until it is addressed.
