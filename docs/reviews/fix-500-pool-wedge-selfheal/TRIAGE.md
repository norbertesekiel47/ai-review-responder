# #500 — Step 7 dual review triage

Both axes ran on `main...HEAD` (fresh agents, ≥80%-confidence filter).

## Verdict: BOTH CLEAN — no findings to accept/reject.

- **Spec & correctness** (`spec-correctness.md`): NO HIGH-CONFIDENCE FINDINGS.
  Intake verified field-by-field — user_visible_behavior 5/5, invariants 9/9,
  edge_cases 8/8, no `allowed_edit_surface` drift, tests_to_add 6/6 (all genuine
  behavior tests). Deviations D1–D7 correctly implemented. F1/F2 lifecycle fix holds.
- **Standards & maintainability** (`standards-maintainability.md`): NO HIGH-CONFIDENCE
  FINDINGS. Deep well-named modules, no `any`, `closeDb` shrank, invariant #15
  intact. Four sub-80% items in that report's appendix — none blockers.

No code changes from triage → no Step 5 gate re-run required (gate already GREEN at
HEAD `7b6f041d`).

## Carried to Step 8 (ship prerequisites, NOT code fixes)
1. **`DIRECT_URL` must be set** on the staging AND prod Railway workers to a real
   direct `:5432` route, or the default-ON reaper permanently disables itself +
   emits a Sentry warning (by design — never runs on the pooler it heals). On
   staging, `DATABASE_URL` is already the direct :5432 route (reaper resolves
   `DIRECT_URL ?? DATABASE_URL`), so confirm one of them is genuinely direct.
2. **Revert `HEALTH_ALERT_POLL_INTERVAL_MS` 86400000 → 300000** on the Railway
   staging worker (ENV change, correctly not in the diff).
3. **Staging active+ClientRead termination tracer** (Codex "next steps"): open a
   marked wedged backend on staging; assert reaper routes direct (app_name echo /
   non-6543 port), stable pid+backend_start + monotonic age, backend DISAPPEARS
   after the sweep, shared pool unaffected.
