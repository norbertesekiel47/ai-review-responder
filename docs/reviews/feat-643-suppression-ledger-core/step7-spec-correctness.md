# Step 7 — Spec & correctness review (`feat-643-suppression-ledger-core`)

**Reviewer:** fresh step-7 spec & correctness reviewer.
**Diff under review:** `a3f4ddb417c9fc3f0af2994ffaa44b79009ee2b2..c12db598` — 37 files,
5,283 insertions / 20 deletions.
**Verdict:** no critical/high/medium findings. Three `low` findings below.

---

## 1. What I verified, and how

Nothing was taken from a prior session's word. Every claim below was re-derived from
files, from the database, or from a command I ran in this worktree.

| Check | Method | Result |
|---|---|---|
| Edit surface | `git diff --name-only`, each of 37 paths matched by hand against the 26 `allowed_edit_surface` globs | 37/37 in surface |
| Intake copies identical | `shasum -a 256 .feature/intake.json docs/superpowers/plans/…-intake.json` | both `5078c6d6…` |
| Typecheck | `pnpm typecheck` | pass (this also validates the 6 `@ts-expect-error` assertions in `suppression.test.ts` — an unused one is an error) |
| `ci:tenant-scope` | run | pass, 413/413 (baseline bumped 410 → 413 in the same PR) |
| `ci:rls-audit` | run | pass, 42 tenant tables enable RLS |
| `ci:analytics-events` | run | pass |
| `ci:static-policy`, `ci:db-imports`, `ci:live-db-suites`, `ci:outbox-seam`, `ci:outbox-status` | run | all pass |
| `suppression.integration.test.ts` | run against the local test DB, `--reporter=verbose` | 11/11, all executed (not skipped) |
| `migration-096` + `migration-097` suites | run | 70/70 across the three files |
| `offboarding-lifecycle.integration.test.ts` | run, verbose-filtered | 14/14, all seven new suppression/token/receipt cases executed |
| `batch-builder.integration.test.ts` | run | 20/20 |
| Unit tier (`suppression.test.ts`, `batch-builder.test.ts`, `email-templates.test.ts`, `src/lib/account-offboarding/__tests__/`, `PurgeWorker.test.ts`, `AccountOffboardingEmailWorker.test.ts`, `events.test.ts`) | run | 24 files / 225 tests pass |
| 19 `tests_to_add` titles | scripted fixed-string grep over `src`, `worker`, `scripts` | 19/19 present verbatim |
| Query plans for the two new purge predicates | `EXPLAIN` against the local test DB | see finding 2 |
| `recordSuppression` production callers | repo grep | zero, as `edge_cases` predicts (G6) |
| Preemptive fallow suppressions | `git diff … \| grep -n 'fallow-ignore\|fallow-disable\|@ts-ignore\|outbox-seam-ignore'` | none in code; the only hit is prose inside the plan document |

---

## 2. Field-by-field intake check

### 2.1 `allowed_edit_surface` — 37/37 in surface

Checked path-by-path, not from memory:

`.claude/reference/migrations-log.md` ✓ · `CONTEXT.md` ✓ · `docs/analytics/events.md` ✓ ·
`docs/security/rls-inventory.md` ✓ · four files under `docs/superpowers/plans/**` ✓ ·
`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` ✓ ·
`scripts/ci/tenant-scope-allowlist.ts` ✓ · `scripts/ci/tenant-tables.ts` ✓ ·
`src/lib/account-offboarding/{outbox,purge-verification,table-disposition}.ts` ✓ ·
`src/lib/account-offboarding/__tests__/outbox.test.ts` ✓ ·
`src/lib/analytics/events.ts` + `__tests__/events.test.ts` ✓ ·
`src/lib/notifications/email/templates/account-offboarding.ts` +
`src/lib/notifications/__tests__/email-templates.test.ts` ✓ ·
`src/lib/shared/worker-types.ts` + four files under `src/lib/shared/__tests__/**` ✓ ·
`src/lib/solicitation/{suppression,batch-builder}.ts` + four files under
`src/lib/solicitation/__tests__/**` ✓ · `supabase/migrations/096_*.sql`, `097_*.sql` ✓ ·
`worker/jobs/account-offboarding/{purge-stages,AccountOffboardingEmailWorker}.ts` +
three files under `worker/jobs/account-offboarding/__tests__/**` ✓.

**No drift.** Note the migration-094 suite edit (`src/lib/shared/__tests__/migration-094-…`)
is in surface via `src/lib/shared/__tests__/**` — it is the analytics-CHECK drift-guard
handoff 094 → 097, which the deviations log records and which the 097 suite now owns
(`migration-097-…:71-80`) while 094 pins its own historical 21-name list.

### 2.2 `user_visible_behavior` — 4/4 shipped, nothing extra

