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

## Task 3

- [2026-07-30] **BLOCKED: spec §8.1's events need a DB migration the plan did
  not anticipate, and every file it needs is outside the edit surface.**
  `analytics_events.event_name` is a DB-level CHECK allowlist (046, last
  extended by 089 — whose own header warns that registering a name only in
  `ANALYTICS_EVENT_NAMES` is not enough). With `solicitation_consent_recorded`
  / `solicitation_consent_upgraded` registered in code but absent from the
  CHECK, **every consent-recording csv_ingest transaction rolls back**
  (verified on the live suite: `violates check constraint
  "analytics_events_event_name_check"`). Migration 093 is the recorded head
  and immutable (the fix is head+1 = 094), but the edit-surface-guard blocked
  `supabase/migrations/094_*.sql`, the migration-094 shape suite, the
  migration-089 drift-guard handoff edit, and `docs/analytics/events.md`
  (needed by `ci:analytics-events`). No in-surface adaptation exists for a DB
  constraint. **All four artifacts are written and parked verbatim in
  `feat-625-consent-ledger-task3-pending-artifacts.md`** — after the owner
  amends the intake surface (Task 6 precedent), land them, bump
  migrations-log to 094 (AFTER the 094 file exists — the immutability hook
  reads the head), run `pnpm test:db:setup`, and Task 3's gates go green. All
  in-surface Task 3 work (ingest.ts writer, analytics registration, unit +
  integration tests) is complete in the working tree; the commit is
  deliberately withheld until the gates can pass.
  **RESOLVED [2026-07-30]** with `feat(#625): migration 094 — analytics
  event_name allowlist gains consent events`: the map owner approved the
  second surface amendment (recorded in both intake copies — migration
  `094_*.sql`, the migration-094 shape suite, the migration-089 suite edit,
  `docs/analytics/events.md`). Migration 094 landed exactly as parked, the
  live CHECK⟺allowlist drift guard handed off 089 → 094 (the 069 → 089
  precedent), migrations-log bumped to head 094, and the parking file
  (`feat-625-consent-ledger-task3-pending-artifacts.md`) was deleted once its
  contents landed — this bullet is now the only record of it. Keep the
  underlying lesson at ship time: **any new `ANALYTICS_EVENT_NAMES` entry
  needs a paired event_name-CHECK migration** — a plan that registers an
  event without one repeats this block. 094 applies to staging + prod in the
  normal ship-time lockstep alongside 093.

## Task 4

- [2026-07-30] **BLOCKED: one compile-fallout site sits outside the edit
  surface.** Widening `WithholdEvidence`'s `no_consent` member (§6.1 —
  `upload_id: string | null; attestation_version: string | null`) breaks
  `pnpm typecheck` in exactly one file:
  `src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx`
  (~line 49), whose `sampleFor('no_consent', …)` fixture builds
  `{ ...base, reason, upload_id: 'upload-9' }` without the now-required
  `attestation_version`. The fix is one token —
  `upload_id: 'upload-9', attestation_version: 'consent_attestation_v1'` —
  but `src/app/**` is outside both Task 4's fallout surface
  (`src/lib/solicitation/**`) and the intake's `allowed_edit_surface`, so the
  write was not attempted. Runtime is unaffected (the suite passes 14/14 —
  vitest does not typecheck), so this is a compile-only block. Everything
  in-surface is complete and green: restraint-policy unit suite (73),
  batch-builder unit + integration (16, incl. the four promised titles),
  batch-view unit (10), lint, and the full `pnpm test` sweep (760 files /
  9714 tests, live-DB suites disabled per the verify-gate convention). Commit
  deliberately withheld until the surface is amended and typecheck can pass
  (Task 3 precedent).
  **RESOLVED [2026-07-30]** via a narrow map-owner surface amendment
  (recorded in both intake copies): the batch-report test file joined the
  surface. The fixture keeps its case-(b) intent — `upload_id` already
  populated — so it gained the matching populated
  `attestation_version: 'consent_attestation_v1'` (a case-(a) fixture would
  carry both nulls instead). Suite 14/14, `pnpm typecheck`, `pnpm lint`, and
  the full `pnpm test` sweep all green; landed with the Task 4 commit.

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
