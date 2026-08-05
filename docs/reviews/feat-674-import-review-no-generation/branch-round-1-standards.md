# feat-674-import-review-no-generation — Standards & maintainability review (branch round 1)

**Reviewer role:** Standards & maintainability (step 7, round 1)
**Skill applied:** `thermo-nuclear-code-quality-review`
**Diff under review:** `6bd45cfe..HEAD` (fork point = `origin/main`)
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation`
**Read before reviewing:** `docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md` (15 entries, all ACCEPT)

**Production surface:** `src/lib/reviews/process-review.ts` (451 → 542 lines)
**Test surface:** `src/lib/reviews/__tests__/process-review.test.ts` (790 → 1020 lines, modified),
`src/lib/reviews/__tests__/import-review.integration.test.ts` (195 lines, new)
**Docs surface:** `CONTEXT.md` (+1 glossary entry)

---

## Verdict

**No structural regression. No spaghetti growth. No boundary leak. No glossary violation.**

This is a disciplined keystone change. The extraction is the minimum that makes two entry points
share one INSERT; the new public function is genuinely narrow relative to the work it does; the
biggest pre-existing smell in the file (`processExistingReview`, ~220 lines) was correctly left
alone rather than opportunistically refactored inside a "no behaviour change" ticket. The five
findings below are all LOW/MEDIUM maintainability items — none of them blocks the merge on
standards grounds.

Static audits re-run independently as evidence:

| Audit | Result |
|---|---|
| `pnpm ci:live-db-suites` | passed |
| `pnpm ci:outbox-seam` | passed (15 helper-owned topics; no bypass) |
| `pnpm ci:static-policy` | passed (1119 files scanned) |
| `pnpm ci:tenant-scope` | passed (420 entries, baseline 420 — no new cross-tenant query) |
| `pnpm ci:rls-audit` | static coverage passed |

---

## Findings

| Severity | Location | Finding |
|---|---|---|
| MEDIUM | `src/lib/reviews/__tests__/import-review.integration.test.ts:137`, `:161`, `:177` | Three of four `it` blocks depend on `it` #1 having already run — `it` #1 is both the fixture producer and an assertion. |
| LOW | `src/lib/reviews/__tests__/import-review.integration.test.ts:59-74` | New live-DB suite does not call `assertSchemaReady`, so a behind-head test DB fails as a raw Postgres error instead of the actionable re-provision message. |
| LOW | `src/lib/reviews/__tests__/process-review.test.ts` (790 → 1020 lines) | The PR pushes a file from under 1000 lines to over 1000 lines — the review skill's named presumptive blocker. |
| LOW | `src/lib/reviews/process-review.ts:144` | `insertNewReviewRow` returns `Promise<number>`, leaking the `ON CONFLICT` row-count mechanism into both callers and forcing each to mint its own `uuidv7()`. |
| LOW | `docs/directory.md:569` | The module's code-map description still describes only `processReview`; the second exported entry point and the new integration suite are absent. |

---

### 1. MEDIUM — order-coupled `it` blocks in the one suite that is the executable proof

`src/lib/reviews/__tests__/import-review.integration.test.ts:91` (`it` #1) performs the only
`importReview` call that creates the fixture row. The next three tests read state it produced:

- `:137` — `it('…leaves the agent run terminal…')` selects the `agent_runs` row created by `it` #1.
- `:161-168` — `it('…writes no job_outbox row…')` does `SELECT id FROM reviews …` then dereferences
  `reviewRow!.id`.
- `:177` — `it('…is idempotent on a second call…')` asserts `rows`/`runs` have length 1, which only
  holds if exactly `it` #1 ran before it.

**Concrete failure scenario.** `.claude/CLAUDE.md` explicitly instructs developers to run these
suites individually: *"When touching governor/judge/publisher paths, run the matching integration
file explicitly with `TEST_DATABASE_POOL_URL` set."* A developer narrowing to one case —
`pnpm vitest run <file> -t 'writes no job_outbox'`, or an `it.only` while debugging — gets
`TypeError: Cannot read properties of undefined (reading 'id')` at line 167, which reads as a bug in
the test harness, not as "you filtered out the fixture." Worse, a single real regression in
`importReview` (say it starts returning `'unchanged'` on a fresh insert) fails `it` #1 *and*
cascades into three misleading secondary failures, burying the one root cause under noise.

**Named standard / precedent.** The suite this file was modelled on —
`src/lib/agents/__tests__/read.integration.test.ts`, which the branch cites in D15 as its precedent
— seeds *everything* in `beforeAll` (lines 49-221) and keeps all four `it` blocks independent. The
new suite diverges from that precedent in exactly the direction that costs debuggability.

**Remedy.** Move the `importReview(…)` call for the base fixture into `beforeAll`, keep `it` #1 as a
pure assertion over the row it produced. `it` #4 (idempotency) then calls `importReview` a second
time and is genuinely self-contained. Net cost: ~4 lines moved. This does not weaken any assertion —
the return value of the seeding call can be captured in a module-level `let` and asserted in `it` #1
exactly as today.

This is not covered by deviations D1-D15; the recorded reasoning about test duplication (D-decision
#1 in the review brief) is about the *unit* suite's tx harness, a different file and a different
concern.

---

### 2. LOW — new live-DB suite skips `assertSchemaReady`

`src/lib/reviews/__tests__/import-review.integration.test.ts:59-74` opens the connection, seeds the
tenant and inserts a `businesses` row, then goes straight to testing. It never asserts the schema it
depends on.

**Named standard.** `.claude/CLAUDE.md`, "Dev commands" → `pnpm test:db:setup`:

> live-DB suites **assert** their schema (`assertSchemaReady`) instead of applying migrations, so a
> behind-head DB fails loudly rather than self-healing.

**The requirement constant already exists and covers exactly this suite's tables.**
`src/lib/shared/__tests__/helpers/schema-ready.ts` exports:

```ts
export const MIGRATION_071_RUN_SPINE: SchemaRequirement = {
  migration: '071_agent_run_spine',
  tables: ['agent_runs', 'agent_run_steps', 'agent_outcomes'],
};
```

The suite reads `agent_runs` (`:138`), `agent_run_steps` (`:155`), and deletes from both in
`afterAll` (`:80-83`).

**Concrete failure scenario.** A container provisioned before migration 071 (or any developer whose
local DB is behind head — the exact condition `pnpm test:db:setup` exists to fix) hits
`relation "agent_runs" does not exist` at `:80` in `afterAll`, *before* the more informative test
failures are reported. `assertSchemaReady` would instead emit
`test database is behind head — missing schema objects: 071_agent_run_spine: table agent_runs … Re-provision it with pnpm test:db:setup`.

**Adoption context (honest calibration).** 29 of 72 `*.integration.test.ts` files call it. It is not
universal — notably, the cited precedent `read.integration.test.ts` also omits it. But every recent
suite in the agent/solicitation/escalation families uses it, including
`src/lib/agents/__tests__/run-spine.integration.test.ts`, which touches the same three tables. Given
that this suite exists *specifically* because D7 found that nothing else executes `importReview`'s
SQL, making its failure mode actionable is worth two lines.

**Remedy.** Add to `beforeAll`, after the `postgres(…)` call:
`await assertSchemaReady(db, [MIGRATION_071_RUN_SPINE]);`

---

### 3. LOW — `process-review.test.ts` crosses the 1000-line threshold (790 → 1020)

**Named standard.** `thermo-nuclear-code-quality-review` rule #1: *"Do not let a PR push a file from
under 1k lines to over 1k lines without a very strong reason … Only waive this if there is a
compelling structural reason and the resulting file is still clearly organized."*

**I am recording this as a threshold crossing, not as a blocker, and here is the honest tradeoff
analysis** — the obvious remedy is *not* a free win:

*Option A (as shipped).* One file, 1020 lines, three labelled top-level `describe` blocks with
section banners. ~12 lines of tx-harness duplication between `describe('processReview')` and
`describe('importReview')`. `process-review.test.ts` **is** modified (4 lines: the `completeRun`
mock and two import lines).

*Option B (split into `__tests__/import-review.test.ts`).* Two files, 790 + ~260. Duplicates
`makeMonitoredReview` (~30 lines, `:47-77`) and `withCount` (3 lines, `:79-81`) instead — **more**
duplication, not less. Its one real advantage: `process-review.test.ts` becomes literally untouched,
which is a strictly stronger form of the "visible regression evidence" property the team said it was
optimizing for.

*Option C (hoist the fixtures into `__tests__/helpers/`).* Deletes the duplication properly, but
requires editing `process-review.test.ts`'s fixture block — directly contradicting the
byte-for-byte-untouched requirement.

**Verdict on the deliberate decision.** Option A is defensible for *this* ticket. The file remains
clearly organized, the duplication is annotated in place (`:795-800`) with the reason, and Option B
trades 12 duplicated lines for 33. **But the crossing should not be re-waived silently at #675**,
which will add callers and almost certainly more `importReview` cases. Recommendation: revisit at
#675 with Option C, once the byte-for-byte constraint has expired.

---

### 4. LOW — `insertNewReviewRow` leaks its dedup mechanism through its return type

`src/lib/reviews/process-review.ts:144-172`:

```ts
async function insertNewReviewRow(
  tx: TxClient,
  reviewId: string,
  businessId: string,
  monitored: MonitoredReview,
): Promise<number>
```

**Assessment of the seam itself (the question the brief asked): the private-helper decision is
right.** A public module would have been wrong here — `.claude/CLAUDE.md` working rules say
*"no abstractions for a single caller"* and *"Default is 'no new file' — check `docs/directory.md`
first."* Two callers inside one cohesive module, sharing 17 column bindings whose transposition is
silently catastrophic, is precisely the case for a file-private helper. The `// Private by design —
not part of the module's interface.` comment (`:142`) makes the intent durable. Good call.