1. **Withheld with reason `suppressed`, carrying `source` + `suppressed_at` verbatim.**
   `batch-builder.ts:411-412` selects them, `:343-346` stamps `candidate.suppression`,
   `restraint-policy.ts:367-374` (pre-existing, precedence 2) emits
   `{ reason:'suppressed', suppression_source, suppressed_at }`. Proven end-to-end by
   `batch-builder.integration.test.ts:1395`, which asserts the exact `suppressed_at`
   string the DB rendered — not a re-derivation.
2. **Does not consume `BATCH_CAP`.** `batch-builder.integration.test.ts:1429` seeds
   `BATCH_CAP` clean candidates + 1 suppressed and asserts
   `candidateCount = BATCH_CAP + 1`, `sendCount = BATCH_CAP`, `velocity_banked: 0`. The
   `velocity_banked: 0` assertion is what makes the companion mutation (counting a
   suppressed row as eligible) fail, so the test is two-sided.
3. **Receipt states the retained count and lists no addresses.**
   `purge-stages.ts:772-777` counts inside the finalize transaction;
   `account-offboarding.ts:258-274` renders; `offboarding-lifecycle…:1429` drives the
   real poller → outbox → worker → template path and asserts both halves (`= 2`, and
   that none of four seeded handles, nor `@test.local`, nor the owner email appear).
4. **Account row deleted, global row survives with `account_id` intact.**
   `purge-stages.ts:329-332`; proven twice — once through the full production purge
   (`…:1270`) and once through `runContentPurgeStage` with a global AND an account row
   on ONE handle (`…:1306`), which only a `scope`-discriminating delete can pass.

**Behaviour shipped that the contract did not name:** none material. Two copy-level
additions are inside item 3 and are recorded as deviations — the singular sentence branch
(`account-offboarding.ts:269-271`) and "zero renders nothing" (`:267`). See §5 for my
judgement on both.

### 2.3 `invariants` — 13 items

