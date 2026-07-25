# Step 7 — spec and correctness review: #543

## Review pin and method

- Fixed point: merge-base of `origin/main` and the feature branch,
  `42a4c30b7fe1142e9f1576a5f1ea6229b0bd8b49`.
- Reviewed implementation: `57c262a10adb75199d69014b5630fc96c942db38`
  (including final-review commits `644ce265` and `57c262a1`),
  plus the in-progress relocation of review artifacts into the intake-approved
  `docs/reviews/codex-543-run-engine-executor/**` path.
- Contract sources: `.feature/intake.json`, the implementation plan,
  `2026-07-23-run-engine-executor-shape.md`, ADR 0011, the triaged deviations,
  the accepted step-6 adversarial findings, and the generated blast-radius
  inventory.
- Confidence filter: the findings table contains only issues at or above 80%
  confidence with a concrete failure scenario. No such issue was found.

The working tree was dirty only for review/deviation artifacts and the
intake's review-path correction. Production source and tests matched the
reviewed HEAD.

## Findings (>=80% confidence)

No findings.

## Intake field-by-field verification

| Field | Status | Evidence |
| --- | --- | --- |
| `classification` / `surface` / `db_touching` | VERIFIED | The diff is a high-risk backend worker/schema feature: migration 088, `src/lib/**`, `worker/**`, and no UI implementation. |
| `goal` | VERIFIED | Completed-ingest trigger in `src/lib/solicitation/ingest.ts`; logical fan-out and authoritative decisions in `src/lib/solicitation/batch-builder.ts`; worker registration in `worker/index.ts`. No send/publish/notification seam is called. |
| `non_goals` | VERIFIED | No physical fan-out, join/wait/cancel verbs, status-enum expansion, owner UI, `reviewed_at` writer, fuzzy review attribution, suppression writer, consent ledger, #565 campaign, or #546 code/migration appears in the diff. |
| `user_visible_behavior` | VERIFIED | Ingest creates one unbuilt batch and outbox in its terminal transaction; construction reads the accumulated Business pool and commits asks/run graph/built fact; owner batch RLS requires `built_at IS NOT NULL`; closed gates remove owned unbuilt work and terminalize only an existing parent. |
| `invariants` | VERIFIED | Schema, builder, run-spine, offboarding, and history evidence are detailed below. Migration 088 leaves the three-state status CHECK and active-run partial predicate untouched. |
| `edge_cases` | VERIFIED | DB tests cover empty pool, 5,001-contact rotation, concurrent same-Business batches, committed replay, stale ownership, both no-parent and existing-parent gate closure, exhausted failure, send-only prior history, delete-data serialization, and repeated visit/ask history. |
| `existing_patterns_to_follow` | VERIFIED | The change deepens the run-spine and typed outbox seams, uses transaction-owned Postgres.js domain functions, follows the colocated worker/failed-hook layout, registers tenant tables/RLS, and extends the existing offboarding inventories. |
| `allowed_edit_surface` | VERIFIED | After the pending review-artifact relocation, every changed path is covered by the synchronized intake glob list. No package or lockfile changed. |
| `tests_to_add` | VERIFIED | All 21 titles occur verbatim in test files. The two final-review titles are in `src/lib/agents/__tests__/read.test.ts` and `src/lib/shared/__tests__/feature-543-database-lock.integration.test.ts`. |
| `verification_commands` | VERIFIED | Every declared command is PASS in `.feature/gate-status.json`, including all four changed DB integration suites and `pnpm build`. |
| `estimated_diff_size` | VERIFIED | The plan/intake explicitly reclassify the approximately 4,000-line implementation and record why executable Postgres evidence accounts for the growth. |
| `dependencies_added` | VERIFIED | Empty contract list and no manifest/lockfile diff. |
| `rollback_plan` | VERIFIED | Default-off `SOLICITATION_WATCH_ENABLED` stops new triggers and makes owned queued work self-remove; schema rollback is explicitly a later migration after code rollback. |
| `observability` | VERIFIED | Worker emits bounded aggregate/skip/failure fields; parent outcome stores the candidate count; terminal failed outbox rows enter the existing HealthAlertPoller query. |
| `open_questions` | VERIFIED | Empty. |

## Original behavior and atomicity

