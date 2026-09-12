# Deviations — feat/owner-operator-run-a

Entries are things the plan or the workflow did not anticipate. Each entry
gets a one-line **Verdict:** (ACCEPT or RE-PLAN) at the step-6 read-back.

## 2026-09-11 — `grill-with-docs` skill absent from this machine

The `/feature` command's step 1 names the `grill-with-docs` skill and says to
read `~/.claude/skills/grill-with-docs/SKILL.md` if it is not model-invocable.
Neither the directory nor the file exists (`~/.claude/skills/` holds
`grill-me-codex` and `grilling` only). The run is the TICKET-SEEDED variant, so
the grill covered only the three deltas the owner named plus one map-level
constraint the code surfaced (the LLM worker-slot cap), all four resolved by
`AskUserQuestion` and recorded in the intake. The glossary context file was
written in the plan phase instead of during the interview.

**Verdict:** ACCEPT — the ticket-seeded delta grill needs no interview script; the decisions and the glossary are on disk.

## 2026-09-11 — baseline gate RED on `feature-surface` before T0

A `verify-gate.sh --baseline` run at the plan phase (HEAD f747cb7b6, docs-only
mode) passed every row except `feature-surface`: 13 `allowed_edit_surface`
entries name files that T0–T6 create and that do not exist yet
(`ci:feature-surface` fails on an entry that matches nothing). This is the
documented pre-implementation state (#867), not a defect. The row clears once
T0 lands the scaffold files.

**Verdict:** ACCEPT — expected before implementation; re-verified at the first post-T0 gate.

## 2026-09-11 — Codex round-3 appendix: flag-off helper ordering (T5 instruction)

The plan-skeptic's final round APPROVED the plan and left one untriaged note:
`failTurnAndCompleteOutbox` (plan T5 Step 10) fails the turn BEFORE the outbox
ownership CAS and ignores a false CAS result. T5's implementer applies the
opposite order inside the same transaction: `markOutboxCompletedIfOwned(tx, …)`
first; only when it returns true call `failTurnIfNonTerminal(tx, …)`; when it
returns false, write nothing (a newer dispatch owns the row). The flag-off unit
test (title 22) asserts the CAS runs first and that a false CAS leaves the turn
untouched.

**Verdict:** ACCEPT — an ordering fix inside one transaction; no contract change.

## 2026-09-11 — T0 lists `worker/config/__tests__/startup-assertion.test.ts` as Modify but specifies no edit

T0's **Files** block names `Modify:
worker/config/__tests__/startup-assertion.test.ts`, but none of Steps 1–3
assigns it a title (title 22, the only worker-flag title, goes to
`worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts`), and T0's Step 6
`git add` list omits the file. T0 therefore left it untouched: the steps and the
commit list agree, and the Files line is the outlier. The startup-assertion
change (the new flag-gated `agent_turn` lane in the worker-slot envelope) is
T5's, inside its own allowed surface.

Two smaller drifts in the same task text, neither acted on: T0 cites
`model-pinning.test.ts:51` as the file's last `it` (it is line 70 at b65c57197 —
the append landed at the true end of the `describe`), and T0's Step 1 scaffolds
five seam titles (`createTurn…`, `insertProposals…`, `buildSnapshot…`,
`reauthorizeTurn…`, `generateOperatorReply…`) that are not among the intake's 35
`tests_to_add`. Those five are written verbatim as T0 specifies, so the scaffold
holds 36 todos, of which 35 are the promised titles.

**Verdict:** ACCEPT — no title lost; the un-edited file carries no T0-owned title.

## 2026-09-11 — T1 Step 11 cites three test helpers that do not exist

T1's Step 11 snippet calls `makeRecordingExec`, `makeRecordingSql` and
`purgeRow` and instructs "use the file's existing mock-executor helper".
`src/lib/account-offboarding/__tests__/purge-verification.test.ts` has no such
helpers: its only executor is the `vi.hoisted` `mockSql` template tag shared by
the whole file. T1 defined the three locally inside the `owner operator purge`
describe, on the hoisted mock's exact shape (a template tag recording
`{ text, values }`, plus `.json` identity because `verificationQuery` reaches
for `exec.json(...)` on other branches), with `makeRecordingSql` additionally
carrying `.begin` (the stage's transaction entry) and returning an identifier
marker when the tag is called with a bare string, which is `deleteByBusiness`'s
`tx(tableName)` escape and must not be recorded as a statement. Per-case call
lists rather than the file-wide one so an arm's assertions read only its own
calls. The test title is verbatim and the assertions are exactly the ones the
plan specifies (bound values + query text, never an assembled SQL string). The
file also gained one import: `runContentPurgeStage` from
`worker/jobs/account-offboarding/purge-stages`, precedented by
`src/lib/agents/__tests__/run-spine.integration.test.ts`.

Two smaller drifts in the same task, both acted on the obvious way: (a) Step 4's
suite snippet destructures single-row results (`const [{ policy_count }] = …`),
which does not compile under this repo's `noUncheckedIndexedAccess` — T1 used
indexed access with a non-null assertion and said so in a comment; (b) Step 13
says to add the `120` entry "after the `119` entry", and T1 did exactly that
(between 119 and 118) even though the log's ordering is not strictly
descending — head line bumped to `120`/next `121`, entry marked **LOCAL-ONLY**.
Step 5's checkpoint ("PASS — two tests") also cannot hold before Step 6 lands
the registry rows; the registry title was RED at Step 5 and green immediately
after Step 6, which is the intended end state.

**Verdict:** ACCEPT — no contract change; the plan's named surfaces, titles and
assertions are all honoured.

## 2026-09-11 — T2 Step 5's route suite needs `NEXT_PUBLIC_APP_URL` pinned to its ORIGIN

T2's route-suite snippet builds every PUT against
`ORIGIN = 'https://app.repworth.test'` but never sets `NEXT_PUBLIC_APP_URL`.
`withSameOrigin()` → `assertSameOrigin` compares the `Origin` header against
that env var, which `vitest.setup.ts:16` defaults to `http://localhost:3000`, so
every PUT in the suite returned 403 before reaching the handler. T2 added one
line to the existing `beforeEach` — `process.env.NEXT_PUBLIC_APP_URL = ORIGIN;`
— which is exactly what the sibling settings suite does
(`src/app/api/settings/__tests__/route.test.ts:154`). The test title, the
assertions and every mock are verbatim as the plan specifies.

**Verdict:** ACCEPT — a suite-setup line, no contract change.

## 2026-09-11 — T2's new `src/lib/responses/voice-settings.ts` has no `docs/directory` row

`ci:directory-map` is CI-complete for `src/lib/`, so the new writer fails the
audit with "`src/lib/responses/voice-settings.ts` has no row in
docs/directory.md + docs/directory/\*.md". Its owning page is
`docs/directory/lib-reviews-responses.md` (§ `src/lib/responses/`), which is
**outside T2's edit lease** and outside T2's Step 9 `git add` list, so T2 did not
write it. The row is a one-line addition and must land before the branch's CI
gate goes green — the plan assigns it to no task, and the same gap will hit every
task in this run that creates a file under `worker/` or `src/lib/`.

**Verdict:** ACCEPT — resolved by T8 (commit `9301b8e89`): the row sits on the
sibling page `docs/directory/lib-owner-operator.md` under `### responses/
(continued)`, because the owning page is at its 3,000-word cap (see the
amendment #2 entry below). `ci:directory-map` passes at HEAD. Earlier text of
this verdict read "RE-PLAN (small) — STILL OPEN, assigned to T8"; the
orchestrator closed it at the step-6 read-back.

## 2026-09-11 — T2's GET change staleness-fails the tenant-scope allowlist

Step 7.3 adds `highlight_facts` to the all-locations GET `SELECT` list, which is
reproduced verbatim as the `sqlSnippet` of the
`src/app/api/settings/voice/route.ts` / `businesses` entry in
`scripts/ci/tenant-scope-allowlist.ts:677-682`. `pnpm ci:tenant-scope` now fails
with `businesses: unused tenant scope allowlist entry` — the snippet no longer
matches the source. The fix is to re-spell that one `sqlSnippet` with
`highlight_facts` between `avoid_facts` and `sample_responses`; the entry's
category and reason are unchanged, and the query is no less scoped than before.
**RESOLVED in T2** — the coordinator extended the lease to
`scripts/ci/tenant-scope-allowlist.ts`. The entry's `sqlSnippet` now carries
`highlight_facts` between `avoid_facts` and `sample_responses`, matching the
edited SQL; category and reason are untouched. `ALLOWLIST_BASELINE` did **not**
move — the entry was re-spelled, not added, and `pnpm ci:tenant-scope` reports
`passed — entries: 379 (baseline: 379)`. (T4's entry below records this same
failure as pre-existing; it was T2's, and it is now closed.)

**Verdict:** ACCEPT — fixture re-spelled to match its source; no baseline change.

## 2026-09-11 — T2 breaks the PRE-EXISTING voice route suite, which is outside T2's lease

T2's Files block and Step 9 `git add` list name only the NEW suite
`src/app/api/settings/__tests__/voice-route.test.ts`, and Step 8's regression
check runs `src/app/api/settings/__tests__/route.test.ts` — the *account*
settings route. Neither mentions
**`src/app/api/settings/voice/__tests__/route.test.ts`**, the route's own
pre-existing suite, which asserts on exactly what Step 7 extracts: the field →
column map, the location-ownership `SELECT`, and the `UPDATE`'s bound
`account_id`, all observed through a `sql` tagged-template double that has no
`.begin`. After Step 7 the PUT path issues no statements of its own, so 8 of its
18 tests fail (10 GET tests still pass):

- `updates tone for a specific location`
- `returns 404 when location not found or not accessible`
- `binds account_id as a parameterized value in the UPDATE WHERE clause (not interpolated)`
- `maps schema field tone → column tone` (and the `productsServices` ×2,
  `avoidFacts`, `sampleResponses` cases of the same table-driven `it.each`)

The behaviour those tests pin is preserved — it moved into
`src/lib/responses/voice-settings.ts` and is asserted by the new writer suite
(title 5) and the new route suite (title 6).

**RESOLVED in T2** (coordinator amendment #1 put the file in T2's surface). The
suite's PUT section now mocks `@/lib/db/server`'s `sql.begin` and
`@/lib/responses/voice-settings`'s `updateVoiceConfig` and asserts at that seam;
all five GET cases are untouched. **No case was deleted** — each of the 8 keeps
its verbatim title, and every behaviour it covered is still asserted:

- `updates tone …` now also pins one `sql.begin`, one writer call with
  `{ accountId, locationId, fields }`, and that the route issues no statements
  of its own on the PUT path.
- `returns 404 …` drives the writer's `{ ok: false, reason: 'location_not_found' }`
  (the ownership check is now the writer's locking `SELECT`) and asserts the body.
- `binds account_id as a parameterized value in the UPDATE WHERE clause (not
  interpolated)` keeps its title and asserts the route's half of that guarantee
  — the account scope crosses as a structured value and the route assembles no
  SQL text to interpolate into. The bound-parameter form itself is asserted
  against the REAL writer in `voice-settings.test.ts` (lock and UPDATE values
  both `[LOCATION, ACCOUNT]`); a comment in the case points there.
- the `maps schema field %s → column %s` table asserts both halves — the route
  forwards the camel field untouched, and the real (un-mocked)
  `VOICE_FIELD_TO_COLUMN` maps it to the expected column. A `highlightFacts →
  highlight_facts` row was added, making the table the full five-field map.

Three cases were ADDED for branches the extraction newly exposes at this seam:
`no_fields` → 400, a throwing writer → 500, and (inside the existing past-due
case) that neither `sql.begin` nor the writer runs when the gate refuses.

**Verdict:** ACCEPT — re-pointed, not weakened; 21 tests in the file, all green.

## 2026-09-11 — T3's `render.test.ts` fixture says `threshold: 'manual'`, a value `RuleSummary` cannot hold

T3 Step 2's suite snippet builds its `Snapshot` fixture with
`operatingRules.account.threshold = 'manual'` (twice), but the `RuleSummary`
declaration T3 must copy verbatim into `context.ts` types it as
`AutoApprovalThreshold | null`, and `AutoApprovalThreshold` is
`z.union([z.literal(4), z.literal(5)])` (`src/lib/auto-approval/types.ts:5`) —
`'manual'` is outside the domain and the fixture does not compile. The two
readings are semantically the same thing: the plan's own JSDoc says "null means
no threshold is set", which is what `'manual'` was reaching for. T3 kept the
TYPE verbatim (T5 and the Run B comparison depend on it) and changed the two
fixture values to `null`, with a one-line comment in the suite saying so. No
assertion in any of the six render titles reads `operatingRules`, so no
behaviour moved. The same fixture spelling appears once more in the plan at
`feat-owner-operator-run-a-plan.md:5530` (a T6/T7 suite) and will need the same
one-word fix there.

Two smaller drifts in the same task, both acted on the obvious way: (a) T3 Step 6
says the `context.ts` type declarations are "exactly as T5 Step 3 declares them",
but T5 Step 3 registers the LLM task — the declarations are in **T5 Step 6**, and
that block is what T3 copied; (b) that block declares a seventh type,
`SnapshotFacts`, which T3's named list (`Snapshot`, `SnapshotMetrics`,
`StarBands`, `SnapshotTurn`, `SnapshotProposal`, `RuleSummary`) omits —
`Snapshot.facts` is typed with it and it carries the invariant-5 reason for
existing, so it shipped with the other six, along with `StarBandKey` which
`StarBands.byStar` needs. T3 also dropped the unused `type Segment` from
`render.ts`'s import list (the plan's snippet imports it and never uses it;
`no-unused-vars` fails the file as written).

**Verdict:** ACCEPT — the type wins over the fixture, no contract change, and
the plan's own line 5530 is flagged for the task that owns it.

## 2026-09-11 — T4 Step 1 cites two test helpers that do not exist, and Step 8's route suite omits the app URL its own Origin needs

Two drifts in T4's snippets, both adapted rather than imported:

(a) Step 1 calls `makeRecordingTx` and `jsonPayload` and says to reuse "the one
the sibling `enqueueJudgeVerdict` case uses".
`src/lib/shared/__tests__/job-outbox-helpers.test.ts` has neither: its helpers
are `createMockTx`, `sqlText(call)` and `objectArgs(tx)`, and every sibling case
reads the payload through `objectArgs`. T4 used those. The plan's `call.values[n]`
indices are preserved as `call.slice(1)[n]` — this file's double records
`[strings, ...values]`, so each bound value is offset by one — and every
assertion the plan names (topic, `aggregate_type` `'agent_turn'`, `aggregate_id`
= the turn id, `status` `'pending'`, the `'outbox-uuid'` id, no `ON CONFLICT`,
the exact four-key payload) is asserted verbatim.

(b) Step 8's route suite builds every request with
`ORIGIN = 'https://app.repworth.test'`, but `withSameOrigin()` compares the
Origin header against `NEXT_PUBLIC_APP_URL`, which `vitest.setup.ts` defaults to
`http://localhost:3000` — as written, all five cases would have 403'd on the app
URL rather than on the behaviour under test. T4 sets
`process.env.NEXT_PUBLIC_APP_URL = ORIGIN` in the suite's `beforeEach`, beside
the `OWNER_OPERATOR_ENABLED` line the plan already puts there. Two assertions
were also added inside the plan's own titles, neither changing a contract: the
Origin case exercises the MISSING half its title promises (no Origin header →
the same 403), and the flag-off case asserts `requireRole` was never called,
which is what "before any write" means for a gate that runs ahead of auth.

Two further things T4 owns that its task text does not step through. The extra
T0 seam todo in `src/lib/agents/operator/__tests__/turns.test.ts` (`createTurn
assigns the next sequence under the conversation row lock`) has no step in T4 —
it was written from the plan's C8/F6 lock-order decision as a mocked-`sql`
recording double, asserting that the `FOR UPDATE` precedes the turn-key read,
that the sequence is read after the lock and bound into the INSERT, that the
outbox row rides the same transaction after the turn insert, and that every
statement except the `job_outbox` one carries `account_id`. And Step 10's
`const [{ next_sequence }] = …` destructure does not compile under
`noUncheckedIndexedAccess` (the same drift T1 hit); `turns.ts` uses indexed
access with a non-null assertion and says so in a comment.

Two audits are RED for reasons outside T4's edit lease, neither caused by it:
`ci:env-registry` fails on `OWNER_OPERATOR_ENABLED` having no row in
`docs/eservices-variables.md` / `.claude/reference/env-vars.md` — those rows are
T8's, exactly as T4's brief anticipates. `ci:directory-map` fails on all six new
`src/lib/agents/operator/*.ts` files (T2/T3's four plus T4's `flags.ts` and
`turns.ts`) and on T2's `src/lib/responses/voice-settings.ts`; `docs/directory*`
is in no implementer's lease. `ci:tenant-scope` also fails, on a finding that
predates this task and is untouched by it: a stale allowlist entry for
`src/app/api/settings/voice/route.ts` (`git diff HEAD` shows neither that route
nor `scripts/ci/` modified). T4's own statements add no finding.

**Verdict:** ACCEPT — no contract change; every plan-named title, assertion and
surface is honoured, and the three RED audits belong to other tasks.

## 2026-09-11 — T5: Step 12's flag-off assertions contradict the accepted helper ordering, and three smaller drifts

**(a) The contradiction, resolved toward the binding decision.** The
"flag-off helper ordering" entry above is ACCEPTED and says
`failTurnAndCompleteOutbox` must run `markOutboxCompletedIfOwned(tx, …)` FIRST
and transition the turn only when the CAS returns true — and that title 22
"asserts the CAS runs first". T5's own Step 12 snippet asserts the opposite
(`calls[0]` = `UPDATE agent_turns`, `calls[1]` = `UPDATE job_outbox`). The
binding decision wins: the helper CASes first, writes nothing when the CAS
returns false, and the test asserts that order. The title is verbatim; the case
additionally drives a losing CAS (a second mocked `sql` whose `count` is 0) and
asserts NO `agent_turns` statement is issued, which is the half the ordering
exists for.

**(b) "Exactly two statements" needs a fragment filter.**
`markOutboxCompletedIfOwned` composes its WHERE from the shared `dispatchedRow`
FRAGMENT (`src/lib/shared/outbox.ts:19`), which is itself a tagged template and
is indistinguishable from a statement at the plan's recording double — the
flag-off path records THREE calls, not two, under either ordering. The suite
adds a `statementsOf` filter (leading `UPDATE|SELECT|INSERT|DELETE`) and asserts
two STATEMENTS in the stated order; the outbox id, which is bound inside the
fragment rather than the outer UPDATE, is asserted against the unfiltered list.

**(c) `status_ref.metric` is a bounded `string`, not `StatusMetric`.** T3's
`StatusRefSegmentSchema` types `metric` as `z.string().trim().min(1).max(40)` so
that `validateModelOutput` can reject an out-of-domain metric WITH A REASON
rather than failing shape validation anonymously. Step 14's
`materializeStatus(segment.metric, …)` therefore does not compile. The worker
narrows with a local `isStatusMetric` guard and DROPS an unreachable miss rather
than throwing: the validator has already refused it, the turn's budget is spent,
and a throw would be classified transient and retried without converging. The
`map` became a `for` loop so the non-`status_ref` arm keeps its `StoredSegment`
narrowing.

**(d) Two smaller drifts, both acted on the obvious way.** Step 10's import line
says to bring `TURN_FAILURE_REASON` into `turns.ts` "for the worker's use"; the
value is never referenced there (the worker imports it from `schema.ts` itself,
per Step 14) and an unused value import fails `no-unused-vars`, so only the
`TurnFailureReason` type is imported and a comment records why `markOutboxFailed`
is likewise absent. And `worker/jobs/agent-turn/constants.ts` is in T5's Files
block and its Step 22 `git add` list (`worker/jobs/agent-turn`) but not in the
coordinator's per-file edit lease; it was written as the plan specifies.

Two audits are RED for reasons outside T5's edit lease, exactly as the brief
anticipates: `ci:env-registry` on `OWNER_OPERATOR_ENABLED` having no row in
`docs/eservices-variables.md` / `.claude/reference/env-vars.md`, and
`ci:directory-map` on the operator files — T5's four new ones
(`prompt.ts`, `model-call.ts`, `proposals.ts`, `authorize.ts`, plus the three
under `worker/jobs/agent-turn/`) join T2/T3/T4's in the same T8 sweep.

**Verdict:** ACCEPT — the binding decision resolves the one contradiction; the
other three are compile/lint adaptations with no contract change.

## 2026-09-11 — T6: `rules.vetoWindowMinutes` cannot be `VetoWindowMinutes` and null at once, plus the flagged `'manual'` fixture

**(a) The type contradiction, resolved by widening one field.** T6 Step 3
declares `OwnerConversationView.summary.rules.vetoWindowMinutes` as
`VetoWindowMinutes`, which is `z.union([z.literal(15), z.literal(30)])`
(`src/lib/auto-approval/types.ts:41`) with no null member — and then the
no-turns branch of `getConversationForOwner`, six lines below in the same
snippet, returns `vetoWindowMinutes: null`. As written the module does not
compile. T6 widened the FIELD to `VetoWindowMinutes | null` rather than
inventing a value for the empty branch: with no turns there is no location to
scope a rule read to, and null there means "no rules to report" — the same
reading the sibling `threshold: null` and `facts: null` already carry in that
branch. A one-line comment in the declaration says so. Nothing changes on the
populated path, where the value still comes from
`locationSettings?.effective.vetoWindowMinutes ?? settings.accountDefault.…`
and is always 15 or 30.

**(b) The `'manual'` fixture the T3 entry pre-flagged.** T6's conversation-suite
snippet builds its summary fixture with `rules.threshold: 'manual'` — the same
spelling the T3 entry above flagged at `feat-owner-operator-run-a-plan.md:5530`
as needing "the same one-word fix". T6 made it `null`, with a comment in the
case. The mock is untyped so `'manual'` would have compiled, which is precisely
why it had to be fixed by hand: a fixture asserting a value the domain cannot
hold teaches the next reader the wrong union. No assertion reads
`summary.rules.threshold`, so no behaviour moved.

**(c) Two smaller things, neither a contract change.** T6's edit lease allowed
`proposals.ts` "only if the plan's T6 step adds a list read there" — it does
not: `listProposalsForTurn`, `listPendingProposals` and `listUnsupportedForTurn`
all landed in T5, so the file is untouched. And both route suites gained a
flag-off case inside their existing verbatim title (the turn suite's was already
in the plan; the conversation suite's was added to match), asserting the 404 and
that `requireRole` was never called — which is what "before auth" means for a
gate that runs ahead of it.

`ci:feature-surface` was RED until this task's commit: its two
`allowed_edit_surface` entries for the new route files matched nothing while the
files were untracked (#867, the same pre-implementation state the baseline entry
above records). It is green at the commit. `ci:env-registry` and
`ci:directory-map` remain RED for T8's rows — `docs/directory` now also owes no
new row for T6, which creates no file under `worker/` or `src/lib/`.

**Verdict:** ACCEPT — one widened field resolves the compile contradiction; the
fixture fix was pre-authorised by the T3 entry.

## 2026-09-11 — surface amendment #2: `docs/directory/lib-owner-operator.md` (orchestrator)

`wc -w` at T8 dispatch: `docs/directory/lib-platform.md` 3,000 and
`docs/directory/lib-reviews-responses.md` 3,000 — both exactly at the
reference-shape cap, zero headroom. T8 owes eleven `src/lib` rows (ten under
`agents/operator/`, one for `responses/voice-settings.ts`) that `ci:directory-map`
requires and the cap forbids on those pages. `docs/directory.md`'s own Pages
convention sanctions a sibling page with a `### responses/ (continued)`
section, so T8 writes `docs/directory/lib-owner-operator.md` and adds its
Pages-table row. Counted mechanically as amendment #2 with `--reason`. This is a
docs-only file inside a tree the surface already covers, not a code-scope
change: the abort criterion's "2nd surface amendment" targets scope drift, and
the reclassify trigger is recorded here rather than fired. Owner may veto at
review.

**Verdict:** ACCEPT — forced by a word cap, not by scope.

## 2026-09-11 — T7: five of the plan's live-DB fixtures do not match the live schema, and one assertion does not compile

Six drifts, all adapted rather than argued with — the schema and the landed
types win, exactly as the brief says.

**(a) Four INSERT fixtures contradict the live tables.** `reviews` has no
`source` column (it is `provider`, defaulted `'google'`) and carries three NOT
NULL provider identifiers the plan's snippet omits — `provider_review_id`,
`provider_review_name`, `provider_location_name` — with `unique_provider_review`
on `(provider, provider_review_name)`, so the name is minted per row.
`responses.original_draft_text` is NOT NULL and absent from the plan's seed.
`flagged_responses` requires `account_id`, `review_id` and a `source` inside
`flagged_responses_source_check` ('local_regex' here), none of which the plan's
INSERT supplies. T7 added exactly those columns and changed nothing about what
each case asserts; the hand-counted star bands in title 32 are unchanged.

**(b) The two casts the plan pre-authorised are not needed.**
`VerifyAccountOffboardingPurgeInput`
(`src/lib/account-offboarding/purge-verification.ts:9`) requires only
`accountId` + `offboardingId`, and `AccountOffboardingPurgeRow`
(`worker/jobs/account-offboarding/purge-stages.ts:30`) carries five columns the
plan's literal omits (`location_ids`, `stripe_step`, `zernio_accounts_step`,
`zernio_profiles_step`, `location_archival_step`). Both are spelled in full and
typed, so the purge case carries no `as never`.

**(c) Title 23's `status_ref` assertion is a compile error, not a test.**
`stored.some((segment) => segment.type === 'status_ref')` does not typecheck:
`StoredSegment` has no `status_ref` member, which is the type-level form of the
very guarantee the line was reaching for (TS2367). The runtime half is asserted
instead, against the RAW `agent_turns.reply` value —
`expect(JSON.stringify(turn.reply)).not.toContain('status_ref')` — with a
comment recording that the stronger half is free and structural.

**(d) `secondLocationId` is seeded but unused in the worker suite.** The plan's
harness seeds a second location for `turn-worker.integration.test.ts` and no
case reads it, which fails `no-unused-vars`. T7 dropped it from that suite
rather than inventing a title for it; the snapshot suite seeds and uses its own
(title 32's account aggregate needs it).

**(e) `context.test.ts`'s seam todo needs three collaborator mocks.** Driving
`getAutoApprovalSettings` / `getLocationsForAccount` / `readVoiceConfig` through
the recording `sql` double would test THEIR null-handling against an empty
return queue, not `buildSnapshot`'s scoping. They are mocked at the seam and
their own account scoping is asserted through the arguments they were called
with; the four statements `buildSnapshot` owns are asserted to bind the account
id, the list is closed at four, and the two conversation-scoped reads are
asserted to carry the account beside the conversation.

**(f) `insertProposals` tags FOUR JSONB columns, not three.** `input`, `before`,
`after` AND `prepared_version_token` all cross through `tx.json`
(`src/lib/agents/operator/proposals.ts`), so the double-encode assertion counts
`rows.length * 4`.

Fixture bite verified by mutation, not by a green run alone: changing title 23's
`markDispatched(db, outboxId, 2)` to `3` turns the terminal-redispatch arm red
(`expected 'dispatched' to be 'completed'`), which is the CAS the whole harness
exists to make real.

**Verdict:** ACCEPT — schema and landed types over the plan's snippets; no
title lost, no assertion weakened.

## 2026-09-11 — T8: three small departures from the task text

**(a) No pointer sentence on the two donor directory pages.** The orchestrator's
amendment-#2 instruction allowed a one-line pointer in `lib-platform.md`'s
`### agents/` intro and `lib-reviews-responses.md`'s `### responses/` intro
"only if it fits under the cap". Both pages measure **exactly 3,000** words, the
cap itself, so any added word fails `reference-shape.test.ts`. Both pages are
therefore untouched and `docs/directory.md`'s Pages table is the sole record of
where the Operator rows went — which is the fallback the instruction named, and
also the convention `docs/directory.md` already states ("a small folder may sit
on a sibling page to keep that page under the cap; the row here is the record of
where it went"). No `git add` entry for either file.

**(b) The spec's status line was updated, though T8 does not say to.** It read
`**SELECTED, NOT STARTED**`, which is false the moment §15 gains a "Run A built"
entry — two facts on one page contradicting each other. Changed to
`**RUN A BUILT, FLAG OFF EVERYWHERE**` with the Run A / Run B split named. A
factual correction to a line T8's own §15 step falsifies, not new scope.

**(c) `docs/context/owner-operator.md` and `CONTEXT-MAP.md` were re-checked and
need no change — and are outside T8's edit lease anyway.** Step 6 names three
likely drifts; all three are already correct as landed: the glossary never
asserts `requires_confirmation` (the term is not defined there), the
**Proposal** entry states the supersession by behaviour rather than by the
`IS NOT DISTINCT FROM` spelling, and **Turn claim** already says "bounded by a
180-second lease" — the L2 value, not the superseded 120 s. Verified against
`worker/jobs/agent-turn/constants.ts`, `src/lib/agents/operator/proposals.ts`
and `catalog.ts`. Nothing edited.

**Verdict:** ACCEPT — (a) is the instruction's own fallback, (b) removes a
self-contradiction, (c) is a no-op. Orchestrator correction to (b) at the
step-6 read-back: the status line now reads "RUN A IN REVIEW on branch …,
unmerged; flag off everywhere" — "BUILT" overstated an unmerged branch.

## Step-6 read-back (orchestrator, 2026-09-11, HEAD after T8)

Every entry above re-read end to end. One-line verdicts, in file order:

1. `grill-with-docs` absent — **ACCEPT** (ticket-seeded delta grill; decisions on disk).
2. Baseline gate RED on `feature-surface` — **ACCEPT** (cleared at the T0 commit; T6's entry confirms `feature-surface: passed`).
3. Codex round-3 flag-off ordering — **ACCEPT** (T5 applied CAS-first; title 22 pins it).
4. T0 startup-assertion file listed, not edited — **ACCEPT** (T5 owned the edit).
5. T1 missing test helpers / `noUncheckedIndexedAccess` / log ordering — **ACCEPT** (no contract change).
6. T2 `NEXT_PUBLIC_APP_URL` in the suite — **ACCEPT** (sibling-suite precedent).
7. T2 `voice-settings.ts` directory row — **ACCEPT** (closed by T8, see the amended verdict).
8. T2 tenant-scope allowlist snippet — **ACCEPT** (re-spelled, baseline unchanged).
9. T2 pre-existing voice route suite — **ACCEPT** (surface amendment #1; re-pointed, no case deleted).
10. T3 `threshold: 'manual'` fixture — **ACCEPT** (type wins; T6 applied the same fix).
11. T4 missing helpers / app URL / seam todo / destructure — **ACCEPT**.
12. T5 flag-off assertion order + three drifts — **ACCEPT** (binding decision wins).
13. T6 `vetoWindowMinutes | null` + fixture — **ACCEPT** (compile contradiction resolved by widening).
14. Surface amendment #2 (sibling directory page) — **ACCEPT** (forced by a word cap; docs only).
15. T7 five live-schema fixture drifts + one TS2367 — **ACCEPT** (schema and landed types over snippets; no production defect surfaced).
16. T8 three departures — **ACCEPT** with the status-line correction above.

No RE-PLAN remains. No entry invalidates a locked intake decision.

## 2026-09-11 — first full review gate at d2cbf1459: two RED rows, neither a production defect (orchestrator)

1. `test` — `src/__tests__/cost-guard-contract.test.ts` "every runLlmTask call
   site is in the reviewed-caller allowlist": the new tenant
   `src/lib/agents/operator/model-call.ts` was not on `CALLER_ALLOWLIST`. The
   test's own instruction is to add the reviewed caller there. That file is
   outside the intake surface → **surface amendment #3** (counted with
   `--reason`; one test-file entry, the caller is already guarded reserve-first
   inside `withCostGuard`). Entry added with the guard-shape comment.
2. `test` — `src/lib/config/__tests__/server.test.ts` "getResendConfig throws
   when RESEND_API_KEY is missing": a gate-run environment leak, not code. The
   orchestrator sourced `.env.local` into the gate process to hand the live-DB
   rows `TEST_DATABASE_POOL_URL`, which also exported `RESEND_API_KEY`. The gate
   resolves the DB URL itself (`resolveTestDatabaseUrl` falls back to
   `.env.local` on disk — lab-notes/live-db-test-suites.md), so the re-run
   sources nothing.
3. `merge-ledger` — the audit requires the `arch-review-log.md` line at PR time,
   not at step 8; the line is written now (counter untouched — "the pass
   decides").

**Verdict:** ACCEPT — one allowlist entry, one gate-invocation correction, one
ledger line; no contract change.

## 2026-09-11 — review round 1: five findings triaged REJECT, two accepted as documented-only

Round-1 fixes applied 33 accepted findings
(`docs/reviews/feat-owner-operator-run-a/review-round-1.md`). The seven rows
below are the ones that produced NO code change, recorded here so a later
reader does not re-open them as oversights.

**Rejected (5) — with the triage reason:**

1. **CA5** — envelope 11→12 bypasses ADR 0005's ~10 semaphore trigger.
   REJECTED on an owner decision taken in the grill (map-level question,
   2026-09-11): the third lane is flag-gated at concurrency 1, the ADR 0005
   amendment is written, and the NON-GATED sum stays at 9. The lane is
   owner-interactive and rare. Revisit when the semaphore trigger actually
   fires, not inside this run. Listed under "Red-team/review findings rejected"
   in the PR.
2. **SM8** — `job-outbox-helpers.ts` (976→1027) and `worker/index.ts`
   (982→1006) cross 1,000 lines. REJECTED: both are REGISTRIES that grow by
   exactly one entry per topic/worker by repository design (32 topics, one
   helper each; one Worker per queue). Splitting a registry is its own refactor
   with its own audit — `ci:outbox-seam` derives helper ownership from that
   file — and doing it inside a feature branch would put the audit and the
   feature in one diff.
3. **SM13a** — `modelVisibleOperations(_tier)` ignores its parameter. REJECTED:
   `_tier` is threaded deliberately for Run B by plan decision L5. The
   tier-gated operations are the three auto-approval ones, which Run A does not
   register; removing the parameter now means re-threading `subscriptionTier`
   through `Snapshot`, `BuildSnapshotInput` and `authorize.ts` when Run B adds
   them. (SM13b, `proposalSummaries` always `[]`, WAS accepted — it is SC5 and
   is now populated from `listProposalsForTurns`.)
4. **SM14** — `parseJsonbObject` / `nullableIso` duplicate `src/lib/agents/read.ts`.
   REJECTED for this run: `read.ts` is outside the intake's
   `allowed_edit_surface`, and it EXPORTS neither helper, so "reuse" would mean
   editing a file this run may not touch. The PgBouncer JSONB allowlist is
   owned per parse site by design (lab-notes/postgres.md), which is what makes
   two small copies the cheap option. Follow-up: fold both into a shared
   `src/lib/agents/` helper when a change lands that may edit `read.ts`.
5. **RT12** — `not.toContain('status_ref')` is an absence proxy. REJECTED
   (recorded): the surrounding comment argues the limitation honestly, the
   `StoredSegment` type carries the stronger half (the stored union has no
   `status_ref` member, so the type-level assertion is a compile error rather
   than a test), and RT8's equality assertion now sits directly beside it —
   each materialized value is compared against its OWN seeded metric.

**Accepted as documented-only (2) — no code change in this run:**

6. **CA1 (dispatch-exhaustion half)** — five poller dispatch failures
   terminalize the `job_outbox` row while the turn is still `accepted`;
   successors fail `predecessor_stalled` after 20 min but the turn itself never
   resolves. The "permanently disagree" half was REJECTED — a stale-attempt
   completion is closed by the terminal-turn branch on the next dispatch
   (`readTerminalTurn` → `markOutboxCompletedIfOwned`), proven live by the
   claim-race case's third dispatch. The remaining half needs `OutboxPoller`,
   which is outside this run's surface, so it is a Run B item: spec §14.
7. **CA4 (predecessor wait vs watchdog reclaim)** — the 20-minute predecessor
   wait outlives the 15-minute watchdog window, so a waiting turn can be
   re-dispatched. ACCEPTED AS A TRADEOFF, no code change: a redundant dispatch
   is safe by construction (the **Turn claim** serialises; the loser exits) and
   at the default watchdog it happens at most once per wait. The alternative —
   a durable waiting state, or sequence-aware outbox dispatch — changes
   `OutboxPoller`. Recorded in spec §14 with both clocks named.

**Adaptations made while applying the accepted findings** (nearest correct
thing, not a departure from intent):

- **CA2/SC2** removed `proposal_ref` from the STORED union rather than leaving
  it beside the new `proposal` member — exactly as `status_ref` is absent from
  it. The consequence is that `RenderContext` no longer carries `proposalIds`
  at all, so the read path cannot re-derive an index even by mistake. Because a
  stored `proposal` segment then carries only an id, `OwnerConversationTurn`
  gained a `proposals` field fed by SC7's batched `listProposalsForTurns` —
  `summary.pendingProposals` could not stand in, being pending-only, and a
  superseded card still belongs to the sentence that proposed it.
- **SM7** bumped `OWNER_OPERATOR_PROMPT_VERSION` to `2026-09-11.2`: the fix
  edits `OWNER_OPERATOR_SYSTEM_PROMPT`, and the version + hash are recorded on
  every `api_costs` row precisely so a prompt edit is visible in the ledger.
- **SM9** left the single-location voice GET issuing TWO reads —
  `readVoiceConfig` (which owns the account-scoped 404) and a narrow
  name/`display_label` read. The review itself names the display label as the
  one genuine difference and a different concern (`getDisplayLabel`).

**Verdict:** ACCEPT — five rejections stand on owner decisions, surface bounds
or registry design; the two documented-only items are recorded in spec §14 as
Run B work; the three adaptations carry the accepted findings' intent without
widening them.

## 2026-09-11 — review round 2: two P0 oracle gaps accepted, one deferred to go-live alerting

Round 2 was the VERIFICATION wave over round 1's fix commit `eb21f55c2`: a
fresh spec-and-correctness agent, a fresh standards agent, and a red-team round
scoped to the fix hunks. All five round-1 P0 mutants are now KILLED, SC1–SC7
and CA2/CA3 are ADDRESSED, and SM1–SM7/SM9–SM12/SM15 are ADDRESSED. Round 2
raised ten new findings; eight were accepted and applied in this commit
(R1–R7, R10), and the remainder are recorded here.

1. **Codex adversarial round 2 did not run.** `codex exec resume` refused the
   companion's thread (`thread/resume: no rollout found for 01a09406…`): the
   session is not resumable on this machine, and the plan-phase thread id in
   the handoff is therefore dead for the rest of the run. Its two round-1 code
   findings (CA2, CA3) were verified ADDRESSED by the spec axis instead, and
   its other three were documented or rejected in round 1, so no finding lost
   its adjudicator. Recorded rather than retried: a cold Codex round would
   review the fix hunks without round 1's context, which is a different review,
   not the one that was owed.
2. **R8 (P2, absence-of-token proxies in the new render tests) — REJECTED,
   recorded.** Same class as round-1 RT12 and rejected on the same grounds: the
   `not.toContain` assertions sit BESIDE positive assertions on the same
   render, so an empty or collapsed output fails the positive half first. An
   absence assertion alone would be the finding; an absence assertion paired
   with the presence it is the complement of is not.
3. **R9 (P2, terminal paths emit `logger.warn` only, no Sentry rule row) —
   DEFERRED to the go-live alerting adjudication.** Real, and uniform across
   all six terminal paths in `AgentTurnWorker` rather than particular to the
   one this run added — five of them pre-date the fix. Escalating the new line
   alone would open a front on unchanged code and would leave the lane's
   alerting decided in six places. Recorded as one spec §14 item at ship, to be
   taken with the rest of Run A's alerting before the pilot.
4. **spec-r2 low #2 (`summary.facts.updatedAt` serializes as Postgres text) —
   DOCUMENTED, no change.** That spelling IS the **Version token**: `updated_at::text`
   end to end, because postgres.js decodes `timestamptz` into a JS `Date` and
   silently truncates the microseconds Postgres stores, so a token built from a
   round-tripped `Date` compares EQUAL to a row written up to a microsecond
   later. Run B's Apply compares text to text. The DTO comment says so, and
   R7 below extends the same spelling to the writer, which was the one site
   still disagreeing by format.
5. **standards-r2 maintainability lows (3) — DEFERRED to Run B.** `render.ts`
   gained a fourth concern; the ten-column proposal `SELECT` is spelled three
   times in `proposals.ts`; the `UnsupportedRow` map is left in the worker
   handler. All three are readability, none is a defect, and Run B reworks both
   files anyway — `render.ts` for Apply cards and `proposals.ts` for the
   proposal lifecycle. Doing them now would rewrite code Run B rewrites again.

**Applied in this commit (R1–R7, R10)** — every one is a test-oracle or
citation fix; the single production edit is R7's `RETURNING` clause:

- **R1 (P0)** `listProposalsForTurns` was fake-covered: an always-empty Map
  survived both consumers. `reads.integration` now seeds three turns (two with
  stored proposals, one without) and asserts `turns[].proposals` by id,
  operation and status, the catalog-recomputed `describe`, and `[]` on the turn
  that proposed nothing; `snapshot.integration` asserts `proposalSummaries`
  carries each operation's catalog sentence. Both kill the empty-Map mutant,
  verified by applying it and reverting.
- **R2 (P0) + R4 (P1)** `locationOverrideExists` had no non-mocked oracle and
  the only rules assertion was `vetoWindowMinutes > 0`. Both live suites now
  seed an `auto_approval_policies` override on ONE of the account's two
  locations and assert `true` there and `false` on the other, with equality
  against the seeded dials (30 / 7 / threshold 5) and against the inherited
  defaults. The forced-`true` mutant is killed in both.
- **R3 (P1)** the `if (!voice)` terminal branch now has a unit case: claim,
  reauthorize, snapshot and generate all succeed, `readVoiceConfig` returns
  null, and the assertions are `failTurnFenced` writing `unauthorized` fenced
  on the attempt token, the outbox CAS in the SAME transaction, and no
  `agent_proposals` write at all. `@/lib/agents/operator/turns` is mocked
  PARTIALLY (only `claimTurn`), so the real `failTurnFenced` is what the
  statements come from.
- **R5 (P1)** `context.test.ts`'s closed list is closed again: the fixture now
  returns one historical turn, so the batched proposal read issues its
  statement and the count is 5, with the `turn_id = ANY` read's account and
  turn-id bindings asserted.
- **R6 (P1)** the plan's two remaining `voice/route.ts:23` citations (the same
  table round 1's F10 corrected) now name the symbol — the `GET` handler —
  rather than a line the fix itself moved.
- **R7 (P1)** `updateVoiceConfig` returns `RETURNING updated_at::text`, the
  read's spelling, so the two **Version token** producers agree byte for byte.
  The writer's unit test asserts the `.123456` fixture survives verbatim and
  the route test asserts the PUT response passes it through unformatted.
- **R10 (P2)** `asTurnStatus` / `asProposalStatus` throw branches have a case,
  including the cross-vocabulary arms (a legal proposal status is not a legal
  turn status).

**Verdict:** ACCEPT — the two P0s were oracle gaps, not defects in shipped
behavior, and both mutants are now killed; R8 is rejected on the same reasoning
as its round-1 twin; R9 and the three maintainability lows are deferred to
owners that already exist (spec §14, Run B) rather than to nobody.

## 2026-09-12 — the fallow gate (PR #1270): four findings, all cleared behavior-preservingly

`fallow` (`pnpm ci:fallow:coverage`, new-findings-only vs `origin/main`) was the
only red check on the PR. Four findings, no production defect among them — each
is a shape the gate can see and a reviewer would not.

- **Complexity, `render.ts:127 validateModelOutput` (CRITICAL — 25 cyclomatic,
  40 cognitive).** One function carried four unrelated rule families over one
  segment loop. Split into four per-concern passes in the same file —
  `validateTextSegments`, `validateRefSegments`, `validateScopeCheck`,
  `validateProposals` — plus `validateProposalScope`, which keeps the proposal
  pass itself under the threshold. Every rule and every reason string is
  byte-for-byte what it was; the public function concatenates the four reason
  lists and returns the parsed proposals `validateProposals` carried forward.
  **One deliberate departure from the finding's wording:** `validateProposals`
  returns `{ reasons, proposals }` rather than a bare `string[]`, because it is
  the pass that also does the catalog lookup and `parseInput` exactly once —
  making it return only reasons would reintroduce the second lookup the
  `ParsedProposal` seam exists to remove. The other four return `string[]`.
  The only observable change is reason ORDER when an output breaks rules in
  more than one family: now grouped by concern rather than interleaved by
  segment. Nothing reads the order — `render.test.ts` asserts through
  `reasons.join(' ')` and the retry prompt quotes the set. `STATUS_METRICS` is
  now a module-level `Set` rather than one built per call.
- **Complexity, `AgentTurnWorker.ts:40 handleAgentTurn` (20 cognitive, 273
  lines).** Extracted four in-file helpers named for the step comments —
  `settleClaimMiss`, `waitOrFailOnPredecessor`, `generateAndAssemble`,
  `handleTurnError` — so the handler is the flag check, the claim, and four
  calls. No new file, no changed call order, no changed log line or fenced
  transition. The outbox handle became one `OutboxHandle` object spread at each
  site, which is why the `{ outboxId, outboxAttempt }` pairs read as
  `...outbox` now. `AgentTurnWorker.test.ts` and
  `turn-worker.integration.test.ts` pass unchanged.
- **Dead code: 7 unused exports, 3 unused types.** `export` dropped (symbols
  kept, all still used inside their own file) on `SegmentSchema`,
  `StoredSegmentSchema`, `ProposedOperationSchema`, `UnsupportedRequestSchema`
  (schema.ts), `OWNER_OPERATOR_SYSTEM_PROMPT` (prompt.ts),
  `PASTED_REVIEW_SEGMENT` (render.ts) and the `VoiceField` type
  (voice-settings.ts). Three symbols had NO consumer at all and were deleted:
  the `ProposedOperation` and `UnsupportedRequest` type aliases, and
  `CATALOG_OPERATION_IDS` — the last became the literal union
  `CatalogOperationId` it only ever fed, which also settles the
  second-wider-list hazard prompt.ts already warns about in a comment. No
  suppressions were added.
- **Duplication: `schema.ts:221-226` vs `read.ts:212-217` (`parseJsonbObject`).**
  Byte-identical copies. `read.ts` now exports the one parser and `schema.ts`
  re-exports it, so `proposals.ts` and the live suites keep importing it from
  their own module. The message prefix went from the per-module `agents/read:` /
  `agents/operator:` to a plain `agents:` — the `column` argument is already
  fully qualified (`agent_runs.error`, `agent_proposals.before`), so it names
  the site better than a module label did, and nothing asserts the string.
  Lab-note `postgres.md` "PgBouncer JSONB parse-site allowlist" updated: it had
  said "both parsers in `operator/schema.ts`", which is now false. The site
  COUNT and every listed site are unchanged.

**Surface amendment #4:** `src/lib/agents/read.ts` added to
`allowed_edit_surface` in the intake. The duplication finding names both files
by line; clearing it from inside `operator/` alone is impossible, and the
alternative (a third copy, or a suppression) is what the gate exists to stop.
The change to that file is one `export` keyword, one error-message prefix and a
doc comment.

**Verdict:** ACCEPT — four gate findings, four behavior-preserving fixes, no
suppression and no widened scope. `pnpm ci:fallow` reports 0 dead code, 0
complexity, 0 duplication across 91 changed files; the operator, agent-turn,
voice-settings and agents suites pass 116/116 with the live DB attached;
typecheck, `ci:directory-map` and `ci:db-imports` pass.

## 2026-09-12 — fresh red-team round 1 at `5b223e33f`: OPEN_P0; surface amendment #5

The closed three-round run (preserved under `…-b83a4f-rounds1-3/`) was voided by
the fallow refactor (`15bc4a4aa`) and by intake amendments #3/#4. Before the
fresh pass the branch took `origin/main` (`10c9444a9`, docs-only, one commit) by
merge — owner decision via `AskUserQuestion`: PR #1270 reported `BEHIND`, so the
update was owed at merge time regardless, and taking it BEFORE the pass costs one
gate run instead of a second adversarial pass. The fresh round 1 ran at
`5b223e33f` with fork `10c9444a9`: 30/30 mutation runs, every validator rule at
its post-refactor home and every handler step helper KILLED, one survivor.

Findings, all nine verified by the orchestrator against HEAD and ACCEPTED:

- **P0-1** `claimTurn`'s lease predicate survives deletion — the written-state
  fence is asserted, the spend guard is not. Fix: call-count oracle on the
  racy turn plus a direct `claimTurn` lease case.
- **P1-1** validator `allowedOperations` gate reached by no test. Fix: one case.
- **P1-7** `handleTurnError` budget-decision terminal branch untested. Fix: one
  live case (`budget_exceeded`, no retry).
- **P1-5** spec §14 line 638 said all six terminal paths `logger.warn` — false
  (`operator_disabled` logs info; a lost lease resolves nothing). This is the
  closed run's R11, accepted-risk there because no further commit was planned;
  the branch now takes commits, so it is FIXED in the spec instead.
- **P1-6** `postgres.md` parse-site allowlist named `turns.ts`; the two calls
  live in `reads.ts` since `eb21f55c2`. Fixed.
- **P1-2 / P1-3 / P1-4** the `agent_turn` alert path was broken on both halves:
  the topic was absent from `checkFailedOutboxByTopic`'s CLOSED allowlist (the
  #628 class its own comment names), the job-failure-sink signal for
  `queue:agent_turn` had no runbook rule row, and the intake's "stuck dispatched
  row is the orphaned-lease signal" named a signal with no destination.
- **P2-1** fifth private `boundedErrorClass`, unhardened. Fix: import the shared
  hardened export.

**Surface amendment #5:** `worker/background/pollers/health-alert/checks.ts`,
its unit test, and `docs/runbooks/beta-launch-alerting.md` added to
`allowed_edit_surface`. Owner chose "amend surface #5 and fix now" over
accepted-risk-deferred-to-go-live via `AskUserQuestion` on 2026-09-12. Recorded
mechanically with `--reason`. The edits are one allowlist entry plus one
regression test modeled on the #628 case, and one rule row (§1 bullet +
click-path row 11). The intake SHA-256 moved to `43b0b7ef…`; the round-2
sidecar pins the new value.

**Verdict:** ACCEPT — nine findings, nine fixes, no production behavior change
except the allowlist entry and the import swap; round 2 re-mutates the fix hunks.
