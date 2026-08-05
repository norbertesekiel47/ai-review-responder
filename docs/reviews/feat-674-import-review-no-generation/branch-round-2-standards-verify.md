# feat-674-import-review-no-generation — Standards axis, round 2 (verification-only)

**Reviewer role:** Standards & maintainability, round 2 — verification of round 1's dispositions
**Fix commit under verification:** `a720a801` (plus `8cab463a`, docs-only D16)
**Diff verified:** `b6d841f8..HEAD`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation`
**Scope:** verification only. No new fronts opened against unchanged code; unrelated
observations are in the appendix, marked untriaged.

---

## Findings

| Severity | Location | Finding |
|---|---|---|
| LOW | `src/lib/reviews/__tests__/import-review.integration.test.ts:69` | The S2 fix asserts `MIGRATION_071_RUN_SPINE` only, but `importReview` → `startReviewRun` → `startOrGetActiveRun` writes `agent_runs.parent_run_id`, added by migration **088** (`supabase/migrations/088_solicitation_batch_executor.sql:21`) and covered by `MIGRATION_088_SOLICITATION_BATCH_EXECUTOR`, not by 071. A container at head 071–087 passes the assertion and then fails at `it` #1 with `column "parent_run_id" of relation "agent_runs" does not exist` — the raw-Postgres-error mode S2 exists to eliminate. |

That is the only item at ≥80% confidence. Everything else below is a VERIFIED/sound record.

---

## 1. Did the S2 fix land correctly and completely?

**VERIFIED, with one incompleteness (the finding above).**

### 1a. Placement — VERIFIED

`import-review.integration.test.ts:63-83`:

```
63  beforeAll(async () => {
64    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
69    await assertSchemaReady(db, [MIGRATION_071_RUN_SPINE]);
70    tenant = await seedTenantAccount(db, { … });
75    await sql()`INSERT INTO businesses (…)`;
```

The call is the **first statement after the connection opens**, ahead of `seedTenantAccount`, ahead
of the `businesses` INSERT, and ahead of every `agent_runs` / `agent_run_steps` touch (the earliest
is inside `importReview` at `:101`; `afterAll:89-92` is later still). A behind-head DB now fails at
`:69` rather than in `afterAll` cleanup. Correct placement — this is exactly what round 1 asked for.

### 1b. Requirement coverage — INCOMPLETE (the finding)

Objects the suite touches, and the migration that owns each:

| Object | Owning migration | Covered by the assertion? |
|---|---|---|
| `agent_runs` (read `:147-152`, delete `:92`) | 071 | yes |
| `agent_run_steps` (read `:164-166`, delete `:89-91`) | 071 | yes |
| `reviews`, `businesses`, `provider_review_name` | 001 | transitively (ordered application) |
| `reviews.sentiment_score/label/source` (`:118-121`) | 052 | transitively |
| `job_outbox` (`:175-177`) | 004 | transitively |
| `analytics_events` (`:88`), `first_review_ingested` name | 046 | transitively |
| **`agent_runs.parent_run_id`** — written by `run-spine.ts:118-125` on every `startOrGetActiveRun` | **088** | **no** |

Everything below 071 is fine under the file's own stated convention (`schema-ready.ts:193-196`,
"The migration's LAST statement, so its presence implies the whole file") — migrations apply in
order, so `agent_runs` existing implies 001/004/046/052 ran. That argument does **not** run
upward. 088 is *newer* than 071, so 071's presence proves nothing about `parent_run_id`.

Chain, verified in code rather than assumed:

- `process-review.ts:536-541` — `importReview` calls `startReviewRun(tx, { … stepKey: 'review_ingested' })`
- `process-review.ts:198-205` — `startReviewRun` calls `startOrGetActiveRun(tx, …)`
- `src/lib/agents/run-spine.ts:118-125` — `INSERT INTO agent_runs (id, account_id, business_id, kind, subject_type, subject_id, status, correlation_id, parent_run_id)`
- `supabase/migrations/088_solicitation_batch_executor.sql:21` — `ADD COLUMN IF NOT EXISTS parent_run_id UUID;`
- `schema-ready.ts:204-208` — `MIGRATION_088_SOLICITATION_BATCH_EXECUTOR` names `agent_runs.parent_run_id`

**Honest calibration, which is why this is LOW and not MEDIUM.** The identical gap exists in the
closest precedent: `src/lib/approval/__tests__/owner-decision-outcomes.integration.test.ts:47`
asserts `[MIGRATION_071_RUN_SPINE]` alone and then calls `startOrGetActiveRun` at `:64`. The two
suites in the repo that *do* name 088 (`src/lib/agents/__tests__/run-spine.integration.test.ts:92-95`,
`worker/background/pollers/health-alert/__tests__/checks.integration.test.ts:219-222`) name it
because they test 088/091 features directly, not because of this transitive write. So the new suite
is consistent with existing practice; this is a one-token improvement
(`assertSchemaReady(db, [MIGRATION_071_RUN_SPINE, MIGRATION_088_SOLICITATION_BATCH_EXECUTOR])`),
not a defect the branch introduced. It is recorded because round 1's stated goal for S2 was
"a behind-head container fails loudly by name", and for the 071–087 window it still does not.

### 1c. Import path and helper API match the repo convention — VERIFIED

`:20-23` imports `{ assertSchemaReady, MIGRATION_071_RUN_SPINE }` from
`@/lib/shared/__tests__/helpers/schema-ready` — same path, same named exports, same
`await assertSchemaReady(db, [...])` shape, same position in `beforeAll` as
`owner-decision-outcomes.integration.test.ts:47` and `transitions.integration.test.ts:88`. It
passes the raw `db` handle rather than the `sql()` accessor, which is correct here (`db` is
assigned on the line above) and matches the precedents.

### 1d. Nothing new introduced — VERIFIED

`git diff b6d841f8..HEAD -- src/lib/reviews/__tests__/import-review.integration.test.ts` is
**+9 lines, −0**: a 4-line import block and a 5-line addition in `beforeAll` (4 comment lines + the
call). No assertion changed, no fixture changed, no `it` block changed, no timeout changed. The only
other code-surface change in the range is `src/lib/reviews/process-review.ts` +17/−6 — entirely
inside the `importReview` JSDoc `KNOWN HAZARD` block (the A1 characterization correction). Zero
executable lines changed in production code. Everything else in the range is `docs/`.

---

## 2. Are the four rejections defensible?

### S1 (order-coupled `it` blocks) — **SOUND**, with a citation caveat

The triage's primary citation is the plan at
`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:817`:

> Note the four `it` blocks run in file order and share state deliberately … Do not add `beforeEach`
> isolation — the shared fixture *is* the scenario.

Read literally, that sentence forbids `beforeEach` isolation; round 1's remedy was a `beforeAll`
hoist, which the sentence does not name. So "the plan locks this explicitly" is slightly stronger
than the text supports for the *specific* remedy proposed.

The triage's **second** reason is the one that actually carries it, and it holds: hoisting the
`importReview` call into `beforeAll` makes `it` #1 — whose intake-locked title is *"importReview
stores the review against the live schema and returns new"* — assert a return value produced outside
itself, parked in a module-level `let`. Round 1 conceded that mechanism in its own remedy text. That
is a real trade, not a free win, and for a 4-test suite whose four cases genuinely are one narrative
(import → observe → observe → re-import) the shipped shape is a defensible choice. The diagnostic
cost is real and confined to interactive debugging; carrying it to #675 if the suite grows is the
right disposition.

### S3 (test file crosses 1k lines) — **SOUND**

Round 1 itself scored the crossing as waivable and did the option analysis: the obvious split
(Option B) trades 12 duplicated lines for 33, and Option C requires editing the block whose
byte-for-byte immutability is this ticket's regression evidence. The triage adopts that analysis
rather than inventing a new one, and explicitly refuses to let it be re-waived silently at #675.
Verified current state: `process-review.test.ts` is 1020 lines, unchanged by the fix commit;
`process-review.ts` is 551 (was 542 — the +9 is the JSDoc), still far under any threshold. Nothing
about the fix commit worsens the crossing.

### S4 (`insertNewReviewRow` returns `Promise<number>`) — **SOUND** in outcome; one supporting claim is overstated

Plan-lock verified verbatim: `2026-08-05-674-import-review-no-generation.md:387-392` specifies

```ts
async function insertNewReviewRow(
  tx: TxClient, reviewId: string, businessId: string, monitored: MonitoredReview,
): Promise<number>
```

and `process-review.ts:144-149` matches it exactly. The rejection's core reasons — plan-locked,
survived three plan-review rounds, LOW design nicety, post-gate churn, recorded for #675 — are
sound, and the triage concedes the reviewer is right on the principle.

The one supporting claim I would not repeat: *"changing it ripples into the canonical-order binding
test."* The relevant assertion is `process-review.test.ts:890-893` —
`expect(typeof params[0]).toBe('string')` over the INSERT's first binding. Moving the `uuidv7()`
mint inside the helper changes **where** the id comes from, not that `params[0]` is a uuid string, so
the assertion survives; only the explanatory comment at `:891` ("the uuidv7 PK minted inside
`importReview`") would need a word changed. The rejection stands on its other legs; that leg is
weaker than stated.

### S5 (`docs/directory.md` stale) — **SOUND**, and the surface claim is **VERIFIED TRUE**

`.feature/intake.json` → `allowed_edit_surface` contains exactly seven entries:

```
src/lib/reviews/process-review.ts
src/lib/reviews/__tests__/process-review.test.ts
src/lib/reviews/__tests__/import-review.integration.test.ts
CONTEXT.md
docs/superpowers/specs/2026-08-05-consented-review-import-design.md
docs/superpowers/plans/**
docs/reviews/**
```

`docs/directory.md` matches none of them — not literally, and not through either glob
(`docs/superpowers/plans/**`, `docs/reviews/**`). The claim is true.

The D8 claim is also true and is stronger than the triage summarizes.
`feat-674-import-review-no-generation-deviations.md:252-280` records amendment #2 (adding the
integration suite to the surface) as having already flirted with the step-5 teardown trigger, closing
with: *"The amendment budget is now exhausted. Any third `allowed_edit_surface` change during
implementation is a genuine signal and MUST trigger the abort path — no further reasoning-around."*
Patching `docs/directory.md` in step 7 would be that third change. Deferring to step 8's
`document-feature` sweep — which owns `docs/directory.md` by design — is the correct handling, and
round 1's own report already offered that caveat.

(Note for the orchestrator, not a finding: this report itself lands under `docs/reviews/**`, which
**is** in the surface, so writing it spends no amendment.)

---

## 3. Did anything regress?

**VERIFIED — nothing regressed.**

| Check | Command | Result |
|---|---|---|
| Integration suite genuinely **ran**, not skipped | `TEST_DATABASE_POOL_URL=… pnpm vitest run --reporter=verbose src/lib/reviews/__tests__/import-review.integration.test.ts` | **4 passed**, all four `it` titles printed with the `\|integration\|` project tag — no skip |
| Unit suite for the same module | `TEST_DATABASE_POOL_URL=… pnpm vitest run …/process-review.test.ts` (with the integration file) | 2 files, **41 passed** |
| Whole repo | `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test` | **819 files passed, 57 skipped; 10711 tests passed**, 0 failed |
| Typecheck | `pnpm typecheck` | clean |
| Lint | `pnpm lint` | clean |
| `ci:live-db-suites` | | passed |
| `ci:static-policy` | | passed (1119 files scanned) |
| `ci:outbox-seam` | | passed (15 helper-owned topics; no bypass) |
| `ci:outbox-status` | | passed (1077 TS + 99 migration files) |
| `ci:db-imports` | | passed (strict) |
| `ci:tenant-scope` | | passed — 420 entries, baseline 420 (unchanged) |
| `ci:rls-audit` | | static coverage passed (43 tenant tables) |
| Worktree state | `git status --short` | clean — this review edited nothing |

The `assertSchemaReady` addition did not perturb `ci:live-db-suites` (it is a read-only
`information_schema` query, not migration SQL, so the #573 rule is respected) and did not move the
tenant-scope baseline.

---

## Appendix — untriaged, out of round-2 scope

Recorded only so they are not lost; **none of these are round-2 findings** and none were opened
against this round's fix.

- **U-1.** `assertSchemaReady` runs before `seedTenantAccount`, so a DB missing the *tenant* seed
  tables would still fail as a raw error. No requirement constant models the base schema, so there
  is nothing to assert — repo-wide, not this branch.
- **U-2.** `owner-decision-outcomes.integration.test.ts:47` has the same 088 gap as the finding
  above. Pre-existing, unchanged code, outside this branch's diff — noted only because it is what
  makes the finding LOW rather than MEDIUM.
- **U-3.** `owner-decision-outcomes.integration.test.ts:9` still carries a stale header comment
  ("Migration 071 is applied idempotently in beforeAll") that its own `assertSchemaReady` call
  contradicts. Unchanged code, unrelated file.
- **U-4.** Round 1's appendix items A-1 through A-7 were below the confidence bar and were not
  re-litigated here. A-5 (the bare `deviations D4` label at `process-review.ts:505`) survives the
  fix commit — the rewritten hazard block still cites the label without a path.

---

## Verdict

**PASS.** The S2 fix landed correctly, in the right place, using the repo's helper API, and
introduced nothing beyond +9 lines in the target file. All four rejections are defensible on their
recorded reasoning (two with a noted caveat on one supporting claim each, neither of which changes
the outcome). The S5 surface claim is verified true against `.feature/intake.json` and D8. No
regression: full suite, typecheck, lint, and all seven audits green. One LOW finding — the schema
requirement is one migration short of what the code under test writes.
