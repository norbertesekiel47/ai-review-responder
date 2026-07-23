# Handoff — feat/competitor-snapshots-538 (#538, map #528)

Resume with `/feature-resume feat/competitor-snapshots-538`. State lives on disk; do not reconstruct from transcript.

## Current step

/feature step 8 (SHIP, RISK=high lane) — NOT started. Steps 4–7 complete 2026-07-23:
- Tasks 1+2 executed (migration 084, worker resolveLocalPack + tx persistence, 30 tests).
- Mid-run surface amendment (user-approved): 5 offboarding/RLS-inventory companion files — competitor_snapshots is purge-complete (hard_delete/must_be_absent, DELETABLE_BY_BUSINESS, rls-inventory row).
- Step 6 adversarial (Codex): finding 1 (search_location in replace key) REJECTED with rationale + pinned by regression test; finding 2 (migration retryability) ACCEPTED → IF NOT EXISTS guards, re-apply verified idempotent. Report: docs/reviews/feat-competitor-snapshots-538/adversarial-review.md.
- Step 7 dual review triaged: 4 accepted (comment honesty, synthesizeMockPack extraction, try/finally test hygiene, NULL-rank assertion), 1 rejected (bulk insert). Verdicts: docs/reviews/feat-competitor-snapshots-538/triage-verdicts.md.
- Verify gate GREEN (run 5, all 15 checks) at HEAD.
- Local test DB (localhost, TEST_DATABASE_POOL_URL) has 084 applied. Staging/prod DO NOT.

Step 8 remaining: push branch → land on `staging` (auto-deploys full stack) → apply 084 to STAGING Supabase first → smoke ranking path on staging (worker logs + competitor_snapshots rows) → PR to main → CI green → PAUSE for explicit merge approval → prod migration in lockstep at promotion → post-merge sweeps (document-feature, domain sweep, entropy counter, worktree cleanup).

## Artifacts (read in this order)

- Intake contract (drift detector): `docs/superpowers/plans/feat-competitor-snapshots-538-intake.json` (armed copy at `.feature/intake.json`)
- Plan (execute task-by-task): `docs/superpowers/plans/2026-07-23-competitor-snapshots.md`
- Glossary: `CONTEXT.md` — section "Competitor Delta (locked 2026-07-23 — ticket #532)"; Task 1 adds the **Competitor pack** term
- Locked semantics source: `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §9 competitor-delta probe (lines ~467–481)
- Research basis (NOTE: only on unmerged branch `research/serpapi-competitor-fields`, not main): `docs/research/2026-07-23-serpapi-competitor-fields.md`
- Deviations log (create on first deviation): `docs/superpowers/plans/feat-competitor-snapshots-538-deviations.md`

## Key decisions already made (do not re-litigate)

Grilling (user-locked): standalone mirror table + replace-pack idempotency; data_cid write-only column; mock mode synthesizes a pack through the real write path; one sql.begin tx, pack failure fails the job.
Adversarial round (Codex): search_location deliberately NOT in the replace key/index; upsert-first ordering is the concurrency serializer (load-bearing); no CHECK constraints; no tenant-scope allowlist entries (audit rejects unused ones); rls-audit static gate satisfied by the migration's ENABLE RLS in the same commit.

## Environment

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-snapshots-538` (branch `feat/competitor-snapshots-538`)
- Hooks armed + arm-checked (guard exit 2, stop-gate exit 2). Shell cwd resets between Bash calls — prefix every command with `cd <worktree>`.
- Baseline gate: ALL GREEN (15 checks) at plan sign-off — `.feature/gate-status.json`.
- RISK=high lane: after step 7 review → staging ride (migration 084 to staging Supabase first), PR to main, explicit merge approval, prod migration in lockstep.

## Map-level loose end (surfaced to user, not in scope)

Research doc branch `research/serpapi-competitor-fields` never merged to main; ticket #538 cites its path. Docs-only PR recommended outside this run.
