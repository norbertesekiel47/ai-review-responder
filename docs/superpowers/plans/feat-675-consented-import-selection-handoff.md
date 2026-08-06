# Handoff — feat-675-consented-import-selection

**Phase:** `reviewed` (2026-08-05). Next: **step 8 SHIP, RISK = high lane** — (1) land the branch on `staging` (push → full stack auto-deploys; no migration on this branch), (2) smoke the import path on staging, (3) open PR to `main`, confirm CI green, then **PAUSE for owner merge approval**.

A resumed session bootstraps from these files, in order — never the prior transcript:

1. **Intake (locked; amendment #1 applied 2026-08-05):** `docs/superpowers/plans/feat-675-consented-import-selection-intake.json` — 30 promised test titles; `allowed_edit_surface` now includes `scripts/ci/tenant-scope-allowlist.ts` (owner-approved amendment #1 of the 2-amendment budget; D12).
2. **Plan (codex-APPROVED r3):** `docs/superpowers/plans/2026-08-05-feat-675-consented-import-selection.md` — all six tasks executed (T1 ad77dd6b, T2 1a5ed4ba, T3 da6bcac0, T4 bf92642b, T5 c7502ff3, T6 125605c9; amendment 084dfd19; review fixes 7bbc0224).
3. **Deviations (D1–D13, all triaged, no RE-PLAN):** `docs/superpowers/plans/feat-675-consented-import-selection-deviations.md`
4. **Step 7 review record** in `docs/reviews/feat-675-consented-import-selection/`: `spec-correctness-r1.md` (NO findings ≥80%), `standards-r1.md` (3M/5L; triage at end: F1/L1/L2/L3/L4 accepted+fixed, F2/F3/L5 rejected with reasons), `adversarial-codex-r1.md` (3 HIGH, all REJECTED with verification — see PR notes below), `standards-r2-verification.md` (**CLEAN** — all fixes verified), `blast-radius.md`. Branch review rounds: 2 of 3 used.
5. **Gate:** GREEN `--review` (incl. promised-tests + diff-coverage) at `94241937`; re-run after any new commit. Live-DB suites run explicitly and green: `import-review.integration.test.ts` 4/4 (needs `TEST_DATABASE_POOL_URL` exported from `.env.local` — the suite self-skips otherwise), `zernio-end-to-end.integration.test.ts` 6/6.

**PR description MUST include** (owner reads review positions there — round protocol):
- **Sequencing note (codex r1 finding 1, accepted as release constraint):** this branch replaces the auto-drafting backfill with the consented list-only import, but the fail-closed `import_decision='accepted'` worker pre-flight is #679 and the enqueue gates are #676 — **#679 must land before real customers**. Interim posture is strictly safer than status quo (nothing drafted, nothing can reach Google — no `job_outbox` writes) and prod has zero customers (ADR 0015 R1).
- **Recorded disagreement (codex r1 finding 3, rejected):** codex holds that a dirty-ordering cap-out with ≥100 candidates should fail terminally rather than proceed best-effort; the locked intake edge case says best-effort + warning. Both positions in `adversarial-codex-r1.md` §3 — owner may overrule at merge (small isolated change if so).
- Deps: none added (no `.feature/deps-justification.md` exists — nothing to carry over).

**Staging smoke (step 8.2):** connect (or reuse) a staging test location → let the connect finalizer enqueue `zernio_initial_backfill` → verify: completion log line `Import complete business=… imported=N skipped=M pages=P window=[floor, cutoff)`; `zernio_backfill_runs` row has `imported_count`/`skipped_count` set and all four `gap_*`/`historical_*` at 0; imported reviews appear as list rows (answered ones with a posted response row); **no** `generate_response` outbox rows for imported reviews; no notifications.

**Standing cautions:** worktree path discipline (`cd` prefix on every Bash; absolute Edit/Write paths); `worker/index.ts` stale comment stays for the post-merge `document-feature` sweep (out of surface); follow-up candidates recorded in standards triage — F3 test-file split + pre-#675 helper shadows (post-merge sweep), F2 pagination-collector extraction (only if a second caller appears).
