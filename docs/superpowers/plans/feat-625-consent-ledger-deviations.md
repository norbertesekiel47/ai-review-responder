# Deviations — feat-625-consent-ledger

## Pre-implementation coordination notes

- [2026-07-30] **Surface overlap with `feat-628-ask-generation-lane`** on
  `src/lib/solicitation/**`; the one real collision file is
  `src/lib/solicitation/batch-builder.ts` (#625 rewrites the consent read in
  the candidate query; #628 adds the generation enqueue to the `built_at`
  transaction). **Agreed merge order (owner-approved, 2026-07-30): #625
  merges first; #628 rebases over it before its gate/review rounds.** #625
  does not need to coordinate further — proceed normally. Same note recorded
  in feat-628's deviations file.

## Task 2

- [2026-07-30] Task 2's "full `pnpm test` all green" gate could not be met
  literally: `src/lib/account-offboarding/__tests__/table-disposition.test.ts`
  fails because migration 093 (Task 1) added `solicitation_consent` without a
  disposition entry. Confirmed pre-existing at HEAD (fails with Task 2's
  changes stashed) and explicitly owned by Task 6 ("Offboarding disposition
  entry") in the locked plan. Everything else green: 768 passed / 1 failed
  files, 9839 passed / 1 failed tests. No adaptation made — proceeding.

## Task 6

- [2026-07-30] **`scripts/ci/tenant-tables.ts` is outside the intake's
  `allowed_edit_surface`** (edit-surface-guard blocked the write), but the
  disposition completeness test requires every classified table to appear in
  `TENANT_TABLES ∪ EXPLICIT ∪ SPEC_ONLY`. Adaptation: `solicitation_consent`
  added to `EXPLICIT_ACCOUNT_OFFBOARDING_TABLES` (in-surface) with a comment
  pointing here. **Follow-up before merge (or with #628/#630):** move it to
  `TENANT_TABLES` (amending the surface with user sign-off) so `ci:rls-audit`
  guards its RLS posture and `ci:tenant-scope` audits its queries — the
  precedent every other `solicitation_*` table follows.
  **RESOLVED [2026-07-30]** with `fix(#625): explicit consent purge sweep +
  tenant-table registration`: the map owner approved the surface amendment
  (both intake copies now include `scripts/ci/tenant-tables.ts` and
  `worker/jobs/account-offboarding/**`); `solicitation_consent` is registered
  in `TENANT_TABLES` like its siblings and the EXPLICIT-list workaround is
  removed — one authoritative owner.
- [2026-07-30] **Spec §7.2's cascade assumption does not hold on the
  offboarding purge path.** The locked reason text says consent rows "leave
  with the business via the businesses(id) cascade", but
  `worker/jobs/account-offboarding/purge-stages.ts` tombstones `businesses`
  (retain_deidentified — UPDATE, never DELETE), so that cascade never fires
  during purge; `source_upload_id` is ON DELETE SET NULL and consent has no
  FK to contacts, so nothing else sweeps the ledger either. The
  `must_be_absent` verification added in this task therefore FAILS CLOSED for
  any account holding consent rows. `worker/**` is outside the #625 edit
  surface, so the sweep could not land here. **Blocking follow-up before any
  consent writer ships (Task 3 ingest wiring):** add `solicitation_consent`
  to `DELETABLE_BY_BUSINESS` in
  `worker/jobs/account-offboarding/purge-helpers.ts`, call
  `deleteByBusiness(tx, 'solicitation_consent', row.account_id)` in
  `purge-stages.ts` (the flagged_responses/agent_runs precedent: explicit
  DELETE because the parent row is tombstoned), and pin it in
  `PurgeWorker.test.ts`. The locked entry text was kept verbatim per the
  plan; the purge-verification.ts comment records the real mechanics.
  **RESOLVED [2026-07-30]** with `fix(#625): explicit consent purge sweep +
  tenant-table registration`: `deleteByBusiness(tx, 'solicitation_consent',
  …)` now runs in the content-purge stage (after the upload delete, under the
  same csv-ingest/batch advisory locks), pinned by `PurgeWorker.test.ts` and
  by a live-DB absent-vs-bystander-survives assertion pair in
  `offboarding-lifecycle.integration.test.ts`. **Keep the underlying finding:
  spec §7.2's "rows leave with the business via the businesses(id) cascade"
  is WRONG on the offboarding purge path (businesses are tombstoned, never
  DELETEd — the cascade only fires on real location deletion); promote this
  to the spec + lab notes at ship time.**