**The interface is one step less deep than it could be.** `Promise<number>` is a raw
affected-row count — it exports the fact that dedup is implemented as `ON CONFLICT … DO NOTHING` and
makes every caller re-encode "0 means it already existed." The consequence is visible at both call
sites: each mints its own PK before calling, because the helper cannot supply one.

- `:65` — `const reviewId = uuidv7();` then `insertNewReviewRow(tx, reviewId, …)`
- `:520` — `const reviewId = uuidv7();` then `insertNewReviewRow(tx, reviewId, …)`

**Named principle.** `codebase-design` / information hiding: the interface should hide the
mechanism. `Promise<string | null>` — *the id of the row that was inserted, or `null` if the review
already existed* — is strictly narrower, deletes the duplicated id minting, and turns both call
sites into a single readable branch:

```ts
const reviewId = await insertNewReviewRow(tx, businessId, monitored);
if (!reviewId) return 'unchanged' as const;   // importReview
```

I verified this is viable: `processReview` never uses the generated `reviewId` on the zero-row path
(it re-reads `winner.id` at `:96-106`), so nothing needs the id before the INSERT.

This is an improvement, not a defect — the shipped version is correct and tested (the canonical-order
binding test at `process-review.test.ts:833` is a genuinely good guard for the extraction).

---

