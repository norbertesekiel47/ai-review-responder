# Deviations — feat-898-solicitation-send-governors

Every entry here is, by definition, something the plan did not anticipate — the
highest-signal bug source on the branch. Step 6 reads this file end to end before
any review agent is dispatched and logs a one-line **ACCEPT** or **RE-PLAN** verdict
against each entry.

**Subagents: append, never rewrite.** One entry per surprise, using the template
below. Do not dump context into the orchestrator instead — this file is where an
unanticipated fact goes.

```
## <task id> — <one-line title>

**Found:** what the plan said, and what the code/schema/tooling actually is.
**Did:** the adaptation made, with the exact file and symbol.
**Blast radius:** what else this touches, or "none".
**Invalidates a locked decision?** yes/no — if yes, STOP and report; abort criteria apply.

**Verdict:** _(template — not a real entry)_
```

Two branches the plan deliberately left open, because they cannot be resolved without
running a command. Neither is a placeholder; each states its check and both outcomes.
**Record the outcome here either way** — including "checked, no change needed", so a
resumed session does not re-investigate:

- **T2 step 5** — whether `TABLE_DISPOSITIONS` is exhaustive over the live schema. If it
  is, `solicitation_send_breaker` needs a `not_applicable` entry in
  `src/lib/account-offboarding/table-disposition.ts`, which is **outside**
  `allowed_edit_surface` and needs a surface amendment first.
