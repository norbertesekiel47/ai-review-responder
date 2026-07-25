# Step 6 adversarial review triage — #543

Review verdict received from the user: **NEEDS ATTENTION / NO-SHIP**.

| Finding | Triage | Resolution | Evidence |
| --- | --- | --- | --- |
| Run-graph relationships were not tenant-safe | **ACCEPT** | Migration 088 now exposes `UNIQUE (account_id, business_id, id)`, uses tenant-composite parent/ask FKs with column-specific run-id `SET NULL`, and blocks nullable-Business parent bypass. | `04aca2ed`; separate cross-account/cross-Business rejection and archival assertions pass. |
| Executor bypassed offboarding processing gate | **ACCEPT** | Preparation and construction use account-row lock → later offboarding read → `isProcessingBlocked`; `delete_data` closes the owned attempt without history/asks/children. | `be750135`, `8833956e`; synchronized DB race and focused seam tests pass. |
| Exhausted batch failures lacked an alert | **ACCEPT** | The existing failed-topic health query includes `build_solicitation_batch`. | `e09f5d08`; focused health test passes. |
| Candidate query multiplied visit and ask histories | **ACCEPT** | Indexed latest-row lookups independently reduce both histories before the bounded contact join. | `be750135`, `d0bf4671`; 4,000 visits × 4,000 asks completes under a 2-second statement timeout. |

## Gate read-back

The first post-fix review gate exposed two secondary gate issues:

- explicit tenant bindings were not visible to `ci:tenant-scope`;
- valid full-lifecycle DB serialization exceeded the old 120-second hook
  budget.

Both were fixed without audit allowlists, coverage removal, or isolation
weakening. The complete DB-backed `scripts/verify-gate.sh --review` gate is
green at `9fc3c5d7`, including `pnpm build`, all CI audits, every changed
integration suite, promised tests, coverage, and diff coverage.

## Remaining lane requirement

The four review findings are closed in code. The high-risk feature is not
shipped until the mandatory staging migration/deploy/smoke ride succeeds;
production migration and issue #546 remain out of flight.
