# Deviations — feat-643-suppression-ledger-core

Entries are appended by implementation subagents when reality diverges from the
plan; each gets an ACCEPT / RE-PLAN verdict at step 6.5.

## Step 6.5 triage — 33 entries, 33 ACCEPT, 0 RE-PLAN

Read end to end at gate-green (`fe675af0`). **No entry invalidates a locked intake
or G1–G14 decision**, so the abort criteria are not reached. Verdicts by section:

| Section | Entries | Verdict | Note |
|---|---|---|---|
| Pre-implementation | 2 | ACCEPT ×2 | T0 glossary written before dispatch; the pre-T1 gate-evidence gap is now discharged. |
| T1 schema + registries | 5 | ACCEPT ×5 | Two are *plan factual errors* correctly caught (097 needs no `SchemaRequirement`; the `as const` matrices could not exist yet). One was my own dispatch-prompt error, not a surface breach. |
| T2 `suppression.ts` | 4 | ACCEPT ×4 | The fallow reversal is the highest-value entry on the branch — see below. |
| T3 purge retention | 5 | ACCEPT ×5 | Includes a second plan factual error (`TABLE_DISPOSITIONS` is asserted *unique*, never *sorted*). |
| T4 populate seam | 5 | ACCEPT ×5 | Step 3's allowlist work was already discharged by T2 — timing wrong, placement reasoning right. |
| T5 purge receipt | 6 | ACCEPT ×6 | Owner-facing copy gained a singular branch the plan did not write. |
| T6 spec + log | 4 | ACCEPT ×4 | Section-level amendment convention invented by extending the document-level one. |
| Step 5 gate | 2 | ACCEPT ×2 | Both owner-approved: the `test:db:setup` race and the reclassify estimate error. |

**Four entries the step-7 reviewers must look at specifically** (carried into their briefs):

1. **Planned unit tests were relocated to live-DB suites in T3, T4 *and* T5** — three
   independent tasks, each with a sound local justification (a `vi.hoisted` fake `sql`
   tag can assert SQL text but cannot distinguish a branch, prove row survival, or
   produce a real count). Individually correct; **collectively a pattern worth
   checking**, because `pnpm test:integration` hard-gates only the publisher
   edit-existing-reply suite, and "an existing-but-not-run suite" is precisely how #520
   shipped. Reviewers: confirm these suites actually execute in CI's `test` job rather
   than self-skipping, and that unit-level coverage did not thin where it still had value.
2. **`retained_suppression_count` is optional on the `purge_receipt` payload** with the
   reader defaulting to 0. This brushes the anti-slop "no backwards-compatibility shims"
   rule, and the justification must be judged, not assumed: outbox rows enqueued *before*
   this deploys are genuinely in flight and their receipts must still render. That is a
   rollout invariant, not a speculative shim — ACCEPT — but it is the one interface
   widening in the whole feature and deserves a second opinion.
3. **The receipt's owner-facing copy diverged from the plan** — the plan wrote the plural
   sentence out in full and it renders "1 opt-out records are retained" at the most likely
   non-zero count. A singular branch was added. Copy the plan specified verbatim is exactly
   the kind of change that should not pass unreviewed.
4. **T2's fallow reversal.** Writing the plan-mandated `unused-export` suppression for
   `recordSuppression` *created* a failure (`stale suppression`) because G6 made the
   live-DB suite a real consumer. The marker was removed and the rationale kept as a plain
   comment. Reviewers: confirm no other preemptive suppression survived anywhere on the
   branch — a suppression written from a prediction is a defect class, not a one-off.

## Pre-implementation coordination notes

