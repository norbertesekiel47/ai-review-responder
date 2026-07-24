# Deviations — feat/541-contacts-csv

Entries appended by subagents when reality diverges from the plan. Orchestrator
logs a one-line ACCEPT / RE-PLAN verdict per entry at step 6.5.

## Pre-execution amendments (orchestrator-logged)

- [2026-07-24] Surface amendment #1 (user-approved at planning): added
  `src/lib/shared/worker-types.ts` + `src/lib/shared/__tests__/**` —
  `CsvIngestPayload` follows the worker-types.ts convention every other outbox
  payload uses; inverting the shared→domain dependency was the worse option.
- [2026-07-24] Surface amendment #2 (user-approved WITH explicit waiver of the
  "2nd amendment → abort" criterion): added `.claude/CLAUDE.md`. Reason:
  codex plan-review finding 5 — `contact_csv_uploads.report` is a new
  production JSONB field-to-parser site (PgBouncer string carve-out), and
  CLAUDE.md's explicit allowlist must gain the 16th entry in the same change.
  Waiver rationale: the abort criterion targets scope drift; a one-line
  documentation-allowlist addition is not drift. Recorded here so step 6.5 and
  the reviews inherit the decision.
- [2026-07-24] Planning-phase park: gate run at plan time is green on all 21
  checks EXCEPT `promised-tests` (structurally impossible before execution —
  the 20 promised tests are the work itself). Stop gate is not phase-aware, so
  `.feature/intake.json` is parked as `.feature/intake.parked.json` while
  awaiting the codex round-2 verdict + plan sign-off. MUST be renamed back
  before any implementation edit (arm-check re-verified at step 4 start).
