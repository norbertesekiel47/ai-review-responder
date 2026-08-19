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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_
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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

## T1 — `pnpm typecheck` cannot pass at the end of the eval task

**Found:** The Task 1 brief requires `pnpm typecheck` to pass. `tsconfig.json` includes
`**/*.ts`, so the eval suites are typechecked — and Task 1 is defined by importing five
modules and two exports that do not exist yet ("write ZERO implementation code").
**Did:** Ran it anyway and confirmed the ONLY errors are those nine intended references
(5 × TS2307 missing module, 2 × TS2305 missing export, across 7 files). No incidental type
error remains in any fixture. That is the strongest signal available at this task.
**Blast radius:** none once T2/T4/T5/T6/T7 land; typecheck goes green by construction.
**Invalidates a locked decision?** no.

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

## T1 — the lane already LOGS `bounce_kind`; it does not yet WRITE it

**Found:** `worker/ingress/resend/solicitation-lane.ts:301` already emits
`bounce_kind: isHard ? 'hard' : 'soft'` — but as a structured LOG field only. The column
is absent from `recordBounce`'s UPDATE.
**Did:** Nothing (Task 3's work is unchanged). Recorded so Task 3 does not read the log
line as "already done" and skip the UPDATE, and so it reuses that same `isHard` value
rather than reclassifying.
**Blast radius:** none.
**Invalidates a locked decision?** no.

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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

**Verdict:** _(orchestrator fills this in at step 6: ACCEPT or RE-PLAN)_

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