- [2026-08-01] **T0 added: the mandated `CONTEXT.md` glossary section did not exist.**
  Caught at `/feature-resume` reconciliation. Both the plan
  (`2026-08-01-suppression-ledger-core.md:15`) and the step-3→4 handoff list
  `CONTEXT.md` → "Solicitation suppression & unsubscribe" as required reading, and
  the plan instructs that **every subagent prompt carry that glossary excerpt** with
  the five terms used verbatim. The section was never written — `CONTEXT.md`'s
  headings ended at "Voice Report Card", and the only suppression mention was a
  forward-reference inside #535's **Normalized handle** entry. The last `CONTEXT.md`
  commit is `6531c3d8` (#625), which *did* add its own **Consent ledger** entry, so
  the per-ticket precedent was clear and #643's was simply missed. **Three
  adversarial review rounds did not catch it** — all three reviewed the plan's
  internal consistency, and none verified that a document the plan *cites* exists.
  Worth carrying into future review briefs: cited-artifact existence is not covered
  by plan-internal review.

  **Resolution (owner-approved):** written as a T0 docs commit before T1 dispatch,
  sourced from the locked spec (§1.1–§1.3, §2.1, §2.2, §3.1–§3.3, §4.2, §5.2, §6.4,
  §7.6, §8.1, §8.2, D1/D3/D5/D6/D7/D8, DR1, DR2) and the plan's G1/G3/G7/G11/G12
  decision table. No intake amendment was required — `CONTEXT.md` was already inside
  `allowed_edit_surface`, so the **amendment budget stays at 1 of 2 used**
  (`scripts/ci/tenant-scope-allowlist.ts`, added during planning).

  Two judgment calls inside the entry, both flagged rather than silently taken:
  (a) it names **migration 096** before T1 creates it — the plan's file-structure
  table locks that number, and T6's migrations-log sweep is the backstop if it
  moves; (b) provenance reads `*(coined in #621 grilling; schema + domain core by
  #643)*` with **no PR number**, since the PR does not exist yet — the **Consent
  ledger** entry carries `PR #640`, so #643's should be added at ship time (step 8).

- [2026-08-01] **Gate evidence is structurally unavailable before T1.**
  `scripts/verify-gate.sh` has no docs-only mode, and its `promised-tests` row
  fixed-string-matches all 19 `tests_to_add` titles, none of which can exist at zero
  implementation. A green gate is therefore impossible for a docs-only commit; the
  worktree is parked (`.feature/intake.json` → `.feature/intake.parked.json`)
  instead, which is the documented way to end a session mid-feature. This is the
  second session to hit the same wall — the prior one recorded it as an observation
  ("feature state machine lacks an intermediate awaiting-review phase"). **Candidate
  workflow improvement, out of scope here:** a `docs_only` gate row that runs lint +
  the doc audits and skips `promised-tests` when the diff touches no `src/`,
  `worker/`, `scripts/` or `supabase/` path.

## Task 1 — schema + registry ripple

- [2026-08-01] **Step 3 breaks `src/lib/analytics/__tests__/events.test.ts`; the plan
  does not mention it.** Its first case pins `ANALYTICS_EVENT_NAMES` to a 21-entry
  array literal with `toEqual`, so registering `solicitation_suppressed` and
  `solicitation_suppressed_at_dispatch` makes it fail. Both names were appended in
  the same order/placement as in the allowlist, keeping the `toEqual` a genuine
  drift-guard rather than a sorted set. **Resolved; no amendment required** —
  `src/lib/analytics/__tests__/**` is inside the feature's `allowed_edit_surface`
  per `.feature/intake.json`, so the budget stays at 1 of 2 used.

  Recorded because T1 initially halted here: the surface list in the dispatch prompt
  had been trimmed to what T1 was thought to need and omitted that glob, so the edit
  looked out-of-surface. Halting was correct given what the subagent could see, but
  it cost a round-trip. **Carry into future dispatches:** when a surface entry names
  an implementation file, its `__tests__` sibling has to travel with it — a pinned
  allowlist literal is a guaranteed second edit site, not a possible one.

- [2026-08-01] **Analytics CHECK drift-guard handed off 094 → 097; not in the plan.**
  `migration-094-…integration.test.ts` owned the "every `ANALYTICS_EVENT_NAMES`
  entry is in the re-added CHECK list" guard, which by construction breaks the
  moment a NEWER constraint-swap migration lands. The repo already has the pattern
  (089 handed the guard to 094 and kept a pinned literal of its own historical
  list), so T1 applied it verbatim: 097 now owns the drift-guard, 094 pins its own
  21-name list, and 094's now-unused `ANALYTICS_EVENT_NAMES` import is dropped.
  In-surface (`src/lib/shared/__tests__/**`), no amendment. Worth adding to the plan
  template: every analytics-CHECK migration carries this handoff as a mandatory
  step.

- [2026-08-01] **Step 4 asks for "two `SchemaRequirement` exports"; only one is
  correct.** `MIGRATION_096_SOLICITATION_SUPPRESSIONS` was added as specified. 097
  did NOT get one: it creates no relation, column or index, and its constraint NAME
  has existed since migration 046 — a presence check would pass against a 094
  database and prove nothing. 094, the exact analogue, likewise has no entry, and
  097's suite is text-only and never calls `assertSchemaReady`. The reasoning is
  recorded in the doc comment above the 096 export so the absence is not read as an
  oversight.

- [2026-08-01] **Step 5's "drive the matrix from the exported `as const` arrays" is
  not yet possible.** Those arrays live in `src/lib/solicitation/suppression.ts`,
  which T2 creates and which is outside T1's edit surface — T1 is the blocking edge,
  so it cannot import from its own dependent. Both matrices are instead parsed from
  migration 096's own column `CHECK` lists (14 = scope x source, 8 = provenance
  nullability), and a live test pins that parse against `pg_get_constraintdef()` on
  the database, so a parse that silently matched nothing cannot masquerade as an
  empty matrix. Same property the plan wanted — the matrix cannot stay the same size
  while the schema's closed sets grow. **T2 should re-point both matrices at the
  `as const` arrays once `suppression.ts` exists**, keeping the DB pin as the
  three-way cross-check (TS allowlist ⟺ migration text ⟺ deployed constraint).

