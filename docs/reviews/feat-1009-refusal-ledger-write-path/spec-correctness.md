# Spec & correctness review — `feat/1009-refusal-ledger-write-path`

**Axis:** spec & correctness. **Mode:** read-only.
**Branch:** `feat/1009-refusal-ledger-write-path` · **HEAD** `05e52e3f` · **fork point** `0494297a`
**Diff under review:** `git diff 0494297a...HEAD` — 32 files, +4243/−25.
**Reviewed:** 2026-08-30.

**Verdict: the production code is correct against the locked contract.** Every
intake field checks out; no non-goal is shipped; no behaviour outside
`user_visible_behavior` is introduced; all 13 invariants hold in the code; 14 of
15 edge cases are both handled and pinned by a test; all 28 promised titles
exist verbatim **and execute**; every changed path is inside
`allowed_edit_surface`; all four `observability` signals exist. The four
findings below are one test-coverage gap on the intake's own edge case 5 and
three documentation/test-title accuracy defects. None blocks correctness of the
shipped lane.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| medium | `src/lib/refusals/__tests__/write.test.ts:266` | Intake edge case 5 ("Sentry throws MANY times and then recovers") is unpinned: test 28 uses `mockImplementationOnce`, so exactly ONE capture failure is exercised. A regression to a lifetime attempt ceiling — `MAX_WARN_ATTEMPTS = 3`, the precise defect plan-review round 3 spent a round removing — passes all 28 tests. |
| low | `src/lib/refusals/__tests__/eval-completeness.test.ts:43` | `EVAL_FILES` lists 7 files; the branch touches 9 test files. `src/lib/auto-approval/__tests__/suspension.test.ts` and `worker/background/pollers/__tests__/ArchivalPoller.test.ts` (the D18/D10 edits, made after T1 froze the list) are unscanned, so a `.skip`/`.todo` in either satisfies test 26 — and the header's "Seven rows, seven distinct files" completeness claim is false. |
| low | `worker/background/pollers/__tests__/ArchivalPoller.test.ts:114` | Title renamed to "logs all 11 target counts when any archival happened" but the body still asserts 10; `refusal_events` is never asserted on the `Archived` line in this suite and its fixture queues no eleventh count. A regression dropping `refusal_events` from the log object is caught only by the live-DB suite. |
| low | `.claude/reference/arch-review-log.md:1432` | "Six artifacts were swept and **six** deliberately left alone" undercounts: the plan's own §0 sweep table lists EIGHT untouched rows. The enumeration omits `docs/reviews/red-team/feat-1008-…/findings.{md,json}` and `src/lib/refusals/vocabulary.ts`. D12's own failure mode, once more, in the branch's newest artifact. |

---

## 1. Verification actually performed (not inferred)