### 5. LOW — `docs/directory.md` module description is now incomplete

`docs/directory.md:569`:

> `process-review.ts` | Processes one `NormalizedReview`: deduplication, identity-collision
> detection, upsert into `reviews` table.

The module now exports a **second** entry point with a materially different contract (insert-only,
no lock, no outbox row, self-completing run). A reader consulting the code map before touching the
file would not learn that. The new `import-review.integration.test.ts` suite is likewise unlisted.

**Named standard.** `.claude/CLAUDE.md` working rules: *"No new top-level directories … Default is
'no new file' — check `docs/directory.md` first."* — the code map is treated as authoritative, and
recent feature PRs maintain it in-branch (`e3b86499` #666, `ec115089` #659, `6b0a636b` #664 all touch
`docs/directory.md`).

**Caveat, stated honestly:** step 8's `document-feature` sweep may already own this. If the feature
workflow's step 8 updates `docs/directory.md`, treat this finding as satisfied there rather than
patching it in step 7.

---

## Engagement with the three recorded deliberate decisions

### D-1. Duplicated tx harness in `describe('importReview')` — **agree, keep it**

Fowler's *Duplicated Code* smell is fundamentally about change amplification: duplication is bad
when the copies must change together. Here the opposite is true — the two harnesses must be free to
diverge, because `describe('processReview')`'s harness is *pinned* as the regression evidence for
"no behaviour change for any existing caller." Hoisting would couple them and destroy that property.