- **T5 step 2** — the repo's UUIDv7 helper path. If none exists, use `randomUUID()` from
  `node:crypto` (invariant #10). **Do not add a dependency**: that needs
  `.feature/deps-justification.md` plus `package.json` and `pnpm-lock.yaml` in the edit
  surface, none of which this feature has.

## Surface amendment log

Only `allowed_edit_surface` changes count toward the 2-amendment abort budget.
`tests_to_add` retitles and `verification_commands` corrections are ordinary entries above.

| # | Date | Change | Auto-approved or owner sign-off |
|---|---|---|---|
| 1 | 2026-08-19 | +`src/lib/shared/__tests__/helpers/schema-ready.ts` | owner sign-off |
| 2 | 2026-08-19 | +`src/components/admin/nav-config.ts` | owner sign-off (abort criterion waived) |
| 3 | 2026-08-19 | +`docs/.../2026-07-28-send-mode-cross-spec-amendments.md` | owner directed round-1 fix-all; step 0 re-run performed |

## plan round 1 — codex unavailable; orchestrator ran the review

**Found:** Three `codex exec` attempts failed to deliver a verdict — the first hit the
10-minute foreground cap mid-turn (thread `01a01908-f132-7f70-8a67-b83731ff035a`), the
second stalled at 141 lines with no progress for 2+ minutes, the third emitted zero
lines in 3 minutes (stderr showed repeated
`codex_models_manager: failed to renew cache TTL: missing field base_instructions`).
The codex CLI is wedged in this environment, not merely slow.

**Did:** Ran round 1 myself, split in two.
 (a) Cited-artifact check — mechanical, done by grep: all 19 symbols, 7 precedent
     files, both runbooks (§5/§6/§7 at lines 207/243/280) and 091's
     one_live_per_ask + daily_send_cap resolve. **One defect found and fixed**: the
     plan cited a non-existent `@/lib/shared/uuid`; the repo uses
     `import { v7 as uuidv7 } from 'uuid'` (audit/log.ts, notifications/delivery.ts).
     The plan's own fallback to `randomUUID()` was also wrong — that is UUIDv4, which
     breaks the time-ordered-PK convention. T5 step 2's branch is now closed.
 (b) Eval-first critique — can the 27 tests pass while the feature is wrong? Four
     probes held (LEAST semantics vs `() => 10`; MIN_SENDS boundary; asymmetric vs
     cohort window; ON CONFLICT inference, which the idempotence test de-risks).
     **Three holes found**, all closed by new tests:
       1. classifyBreach precedence was unobservable — no test breached both
          thresholds at once, so a reversed implementation passed everything.
       2. countAccountDispatchAttemptsToday never proved it filters on account_id —
          the fixture had one tenant, so dropping the filter changed nothing.
       3. resolvePlatformDailyCap never exercised the unsafe-integer branch.

**Blast radius:** `tests_to_add` 27 → 30 in BOTH intake copies (verified identical);
`estimated_test_lines` 1300 → 1400. Per the workflow this is a deviations entry, NOT a
surface amendment — the amendment budget is untouched at 0 of 2.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT (self-triaged at step 3; re-confirm at step 6).

## T1 — `schema-ready.ts` is outside `allowed_edit_surface`; the constant could NOT be added

**Found:** Both the plan (File structure table, Task 2 step 3) and the Task 1 brief say
`src/lib/shared/__tests__/helpers/schema-ready.ts` is modified to export
`MIGRATION_110_SEND_GOVERNORS`. `.feature/intake.json`'s `allowed_edit_surface` does not
list that path (nor does the audit copy — the two are byte-identical), so
`.claude/hooks/edit-surface-guard.sh` BLOCKED the edit.
**Did:** Left the constant unwritten. The three live-DB suites still import it by name, as
instructed. Consequence: `migration-110-send-governors.integration.test.ts` fails in
`beforeAll` with `TypeError: Cannot read properties of undefined (reading 'tables')` from
`assertSchemaReady` (the named import resolves to `undefined`) instead of the intended,
actionable `test database is behind head — 110_solicitation_send_governors` message. The
other two suites fail earlier still, on `Cannot find module '../send-breaker'` /
`'../send-caps'`, so for them nothing is lost.
**Blast radius:** Task 2 step 3 hits the identical wall. Fix is one surface entry —
`"src/lib/shared/__tests__/helpers/schema-ready.ts"` — added to `allowed_edit_surface`
in `.feature/intake.json` WITH user sign-off, then the constant is a 6-line paste from
Task 2 step 3.
**Invalidates a locked decision?** no — it is a surface gap, not a design change.

**Verdict:** ACCEPT — closed by surface amendment 1 of 2 (owner sign-off). Refusing to work around the guard was the correct call.

## T1 — `pnpm typecheck` cannot pass at the end of the eval task

**Found:** The Task 1 brief requires `pnpm typecheck` to pass. `tsconfig.json` includes
`**/*.ts`, so the eval suites are typechecked — and Task 1 is defined by importing five
modules and two exports that do not exist yet ("write ZERO implementation code").
**Did:** Ran it anyway and confirmed the ONLY errors are those nine intended references
(5 × TS2307 missing module, 2 × TS2305 missing export, across 7 files). No incidental type
error remains in any fixture. That is the strongest signal available at this task.
**Blast radius:** none once T2/T4/T5/T6/T7 land; typecheck goes green by construction.
**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — structural, not a defect. The eval task's whole purpose is code that does not exist yet; the 9 errors were verified to be exactly the intended missing-module/missing-export set.

## T1 — plan snippets used three helper signatures that do not exist

**Found:** Task 1's code blocks call `acquireLiveDbLock(sql)`, `assertSchemaReady(sql,
MIGRATION_110_SEND_GOVERNORS)`, and `postgres(url, { …, statement_timeout: 30_000 })`.
The real signatures are `acquireLiveDbLock(databaseUrl: string)`,
`assertSchemaReady(db, readonly SchemaRequirement[])`, and postgres.js takes
`statement_timeout` under `connection`, not at the top level (`live-db-lock.ts` is the
precedent for all three).
**Did:** Used the real signatures in all three live-DB suites. The lock is acquired from
`resolveTestDatabaseUrl()`'s string, requirements are passed as an array, and the timeout
moved to `connection: { statement_timeout: 30_000 }`.
**Blast radius:** none — the suites' behaviour is what the plan described.
**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — the committed tests are correct and the plan snippets were stale. Every downstream brief was told to trust the tests over the plan. My error, caught before it propagated.

## T1 — the second tenant cannot be seeded inside a probe transaction

**Found:** Task 1 step 6's snippet does `const other = await seedTenantAccount(tx)` inside
`sql.begin`. `seedTenantAccount` opens its own `db.begin(...)` for the deferred
`users` <-> `accounts` cycle, and postgres.js's `TransactionSql` extends `ISql`, not
`Sql` — it exposes `savepoint`, never `begin`. The call is both a type error and a runtime
`tx.begin is not a function`.
**Did:** `send-caps.integration.test.ts` seeds BOTH tenants (and both business →
upload → batch chains) in `beforeAll`, the pattern `suppression.integration.test.ts`
already uses for its `otherTenant`, and cleans both up in `afterAll`. Every probe write
still runs inside an always-rolled-back transaction.
**Blast radius:** none — the cross-account assertion is unchanged.
**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — postgres.js `TransactionSql` exposes `savepoint`, not `begin`, so seeding both tenants in `beforeAll` is the only shape available. Matches the suppression-suite precedent.

## T1 — reused the shared outreach fixture instead of writing a fourth local `insertOutreach`

**Found:** Task 1 step 2 says to write a local `insertOutreach` supplying every NOT NULL
column 091 declares. `src/lib/shared/__tests__/helpers/outreach-fixture.ts` already owns
exactly that (three suites use it; its module comment records that re-spelling the set by
hand cost three fixture edits for one new column in #624 S1).
**Did:** `migration-110-…` and `send-caps.integration` wrap it in a thin local helper that
seeds the fresh Ask + Contact each row needs and delegates the fifteen NOT NULL columns.
`send-breaker.integration.test.ts` still hand-writes its SQL, because its fixture is a
bulk `INSERT … SELECT … FROM generate_series` (100 and 1,000 rows) the shared single-row
helper cannot express; the three tables agree on ids via `md5(nonce || ':c:' || g)::uuid`.
**Blast radius:** none — no shared helper was created or modified.
**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — correct DRY call. A fourth local `insertOutreach` re-spelling 091's fifteen NOT NULL columns would have been the slop option.

## T1 — the `bounce_kind` projection turns 22 pre-existing lane tests red until 110 lands

**Found:** Task 1 step 9 requires extending the lane suite's local `readOutreach`
projection with `bounce_kind`. That projection is shared by most of the suite, so with
migration 110 unapplied every case reading it fails `column "bounce_kind" does not exist`.
**Did:** Made the change as instructed and confirmed the failure mode: the lane suite is
23 failed / 11 passed, and all 23 name that one missing column. Task 2 (the migration)
returns 22 of them to green and Task 3 turns the new one green.
**Blast radius:** any interim CI run on this branch between T1 and T2 shows the lane suite
red for a schema reason, not a logic one.
**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — transient by construction and resolved by T2 exactly as predicted (23 failed -> 1). Predicting the number in advance is what made it checkable.

## T1 — the lane already LOGS `bounce_kind`; it does not yet WRITE it

**Found:** `worker/ingress/resend/solicitation-lane.ts:301` already emits
`bounce_kind: isHard ? 'hard' : 'soft'` — but as a structured LOG field only. The column
is absent from `recordBounce`'s UPDATE.
**Did:** Nothing (Task 3's work is unchanged). Recorded so Task 3 does not read the log
line as "already done" and skip the UPDATE, and so it reuses that same `isHard` value
rather than reclassifying.
**Blast radius:** none.
**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — high-value trap. Carried into T3's brief verbatim; T3 confirmed the log field was indeed log-only.

## SURFACE AMENDMENT 1 of 2 — schema-ready.ts

**Found:** `src/lib/shared/__tests__/helpers/schema-ready.ts` was named in the plan's
File-structure table but omitted from `allowed_edit_surface`. Orchestrator error, not a
subagent one. The guard blocked T1 from adding `MIGRATION_110_SEND_GOVERNORS`; the
subagent stopped and reported rather than working around it, which is the correct
behaviour and is what the guard is for. T2 step 3 would have hit the identical wall.

**Did:** Added that one path to BOTH intake copies (verified byte-identical). NOT
auto-approved — the path sits outside every covered tree — so this went to the owner
and was signed off 2026-08-19. Chosen over declaring the requirement locally because
every MIGRATION_* constant in this repo lives in schema-ready.ts; a locally-declared
110 would be invisible to whoever writes 111.

**Blast radius:** one exported const. `TABLE_DISPOSITIONS` was checked at the same time
and needs NO entry — there is no live-schema exhaustiveness assertion, so the plan's
T2-step-5 branch resolves to "no change needed" and `table-disposition.ts` stays out of
the surface.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## T4 — `platform-cross-account` path rule did not admit `src/lib/solicitation/`

**Found:** The plan's Task 4 step 2 says "add one entry to
`scripts/ci/tenant-scope-allowlist.ts`". One entry is not sufficient: the audit also
enforces `CATEGORY_PATH_RULES`, and `platform-cross-account` was restricted to
`allowedPrefixes: ['src/lib/admin/']`. A bare entry for
`src/lib/solicitation/send-caps.ts` fails the per-category path invariant.

**Did:** Added the file to a new `allowedFiles` array on the `platform-cross-account`
rule (the same escape hatch `admin-after-require-role` and `background-global-scan`
already use for src/lib domain modules), with the justification that the ceiling is
read by the send path itself, not an admin surface, so it stays with its domain and
keeps explicit `Sql` injection (invariant #15). Also bumped `ALLOWLIST_BASELINE`
381 → 382 with a dated changelog comment, as the exact-match growth gate requires.
The alternative — categorising it `background-global-scan`, which already lists three
`src/lib/**` files — was rejected: that category means "scanning tenant rows globally
before enqueueing scoped work", and this statement projects one integer and enqueues
nothing.

**Blast radius:** `scripts/ci/tenant-scope-allowlist.ts` only. Task 5 adds two more
entries and must bump the baseline 382 → 384 from the value this task left.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — the `allowedFiles` escape hatch already existed for two other categories; extending it is the established pattern, not a new mechanism.

## T4 — `date_trunc` boundary is spelled one conversion shorter than the cited precedent

**Found:** The plan's module source (and the locked-semantics restatement) spells the
UTC day boundary `date_trunc('day', NOW() AT TIME ZONE 'UTC')`. The precedent the plan
names as the idiom to mirror, `worker/jobs/response-generation/auto-approval.ts:231`,
spells it `date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` — with a
trailing conversion back to `timestamptz`, and a unit test that asserts that exact text
(`auto-approval.test.ts:514`). Without the trailing conversion the boundary is a naive
`timestamp` that Postgres casts using the SESSION `TimeZone` when compared against the
`timestamptz` column; the two spellings agree only while the session is UTC. No repo
code pins `TimeZone` on the postgres.js clients (`src/lib/db/server.ts`), so the
guarantee rests on the server default being UTC (it is, on Supabase and on the local
`postgres:16` test container).

**Did:** Followed the plan verbatim — `src/lib/solicitation/send-caps.ts`,
`countAccountDispatchAttemptsToday` and `countPlatformDispatchAttemptsToday` both use
the short form, because the boundary expression is restated in the task's
locked-semantics list. Both live-DB cases pass, and they would pass under either
spelling on a UTC session, so the suite does not discriminate between them.

**Blast radius:** both counters in `send-caps.ts`. A non-UTC session `TimeZone` would
shift the cap's day boundary by the session offset — it would never fail loudly, it
would silently count the wrong day.

**Invalidates a locked decision?** no — but if the orchestrator prefers the precedent's
exact spelling, the change is two identical one-line edits and no test moves.

**Verdict:** ACCEPT — and SUPERSEDED by the orchestrator follow-up below, which restored the trailing `AT TIME ZONE 'UTC'`. Escalating instead of silently deviating is what surfaced a real bug no test could catch.

## T4 — `ci:directory-map` is red until Task 8 adds the `send-caps.ts` row

**Found:** `pnpm ci:directory-map` fails with
`src/lib/solicitation/send-caps.ts has no row in docs/directory.md`. The map is
CI-complete for `src/lib/`, so a new file under that root must ship its row in the same
PR. `docs/directory.md` is Task 8's file and is outside this task's edit surface.

**Did:** Nothing — deliberately left red rather than working around the edit-surface
guard. Task 8 must add a `send-caps.ts` row under the `src/lib/solicitation/` section
(alongside the `send-breaker.ts` row Task 5 will need).

**Blast radius:** the `lint` CI job fails until Task 8 lands. No runtime effect.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — resolved by T8; `ci:directory-map` passes. Leaving it red rather than editing outside surface was correct.

## T4 follow-up (orchestrator) — UTC-day boundary was a latent local-day bug

**Found:** The Task 4 subagent flagged that the plan's
`date_trunc('day', NOW() AT TIME ZONE 'UTC')` is one conversion SHORTER than the
precedent it cites (`worker/jobs/response-generation/auto-approval.ts:231`, which ends
with a second `AT TIME ZONE 'UTC'`). It implemented the plan verbatim and escalated
rather than deviating, because I had listed the expression under "locked semantics".
That was the correct call and the flag was right.

The short form yields a NAIVE timestamp. Comparing a `timestamptz` column against one
makes Postgres coerce it using the SESSION `TimeZone`, which nothing in this repo pins.
Whenever the session is not UTC, the "UTC day boundary" the account cap and platform
ceiling both depend on silently becomes a LOCAL day boundary — the cap resets at the
wrong hour, and B3's counting basis is wrong by up to a full day's sends.

**Why no test caught it:** the fixture seeds `queued_at` using the SAME expression, so
both the buggy and correct forms agree. A test written from the implementation cannot
falsify the implementation. This is the sharpest instance so far of why the eval task
is authored before the code.

**Did:** Added the trailing `AT TIME ZONE 'UTC'` to BOTH queries in
`src/lib/solicitation/send-caps.ts`, matching the precedent byte-for-byte, plus an
8-line comment stating why the trailing conversion is load-bearing so nobody "tidies"
it away. Updated the matching `sqlSnippet` in `scripts/ci/tenant-scope-allowlist.ts`.
`ci:tenant-scope` passes at 382/382; send-caps suites 7 passed.

**Blast radius:** two SQL lines + one allowlist snippet. No test moved, no interface
changed. Not a surface amendment — both files were already in surface.

**Invalidates a locked decision?** no — it RESTORES the locked one (#622 §4.3 / B3's
UTC day), which the plan's snippet had mis-transcribed.

**Verdict:** ACCEPT.

## T3 follow-up (orchestrator) — lane allowlist snippet needed the new column

**Found:** `ci:tenant-scope` went red the moment T3 added `bounce_kind` to
`recordBounce`'s UPDATE: the allowlist entry stores the statement text, so the changed
statement no longer matched and reported BOTH "unused allowlist entry" and "missing
account_id or business_id scope". T3's edit surface was `solicitation-lane.ts` only, so
it could not have fixed this — another surface gap I left, not a subagent error.

**Did:** Orchestrator updated the `sqlSnippet` at
`scripts/ci/tenant-scope-allowlist.ts` (already in surface) to include the new column,
and extended its `reason` to record that `bounce_kind` rides the SAME statement because
110's pairing CHECK requires it. `ci:tenant-scope` passes 382/382.

**Lesson for the remaining tasks:** any task that changes a SQL statement text must
also own the matching allowlist entry, or the two files must be dispatched together.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## T5 step 2 — pre-registered branch resolved: `uuid`'s v7, NOT `randomUUID()`

**Found:** The open branch above still says "If none exists, use `randomUUID()` from
`node:crypto`". Checked: the repo has no `src/lib/shared/uuid` helper, and every
app-supplied PK uses the `uuid` package directly (`src/lib/audit/log.ts:2`,
`src/lib/notifications/delivery.ts:1`). `uuid` is already a dependency, so no
`deps-justification.md` and no `package.json` surface amendment was needed. The plan
BODY (Task 5 step 2, corrected in plan round 1) already says exactly this; only the
bullet at the top of this file is stale.

**Did:** `import { v7 as uuidv7 } from 'uuid'` in
`src/lib/solicitation/send-breaker.ts`. `randomUUID()` was deliberately NOT used —
it is UUIDv4, which is random rather than time-ordered and breaks the time-ordered-PK
convention every table in `migrations-log.md` states. Invariant #10's "use node:crypto"
governs hashing, not id generation.

**Blast radius:** none. Recorded so a resumed session does not re-investigate.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — `uuid`'s v7 is the repo convention. `randomUUID()` would have been UUIDv4 and broken the time-ordered-PK convention; the stale bullet at the top of this file is superseded by this entry.

## T5 — `ON CONFLICT ((reset_at IS NULL))` inference: checked against Postgres, it works

**Found:** The plan flagged the expression-index conflict target as the riskiest line
on the branch and pre-authorised a `SELECT … FOR UPDATE` fallback if Postgres declined
to infer from it. Verified empirically against the local test database BEFORE writing
the module: two consecutive inserts inside one transaction, the second returning zero
rows and leaving exactly one open trip. Postgres infers
`solicitation_send_breaker_one_open` from `((reset_at IS NULL)) WHERE reset_at IS NULL`
with no error.

**Did:** Kept the plan's insert verbatim. No fallback, no index change. The
idempotence integration test now proves inference works on every run rather than only
in a one-off `psql` check.

**Blast radius:** none.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — the single riskiest line in the feature, verified against real Postgres BEFORE the module was written and again by the idempotence test. No fallback needed, index unchanged.

## T5 — `BreakerWindow` had to be a `type` alias, not an `interface`

**Found:** The plan's Task 5 source declares `export interface BreakerWindow`. That does
not compile: `sql.json(breakerWindow)` takes postgres.js's `JSONValue`, which requires a
string index signature, and TypeScript grants an implicit index signature to a type
alias of an object type but never to an interface. `tsc` reports
`Type 'BreakerWindow' is not assignable to parameter of type 'JSONValue'` at the insert
— a message that says nothing about JSONB.

**Did:** Declared `export type BreakerWindow = { … }` in
`src/lib/solicitation/send-breaker.ts` with a comment stating why, so nobody "tidies" it
back to an interface and rediscovers this. The alternative house pattern —
`tx.json(x as never)` (`src/lib/approval/audit.ts:192`, `src/lib/audit/log.ts:47`) —
was rejected: it launders a real type into `never` at the one boundary where the shape
of the stored snapshot matters, and `readSendBreaker` reads it straight back out as
`BreakerWindow`. `src/lib/reviews/import-consent.ts:706`'s `satisfies` idiom is the
same fix by another route.

**Blast radius:** the exported type's declaration form only. Every consumer sees the
identical structural shape.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — `sql.json`'s `JSONValue` needs an implicit index signature that an `interface` never gets. A real TypeScript constraint, not a preference.

## T5 — `HealthFinding` has exactly one owner, and it lives in `worker/`

**Found:** The plan has `evaluateSendBreaker` return `HealthFinding | null` and puts
`breakerFinding` in `src/lib/solicitation/send-breaker.ts`, but never says where the
type comes from. Its only declaration is
`worker/background/pollers/health-alert/checks.ts`, and no file under `src/lib/` has
ever imported from `worker/` — the dependency has always run the other way
(`checks.ts` imports `src/lib/shared/backlog-depth`, `src/lib/agents/read`).

**Did:** Imported it type-only:
`import type { HealthFinding } from '../../../worker/background/pollers/health-alert/checks'`.
`import type` is erased, so no runtime edge from `src/lib` into `worker/` is created and
the checks.ts↔send-breaker.ts cycle exists only in the type graph. Chose this over
restating the four-field shape locally because a duplicated interface is two owners of
one fact, and Task 6's `checkSolicitationSendBreaker` returning the value AS a
`HealthFinding` would then typecheck by coincidence rather than by identity. ESLint's
`PARENT_TRAVERSAL_BAN` already exempts paths containing `/worker/`; `pnpm typecheck` and
`eslint` on the file are both clean.

**Blast radius:** one type-only import. If a later ticket wants the layering strictly
one-way, the fix is to move `HealthFinding` into `src/lib/shared/`, not to duplicate it.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT WITH FLAG — no invariant is violated (invariant #1 explicitly permits `import type`), and the gate is green. But the dependency direction is inverted: `src/lib` has never imported from `worker/` before, and normally worker depends on lib. The deeper shape is `evaluateSendBreaker` returning a domain verdict with the worker check mapping it to a `HealthFinding`. That would change the test contract, so it is NOT a mid-flight edit. EXPLICITLY REFERRED to the step 7 standards & maintainability agent; if upheld it becomes a follow-up ticket for #900, which consumes this module anyway and may want the domain-verdict shape.

## T6 — the new check drains one entry from `checks.test.ts`'s positional sql queue (2 pre-existing tests RED; fix is outside T6's edit surface)

**Found:** Task 6's one-line wiring is correct and complete, but the plan does not
account for how `worker/background/pollers/health-alert/__tests__/checks.test.ts` mocks
`sql`. That suite's `mockSql` is a **positional queue** (`sqlReturnQueue`): every tagged
template call shifts the next pushed row off the front, and an exhausted queue yields
`[]`. Adding ANY check to `runHealthChecks` therefore consumes one more entry and
shifts every response after it by one. `checkSolicitationSendBreaker` sits immediately
before `checkBacklogDepth`, so the backlog check now receives the breaker's row (and
then `[]`), and two pre-existing tests go red:

- `backlog-depth threshold config > uses the 1500 default …` (helper
  `pushQuietChecksBeforeBacklog()`, ~line 350)
- `runHealthChecks > aggregates findings across all checks (env defaults)` (~line 420)

Both fail on the missing `backlog_depth:job_outbox` key — the backlog finding, not the
breaker, is what disappears. This is a mock-arity artifact, not a behaviour change: the
breaker itself reads `sends: undefined → 0`, falls under `BREAKER_MIN_SENDS`, and
correctly returns `null`.

**Did:** Nothing — `checks.test.ts` is outside T6's hook-enforced edit surface
(`checks.ts` + this file), so the agent stopped rather than reaching for it. The fix is
three pushes, one per `runHealthChecks` call site, inserted directly after each
`stalledSendBatches` push:

```typescript
sqlReturnQueue.push([{ sends: 0, hard_bounces: 0, complaints: 0 }]); // sendBreaker → null (under MIN_SENDS)
```

in `pushQuietChecksBeforeBacklog()`, in "aggregates findings across all checks", and in
"isolates a backlog-check failure" (that third one passes either way today — the queue
is already exhausted there — but its inline dispatch-order comment is now wrong without
it, and it would break the moment a later check is appended).

Rejected alternative: moving the `collect(await checkSolicitationSendBreaker(sql));`
line to AFTER the backlog `try/catch`, where the exhausted queue would hand it `[]` and
all three tests would pass untouched. That is passing the suite by exploiting a mock's
queue-exhaustion behaviour, it contradicts the plan's explicit placement, and it would
break again the next time a check is appended.

**Blast radius:** two RED tests in `checks.test.ts` until the pushes land. `pnpm lint`
is clean, `pnpm typecheck` is clean for `checks.ts` (the only error is T7's not-yet-
written `reset/route.ts`), and the two new `send-breaker-check.test.ts` tests are green.

**Invalidates a locked decision?** no — the #505 sequential list and the fail-loud
(no `try/catch`) placement are both preserved exactly as specified.

**Verdict:** ACCEPT — resolved by the orchestrator follow-up below. Rejecting the mock-exhaustion workaround was the right call: it would have passed three tests while putting the check in the wrong dispatch position.

## T6 follow-up (orchestrator) — positional mock queue in checks.test.ts

**Found:** Adding `checkSolicitationSendBreaker` to `runHealthChecks` turned 2
PRE-EXISTING tests in `worker/background/pollers/health-alert/__tests__/checks.test.ts`
red. That suite's `mockSql` is a POSITIONAL queue (`sqlReturnQueue`): each check consumes
the next entry, so inserting a check anywhere shifts every later response by one.
`checkBacklogDepth` began eating the breaker's row and its `backlog_depth:job_outbox`
finding vanished. Not a behaviour regression — the breaker read `sends: 0`, fell under
`BREAKER_MIN_SENDS` and correctly returned `null`.

The T6 subagent could not fix it: its edit surface was `checks.ts` only. It diagnosed the
cause, prescribed the exact fix, and — importantly — **rejected the tempting workaround**
of moving the `collect(...)` line below the backlog `try/catch`, where an exhausted queue
would have made all three tests pass with no edit. That "fix" would have passed by
exploiting mock exhaustion, put the check in the wrong dispatch position, and broken again
on the next appended check. Good call.

**Did:** Orchestrator applied the prescribed fix in
`worker/background/pollers/health-alert/__tests__/checks.test.ts` (already in surface):
three `sqlReturnQueue.push([{ sends: 0, hard_bounces: 0, complaints: 0 }])` entries
immediately after each `stalledSendBatches` push, plus a rewritten dispatch-order comment
that now names the breaker AND states the positional contract explicitly, so the next
person appending a check knows they must append an entry here too.

Health-alert directory: 82 passed / 2 failed → **84 passed / 0 failed**.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## T7 — the nav registry entry the new page needs is OUTSIDE the edit surface (1 test RED)

**Found:** `src/components/admin/__tests__/AdminSidebar.test.tsx` derives the admin IA
from the filesystem: it walks `src/app/admin/**/page.tsx` and asserts every non-auth
route appears exactly once in `ADMIN_NAV_GROUPS` ("lists every non-auth admin page
exactly once"). Creating `src/app/admin/solicitation/page.tsx` therefore requires a
matching entry in `src/components/admin/nav-config.ts`, which is not in T7's
hook-enforced edit surface (`src/app/api/admin/solicitation/**`,
`src/app/admin/solicitation/**`, this file). The plan's Task 7 does not mention it.

**Did:** Nothing — stopped rather than reaching outside the guard, and did not use the
`NON_NAV_PAGES` escape hatch (a hidden Safety page is not the intent). The fix is one
line under the existing `Safety` group, beside `/admin/autonomy`:

```typescript
{ href: '/admin/solicitation', label: 'Send breaker' },
```

**Blast radius:** exactly one test red —
`admin IA: nav ⇄ filesystem > lists every non-auth admin page exactly once`, reporting
`["/admin/solicitation"]`. The page itself builds, renders and is reachable by URL; it
is only absent from the sidebar. Nothing else in the suite, the audits or the build is
affected.

**Invalidates a locked decision?** no — it is a surface gap, not a design change.

**Verdict:** ACCEPT — closed by surface amendment 2 of 2 (owner sign-off, abort criterion waived). Stopping at the guard was correct.

## T7 — a GET route was needed for "refetch on success"; the plan lists only the reset route

**Found:** Task 7 specifies three files and no read endpoint, yet it also requires the
panel to "refetch on success", to "copy `AutonomySuspensionsClient.tsx`'s fetch/error/
pending shape" (which is `useQuery` + `useMutation`), and to ISO-stringify the page's
dates so `initialData` is "structurally identical to **a client refetch**". Those three
sentences presuppose a GET the client can call; none existed.

**Did:** Added `src/app/api/admin/solicitation/breaker/route.ts` — a `GET` that gates
with `requireAdminWithAal2` (matching the reset route it sits beside), calls
`readSendBreaker(sql)` and returns `{ open, trip }` with `trippedAt` as an ISO string.
Inside the allowed edit surface (`src/app/api/admin/solicitation/breaker/**`), so no
amendment was needed. `page.tsx` builds byte-identical `initialData` inline, the same
way `/admin/autonomy`'s page does.

Rejected alternative: `router.refresh()` instead of a query. It would have avoided the
extra file, but it drops the precedent's non-blanking error/stale-data behaviour and
makes the plan's own "structurally identical to a client refetch" sentence meaningless.

**Blast radius:** one new read-only route. `ci:admin-aal2`'s ROUTE contract covers
mutation verbs only, so the GET is unaffected by it; its P2 page-parity anchor is
`src/app/api/admin/solicitation/route.ts`, which still does not exist, so the page is
checked by P1 only (and passes `aal2: true` regardless).

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — see the orchestrator entry below; verified `requireAdminWithAal2`-gated so the read is not a weaker door onto the same state.

## T7 — the brief calls /admin/solicitation a Console surface; the brand skill routes admin to Island

**Found:** Both the plan's Task 7 step 1 and the task brief say "This is a **Console**-
system surface". The `repworth-brand-design` router says the opposite, in a dedicated
sentence: "Admin renders **outside** `.rw-console` and consumes **no** Console tokens —
it is an Island-palette surface, just more utilitarian" (`docs/design/README.md:26-28`
says the same). `console-admin-palette.test.ts` enforces that split, and the cited
precedent `AutonomySuspensionsClient.tsx` uses the admin console's neutral vocabulary,
not `--rw-app-*`.

**Did:** Built on the admin primitives — `AdminPage`, `StatTile` (its `alert` variant is
literally "red-border variant for breached thresholds"), `EmptyState`/`ErrorState`/
`TableSkeleton`, `formatAdminDateTime`/`formatAdminCount`, `LiveRegion` — with the
admin neutral palette. No Console token is referenced. Verified the two structural
guards the palette test derives from the filesystem: `page.tsx` carries no `className`
(so CF-4 does not oblige a `SWEPT_FILES` entry, which is outside the edit surface), and
neither new component uses amber/orange/stone/blue/indigo.

**Blast radius:** none. Had the brief's Console reading been followed, the page would
have imported tokens that do not resolve outside `.rw-console`.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT — my briefing error, not a code error. See the orchestrator entry below. Following the design docs over my instruction was correct.

## SURFACE AMENDMENT 2 of 2 — nav-config.ts (abort criterion waived by owner)

**Found:** `src/components/admin/__tests__/AdminSidebar.test.tsx` walks the filesystem and
requires every non-auth admin page to appear exactly once in `ADMIN_NAV_GROUPS`. The new
`/admin/solicitation` page therefore needs a row in `src/components/admin/nav-config.ts`,
which the intake never listed. T7 hit the guard and stopped rather than working around it.

**Did:** Added `{ href: '/admin/solicitation', label: 'Send breaker' }` to the Safety group,
between Suppressions and Security. `AdminSidebar.test.tsx` 8/8.

**Abort criteria:** this is the SECOND surface amendment, which the workflow treats as a
trigger to tear the branch down and restart at step 1. Surfaced to the owner with both
positions; **owner waived it 2026-08-19** on the argument that the criterion exists to catch
SCOPE SPRAWL and neither amendment is that — both are one-line registry entries
(`schema-ready.ts`, `nav-config.ts`) for files the feature always had to touch and my plan
simply failed to enumerate. Production diff, test diff and task count all still track the
intake estimate.

**Budget now EXHAUSTED.** A third surface amendment must re-run step 0 rather than ask again.

**Lesson for the next intake:** every new admin PAGE implies a nav-config row, and every new
MIGRATION implies a schema-ready requirement. Both are filesystem-walked by tests, so both
belong in `allowed_edit_surface` from the start. Promote to lab-notes at step 8.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## T7 (orchestrator) — my brief said Console; the design docs say Island

**Found:** My T7 brief called `/admin/solicitation` a **Console**-system surface. The
`repworth-brand-design` router and `docs/design/README.md` route admin to **Island**
("consumes no Console tokens"), and `console-admin-palette.test.ts` ENFORCES it. The
subagent followed the design docs over my brief, built on the admin primitives with no
Console token, and flagged the contradiction instead of silently picking one.

**Verified:** `console-admin-palette.test.ts` passes (114/115 at the time; the single
failure was the unrelated nav test above).

**Did:** Nothing to change — the code is correct. Recorded so the error is in the brief,
not in the codebase, and so the next feature brief for an admin surface says Island.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## T7 (subagent) — GET endpoint added, inside surface

**Found:** The brief required the client to "refetch on success" and the page's
`initialData` to be "structurally identical to a client refetch", but no read endpoint
existed. The subagent added `GET src/app/api/admin/solicitation/breaker/route.ts` —
inside the allowed surface, so no amendment — and rejected `router.refresh()` as the
alternative. Verified by the orchestrator: it is `requireAdminWithAal2`-gated, matching
the reset route, so the read is not a weaker door onto the same state.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## T8 — `page-source.test.ts` EXECUTES the page rather than only reading its source

**Found:** The brief named `src/app/admin/autonomy/__tests__/page-source.test.ts` as the
precedent for the page test. That precedent only `readFile`s the page and asserts on its
text, which (a) cannot assert *"`requireAdminPage` is called with `aal2: true` and
`from: '/admin/solicitation'`"* — the locked requirement — and (b) leaves every line of
`page.tsx` uninstrumented, so the diff-coverage row could not be closed for that file.

**Did:** Used the in-repo precedent that matches this page's shape instead —
`src/app/admin/suppressions/__tests__/page.test.tsx`, an admin page executed against a
mocked `requireAdminPage`/`sql`/client component. No new mechanism was invented. The
autonomy precedent's source assertions ride along as a third case in the same file, so
the file still earns its `page-source` name.

**Verified:** `requireAdminPage` call args asserted; gate-first proved by a rejecting gate
leaving `readSendBreaker` uncalled; diff-coverage 351/351 (100%).

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## SURFACE AMENDMENT 3 of 2 — spec amendments doc (budget over-run, owner-directed)

**Found:** Round 1 returned 6 high / 8 medium / 9 low. The owner directed that ALL bucket-2
findings be fixed on this branch, including the two that are #900 INTERACTIONS. Recording
the outcome of that fix requires editing the cross-spec amendments doc (the doc that "wins
on conflict"), which was never in surface.

**Step 0 re-run, as the rules require when the budget is exceeded** — measured, not asserted:

| bucket | estimate | actual | ratio | trigger at |
|---|---|---|---|---|
| production | 750 | 1003 | 1.34x | 2x |
| test | 1750 | 1838 | 1.05x | 2x |

Both under the reclassify trigger. Classification UNCHANGED: RISK=high, SURFACE=mixed,
SIZE=normal. Estimates re-based to 1150 / 2000 to cover the round-1 fixes.

**The honest read on three amendments:** none was scope sprawl. All three were files the
feature always had to touch and my intake failed to enumerate — a schema-ready constant, a
nav registry row, and the spec doc that records a design decision. The abort criterion is
tuned for scope growth and fired on plan incompleteness instead. That distinction is the
lesson, and it belongs in lab-notes at step 8.

**Invalidates a locked decision?** The round-1 fixes DO revise locked decisions 2 and 5's
consequences — recorded per-fix in the entries that follow.

**Verdict:** ACCEPT (owner-directed).

## R1-B2.1 — breaker recovery was arithmetically unreachable; the window's lower edge is now the last reset

**Found:** adversarial-1 is correct and it is arithmetic, not opinion. While a trip is open
#900 sends nothing, so the denominator (`sent_at` in the last 7 days) drains toward zero
while the numerators keep receiving late-landing `bounced_at` / `complained_at` signals from
pre-halt sends. `rate(Δ) ≥ rate(0)` for every Δ: the ratio gets WORSE the longer the halt
lasts. An admin reset therefore re-tripped within one poll interval, every time, and runbook
§8.3's "roll `SOLICITATION_PLATFORM_DAILY_CAP` down, then reset" could not work — rolling a
ceiling down changes future volume and the window is a pure function of history. The only
real recoveries were "wait ~7 days for the signals to age out" and "wait for the denominator
to fall under `BREAKER_MIN_SENDS`", i.e. roughly seven days of zero sending.

**Did:** `readBreakerWindow` (`src/lib/solicitation/send-breaker.ts`) now bounds the window at
`GREATEST(NOW() - BREAKER_WINDOW_DAYS, (SELECT MAX(reset_at) FROM solicitation_send_breaker))`,
applied to the `WHERE` and to all three aggregate `FILTER`s. No migration: `reset_at` already
exists on 110's table. `GREATEST` ignores NULL arguments in Postgres, so with no reset ever
recorded the expression is byte-equivalent in meaning to the old `NOW() - 7 days`; a COALESCE
would be wrong, not merely redundant. `resetSendBreaker`'s doc comment was rewritten — its old
"the next poller tick re-evaluates honestly and re-trips if the breach stands" described the
bug.

**Is the fix sound? Two properties, both asserted by a live-DB test:**

1. *Recovery is reachable.* Immediately after a reset the window is nearly empty, so
   `BREAKER_MIN_SENDS` (100) suppresses tripping until 100 fresh sends accumulate. That grace
   period is the POINT, not a hole: it is the half-open probe a circuit breaker needs,
   expressed with a floor the design already had. §3.2B ruled out auto-recovery, which is
   defensible, but nothing had replaced the probe, so the manual reset inherited a job it
   could not do.
2. *It cannot be abused into never tripping.* Each reset buys at most 100 sends of ungoverned
   volume — three hard bounces inside that 100 re-trips at once, ~30 minutes at the top ramp
   stage — and the next 100 post-reset sends are measured honestly, so a genuinely bad list
   re-trips almost immediately. For a NORMAL operator the arithmetic yields a bounded probe,
   never a disabled governor. An admin resetting in a loop is a human problem with a durable
   audit trail (append-only table, `reset_by` + non-blank `reset_note` enforced by 110's
   reset_consistency CHECK), not something the arithmetic must defend against.

Accepted consequence, stated plainly: late-landing signals from PRE-reset sends no longer
count. That is deliberate — counting the old cohort's tail against the new window is exactly
what made recovery impossible — and it is what makes a reset an assertion ("I have dealt with
the cause") the system can act on.

**Blast radius:** runbook §8.3/§8.4 now describe a procedure that WORKS; the sibling agent owns
the doc rewrite. The admin surface is unchanged (it renders the frozen trip snapshot).

**Invalidates a locked decision?** It revises locked decision 5's CONSEQUENCES, exactly as the
triage's bucket-2 entry anticipated, and was owner-directed. The decision itself — "never
self-clears; only an explicit admin reset closes a trip" — is untouched and now actually holds.

**Verdict:** ACCEPT.

## R1-B1.1 — paging was EDGE-triggered; it is now LEVEL-triggered, and one test's meaning changed

**Found:** `evaluateSendBreaker` returned a finding only when it newly INSERTed; `ON CONFLICT
DO NOTHING` made every later tick return `null`. One dropped Sentry event (quota, transport
blip, a worker restart before the flush) therefore left sending halted platform-wide with no
notification and no re-page, indefinitely. Every sibling check in `runHealthChecks` is
level-triggered, and Sentry groups `captureMessage` by its text.

**Did:** the open-trip probe (`readSendBreaker`) now runs FIRST and short-circuits: a finding
is returned on every tick a trip is open, including after the breaching signals have aged out
of the window — the halt outlives the breach, because only a reset clears it. New
`openTripFinding` carries the SAME key (`solicitation_send_breaker_tripped`, the alert-routing
tag) and a STABLE title, so the repeat collapses into one Sentry issue that keeps receiving
events rather than opening a new issue every five minutes; elapsed/`trip_id` detail rides in
Sentry `extra`, which plays no part in grouping. Probe-first also means the expensive
aggregate is skipped entirely while halted.

The probe→insert race (`!inserted`) still returns null. That is NOT the old bug: a trip is now
open, so the very next tick's probe pages on it — one poll interval of exposure, not forever —
and the worker is single-replica, so the branch should never execute.

**The test change is the load-bearing part.** `evaluateSendBreaker is idempotent while a trip
is already open` asserted `expect(second).toBeNull()`, which encoded the bug as a promise. The
title is kept VERBATIM (`.feature/intake.json` + the promised-tests gate match it
character-for-character); only the assertions changed, and a comment in the test says why:
idempotence constrains the ROW (still exactly one open trip after two evaluations), never the
finding.

**Blast radius:** `send-breaker-check.test.ts`'s stub had to become POSITIONAL — it answered
every query with the same row, which now reports every healthy window as an open trip. Both
`checks.test.ts` positional-queue helper sites gained a second entry (the breaker is the one
check that issues two queries).

**Invalidates a locked decision?** It reverses decision 6's "it pages ONCE, not every five
minutes" sub-clause. Owner-directed; the anti-fatigue intent is preserved by Sentry grouping
rather than by silence.

**Verdict:** ACCEPT.

## R1-B1.2 — `readBreakerWindow` seq-scanned the whole table; migration 110's index rationale is WRONG and cannot be fixed in place

**Found:** the statement had no `WHERE`, only aggregate `FILTER`s, which do not restrict the
scan. It read every row `solicitation_outreach` has ever held — an append-only, retained table
— once per 5-minute poll cycle, forever. `idx_solicitation_outreach_sent_at` could not serve
it and had no other reader on the branch.

**Did:** added the real `WHERE` (`sent_at >= window_start OR bounced_at >= window_start OR
complained_at >= window_start`), sharing the B2.1 `GREATEST(...)` bound. The three aggregate
`FILTER`s are unchanged, so the asymmetric window basis is preserved exactly.

**Migration 110 is NOT edited** — it is immutable and already recorded at head. Two corrections
are recorded HERE for a follow-up ticket instead:

- 110's comment ("a bitmap scan is cheaper than two more indexes") was wrong about the old
  statement: no bitmap scan was reachable at all, and the relevant row count was the whole
  outreach history, not the ~35k in the window.
- It is still not fully right about the NEW statement. With only `sent_at` indexed, an OR of
  three predicates cannot form a BitmapOr, so Postgres will most likely still choose a seq
  scan. The `WHERE` is nonetheless correct and necessary; whether to add partial indexes on
  `bounced_at` / `complained_at` is now a REAL trade rather than a moot one, and belongs to
  the same follow-up that fixes the comment.

**Blast radius:** `scripts/ci/tenant-scope-allowlist.ts` — see the surface note below.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## R1-B1.3 — the only WRITE in a "No writes" module, un-isolated in a shared-fate chain

**Found:** `worker/background/pollers/health-alert/checks.ts` opened with "Read-only health
checks … No writes." That became false when the breaker trip landed there, and the check sat
un-isolated in the SEQUENTIAL shared-fate core list — so a `23505`, a lock wait or an ON
CONFLICT inference error discarded the nine findings already collected, including the
wedged-connection signal that would explain the failure.

**Did:** (a) the module header now names the single writer and why it is here (the 7-day
aggregate must not run on the send loop, and this poller is the only existing cadence),
plus an explicit "a second writer needs a better answer than 'the first one did it'".
(b) the call is wrapped in a `try/catch` mirroring `checkBacklogDepth`, degrading to
`health_check_error:solicitation_send_breaker` at `warning`. It stays SEQUENTIAL and in
position — never `Promise.all` (#505).

**One correction to the brief I was given.** The brief justified this as "the READ path fails
closed at the releaser (#900), so the poller's write failing does not permit a send." That
overstates it: `readSendBreaker` fails closed on a DB ERROR, not on a trip that was never
written, so a swallowed write failure does delay the halt. The honest argument — the one in the
code comment — is that the delay is ONE poll interval (≤5 min), which is the same bound the
design already accepts as trip latency, and that rethrowing is *silent about the breaker* while
deleting every other signal. The fail-closed guarantee was never carried by this call site and
the catch cannot reach it.

**Blast radius:** one new test in `checks.test.ts`; no behaviour change for any other check.

**Invalidates a locked decision?** no — decision 6 keeps the poller as tripper. The deeper
"evaluation should be its own duty, not an alerting concern" question (adversarial-5's option
ii) is untouched and remains open alongside B3.1.

**Verdict:** ACCEPT.

## R1-B1.7 — the promised trip log line did not exist

**Found:** `.feature/intake.json` `observability` promises "Structured worker log line on trip
from `evaluateSendBreaker`: msg 'solicitation send breaker tripped' with the metric snapshot
only". No such line existed.

**Did:** added `createWorkerLogger('[SendBreaker]')` and a `logger.warn` on the newly-inserted
trip carrying `trip_id`, `trip_reason`, the three counts, the two rates, both thresholds,
`min_sends` and `window_days` — AGGREGATE ONLY, never a recipient address, subject or body.
Deliberately NOT emitted on the level-triggered re-page: the intake promises one line per trip,
and a line every five minutes for the life of a halt is noise. The admin-reset line is the
sibling agent's.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## R1 — surface note: `scripts/ci/tenant-scope-allowlist.ts` snippet had to be re-keyed

**Found:** the allowlist keys an exception on the NORMALIZED SQL text, so re-shaping
`readBreakerWindow` (B2.1 + B1.2) turned its entry into "unused allowlist entry" + "missing
account_id or business_id scope" and `pnpm ci:tenant-scope` went red.

**Did:** updated that one entry's `sqlSnippet` to the new statement and extended its `reason`
to say what changed and that the cross-account justification is unaffected. Entry count
unchanged (383 = baseline). The file IS inside `allowed_edit_surface`; it was outside the
narrower per-agent brief, which is recorded here rather than treated as scope growth — a
snippet re-key is a mechanical consequence of editing the file the entry names.

**Invalidates a locked decision?** no.

**Verdict:** ACCEPT.

## B1.4-tests — two pre-existing gate rows were already RED on HEAD (`d6882a0f`)

**Found:** the brief was "write the two missing B1.4 tests, then take the gate green". The two
tests are written and green (35 lane cases, 11 breaker cases, `promised-tests` 43/43,
`diff-coverage` 408/408 = 100.0%), but `bash scripts/verify-gate.sh --review` comes back
**RED on `tenant-scope` and `build`**, and BOTH rows are red on a clean `d6882a0f` too —
verified by stashing the two test files and re-running each row, which fails identically. The
last recorded green `.feature/gate-status.json` is stamped 2026-08-19 11:01:59Z, i.e. ~3.5h
BEFORE `d6882a0f` was authored, so it never covered that commit. Neither row is flaky: both
reproduce deterministically, and `build` reproduces after `rm -rf .next`. Neither is exit 143.

  1. **`tenant-scope`** — the SAME class of miss the "R1 — surface note" entry above records,
     a second time. `d6882a0f` changed `readBreakerWindow`'s hard-bounce FILTER to
     `o.bounced_at >= b.window_start AND (o.bounce_kind = 'hard' OR o.bounce_kind IS NULL)`
     but left the allowlist entry's `sqlSnippet` on the old
     `o.bounce_kind = 'hard' AND o.bounced_at >= b.window_start`. The allowlist keys on
     NORMALIZED SQL text, so the audit reports both halves of the mismatch:
     `unused tenant scope allowlist entry` **and** `missing account_id or business_id scope
     [template:71424532c47dd181:…]`. Fix is a one-line re-key of that entry's `sqlSnippet` in
     `scripts/ci/tenant-scope-allowlist.ts` (entry count stays 383 = baseline); the
     cross-account justification is unaffected.

  2. **`build`** — `d6882a0f`'s "formatRate single owner" made
     `src/app/admin/solicitation/SendBreakerClient.tsx` (a `'use client'` component) import the
     **value** `formatRate` from `src/lib/solicitation/send-breaker.ts`. That module imports
     `createWorkerLogger` → `src/lib/shared/logger.ts` → `./log-context` →
     `node:async_hooks`, so Turbopack fails the browser chunk:
     `Failed to write app endpoint /admin/solicitation/page … the chunking context (unknown)
     does not support external modules (request: node:async_hooks)`. The four
     `BREAKER_*` constants the client already imported are inlinable literals and merged
     cleanly; a live function binding forces the module merge (`MergedEcmascriptModule` in the
     Turbopack trace) that drags the logger in. `git show d6882a0f~1` confirms the import list
     is the only delta in that file. ESLint invariant #1 does not catch it — `@/lib/shared/logger`
     is not on the banned-runtime-import list — but the spirit of #1 is exactly this.

**Did:** NOTHING to either. Both fixes land in production code
(`scripts/ci/tenant-scope-allowlist.ts`, and a logger-free home for `formatRate` or a client-side
formatter) which is outside this brief's hook-enforced edit surface
(`worker/ingress/__tests__/**`, `src/lib/solicitation/__tests__/**`, this file). The brief's
standing rule is "do not change production code; if a test reveals a genuine defect, STOP and
report", so both are reported rather than patched. The two tests are committed on their own.

**Blast radius:** the branch cannot go green until both are fixed. Neither blocks the tests
themselves: every other gate row, including `test`, `promised-tests`, `merge-coverage` and
`diff-coverage`, is PASS.

**Invalidates a locked decision?** no — B1.4's two-half fix stands and is now pinned. The
`formatRate` single-owner decision (std-5 / B1.11) survives too, but its OWNER cannot be a
module that reaches `createWorkerLogger`.

**Verdict:** _(open — for the orchestrator)_