| Requirement | Status | Evidence |
| --- | --- | --- |
| Completed ingest creates exactly one batch plus durable build job | VERIFIED | `terminalizeUpload` and `createSolicitationBatchTrigger` run inside the existing ingest transaction; `source_upload_id` uniqueness plus insert-returning gates the paired enqueue (`src/lib/solicitation/ingest.ts:329-405`). |
| Exact-attempt ownership precedes mutation | VERIFIED | Preparation's first domain statement locks the dispatched outbox attempt before the batch or parent (`src/lib/solicitation/batch-builder.ts:129-151`). Construction's first statement completion-CASes that attempt (`:300-320`). |
| Construction is atomic | VERIFIED | Ask inserts, child runs/steps, ask linkage, parent step/outcome/completion, `built_at`, and outbox completion all share the construction transaction (`src/lib/solicitation/batch-builder.ts:300-601`). A thrown write rolls the outbox CAS back too. |
| Same-Business histories serialize | VERIFIED | Construction takes the Business advisory transaction lock before history reads (`src/lib/solicitation/batch-builder.ts:325-330`); the concurrent integration test proves the later batch sees the earlier committed send. |
| Retry and exhausted failure are owned | VERIFIED | Committed retries fail exact-attempt ownership and create no duplicate graph. The failed hook marks the exact outbox attempt first, then locks/fails only the matching active parent, leaving `built_at NULL` (`worker/jobs/solicitation-batch/failed-hook.ts:45-125`). |
| Watch-mode sends nothing | VERIFIED | The builder and worker depend only on DB, policy, logging, run-spine, and outbox modules; no publisher, notification, provider, or HTTP seam appears. |

Lock order is consistent on the shared resources:

1. preparation: outbox attempt -> batch -> account -> active parent;
2. construction: outbox completion CAS -> batch -> Business advisory lock ->
   account -> later offboarding projection;
3. exhausted hook: outbox failure CAS -> batch/active parent.

## Accepted no-ship remediation

| Accepted finding | Status | Evidence |
| --- | --- | --- |
| Tenant-composite parent and ask run links, archival-safe | VERIFIED | Migration 088 creates `UNIQUE (account_id, business_id, id)`, requires Business scope for parented runs, and adds both composite FKs with column-specific `ON DELETE SET NULL` (`supabase/migrations/088_solicitation_batch_executor.sql:23-55,181-191`). The DB test separately rejects cross-account and sibling-Business links and verifies only the run-id column nulls during archival (`src/lib/shared/__tests__/migration-088-solicitation-batch-executor.integration.test.ts:212-428`). |
| Offboarding gate race in both transactions | VERIFIED | Preparation and construction each lock the account row, perform a later `getOffboardingState` command under READ COMMITTED, and apply `isProcessingBlocked` before candidate history (`src/lib/solicitation/batch-builder.ts:161-224,332-375`). The synchronized DB race proves an in-flight `delete_data` writer wins visibility before any ask/run effect; the focused construction test proves the second recheck closes an already-started parent without reading contacts. |
| Actionable terminal-failure alert | VERIFIED | `checkFailedOutboxByTopic` includes `QUEUE_NAMES.BUILD_SOLICITATION_BATCH` and emits an error finding above threshold (`worker/background/pollers/health-alert/checks.ts:56-85`); the exact promised regression pins both query inclusion and finding shape. |
| Bounded history work and send-only `priorBatch` | VERIFIED | Candidate scheduling uses indexed latest-row lookups for visit and latest evaluation rather than joining both histories, then applies the 5,000 cap (`src/lib/solicitation/batch-builder.ts:389-445`). A separate query loads only `status='send'` history for selected contacts (`:447-463`). The 4,000-visit/4,000-ask regression completes under a 2-second statement timeout, and the velocity-banked integration case remains eligible. |

## Final-review delta

- `644ce265` changes the persisted-row type accepted by the existing Agent
  team summary and adds a regression proving Solicitation outcomes do not
  alter the displayed Reply/Guardian/Insights totals. It does not change the
  query, reducer, user-visible output, or a non-goal.
- `57c262a1` extracts the feature-only local-Postgres advisory-lock harness and
  adds a timeout/session-release regression. Its production diff is empty.
- The new read/test/harness paths are explicitly present in
  `allowed_edit_surface`; both intake copies list 21 verbatim tests.
- Neither commit touches a migration, #546, network deployment code, or any
  remote database path. The harness still refuses non-local Postgres hosts.

## Tests, surface, migration boundary, and blast radius

- All 21 promised titles are present verbatim. The original four changed DB suites pass
  separately with 34/34 tests.
- Review gate: lint PASS; typecheck PASS; full test PASS (9,489 passed, 9
  skipped outside the changed DB rows); every `ci:*` audit PASS; build PASS;
  promised-tests PASS; diff coverage PASS at 98.8%.
- The broadest changed seams (`run-spine.ts`, outbox helpers/types, queue
  registry, worker entry point) have their importers enumerated in
  `blast-radius.md`; typecheck, full tests, topic audit, DB-import audit,
  tenant-scope audit, RLS audit, and build are green.
- The only schema file in the diff is
  `supabase/migrations/088_solicitation_batch_executor.sql`. The migration test
  refuses non-local hosts, the migration log records it as not remotely
  applied, and no staging/production apply artifact exists in this branch.
- Issue #546 remains excluded: no #546 code/schema/migration is present, and
  the intake/plan/rollback contract keeps it blocked until #543 lands.

## Verdict

All verifiable intake claims, the four accepted no-ship remediations, and the
two final-review compatibility/harness regressions are implemented without
changing product behavior or the migration boundary.

Suite: lint PASS | typecheck PASS | test PASS (9,489) | changed DB tests PASS
(34) | audits PASS | build PASS | diff coverage PASS

VERDICT: PASS
