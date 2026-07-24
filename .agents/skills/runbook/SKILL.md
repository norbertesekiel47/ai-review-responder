---
name: runbook
description: Use when executing any staging runbook or E2E validation campaign (docs/runbooks/*) end-to-end, when resuming an interrupted run, or when asked to "run Phase X with evidence" — before performing the first setup step.
---

# Runbook Execution Contract

Every runbook run produces three things or it didn't happen: an **evidence
file**, a **completed teardown**, and a **PASS/FAIL verdict with zero open
unproven paths**. The recurring failure this skill prevents: a run interrupted
mid-campaign leaving stale fixtures (test accounts, Stripe subscriptions,
flipped flags, synthetic verdicts) in staging with no record of what to clean.

## Workflow

1. **Open the evidence file FIRST** — `docs/runbooks/evidence/YYYY-MM-DD-<runbook-slug>-evidence.md`, following the structure of the existing files there (see `2026-07-22-agentic-staging-phase-d-evidence.md` as the reference):
   - `# Evidence — <campaign>` + link to the runbook file
   - **Environment block**: env name, Supabase project ref (and the prod ref marked NEVER touched), worker/UI URLs, Stripe mode, git SHA at start, UTC start, test accounts, any live-surface posture constraints (e.g. "no new posts on the live Google profile")
   - **Preflight table**: one row per runbook precondition — check, result (✅/⚠️/⏳), UTC
   - **Deviations log**: numbered `D-n (UTC)` entries — a deviation is recorded, never silently absorbed
2. **Write the teardown ledger before the first fixture** — a `## Teardown ledger` section in the evidence file. EVERY fixture gets a row **at creation time** (what, identifier, how to remove, `[ ]` open). Flag flips count as fixtures (record the pre-flip value). This is the resume contract: an interrupted run's cleanup list is always complete and on disk.
3. **Execute steps in runbook order.** Per step: UTC timestamp, action, verbatim evidence (SQL query + result, screenshot path, log line, script output), and a PASS/FAIL/DEVIATION mark. Use `flag-flip` for any flag change and the Supabase MCP for staging SQL. Blockers: diagnose root cause, fix on a branch if warranted, log the deviation, re-verify, continue — file a bug for anything product-shaped.
4. **Track unproven paths explicitly.** Keep a running list of paths the runbook claims but the run hasn't yet demonstrated. The campaign cannot be declared PASS while any remain open — close each with evidence or record it as a documented gap with owner sign-off.
5. **Teardown = execute the ledger.** Work through every row: remove the fixture, VERIFY it's gone (query, not assumption), tick the row with UTC. Restore all flags to their recorded pre-run values and verify the full flag baseline (Phase D found drift at start — always re-read actual values, both Railway and Vercel).
6. **Final verdict block**: overall **PASS/FAIL**, deviations summary, bugs filed (PR/issue links), unproven-paths disposition, teardown-complete confirmation, UTC end.
7. **Runbook feedback loop**: any defect found in the runbook itself (wrong SQL, missing precondition, ordering flaw) gets fixed in the runbook file in the same session, referencing the deviation number.

## Resuming an interrupted run

Read the evidence file's teardown ledger and last completed step FIRST. Never
restart from step 1 against a dirty environment: either finish teardown and
start clean, or resume from the recorded position — decided by ledger state,
not memory.

## Common mistakes

- Creating a fixture before its ledger row exists — an interruption in that window orphans it.
- Declaring PASS with open unproven paths or an unexecuted teardown row.
- Trusting that flags/state match the previous session's teardown record — verify the actual baseline at preflight (drift happens).
- Evidence that asserts instead of shows — every claim links to a query result, output, or screenshot.