- [2026-08-01] **Step 6's predicted `ci:tenant-scope` failure did not occur** —
  it passed at 410/410 entries. The `missing account_id or business_id scope`
  finding the plan anticipated needs a SQL touchpoint on the new tables, and T1
  ships none (the writer is T2, the purge stages are T3). Expect it at T2/T3
  instead; the Task 4 allowlist work is still needed, just not yet.

## Task 2 — `suppression.ts`, the authoritative module

- [2026-08-01] **Step 5's predicted fallow `unused-export` finding for
  `recordSuppression` did not occur — and writing the suppression preemptively
  created a REAL failure.** With the marker in place `pnpm ci:fallow` reported
  `stale suppression … (no unused-export issue found on the next line)`. fallow
  counts `suppression.integration.test.ts` as a consumer, and G6 deliberately made
  that suite the writer's consumer, so the export is never unreferenced. The marker
  was removed; its five-line rationale was kept as an ordinary comment, because the
  *reason* the writer ships ahead of #644/#645/#627 is still the non-obvious fact a
  reader needs. **Carry forward:** a "write the suppression now" step is only safe
  when the finding has been observed — for `unused-export` specifically, a live-DB
  suite that exercises the export is enough to prevent it ever firing.

- [2026-08-01] **fallow instead flagged `SuppressionScope` as an unused TYPE
  export.** Spec §3.1 mandates all three `as const` arrays "with derived types", so
  deleting it was not an option and neither was a second speculative suppression.
  Resolved with coverage rather than a marker: the unit suite gained
  `derives a closed union type from each array, not a widened string`, which asserts
  through all three derived types and uses `@ts-expect-error` to pin that each
  rejects a non-member. That is the assertion that was missing anyway — nothing
  else proved the arrays had not widened to `string[]`.

- [2026-08-01] **T1's Step 5 carry-forward discharged.** Both matrices in
  `migration-096-solicitation-suppressions.integration.test.ts` now import
  `SUPPRESSION_SCOPES` / `SUPPRESSION_SOURCES` from `suppression.ts`; the migration-
  text parser (`parseColumnCheckValues`) is deleted and the live
  `pg_get_constraintdef()` pin is unchanged, so the three-way cross-check is now
  TS module ⟺ deployed constraint (the migration text is still asserted separately
  by the checked-in-SQL contract tests). 47/47 still pass.

