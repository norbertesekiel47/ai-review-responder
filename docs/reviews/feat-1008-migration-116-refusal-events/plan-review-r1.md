I’m using the repository’s `verify-spec` skill because this is a read-only adversarial audit of a plan and its eval. I’ll first load the project rules and skill instructions, then trace every cited artifact and map the 13 proposed tests against the locked DDL and purge behavior.

===== MSG BREAK =====

The skill normally writes an incremental `/tmp` findings file, but your read-only instruction overrides that, so I will keep findings in-memory and make no filesystem changes. I’m also checking the worktree state now so the report can distinguish HEAD evidence from uncommitted changes.

===== MSG BREAK =====

The plan file itself is untracked, while the intake is tracked; I’ll review the supplied plan as the artifact but resolve its citations against HEAD. Because this audit has well over 15 independently verifiable claims, the `verify-spec` workflow calls for parallel section checks; I’m splitting eval coverage, citation resolution, and codebase/order assumptions, then I’ll independently verify any adverse findings before reporting.

===== MSG BREAK =====

Two material codebase conflicts are already confirmed: the plan omits a forced `docs/security/rls-inventory.md` update, and its “retry succeeds after promotion” claim conflicts with the purge worker’s three short retries and terminal-failure path. I’m finishing the mechanical citation matrix and tightening the missing-test list so each row names an executable bad state, not a prose concern.

===== MSG BREAK =====

## EVAL VERDICT:

**Yes. The 13-test eval can pass while the feature is still wrong.**

Most importantly, the proposed C1 fall-through insert is impossible against the locked schema: the separate `refusal_source` CHECK rejects every unmapped lane before C1 runs. A C1 implementation with the correct seven arms but without `IS TRUE` can therefore pass all reachable row tests.

| MISSING FAILING TEST title | What bad state it catches | Which locked decision it defends |
|---|---|---|
| `C1 constraint definition wraps the total source-to-subject CASE in IS TRUE` | C1 ships without `IS TRUE`. All seven current lanes work, while the source CHECK prevents any eighth lane from reaching C1, so all behavioral tests pass. Assert `pg_get_constraintdef` structurally. | C1 fall-through must evaluate false, not NULL. |
| `all seven refusal sources admit only their locked subject_type mapping` | One untested arm is swapped, e.g. `ask_withheld → response`, while the single mismatch fixture exercises another lane. | C1’s complete seven-lane mapping. |
| `canonical valid rows for every refusal lane satisfy C1-C5` | An over-restrictive named constraint rejects a valid lane. Rejection-only tests can remain green. | CHECKs must admit every valid locked row, not merely reject selected invalid rows. |
| `C5 rejects policy_gate_held when all_refusal_codes contains NULL and omits refusal_code` | `refusal_code='winner'`, `all_refusal_codes=ARRAY['different', NULL]::text[]`. `refusal_code = ANY(...)` becomes NULL, the entire CHECK becomes NULL, and PostgreSQL accepts it. | C5 requires the winner to be present. The locked C5 expression itself needs NULL-safe handling. |
| `C5 admits valid future companion codes without a database enum-member CHECK` | An implementation adds a second authority over `AutoApprovalBlockReason`, or rejects every policy row. Example valid state: winner present alongside a future code. | Array members are deliberately TypeScript-owned. |
| `migration 116 creates exactly the locked twelve-column type, nullability, primary-key and default contract` | Examples: DB-generated `id`; nullable `occurred_at`; missing `created_at DEFAULT now()`; nullable `vocabulary_version`; added `origin`; wrong timestamp or array type. Explicit-value fixtures can still pass. | Exact twelve-column locked row shape. |
| `migration 116 creates only account_id and business_id foreign keys with NO ACTION and leaves subject_id unreferenced` | `business_id ON DELETE CASCADE`, `account_id ON DELETE SET NULL`, or `subject_id REFERENCES responses`. Tests using live parents never exercise deletion. | Only two FKs, neither with a referential action; `subject_id` stays a bare UUID. |
| `migration 116 defines the exact four-member subject_type CHECK` | The standalone subject-type CHECK is missing or admits an unknown member; current C1 arms still reject ordinary bad fixtures. | Closed subject vocabulary. |
| `the three refusal_events indexes have their exact keys, ordering, uniqueness and predicates` | Presence-only `pg_indexes` assertions accept wrong states such as archival `(id, occurred_at)`, account-window `(occurred_at, account_id)`, missing `DESC`, or a non-partial/non-unique subject index. | All three locked index definitions. |
| `the targeted ON CONFLICT clause infers refusal_events_subject_uniq` | Execute `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING`. Bare `ON CONFLICT DO NOTHING` never proves partial-index inference. | Slice 2 must infer the byte-for-byte predicate. |
| `subject uniqueness is global by source-subject pair and permits the same subject under another source` | An index incorrectly includes `account_id`, or indexes only `subject_id`. A single-account same-source duplicate test misses both errors. | Global composite uniqueness on exactly `(refusal_source, subject_id)`. |
| `purge verification counts target account-wide rows and ignores another account` | Unscoped verification counts another tenant’s row, or business-scoped verification misses a target row with `business_id=NULL`. | `must_be_absent` verification is account-scoped. |
| `content purge deletes account-wide refusal rows and preserves another account’s account-wide rows` | A purge implemented through a business/location join passes business-bound fixtures but leaves `autonomy_suspended` rows behind. | Purge must actually execute account-scoped hard deletion. |
| `TENANT_TABLES classifies refusal_events with account_id and business_id` | Registry entry is absent or lists only one scope column. None of the 13 titles names this registry. | Forced tenant-table registry row. |
| `migration 116 carries table and all twelve column comments including both retention-clock comments` | Comments are absent or claim `created_at` is sweepable. Runtime behavior remains green. | Database-local vocabulary and `occurred_at` as the sole retention clock. |
| `migration 116 is one transaction with SET LOCAL lock_timeout = '10s'` | Migration autocommits statements or omits the timeout; a clean rebuilt database passes despite unsafe partial-application behavior. | Atomic, bounded-lock migration execution. |
| `slice 1 adds no refusal_events writer or owner read path` | An accidental `INSERT` or owner-facing read lands in this slice without affecting any schema or purge test. | The slice boundary: schema, registries, purge, and vocabulary only. |

