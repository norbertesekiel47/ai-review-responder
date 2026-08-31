| # | severity | file:line | finding | fix |
|---|---|---|---|---|
| 1 | high | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:279` | **MISSING FAILING TEST — “none of #1009’s nineteen promised tests remains `.todo` or `.skip`.”** T1 explicitly permits `.todo`; the promised-tests gate only greps titles, so the final gate can pass with every promised case inert. | Add the meta-test and require T1’s stubs to be converted before any task is complete. |
| 2 | medium | `.feature/intake.json:103` | The locked claim that every ledger CHECK failure reaches Sentry through `attachJobFailureSink` is false for Governor-triggered suspensions: `AutonomyGovernorScheduler` catches the rejection and only logs it. **MISSING FAILING TEST — “a refusal-ledger failure during a Governor suspension reports a Sentry issue and continues later accounts.”** | Add an explicit Sentry sink for this scheduler path, amend the edit surface, and test it. |
| 3 | medium | `.feature/intake.json:25` | **MISSING FAILING TEST — “WriteRefusalEventInput requires occurredAt and rejects an omitted value at compile time.”** Tests 11–12 always supply the field, so an optional `occurredAt?: …` defaulting to `NOW()` passes all nineteen titles. | Add a compile-time assertion, such as `@ts-expect-error`, against omission. |
| 4 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:235` | **MISSING FAILING TEST — “writeRefusalEvent observes false→true→false REFUSAL_LEDGER_ENABLED changes within one process.”** Test 6 exercises only a continuously false flag; a module-construction cache passes it. | Toggle the environment around three calls without resetting modules and assert write/no-write/write behavior. |
| 5 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:457` | **MISSING FAILING TEST — “the refusal_events arm uses occurred_at even when created_at gives the opposite retention answer.”** Test 17 can pass with a `created_at` sweep if its fixtures age both timestamps together. | Seed crossed-clock rows: old `occurred_at`/fresh `created_at` must delete; fresh `occurred_at`/old `created_at` must remain. |
| 6 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:462` | **MISSING FAILING TEST — “the refusal_events tenant-scope allowlist sqlSnippet equals the ArchivalPoller statement after normalization.”** None of the nineteen titles mentions the allowlist, so its text can drift from emitted SQL while T1 passes. | Add a source/CI test comparing the allowlist snippet with the emitted statement, following the exact audit normalization. |
| 7 | medium | `supabase/migrations/116_refusal_events.sql:48` | The immutable migration says both “No writer may pass `NOW()`” and “Never `NOW()` inside the insert,” while T3 requires the helper to emit unparameterized `NOW()` for `transaction_time`. The plan’s claim that the migration is “already correct” is therefore false. | Keep the applied migration untouched, but explicitly record that these sentences are superseded for transaction-time lanes and sweep the living documentation for the corrected rule. |
| 8 | medium | `.feature/intake.json:39` | **MISSING FAILING TEST — “a writeRefusalEvent rejection rolls back the suspension policy, audit row and notice outbox rows and rejects the caller.”** All planned suspension tests use valid ledger input, so a catch-and-swallow implementation—or an out-of-transaction write—can pass. | Inject a rejecting ledger writer or induce a named CHECK violation and assert rejection plus zero committed side effects. |
| 9 | medium | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:239` | **MISSING FAILING TEST — “a throwing Sentry capture does not change kill-switch-off suspension behavior.”** The cited circuit-breaker precedent catches telemetry failures, but the plan does not require that guard. A throwing warning can abort the suspension while the ledger is disabled, contradicting “byte-identical” behavior. | Wrap warning emission in `try/catch` and make test 15 include a throwing Sentry mock. |
| 10 | low | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md:55` | The D16 sweep is not a complete inventory. It omits quoted copies in `docs/reviews/feat-1008-migration-116-refusal-events/standards.md:214,374-377` and `triage.md:44`. They are historical and should remain untouched, but the table claims completeness. | Add both as explicit **DO NOT TOUCH — historical review record** entries. |

### 1. `.todo` permits a fully inert eval

The plan says unbuildable tests may use `.todo`. The gate at `scripts/verify-gate.sh:451-475` checks only that each title appears in a test file; it does not reject `.todo` or `.skip`.

This is a known repository failure mode. `src/lib/moderation/__tests__/held-draft.test.ts:129-147` adds a dedicated test because the gate accepts todos, and `src/lib/kpi/__tests__/fragments.test.ts:7-10` calls a surviving todo review-blocking. Without the proposed meta-test, T1 can be nominally complete and the final suite green with no assertions executing.

### 2. Governor failures do not reach `attachJobFailureSink`

There are two production suspension callers. Judge runs inside a BullMQ worker, but `worker/background/schedulers/AutonomyGovernorScheduler.ts:85-99` catches each candidate failure and emits only `logger.error`.

`attachJobFailureSink` is attached exclusively to BullMQ workers in `worker/index.ts:537-545`. The scheduler is not one, so `.feature/intake.json:103` overclaims Sentry coverage. This is the concrete path where a ledger CHECK failure rolls back a real suspension without the promised issue.

### 3. Required `occurredAt` is not type-tested

The plan correctly identifies optionality as dangerous at lines 212–217, but tests 11 and 12 exercise only runtime values. This wrong interface passes:

```ts
occurredAt?: Date | 'transaction_time';
```

