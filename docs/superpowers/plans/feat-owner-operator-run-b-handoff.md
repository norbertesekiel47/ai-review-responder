# Handoff — feat/owner-operator-run-b (Owner Operator v1, Run B: Apply, Decline, receipts, the Operator screen)

Everything a resumed session needs is on disk. Read in this order; never re-read the prior conversation.

| What | Path |
|---|---|
| Spec of record (map, ticket-seeded) | `docs/roadmap/2026-09-11-owner-operator/README.md` (§3.1–§3.3, §5.1, §6.1–§6.5, §7, §8, §12.1, §14, §15) |
| Locked intake (drift detector; 1 surface amendment recorded) | `docs/superpowers/plans/feat-owner-operator-run-b-intake.json` (= `.feature/intake.json`) |
| Plan (T0–T8) | `docs/superpowers/plans/feat-owner-operator-run-b-plan.md` |
| Plan-review artifacts (Codex rounds) | `~/.claude/grill-codex/run-b-2026-09-12/` (outside the repo; `runs/claudex-*/result.json`) |
| Glossary (use terms verbatim; Run B coins **Receipt** and **Refresh plan** in T6) | `docs/context/owner-operator.md` |
| Architecture pass that preceded this run (findings H1-A…H1-D bind the plan) | `docs/reviews/PATHFINDER-2026-09-12/` on PR #1272 (worktree `../arch-pathfinder-2026-09-12`) |
| Deviations (verdict lines required before the wave) | `docs/superpowers/plans/feat-owner-operator-run-b-deviations.md` |
| Phase / rounds / gate truth | `.feature/state.json`, `.feature/gate-status.json`, `.feature/progress.json` |

## Where the run is

- Worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-b`, branch `feat/owner-operator-run-b`, base `6edacd0b0` (origin/main). Enforcement ARMED.
- Step 3 (plan): **LOCKED 2026-09-12 by owner call after round 3** (`phase=plan_approved`). Drafted by an Opus subagent, revised once by the root (page path → `/dashboard/operator`, nav test in the existing suite, `recordTerminal` status predicate), then three Codex rounds through `grill-me-codex/scripts/runner.py`: round 1 plan-skeptic REVISE (11, all accepted), round 2 fresh verification REVISE (7 fix-introduced defects, all accepted), round 3 resumed REVISE (1 race, accepted). Ledger: `docs/reviews/feat-owner-operator-run-b/plan-review.md`; raw artifacts under `~/.claude/grill-codex/run-b-2026-09-12/`. 51 test titles in the intake (40 + 11 from review). PREVALIDATE: PASS at the lock.
- Codex thread: 01a0960d-4387-7f72-be06-e1d2f82c8a0c
- That id is the round-2 Codex session, a uuid this repo knows nothing about. It sits alone on the line above because `prevalidate-plan.py` scans a line for hex runs only when the line also carries a git-object word, and every label worth giving it — including the "rev" hiding inside "revised" — is one, which is why naming it in place reported it as two stale commits twice over (RT-11).
- Baseline gate on the untouched tree: RED only on `feature-surface` (new files do not exist yet) and `pnpm test:e2e` (local `ADMIN_APP_URL` missing — export `ADMIN_APP_URL=https://admin.example.invalid` for every gate run; see deviations).
- Step 4 (execute): T0–T7 landed (`bf1866f82` … `8be77eedd`), each by an Opus subagent with a lease; T0's diff was the enforcement spot check (all 14 files in the lease). Three surface amendments (page path; arch-log ledger file; one dead glob). Reclassify fired on the TEST bucket, lane unchanged. 18 browser-evidence PNGs + `evidence.md` captured on a throwaway local Supabase stack.
- Step 5 (gate): review gate GREEN at `dba7af671` (fingerprint written). Step 6: every deviations entry carries a root verdict.
- Step 7 (wave at `dba7af671`): spec 7, standards 13, Codex adversarial 3 (thread `01a0968b-6f4e-7443-8f54-532becd3ffe3`), red team 11 (1 P0: the docs claimed rule 11 BUILT). Triage: `docs/reviews/feat-owner-operator-run-b/review-round-1.md`. Fix commits `64f9de864` (docs), `aa7fd157a` (server), `cd4710b4b` (client). Red team round 2 (`619461e60`): P0 closed, 8 fixed, 2 rejected, 4 new P1 + 3 P2 in the fix hunks → fixed in `be03c88c2` under owner AUTH-1/AUTH-2; round 3 (`ef9b3a7ca`): 5 of 6 verified, RT-12 an oracle gap the owner accepted as risk (AUTH-3) with the never-executed rows excluded as a scope claim; RT-14 rejected as the RT-10 twin. Sidecar: `docs/reviews/red-team/feat-owner-operator-run-b-fec8cf/`.
- **Rule 11 is NOT BUILT** (Sentry API refused: no `alerts:write` scope; MCP is read-only). The owner is minting `SENTRY_ALERTS_TOKEN` in `.env.production.local`; the scratchpad script `sentry-rule-11.sh <staging|production> --apply` builds it and prints the id; then the runbook row 11 flips to BUILT with both ids. The T8 staging flip gates on it.
- Model routing (owner instruction): Fable orchestrates and reviews; every writing subagent runs on `opus`.

