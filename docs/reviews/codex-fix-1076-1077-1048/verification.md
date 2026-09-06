# Verification — issues 1076, 1077, 1048

Branch: `codex/fix-1076-1077-1048`. Base:
`249389c7e16aa9b2efb0646f0f1b6b88410b017a`. Local implementation; initial gates
ran before the owner authorized local implementation and review-report commits.

## Targeted evidence

- #1076: corrected regression fixtures fail on the original flag-on behavior
  in empty and populated windows; the implementation supplies the missing line.
- #1077: original behavior fails nine assertions across database overflow,
  rendering, and required-field validation. After the change, the combined
  Restraint component, read integration, and API route run passes **140 tests**
  across four files. Local DB suites ran, rather than skipping.
- Commands: `pnpm exec vitest run src/lib/refusals/__tests__/read.integration.test.ts src/components/dashboard/restraint/__tests__ src/app/api/dashboard/__tests__/refusals-route.test.ts`,
  with the configured localhost test DB explicitly supplied to both database
  environment variables. No remote database used.
- `pnpm doctor --verbose --diff`: repository-pinned React Doctor 0.9.11 reports
  **91/100, no issues found**. The initial latest-version attempt (0.9.12)
  failed pnpm's dependency trust check; no trust setting was disabled.
- #1048: three new database assertions fail on the original null producer;
  Requests copy assertion also fails before the fix. Final narrow run passes
  **118 tests across four suites, zero skips** (batch-builder unit/integration,
  Requests client, and batch report). This includes actual ask evidence,
  completed child run, mapped Refusal, and replay without duplicated effects.
- One intermediate #1048 run failed the pre-existing built-after-created
  constraint with DB time about 4ms ahead of host time. The identical-code
  rerun passed after clock diagnosis; no production or fixture workaround was
  introduced. Preserve this limitation if timing failures recur.
- Full wrapper gate: **GREEN**. Lint, typecheck, full test row, all selected CI
  audits, production build, both changed live-DB suites, intake verification
  commands, and promised-test checks pass. The initial full gate wrote and
  validated its content fingerprint. Review mode also passed with **62/62 added
  instrumented lines covered (100%)**. `.feature/gate-status.json` and `.feature/codex-gate-fingerprint.json`
  are authoritative for the most recent result and content freshness.
  The main test row reports **13,965 passed / 1,157 skipped** across
  **1,046 passed / 97 skipped files**. The wrapper deliberately disables
  live-DB suites in that row and runs the changed integration files separately;
  both changed integration rows and the explicit DB verification command pass.

## Browser verification

**Blocked: Computer Use is not exposed in this task.** No desktop/mobile
journey or screenshot evidence is claimed. Tool discovery found no Computer
Use or browser-control tool; `open_in_codex` displays pages but cannot exercise
the journey. Component tests above are distinct automated evidence.

Required target when available: a local app containing this branch's changes,
using designated test data. Exercise account/location Restraint windows with
posting on/off, empty/populated results, archival overflow, failed fetch/retry,
and the Requests explanation plus a built batch withholding an attributed
reviewer. Repeat on desktop and mobile; inspect the stored ask evidence and
Refusal/run outcome, and capture sanitized screenshots. Follow
`docs/runbooks/e2e-local-setup.md`.

## Documentation sweep

| File | Changed? | Reason |
| --- | --- | --- |
| CONTEXT.md | Yes | Clarifies historical coverage, archival overflow, and retained dated attribution. |
| docs/currents.md | Yes | Adds pre-merge state summary and existing-file map. |
| docs/progresstracking.md | Yes | Appends local implementation decisions and soft-deletion finding. |
| .claude/reference/env-vars.md | No | No environment variable or flag change. |
| .claude/reference/migrations-log.md | No | No migration. |
| .claude/reference/review-ingestion.md | No | No ingest change. |
| .claude/reference/lab-notes.md | No | Existing soft-delete precedent reused; contract clarification is in CONTEXT.md. |
| .claude/CLAUDE.md | No | No architecture invariant or file-location change. |
| docs/directory.md | No | No production file added, moved, or deleted. |
| .claude/reference/arch-review-log.md | No | Pre-merge; no merge counter increment. |

## Remaining guarded-workflow boundary

The required review wave and adversarial verifier inspect committed code.
After both gates passed, the owner authorized local implementation and review
report commits with “Yes go for it.” These authorize completing the guarded
reviews locally. No push, PR, deployment, or merge is authorized.
