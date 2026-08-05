# feat-673-import-consent-columns — handoff

Machine state: `.feature/state.json` (phase, review-round counters). Read that first.

- **Ticket:** #673 (epic map #667) — ticket-seeded /feature run; intent locked at map level.
- **Intake (signed off, RISK=high):** `docs/superpowers/plans/feat-673-import-consent-columns-intake.json` (committed) = `.feature/intake.json` (arming copy — keep in sync).
- **Plan (locked):** `docs/superpowers/plans/feat-673-import-consent-columns-plan.md` — 3 tasks; Task 1 (eval) alone first, then Task 2 ∥ Task 3.
- **Deviations:** `docs/superpowers/plans/feat-673-import-consent-columns-deviations.md` (D1–D4 recorded and triaged).
- **Plan review:** codex session `019fd32f-a72d-7822-9f41-b64fde239087`, rounds 1–3 (counter in `.feature/state.json`); disposition in the plan's "Plan review" header block. Round-3 residuals accepted and applied; no round 4 per protocol.
- **Design of record:** ADR 0015 + `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §4, §8a R1/R3/R4.
- **Owner decisions this run (also in plan "Locked decisions"):** dual-write in this PR; enum CHECK only.
- **Glossary excerpt for subagents:** *Consented Review Import* = the owner-gated one-time import of existing Google reviews (spec §3); *import offer* = the prompt whose state lives in `businesses.import_decision`; *collapse* = `gap_*`+`historical_*` → `imported_count`/`skipped_count`, split ADD (migration 100, this run) / DROP (#680).
- **Ship lane:** RISK=high → staging first (migration to staging Supabase BEFORE prod; LOCAL-ONLY marker until promotion), PR to main, owner merge approval, prod migration in lockstep at promotion.

## Status after step 7 (2026-08-05)

- **Steps 4–7 COMPLETE.** Tasks 1–3 executed by subagents (eval-first, red→green); gate GREEN three times, last at head `9c1dae4e` (`--review` mode: coverage + diff-coverage + promised-tests all pass).
- **Deviations D1–D7 all triaged** (verdicts inline in the deviations file). D7 is the adversarial-F2 contract re-scope: legacy writer contract ends at #675, #680 needs a reconciliation preflight.
- **Step 7 reviews (round 1 full + round 2 verification-only, both committed under `docs/reviews/feat-673-import-consent-columns/`):**
  - Spec & correctness: NO findings ≥80%, PASS.
  - Standards (thermo-nuclear): one Low (test predicate duplication) — FIXED, round-2 VERIFIED.
  - Adversarial (codex thread `019fd355-e207-74a2-a75b-94a7fa92641e`): needs-attention, 3 findings — F2 ACCEPTED (wording, fixed, round-2 VERIFIED); F1/F3 REJECTED for this PR with follow-up constraints posted as comments on #675, #680, #677 (2026-08-05T19:29Z). F3's archive→re-add consent-reset loophole grazes the map-level "columns on businesses" decision — flag to owner at ship time.
- **Branch review rounds used: 2 of 3** (counter in `.feature/state.json`).

## Step 8 progress (2026-08-05, session 2)

1. **DONE — staging applied + verified.** Migration 100 applied to staging Supabase (`kubdiqdhqbhwmqfditeg`) via MCP `execute_sql`, verified by `information_schema.columns` + `pg_get_constraintdef` (all five columns exact; four-state CHECK renders as predicted; `zernio_backfill_runs` empty). Migrations-log marker replaced with **APPLIED TO STAGING … NOT YET PRODUCTION** (re-arms the immutability guard, 099 precedent). **D8 recorded**: staging `businesses` held 2 post-reset smoke rows — the §8a R3 zero-rows premise was stale by hours; harmless (both rows `pending`/NULL/NULL, no backdating), record-only. `staging` fast-forwarded to `fb47f0ca` and pushed; Railway staging worker redeployed and healthy (uptime probe + GitHub deploy check Success). Dual-write observability proof awaits the first staging backfill run (table empty).
2. **DONE — PR #685 open to `main`, ALL 15 CI checks green** (incl. fallow, e2e, llm-eval, CodeQL) at `fb47f0ca`.
3. **PAUSED HERE — awaiting owner merge approval.** At promotion, in order: apply migration 100 to prod Supabase (`udeyaqnvpojbwgoaxwdg`) BEFORE merging (099's order), verify by introspection, replace the migrations-log **NOT YET PRODUCTION** sentence with the applied-to-production statement, merge PR #685, `git pull --ff-only` local main, re-align `staging` with main, run `scripts/feature-cleanup.sh` dry-run then `--apply`, promote deviations lessons (D5–D8) to lab-notes, `document-feature` sweep, domain sweep, entropy counter, set feature phase `shipped`.
   - **Owner flags at ship time:** (a) adversarial F3's archive→re-add consent-reset loophole grazes the map-level "columns on businesses" decision — constraints posted to #676/#677; (b) GitHub reports 38 dependabot vulnerabilities on the default branch (17 high) — pre-existing, unrelated to this PR.