The existing RLS title is sufficient only if it independently asserts both `pg_class.relrowsecurity = true` and zero `pg_policies` rows. Title 11 covers the classification triple, and title 13 covers deletion and tenant isolation only if it uses `business_id=NULL` account-wide fixtures.

## CITED-ARTIFACT CHECK:

Audit basis: HEAD `54762148`. The plan itself is untracked; the intake is tracked.

| Citation | Resolved yes/no |
|---|---|
| `docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md` | **NO at HEAD; YES on disk** — untracked artifact |
| `docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json` | **YES** |
| `supabase/migrations/` | **YES** |
| `supabase/migrations/116_refusal_events.sql` | **NO** — planned new file |
| `scripts/ci/tenant-tables.ts` / `TENANT_TABLES` | **YES** |
| `scripts/ci/tenant-tables.ts:158` as the `solicitation_batches` precedent | **NO** — stale; the entry is at line 154, while line 158 is `solicitation_suppressions` |
| `scripts/ci/__tests__/tenant-tables.integration.test.ts` | **YES** |
| `scripts/ci/live-db-suites-audit.ts` / `MIGRATION_SHAPE_FILES` | **YES** |
| `scripts/ci/tenant-scope-allowlist.ts` | **YES** |
| `src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts` | **YES** |
| Planned `migration-116-refusal-events.integration.test.ts` | **NO** — planned new file |
| `describeWithDb`, `acquireLiveDbLock`, `LIVE_DB_LOCK_HOOK_TIMEOUT_MS` | **YES** |
| `assertSchemaReady`, `SchemaRequirement` | **YES** |
| `seedTenantAccount`, `seedLocation`, `cleanupTenantAccount` | **YES** |
| `supabase/migrations/114_solicitation_attribution.sql` precedent | **YES** |
| `supabase/migrations/111_platform_halt_reason.sql` precedent | **YES** |
| “110’s reasoning” (`110_solicitation_send_governors.sql`) | **YES** |
| “112’s precedent” (`112_breaker_window_indexes.sql`) | **YES** |
| “098’s exact shape” (`098_solicitation_suppression_corrections.sql`) | **YES** |
| `src/lib/account-offboarding/table-disposition.ts` | **YES** |
| `table-disposition.ts:361-366` | **YES** |
| `accountLinkedTablesFromMigrations()` | **YES** |
| `src/lib/account-offboarding/__tests__/table-disposition.test.ts` and cited test title | **YES** |
| `src/lib/account-offboarding/purge-verification.ts` / `verificationQuery` | **YES** |
| `purge-verification.ts:620-633` | **YES** |
| `verifyAccountOffboardingPurge` | **YES** |
| `src/lib/account-offboarding/__tests__/purge-verification.test.ts` and both cited titles | **YES** |
| `worker/jobs/account-offboarding/purge-stages.ts` / `runContentPurgeStage` | **YES** |
| `markPurgeRetryableFailure` | **YES** |
| `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts` | **YES** |
| Lifecycle references `:1207` and `:1283` | **YES** — both are `runContentPurgeStage` calls |
| `.claude/reference/migrations-log.md` | **YES** |
| `Current head`, `LOCAL-ONLY`, and `Data retention policy` sections | **YES** |
| Migration-log 111 and 114 entries | **YES** |
| `CONTEXT.md` | **YES** |
| `CONTEXT.md` → `## Refusal Log` at HEAD | **NO** |
| Local branch `feat/refusal-log` | **YES** |
| `feat/refusal-log:CONTEXT.md` → `## Refusal Log` and four terms | **YES** |
| `docs/adr/0023-refusal-log-owner-safe-projection.md` at HEAD | **NO** — planned carry/new file |
| `feat/refusal-log:docs/adr/0023-refusal-log-owner-safe-projection.md` | **YES** |
| `docs/adr/0021-ask-withdrawal-is-restraint-not-reapproval.md` | **YES** |
| `docs/directory.md` | **YES** |
| `scripts/verify-gate.sh` | **YES** |
| `new-migration` skill and its retention/lockstep requirements | **YES** |
| `ArchivalPoller` | **YES** |
| `attachJobFailureSink` | **YES** |
| `AutoApprovalBlockReason` | **YES** |
| `src/lib/refusals/vocabulary.ts` | **NO** — explicitly future/out of scope |
| `REFUSAL_LEDGER_ENABLED` | **NO** — explicitly future |
| GitHub issues `#994–#1004`, `#1008–#1014` | **NO on disk** — external citations; issue #1001 was separately accessible through GitHub |
| `docs/superpowers/plans/**` and `docs/reviews/**` roots | **YES** |

