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

## Step 6 adversarial review — verdict and accepted finding

- [2026-08-02] **Codex verdict: `needs-attention`. One [high] finding, ACCEPTED, fix
  pending.** `solicitation_unsubscribe_tokens.token_hash` is `TEXT NOT NULL UNIQUE` with
  **no format constraint**, while the column comment asserts *"SHA-256, node:crypto
  (invariant #10); raw token NEVER stored (invariant #5)"*. Nothing enforces it. Because
  this table is deliberately a **retention** table whose rows outlive the account that
  minted them, a raw **Unsubscribe token** written by a future #644 minting regression
  would persist indefinitely — through purge, backups and exports.

  **Accepted on two grounds, both verified rather than taken on the reviewer's word:**
  (a) the intake contract declares the invariant in its own words — *"Invariant #5: raw
  unsubscribe tokens exist only in memory and in the sent message — never in Postgres,
  outbox payloads, or logs. This ticket stores hashes only."* — so this is an in-contract
  gap, not scope creep; (b) there is an exact in-repo precedent at
  `supabase/migrations/056_account_offboarding.sql:135-136`,
  `token_hash TEXT NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$')`. Note `approval_links`
  (001) and `channel_enrollments` (021) carry no such CHECK — 056 is the newer, deliberate
  precedent for a *new* token table, and is the one to mirror. Node's
  `createHash('sha256').digest('hex')` emits lowercase, so the lowercase-only class is right.

  **Blast radius: nil today.** No production writer of the table exists on this branch
  (minting is #644). The only touchpoints are a read (`purge-verification.ts:657`) and the
  provenance scrub (`purge-stages.ts:345`), which sets `account_id`/`business_id`/`ask_id`
  and never `token_hash`. All three test fixtures already emit valid 64-char lowercase hex
  — `offboarding-lifecycle.integration.test.ts:282` uses a real
  `createHash('sha256')…digest('hex')`; the two 096-suite sites (`:227`, `:753`) use
  `randomUUID().replaceAll('-','').padEnd(64,'0')`, which satisfies the class but should be
  converted to real digests for honesty, not for the constraint.

- [2026-08-02] **The fix is blocked by `.claude/hooks/migration-immutability-guard.sh`,
  and the workaround is owner-approved but needs a process-env change.** The hook refuses
  any Edit/Write to a `supabase/migrations/*.sql` whose number is `<=` the
  `Current head: **097**` line in `.claude/reference/migrations-log.md` — which T6 bumped
  *on this branch*, before promotion. Its escape hatch is the process env var
  `MIGRATION_GUARD_DISABLE=1`, and its own header names this exact case: *"amending an
  unapplied file after a premature log bump"*.

  **Amending 096 in place is the correct call, not merely the convenient one.** The
  decisive constraint is the intake: `allowed_edit_surface` contains
  `supabase/migrations/096_*.sql` and `097_*.sql` and **no 098 glob**, so shipping the CHECK
  as a new migration would require a **2nd surface amendment and trip the abort criteria**
  (post-mortem, tear down, restart at step 1) — a disproportionate price for a one-line
  constraint. Meanwhile 096 has never been applied outside a rebuildable local container
  (its own migrations-log entry records it as local-only), so it is not yet immutable in
  the sense the guard is protecting. The guard is firing on its proxy (recorded head)
  rather than the real condition (applied to staging/prod).

  Neither `.claude/settings.json` nor `.claude/settings.local.json` is inside
  `allowed_edit_surface`, so the agent cannot set the var itself — the edit-surface guard
  correctly blocks that too. **Unblock recipe:** relaunch with
  `MIGRATION_GUARD_DISABLE=1 claude`, then `/feature-resume feat-643-suppression-ledger-core`.

  **Candidate guard improvement, out of scope here:** the hook conflates "highest migration
  recorded in the log" with "applied to staging/prod". Every in-place amendment of a
  local-only migration is a false positive, and this workflow produces exactly that shape
  whenever the migrations-log task (T6) runs before the ship lane. A truer signal would be
  a per-entry applied marker in the log rather than the head number alone.

- [2026-08-02] **FIX APPLIED — `cd861e6b`, gate GREEN.** The owner relaunched with
  `MIGRATION_GUARD_DISABLE=1`; `arm-check.sh` printed ARMED, and reconciliation was clean
  (phase `gate_green`, `headSha` == HEAD, tree clean, 0 behind `origin/main`, both intake
  copies byte-identical). Three files, all in-surface:

  1. `096_solicitation_suppressions.sql` — named
     `CONSTRAINT solicitation_unsubscribe_tokens_token_hash_sha256_hex CHECK (token_hash ~ '^[a-f0-9]{64}$')`,
     placed before the G12 provenance implication, with a rationale comment in the file's
     style. Named because 096's other table-level constraints are and the suite asserts
     `pg_get_constraintdef()` by name.
  2. The 096 suite — a `sha256Hex()` helper replaces both
     `randomUUID().replaceAll('-','').padEnd(64,'0')` fixtures (`:227`, `:753`) with real
     digests, `insertToken` gained an optional `tokenHash` override used only by the new
     matrix, and two tests were added: a `pg_get_constraintdef()` assertion and a 6-case
     `it.each` — raw token, uppercase hex, 63-char, 65-char, hex-length non-hex all
     rejected with SQLSTATE `23514` and the constraint named, plus **one accepted real
     digest** so the matrix cannot pass by rejecting everything.
  3. `migrations-log.md` — 096's entry now describes the CHECK and the lowercase-only
     rationale. **Head stayed 097.**

  **Mutation-checked as the handoff required:** with the CHECK removed and the DB
  re-provisioned, 6 of the 7 new assertions FAIL (the definition test + all 5 rejections);
  the accepted case still passes, which is correct — a constraint-free table accepts
  everything. Restored, re-provisioned, 54/54 green.

  `ALLOWLIST_BASELINE` stayed 413 as predicted — a CHECK adds no SQL touchpoint. Gate
  re-run with `--review` at `cd861e6b`: all 34 rows PASS including `merge-coverage` and
  `diff-coverage`; the standing owner-approved `reclassify` WARN now reads 5,299 lines,
  up from the 5,052 measured at `fe675af0` — **130 of that from this fix** (3 constraint
  lines, the rest test matrix, helper and rationale comments) and 117 from the two step-6
  documentation commits in between. Still an estimate error, not a lane error: production
  code is unchanged at 435 lines, and this fix touched no production file at all.

## Step 7 dual review — triage verdicts

Two fresh parallel agents on the branch diff. **Spec & correctness**: 3 findings, all
`low`, nothing at critical/high/medium; it verified all 37 paths in-surface, both intake
copies byte-identical, 19/19 `tests_to_add` verbatim (eight bodies read and confirmed
two-sided), 4/4 `user_visible_behavior` shipped with nothing unauthorised, and 13/13
`edge_cases` handled. **Standards & maintainability**: 6 findings (3 medium, 3 low), a
clean glossary sweep, and independent confirmation that the relocated live-DB suites DO
run in CI and that zero new fallow/eslint/ts suppression markers exist. Both agents
independently reviewed the four escalated deviations and concurred with all four ACCEPTs.
Full reports: `docs/reviews/feat-643-suppression-ledger-core/step7-*.md`.

Every finding was verified against the code before triage; none was taken on the
reviewer's word.

**ACCEPTED — 6:**

- [2026-08-02] **`suppressionMatchSql` hardcoded `channel = 'email'` while
  `recordSuppression` parameterised it** (medium). Two owners for one dimension, and the
  failure mode is fail-OPEN: the day `SUPPRESSION_CHANNELS` gains a member, the writer
  mints rows the reader can never see and a recipient who opted out gets contacted. No
  live divergence today (the enum has one member), so this is a latent trap, not a bug.
  **Fixed** — `channel: SuppressionChannel` is now a required parameter; both call sites
  (`batch-builder.ts` LATERAL, the suite's `matchSuppression` probe) pass `'email'`.

- [2026-08-02] **The token scrub's `OR business_id IN (SELECT … FROM businesses …)`
  defeated the index added for it** (low, spec agent, EXPLAIN-confirmed). `edge_cases[4]`
  says 096 ships `idx_solicitation_unsubscribe_tokens_account` expressly because the
  scrub filters account-first; the `OR` made it unusable and forced a seq scan on that
  exact statement, while the scrub holds the per-business advisory locks. The branch was
  also redundant: G12's CHECK gives `business_id NOT NULL ⟹ account_id NOT NULL`, so no
  row of the account's can hide behind a NULL `account_id`. **Fixed, asymmetrically and
  on purpose** — the `OR` is gone from the scrub (hot path) and **kept in the verifier**
  (`purge-verification.ts`, cold path, runs once). The one shape the branch could still
  have caught is a token stamped with account Y while pointing at account X's business —
  a cross-account writer bug — and silently scrubbing it would HIDE it. Now it fails the
  purge loudly instead. Owner-approved at the triage checkpoint.

- [2026-08-02] **`solicitation_suppressed` distinct-ID doc drift** (low, flagged
  independently by BOTH agents). `docs/analytics/events.md` said "Distinct ID: account
  ID"; the code is `input.accountId ?? row.id`. The `accountId: null` path is
  spec-mandated (§5.2 post-purge redemption, unresolvable webhook sources) and
  `analytics_events.distinct_id` is NOT NULL, so the fallback is correct — **the doc was
  wrong**. Fixed the doc rather than the code, and named the consequence it was hiding:
  an accountless global suppression mints a one-off PostHog person per row. Harmless at
  today's zero callers; picking a stable sentinel is explicitly handed to #644/#645/#627
  rather than decided here.

- [2026-08-02] **Two test titles named `isSuppressed`, which G7 forbids** (low, spec
  agent). `CONTEXT.md`'s **Suppression scope** entry rules the helper out by name ("no
  `isSuppressed()` helper, because the second consumer does not exist yet"), so the suite
  advertised an API the branch's own locked glossary forbids. The titles were verbatim in
  `tests_to_add` and gate-matched by `promised-tests`, so this could not be fixed in the
  test alone. **Fixed via an INTAKE AMENDMENT — the 2nd and last of 2, owner-approved at
  the triage checkpoint.** Both titles now name `suppressionMatchSql`; both intake copies
  updated in lockstep and re-verified byte-identical (sha256 now `91786a3d…`, was
  `5078c6d6…` — **the handoff's old hash is superseded**). `allowed_edit_surface` was NOT
  touched; the amendment is to `tests_to_add` only. **Budget is now exhausted: any further
  amendment trips the abort criteria.**

- [2026-08-02] **The purge-boundary suppression contract has no documented remediation**
  (medium, standards agent — accepted in part). The reviewer is right about the mechanism
  and I verified it: `users` rows are **tombstoned, not deleted**
  (`purge-stages.ts` parent-tombstone stage), so the verifier's
  `created_by_user_id IN (SELECT id FROM users WHERE account_id = …)` subquery keeps
  matching after purge, and the content stage deletes only `scope='account'` rows — so a
  `global` row authored by one of the account's own users is never cleaned and the purge
  fails verification on every retry. **Rejected the "this is an oversight" framing:** that
  arm is a deliberate tripwire, documented at `suppression.ts:81-86` — the type layer
  cannot prove an actor is an admin rather than an owner, and an owner-authored global row
  is a cross-tenant write that MUST NOT be silently absorbed. Failing loudly is correct.
  **Accepted the real residue** — there is no written remediation path. Recorded here as
  the operator answer, and handed to #645 (which owns the **Correction path**, the
  admin-only audited removal this needs): *if a purge wedges at
  `account_offboarding_purge_verification_failed` with a non-zero
  `solicitation_suppressions` violation count, the row to inspect is a `scope='global'`
  row whose `created_by_user_id` belongs to the purged account. It must not be deleted as
  routine cleanup — it is evidence of a writer authorization bug. Remove it only through
  the Correction path, with the audit record, then re-run the purge.* No code change: the
  contract comment is already in the right file, and inventing enforcement machinery for
  a writer that does not exist yet is exactly the speculative generality the plan avoided.

**REJECTED — 3, with reasoning:**

- [2026-08-02] **"Make `suppressionMatchSql` self-normalize with `lower(btrim(…))`"**
  (medium, standards agent). Rejected on two independent grounds. (1) It is not the
  equivalence the finding claims: `normalizeEmail` (`handles.ts:12-16`) is
  `trim().toLowerCase()` **plus** a length bound and a plausibility regex, and returns
  `null` on failure — `lower(btrim(…))` reproduces the transformation and drops the
  validation, so it is a different function wearing the same name. (2) It contradicts a
  locked intake decision: `edge_cases[9]` states that `solicitation_contacts.email`
  already stores the Normalized handle, with the consent LEFT JOIN as the standing proof,
  *"so the suppression lookup joins on c.email with no re-normalization."* On data that
  is already normalized the extra call is a no-op that would MASK an upstream integrity
  bug rather than surface it — the opposite of the posture repworth.md requires. The
  prose-only precondition is a real observation; this remedy is the wrong answer to it.

- [2026-08-02] **"Extract the duplicated INSERT column/VALUES head in `recordSuppression`"**
  (low). Rejected. The two branches sit either side of the one construct in this codebase
  that is documented as byte-for-byte fragile — the `ON CONFLICT … WHERE` predicate that
  Postgres must match exactly to infer the partial index. Splicing a shared fragment into
  both statements buys ~8 duplicated lines and puts a layer of indirection between a
  reader and the two predicates they most need to read literally. Two complete, readable
  statements is the better trade here.

- [2026-08-02] **"`offboarding-lifecycle.integration.test.ts` crossed 1,000 lines"** (low).
  Rejected; the reviewer conceded the counter-argument in the same breath. The
  suppression-retention block reuses that file's existing `vi.hoisted` DB bootstrap, and a
  new file would duplicate the bootstrap to satisfy a line count. Recorded, not acted on.

## Carried forward from the handoff — address at step 8

- **`origin/staging` is 1 commit behind `origin/main`** (the post-#642 fast-forward
  was skipped). Fast-forward it before the staging ride.
- **Document the codex-rescue task-ID issue** hit during planning: the companion
  reported no jobs recorded while the task existed only in the agent transcript;
  the round-2 review had to be re-dispatched via a direct `codex exec` CLI call.