## Decisions locked in the grill (do not reopen)

Console (Harbor) visual system, inside the authenticated shell · page at `/dashboard/operator` (rides proxy branch 7; owner decision after the plan review) · `All locations` disables the composer with an inline chooser; `GET /api/operator/conversation?locationId=` scopes the no-turn summary; the summary carries `connectionStatus` · flag off → `notFound()` and no nav entry; an open screen stops polling on 404 `operator_disabled` · card note `Prepared for <location>` only when the selector differs · Decline records the actor only, idempotent · the six domain terminal reasons stay logs-only (revisit at the §12.1 checkpoint); rule 11 is built by the root in both Sentry projects before the staging flip · T8 (staging flip, p50/p95, constants, §12.1, §15) runs after merge in a follow-up PR · one `hasImpersonationCookie` in `src/lib/admin/impersonation/cookie.ts` · `/api/operator` joins `isProtectedOwnerApiRoute` · the summary panel reuses Run A's granular reads, not the dashboard DTOs (pass H1-D).

## Owed external actions (root, owner-approved at the moment)

1. Build Sentry rule 11 (`subsystem:worker_job` AND `queue:agent_turn`, every event, Discord action mirroring rule 3946648) in `repworth-staging` and `repworth-production`; the MCP has no create tool — use the Sentry API with `SENTRY_AUTH_TOKEN` sourced from `.env.local` via a `.scratch/` script, never as a literal argument.
2. After merge: flip `OWNER_OPERATOR_ENABLED=true` on staging (Railway + Vercel) through the `flag-flip` skill; measure; §12.1.
3. PR #1272 (architecture pass) needs `gh pr ready 1272` + merge by the owner (the auto-mode classifier refused the ready call).

## Resume checklist

1. `cd` to the worktree; `git status --porcelain`; `bash scripts/arm-check.sh` must print ARMED.
2. Read `.feature/state.json` for `phase`, `planReviewRounds`, `surfaceAmendments`.
3. If the phase is `worktree_ready`: find the latest `result.json` under the plan-review artifacts; if its verdict is REVISE, triage the findings into the plan's Review appendix, fix, run `feature-state.sh contract-changed <plan>` and resume the Codex session only if CHANGED; if APPROVED, `set-phase plan_approved` and `progress.mjs step plan done`, then step 4.
4. Step 4 order: T0 alone (enforcement spot check on its diff) → T1 alone → T2 ∥ T3 → T4 ∥ T5 → T6 (docs; root builds rule 11) → T7. Every writing subagent on `opus`.
