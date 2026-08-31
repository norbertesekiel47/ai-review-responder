# Standards & maintainability review — `feat/1008-migration-116-refusal-events`

**Diff under review:** `5ab6bfeeef9bce1d389cf9c75ec87eeeefad9d64...f005ded8`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events`
**Method:** `thermo-nuclear-code-quality-review` skill against the branch diff, plus
the four scope items the review brief named (repo standards, deep-module
discipline, Fowler baseline, glossary).
**Reviewer stance:** read-only. No source was edited.

---

## 0. Verdict

**No blocking finding.** The change is unusually disciplined for its size: five
CHECK constraints that each name the bug they make unrepresentable, an
adversarially-found NULL hole in the *locked* C5 expression corrected rather
than shipped, and every forced registry consequence (`TENANT_TABLES` ×2,
`rls-inventory.md`, `TABLE_DISPOSITIONS`, `verificationQuery`,
`runContentPurgeStage`) landed in the same PR instead of deferred.

Six findings, all in the **test suite and the vocabulary docs**, none in the
migration or the production TypeScript. Two are worth fixing before merge
(a title that over-claims what its body checks, and a 14-line copy-paste);
four are low-severity hygiene.

### Verification performed at HEAD `f005ded8`

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm ci:static-policy` | passed (1220 files) |
| `pnpm ci:live-db-suites` | passed |
| `pnpm ci:directory-map` | passed (582 files, no stale rows) |
| `pnpm ci:db-imports` | passed (strict) |
| `pnpm ci:tenant-scope` | passed (370 entries, baseline 370) |
| `vitest` — `purge-verification.test.ts` + `table-disposition.test.ts` | 24/24 passed |

Live-DB suites were **not** run: bringing the local container to head 116
requires `pnpm test:db:setup`, which drops schema `public`. That is a write and
outside a read-only review's mandate; the parent's verify gate owns it.

---

## 1. Repo standards (`.claude/CLAUDE.md`)

Every numbered invariant that could plausibly apply was checked against the
diff.

| Invariant | Applies? | Result |
|---|---|---|
| #1 Vercel = UI only | no | No `src/app/**` or `src/components/**` change. |
| #2 Transactional outbox | no | No state change enqueues follow-up work. |
| #3 No unapproved posting | no | No posting path touched. |
| #4 High-confidence unsafe drafts held | indirect | ADR 0023 §1 re-affirms `flagged_responses` deny-all and that `.reason` is never selected. Nothing in the diff weakens it. |
| #5 Approval tokens never stored raw | no | — |
| #6 Third-party ingress on Railway | no | — |
| #7 ReviewSource contract | no | — |
| **#8 Auth scope is app-enforced** | **yes** | ✅ `refusal_events` carries `account_id NOT NULL` + nullable `business_id`; both new query sites (`verificationQuery`, `runContentPurgeStage`) filter `WHERE account_id = $1::uuid`. Registered in `TENANT_SCOPE_COLUMNS` as `['account_id','business_id']`. `ci:tenant-scope` passes with no new allowlist entry — correct, because both sites are account-scoped rather than cross-tenant. |
| **#9 `businesses` = location, `accounts` = billing parent** | **yes** | ✅ Handled *unusually* well. C3 is a biconditional (`business_id IS NOT NULL` ⇔ `refusal_source <> 'autonomy_suspended'`), which makes both "account-wide row that is not a suspension" and "suspension pinned to one location" unrepresentable. This is exactly the defect class invariant #9 exists to prevent, encoded in the schema instead of a convention. No subscription column added to `businesses`. |
| **#10 Node native crypto** | **yes** | ✅ No `crypto-js`. `ci:static-policy` passes. The `uuid` package's `v7` is used for UUIDv7 ids — `node:crypto` has no v7 generator, and this matches the repo's UUIDv7 PK convention in `migrations-log.md`. |
| #11 Subscription guard in workers | no | Purge stage is offboarding, downstream of the guard. |
| #12 Entry points orchestrate | yes | ✅ The new `runContentPurgeStage` arm is one `DELETE` in an existing transaction; no new error-handling branch. |
| **#13 Feature flags server-authoritative** | **yes** | ✅ No `NEXT_PUBLIC_*` added (`ci:static-policy` allowlist unchanged). The `REFUSAL_LEDGER_ENABLED` kill switch is deferred to #1009 and correctly *not* pre-registered here. |
| #14 Auto-approval policy access server-owned | no | — |
| **#15 Domain modules take the DB client explicitly** | **yes** | ✅ `verificationQuery(table, input, exec)` keeps its `exec` parameter; `runContentPurgeStage(sql, row)` keeps its. No `@/lib/db/server` import added. `ci:db-imports` passes strict. |

