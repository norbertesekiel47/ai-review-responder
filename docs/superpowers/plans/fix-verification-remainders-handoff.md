# Handoff — fix/verification-remainders

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-verification-remainders`
Branch: `fix/verification-remainders` (base: main @ eaf4f3f2)

## State

- Step 1 GRILL: complete. 4 decisions + 1 codex-surfaced decision locked; see
  intake. Key user decisions: add both indexes (082); boot assert; no
  backfill guard (comment only); hygiene included; **enforce cap at 9 with
  generate_demo included + amend ADR 0005 addendum** (codex found #490's
  inventory missed generate_demo).
- Step 2 SETUP: worktree created, intake committed, ARM CHECK passed
  (guard + stop gate both exit 2).
- Step 3 PLAN: complete, codex-adversarial-reviewed (3 rounds; all
  substantive findings resolved; round-3 residual fixed). User signed off.
- Step 4 EXECUTE: complete — commits 4645a961 (T3), b33d3380 (T1),
  a6cea0ec (T2), plus glossary sync (CONTEXT.md worker-slot cap 9,
  adversarial finding 2; surface amended with sign-off).
- Step 5 GATE: GREEN twice (post-execute, post-glossary-sync) — all checks
  + pnpm build.
- Step 6 ADVERSARIAL: needs-attention, 2 findings. F2 (CONTEXT.md ≤8 stale)
  ACCEPTED + fixed. F1 (inventory completeness) REJECTED with reasoning —
  see docs/reviews/fix-verification-remainders/ triage sections.
- Step 7 REVIEW: spec-correctness NO FINDINGS; standards approve-with-2
  (harness dup ACCEPTED-DEFERRED follow-up; membership comment REJECTED).
  Full reports + triage verdicts in docs/reviews/fix-verification-remainders/.
- Step 8 SHIP: NEXT. High-risk lane: (1) apply migration 082 to STAGING
  Supabase first (CONCURRENTLY, outside transaction, recovery in header);
  (2) merge branch → staging, push (full stack auto-deploys); (3) capture
  EXPLAIN (ANALYZE, BUFFERS) on staging for the three
  NotificationFailoverPoller target queries → attach to PR (INCLUDE-column
  decision point); (4) PR to main, CI green, PAUSE for user merge approval;
  (5) at promotion apply 082 to PROD Supabase in lockstep; (6) post-merge:
  ff-pull main, ff staging, remove worktree, delete branch,
  document-feature sweep, domain sweep, entropy counter, and remind user:
  manual `rm poller_cursors.cursor` in the PARENT checkout.

## Follow-up tickets to file (from review triage)
- Extract the shared DB-guard test harness (5 duplicate copies:
  076/077/078/079/082 integration tests) into src/__tests__/helpers/.
- Candidate ci: contract audit mapping runLlmTask importers → LLM queue
  inventory (adversarial F1 / standards F2 class).

## Authoritative files (read these, not the transcript)

- Intake contract: `.feature/intake.json` (rev 3, committed ba5529b7)
- Plan: `docs/superpowers/plans/fix-verification-remainders-plan.md` (rev 2 + edits)
- Deviations (created during execution if needed):
  `docs/superpowers/plans/fix-verification-remainders-deviations.md`

## Verification / ship

- Gate: `scripts/verify-gate.sh` + `pnpm build` (intake verification_commands).
- Ship: HIGH-risk lane — staging ride first; capture
  `EXPLAIN (ANALYZE, BUFFERS)` on staging for the three target
  NotificationFailoverPoller queries (INCLUDE-column decision point);
  PR to main; PAUSE for user merge approval; apply 082 to prod at promotion.
- At ship, remind user: manual `rm poller_cursors.cursor` in the PARENT
  checkout (untracked stray; worktree rule forbids touching it here).

## Vocabulary (verbatim in code/commits)

- **worker-slot cap** — per-process summed BullMQ concurrency budget for
  LLM-calling queues; global bound only under single-replica (ADR 0005).
- **pacing cap vs guarded single-consumer invariant** — zernioBackfill's
  concurrency:1 is the former; assertSingleConcurrencyWorker is reserved
  for the latter.
- **sanctioned unguarded lane** — demo/eval LLM fan-out exempt from cost
  guards, bounded by review-count cap + admin rate limits.