What makes this maintainable rather than accidental is the comment at `:795-800` recording the
reason in the file itself, so a future "helpful" dedup PR has to argue with it. That is the correct
mitigation. The only residual risk is that the comment is the *sole* guard — nothing mechanical stops
the hoist — but a mechanical guard would be disproportionate for 12 lines.

### D-2. `importReview` exported with no caller — **agree, and the mitigation is the right one**

A callerless export is normally a dead-code smell, and the standard objection is that it rots
silently between now and its caller landing. This branch closes that objection properly: D7 caught
that *nothing in the repository would ever execute `importReview`'s SQL*, and the response was to add
`import-review.integration.test.ts` — a real live-Postgres suite that runs the statement against the
provisioned schema. That converts "staged keystone" from an assertion into an enforced one. A wrong
column name or constraint violation now fails in #674 rather than being inherited by #675 as a broken
keystone.

Note (not a finding): `pnpm ci:fallow` may report `importReview` as an unused export. That audit is
the developer-facing sweep and gates nothing (`.claude/CLAUDE.md`, "Dev commands"), so it is not a
merge concern — but expect the noise and don't "fix" it by un-exporting.

### D-3. D4 cross-lane lost-draft hazard, deliberately unfixed — **accept the deferral**

The deferral reasoning holds on its own terms: the fix lives in `processReview`'s race-loss branch,
which is the module's most concurrency-sensitive code, and the hazard is unreachable until #675 wires
a caller. Editing that branch would be exactly the behaviour change the ticket forbids. Documenting a
known hazard beats shipping an unreviewed concurrency fix into a lane that has no caller.

The documentation placement is right — the JSDoc `KNOWN HAZARD` block sits on `importReview`
(`:505-508`), the function whose *winning* the race is the trigger, so a reader of the dangerous
function sees the danger.

One reservation, recorded rather than raised as a finding (see appendix A-4): the hazard's only
durable home is that JSDoc. `CONTEXT.md`'s glossary entry describes the insert-only /
`'unchanged'`-collapse purely as a safety property.

---

## Glossary check (`CONTEXT.md` → code) — **clean**

The new term **Review import** (`CONTEXT.md:25`) carries `_Avoid_: backfill (the user-facing noun is
**import**), historical sync, review sync`, and explicitly preserves the mechanism's existing names:
*"The mechanism keeps its existing names (`zernio_initial_backfill` topic, `zernio_backfill_runs`
table, `origin_lane='backfill'`) — only the semantics changed."*

Every occurrence of an `_Avoid_` term in the changed files is licensed by that clause:

| Location | Occurrence | Verdict |
|---|---|---|
| `process-review.ts:511` | `` `processUnansweredReview` closure inside `handleZernioBackfill` `` | OK — names an existing symbol, explicitly preserved |
| `process-review.test.ts:254,266,271` | `originLane: 'backfill'` / `origin_lane: 'backfill'` | OK — pre-existing lines in the untouched `describe('processReview')` block; the lane value is explicitly preserved |

Zero occurrences of "historical sync" or "review sync". The new code and comments consistently use
**import** as the noun (`importReview`, "Review import", "the import's work", "a bulk import"), and
the glossary entry's own style matches the file's established convention (`- **Term**: definition …
*(coined in …)*`) including the `_Avoid_:` clause and provenance parenthetical. D5's rejection of the
round-1 "not a flat glossary" finding was correct.

---

## Fowler smell baseline

