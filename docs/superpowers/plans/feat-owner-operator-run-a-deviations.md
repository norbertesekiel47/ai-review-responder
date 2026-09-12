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

**Verdict:** RE-PLAN (small) — the run needs one owner for the `docs/directory`
rows of all of Run A's new `src/lib/**` and `worker/**` files.

## 2026-09-11 — T2's GET change staleness-fails the tenant-scope allowlist

Step 7.3 adds `highlight_facts` to the all-locations GET `SELECT` list, which is
reproduced verbatim as the `sqlSnippet` of the
`src/app/api/settings/voice/route.ts` / `businesses` entry in
`scripts/ci/tenant-scope-allowlist.ts:677-682`. `pnpm ci:tenant-scope` now fails
with `businesses: unused tenant scope allowlist entry` — the snippet no longer
matches the source. The fix is to re-spell that one `sqlSnippet` with
`highlight_facts` between `avoid_facts` and `sample_responses`; the entry's
category and reason are unchanged, and the query is no less scoped than before.
`scripts/ci/tenant-scope-allowlist.ts` is **outside T2's edit lease**, so T2 did
not write it.

**Verdict:** RE-PLAN (small) — same follow-up as the `docs/directory` row: one
owner for T2's out-of-lease audit fixtures.

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
(title 5) and the new route suite (title 6). What is needed is to re-point that
file's PUT section at `sql.begin` + the mocked writer, the way title 6's suite
does. The file is **outside T2's edit lease**, so T2 did not touch it and
committed with the suite red.

**Verdict:** RE-PLAN (small) — assign
`src/app/api/settings/voice/__tests__/route.test.ts` to a follow-up with the
lease to edit it; the branch gate stays red until then.

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
