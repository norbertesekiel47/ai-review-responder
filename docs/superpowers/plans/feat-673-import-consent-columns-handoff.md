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

Current step when this doc was written: entering step 4 (execute).