| Smell | Present? | Assessment |
|---|---|---|
| Long Method | Pre-existing | `processExistingReview` (`:254-473`, ~220 lines) is the file's real smell. **The branch correctly did not touch it** — refactoring it inside a "no behaviour change for any existing caller" ticket would have destroyed the diff's own evidence. Right scope discipline. `importReview` is 24 lines; `insertNewReviewRow` is 29. |
| Large Class / File | Borderline | `process-review.ts` 451 → 542, well under 1k. `process-review.test.ts` 790 → 1020 — see finding #3. |
| Duplicated Code | Yes, deliberate | 12-line tx harness in the unit suite. Argued, annotated, and correct — see D-1 above. The production duplication (the 17-binding INSERT) was *eliminated* by this branch, which is the change's whole point. |
| Divergent Change | Candidate, acceptable | `process-review.ts` now changes for two reasons (live lane, import lane). Normally a split signal — but the two lanes share the INSERT statement and its sentiment discipline, so cohesion is genuine, not incidental. Splitting would re-introduce the duplication the branch just deleted. Correct call. |
| Shotgun Surgery | No | Change confined to one production file. |
| Primitive Obsession | Minor | `Promise<number>` from `insertNewReviewRow` — finding #4. |
| Data Clumps | Minor | `(tx, reviewId, businessId, monitored)` recurs across `insertNewReviewRow` / `startReviewRun` / `maybeEnqueueFirstReviewIngested`, but each takes only the subset it needs. Not worth a parameter object. |
| Feature Envy | No | — |
| Speculative Generality | No | `insertNewReviewRow` has two real callers on the branch; no unused parameters, no flags, no modes. `importReview` takes no `options` object at all — correctly, since `suppressNotification` and `originLane` are meaningless for a path that enqueues nothing. |
| Comments as Deodorant | No | The 36-line JSDoc on `importReview` documents *why* (the deliberate absence of a lock, the run-completion rationale, the hazard), not *what*. That is Ousterhout-correct deep documentation, not a smell. |
| Message Chains / Middle Man | No | — |

---

## Repo-standards checklist (`.claude/CLAUDE.md`)

| Rule | Status | Evidence |
|---|---|---|
| Invariant #2 — transactional outbox | PASS | Whole path in one `sql.begin` (`:519`); unit test `:918` asserts `begin` called exactly once and every spine writer received the same `tx`. `ci:outbox-seam` passed. |
| Invariant #3 — no unapproved posting | PASS | Zero outbox rows written; asserted both in the mocked suite (`:812`, `not.toContain('job_outbox')`, with `enqueueGenerateResponse` deliberately unmocked) and against live Postgres (`import-review.integration.test.ts:161-174`). Verified `enqueueGenerateResponse` writes `aggregate_id = reviewId` (`job-outbox-helpers.ts:246`), so the live assertion's WHERE clause genuinely covers the stray-enqueue case. |
| Invariant #8 — tenant scoping | PASS | Every write scoped by the `businessId` parameter; `ci:tenant-scope` at baseline (420/420). |
| Invariant #15 — explicit DB client | PASS | `importReview(sql: Sql, …)`; no `@/lib/db/server` import in the module. |
| No `any` | PASS | Zero `any` in the diff. Test casts are `unknown`-mediated (`as unknown as { begin: … }`), and D10 records that a gratuitous `as MonitoredReview` was removed from the fixture. |
| No silent catches | PASS | No `try`/`catch` added. |
| No string literals for status / tier / job names | PASS | `REVIEW_STATUS.NEW` imported (`:164`); `completeRun(tx, runId, 'completed')` binds to `completeRun`'s own typed union `'completed' \| 'cancelled' \| 'failed'` (`run-spine.ts:568`) — there is no constant to import, and the compiler is the guard. |
| Entry points orchestrate; modules own failure behavior | PASS | `importReview` is a domain module; no route/worker boot file touched. |
| Tests for outbox transitions / tenant-scoped queries | PASS | 8 new unit cases + 4 live-DB cases; every `tests_to_add` title present per the step 6 gate. |
| Live-DB suite naming (`*.integration.test.ts`) | PASS | `ci:live-db-suites` passed. |
| Live-DB suite applies no migration SQL | PASS | Same audit. |
| Live-DB suite asserts schema | **MISS** | Finding #2. |
| `docs/directory.md` currency | **MISS** | Finding #5 (may be step 8's). |