| Invariant | Status | Evidence |
|---|---|---|
| #14 RLS deny-all, zero policies on both tables | HELD | `096:104-105`, `096:159-160`; `ci:rls-audit` counts them (42 tenant tables); `rls-inventory.md:36-37` |
| #8 owner reads scoped by `account_id`; account arm can never match another tenant | HELD | `suppression.ts:67`; proven by `suppression.integration.test.ts:535`, which asserts the miss for account A *and* the hit for the owning account B — so the miss is scoping, not a broken predicate |
| #10 SHA-256 via `node:crypto` for `token_hash` | HELD (and now enforced) | `096:128-129` `CHECK (token_hash ~ '^[a-f0-9]{64}$')`; no `crypto-js` anywhere; `ci:static-policy` green |
| #5 raw tokens never in Postgres/outbox/logs | HELD | this ticket stores only a hash; the format CHECK added at `cd861e6b` is the first mechanical enforcement (previously a comment only) |
| #15 explicit `sql`/`tx` parameter | HELD | `suppression.ts:59,142`, `purge-verification.ts:74-78`; `ci:db-imports` passes strict |
| DR2 solicitation-only | HELD | only consumers of `suppressionMatchSql` are `batch-builder.ts` and the two test suites; no notification/transactional path references either table |
| First-write-wins `ON CONFLICT … DO NOTHING` | HELD | `suppression.ts:157,169` re-spell `WHERE scope = 'global'` / `WHERE scope = 'account'` byte-for-byte against `096:90-96`; proven behaviourally (`…:229`, `:257`) and by source-survival (`:324` asserts the *winner's* source, which a silent overwrite would fail) |
| Existence checks only, never compared against `suppressed_at` | HELD | `suppression.ts:61-71` selects and orders by it but never compares; the purge/verification/count queries use `scope`/`account_id` only |
| §4.2 populate, never pre-filter | HELD | `batch-builder.ts:446-448` is a `LEFT JOIN LATERAL … ON TRUE` with no filter; the deviations log records the mutation proof (adding `AND suppression.source IS NULL` fails `…:1429` at 25 vs 26) |
| Lock order csv-ingest → batch, ordered by `business.id` | HELD | both new statements sit inside `runContentPurgeStage` **after** the `:282-285` lock loop; `recordSuppression` takes no business-keyed lock and cannot (it is handle-keyed, takes no business id) — see §5 |
| `TABLE_DISPOSITIONS` "stays alphabetically sorted … never append" | **Intake clause is factually wrong; the real gate holds** | `table-disposition.test.ts:107` is `expect(unique(classified)).toEqual(classified.slice().sort())` and `unique()` itself sorts, so it asserts *uniqueness*. The list has never been alphabetical (`accounts, businesses, users, reviews, …`). The binding assertion is `:108` (classified set == `TENANT_TABLES ∪ explicit ∪ spec-only`), satisfied by registering both tables in `scripts/ci/tenant-tables.ts`. Entries were appended; `PURGE_VERIFICATION_TABLES` order only decides verification order, which is immaterial. Correctly triaged in the deviations log. |
| Fail-closed `missing_purge_verification_sql:<table>` | HELD | `purge-verification.ts:665-666` default arm unchanged; `purge-verification.test.ts` still gates arm existence for every disposition table |

### 2.4 `edge_cases` — 13 items, each checked against code

1. **`outreach_id` plain UUID, no FK** → superseded in flight. It ships as
   `REFERENCES solicitation_outreach(id) ON DELETE SET NULL` (`096:115`) with a **partial**
   unique index (`096:150-152`). The spec carries the amendment banner
   (`2026-07-28-…:169-190`). The retention property the edge case protects is preserved and
   directly tested (`offboarding-lifecycle…:1383` asserts the outreach row is gone and the
   token survives with `outreach_id` NULL and `token_hash` intact). This is the *stronger*
   shape, not a regression: no-FK would leave a scrubbed row carrying an undetectable stale
   pointer. ✅
2. **ONE disposition entry, not two** → `table-disposition.ts:388-394` one entry for
   `solicitation_suppressions`; the single arm (`purge-verification.ts:637-651`) asserts both
   facts, so it can actually fail. Spec §6.3 carries the amendment banner. ✅
3. **Global wins a double match** → `suppression.ts:69`
   `ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC LIMIT 1`. `boolean DESC` puts
   `true` first. `suppression.integration.test.ts:503` ages the *account* row backwards a
   day first, so an order-by-timestamp-only fragment would return it — the test fails
   unless scope precedence is doing the work. ✅
4. **account_id-leading index on each table** → `096:100-102`, `096:155-157`. Shipped —
   but see **finding 2**: the scrub/verification predicates cannot use the token one. ⚠️
5. **`VerifyAccountOffboardingPurgeInput` needs no widening** → unchanged
   (`purge-verification.ts:8-17`); both new arms derive users/businesses by subquery. ✅
6. **Count at finalize, global rows only, tokens excluded** → `purge-stages.ts:772-776`;
   `PurgeWorker.test.ts:435` asserts the query text contains `scope = 'global'` and does
   **not** contain `solicitation_unsubscribe_tokens`. ✅
7. **One-directional CHECK pairing** → `096:73-74`
   `CHECK (scope <> 'account' OR account_id IS NOT NULL)`; `…:477` proves a global row may
   carry `account_id` (a reversed or symmetric constraint would reject it). ✅
8. **Repeat write is a no-op success and mints no duplicate event** →
   `suppression.ts:174-175` returns `null` before the enqueue; `…:401` asserts
   `totalForAccount === 1`, i.e. nothing minted at all — not a second row deduped by
   `event_key`. ✅
9. **`solicitation_contacts.email` already normalized, no re-normalization** →
   `batch-builder.ts:447` passes `tx\`c.email\``; the consent join two lines above
   (`:438-441`) is the standing proof. ✅
10. **`recordSuppression` has zero production callers** → confirmed by repo grep. Its
    consumer is `suppression.integration.test.ts`, which is why the predicted fallow
    `unused-export` finding never fired and why writing a suppression for it *created* a
    `stale suppression` failure. No preemptive marker survives on the branch. ✅
11. **Gate live but dormant in prod; zero events is the steady state** → consistent with
    (10); `docs/analytics/events.md` marks both events `planned` with an explicit status
    note. ✅
12. **Registering `solicitation_suppressed_at_dispatch` here is deliberate** →
    `events.ts:27`, `097:56`, documented in both the migration header and `events.md`. ✅
13. **CHECK pairing rejects `scope='account'` with NULL `account_id`** → covered by (7);
    `…:439` asserts SQLSTATE `23514` **and** the constraint name. ✅

### 2.5 `tests_to_add` — 19/19 present verbatim; sample rigorously verified

All 19 titles matched by fixed-string grep. I did not stop at existence — for eight of them
I read the body and confirmed the assertion matches the title:

- *"first write wins: a later complaint does not overwrite an earlier unsubscribe row"*
  (`…:324`) — asserts the **surviving row's `source`**, not just `rows === 1`. A row count
  of 1 is equally true of a writer that overwrote in place; this test discriminates. It also
  asserts the loser's `account_id` did not leak into the winner.
- *"a repeat recordSuppression mints no duplicate analytics event"* (`…:401`) — asserts the
  **account-wide** total is 1, which is the difference between "skipped the enqueue" and
  "enqueued and got deduped by `event_key`".
- *"the CHECK pairing rejects scope='account' with a NULL account_id"* (`…:439`) — casts an
  illegal input past the type system on purpose (modelling a caller that lost the type) and
  asserts code `23514` **and** `constraint === 'solicitation_suppressions_account_scope_pairing'`.
  `expectRejectedWrite` fails loudly if the DB *accepted* the write, so a dropped CHECK
  cannot read as a pass.
- *"isSuppressed returns the global row when both … match"* (`…:503`) — the account row is
  aged backwards first; see edge case (3).
- *"isSuppressed ignores an account row belonging to a different account"* (`…:535`) —
  two-sided (miss for A, hit for B).
- *"a withheld-suppressed candidate does not consume BATCH_CAP"* (`…:1429`) — arithmetic
  over `BATCH_CAP + 1` seeded contacts plus `velocity_banked: 0`; both mutation directions
  are caught.
- *"purge verification passes when a global suppression row survives with its account_id
  intact"* (`…:1270`) — drives the **full** production purge (poller → outbox → worker) so
  `finalizePurgeInTransaction`'s own verification call is the "passes" assertion, then reads
  the row back, because (per G13) a verifier that counts violations returns 0 for "correctly
  retained" *and* for "wrongly deleted everything".
- *"the purge receipt reports the retained global suppression count and lists no addresses"*
  (`…:1429` in the offboarding suite) — four seeded rows chosen so a wrong count is a
  *different* number (2 global + 1 account + 1 token; a pre-purge count reads 3, a
  token-inclusive count reads 3), then asserts the rendered body from the real
  `handleAccountOffboardingEmail`, and that no handle nor even `@test.local` appears.

**One naming issue**, see finding 3: two of the mandated titles name `isSuppressed`, a
helper `CONTEXT.md` explicitly says must not exist.

**Unit coverage did not thin** where the plan's tests were relocated to live-DB suites
(deviations flag 1): `purge-verification.test.ts` still gates every disposition table having
an arm; `email-templates.test.ts` gained three rendering cases; `AccountOffboardingEmailWorker.test.ts`
gained the retry-stability case (renders the same number twice, never queries the ledger);
`PurgeWorker.test.ts` gained a genuine in-transaction ordering assertion (`lockIdx < countIdx
< receiptIdx`, `scope === 'tx'`) rather than a text match; `batch-builder.test.ts` fixtures
gained the two new columns so `toCandidate`'s `!== null` gate is exercised faithfully.

**These suites do run in CI** — the deviations log asked reviewers to confirm this and it is
the item most worth checking, given #520. `.github/workflows/ci.yml:133` sets
`TEST_DATABASE_POOL_URL` on the `test` job, `:143` runs `./.github/actions/test-db`, and that
action applies `scripts/ci/test-db-bootstrap.sql` then **every** `supabase/migrations/*.sql`
in sorted order — so 096/097 are picked up with no workflow edit. The stale comment in
`vitest.config.ts:11-12` ("the integration suites self-skip there because
`TEST_DATABASE_POOL_URL` is unset") is wrong as of the `postgres:16` service container; it
does not affect behaviour. All three relocated suites executed locally with real assertions.

### 2.6 `verification_commands`, `rollback_plan`, `observability`

- All five verification commands run green in this worktree (§1).
- **Rollback plan** is consistent with the code: `097` is a strict superset of `094`
  (asserted mechanically by `migration-097-…:57-69`, which compares the extracted name lists
  and pins that the first *N* are 094's in the same order); `096` has zero production
  writers so the "drop while empty" window is real; and the "code revert MUST precede any
  table drop" ordering is correct — `batch-builder.ts:446`, `purge-verification.ts:637/657`
  and `purge-stages.ts:329/344/772` would all hard-error against dropped tables.
- **Observability**: the `account_offboarding_purge_verification_failed:<tables>` string is
  produced at `purge-stages.ts:718-722` (joins the failing table names), and
  `missing_purge_verification_sql:<table>` at `purge-verification.ts:666`. The intake's own
  caveat — the verifier counts violations so its *absence* does not prove retention — is
  restated verbatim in the code comment at `purge-verification.ts:615-620`, and retention is
  proven by the live survival tests as required. No log line interpolates a handle.

---

## 3. Blast-radius caller analysis

This is the part typecheck cannot do. For each changed file with importers, I asked: does a
*semantic* change break a caller that relied on the old behaviour?

### `src/lib/account-offboarding/outbox.ts` — 67 importers

Change is **additive-optional**: `retainedSuppressionCount?: number` on
`EnqueueAccountOffboardingEmailInput`, written to the payload only when `!== undefined`
(`outbox.ts:133-135`). Every one of the 67 importers that calls
`enqueueAccountOffboardingEmail` (the offboarding pollers, `TeardownWorker`,
`ReactivationWorker`, `confirm.ts`, `keep-my-data.ts`, `retry-billing.ts`, …) passes no such
field, so their payloads are byte-identical to before —  asserted by the new
*negative* case `outbox.test.ts:105` ("omits the retained-count field for email types that
have no purge receipt"), which pins the exact payload object for `cancel_only_confirmation`.
The other 60-odd importers import unrelated helpers from the module and are untouched.
**No caller impact.**

### `src/lib/shared/worker-types.ts` — 113 importers

`AccountOffboardingEmailPayload` gained `retained_suppression_count?: number`. Optional, on
a payload interface consumed only by `AccountOffboardingEmailWorker`. Adding an optional
property to an interface cannot break a structural consumer. `pnpm typecheck` green across
all 113. **No caller impact.**

### `src/lib/analytics/events.ts` — 15 importers

`ANALYTICS_EVENT_NAMES` gained two members, so `AnalyticsEventName` widened. Widening a
union in the *value* position is safe for every producer; the risk is a consumer that
**exhaustively switches** on the union (a widened union makes a `never` exhaustiveness check
fail) or one that **pins the array**. I checked both:

- Exhaustive switch: none. `isAnalyticsEventName` is a `Set.has` guard; `enqueue.ts`,
  `activation-event.ts`, `trial-events.ts`, `named-rival.ts`, `process-review.ts`,
  `account-offboarding/analytics.ts`, `response-generation/analytics.ts` all *produce* names.
- Pinned array: exactly one — `events.test.ts`'s first case pins the literal with `toEqual`.
  It was updated in the same PR, in the same order/placement as the allowlist, so it remains
  a genuine drift-guard rather than degrading to a sorted-set comparison.
- `scripts/ci/analytics-events-audit.ts` compares the TS allowlist against
  `docs/analytics/events.md`; both sides were updated and the audit passes.
- The **database** side is the one a TS-only registration silently breaks (089's lesson).
  Migration 097 covers it, and `migration-097-…:71-80` now owns the drift-guard that used to
  live in the 094 suite.

**No caller impact.** One documentation-vs-code mismatch found — finding 1.

### `src/lib/account-offboarding/table-disposition.ts` — 3 importers

Two appended entries. Consequences traced:

- `PURGE_VERIFICATION_TABLES = TABLE_DISPOSITIONS.filter(purgeVerification !== 'not_checked')`
  (`:408-414`) → both new entries **are** verified, so the new arms are live on every purge,
  not dead. Confirmed by the failing-verification tests at `offboarding-lifecycle…:1203`
  and `:1237`.
- `ALLOWED_PURGE_VERIFICATION_BY_DISPOSITION` (`:35-43`) permits
  `retain_compliance_limited_pii → allowed_limited_retention` only; both entries use exactly
  that pair, so the `satisfies` constraint holds.
- `table-disposition.test.ts:98-108` requires the classified **set** to equal
  `TENANT_TABLES ∪ explicit ∪ spec-only`; satisfied because `scripts/ci/tenant-tables.ts`
  registered both tables in the same PR. `:110-120` separately scans every migration for
  tables with an `accounts`/`businesses` reference and requires them to be classified —
  `solicitation_suppressions` has `account_id UUID REFERENCES accounts(id)` (`096:59`) and
  would have failed that scan had it not been registered.
- Adding to `TENANT_TABLES` also arms `ci:rls-audit` (both tables `ENABLE ROW LEVEL SECURITY`
  ✓) and `ci:tenant-scope` on every SQL touchpoint of the two tables — which is exactly why
  the three allowlist entries and the 410 → 413 baseline bump exist. Verified 413/413.

**Caller impact is intended and complete.**

### `worker/jobs/account-offboarding/purge-stages.ts` — 3 importers

`runContentPurgeStage` gained two statements; `finalizePurgeInTransaction` gained one query
and one extra argument to an existing enqueue. Callers are `PurgeWorker.ts` and two live-DB
suites. Semantics checked against the surrounding stage:

- **Ordering vs. the advisory locks.** Both new statements sit *after* the
  `acquireCsvIngestLock` → `acquireSolicitationBatchLock` loop (`:282-285`), preserving the
  global lock order.
- **Ordering vs. the upload cascade.** The token scrub (`:344`) runs after the
  `contact_csv_uploads` DELETE (`:307`), so `solicitation_outreach` has already cascaded away
  and `outreach_id` is already NULL by SET NULL — which is why `outreach_id` is deliberately
  absent from the explicit `SET` list and from the G12 CHECK. Proven by `…:1383`.
- **`businesses` is tombstoned, not deleted** (`:643-668` is an `UPDATE`, and `account_id` is
  not among the scrubbed columns), so `business_id IN (SELECT id FROM businesses WHERE
  account_id = …)` still resolves at both scrub time and verification time. Likewise `users`
  is `retain_deidentified` with `account_id` intact, so the verifier's user subquery resolves.
- **Idempotency on retry.** Both statements are idempotent (a `DELETE … WHERE scope='account'`
  and an `UPDATE … SET NULL`), which matters because the purge worker re-runs the whole stage
  on retry.
- **Ordering inside finalize.** lock → scrub → verify → `SET status='purged'` → count →
  enqueue. The count therefore only runs once the finalize preconditions actually hold, and
  it is in the **same transaction** as the state change and the outbox row (invariant #2).
  `PurgeWorker.test.ts:435` pins that ordering positionally rather than by text match.
- **`accounts` FK with no `ON DELETE` action.** I checked whether any production path
  `DELETE`s an `accounts` row and would now hit an FK violation from a retained global
  suppression row: the only non-test site is
  `src/lib/onboarding/admin-onboarding-service.ts:249`, a compensating delete of an
  account created seconds earlier — no suppression row can exist. Not a hazard.

### `src/lib/solicitation/batch-builder.ts` — 8 importers

`loadCandidateWindow` is private; the change reaches callers only through `AskCandidate`,
whose `suppression` field already existed (`restraint-policy.ts:116`) and was previously
hard-coded `null`. So the semantic change is: **a field that was always `null` can now be
non-null**, which flips `evaluateAsk`'s precedence-2 branch from unreachable to reachable.
Callers checked:

- `worker/jobs/solicitation-batch/index.ts` / `generate.ts` — consume
  `{status, candidateCount, sendCount, withholdCount, withheldByReason}`; `withheldByReason`
  is already keyed by the full `WITHHOLD_REASONS` enum, so a `suppressed` key is not new
  shape.
- `src/lib/solicitation/ask-generation.ts` — reads `solicitation_asks` rows with
  `status='send'`; a suppressed candidate is `withhold` and never reaches it.
- `worker/jobs/account-offboarding/purge-stages.ts` and
  `batch-purge-concurrency.integration.test.ts` import the batch **lock** helper, not the
  builder — unaffected.
- The `evidence` JSONB shape `{reason:'suppressed', suppression_source, suppressed_at}` is a
  pre-existing member of `WithholdEvidence` and is already handled by `parseEvidence` in the
  Requests read model (`batch-view.ts`), so no read-model change is required.
- `suppressed_at` is emitted as `::text` (`:412`), matching the existing convention for
  evidence timestamps (`prior_decision_at` at `:486` does the same). No format regression.
- Fragment composition (`suppressionMatchSql(tx, tx\`c.email\`, accountId)` nested into the
  outer template) is the risky part — postgres.js must splice and renumber parameters
  correctly. It is proven with real values by two independent live suites
  (`suppression.integration.test.ts:144-158` composes it standalone;
  `batch-builder.integration.test.ts:1395/1429` composes it inside the real 10-join query and
  gets per-account-correct results). The deviations log also records a mutation proof that
  the nested backtick does not blind the tenant-scope scanner.
- Performance: the LATERAL adds one index probe per pool row. Both partial uniques are
  usable for the `(channel, normalized_handle)` equality, so this is a BitmapOr of two index
  scans, not a scan.

### `src/lib/account-offboarding/purge-verification.ts` — 3 importers

Two new `case` arms in an existing `switch`; the `default` throw is untouched, so the
fail-closed guard still holds and `purge-verification.test.ts`'s "has explicit verification
SQL for every disposition table" case gates the pairing. `verificationQuery`'s signature is
unchanged (no input widening), so `offboarding-lifecycle…` and `purge-stages.ts` are
source-compatible.

### `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts` — 3 importers

One added field on the params object handed to `buildAccountOffboardingEmailHtml`, read off
`job.data` with `?? 0`. The worker gains no DB access — asserted negatively at
`AccountOffboardingEmailWorker.test.ts:427` (`sqlCalls.some(… 'solicitation_suppressions')`
is `false`). Retry stability asserted by calling the handler twice with the same job.

### `src/lib/notifications/email/templates/account-offboarding.ts` — 1 importer

`src/lib/notifications/email.ts` passes params through. The new param is optional and
defaults to 0 at the `purge_receipt` branch (`:52`), so the five other email types render
byte-identically — pinned by the existing purge-receipt case's new negative assertion
(`email-templates.test.ts:139`).

---

## 4. Findings (≥80% confidence)

### Finding 1 — `low` — analytics distinct ID falls back to a random row id on a typed, spec-mandated path

`src/lib/solicitation/suppression.ts:180`

```ts
distinctId: input.accountId ?? row.id,
```

`docs/analytics/events.md:265` — written by this same PR — documents
`solicitation_suppressed` as **"Distinct ID: account ID"**. The code silently substitutes the
suppression row's UUIDv7 when `accountId` is null.

That path is not hypothetical: `RecordSuppressionInput` types `accountId` as
`string | null` for both global variants (`suppression.ts:92`, `:102`), and spec §5.2 states
outright that *"Redemption of a token whose account was purged still writes a ledger row…
The resulting row carries `account_id = NULL`"*. `analytics_events.distinct_id` is
`TEXT NOT NULL` (migration `046:25`) and is shipped verbatim as PostHog's person key
(`worker/background/pollers/AnalyticsDispatchPoller.ts:153`).

**Failure scenario:** #644 ships redemption. A recipient clicks an unsubscribe link 12 days
after the sending account was purged. `recordSuppression` runs with `accountId: null`. The
`solicitation_suppressed` event lands in PostHog under a distinct ID nobody will ever emit
again — one ghost person per post-purge opt-out, un-joinable to any account, and
contradicting the doc this PR wrote. The same applies to any #627 webhook source that
cannot resolve an account.

A stable sentinel (or documenting the fallback in `events.md`) would resolve it. Not a
correctness defect in the ledger itself — the ledger row is right either way.

### Finding 2 — `low` — the purge's token predicate defeats the index migration 096 added for it

`worker/jobs/account-offboarding/purge-stages.ts:349-350` (twin at
`src/lib/account-offboarding/purge-verification.ts:660-662`)

```sql
WHERE account_id = ${row.account_id}::uuid
   OR business_id IN (SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid)
```

`solicitation_unsubscribe_tokens` has an index on `account_id` (`096:155-157`) whose stated
purpose in the migration header is *"account-leading, for the offboarding purge scrub"*,
and the intake names this explicitly as an edge case handled up front: *"PG16 has no skip
scan, so 096 ships an account_id-leading index on each table — the migration-095 lesson,
applied up front instead of in a review round."*

There is **no index on `business_id`**. Postgres cannot serve an `OR` from a partial index
set that covers only one branch — there is no partial-coverage plan — so both statements are
structurally forced to a sequential scan regardless of table size. `EXPLAIN` on the local DB
confirms `Seq Scan on solicitation_unsubscribe_tokens / Filter: ((account_id = …) OR (hashed
SubPlan 1))`.

The second branch is also **provably redundant** against the G12 CHECK
(`096:144-145`: `account_id IS NOT NULL OR (business_id IS NULL AND ask_id IS NULL)`), which
means `business_id IS NOT NULL ⟹ account_id IS NOT NULL`. The only rows the branch can add
are those with `account_id = Y ≠ X` while `business_id ∈ businesses(X)` — a cross-account
inconsistency no writer produces.

**Failure scenario:** `solicitation_unsubscribe_tokens` has **no expiry by decision** (spec
§2.2) and gains one row per outreach forever. At a few million rows, every offboarding purge
seq-scans the whole table twice — once for the scrub inside `runContentPurgeStage`, which is
holding the per-business `csv_ingest` and `solicitation_batch` advisory locks and therefore
blocks contact-CSV ingest and batch construction for that business for the duration, and
once again for verification inside the finalize transaction. Contract clause violated:
intake `edge_cases` item 4.

The same class applies, at lower volume, to `purge-verification.ts:643-645`
(`created_by_user_id IN (SELECT id FROM users …)` on `solicitation_suppressions`, no index on
`created_by_user_id`) — also confirmed a seq scan by `EXPLAIN`.

### Finding 3 — `low` — two test titles name a helper the glossary says must not exist

`src/lib/solicitation/__tests__/suppression.integration.test.ts:503` and `:535`

```
isSuppressed returns the global row when both a global and an account row match
isSuppressed ignores an account row belonging to a different account
```

`CONTEXT.md`'s **Suppression scope** entry states the lookup is *"owned by the one exported
fragment `suppressionMatchSql` and never re-implemented at a call site (**G7: no
`isSuppressed()` helper**, because the second consumer does not exist yet)"*. `suppression.ts`
exports no such symbol, and the tests correctly drive `suppressionMatchSql` through its real
LATERAL composition.

The titles come verbatim from `tests_to_add`, and `scripts/verify-gate.sh`'s `promised-tests`
row fixed-string-matches them, so the implementation was right to keep them — the fix is an
intake amendment, not a rename. But as shipped, the branch's own test suite advertises an API
its own glossary forbids. A reader arriving at `suppression.ts` looking for `isSuppressed`
finds nothing, which is precisely the confusion the glossary entry was written to prevent.
Contract clause: the mandate's "glossary drift — code that contradicts a `CONTEXT.md`
concept".

---

## 5. Judgement on the four entries the deviations log escalated to step 7

1. **Live-DB relocation across T3/T4/T5.** *Sound.* I confirmed the CI `test` job stands up
   `postgres:16`, sets `TEST_DATABASE_POOL_URL`, and applies every migration via
   `.github/actions/test-db` — so all three relocated suites execute in CI rather than
   self-skipping, which was the #520 failure mode. I also ran all of them locally and
   confirmed real execution (verbose reporter, non-zero durations, per-test names). Unit
   coverage did not thin: each relocation left behind a *different* unit assertion that the
   integration test cannot make (arm existence, template rendering, retry stability,
   in-transaction ordering). The stale `vitest.config.ts:11-12` comment should be corrected
   at some point but is inert.
2. **Optional `retained_suppression_count`.** *Correct call.* Outbox rows enqueued before
   this deploys are genuinely in flight and their receipts must render. That is a rollout
   invariant with a bounded lifetime, not a speculative shim, and it is covered by a named
   test (`renders no retained count for a purge receipt enqueued before the count existed`).
   The read-side default (`?? 0`) collapses "absent" and "zero" to the same rendering, which
   is the right merge: both mean "we are not claiming a number."
3. **Singular copy branch.** *Correct call, and the plan's copy was wrong.* The plural-only
   sentence renders "1 opt-out records are retained" at N=1, which is the most likely
   non-zero count there is. The singular branch is grammatical, the plural wording is
   verbatim from the plan, and there is one test per branch plus one for zero. I would have
   made the same change.
4. **The fallow reversal.** *Verified.* No `fallow-ignore`, `fallow-disable`, `@ts-ignore`,
   `eslint-disable` or `outbox-seam-ignore` marker appears anywhere in the branch's code
   diff — the only textual hits are prose inside the plan document. `pnpm ci:fallow` is not
   a gate, but the substantive point (a suppression written from a *prediction* is a defect
   class) holds and was not repeated anywhere.

---

## 6. Low-confidence appendix (deliberately NOT in the findings table)

These are observations I would not stake 80% on as defects. Recorded so a later reader does
not have to re-derive them.

- **The zero-count receipt says nothing about retention.** `user_visible_behavior` item 3
  reads "the receipt **states** how many opt-out records are retained." At count 0 the
  sentence vanishes entirely (`account-offboarding.ts:267`), and since `recordSuppression`
  has zero production callers, **every** purge receipt until #644/#645/#627 ship will render
  no retention sentence at all — i.e. the ticket's headline user-visible change is invisible
  in production for its whole life. I judge the decision itself correct ("0 opt-out records
  are retained" is noise that invites a question with no answer behind it) and it is
  explicitly tested, so this is a note, not a finding.
- **The `solicitation_suppressions` verification branch (b) has no remediation path.** If a
  global row ever names one of the account's users as actor, `finalizePurgeInTransaction`
  throws forever: the row is retained by design and cannot be deleted, and the admin
  Correction path is #645. The offboarding would wedge in `purge_scheduled` and page on every
  retry. It is unreachable today (admin users carry `users.account_id IS NULL` — verified in
  `migration 039`'s header, and machine sources write `created_by_user_id IS NULL`), and the
  branch is a deliberate defence-in-depth against a state G14 admits the type layer cannot
  prove. Worth carrying into #645's brief.
- **`recordSuppression` takes no advisory lock**, so it does not literally satisfy the
  intake's "any new writer of a solicitation table honours `acquireCsvIngestLock` then
  `acquireSolicitationBatchLock`." It *cannot* — it is handle-keyed and receives no business
  id. There is no ABBA cycle today (the batch build only reads the ledger; the purge holds
  both advisory locks before touching it), and `purge-stages.ts:757-771` writes down the
  actual contract future writers must honour (no `scope='account'` write during an active
  teardown; `accountId: null` for global writes after the boundary). Sound, but it is a
  comment rather than a mechanism, and nothing enforces it when #644/#645/#627 land.
- **`suppressionMatchSql` hardcodes `s.channel = 'email'`** (`suppression.ts:63`) rather than
  taking a channel parameter, even though `SUPPRESSION_CHANNELS` exists in the same file.
  Correct for v1 (email-only is a destination constraint), and the module owning the enum is
  the right place for the literal — but SMS will require a signature change at both
  evaluation points rather than a value change.
- **The retained count under-reports global rows whose `account_id` is NULL.** A global row
  written for one of the account's contacts by a webhook that could not resolve an account
  is retained but not counted. Within the intake's stated scope for the count, and the
  aggregate is a courtesy disclosure rather than a legal one.
- **The build-time `suppressed` evidence carries `suppression_source` verbatim**, including
  `complaint` / `bounce_permanent` / `provider_suppressed`, which weakly implies to an owner
  that *someone* mailed this person through RepWorth. Spec §4.2 mandates exactly this
  ("`suppression_source` in the evidence is the ledger's `source` value verbatim") and §7.4's
  prohibition is on attributing to another *account*, which the evidence never does. Not a
  leak; noted because #629's copy work will have to reason about it.
- **`vitest.config.ts:11-12`** still claims integration suites self-skip in CI. False since
  the `postgres:16` service container landed. Out of surface for this branch.

---

## Triage verdicts — 2026-08-02 (step 7)

Every finding verified against the code before triage. Full reasoning in
`docs/superpowers/plans/feat-643-suppression-ledger-core-deviations.md` → "Step 7 dual
review — triage verdicts".

- **ACCEPTED** — distinct-ID doc drift (`suppression.ts:180` vs `events.md`). Flagged
  independently by both agents. The `accountId ?? row.id` fallback is correct and
  spec-mandated (§5.2, NOT NULL column); the doc was wrong. Doc fixed, and the per-row
  PostHog person consequence is now stated rather than implied.
- **ACCEPTED** — the token scrub's `OR business_id IN (…)` defeating
  `idx_solicitation_unsubscribe_tokens_account`. Fixed asymmetrically: the `OR` is gone
  from the scrub (hot path, now index-usable, matching `edge_cases[4]`'s stated intent)
  and **kept in the verifier** (cold path), so the one shape it could still catch — a
  cross-account writer bug — fails the purge loudly instead of being silently scrubbed.
  Owner-approved at the triage checkpoint.
- **ACCEPTED** — `isSuppressed` test titles contradicting G7. Fixed via the 2nd and last
  intake amendment (owner-approved): both titles now name `suppressionMatchSql`, both
  intake copies updated in lockstep and re-verified byte-identical (sha256 `91786a3d…`,
  superseding `5078c6d6…`). `allowed_edit_surface` untouched. **Amendment budget is now
  exhausted.**