## PLAN FINDINGS:

| Severity | Location | Finding |
|---|---|---|
| **CRITICAL** | [plan:59](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:59) | The promised C1 fall-through insert cannot be constructed without changing the source CHECK at runtime, which the plan expressly forbids. A naive C1 without `IS TRUE` can pass the eval. |
| **CRITICAL** | [intake C5 case](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:38) | The locked C5 expression itself admits `ARRAY['different', NULL]` when the winner is absent because the CHECK evaluates NULL. The eval lacks this row. |
| **CRITICAL** | [plan:189](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:189) | The merge-before-promotion window contradicts the repository’s worker/migration staging workflow. The claimed automatic recovery is also false: purge jobs receive three short retries and then [mark the purge and outbox terminally failed](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/worker/jobs/account-offboarding/PurgeWorker.ts:96). A later migration promotion does not automatically clear that state. |
| **MAJOR** | [Task 2](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:139) | Adding `refusal_events` to `TENANT_TABLES` forces a `docs/security/rls-inventory.md` row: the existing RLS audit loops over every tenant table and requires its documentation entry. That file is absent from the task and allowed edit surface. |
| **MAJOR** | [plan:90](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:90) | Contrary to the supplied context, the plan does not reproduce the locked DDL: it omits the twelve column definitions and the actual C1–C5 expressions. Implementing Task 1 still requires the external issue. |
| **MAJOR** | [plan:166](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:166) | The required disposition rationale says the table’s “only FK is to accounts,” contradicting the locked schema’s FKs to both `accounts` and `businesses`. The reason should explain that neither retained parent cascades. |
| **MINOR** | [plan:147](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:147) | The cited `tenant-tables.ts:158` precedent is stale; `solicitation_batches` is at HEAD line 154. |

Numbered reasons for revision:

1. C1’s defining NULL-safety property is not executable by the proposed behavioral test.
2. C5’s locked expression and eval both miss a real PostgreSQL NULL fall-through.
3. Partial-index inference is not proven by bare `ON CONFLICT DO NOTHING`.
4. Deployment ordering can terminally fail account purges rather than self-heal.
5. The forced RLS-inventory update and several locked schema properties are absent from scope/eval.

VERDICT: REVISE

===== MSG BREAK =====

Gate intentionally not run: this was a read-only plan review, the plan is unimplemented, and `scripts/verify-gate.sh` may modify test/build artifacts. The evidence came from HEAD source inspection, not completion claims.