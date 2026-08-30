# Spec & correctness review — `feat/1008-migration-116-refusal-events`

Reviewed diff: `git diff 5ab6bfeeef9bce1d389cf9c75ec87eeeefad9d64...HEAD`, HEAD `f005ded8`.
Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events`.
Read-only review. No source edited.

Inputs read in full: `.feature/intake.json`,
`docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md`,
`docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md`,
`docs/reviews/feat-1008-migration-116-refusal-events/blast-radius.md`.

Empirical verification was done against the live `repworth-testdb` container
(postgres:16) in a rolled-back probe schema and in `ON COMMIT DROP` temp tables.
Nothing was left behind — leak check returned 0 rows in
`information_schema.tables` for `refusal_events` afterwards.

---

## Verdict summary

| Axis | Result |
|---|---|
| Intake `user_visible_behavior` | 2/2 implemented |
| Intake `invariants` | 8/8 upheld |
| Intake `edge_cases` | 9/9 handled in the schema; 1 (`contains NULL`) only **partially** pinned by a test — F1 |
| `tests_to_add` (22 titles) | 22/22 present **verbatim**; 21/22 discriminate the behaviour they name; 1 does not — F1 |
| `allowed_edit_surface` | No drift. Every changed path is inside the declared surface (as amended by D7 + D13). |
| Behaviour not in `user_visible_behavior` | None found |
| Migration SQL vs locked DDL (plan Task 1) | Byte-equivalent, verified by `pg_get_constraintdef` / `pg_indexes` introspection |
| C5 soundness across all combinations | Sound |
| C1–C4 NULL fall-through | Clean |
| Purge arms account-scoped, no `businesses` join | Both correct; both pinned by tests that would fail a business-joined implementation |
| Ordering claims vs `deployment-guide.md` §II.5 and `PurgeWorker` | Accurate |
| Documentation truth | 1 false claim found — F2. All other spot-checked claims verified true. |

**Two findings above the ≥80 % confidence bar. Both are recorded in the table
returned to the caller. Everything else is in the appendix.**

---

## 1. Intake contract, field by field

### 1.1 `user_visible_behavior`

| Item | Status | Evidence |
|---|---|---|
| "No owner-visible change. No route, screen, notification or draft behavior changes." | ✅ | No file under `src/app/**`, `src/components/**`, `worker/ingress/**` or any notification path is touched. Diff is 19 files: 1 migration, 5 production TS/MD registry edits, 4 test files, 9 docs. |
| "An account purge now deletes that account's `refusal_events` rows in `runContentPurgeStage` and verifies their absence in `verifyAccountOffboardingPurge`." | ✅ | `worker/jobs/account-offboarding/purge-stages.ts:434-448` (DELETE, inside the stage's `sql.begin` transaction); `src/lib/account-offboarding/purge-verification.ts:626-636` (`case 'refusal_events'`). |

### 1.2 `invariants`

1. **Deny-all RLS, zero policies.** ✅ `116_refusal_events.sql:225` +
   the deliberate no-policy comment at `:226-229`. Introspection confirms
   `pg_class.relrowsecurity = true`. Pinned by title 1.
2. **Tenant isolation: every statement scoped by `account_id`.** ✅ Both
   production statements filter `account_id = $1::uuid` and nothing else.
   `pnpm ci:tenant-scope` passes (370 entries, baseline 370).
3. **No write site, table empty in every environment at merge.** ✅ `rg`
   confirms the only production SQL naming `refusal_events` is the purge DELETE
   and the verification SELECT.
4. **`occurred_at` is the single retention clock.** ✅ Column comments at
   `:193-196` say so in those words; pinned by title 5, which asserts BOTH
   comments mention retention AND name `occurred_at`.
5. **A CHECK is satisfied by NULL, so C1 wraps its CASE in `IS TRUE`.** ✅
   Confirmed by deparse: `… END IS TRUE`.
6. **`account_id`/`business_id` are the only FKs, neither carries a referential
   action; `subject_id` is a bare uuid.** ✅ Verified by
   `pg_constraint.confupdtype/confdeltype = 'a'` on both; pinned by title 3.
7. **`all_refusal_codes` members deliberately NOT CHECKed against
   `AutoApprovalBlockReason`.** ✅ No member CHECK exists; title 13 pins that an
   unknown member is admitted.
8. **Migration files at or below head are immutable; 116 carries LOCAL-ONLY.** ✅
   `.claude/reference/migrations-log.md` 116 entry carries the marker.
   `.claude/hooks/migration-immutability-guard.sh:53-72` confirms a LOCAL-ONLY
   entry is exactly what unblocks the guard — the plan's step-9 claim
   ("removing the marker re-arms the guard") is true.

### 1.3 `edge_cases`

| Edge case | Schema handles it | Test pins it |
|---|---|---|
| C1 CASE fall-through rejects | ✅ `IS TRUE` wrapper | ✅ title 7 (structural — correctly so; see D5) |
| C2 typed-subject-no-id / id-no-type | ✅ | ✅ title 9 |
| C3 biconditional, both directions | ✅ | ✅ title 10 |
| C4 `refusal_code IS NULL` ⇔ `held_draft` | ✅ | ✅ title 11 |
| C5 non-null, non-empty, contains winner, NULL ≠ `'{}'` | ✅ | ⚠️ **partially** — see F1 |
| Idempotency: same `(source, subject_id)` twice under DO NOTHING → one row, tx survives | ✅ | ✅ titles 16, 17 |
| Two `autonomy_suspended` rows persist (partial index) | ✅ | ✅ title 18 |
| `ON CONFLICT` cannot infer a partial index unless re-spelled byte-for-byte | ✅ | ✅ title 16 (runs the second insert *inside* `sql.begin`, then reads in the same tx — that is what makes it a real proof rather than an outcome restatement) |
| Deploy ordering: 42P01 at plan time, `PurgeWorker` terminalizes | ✅ | n/a (documented; see §4) |
| Account-window index leads on `account_id`, covers `business_id IS NULL` | ✅ | ✅ title 4 |

### 1.4 `allowed_edit_surface` — no drift

Every one of the 19 changed paths is inside the declared surface, counting the
two amendments recorded in D7 (`docs/security/rls-inventory.md`,
`worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts`) and D13
(`.claude/reference/arch-review-log.md`). `PurgeWorker.test.ts` was in the end
**not** modified — it mocks `purge-verification` but lets `purge-stages` run
against its `sql` stub, and the extra tagged-template call needs no mock change.

Non-goals verified NOT done:
- `scripts/ci/tenant-scope-allowlist.ts` untouched ✅
- No `src/lib/refusals/vocabulary.ts` ✅ (the suite declares the vocabulary
  locally with an explicit "derive from the module the moment it exists" note)
- No promotion lines in the migrations-log; LOCAL-ONLY present ✅
- No backfill, no `origin` column ✅ (title 2 pins "twelve columns and no others")
- Retention row marked **NOT YET ENFORCED** with the #1009 pointer ✅

### 1.5 `tests_to_add` — all 22 present verbatim

Titles 1–18 in
`src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts`
(19 is rehomed there too, per D10c); 20 in `table-disposition.test.ts`; 21 in
`purge-verification.test.ts`; 22 in `offboarding-lifecycle.integration.test.ts`.
String-for-string match against the intake array — checked, not eyeballed.

The substantive question the brief asks — *does a title pass while the feature
is wrong?* — is answered "no" for 21 of them and "yes" for one. See F1.

---

## 2. The migration SQL against the locked DDL

Applied `116_refusal_events.sql` into a throwaway `probe116` schema inside a
transaction and rolled back. Deparsed output matches the plan's Task 1 block
exactly:

- **Twelve columns**, exact types/nullability/defaults. `id` has no default
  (worker-supplied UUIDv7); `created_at` has `now()`; `occurred_at` has none.
- **Five named CHECKs** — `refusal_events_source_subject_pairing`,
  `…_subject_completeness`, `…_business_pairing`, `…_code_pairing`,
  `…_all_codes_pairing`.
- **Three column-level enum CHECKs** — Postgres derived
  `refusal_events_refusal_source_check` (7 members, in order),
  `refusal_events_refusal_category_check` (8 members — `owner_review_required`
  present, i.e. #998 is folded in), `refusal_events_subject_type_check` (4).
- **Three indexes** plus `refusal_events_pkey`:
  `idx_refusal_events_archival (occurred_at, id)`,
  `idx_refusal_events_account_window (account_id, occurred_at DESC)`,
  `refusal_events_subject_uniq UNIQUE (refusal_source, subject_id) WHERE (subject_id IS NOT NULL)`.
- **Deny-all RLS** — `relrowsecurity = true`, zero policies.
- One transaction with `SET LOCAL lock_timeout = '10s'`, no `CONCURRENTLY`.

C1's deparse is:

```
CHECK ((
CASE refusal_source
    WHEN 'held_draft'::text THEN (subject_type = 'response'::text)
    …
    WHEN 'autonomy_suspended'::text THEN (subject_type IS NULL)
    ELSE NULL::boolean
END IS TRUE))
```

which confirms D12's lesson is right: Postgres *adds* `ELSE NULL::boolean`, so
title 7's `toContain('ELSE NULL::boolean')` + `toMatch(/END\)?\s*IS TRUE/)` is
the correct pairing and both assertions match the real output (note there is no
paren between `END` and `IS TRUE` — the optional `\)?` in the regex covers that).

### 2.1 C5 soundness — exhaustive

`refusal_source` is `NOT NULL`, so `= 'policy_gate_held'` and `<> …` are never
NULL and the two arms are mutually exclusive without gaps.

| `refusal_source` | `all_refusal_codes` | `refusal_code` | C5 |
|---|---|---|---|
| `policy_gate_held` | NULL | any | reject (arm-1 `IS NOT NULL` FALSE) |
| `policy_gate_held` | `'{}'` | any | reject (`cardinality > 0` FALSE) |
| `policy_gate_held` | contains a NULL member | any | reject (`array_position(...) IS NULL` FALSE) |
| `policy_gate_held` | no NULL member | NULL | reject (`= ANY` → NULL → outer `IS TRUE` FALSE); C4 also rejects |
| `policy_gate_held` | no NULL member, winner absent | non-NULL | reject |
| `policy_gate_held` | no NULL member, winner present | non-NULL | **admit** ✅ |
| any other lane | NULL | any | **admit** ✅ |
| any other lane | non-NULL | any | reject |

`array_position` is deliberately non-strict and uses `IS NOT DISTINCT FROM`
semantics, so searching for NULL is meaningful — confirmed empirically:
`array_position(ARRAY['winner', NULL], NULL)` yields a non-NULL subscript and
the shipped CHECK rejects the row.

`NULL` and `'{}'` never collapse into one value: the first is caught by
`IS NOT NULL`, the second by `cardinality > 0`, and neither is reachable by the
other arm.

### 2.2 C1–C4 have no equivalent NULL fall-through

- **C1** carries the wrapper.
- **C2** `(subject_type IS NULL) = (subject_id IS NULL)` — `IS NULL` never
  yields NULL, so the equality is never NULL.
- **C3** `(business_id IS NOT NULL) = (refusal_source <> 'autonomy_suspended')` —
  LHS never NULL; RHS never NULL because `refusal_source` is `NOT NULL`.
- **C4** `(refusal_code IS NULL) = (refusal_source = 'held_draft')` — same.

D4's claim that "C1–C4 were checked for the same NULL class and are clean" is
correct.

---

## 3. The purge arms

Both are account-scoped and neither joins through `businesses`:

- `purge-verification.ts:626-636` — `SELECT COUNT(*) FROM refusal_events WHERE
  account_id = $1::uuid`, and deliberately not `absentByBusiness`.
- `purge-stages.ts:444-447` — `DELETE FROM refusal_events WHERE account_id =
  $1::uuid`, placed at the end of `runContentPurgeStage`'s single transaction,
  after the `agent_runs` DELETE. It sits below the per-business advisory-lock
  loop, so the ABBA hazard documented at `purge-stages.ts:410-421` is not
  reintroduced; nothing else in the codebase touches `refusal_events`, so it
  introduces no new lock ordering at all.

**Would the tests catch a business-joined implementation? Yes — both of them.**

- Title 21 (`purge-verification.test.ts:214-253`) asserts the captured statement
  `.toContain('WHERE account_id = ?::uuid')`, `.not.toContain('account_businesses')`,
  `.not.toContain('business_id')`, and `values` is exactly `[accountId]`. A join
  through `businesses` fails on at least two of those.
- Title 22 (`offboarding-lifecycle.integration.test.ts:1379-1407`) seeds **two
  tenants × two rows**, one located (`held_draft`) and one account-wide
  (`autonomy_suspended`, `business_id IS NULL`). After the purge it asserts the
  target account holds **0** and the bystander holds **2**. A business-joined
  DELETE leaves the account-wide row and the first assertion reads 1 ≠ 0; an
  unscoped DELETE empties the bystander and the second assertion reads 0 ≠ 2.
  Both fixture halves are load-bearing and both are present.

Note the fixture is C-constraint-legal on every axis (checked by hand against
C1–C5), which is why it actually inserts rather than failing at seed time.

`verificationQuery`'s `default:` arm throws
`missing_purge_verification_sql:<table>` (`purge-verification.ts:736-737`), so
omitting the branch would fail every purge, not fail silently — the plan's D1
claim is accurate.

**The disposition row really is forced.** `accountLinkedTablesFromMigrations()`
(`table-disposition.test.ts:55-97`) matches a `CREATE TABLE … ( … );` body
non-greedily up to the first `);`. I checked 116 for an earlier `);` — there is
none (`accounts(id),`, `'policy_gate_held')),` and `),` all avoid it), so the
whole body is captured, and both `linkedColumnPattern` (`account_id`) and
`referencesTenantRootPattern` (`REFERENCES accounts`) match. D1 and the
rollback narrative that depends on it hold.

**Placement is not order-sensitive.** The plan says "the array is asserted
sorted by the inventory test"; it is not — `table-disposition.test.ts:107`
compares `unique(classified)` to `classified.slice().sort()`, which asserts
*uniqueness*, and `:108` compares two independently sorted lists. The row's
non-alphabetical position (after `judge_verdicts`) is therefore harmless. See
appendix A3.

---

## 4. Ordering claims

The plan's Step 8 asserts two properties. Both check out.

**"The migration precedes the code in every environment."** Verified against
`PurgeWorker.ts:71-105`: the stage call sits inside the `try`, and on a
non-terminal attempt it calls `markPurgeRetryableFailure` and rethrows, while on
`isTerminalAttempt(job)` it calls `markPurgeTerminalFailure` **and**
`markOutboxFailed` and returns. Nothing reopens the offboarding afterwards. So
D6's correction of the intake's original "clears the moment 116 is promoted"
claim is right, and "the mitigation is ordering, not recovery" is the correct
conclusion. The Sentry signal named in `observability`
(`account_offboarding_purge_failed`, tags `subsystem=account_offboarding`,
`step=purge`, `level` warning→error, `terminal` flag) matches
`alertPurgeFailure` at `PurgeWorker.ts:107-127` exactly.

The blast radius confirms no Next.js surface reaches either changed module:
`purge-verification.ts`'s only non-test importer is `purge-stages.ts`, whose
only non-test importer is `PurgeWorker.ts`. So the per-PR Vercel preview — which
deploys at step 1, before any DDL — cannot hit a missing relation. That closes
the one hole a "migration precedes the code" claim could still have had.

**"No SQL reaches production before CI is green."** `deployment-guide.md` §II.5
step 1 opens the PR first, step 3 applies the migration to staging Supabase
"before it ever runs against prod", and step 4 (merge) is "the promotion". §II.5
is silent on the exact moment prod DDL runs relative to the merge; the plan pins
it to immediately before the merge (step 7), which satisfies §II.5's
staging-first lockstep rule *and* the 42P01 constraint. D10a's reading of §II.5
is correct and the final order is a legitimate refinement, not a contradiction.

Step 10's re-sync instruction (`reset --hard origin/main` +
`--force-with-lease`, never a sync merge) matches §II.5 step 5's squash-merge
branch verbatim.

---

## 5. Documentation truth — spot checks

Verified **true**:

| Claim | Where | Evidence |
|---|---|---|
| `rls-audit.test.ts` asserts `REQUIRED_RLS_TABLES === TENANT_TABLES` then requires a row per member | plan Task 2, D7, migrations-log | `scripts/ci/__tests__/rls-audit.test.ts:41-49` — it is `toBe`, i.e. identity, which is stronger than the doc says |
| `TENANT_TABLES` is two structures and editing one is silently wrong | D11, migrations-log | `scripts/ci/tenant-tables.ts` exports the array **and** `TENANT_SCOPE_COLUMNS`; both were edited |
| `solicitation_batches` is at `tenant-tables.ts:154` | D8 | the map entry is at 160 post-change, 154 pre-change ✅ |
| "the 22 `AutoApprovalBlockReason` values" | migration `:154`, ADR 0023 §5 | `worker/jobs/response-generation/auto-approval.ts:37-59` — exactly 22 |
| "the Judge runs on already-posted replies (`judge-store.ts`, `WHERE r.status = 'posted'`)" | CONTEXT.md, ADR 0023 §2 | `src/lib/responses/judge-store.ts:115` |
| "a held draft is subtracted from the owner's pending count (`src/lib/dashboard/pending-count.ts`)" | ADR 0023 Context | file exists; `:4` "Excludes held/flagged drafts", predicate at `:17`/`:45` |
| ADR 0023's other file citations (`step-facts.ts`, `worker/jobs/judge/context.ts`, `judge-policy.ts`, `RenderWithholdReason`, `commitWithhold` in `dispatch.ts`) | ADR 0023 | all resolve |
| "removing the LOCAL-ONLY marker re-arms `migration-immutability-guard.sh`" | plan step 9, migration header | `.claude/hooks/migration-immutability-guard.sh:53-72` |
| `ci:directory-map`, `ci:live-db-suites`, `ci:tenant-scope`, `ci:static-policy` all pass at this HEAD | — | re-run during this review; all four green |

Found **false** — see F2: the `reason` string on the new `TABLE_DISPOSITIONS`
row claims `refusal_events` is unlike **every other** `hard_delete` row in
having no cascade reach it.

---

## Findings (≥80 % confidence)

### F1 — MAJOR. C5's `array_position(all_refusal_codes, NULL) IS NULL` clause has zero test coverage; deleting it leaves all 22 tests green

`src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:869-916`
(title 12, "C5 rejects policy_gate_held rows whose `all_refusal_codes` is null,
empty, **contains NULL**, or omits `refusal_code`…").

The title promises a "contains NULL" case. The suite's only such case is
`refusal_code = 'winner'` against `all_refusal_codes = ARRAY['different', NULL]`
— a row in which the winner is *also* absent. That row is rejected by the outer
`IS TRUE` wrapper **on its own**, so it does not discriminate the
`array_position` clause at all.

Proven on the local `postgres:16` container with two `ON COMMIT DROP` temp
tables — one carrying the shipped C5, one carrying C5 with only the
`array_position` conjunct removed:

| Row | C5 minus `array_position` | Shipped C5 |
|---|---|---|
| `policy_gate_held`, code `winner`, codes `['winner', NULL]` | **INSERT 0 1 — ACCEPTED** | rejected (`refusal_events_all_codes_pairing`) |
| `policy_gate_held`, code `winner`, codes `['different', NULL]` | rejected | rejected |

The second row is the only one the suite exercises, and both variants reject it.
`x = ANY(array)` returns TRUE as soon as one element matches, regardless of NULL
members, so with the winner *present* the arm evaluates TRUE and the wrapper
never fires.

Contract violated: intake `edge_cases` — "C5: `all_refusal_codes` is non-null,
non-empty and contains `refusal_code` exactly for `policy_gate_held`, and NULL
for every other lane. NULL and `'{}'` must never become the same value" — and
`tests_to_add` title 12's own "contains NULL" clause. The migration comment at
`supabase/migrations/116_refusal_events.sql:150-153` and D4 both declare this
clause load-bearing and say "Do not drop either clause. Do not 'simplify' C5."
Nothing enforces that.

Failure scenario: this is slice 1 of 7. When #1009's insert helper and #1010–13's
write sites land, a `blockReasons` array carrying an `undefined`/`null` element
(the natural shape of a partially-populated gate result) produces a
`policy_gate_held` row whose `all_refusal_codes` claims a member that is not a
code. The only thing stopping it is a clause a future "simplify C5" pass can
delete with a fully green suite — including a green run of the very test whose
title says it covers the case.

Fix shape: add one case to title 12 — `refusalCode: 'winner'`,
`allRefusalCodes: ['winner', null]`, expecting `C5_ALL_CODES_PAIRING`. One line
beside the existing cases; no new fixture needed.

### F2 — MINOR. The new `TABLE_DISPOSITIONS` reason states a false fact about every other `hard_delete` row

`src/lib/account-offboarding/table-disposition.ts:330`:

> "…**NO CASCADE REACHES IT, unlike every other hard_delete row here**: its only
> foreign keys are to accounts and businesses, both retain_deidentified and
> neither carrying a referential action…"

The clause after the comma is true of `refusal_events`. The comparative claim is
false, and it is false about rows in the same array and about comments in the
same worker file:

- `review_escalations` (`table-disposition.ts:312-318`, `hard_delete`) —
  migration `073_review_escalations.sql:23-25` declares `account_id`,
  `business_id` and `review_id` all `REFERENCES …` with **no referential
  action** (only `agent_run_id` has `ON DELETE SET NULL`). `purge-stages.ts:373-376`
  says so explicitly: "review_id FK has no cascade, so these must go before the
  reviews delete." It needs its own explicit DELETE for exactly the same reason
  `refusal_events` does.
- `contact_csv_uploads` (`hard_delete`) — `purge-stages.ts:306-311`: "businesses/
  accounts are retain_deidentified (UPDATE-tombstoned, never DELETEd), so this
  explicit DELETE is the only way these three hard_delete/must_be_absent tables
  actually get swept."
- `agent_outcomes` (`hard_delete`) — `purge-stages.ts:400-406`: its
  `accounts` cascade "never fires and the explicit DELETE is required."

Concrete harm: the sentence tells the next reader that `refusal_events` is the
unique case, which invites the conclusion that the other explicit DELETEs in
`runContentPurgeStage` are redundant belt-and-braces. They are not — removing
any of them strands customer PII through a purge. The `reason` field is read as
authority (it is the only prose an auditor gets for a disposition), and the
branch's own review brief holds that a false doc claim is a finding.

Fix shape: drop the three words "unlike every other hard_delete row here". The
rest of the sentence is accurate and sufficient.

---

## Appendix — below the confidence bar / observations, not findings

**A1. C5's outer `IS TRUE` has no structural test, unlike C1's.** Title 7 reads
`pg_get_constraintdef` for C1; there is no equivalent for C5. Given the
`array_position` clause plus C4, I could not construct a row that C5-without-the-
wrapper admits and the shipped schema rejects: the only remaining NULL producer
is `refusal_code IS NULL` on a `policy_gate_held` row, which C4 rejects
independently (and C4 is evaluated second — Postgres sorts CHECK constraints by
name, and `…_all_codes_pairing` < `…_code_pairing`). So the wrapper is
defence-in-depth today. It stops being so the moment C4 changes shape, and
nothing would tell you. Low priority; mentioning it because F1's fix is a natural
place to also add a structural C5 assertion.

**A2. Title 7 pins that seven arms are present, not that there are exactly
seven.** An added eighth `WHEN` would pass. Low risk: an eighth lane also needs
the standalone `refusal_source` CHECK widened, and title 15 asserts that CHECK's
members **and order** exactly.

**A3. The plan's Task 3 claim "the array is asserted sorted by the inventory
test" is wrong**, and the implementation did not insert the row in sorted
position (it sits between `judge_verdicts` and `account_offboardings`).
`table-disposition.test.ts:107` asserts uniqueness, `:108` compares two
independently sorted lists — order in the file is unconstrained. No defect
results; noting it so the next slice does not go hunting for a sort invariant
that does not exist.

**A4. Typo in `.claude/reference/migrations-log.md`** — the 116 entry reads
"105's, 108'S, 110's and 111's entries" (capital S).

**A5. Retention-policy row placement.** The new `refusal_events` row is inserted
between `solicitation_suppression_corrections` and `solicitation_send_breaker`,
splitting the solicitation block. Cosmetic; the table has no asserted order.

**A6. Title 1 selects `relforcerowsecurity` but never asserts it.** Deliberate
and consistent with every other deny-all table in the repo (the app writes
through the RLS-bypassing `postgres` owner role, so FORCE would break the
writer, and deny-all with zero policies is what denies `anon`/`authenticated`).
Not a gap — noting it because the unused column in the destructured row reads
like an oversight.

**A7. Title 4 relies on `ORDER BY indexname` agreeing with a JS literal.** I
checked both plausible collations (byte order and an underscore-ignoring
glibc/ICU primary weight); the four names sort identically under both, so this
is stable. The suite already applies the JS-sort-both-sides defence in title 14
for `refusal_source`, and correctly judged it unnecessary here.

**A8. No test pins that the `refusal_events` DELETE is inside
`runContentPurgeStage`'s transaction.** Title 22 calls the stage and checks the
outcome, so an implementation that issued the DELETE outside `sql.begin` would
still pass. The shipped code is inside the transaction; the gap is theoretical
and matches how every other statement in that stage is tested.

**A9. `docs/reviews/…/blast-radius.md` is untracked and the deviations file has
uncommitted modifications** at review time (`git status --porcelain` shows
` M docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md`
and `?? docs/reviews/feat-1008-migration-116-refusal-events/blast-radius.md`).
The step-6 triage table I read is therefore working-tree content, not content at
`f005ded8`. Worth committing before the PR so the triage record ships with the
branch.

**A10. `pnpm ci:tenant-scope` reports "entries: 370 (baseline: 370)"** — the two
new account-scoped statements did not move the counter. I did not chase why
(the audit passed, and both statements are correctly scoped), but if the
baseline is meant to grow with each new tenant-scoped query, that is worth a
glance in a later slice.
