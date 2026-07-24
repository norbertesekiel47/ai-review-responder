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