| What | Command / method | Result |
|---|---|---|
| Six unit suites execute | `REPWORTH_DISABLE_LIVE_DB_SUITES=1 vitest run --reporter=verbose` | **58 passed / 6 files** |
| Three live-DB suites execute | `TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL` exported at the local container, `vitest run --project integration --reporter=verbose` | **30 passed / 3 files**, every case named in the output (D14's silent-skip trap avoided) |
| All 28 promised titles present verbatim | scripted `String.includes` of each `tests_to_add` entry against every changed test file | **28/28 present, 0 missing** |
| Typecheck | `tsc --noEmit -p tsconfig.json` | exit 0 (so test 6's `@ts-expect-error` is genuinely consumed — `occurredAt` is required) |
| Lint (changed production files) | `eslint src/lib/refusals worker/background/{pollers/ArchivalPoller.ts,schedulers/AutonomyGovernorScheduler.ts} src/lib/auto-approval/suspension.ts scripts/ci/tenant-scope-allowlist.ts` | exit 0 |
| CI audits | `ci:tenant-scope`, `ci:static-policy`, `ci:directory-map`, `ci:env-registry`, `ci:db-imports`, `ci:live-db-suites`, `ci:outbox-seam`, `ci:outbox-status`, `ci:process-env`, `ci:rls-audit` | **10/10 PASS** |
| D9's EXPLAIN claim | `EXPLAIN` of the arm-11 statement against the live test DB | `Limit → LockRows → Sort` — exactly as D9 states |
| Intake mirror integrity | `cmp .feature/intake.json docs/superpowers/plans/…-intake.json` | byte-identical |
| Migration 116 promotion premise | `.claude/reference/migrations-log.md` §116 + `git cat-file -e origin/main:…116…` | 116 is on `main` and recorded applied to **staging** (`kubdiqdhqbhwmqfditeg`) and **production** (`udeyaqnvpojbwgoaxwdg`) on 2026-08-30, no `LOCAL-ONLY` marker. The intake's premise holds, so the eleventh arm cannot `42P01` the archival cycle. |

---

## 2. Intake, field by field

### 2.1 `goal`

Four deliverables named; all four present.

| Goal clause | Where | Verdict |
|---|---|---|
| the one insert helper owning the whole statement | `src/lib/refusals/write.ts:219` `writeRefusalEvent` | ✅ one exported writer, one INSERT |
| default-ON `REFUSAL_LEDGER_ENABLED` kill switch | `write.ts:225` (inside the body) | ✅ |
| ArchivalPoller retention arm on `REFUSAL_LEDGER_RETENTION_DAYS` | `worker/background/pollers/ArchivalPoller.ts:46,372-384` | ✅ |
| first write site, `autonomy_suspended`, inside `suspendAccountAutonomy`'s existing transaction | `src/lib/auto-approval/suspension.ts:324` | ✅ inside `tx`, after `writeAccountAuditLog`, before both enqueues |

### 2.2 `non_goals` (9) — none violated

Machine-checked. `rg` over `src/` + `worker/` for `refusalCategoryFor`,
`REFUSAL_CATEGORY_META`, `RENDER_WITHHOLD_REASONS` and per-lane map names
returns **one hit**, and it is the sentence in `vocabulary.ts:31` saying they
are deliberately absent. `rg writeRefusalEvent --glob '!**/__tests__/**'`
returns exactly **one production call site** (`suspension.ts:324`) plus the
declaration and its import. No SQL file added (`git diff --name-only` carries no
`supabase/migrations/` path). No read path. No backfill. Migration 116's five
CHECKs are not re-tested — `write.integration.test.ts` proves the same
properties *through the helper*, which is a different claim, and its own
docblock says so. The Governor amendment adds a `captureException` and nothing
else: the `catch`, the cursor advance and the loop are byte-identical
(`AutonomyGovernorScheduler.ts:89-119` — the only non-Sentry change is hoisting
`errorName` into a `const` so both sinks share one derivation).

### 2.3 `user_visible_behavior` (5) — no drift

All five present. The only behaviour in the diff not literally enumerated is the
structured `logger.warn('refusal ledger disabled — no decisions are being
recorded')` line (`write.ts:167`), which D13 introduced deliberately to give the
warning a second, independent path. It is operator-facing telemetry beside the
Sentry warning that item 1 of `observability` names, and it is recorded as a
deviation. Not drift; noted in the appendix.

### 2.4 `invariants` (13) — all hold

| # | Invariant | Evidence |
|---|---|---|
| 1 | duplicate subject is `ON CONFLICT DO NOTHING`, never a raise | `write.ts:265-266`; **proved live** by test 12, which writes twice then READS in the same transaction — a failed inference would poison it |
| 2 | `ON CONFLICT` predicate re-spelled byte-for-byte | `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL` vs `116_refusal_events.sql`'s `refusal_events_subject_uniq … WHERE subject_id IS NOT NULL` — identical. Test 11 *parses the migration* for the expectation rather than typing it, and separately asserts no `?` anywhere after `ON CONFLICT`. **Nothing in the clause is parameterised.** |
| 3 | `occurredAt` required, never optional | `WriteRefusalEventInput.occurredAt: RefusalOccurredAt` — no `?`, no default, no `\|\| ` fallback. `tsc` exit 0 with test 6's `@ts-expect-error` present, so omission is genuinely a type error. |
| 4 | no site round-trips `transaction_timestamp()` through a JS `Date` | `suspension.ts:341` passes the `'transaction_time'` **sentinel**; `occurredAtFragment` (`write.ts:212`) emits bare `tx\`NOW()\`` — an UNPARAMETERISED `NOW()`. Test 14 reads `occurred_at::text` and asserts equality with `transaction_timestamp()::text` across a `pg_sleep(0.25)`; test 17 asserts `refusal.occurred_at::text = audit.created_at::text` and that the string carries microseconds. |
| 5 | `autonomy_suspended` writes `business_id`/`subject_type`/`subject_id` NULL, one row per ACCOUNT | `suspension.ts:327,336-337`. Test 16 seeds **two** businesses on the account (`suspension.integration.test.ts:62-63,205-212`) and asserts `toHaveLength(1)` — not `toBeGreaterThan`. CHECK C3 makes the per-location shape unrepresentable independently. |
| 6 | the three arrays mirror 116's CHECK members exactly | `vocabulary.test.ts` titles 1–3 parse `116_refusal_events.sql` (comment lines stripped, anchored on `CHECK (<col> IN (`) and compare **ordered**; each guards the parse with a length assertion first so a silent non-match cannot make it vacuous. |
| 7 | server-authoritative, no `NEXT_PUBLIC` companion, live per call | `readFlagEnabledByDefault(REFUSAL_LEDGER_FLAG)` at `write.ts:225`, inside the function body. `ci:static-policy` + `ci:process-env` PASS. Test 8 drives false→true→false in one process with no `resetModules`. |
| 8 | `tx: TransactionSql` explicit, never `@/lib/db/server` | `write.ts:219-222`; `ci:db-imports` PASS (baseline deleted — any non-root importer fails). |
| 9 | retention sweep cross-tenant with its allowlist exemption | `scripts/ci/tenant-scope-allowlist.ts` new entry + `ALLOWLIST_BASELINE` 370→371; `ci:tenant-scope` PASS, and that audit requires the `sqlSnippet` to **normalize-equal** the emitted statement (`tenant-scope-audit.ts:1269`), so the snippet is verified consistent by the gate, not by eye. |
| 10 | `account_id NOT NULL`, deny-all RLS kept | schema-owned; `ci:rls-audit` PASS; no policy added. |
| 11 | ledger failure aborts and is never swallowed; telemetry IS swallowed | `write.ts:245` — the `await tx\`INSERT …\`` has no `try`. `suspension.ts:324` — no `try`. `warnLedgerDisabled` (`write.ts:161-181`) and `AutonomyGovernorScheduler.ts:114-118` both swallow. **Proved by test 20**, which forces a real `23514` from `refusal_events` through the real helper (by bending one vocabulary map entry) and asserts the policy row, the audit row and BOTH outbox rows are gone. |
| 12 | warning bounded in BOTH directions; latch on success only | traced below (§3.2). Latch set at `write.ts:176`, **after** `captureMessage` returns; failure sets a TIME cooldown at `write.ts:178`, never a counter. |
| 13 | every added test executes — no `.todo`/`.skip`/`.fails` | module-scope scan at `eval-completeness.test.ts:117` throws during collection. Independently confirmed: I ran all nine suites and watched all 28 titles report. |

### 2.5 `edge_cases` (15)

Fourteen are handled **and** pinned. One is handled but unpinned.

| # | Case | Handled | Pinned by |
|---|---|---|---|
| 1 | off ⇒ return without touching the tx, one warning/process | ✅ | tests 7, 9 |
| 2 | off mid-process, both directions | ✅ | test 8 |
| 3 | Sentry throws while off ⇒ helper still returns | ✅ | test 10 |
| 4 | throws ONCE then recovers | ✅ | test 28 |
| **5** | **throws MANY times then recovers** | ✅ (no counter exists) | **NOT PINNED — finding 1** |
| 6 | every title present AND active; scan at module scope | ✅ | test 26 + the module-scope throw |
| 7 | Sentry throws inside the Governor catch ⇒ cycle advances | ✅ | test 27 |
| 8 | two suspensions ⇒ two Refusals (partial index excludes NULL) | ✅ | test 13 |
| 9 | `newlySuspended: false` ⇒ no row | ✅ | test 19 |
| 10 | CHECK violation aborts the whole decision | ✅ | test 20 |
| 11 | that abort is contained + raises a Sentry issue | ✅ | test 21 |
| 12 | arm shares the ten arms' single try/catch, SQL valid against promoted 116 | ✅ | integration run (`logger.error` asserted not called in test 25) |
| 13 | `ORDER BY (occurred_at, id)` matches `idx_refusal_events_archival` | ✅ | test 24, which derives the expectation from `pg_indexes` |
| 14 | keys on `occurred_at`, never `created_at` | ✅ | test 23, with genuinely **crossed** clocks (`seedRefusal(days+20, 0)` and `seedRefusal(0, days+20)`) |
| 15 | boundary rows: strict `<` | ✅ (`ArchivalPoller.ts:374`) | not directly seeded at the boundary (appendix) |

### 2.6 `tests_to_add` (28)

28/28 verbatim, 28/28 executing (measured, not inferred). Quality spot-checks
the brief called out:

- **Test 16** asserts `expect(rows).toHaveLength(1)` — exactly one, not "at
  least one" — against a fixture that seeds **two** businesses on the account.
  It catches a per-location fan-out. ✅
- **Test 17** selects `refusal.occurred_at::text` and `audit.created_at::text`
  and additionally asserts `/\.\d{1,6}/`, so the equality cannot be two
  truncated values agreeing. ✅
- **Test 20** forces a REAL `23514` from the REAL helper inside the REAL
  deciding transaction (mocking only ONE map entry in `vocabulary.ts`, derived
  from the production map inside the factory so titles 16–19 still run against
  the real vocabulary). It asserts `constraint_name` contains `refusal_events`,
  and asserts the policy row, audit count, notice count and alert count are all
  zero. Not a mocked rejection. ✅
- **Test 23** seeds crossed clocks. It fails under a `created_at` sweep. ✅
- **Test 26** runs at MODULE SCOPE (`eval-completeness.test.ts:117`) and throws
  at collection, so it certifies itself. ✅
- **SQL-text-only assertions:** test 11 is text-only but has a live partner in
  test 12 (whose in-transaction read after a duplicate is what actually proves
  inference). The four new assertions in `suspension.test.ts:52-58` are text-only
  but have live partners in tests 16–20. Test 24 is the one case with no live
  behavioural partner — see the appendix.

### 2.7 `allowed_edit_surface` (20) — no path outside it

All 32 changed paths map to a listed glob. `CONTEXT.md` is in the surface and
was correctly left unedited (its four LOCKED terms already describe the shipped
code; see §5).

### 2.8 `observability` (4) — all four signals exist

1. `Sentry.captureMessage(…, { level: 'warning', tags: { subsystem: 'refusal_ledger', … } })` — `write.ts:170`.
2. Two-caller asymmetry: `JudgeWorker` reaches Sentry via `attachJobFailureSink`; `AutonomyGovernorScheduler.ts:114` now raises its own issue. Both verified in the callers (§4).
3. `refusal_events` in the `Archived` log line (`ArchivalPoller.ts:424`) and in `saturated` (`ArchivalPoller.ts:441`). **Observed in real logger output** during the integration run.
4. The reconciliation query is satisfiable against the shipped schema: both rows are written in the same transaction after the `!policy` guard, so per-account counts agree over a common window.

---

## 3. The nine specific attacks

### 3.1 `ON CONFLICT` predicate

`write.ts:265` emits `ON CONFLICT (refusal_source, subject_id) WHERE subject_id
IS NOT NULL DO NOTHING`. Migration 116 declares `CREATE UNIQUE INDEX …
refusal_events_subject_uniq ON refusal_events (refusal_source, subject_id) WHERE
subject_id IS NOT NULL`. Byte-for-byte identical, and **nothing in the clause is
a bind parameter** (test 11 slices from `ON CONFLICT` to end of statement and
asserts no `?`; the mock renders every bound value as `?`). Inference is proved
behaviourally, not textually, by test 12. **No finding.**

### 3.2 `occurredAt`

Required, no `?`, no default, no fallback (`tsc` exit 0 with the
`@ts-expect-error` in place). `'transaction_time'` resolves to a nested fragment
`tx\`NOW()\`` — **unparameterised**; the `Date` arm resolves to
`tx\`${occurredAt}::timestamptz\``. No site reads `transaction_timestamp()` back
into JS: the sentinel exists precisely so it never has to
(`suspension.ts:336-341` carries that reasoning inline). Test 14 measures the
transaction clock against a `pg_sleep`-advanced wall clock, and test 15 asserts
`epoch_ms`, `.123` in the rendered text, and inequality against `NOW()`.
**No finding.**

### 3.3 The kill switch

`readFlagEnabledByDefault` is called **inside** `writeRefusalEvent`'s body on
every call (`write.ts:225`), never at module scope; the off path calls
`warnLedgerDisabled()` and `return`s **before** the `await tx\`INSERT …\``, so
nothing reaches the deciding transaction (test 7 asserts `sqlCalls` stays at its
prior length; test 18 asserts the suspension, the audit row and both notices
still land with the flag off). **No finding.**

### 3.4 The warning's cooldown — all four paths

```
if (warned || Date.now() < nextWarnAttemptAt) return;   // write.ts:162
try { logger.warn(...); Sentry.captureMessage(...); warned = true }   // 167-176
catch { nextWarnAttemptAt = Date.now() + WARN_RETRY_COOLDOWN_MS }     // 178
```

| Sentry behaviour | Outcome | Permanent silence? | Unbounded attempts? |
|---|---|---|---|
| always works | exactly one warning per process | no (it succeeded) | no |
| throws once, then recovers | one warning, first call after the cooldown | no | no |
| throws N times, then recovers | one warning, first call after the Nth cooldown | no | no |
| always throws | ≤1 attempt per 5 min, forever; the structured log line still lands each attempt | no | no — rate-limited |

The latch is set at line 176, **after** `captureMessage` returns — never before
the attempt. A failure buys a cooldown, never the latch. Every path is bounded
and none is permanently silent. **The implementation is correct.** The finding
is that the *eval* cannot tell this implementation from one with a lifetime
ceiling ≥ 2 (finding 1).

### 3.5 CHECK C3

`suspension.ts:327` passes `businessId: null`. C3 is
`(business_id IS NOT NULL) = (refusal_source <> 'autonomy_suspended')` →
`false = false` → true. The write site is not inside any per-location loop:
`AutonomyGovernorScheduler` calls it once per candidate **account**, `JudgeWorker`
once per flag verdict on `context.account_id`. Test 16 seeds two businesses and
asserts exactly one row. **No finding.**

### 3.6 Failure atomicity

The ledger INSERT is genuinely uncaught (no `try` at `write.ts:245` or
`suspension.ts:324`). The Sentry warning is genuinely caught
(`write.ts:177-180`). They are the right way round: the INSERT **carries** the
fact, the warning **observes** it. Test 20 proves the rollback reaches the
policy row, the audit row and both outbox rows. **No finding.**

### 3.7 The retention arm

`WHERE occurred_at < NOW() - make_interval(days => ${REFUSAL_LEDGER_RETENTION_DAYS})`
— `created_at` appears nowhere in the statement (test 24 asserts
`not.toContain('created_at')` over the captured arm text, and the regex starts
*after* the comment block that mentions it). `ORDER BY occurred_at, id` matches
`idx_refusal_events_archival`'s key columns, which test 24 reads out of
`pg_indexes` rather than restating. `FOR UPDATE SKIP LOCKED` before `LIMIT` is
valid PostgreSQL grammar and I confirmed D9's plan claim myself:
`Limit → LockRows → Sort`. The `sqlSnippet` is verified consistent with the
emitted SQL by `ci:tenant-scope`, which compares them after normalisation
(PASS). Strict `<` matches the nine siblings. **No finding.**

### 3.8 The Governor Sentry sink

`captureException` sits inside its own `try/catch` that swallows
(`AutonomyGovernorScheduler.ts:114-118`). `logger.error` runs first
(`:97-100`) — test 27 asserts the log line landed even though the capture threw,
which is only possible if it runs first. The containment `catch`, the cursor
advance (`:85`) and the `for` loop are unchanged; the sole non-Sentry edit is
hoisting `errorName` to a `const` shared by both sinks. Test 27 asserts the
cycle reaches the next candidate with a throwing capture installed.
**No finding.**

### 3.9 `all_refusal_codes`

`write.ts:257` writes `${input.allRefusalCodes === null ? null : [...]}::text[]`,
so SQL `NULL` for the null case — never `'{}'`. This is not merely asserted: C5
(`refusal_source <> 'policy_gate_held' AND all_refusal_codes IS NULL`, wrapped
`IS TRUE`) would **reject** an empty array, so every passing `autonomy_suspended`
insert in the live-DB suites is positive proof that SQL NULL is what reaches the
column. **No finding.**

---

## 4. Blast radius — the callers against the new semantics

`suspendAccountAutonomy` can now reject for a new reason (a ledger CHECK
violation). Nine importers, checked individually:

| Importer | What it imports | Ready for a new rejection? |
|---|---|---|
| `worker/jobs/judge/JudgeWorker.ts:136` | `suspendAccountAutonomy`, inside `sql.begin` | **Yes.** A rejection rolls back the verdict INSERT and `markOutboxCompletedIfOwned` together — no half state. The job then fails, retries, and on the terminal attempt `attachJobFailureSink` raises a Sentry issue and `worker/jobs/judge/failed-hook.ts` owns `job_outbox`. This is exactly the route `observability` item 2 describes, and edge case 10 accepts the abort. |
| `worker/background/schedulers/AutonomyGovernorScheduler.ts:60` | `suspendAccountAutonomy` | **Yes, and this is why the amendment exists.** Contained to one candidate, cursor advances, and it now raises a Sentry issue instead of a log line alone. |
| `src/app/admin/autonomy/page.tsx` | `listSuspendedPolicies` only (read) | N/A |
| `src/app/api/admin/autonomy/suspensions/route.ts` | `listSuspendedPolicies` only (read) | N/A |
| `src/app/api/admin/autonomy/unsuspend/route.ts` | `unsuspendAccountAutonomy` only | N/A — the unsuspend path writes no Refusal, correctly: an unsuspension is not a decision not to act |
| `worker/jobs/autonomy-suspended-notice/context.ts` | types + `AUTONOMY_SUSPENSION_REASONS` | N/A |
| three test files | — | covered |

**No caller relies on the old "cannot reject for a ledger reason" behaviour.**

One transitive consequence I checked and cleared: `suspension.ts` now statically
imports `write.ts`, which imports `@sentry/node` — and `suspension.ts` is
imported by two Next.js **server** surfaces (`admin/autonomy/page.tsx`,
`api/admin/autonomy/suspensions/route.ts`). Both are server components/route
handlers (no `'use client'`), and `@sentry/node` in `src/lib/**` reachable from
server surfaces is established precedent (`src/lib/reviews/import-consent.ts`,
`src/lib/solicitation/release.ts`, `src/lib/llm/circuit-breaker.ts`). `vocabulary.ts`
— the module the Restraint tab will need from a `'use client'` surface — is
correctly `import type`-only throughout. Not a finding.

---

## 5. `CONTEXT.md` — four LOCKED terms

No glossary concept is renamed. `REFUSAL_SOURCES` is the **lane** only, with the
verbatim code in `refusalCode` — matching the term's explicit two-column trap.
Seven lanes, eight categories, four subject types, all in the migration's order.
`autonomy_suspended` is account-wide with `business_id IS NULL`, as the term
requires. D7's narrowing of `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` to
`Record<AutonomySuspensionTrigger, RefusalCategory>` (dropping `| null`) is
consistent with **Refusal category**: `null` is "the recorded decision, not a
refusal", and no `AutonomySuspensionTrigger` is such a case. The term's
"unrecognised code is a fault, not a category" rule is honoured structurally —
the map is indexed by a closed union, so an unrecognised trigger is a compile
error rather than a runtime default.

---

## 6. Deviations D1–D18 — each claim checked against the code

| # | Claim | Verified |
|---|---|---|
| D1 | parked branch harvested, corrected, never copied | ✅ seven lanes / eight categories shipped; no `RENDER_WITHHOLD_REASONS`; no `read.ts` |
| D2 | Governor Sentry sink, containment untouched | ✅ diff is the import, an `errorName` hoist, and one guarded `captureException` |
| D3 | 28 titles | ✅ 28 present verbatim, 28 executing |
| D4 | round-2 defects corrected | ✅ both guards present and both tested (27, 28) |
| D5 | cooldown in time, not attempts | ✅ no counter exists in `write.ts` |
| D6 | three API names pinned by the eval | ✅ `resetRefusalLedgerWarningForTests`, `WARN_RETRY_COOLDOWN_MS`, `REFUSAL_LEDGER_RETENTION_DAYS` all exported and all consumed by tests; test 20's mechanism is option 3 as described |
| D7 | `\| null` narrowed | ✅ `satisfies Record<AutonomySuspensionTrigger, RefusalCategory>` |
| D8 | `ALLOWLIST_BASELINE` 370→371 | ✅ and `ci:tenant-scope` PASS |
| D9 | locking clause before `LIMIT`; EXPLAIN byte-identical | ✅ **independently re-measured**: `Limit → LockRows → Sort` |
| D10 | arm count 10→11 in `ArchivalPoller.test.ts` | ✅ assertion fixed; **titles fixed only partially — finding 3** |
| D11 | `docs/directory.md` rows | ✅ `### refusals/` section with both files; `ci:directory-map` PASS |
| D12 | sweep table short three times | ✅ final table has 14 rows; **but the arch-review-log summary of it undercounts — finding 4** |
| D13 | `logger.warn` first, inside the guard | ✅ `write.ts:167`, before `captureMessage`; observed in real stderr during the integration run |
| D14 | live-DB suites silently skip | ✅ reproduced the correct behaviour by exporting both vars; all 30 cases reported |
| D15 | `DATABASE_POOL_URL` must be overridden too | ✅ followed; the worktree's `.env.local` does carry a live pooler host |
| D16b | Sentry assertion pins presence not placement | ✅ `JSON.stringify(secondArg)` contains the id; `job-failure-sink.ts`'s shape followed (`extra`/`tags`) |
| D17 | two registry placements | ✅ both rows present; `ci:env-registry` PASS |
| D18 | sixth statement + four new assertions on it | ✅ `suspension.test.ts:49-58`; index 3 is the ledger insert and the ordering rationale is recorded |

---

## 7. Low-confidence appendix (deliberately NOT in the table)

1. **Test 24 has no live behavioural partner.** It reads `ArchivalPoller.ts` as
   text and compares the `ORDER BY` against `pg_indexes`. It proves the two
   agree; it does not prove the planner actually chooses
   `idx_refusal_events_archival` (no `EXPLAIN` assertion). Arms 9/10 set the
   same precedent, so this is consistent rather than wrong — and I ran the
   `EXPLAIN` myself with the expected shape. Raised only because the brief asked
   about text-only assertions.

2. **Edge case 15's boundary is not seeded.** Tests 22/23 use ±20 days. A row
   whose `occurred_at` is exactly `NOW() - 180 days` is handled correctly by the
   strict `<`, but nothing pins it. Every sibling arm is in the same position,
   and a boundary fixture is racy against `NOW()` anyway.

3. **`logger.warn` on the disabled path is a new operator-visible signal** not
   named in `user_visible_behavior` or `observability`. D13 records it and it is
   strictly an improvement (the Sentry warning gains a second path), but the
   intake's observability item 1 still reads as if Sentry is the only signal.

4. **The Sentry warning is worker-effective only.** `@sentry/node` is initialised
   by `worker/sentry.ts`; on Vercel a `captureMessage` from this module would be
   inert. In practice `suspendAccountAutonomy` has no Next.js caller, so the
   warning path is worker-only today. Worth remembering when #1010–#1013 add
   lanes with route-side callers.

5. **`write.ts:280` says `vocabulary_version` is "never a parameter"** while the
   statement binds it as `${REFUSAL_VOCABULARY_VERSION}`. The intent — "never
   caller-supplied" — is clear from context, and binding a value there is
   correct (unlike the `ON CONFLICT` predicate). Wording only.

6. **`ArchivalPoller.test.ts:136`** still reads `logs "Nothing to archive" when
   all 10 targets return 0`. Same title-drift class as finding 3, but this one
   is behaviourally inert.

---

## 8. What I did NOT review

Standards/style conformance, mutation testing of the changed test surface,
coverage (`ci:fallow:coverage`), the ship order in plan §7, and the staging
ride. Those belong to the other review axes.