**Working rules:**

- ✅ Route handlers / worker boot files orchestrate only — the new purge arm is a single statement.
- ✅ Tests written for the tenant-scoped queries and the purge arm (both mocked and live-DB).
- ✅ No `any`. No silent catches — the two `42P01` swallows in test teardown are narrow (`if (code !== '42P01') throw`) and documented.
- ✅ No new top-level directory. No new production file, so `docs/directory.md` correctly needs no row (`ci:directory-map` passes; the audit excludes `__tests__/` and `*.test.*` at `directory-map-audit.ts:71`).
- ✅ String-literal rule: the seven lanes / eight categories are re-typed locally in the suite, but with an explicit comment naming the future owner (`src/lib/refusals/vocabulary.ts`, #1009) and the obligation to derive from it. See §5 finding A6 for the residual risk.
- ✅ `new-migration` conventions: single `BEGIN;`/`COMMIT;`, `SET LOCAL lock_timeout`, `IF NOT EXISTS` on every object, no `CONCURRENTLY`, LOCAL-ONLY marker present in `migrations-log.md`, head bumped 115→116.

**Non-obvious gotchas:**

- ✅ *`ON CONFLICT` must match the partial-index predicate byte-for-byte* — the migration says so in the index comment and the suite proves it end-to-end at `:1034` by running the `ON CONFLICT` inside `sql().begin` and then issuing a second statement in the same transaction. That is the correct proof shape: a failed inference raises `42P10` and poisons the transaction, so the surviving `SELECT` is what makes "DO NOTHING actually did nothing" falsifiable.
- ✅ *No run-time DDL in a live-DB file* — the suite asserts via `assertSchemaReady`; `ci:live-db-suites` passes and the file is correctly **absent** from `MIGRATION_SHAPE_FILES` (that allowlist is for suites that re-execute migration SQL through `db.unsafe()`).
- ✅ *`SELECT … FOR UPDATE` is a no-op outside `sql.begin()`* — not applicable, no row locks taken.
- ⚠️ *timestamptz microsecond truncation* — `occurred_at` is writer-supplied and will eventually be compared against a window derived from it by the #1009 `ArchivalPoller`. This is the #520 class. Nothing in **this** PR is wrong, but the retention arm in #1009 must use `date_trunc('milliseconds', occurred_at)` or keep `::text` end to end. Neither the migration comment nor the `migrations-log.md` retention row mentions it. Noted for #1009, not a finding here.

---

## 2. Deep-module discipline (`codebase-design` vocabulary)

The brief's framing is right: **every change here adds one member to an
existing list.** That is the cheapest possible shape and the branch takes it.

**Interfaces widened: none.**
`TENANT_TABLES`, `TENANT_SCOPE_COLUMNS`, `TABLE_DISPOSITIONS`,
`PURGE_VERIFICATION_TABLES`, the `verificationQuery` switch and
`runContentPurgeStage` each gain exactly one member. No signature changed. No
new parameter, no new optional field, no new boolean mode.

**Abstracted before a second caller: no.**
The one place where an abstraction *could* have been invented — a helper
wrapping "account-scoped absence count" — was correctly not invented. See below.

**One decision scattered across seams: partially, but forced.**
The decision *"the Refusal purge is account-scoped and must never join through
`businesses`"* is now restated as prose in five places:

| File | Form |
|---|---|
| `scripts/ci/tenant-tables.ts` | comment above the scope-column entry |
| `src/lib/account-offboarding/table-disposition.ts` | inside the `reason` string |
| `src/lib/account-offboarding/purge-verification.ts` | comment above the case |
| `worker/jobs/account-offboarding/purge-stages.ts` | comment above the `DELETE` |
| three test files | assertion comments |

This is **not** a finding against this PR. The five seams pre-exist and each is
independently forced by a CI audit
(`accountLinkedTablesFromMigrations()` → `TABLE_DISPOSITIONS` →
`verificationQuery` + `runContentPurgeStage`; `TENANT_TABLES` →
`rls-inventory.md`). Restating the *why* at each site is this repo's
established convention, and the alternative — stating it once and leaving four
sites bare — would be worse. It is recorded here because it is the honest
answer to "is one decision scattered across seams": yes, and the architecture
requires it.

**The one code-judo move considered and rejected.**
`verificationQuery` is a 49-case switch over ~700 lines. The repo already has a
parameterized helper for one shape — `absentByBusiness(tableName, accountId,
exec)` at `purge-verification.ts:757`, guarded by an
`ABSENT_BY_BUSINESS_TABLES` allowlist so the identifier interpolation is safe —
used by 10 cases. There is **no** `absentByAccount` twin, and roughly a dozen
cases hand-roll the identical
`SELECT COUNT(*) … FROM <t> WHERE account_id = $1::uuid`.

Extracting that twin would collapse ~12 cases into ~12 one-liners. It is a real
opportunity and it is **out of scope for this PR**: adding member #13 to an
existing hand-rolled family is the correct local move, and refactoring a
700-line switch inside a schema PR would bury the migration under unrelated
diff. Logged in the appendix as a standalone follow-up.

**Deepening the module: the schema does the work.**
The best structural property of this change is that five constraints do work a
TypeScript validator would otherwise do at eleven future call sites. C1's
`CASE … END IS TRUE` in particular converts "an eighth lane was added to the
column CHECK and forgotten in C1" from a silent acceptance into a rejection.
That is a deep-module move — the interface (an INSERT) stays trivial while the
implementation absorbs the whole invariant. It also creates the one genuinely
unusual test (title 7, structural via `pg_get_constraintdef`), and the suite
explains *why* behavioural proof is impossible rather than settling for a
weaker behavioural test. That reasoning is correct and worth preserving.

---

## 3. Migration comment calibration

The brief asked whether `116_refusal_events.sql`'s comments earn their length,
calibrated against 111 and 114 rather than a generic standard.

| Migration | Total lines | Comment lines | Comment ratio | Leading header |
|---|---|---|---|---|
| `110_solicitation_send_governors.sql` | 140 | 54 | 39% | — |
| `111_platform_halt_reason.sql` | 111 | 58 | 52% | 47 lines |
| `112_breaker_window_indexes.sql` | 45 | 37 | 82% | — |
| `114_solicitation_attribution.sql` | 119 | 64 | 54% | 29 lines |
| **`116_refusal_events.sql`** | **231** | **123** | **53%** | **61 lines** |

**The ratio is dead-centre house style.** 53% against 111's 52% and 114's 54%.
The absolute header is longer (61 vs 47/29), but 111 and 114 are a
constraint-only and a column-addition change respectively; 116 creates a
twelve-column table with five named CHECKs, three indexes and an RLS posture.
Per unit of schema, 116 is the *less* commented of the three.

Spot-checking whether individual comments restate the SQL or add something the
SQL cannot say:

- **`WHY TWO TIMESTAMPS`** — earns it. "The skew between them is the only measurement that would catch a writer stamping `occurred_at` with insert time" is a fact no reader recovers from `TIMESTAMPTZ NOT NULL` twice.
- **`WHY subject_id CARRIES NO FOREIGN KEY`** — earns it. The distinction between "points at nothing" and "the subject aged away", and why `ON DELETE SET NULL` collapses them, is invisible in the DDL.
- **`ORDERING IS LOAD-BEARING`** — earns it, and is the single most valuable comment in the file. A `42P01` in `runContentPurgeStage` terminalizes an offboarding that promoting 116 afterwards does not reopen. The comment names the mechanism (`markPurgeTerminalFailure` + `markOutboxFailed`) and closes the obvious wrong answer ("put it behind a flag" — a flag protects rows, a missing relation fails the parse).
- **C1's wrapper comment** — earns it. Explains both why the `IS TRUE` exists and why the constraint cannot be tested by inserting a row.
- **C5's comment** — earns its length; see the appendix for one framing nit.
- **`COMMENT ON COLUMN` block** — twelve comments, all substantive, and pinned by a test that requires all twelve non-empty. Slight overlap with the header block (the `occurred_at` / `created_at` distinction is stated in both), but the catalogue comments are visible to `\d+` and to anyone introspecting a production database who has no access to the migration file. The duplication is deliberate and correct.

**Verdict: no finding.** The comments are calibrated to this repo, not to a
generic standard, and the density matches the two named precedents almost
exactly.

---

## 4. Documentation blocks — do they assert anything the code does not support?

`migrations-log.md` (+112), `CONTEXT.md` (+12), `docs/adr/0023-*` (new, 219) and
`arch-review-log.md` (+1) were checked claim by claim against the tree.

**Claims verified TRUE:**

| Claim | Where asserted | Verified against |
|---|---|---|
| twelve columns | migrations-log, test header | migration: id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes, refusal_category, vocabulary_version, subject_type, subject_id, occurred_at, created_at = **12** ✓ |
| five named CHECKs + three column-level enum CHECKs | migrations-log | migration declares C1–C5 named, plus unnamed CHECKs on `refusal_source`, `refusal_category`, `subject_type` = **3** ✓ |
| "22 `AutoApprovalBlockReason` values" | migration comment, ADR §5, test comment | `worker/jobs/response-generation/auto-approval.ts:37` — counted **22** members ✓ |
| "22 promised tests, all present verbatim" | arch-review-log | 19 `it()` in the 116 suite + 1 each in `purge-verification.test.ts`, `table-disposition.test.ts`, `offboarding-lifecycle.integration.test.ts` = **22** ✓ |
| "a held draft is **subtracted** from the owner's pending count (`src/lib/dashboard/pending-count.ts`)" | ADR §Context | file exists; header comment reads "Excludes held/flagged drafts"; imports `openFlagExistsSql` from `@/lib/moderation/held-draft` ✓ |
| "`judge-store.ts` `WHERE r.status = 'posted'`" | ADR §2 | `src/lib/responses/judge-store.ts:115` ✓ |
| "`judge-policy.ts`" | ADR §2 | `src/lib/responses/judge-policy.ts` exists ✓ |
| "`WITHHOLD_REASONS` model" | ADR §3 | `src/lib/solicitation/restraint-policy.ts:45` ✓ |
| "`RESTRAINT_POLICY_VERSION` model" | migration comment | `src/lib/solicitation/restraint-policy.ts:42` ✓ |
| "`step-facts.ts`: a per-key allowlist" | ADR §1 | `src/components/dashboard/timeline/step-facts.ts` exists ✓ |
| "`accountLinkedTablesFromMigrations()` parses migration files" forces the disposition row | migrations-log, arch-review-log | `table-disposition.test.ts` completeness case passes with the new entry and would fail without it ✓ (verified by running the suite) |
| "`rls-audit.test.ts` asserts `REQUIRED_RLS_TABLES === TENANT_TABLES`" → forces the `rls-inventory.md` row | migrations-log | inventory row present ✓ |
| "`TENANT_TABLES` is two structures" | migrations-log, D11 | `scripts/ci/tenant-tables.ts` — the `as const` array **and** `TENANT_SCOPE_COLUMNS`; both edited ✓ |
| deny-all RLS, zero policies | migration, ADR §5, rls-inventory | `ENABLE ROW LEVEL SECURITY` with no `CREATE POLICY` ✓; pinned by the suite's first case |
| "Postgres normalises a `CASE` with no `ELSE` into `ELSE NULL::boolean`" | arch-review-log, test comment | consistent with the test asserting *presence*; the D12 record documents the first-run failure that produced this correction ✓ |

**Claims NOT supported by code, and how they are marked:**

- **"`occurred_at` > 180 days → deleted"** (`migrations-log.md`, retention inventory). Nothing in the branch implements or even mentions 180 days — the migration ships only the index. The same row's right-hand column says **"NOT YET ENFORCED"** in bold and names #1009 as the owner, so the claim is caveated in place rather than asserted as current behaviour. Acceptable, but see appendix A5: the retention inventory is an inventory of *current* behaviour, and a future policy stated in its left column is the kind of row that gets quoted later without the caveat.
- **"The **Restraint tab** reads through a server route that projects the category, `occurred_at` and the link target only"** (`rls-inventory.md`, ADR §5). Present tense for something #1014 builds. Consistent across both documents and unambiguous from context. Appendix A5.
- **"the eleven writers #1010–#1013"** (`arch-review-log.md:1420`) contradicts the migration header and `migrations-log.md`, which both put "the first caller" in #1009 and "the other ten write sites" in #1010–#1013. Finding 6.

**One doc that contradicts the schema it documents:** the LOCKED term
**Refusal source**. See finding 5.

---

## 5. The test suite

Compared against its stated precedent,
`migration-114-solicitation-attribution.integration.test.ts`.

### Size — not a finding

| | 114 | 116 |
|---|---|---|
| Total lines | 500 | 1094 |
| `it()` cases | 4 | 19 |
| Lines / case | 125 | 58 |
| Preamble before `describeWithDb` | 294 | ~450 |

116 is 2.2× the precedent in lines but **4.75× in cases**, so lines-per-case
is less than half. Against the repo's other migration-shape suites it is third
largest, behind `migration-091-send-mode-spine` (1378) and
`migration-077-copilot-autopilot` (1306) — both, like 116, new-table
migrations. The thermo-nuclear 1k-line rule is technically crossed by a new
file, but the justification is strong and the precedent explicit: **no finding.**

### Structure — good, and better than the precedent in two ways

1. **The three assertion styles are declared up front** (structural / file-text / behavioural) with a per-title justification for which style each case uses. 114 has no such map. This is the single most useful thing in the file for a future maintainer.
2. **Every rejection asserts `constraint_name`**, never merely "something threw" (`expectRejectedBy`, `:391`). The one case where a single name is impossible — the `subject_type` probe at `:1024`, which violates both `C1` and the column CHECK and whose winner depends on evaluation order — is handled with an explicit two-name regex *and* a comment explaining that the ambiguity is a property of the schema rather than a weakness of the test. That is the correct call; weakening it to `.rejects.toThrow()` would have been the lazy one.
3. `CANONICAL` (`:209`) is a genuinely good fixture design: one legal row per lane, so a case that overrides exactly one field isolates the constraint it targets. `resolveRefusalRow` honours an explicit `null` and falls back only on `undefined`, which is what makes "remove this field" expressible. The triple-nested ternaries at `:318-343` are dense but each is doing real work.

### Findings

#### F1 — `:712` title over-claims: "the only retention clock" is not asserted (MEDIUM)

```
it('migration 116 comments the table and all twelve columns, and names occurred_at as the only retention clock', ...)
```

Body:

```ts
const occurredAt = byColumn.get('occurred_at') ?? '';
expect(occurredAt).toMatch(/retention/i);      // :739
expect(occurredAt).toContain('occurred_at');

const createdAt = byColumn.get('created_at') ?? '';
expect(createdAt).toMatch(/retention/i);       // :743
expect(createdAt).toContain('occurred_at');
```

`/retention/i` matches the current `created_at` comment ("**NOT** a retention
candidate") and would equally match its exact negation ("`created_at` **is** a
retention candidate alongside `occurred_at`") — which also still contains the
literal `'occurred_at'`, satisfying the second assertion too. The word "only",
which is the whole claim of the title and the load-bearing fact of ADR 0023
§"`created_at` is not a retention clock", **cannot fail this test**.

The fix is one line: assert the negation on `created_at`, e.g.
`expect(createdAt).toMatch(/not a retention/i)` — or, more robustly, assert that
exactly one of the twelve comments contains the phrase "retention clock".

Standard violated: the brief's own bar — "any test whose title over-claims what
its body checks". Concrete maintenance failure: the migration comment is the
*only* place the one-clock rule is written down for a future #1009 author
(nothing in TypeScript owns it yet), and this test is the only thing guarding
that comment.

#### F2 — `:345` / `:370` duplicated 14-line INSERT (MEDIUM)

`insertRefusal` and `insertRefusalIgnoringConflict` are byte-identical except
for one trailing line:

```sql
ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING
```

The 11-column column list and the 11-expression `VALUES` list (with their
`::uuid` / `::text[]` casts) are written out twice. A third, differently-shaped
copy of the same INSERT exists in
`worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`
`seedRefusalEvent` — three copies of one table's write shape in one PR.

Adding, renaming or re-typing a `refusal_events` column — which #1009–#1013 are
explicitly expected to do around `all_refusal_codes` — requires editing all
three in lockstep, and nothing fails if only two are updated (the second
function is used by four cases, so a divergence surfaces as a confusing
constraint error rather than a compile error).

The suite already knows the right tool: `countRefusals` at `:404` composes a
Postgres.js fragment built at the call site, and its JSDoc explains the pattern.
The same move applies here — one `insertRefusal(input, { exec, onConflict })`,
or an interpolated conflict fragment defaulting to an empty one.

Standard violated: Fowler *Duplicated Code*; thermo-nuclear "copy-pasted logic
instead of extracted helpers".

#### F3 — `:571` / `:605` / `:977` the `created_at` contract is under-asserted (LOW)

Two related gaps around the column ADR 0023 leans on hardest:

- **`:605`** — the title claims "exact types, nullability and **defaults**", but the shape assertion carries only `hasDefault: true`. The default *value* is never read. Changing `DEFAULT NOW()` to `DEFAULT '2000-01-01'::timestamptz` keeps this suite green — and `created_at`'s only stated purpose is that its skew from `occurred_at` is the diagnostic that would catch a mis-stamping writer, which a constant default destroys.
- **`:977`** — `expect(rows.every((row) => row.created_at instanceof Date)).toBe(true)` cannot fail. `created_at` is `timestamptz NOT NULL` (already pinned at `:605`) and postgres.js decodes `timestamptz` to `Date` unconditionally; `rows` is non-empty by the assertion above it. The adjacent comment claims it proves "the DEFAULT filled it" — it does not; the INSERT *succeeding* without the column proves that, and the assertion adds nothing.

One assertion covers both: read `column_default` for `created_at` and match
`/now\(\)/i`.

Standard violated: the brief's "assertions that cannot fail".

#### F4 — `:554-556` dead column in the RLS query (LOW)

```ts
const [relation] = await sql()<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
  SELECT relrowsecurity, relforcerowsecurity FROM pg_class
```

`relforcerowsecurity` is selected and typed and then never asserted. Either
drop it, or assert it — the latter is a real decision, not a nit: the workers
write this table through the RLS-bypassing `postgres` role, so
`relrowsecurity` alone constrains only `authenticated`/`anon`. If that
asymmetry is the intent (it is, and it matches the `judge_verdicts` /
`auto_approval_policies` posture), pinning `relforcerowsecurity === false` with
a one-line comment states it; selecting it and ignoring it states nothing.

Standard violated: thermo-nuclear "direct, boring, maintainable" — dead code in
a brand-new file.

#### F5 — `CONTEXT.md:163` the LOCKED term **Refusal source** names a pair; the column of that name holds half of it (LOW)

`CONTEXT.md:163` (added by this branch):

> **Refusal source**: the lane a **Refusal** came from **plus the verbatim code**
> it carries inside that lane…

`docs/adr/0023-*` §3 repeats it verbatim ("**Axis B** — **Refusal source**, the
lane plus the verbatim code"). But the column named `refusal_source` holds only
the lane — `supabase/migrations/116_refusal_events.sql:179`:

> `COMMENT ON COLUMN refusal_events.refusal_source IS 'The lane. …'`

— with the code in a separate `refusal_code` column. The same `CONTEXT.md`
paragraph then enumerates "SEVEN lanes" as if they *are* the Refusal sources,
so the entry reads two ways within itself.

`_Avoid_` compliance is otherwise clean: a scan of the whole code/SQL diff for
`refusal type`, `refusal origin`, `refusals dashboard`, `restraint report`,
`blocked reason`, `reason group`, `what we blocked` returns nothing. This is not
a wrong-word violation; it is a **term that denotes a pair while a column of the
identical name denotes one element of it.**

Concrete maintenance failure: a #1009 writer or an admin support query built
from the glossary will select `refusal_source` believing it carries the code.
One clause in the `CONTEXT.md` entry fixes it — e.g. "…stored as two columns,
`refusal_source` (the lane) and `refusal_code` (the verbatim value)".

#### F6 — `.claude/reference/arch-review-log.md:1420` writer count contradicts the other two docs (LOW)

The entry says "the insert helper is #1009, **the eleven writers #1010–#1013**".
Both `supabase/migrations/116_refusal_events.sql` (header) and
`.claude/reference/migrations-log.md` say the insert helper **and the first
caller** land in #1009 and "**the other ten** write sites in #1010–#1013".
Eleven writers total either way, but the arch-review-log entry attributes all
eleven to #1010–#1013 and thereby understates #1009's scope — which matters,
because #1009 is the slice that also carries the `ArchivalPoller` arm and the
kill switch.

Standard violated: `.claude/CLAUDE.md` — one authoritative owner per fact.

---

## 6. Fowler smell baseline

### Changed TypeScript

| Smell | Present? | Note |
|---|---|---|
| Duplicated Code | **yes** | F2 — the two INSERT helpers, plus the third copy in `seedRefusalEvent`. |
| Long Function | no | Longest new function is `resolveRefusalRow` (26 lines, mostly a field-per-line object literal). |
| Long Parameter List | no | Every new function takes ≤ 3 params or one object. |
| Large Class / File | borderline, justified | `migration-116-…test.ts` 1094 lines — third-largest migration suite, best lines-per-case ratio of the top three. `purge-verification.ts` grows 623→633, still under its existing size. |
| Divergent Change | no | Each touched file gains one member of the thing it already enumerates. |
| Shotgun Surgery | **structural, pre-existing** | Adding a table forces five registry edits. Not introduced here — see §2. |
| Feature Envy | no | — |
| Data Clumps | minor | `(refusalSource, subjectType, subjectId)` travels together through the fixtures; `CanonicalLane` already models it, so this is the *cure* rather than the smell. |
| Primitive Obsession | no | Lane / category / subject-type are `as const` tuples with derived types. |
| Switch Statements | **pre-existing** | 49-case `verificationQuery`. One member added; see §2 for the rejected refactor. |
| Speculative Generality | **minor** | F4 (`relforcerowsecurity` selected, unused). Also `Number(row?.count ?? -1)` at `:410` and `:1047` — `COUNT(*)` always returns exactly one row, so the `-1` sentinel is unreachable. Harmless and consistent with the sibling helper; noted, not raised. |
| Comments-as-deodorant | **no** | Checked explicitly. The heavy commenting is explanatory of *why*, not compensating for unreadable code. |
| Message Chains / Middle Man | no | — |
| Temporary Field | no | The module-level `db` / `tenant` / `seededBusinessId` are guarded by throwing accessors (`sql()`, `seededTenant()`, `accountId()`, `locationId()`) — the same pattern as the 114 precedent. |

### Migration SQL

| Smell | Present? | Note |
|---|---|---|
| Duplicated constraint logic | no | Each of C1–C5 owns a disjoint invariant; no two overlap. |
| Magic values | no | Every literal is a vocabulary member declared in the same statement. |
| Missing index for a stated access path | no | Three indexes, each with a named consumer; the suite pins that there are exactly three plus the pkey and rejects a fourth ("an unclaimed index on a no-TTL table is write cost nobody is measuring"). |
| Over-constraining | no | `all_refusal_codes` members are deliberately *not* CHECKed against `AutoApprovalBlockReason` — the reasoning ("that enum lives in TypeScript and has no migration owner, so spelling it here would create a second authority that drifts") is correct and is itself pinned by a behavioural test at `:920`. |
| Under-constraining | no | C1–C5 close every combination the map declares invalid, including the `IS TRUE` wrappers for the NULL class. See appendix A1 for one framing nit about C5's comment. |
| Non-atomic DDL | no | Single `BEGIN;`/`COMMIT;` with `SET LOCAL lock_timeout`, pinned by test title 6. |

---

## Appendix — low-confidence / out-of-scope observations

*Nothing here meets the ≥80% bar. Recorded so it is not re-derived next time.*

**A1 — C5's comment slightly overstates which clause closes the cited hole.**
The migration says "TWO CLAUSES … BOTH ARE LOAD-BEARING. Without them this
CHECK ADMITS the exact row it exists to forbid", then names
`refusal_code = 'winner'` vs `all_refusal_codes = ARRAY['different', NULL]`.
For *that* row, `array_position(…, NULL) IS NULL` alone suffices: it evaluates
`FALSE`, and SQL three-valued `AND` gives `TRUE AND TRUE AND TRUE AND FALSE AND
NULL = FALSE`, so the arm is `FALSE`, not `NULL`, and the row is rejected with
or without the outer `IS TRUE`. The `IS TRUE` closes a *different* NULL case
(`refusal_code IS NULL` with a NULL-free array) which C4 independently rejects
anyway. The wrapper is good defensive practice and consistent with C1, and the
sentence is literally true of the pair ("without **them**"), so this is a
framing nit rather than an error. Same framing is repeated in
`migrations-log.md` and `arch-review-log.md` ("Two clauses close it").

**A2 — `absentByAccount` is the missing twin of `absentByBusiness`.**
`purge-verification.ts:757` has a parameterized, allowlist-guarded helper for
the business-scoped shape used by 10 cases. Roughly a dozen other cases
hand-roll the identical account-scoped `SELECT COUNT(*) … WHERE account_id =
$1::uuid`, including the new `refusal_events` one. A symmetric
`absentByAccount(tableName, accountId, exec)` with its own
`ABSENT_BY_ACCOUNT_TABLES` set would collapse them. **Explicitly out of scope
for this PR** — adding member #13 to an existing family is correct, and
refactoring a 700-line switch inside a schema change would bury the migration.
Worth a standalone ticket.

**A3 — `seedRefusalEvent` writes `NOW()` for `occurred_at`.**
`offboarding-lifecycle.integration.test.ts` seeds `occurred_at` with SQL
`NOW()`, the exact form the migration header forbids ("No writer may pass
`NOW()` for `occurred_at`: `NOW()` is a write timestamp wearing a decision
timestamp's name"). It is a test fixture, not a writer, so the rule does not
strictly bind — but it is the copy a #1010–#1013 author will find and imitate.
A `new Date()` bind (as the 116 suite uses) would cost nothing and would not
model the forbidden shape.

**A4 — the locally re-typed vocabulary has no forcing function.**
`REFUSAL_SOURCES` / `REFUSAL_CATEGORIES` / `SUBJECT_TYPES` are declared in the
suite with a comment promising they will be derived from
`src/lib/refusals/vocabulary.ts` once #1009 ships it. Nothing enforces that.
After #1009 the suite would compare its own hard-coded list to the DB CHECK and
stay green even if the new TypeScript module drifted from both. #1009 is
expected to bring its own exhaustiveness test, so the exposure is short-lived —
but the promise is a comment, not a mechanism.

**A5 — two forward-looking claims stated in the present tense.** The
`migrations-log.md` retention row's left column asserts "`occurred_at` > 180
days → deleted" (nothing implements it; the right column says NOT YET
ENFORCED), and `rls-inventory.md` says "the Restraint tab reads through a
server route that projects the category, `occurred_at` and the link target
only" (#1014). Both are internally caveated or unambiguous in context. The
retention row is the riskier of the two, because that table is an inventory of
*current* behaviour and gets quoted without its right-hand column.

**A6 — `CONCURRENTLY` is checked against the raw file, not the stripped one.**
Test title 6 (`:457`) computes `withoutComments`, uses it for five assertions,
then checks `expect(migrationSql).not.toMatch(/\bCONCURRENTLY\b/)` against the
*commented* text. Adding an explanatory comment saying "never `CONCURRENTLY`"
— which `migrations-log.md` already says in prose — would fail the test. One
character (`withoutComments`) fixes the inconsistency.

**A7 — `#520` microsecond truncation is a live hazard for #1009, not for this
PR.** `occurred_at` is writer-supplied and the #1009 `ArchivalPoller` will
compare it against a window derived from it. Neither the migration comment nor
the retention row mentions `date_trunc('milliseconds', …)`. Worth carrying into
#1009's plan.

**A8 — the suite's title numbering is plan-order, not file-order.** Titles 6
and 19 are the first two `it()` blocks in the file (they live outside
`describeWithDb`), and the header comment's "structural (1, 2, 3, 4, 5, 7)"
map is only resolvable by cross-referencing the plan. Every internal
cross-reference checked out (title 7 → C1 structural, title 13 → the
TypeScript-owned members case, title 14 → the seven-lane case that reads
`created_at` back, titles 16–18 → the three index cases), so this is accurate,
just indirect. A one-line "titles are plan numbers; file order differs" would
save the next reader the reconciliation.
