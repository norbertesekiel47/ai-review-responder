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
- [2026-07-24] Task 2 spec-review minor, ACCEPTED-AS-IS (orchestrator): rejected-row
  numbers in the report count blank-line-filtered data rows, so they can drift
  from physical CSV line numbers when blank lines are interleaved. Plan wording
  tolerates it; revisit only if owner confusion shows up. Two other findings
  (strict unterminated-quote structural failure mapped to undecodable_encoding;
  escape sequences + BOM/U+FFFD test coverage) were FIXED in a follow-up commit.
- [2026-07-24] Surface amendment #3 (user-approved WITH explicit waiver): added
  `worker/jobs/account-offboarding/**` + `scripts/ci/tenant-tables.ts`. Reason:
  the two Task 8 divergences below — the contract-§5 purge DELETE and the
  tenant-table registry entries live in files the intake enumeration missed
  (declaration error, not scope drift; both are wiring the signed-off intake
  already promised). LESSON for lab-notes promotion at step 8: any migration
  adding an account-linked table must also touch purge-stages.ts +
  scripts/ci/tenant-tables.ts — future schema-ticket intakes should include
  them by default.
- [2026-07-24] Step-0 re-check (reclassify WARN, user-ACCEPTED): total diff
  +5,069 tripped the 2× trigger against the 2,000-line estimate, but the split
  is production code +2,467 (WITHIN the 2,000–2,500 estimate), tests +1,156,
  docs +1,446 (the workflow's own artifacts). Overage = tests + docs, not
  scope creep; lane already maximal (high / full pipeline / staging ride).
  Lane unchanged with user sign-off.
- [2026-07-24] diff-coverage documented EXCEPTION (user-approved): the FAIL is
  structural, not missing diligence. (a) ingest.ts/contacts-repo.ts are
  covered by the live-DB integration suites, which the gate runs as separate
  vitest invocations whose coverage never merges into coverage-final.json —
  both suites passed 3× against the local test DB (gate run 1 rows, Task 5
  and Task 8 reports). (b) ContactsClient.tsx (~600 lines) is untested by
  repo convention — no dashboard client island has tests; the plan
  conditioned UI tests on neighbor precedent. Latent gate-script bug also
  surfaced: TEST_DATABASE_POOL_URL set globally makes the `test` row wake
  pre-existing WS8 live-DB suites that break inside full vitest runs
  (singleton-init ordering; reproducible off-branch). Gate-hardening
  follow-up filed as issue #563. Review proceeds with the gate green on all
  other rows.
- [2026-07-24] Planning-phase park: gate run at plan time is green on all 21
  checks EXCEPT `promised-tests` (structurally impossible before execution —
  the 20 promised tests are the work itself). Stop gate is not phase-aware, so
  `.feature/intake.json` is parked as `.feature/intake.parked.json` while
  awaiting the codex round-2 verdict + plan sign-off. MUST be renamed back
  before any implementation edit (arm-check re-verified at step 4 start).
- [2026-07-24] Task 3, ACCEPTED-AS-IS (reality diverges from plan text): the
  plan's `enqueueCsvIngest` snippet INSERTs an `idempotency_key` column into
  `job_outbox`. That column does not exist and never has — checked
  `supabase/migrations/001_initial_schema.sql`'s `job_outbox` definition and
  every later `ALTER TABLE job_outbox` (002, 083); the only columns are `id,
  topic, aggregate_type, aggregate_id, payload, available_at, dispatched_at,
  completed_at, attempts, max_attempts, status, last_error, created_at`.
  BullMQ's own dedup key (`${entry.id}_${entry.attempts}`, underscore
  separator) is derived by `OutboxPoller` from the row's own `id`, not a
  literal `idempotency_key` field. Task 1's migration 086 also does not add
  any partial unique index on `job_outbox` for `csv_ingest` (unlike
  `pending_post_notice`/`auto_post_notice`/`judge_verdict`, each backed by
  its own migration-authored index), so the `ON CONFLICT (topic,
  aggregate_id) WHERE ...` pattern those helpers use has no index to bind to
  here. Implemented `enqueueCsvIngest` as a plain INSERT (six columns: id,
  topic, aggregate_type, aggregate_id, payload, status), mirroring
  `enqueueSendNotification`'s shape and its "each call site already gates on
  a state-guarded transition before reaching here" reasoning: `uploadId` is a
  freshly minted uuidv7 written once by `createContactsCsvUpload` (Task 4),
  so this helper is called exactly once per aggregate. Treated `aggregate_id
  = uploadId` as the deterministic idempotency key the plan's prose actually
  points at (an outbox row deterministically identified by its upload);
  retried BullMQ delivery of that same row is idempotent via
  `ingestContactsCsvUpload`'s terminal-state check + per-business advisory
  lock (Task 5), not via an INSERT-time guard. No file outside the approved
  Task 3 edit surface was touched to resolve this — if Task 5 or a future
  reviewer wants a true in-flight INSERT-time guard, that requires a new
  migration (out of this task's scope) adding a partial unique index on
  `job_outbox (topic, aggregate_id)` for `csv_ingest`.
- [2026-07-24] Task 3, ACCEPTED-AS-IS (typecheck failure in the plan's literal
  snippet): the plan's `attestation.ts` snippet ends
  `'...sent in watch-mode.' as const;` applied to a `+`-concatenated string —
  TS1355 (`A 'const' assertion can only be applied to ... string, number,
  boolean, array, or object literals`), confirmed by `pnpm typecheck`.
  `as const` cannot bind to a `BinaryExpression` result even parenthesized.
  Dropped `as const` from `CONSENT_ATTESTATION_TEXT` (type widens to
  `string`, harmless — it's rendered as UI copy, never narrowed/discriminated
  like `CONSENT_ATTESTATION_VERSION`, which keeps its `as const`).
- [2026-07-24] Task 4, minor route-shape divergences from "resolve the
  location context exactly as kpis does" on GET `/uploads/[id]`:
  (a) aggregate scope (`?scope=all`) returns 400 `A location scope is
  required` instead of kpis's account-aggregate branch — an upload belongs to
  exactly one location, so the aggregate mode has no meaning for a
  single-upload status read; (b) location exposure uses `'uniform-not-found'`
  (the newer agent-team posture policy.ts itself recommends for new routes)
  rather than kpis's `'legacy-kpis'` (403 foreign-location) — a new surface
  should not leak foreign-location existence. POST auth uses
  `requireWritableOwner` + `withSameOrigin` from route-helpers (no
  write-flavored wrapper exists in dashboard `policy.ts`) — this is the
  plan's own contingency branch, recorded here for the reviews: the POST is
  owner-gated AND writable-subscription-gated, matching every other
  dashboard mutation route.
- [2026-07-24] Task 5, allowlist follow-up for Task 9: `contact_csv_uploads.report`
  now has a SECOND production JSONB field-to-parser site —
  `src/lib/solicitation/ingest.ts` (`parseStoredReport`, the terminal-status
  no-op re-read the plan requires: "status != 'pending' → return the stored
  report"), alongside Task 4's `src/lib/solicitation/uploads.ts`
  (`getUploadStatus`). Pre-execution amendment #2 promised the CLAUDE.md
  allowlist one `contact_csv_uploads.report` entry; that entry (Task 9 —
  CLAUDE.md is outside Task 5's edit surface) must cite BOTH sites.
- [2026-07-24] Task 5, ACCEPTED addition beyond the plan's Step 5 pseudocode:
  outbox bookkeeping. The plan's `handleCsvIngest` snippet and failed-hook
  spec never mention `job_outbox`, but the mirrored precedents it mandates do
  — the judge/notification handlers `markOutboxCompleted` on every exit, and
  the zernio failed-hook's core is the CAS-first `markOutboxFailed` coupled
  tx. Without them the OutboxPoller watchdog would re-pend the dispatched row
  indefinitely (steady-state violation). Implemented: handler marks the
  outbox row completed on all three exits (missing row / no-entitlement /
  success); failed-hook takes the advisory lock FIRST (plan's explicit
  round-2 ordering, ahead of zernio's CAS-first), then gates the upload
  terminalization on `markOutboxFailed` ownership so a stale exhausted
  attempt that lost to the watchdog performs no mutation. Also, the hook
  persists/logs only the bounded error CLASS (`err.name`), never the message
  — a Postgres unique-violation message/detail can embed handle values (PII
  invariant).
- [2026-07-24] Task 6, PRE-EXISTING `pnpm ci:tenant-scope` failure (NOT
  introduced by Task 6 — verified by re-running the audit on the stashed tree
  at Task 5's commit 29b9aab4, same failure): the audit flags
  `worker/jobs/csv-ingest/index.ts` (`accounts` + `businesses`: "missing
  account_id or business_id scope"). That is Task 5's subscription-gate join
  — a deliberate cross-table read keyed by the trusted `uploadId` aggregate
  (the upload row's business→account join IS the authoritative pairing). The
  fix is an allowlist entry (+ `ALLOWLIST_BASELINE` bump) in
  `scripts/ci/tenant-scope-audit.ts`, which is outside Task 6's approved edit
  surface, so it is left for the orchestrator (Task 5 follow-up or the Task 9
  sweep). Task 6's own queries (`src/lib/solicitation/contacts-repo.ts`) pass
  the audit — both carry `c.business_id = $businessId AND
  b.account_id = $accountId`.
- [2026-07-24] Task 5 follow-up, audit-driven query strengthening (RESOLVES the
  Task 6 note above — no allowlist entry needed): the `handleCsvIngest` gate
  query now BINDS the payload's businessId into the read —
  `AND u.business_id = ${'$'}{businessId}` plus `AND b.id = ${'$'}{businessId}`
  (directly-scoped `businesses` alias; `accounts` becomes transitively scoped
  through the `a.id = b.account_id` join, per the audit's accountTableScoped
  rule). Semantically a strengthening, not a workaround: it mirrors
  `ingestContactsCsvUpload`'s expectedBusinessId assert, so a payload/row
  pairing mismatch now yields no gate row and takes the warn +
  markOutboxCompleted skip branch (warn message updated to name both causes;
  worker unit test retitled and now asserts the bound values). `pnpm
  ci:tenant-scope` passes with the baseline unchanged at 405 entries.
- [2026-07-24] Task 8, two divergences surfaced by wiring the disposition
  entries — both left for the orchestrator because their fix files are
  outside Task 8's approved edit surface (`table-disposition.ts`,
  `purge-verification.ts`, `__tests__/**`):
  1. **NEW, blocking correctness gap — contract §5 is not yet fully
     satisfied.** `verifyAccountOffboardingPurge` (read-side check) now
     covers all three tables, but nothing on the WRITE side deletes them.
     `worker/jobs/account-offboarding/purge-stages.ts` (`runContentPurgeStage`)
     and `purge-helpers.ts` (`DELETABLE_BY_BUSINESS`/`deleteByBusiness`) have
     no entries for `contact_csv_uploads`/`solicitation_contacts`/
     `solicitation_visits`. `businesses`/`accounts` are `retain_deidentified`
     (UPDATE-tombstoned, never `DELETE`d), so the migration's `ON DELETE
     CASCADE` FKs from `contact_csv_uploads` never fire during offboarding —
     CASCADE only helps Task 6's per-contact delete, not account purge. Net
     effect: for ANY account that has ever uploaded a contacts CSV,
     `finalizePurgeInTransaction`'s verification step will now find
     violation rows for these three tables and throw
     `account_offboarding_purge_verification_failed`, permanently blocking
     that account's purge (retryable, but it will never succeed without a
     code fix). Needs: add
     `DELETE FROM contact_csv_uploads WHERE account_id = ${accountId}`
     to `runContentPurgeStage` (alongside the `flagged_responses`/
     `deleteByBusiness` calls) — `solicitation_contacts`/`solicitation_visits`
     CASCADE from that single delete via their `created_by_upload_id`/
     `upload_id` FKs, so no separate delete is needed for those two. This is
     a functional prerequisite for Task 8 to be complete per contract §5
     ("the account offboarding delete_data/purge path must sweep uploads,
     contacts, and visits") — recommend a required Task 8 follow-up commit,
     or folding it into Task 9 before the full gate runs with
     `TEST_DATABASE_POOL_URL` set (a live-DB PurgeWorker integration test
     would have caught this; none currently seeds a contacts-CSV fixture).
  2. **Test-only, non-blocking** —
     `src/lib/account-offboarding/__tests__/table-disposition.test.ts`'s
     pre-existing `classifies every tenant table and explicit account-linked
     table exactly once` test cross-checks `TABLE_DISPOSITIONS` against
     `scripts/ci/tenant-tables.ts`'s `TENANT_TABLES` (+ two other allowlists).
     Adding the three Task 8 entries (required, and correctly flagged by the
     *other* coverage-lock test, `classifies every directly account-linked
     table created by migrations`, which now passes) makes this second test
     fail because `TENANT_TABLES` was never updated for migration 086 — Task
     1's plan didn't mention `scripts/ci/tenant-tables.ts` and it isn't in
     Task 9's file list either. Confirmed this is not a Task 8 regression:
     reproduced on the pre-Task-8 tree (`git stash`), where the OTHER
     coverage-lock test fails instead for the same underlying reason.
     `pnpm ci:tenant-scope` and `pnpm ci:rls-audit` both still pass (405/33
     baselines unchanged) — only this one offboarding-suite unit test
     regresses. Needs: add `'contact_csv_uploads'`, `'solicitation_contacts'`,
     `'solicitation_visits'` to `TENANT_TABLES` in
     `scripts/ci/tenant-tables.ts`. One-line fix, but outside Task 8's
     approved edit surface — left for the orchestrator/Task 9.
- [2026-07-24] Task 8 follow-up (surface amendment #3 approved: added
  `worker/jobs/account-offboarding/**` + `scripts/ci/tenant-tables.ts` to the
  edit surface). Both prior gaps: **RESOLVED**.
  1. `runContentPurgeStage` (`worker/jobs/account-offboarding/purge-stages.ts`)
     now does `DELETE FROM contact_csv_uploads WHERE account_id = ...`,
     commented with the CASCADE reliance. Re-verified the CASCADE claim
     directly against `086_solicitation_contacts.sql`:
     `solicitation_contacts.created_by_upload_id` and
     `solicitation_visits.upload_id` are both
     `REFERENCES contact_csv_uploads(id) ON DELETE CASCADE`, and
     `solicitation_visits` also carries the composite
     `solicitation_visits_contact_business_fk REFERENCES
     solicitation_contacts (id, business_id) ON DELETE CASCADE` — two
     independent cascade paths confirm no separate DELETE is needed for the
     other two tables. Proven, not just asserted: added a contacts-CSV
     fixture (one upload + one contact + one visit) to the existing live-DB
     `purge worker completes with shortened non-production window` test in
     `worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts`
     and asserted all three tables are empty post-purge — ran it against the
     local `repworth-testdb` container (`TEST_DATABASE_POOL_URL=postgresql://
     test:test@localhost:5499/test_ws4`) and it passed on the first try,
     confirming the write-side delete and read-side verification agree for
     real. Also extended the mocked `PurgeWorker.test.ts` unit test with an
     assertion on the new `DELETE FROM contact_csv_uploads` statement
     (scope `tx`, `account_id =` predicate) and a negative assertion that no
     explicit `DELETE FROM solicitation_contacts`/`solicitation_visits`
     appears (cascade-only), mirroring the file's existing
     `channel_enrollments`/`agent_outcomes` assertion style.
  2. `TENANT_TABLES` in `scripts/ci/tenant-tables.ts` now includes
     `contact_csv_uploads`/`solicitation_contacts`/`solicitation_visits`
     (grouped with a new comment, appended after `zernio_backfill_runs` and
     before the `inbound_events` deny-all-RLS block — these three have real
     owner-read-only RLS like `competitor_snapshots`, not deny-all).
     `table-disposition.test.ts`'s `classifies every tenant table...` test
     now passes; full offboarding suite is 184/184 (`pnpm vitest run
     src/lib/account-offboarding worker/jobs/account-offboarding` with
     `TEST_DATABASE_POOL_URL` set — 26 files, 0 skipped, 0 failed).
     `pnpm typecheck` and `pnpm lint` are both clean.
  **NEW gap surfaced by fix #2, UNRESOLVED and blocking `pnpm
  ci:tenant-scope` green** (confirmed via `git stash` on
  `scripts/ci/tenant-tables.ts` alone that this is caused by that one file):
  adding `contact_csv_uploads`/`solicitation_visits` to `TENANT_TABLES` makes
  `scripts/ci/tenant-scope-audit.ts` start scanning queries against those two
  tables for the first time, and it flags three pre-existing, deliberately
  id-scoped call sites as unscoped:
  `src/lib/solicitation/contacts-repo.ts` (`listContacts`'s
  `JOIN solicitation_visits v ON v.contact_id = c.id` — `v` carries no direct
  `business_id`/`account_id` predicate of its own; the file's own doc comment
  already establishes the pattern: "Contacts carry NO account_id... every
  query here joins businesses... the join IS the account-scope check" — same
  transitive-scoping shape the audit already accepts for `solicitation_contacts`
  itself, just not yet taught to trust it through one more join level to
  `solicitation_visits`), `src/lib/solicitation/ingest.ts`
  (`ingestContactsCsvUpload`'s `SELECT ... FROM contact_csv_uploads WHERE id =
  ${uploadId}` and `terminalizeUpload`'s matching `UPDATE`, both keyed by the
  trusted upload-id aggregate, business ownership re-checked in app code
  immediately after the read — same worker-job-scoped-by-trusted-id pattern as
  Task 5's `handleCsvIngest` gate query), and `worker/jobs/csv-ingest/failed-hook.ts`
  (`UPDATE contact_csv_uploads ... WHERE id = ${job.data.uploadId} AND status =
  'pending'`, same pattern). None of these three files are in the edit surface
  granted to this task (Task 8 + amendment #3 cover only
  `table-disposition.ts`, `purge-verification.ts`,
  `src/lib/account-offboarding/__tests__/**`, `worker/jobs/account-offboarding/**`,
  and `scripts/ci/tenant-tables.ts`) — nor is `scripts/ci/tenant-scope-audit.ts`
  itself, which is where the fix most likely belongs (an allowlist entry +
  `ALLOWLIST_BASELINE` bump, the same resolution already used for the Task 6
  note above, OR a query-strengthening fix at the three call sites themselves,
  the pattern the "Task 5 follow-up" entry above used to resolve the prior,
  analogous `worker/jobs/csv-ingest/index.ts` finding). Left for the
  orchestrator: grant access to `scripts/ci/tenant-scope-audit.ts` and/or
  `src/lib/solicitation/**` + `worker/jobs/csv-ingest/**`, or route this to a
  dedicated follow-up task. `pnpm ci:rls-audit` is unaffected and passes (36
  tenant tables now enable RLS in migrations, up from 33 — the three new
  tables' RLS is correctly picked up).
- [2026-07-24] `ci:tenant-scope` blocker above: **RESOLVED via query
  strengthening** (surface amendment: added `src/lib/solicitation/**` +
  `worker/jobs/csv-ingest/**`; `scripts/ci/tenant-scope-audit.ts` stayed
  untouched, no allowlist/baseline change). All three call sites bind a
  tenant value already held in scope — no site needed a value it didn't
  already have:
  1. `src/lib/solicitation/contacts-repo.ts` `listContacts` —
     `JOIN solicitation_visits v ON v.contact_id = c.id AND v.business_id =
     ${businessId}`. Genuinely redundant-safe, not just audit theater:
     `solicitation_visits.business_id` is denormalized directly onto the
     table (migration 086) and is provably always equal to the parent
     contact's `business_id` via the composite FK
     `solicitation_visits_contact_business_fk (contact_id, business_id)
     REFERENCES solicitation_contacts (id, business_id)`.
  2. `src/lib/solicitation/ingest.ts` — bound `expectedBusinessId` into
     `ingestContactsCsvUpload`'s upload SELECT (`WHERE id = ${uploadId} AND
     business_id = ${expectedBusinessId}`) and threaded a new `businessId`
     parameter through `terminalizeUpload` into its `UPDATE`'s `WHERE`. Kept
     the existing `upload.business_id !== expectedBusinessId` throw
     unchanged (per instruction) — added a comment noting it is now
     unreachable through this bound query (a mismatch yields no row, hitting
     the `if (!upload)` "missing — nothing to ingest" warn+return-null branch
     instead) and is kept as defense-in-depth only. Checked for an existing
     test asserting the old throw-on-mismatch behavior: none exists (
     `ingest.test.ts` only covers the pure `resolveContactMatch`;
     `ingest.integration.test.ts` has no mismatch scenario), so nothing
     needed updating — the coherence check the instruction asked for came up
     clean.
  3. `worker/jobs/csv-ingest/failed-hook.ts` — bound `job.data.businessId`
     into the terminalization `UPDATE`'s `WHERE` (alongside the existing
     `status = 'pending'` predicate) — same trusted-aggregate value the
     advisory lock two lines above is already keyed on.
  Verified: `pnpm ci:tenant-scope` passes with the baseline UNCHANGED at 405
  entries (no allowlist edit). Full re-run, `TEST_DATABASE_POOL_URL` set:
  `pnpm vitest run src/lib/solicitation worker/jobs/csv-ingest
  src/lib/account-offboarding` → 190/190 pass, plus `worker/jobs/account-offboarding`
  → 69/69 pass (300 total across both commands, 0 regressions from the
  signature/query changes — no mocked unit test asserted exact SQL text
  tightly enough to break). `pnpm ci:rls-audit`, `pnpm lint`, `pnpm
  typecheck` all clean.

- 2026-07-24 (Task 9, registry sweep): `docs/directory.md`'s
  `supabase/migrations/` section claimed head `078` / next `079`, but
  migrations `082`–`085` already existed on this branch's base BEFORE #541
  (pre-existing staleness, not introduced here). Updated the head line to
  `086` (`086_solicitation_contacts.sql`) / next `087` while adding the #541
  entry, since leaving a knowingly wrong number while editing the adjacent
  fact would be a dangling-ref bug per repworth.md. Per-migration narrative
  remains owned by `.claude/reference/migrations-log.md`.

## Step 6.5 read-back verdicts (orchestrator, 2026-07-24)

Every entry above re-read end to end. Verdicts, in file order: amendments
#1–#3 ACCEPT (user-approved at the time, waivers recorded); Task 2 minor
ACCEPT (won't-fix, monitored); step-0 re-check ACCEPT (user); diff-coverage
exception ACCEPT (user; follow-up #563); parks ACCEPT (protocol);
Task 3 idempotency_key + as-const ACCEPT (plan text was wrong, code is
right); Task 4 route-shape divergences ACCEPT (uniform-not-found is the
stricter posture); Task 5 second JSONB site ACCEPT (allowlist cites both,
landed in Task 9); Task 5 outbox bookkeeping ACCEPT (precedent-mandated);
Task 6 pre-existing audit note ACCEPT (superseded by resolution below it);
Task 5 follow-up strengthening ACCEPT; Task 8 gaps + resolutions ACCEPT
(purge DELETE proven live; tenant-tables wired; strengthenings verified
semantics-preserving); Task 9 directory.md staleness fix ACCEPT. No entry
invalidates a locked intake decision — NO RE-PLAN required.