- [2026-08-01] **`ci:tenant-scope` fired exactly where T1 predicted it would.**
  One finding — `src/lib/solicitation/suppression.ts: solicitation_suppressions:
  missing account_id or business_id scope` — for `suppressionMatchSql`'s statement.
  Allowlisted as `tenant-root-lookup` with `ALLOWLIST_BASELINE` 410 → 411. The
  reason states the asymmetry plainly: the `account` arm IS tenant-scoped by the
  required `accountId` parameter, and the `global` arm is deliberately unscoped
  because a global row records what the recipient revoked against the one shared
  sender identity — scoping it would silently resume sending to someone who opted
  out. The three `recordSuppression` INSERTs drew no finding.

## Task 3 — offboarding purge retention

- [2026-08-02] **Step 1's ordering claim is wrong: `TABLE_DISPOSITIONS` is NOT
  asserted alphabetically sorted.** `table-disposition.test.ts:107` is
  `expect(unique(classified)).toEqual(classified.slice().sort())`, and `unique()`
  itself sorts — so the assertion is **uniqueness**, not ordering. The live list has
  never been alphabetical (it opens `accounts, businesses, users, reviews, …`). The
  real constraint is `:108`: the classified **set** must equal
  `TENANT_TABLES ∪ explicit ∪ spec-only` exactly, which T1 had already satisfied by
  registering both tables in `scripts/ci/tenant-tables.ts`. Both entries were
  appended after `solicitation_consent` as the plan intended; the position is a
  readability choice, not a gate. The prompt's instruction to *verify rather than
  trust the sentence* is what caught this.