---

## Appendix — low-confidence observations (below the ≥80% bar; NOT findings)

**A-1. `startReviewRun`'s `null` return is now load-bearing in a second caller.**
`process-review.ts:534-536` guards `if (runId) await completeRun(…)`. In `processReview` a null run is
benign — the review is still stored and `generate_response` is still enqueued, so the pipeline
proceeds. In `importReview` a null run means the review row commits with **no spine artifact at all
and no follow-up work**, and the function still returns `'new'` — the import becomes invisible to the
run spine forever, silently. The guard is TypeScript-mandated (the return type is `string | null`), so
there is no way to drop it; and the state is FK-impossible per the comment at `:193-195`
(`reviews.business_id` is a non-null FK). D2 records that the team deliberately declined to *test*
this impossible branch on anti-slop grounds, which is consistent. Not raised as a finding because
neither a concrete failure scenario nor a named standard applies to an unreachable state. Worth one
sentence in the JSDoc if #675 ever relaxes the FK.

**A-2. `importReview`'s return type is an inline union while `processReview`'s is a named export.**
`:518` returns `Promise<'new' | 'unchanged'>`; `processReview` returns the exported
`ProcessResult` (`:26`). #675's caller has no name to hold the result in.
`Exclude<ProcessResult, 'updated'>` or a small exported `ImportResult` would restore symmetry and
make the "an import never reports 'updated'" contract nominal rather than positional. Style
preference — no standard names it, and the inline union is self-documenting at the call site.

**A-3. `'new'` overloads with `REVIEW_STATUS.NEW`.** Both appear in `insertNewReviewRow`'s vicinity
meaning different things (a process *result* vs a review *status*). Pre-existing in `ProcessResult`,
not introduced here.

**A-4. The D4 hazard's only durable home is a JSDoc block.** `CONTEXT.md:25`'s "Review import" entry
describes the insert-only / `'unchanged'`-collapse behaviour purely as a *safety* property ("a bulk
import cannot supersede a response, open a `review_exceptions` row, or notify admin") without noting
that the same collapse is the mechanism that can strand a review undrafted. A reader of the glossary
alone gets only the upside. Per the global instruction that checked-in docs are the durable layer
while per-feature plan artifacts are episodic, a one-clause addition to the glossary entry (or a
line in the spec) would outlive `feat-674-…-deviations.md`. Not raised as a finding: the brief asked
for glossary *violations* (code renaming a concept), and there are none; this is a completeness
judgment call, and #675 owns the fix.

**A-5. `// KNOWN HAZARD (deviations D4, owned by #675)` (`:505`) cites a plan artifact by bare
label.** Every other cross-reference in the file cites a path (`src/lib/agents/read.ts`,
`src/lib/publishing/orphan-markers`). "deviations D4" is unresolvable by grep for a reader six months
from now, and the label `D4` is additionally overloaded on this branch (spec §2's design decisions
are also numbered `D…` — the same JSDoc uses "spec D2" at `:480`). Adding the path
(`docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md`) costs one line. Docs
nit, not a standards violation.

**A-6. The live-DB job_outbox assertion could be broader.**
`import-review.integration.test.ts:166-168` filters on `aggregate_id::text = <reviewId>`. That is
correct for the realistic regression (`enqueueGenerateResponse` keys on the review id — verified at
`job-outbox-helpers.ts:246`), but a tenant-wide count would also catch a hypothetical future enqueue
keyed on the account or business. Marginal value; the current assertion is not wrong.

**A-7. Comment placement.** `import-review.integration.test.ts:169-170` explains the `::text` column
cast *after* the query rather than above it. Trivial.

---

## Recommendation

**Approve on standards grounds.** Finding #1 (order-coupled `it` blocks) is worth fixing in this
branch — it is ~4 lines and it protects the debuggability of the one suite that is `importReview`'s
sole executable proof. Finding #2 is two lines and makes that suite's failure mode actionable.
Findings #3-#5 can ride to #675 / step 8 with a note.