If the helper defaults omission to transaction time, every planned runtime test remains green while later LLM-round-trip lanes can silently record persist time.

### 4. The live flag requirement is untested

Test 6 proves only the literal string `false` disables a call. It does not distinguish:

```ts
const enabled = readFlagEnabledByDefault(...); // wrong: construction-time cache
```

from a per-call read. The locked edge case explicitly requires a mid-process toggle at `.feature/intake.json:36`, so it needs its own test.

### 5. The archival clock can be wrong while test 17 passes

Migration 116 makes `occurred_at` the sole retention clock and explicitly rejects `created_at` at `supabase/migrations/116_refusal_events.sql:197-200`. The existing archival integration precedent warns that a constant fixture dimension cannot kill a narrowed predicate.

A simple old-row/fresh-row pair commonly ages all timestamps together. Such fixtures return the same result under both clocks. Crossed timestamps are required to make `created_at` observably wrong.

### 6. The allowlist is outside the nineteen-test net

The allowlist precedents contain hand-maintained normalized SQL strings, for example `scripts/ci/tenant-scope-allowlist.ts:958-968`. Plan T5 requires a new exact copy but maps tests 17–19 only to archival behavior, ordering, logging, and saturation.

The broader `ci:tenant-scope` audit may catch some mismatch during the full gate, but the requested T1 eval can pass with this invariant wrong. A dedicated title also prevents later refactors from weakening that coupling unnoticed.

### 7. The cited migration contradicts the writer design

Migration 116 states:

- `supabase/migrations/116_refusal_events.sql:48-50`: no writer may pass `NOW()`.
- `supabase/migrations/116_refusal_events.sql:197-198`: never use `NOW()` inside the insert.

Plan T3 requires exactly that at `plan.md:382-383`. The transaction-time decision itself is supported by issue [#1009](https://github.com/RepWorth/ai-review-responder/issues/1009), so the implementation direction is defensible; the defect is claiming the immutable artifact remains wholly correct without recording this supersession.

### 8. No test pins failure atomicity

The locked intake requires a CHECK violation to abort the deciding transaction. Yet tests 13–16 cover only successful writing, disabled writing, and already-suspended behavior.

A helper that catches insert errors and returns produces a suspended policy, audit row, and notices without a Refusal and passes those cases. Conversely, a helper that ignores the supplied transaction can commit a ledger row independently. A forced-rejection rollback test distinguishes both from the intended atomic behavior.

### 9. Telemetry can poison the disabled path

The named Sentry precedent catches telemetry exceptions at `src/lib/llm/circuit-breaker.ts:186-206`. Plan §2.3 says only “emit” a warning, while test 7 merely counts ordinary capture calls.

If `captureMessage` throws, an unguarded implementation rejects before returning, breaking `.feature/intake.json:19`’s guarantee that suspension, audit, and notification behavior remain unchanged when the kill switch is off.

### 10. D16 sweep omissions

The sweep’s named phrases do exist in every listed file. Its four excluded artifact classes also exist, and “do not touch” is appropriate:

- Migration 116 is applied and immutable.
- The #1008 intake mirror preserves a closed contract.
- The #1008 plan is a closed run record.
- Red-team findings are historical evidence.

However, the standards report and its triage also reproduce the disputed eleven-versus-ten claim. They should remain historical, but completeness requires listing them.

### Verified cited artifacts and covered attacks

- Migration 116 contains all five named constraints C1–C5, `idx_refusal_events_archival`, `idx_refusal_events_account_window`, and `refusal_events_subject_uniq` with exact predicate `WHERE subject_id IS NOT NULL`.
- Live introspection of both Supabase projects—`RepWorth` and `RepWorth-staging`—found `refusal_events`, all five named constraints, the archival index, and the partial unique index. The staging-and-production promotion claim is verified.
- `AGENT_SPINE_RETENTION_DAYS`, `BODY_RETENTION_DAYS`, `RESTRAINT_POLICY_VERSION`, `readFlagEnabledByDefault`, `AutonomySuspensionTrigger`, and `writeAccountAuditLog` all exist at HEAD.
- Migration 034 gives `account_audit_log.created_at` `DEFAULT NOW()` at `supabase/migrations/034_multi_location_schema.sql:69`.
- The shipped #1008 suite does cover all five CHECKs, C1’s structural fall-through, actual partial-index inference, duplicate-subject idempotency, and multiple NULL-subject suspension rows.
- D16’s substantive settlement is supported: [issue #1004](https://github.com/RepWorth/ai-review-responder/issues/1004) records the exact slice order, and [issue #1009](https://github.com/RepWorth/ai-review-responder/issues/1009) §5 assigns the first `autonomy_suspended` caller here.
- Failure mode 1 is covered by tests 8+9: the helper’s emitted clause is inspected and exercised against real PostgreSQL inside a committing transaction.
- Failure modes 2–3 are substantially covered by tests 11, 13, and 14, subject to the required-field gap above.
- Failure mode 5 is covered by test 7 for continuously-disabled calls: zero warnings and per-decision warnings both fail.
- Failure mode 6’s ordering half is covered by test 18; its wrong-clock half is not.
- Failure mode 8 is covered by migration-parsing vocabulary tests 1–3.
- Failure mode 10 is caught indirectly: serializing `null` as `'{}'` for `autonomy_suspended` violates C5 and prevents tests 13–14 from completing.

### Low confidence

None.

VERDICT: REVISE