- [2026-08-02] **All six tests went to the live-DB suite, not to the mocked-`sql`
  unit suite the plan's Files list named.** `purge-verification.test.ts` drives
  `verificationQuery` through a `vi.hoisted` fake tag, which can assert SQL *text*
  and nothing else — it cannot distinguish the arm's two branches, and by G13's own
  argument it cannot prove survival. All six therefore live in
  `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`,
  the existing live-DB purge suite: no new file (repworth.md's default), and it
  reuses that suite's `vi.hoisted` `DATABASE_POOL_URL` override, which is the fiddly
  part of standing up a second one. The unit suite still gates the arms' existence
  through its `has explicit verification SQL for every disposition table` case.
  Both required verbatim titles about retention are present and BOTH fail against a
  mutated purge that drops the `scope = 'account'` predicate — verified by running
  the mutation, which is the only evidence that G13's guarantee is actually held by
  a test rather than asserted in a comment.

- [2026-08-02] **`ci:tenant-scope` fired twice, exactly as T1/T2 predicted for T3.**
  Both findings come from the token-scrub `UPDATE`
  (`solicitation_unsubscribe_tokens` and `businesses`) and are the same shape the
  audit already allowlists for the `notification_deliveries` DELETE two entries
  above: an `OR` predicate whose second branch is a `business_id IN (SELECT …)`
  subquery the scanner strips before predicate analysis. Two `tenant-root-lookup`
  entries added, `ALLOWLIST_BASELINE` 411 → 413. The
  `DELETE FROM solicitation_suppressions` drew no finding (direct `account_id`), and
  neither did either new `purge-verification.ts` arm.

- [2026-08-02] **Fixture correction the plan could not have known:**
  `contact_csv_uploads_terminal_consistency` (migration 086) requires
  `report IS NOT NULL AND completed_at IS NOT NULL AND raw_csv IS NULL` for a
  `completed` upload. The Unsubscribe token fixture's chain seeds a completed
  upload and initially omitted `report`.

- [2026-08-02] **The plan's extra retention title was kept alongside the intake's
  five.** Step 4 names five verbatim titles and then adds a sixth
  (`a global suppression row survives the purge with its account_id intact`). Both
  the intake title (`purge verification passes when a global suppression row
  survives with its account_id intact`) and the plan's are present, with distinct
  subjects rather than duplicated bodies: the intake one drives the FULL production
  purge (poller → outbox → worker) so that `finalizePurgeInTransaction`'s own
  verification call is the "passes" assertion, then reads the row back; the plan's
  drives `runContentPurgeStage` with a global AND an account row on ONE handle, so
  only a delete that discriminates on `scope` can pass it.

## Task 4 — build-time populate seam

- [2026-08-02] **Step 3 was already discharged by T2 — no allowlist entry and no
  baseline bump belong to T4.** `pnpm ci:tenant-scope` is green at 413/413 both
  before and after the LATERAL join, because T2 shipped the
  `src/lib/solicitation/suppression.ts` / `solicitation_suppressions` entry when it
  created the fragment (410 → 411). The plan's *placement* reasoning was exactly
  right — the literal `FROM solicitation_suppressions` lives in the fragment's own
  template, never in `batch-builder`'s, so an entry pointed at `batch-builder.ts`
  would have matched nothing and then failed the unused-entry check — but its
  *timing* was wrong: the finding fires the moment the fragment exists, not the
  moment it gains a caller. Nothing was written from the plan's prediction.

- [2026-08-02] **The nested `tx\`c.email\`` interpolation could have blinded the
  audit, so that was proven rather than assumed.** `parseTemplateLiteral`
  (`tenant-scope-audit.ts:738`) tracks `${…}` depth and treats backticks inside an
  interpolation as text, so the outer template still parses — but a silent parse
  failure would have read as a green audit while hiding every finding in the file.
  Verified by mutation: replacing `WHERE c.business_id = ${businessId}::uuid` with
  an unscoped predicate makes the audit report
  `batch-builder.ts: solicitation_contacts: missing account_id or business_id
  scope`, which proves the template is still being scanned after the change.

- [2026-08-02] **The mocked candidate-window rows in `batch-builder.test.ts` had to
  gain the two new columns.** `toCandidate` gates on `!== null`, and a mock row
  that simply omits the keys yields `undefined !== null` → a candidate with no
  ledger row reads as suppressed with `undefined` evidence. Real Postgres always
  returns a selected column, so the fixtures were made faithful rather than the
  production mapping made defensive.

- [2026-08-02] **Both required titles went to the live-DB suite, and the BATCH_CAP
  one is mutation-verified.** The populate-not-pre-filter property is a property of
  the SQL, invisible to the mocked-`sql` unit suite. Adding
  `AND suppression.source IS NULL` to `loadCandidateWindow` fails
  `a withheld-suppressed candidate does not consume BATCH_CAP` on
  `candidateCount` (25 vs 26) and `withheldByReason.suppressed` (0 vs 1) — the
  suppressed contact vanishes from the window instead of being withheld. The
  companion mutation (a suppressed row counted as eligible) is caught by the same
  test's `velocity_banked: 0`: it would push `eligible` to `BATCH_CAP + 1` and bank
  one real send.

- [2026-08-02] **Suppression fixtures need their own sweep, in two places.**
  Nothing in the suite's existing teardown reaches them — a ledger row hangs off no
  business, only off the Normalized handle — and `account_id` is a NO-ACTION FK to
  `accounts`, which `cleanupTenantAccount` deletes directly. `sweepSuppressionFixtures`
  runs in `afterEach` and again in `afterAll` before that helper, so a row leaked by
  a failed `afterEach` cannot turn teardown into an FK error. Fixtures are written
  through the real `recordSuppression`, so its `solicitation_suppressed` analytics
  row is swept alongside them.

## Task 5 — aggregate purge receipt

- [2026-08-02] **The receipt sentence is pluralised; the plan specified only the
  plural form.** Step 3's copy ("N opt-out records are retained so those opt-outs
  continue to be honored.") reads "1 opt-out records are retained" at the most
  likely non-zero count there is. The singular branch renders "1 opt-out record is
  retained so that opt-out continues to be honored."; the plural wording is
  verbatim from the plan. One ternary in `formatRetainedSuppressions`, one test per
  branch. Recorded because it changes owner-facing copy the plan wrote out in full.

- [2026-08-02] **The required verbatim title went to the live-DB suite, and the
  plan's Files list named the template unit suite.** Same shape as T3's deviation
  and for a sharper reason here: `email-templates.test.ts` cannot assert "the right
  N" at all — the template is handed a number, so a count assertion there tests the
  test's own fixture. The title lives in
  `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`,
  where the count comes from a real purge over four seeded rows and the body comes
  from driving the real `handleAccountOffboardingEmail`. Mutation-verified: adding
  `AND account_id IS NULL` to the count query fails it at 0 vs 2.
  `email-templates.test.ts` still gained three cases (plural, singular, and zero
  rendering nothing), and `AccountOffboardingEmailWorker.test.ts` gained the
  retry-stability case, which is where "renders the same number twice and never
  queries the ledger" actually belongs.

- [2026-08-02] **The integration suite gained its first module mock.** Only the
  transport (`sendInternalEmail`) is stubbed — `importOriginal` keeps
  `buildAccountOffboardingEmailHtml` and every other export real, so the assertion
  runs against the genuinely rendered body. No other scenario in that suite sends;
  they all enqueue. `runFullProductionPurge` also now returns its `offboardingId`,
  which the receipt lookup needs; its existing caller is unaffected.

- [2026-08-02] **The count sits after the `SET status = 'purged'` UPDATE, not
  immediately after the verification block.** Both positions are inside the window
  the plan specifies (after verification, before `enqueueAccountOffboardingEmail`);
  this one counts only once the finalize preconditions have actually held, so a
  purge that is about to throw `…finalize_precondition_failed` never spends a query.

- [2026-08-02] **`retained_suppression_count` is optional on the payload, and the
  reader defaults it to 0.** Not defensive habit: outbox rows enqueued before this
  ships are in flight with no such field, and their receipts still have to render.
  Covered by `renders no retained count for a purge receipt enqueued before the
  count existed`.

- [2026-08-02] **`ci:tenant-scope` drew no new finding** — green at 413/413. The
  count's predicate is a direct `account_id = …`, which is exactly the shape the
  audit is looking for. No allowlist entry and no baseline bump belong to T5.

## Task 6 — spec amendments + migrations log

- [2026-08-02] **The spec has no SECTION-level amendment convention; the document-level
  one was extended down a level.** `2026-07-28-suppression-unsubscribe-design.md:3` and its
  four sibling send-mode specs all carry the same shape — a `> **AMENDED <date> — …**`
  blockquote banner at the very top, pointing at the authority. Nothing in the family
  amends a single section in place. Both notes therefore use that banner verbatim,
  placed immediately under the `### 2.2` / `### 6.3` headings so they are read before the
  text they qualify, and each names precisely what it supersedes ("this section's no-FK
  posture for `outreach_id` only"; "the row count of the table below, not its content").
  No locked text was edited or deleted.

- [2026-08-02] **Step 2 says "add 096 and 097 entries and move the head"; the
  `new-migration` skill also requires retention-policy rows, so two were added.** Its
  step 3 makes a retention-policy row mandatory for a new table ("or note why exempt"),
  and 096 ships the first two solicitation tables that are NOT `hard_delete`-on-purge —
  precisely the case the table exists to record. `solicitation_suppressions` and
  `solicitation_unsubscribe_tokens` rows now sit after `solicitation_outreach`. The
  **Key Tables Reference** section further down was deliberately NOT touched: it stops at
  migration 088's `solicitation_asks`, and neither 091's `solicitation_outreach` nor 093's
  `solicitation_consent` was ever added to it, so appending only these two would have
  implied a completeness that section does not have.

- [2026-08-02] **T1's Step 4 deviation is now folded into the log itself.** 097's entry
  states in prose that it has **no `SchemaRequirement` export and no `assertSchemaReady`
  entry**, and why (constraint-only; the constraint name predates it by 50 migrations, so a
  presence check would pass against a 094-era database; 094, the same shape, has none
  either). Recorded in the log rather than only in this file because the absence is the
  kind of thing a later reader would otherwise "fix".

- [2026-08-02] **Both entries record the migrations as LOCAL-ONLY.** They are applied and
  verified against the local test container; staging and production application rides the
  PR promotion, 096 then 097, staging first. Phrasing follows migration 075's precedent
  rather than 095's, which was written after its promotion.

## Step 5 gate — two owner-approved corrections

- [2026-08-02] **`pnpm test:db:setup` was a `verification_command` and it raced the
  parallel gate.** `scripts/verify-gate.sh` runs its checks concurrently, and
  `test:db:setup` **drops schema `public`** before re-applying bootstrap + every
  migration. On the first full gate run it demolished the schema underneath its own
  parallel peers: `suppression.integration.test.ts` failed with *"test database is
  behind head — missing schema objects: 096_solicitation_suppressions: table
  solicitation_suppressions, …"*, and the whole-repo `test` row reported 27 failed
  files — every one an `src/app/api/**` route test, every one a 5000ms timeout, all
  passing in isolation. The `migration-097` row passed precisely because it is pure
  SQL-**text** inspection and never opens a connection. Post-run introspection
  confirmed the diagnosis: both tables were present and the schema had 49 tables, so
  provisioning had *succeeded* — it simply finished after its victims.

  **Resolution (owner-approved):** `pnpm test:db:setup` removed from
  `verification_commands` in **both** intake copies (re-verified byte-identical,
  sha256 `5078c6d6…`). Provisioning is a **precondition, not a verification** — a
  command that drops a shared schema can never be a safe parallel peer to the suites
  reading it. It is now run manually before each gate run. This is a
  `verification_commands` edit, **not** an `allowed_edit_surface` amendment, so the
  budget stays at **1 of 2 used**.

  **Candidate workflow improvement, out of scope here** (the fix would live in
  `scripts/verify-gate.sh`, outside this branch's edit surface): the gate should run
  DB provisioning serially *before* the parallel fan-out, so no future intake can
  reintroduce this by listing a destructive command. Related: the gate did not export
  `TEST_DATABASE_POOL_URL` (it lives at `.env.local:301`), so `integration-suites`
  reported SKIP — which the gate itself declares not-review-ready for DB-touching
  work. Both are the same underlying gap: the gate does not own its DB precondition.

- [2026-08-02] **The `reclassify` trigger fired at 2.77× and was an estimate error,
  not a lane error.** Actual 4,989 changed lines against `estimated_diff_size`
  `+1800 / -60 across ~24 files`. The breakdown is the point:

  | Area | Changed lines |
  |---|---|
  | Production code | 435 |
  | Migrations | 207 |
  | Tests | 2,644 |
  | Real docs (migrations-log, spec, CONTEXT.md, analytics, RLS inventory) | 165 |
  | Workflow artifacts (948-line plan, this file, intake, handoff) | 1,537 |

  Excluding workflow artifacts the diff is 3,452 (1.9× — under the trigger).
  Production code landed at **435 lines across exactly the files the plan's file-structure
  table named**, with 37/37 files in-surface and zero scope creep. The overrun is almost
  entirely **test volume the plan itself mandated**: the exhaustive 14-row
  `SUPPRESSION_SCOPES × SUPPRESSION_SOURCES` Cartesian matrix, the 8-row token
  nullability permutations, six live-DB suites, and mutation-verified retention proofs.

  **Resolution (owner-approved): continue, do not re-run step 0.** Re-classifying with
  the real numbers lands on the same lane — RISK was already `high` (the heaviest), the
  work decomposed into 6 tracer tasks (under the ~8 epic threshold), and the single
  surface amendment was spent during *planning*, not execution.

  **Durable lesson for the post-merge lab-notes sweep:** `estimated_diff_size` must be
  estimated as **production + test volume separately**, and a plan that mandates
  exhaustive data-driven matrices should carry a test-line estimate of its own. A
  4:1 test-to-code ratio is a *designed* property of a DB-contract feature, not
  overrun — but an estimate that silently assumes 1:1 will fire the abort criteria on
  exactly the features whose test rigour is most worth having. Consider excluding
  `docs/superpowers/plans/**` from the reclassify computation: counting the plan
  document against the implementation it describes is not a meaningful ratio.

## Carried forward from the handoff — address at step 8

- **`origin/staging` is 1 commit behind `origin/main`** (the post-#642 fast-forward
  was skipped). Fast-forward it before the staging ride.
- **Document the codex-rescue task-ID issue** hit during planning: the companion
  reported no jobs recorded while the task existed only in the agent transcript;
  the round-2 review had to be re-dispatched via a direct `codex exec` CLI call.
