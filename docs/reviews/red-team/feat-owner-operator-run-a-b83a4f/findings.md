# Red team — feat/owner-operator-run-a (round 1)

| | |
|---|---|
| Mode | feature (dispatched inside `/feature` step 7's review wave) |
| Risk | high (from `.feature/intake.json`) |
| Fork | `c5e94e6ca7e3c4187854a67129b1651a8f80566e` |
| Merge base | `c5e94e6ca7e3c4187854a67129b1651a8f80566e` (re-derived; equals the fork) |
| Head | `7224424efa0a226e9a517d28e27850a1973cf14d` |
| Intake SHA-256 | `86430051ff3276a792c58195a3ad4ac66fd7171bbba44b183afc47d2ead38a7f` |
| Round | 1 of 2 |
| **Status** | **OPEN_P0** |

## Status line

**OPEN_P0** — 5 confirmed surviving mutants, 5 open P1, 3 open P2. Three
`inconclusive/oracle` rows and 35 `skipped-budget` rows also stand, so even with
every P0 resolved this round cannot reach `CLEAR`.

## Counts

| Inventory | 62 | Findings | 13 |
|---|---|---|---|
| killed | 17 | P0 open | 5 |
| survived-confirmed-P0 | 5 | P1 open | 5 |
| equivalent | 0 | P2 open | 3 |
| inconclusive (oracle) | 3 | accepted-risk | 0 |
| skipped-budget | 35 | fixed / rejected | 0 / 0 |
| excluded | 2 | | |

## How this pass was run

Preconditions all passed and are recorded: the worktree was clean at the pinned
head (`git status --porcelain --untracked-files=no` empty), `mutation-runner.mjs
watchers` reported no dev server or watch worker on this tree, and `round-start`
opened round 1 with a fresh 30-run budget over a closed journal.

Environment isolation was an allowlist, not a denylist: `PATH`, a temporary
`HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true` and
`TEST_DATABASE_POOL_URL` only after it validated as `localhost`. `.env.local`
was swapped for a scrubbed copy for the whole mutation phase, because
`dotenv-load.ts` and `resolveTestDatabaseUrl()` read it off disk.

**One operator error worth recording**, because it changes how the evidence
should be read: the runner's `run` subcommand takes its own `--test-db`, which
the first live baseline omitted. That run reported
`TEST_DATABASE_POOL_URL unset — DB-gated integration suites SKIPPED` and every
live-DB case came back `skipped`. It was re-run with `--test-db` before any
classification was made, and all 13 live-DB worker cases plus the 2 snapshot
cases then executed green. No mutation was classified against a skipped suite.

Budget: 27 of 30 runs — 4 baseline launches (18 unit cases, 8 route cases, 13
live-DB worker cases, 73 offboarding/outbox/pinning cases, all green at HEAD)
and 23 supervised mutant launches. Every mutant run was filtered with a
regex-escaped title and verified with `assert-one-test`, which passed on all 23.

**Restoration.** Each mutation was restored immediately after its run; the
closing `dotenv-restore` returned `.env.local` and removed the backup. At the
time this report was written the journal showed 23 mutations all `restored`,
`dotenv.open false`, no active supervisors, and `git status --porcelain` empty
on every path — no tracked modification and no untracked file. The wave's
read-only axes had staged nothing under `.feature/review-staging/`, so the
post-restore assertion is unambiguous.

## Findings

### P0 — blocks the PR

#### F1 — the worker never proves it scrubs the CURRENT message
`worker/jobs/agent-turn/AgentTurnWorker.ts:168`

Replacing `scrubPastedReview(claimed.ownerText)` with a pass-through killed no
test.

Two behaviours change under the mutant. The raw owner message reaches
`generateOperatorReply` → `buildOperatorPrompt`, against the intake's stated
behaviour that a pasted review "reaches the snapshot as `[review text
removed]`"; and `scrubbed.scrubbed` becomes permanently false, so the
`server_notice` segment at `AgentTurnWorker.ts:242-244` is never prepended and
the stored reply silently loses the fixed sentence.

Searched for an oracle and found none. `render.test.ts` proves
`scrubPastedReview` as a pure function. `snapshot.integration.test.ts` proves
the *history* re-scrub at `context.ts:231` and then calls `buildOperatorPrompt`
with a hand-written literal (`'What needs me today?'`).
`turn-get-route.test.ts:41` asserts the notice from a **pre-seeded** stored
segment behind a mocked module. No test seeds review-shaped `owner_text` and
drives `handleAgentTurn`.

#### F2 — `sameTurnPayload`'s `owner_text` arm is unexercised, and its test comment is false
`src/lib/agents/operator/turns.ts:54`

Dropping `existing.owner_text === input.text` killed no test — including the one
named "createTurn stores owner_text byte-for-byte and **treats a trimmed repeat
as a conflict**".

The oracle is broken rather than absent. `baseTurnInput`
(`turn-worker.integration.test.ts:96`) mints a fresh
`conversationId: randomUUID()` on every call, and the repeat at `:688` overrides
only `clientTurnKey` and `text`. The 409 therefore comes from the
`conversation_id` arm of `sameTurnPayload`, not the `owner_text` arm. That makes
the comment at `:687-688` — "A `.trim()` re-introduced anywhere would make this
return `existing` instead" — false as written.

Under the mutant, a same-key POST carrying *different* text returns the first
turn's ids instead of `turn_key_conflict`: the owner is shown a reply to a
message they did not send. Fix: pass the same `conversationId` to the repeat
call.

#### F3 — `getTurnForOwner`'s cross-tenant guard has no non-mocked test
`src/lib/agents/operator/turns.ts:542`

Removing `AND account_id = ${input.accountId}::uuid` killed no test, including
the case titled "…**scoped by account** and 404 across accounts".

`turn-get-route.test.ts:19` replaces `@/lib/agents/operator/turns` wholesale, so
the cross-account arm is `mockGetTurnForOwner.mockResolvedValue(null)` and
proves only the route's null→404 mapping. Reverse import search found no other
caller and no live-DB suite that touches `getTurnForOwner`.

Under the mutant `GET /api/operator/turns/:id` returns another account's turn —
status, failure reason, stored reply segments, proposals and unsupported rows —
to any signed-in owner who guesses a uuid. Invariant #8.

#### F4 — `createTurn`'s conversation-ownership re-read can lose its account scope undetected
`src/lib/agents/operator/turns.ts:145`

Removing `AND account_id = ${input.accountId}::uuid` from the conversation
`FOR UPDATE` re-read killed no test, including "POST turns rejects … **a
conversation owned by another account**".

The module's own docblock (`turns.ts:85-88`) states what the guard is for: a
client-minted conversation id colliding with another account's row must be
`conversation_not_found`, "never an upsert into the caller's account", because
"treating a collision as ownership would hand one account another's transcript".
Under the mutant the `ON CONFLICT DO NOTHING` insert loses silently, the
unscoped re-read finds the foreign row, and the turn is inserted against another
account's conversation.

`turns-route.test.ts:31` mocks `createTurn`; no live-DB case seeds a foreign
conversation.

#### F5 — a proposal's `before`/`after` preview is never asserted end-to-end
`worker/jobs/agent-turn/AgentTurnWorker.ts:368`

Swapping `before` and `after` in `buildProposalRows` killed no test. They differ
in that test's data (the seeded location has no tone; `toneProposal` sets
`'warm and brief'`), so this is not an equivalent mutation.

`before`/`after` are the full effective voice state the owner reads on the card
and the state Run B's Apply is specified to preview against. Nothing checks
them: `proposals.test.ts` asserts `insertProposals` binds *fixture* before/after
values, and the live claim-race case reads only `operation`, `status`,
`location_id`, `contract_version` and `requires_confirmation` off the stored row.

### P1 — needs adjudication

- **F6 — `worker/jobs/agent-turn/failed-hook.ts:30` ships with zero covering tests.**
  All 85 lines are new and no test file imports `handleAgentTurnFailed`. The
  ordering it encodes (`markOutboxFailed` CAS first, `failTurnIfNonTerminal`
  only on a win) is exactly the ordering the flag-off path *does* have a test
  for, and the judge hook it is copied from has its own suite.
- **F7 — `getConversationForOwner` (`src/lib/agents/operator/turns.ts:609`) has no non-mocked test.**
  134 lines: actor scoping, the no-turns branch, the effective-rules projection,
  the `asOf` contract. `conversation-route.test.ts` mocks the module, so the
  promised case asserts a fixture the route echoes. The `created_by_user_id`
  predicate at `:624` — the only thing scoping the no-id read to the acting
  owner — never executes under test.
- **F8 — fragile assertion at `src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:308`.**
  `expect(typeof status.value).toBe('number')` is a type-shaped proxy for "the
  materialized value is the metric the `status_ref` named". `materializeStatus`
  (`AgentTurnWorker.ts:317-330`) could map `pending_count` to `draftsWaiting`
  and this would still hold — and the value is frozen at fenced completion, so
  the transcript would be permanently wrong. Replacement: seed a pending count
  that differs from `draftsWaiting` and `posted7d`, then assert equality.
- **F9 — vacuous assertion at `worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts:90`.**
  `expect(mockClaimTurn).not.toHaveBeenCalled()` can never fail:
  `mockClaimTurn` is hoisted at `:14` but no `vi.mock` wires it to `claimTurn`.
  The property it appears to cover is genuinely covered by
  `expect(statements).toHaveLength(2)` at `:80`; delete the line or mock the
  module.
- **F10 — stale citation past end-of-file at `docs/superpowers/plans/feat-owner-operator-run-a-plan.md:70`.**
  It cites `src/app/api/settings/voice/route.ts:197` as the pattern for the new
  POST route; this same change shortened that file to 167 lines.

### P2 — recorded, never blocks

- **F11 — `src/lib/agents/operator/catalog.ts:99`** cites
  `src/app/api/settings/voice/route.ts:102` for `VoiceConfigSchema`, which this
  change moved to `:107`. A new comment born stale in the PR that moved its
  target.
- **F12 — `…/turn-worker.integration.test.ts:314`**,
  `expect(JSON.stringify(turn.reply)).not.toContain('status_ref')` is an
  absence-of-token proxy. Recorded rather than raised: the surrounding comment
  argues the case honestly and the `StoredSegment` type carries the stronger
  half. It still passes for an empty reply.
- **F13 — `src/lib/agents/operator/context.ts:192`** hardcodes
  `INTERVAL '7 days'` while the stored segment's `reportingPeriodDays` comes
  from `RECENT_COMPLETED_DAYS`. Latent today (the constant is 7); a one-line
  edit desynchronises the count from its own label.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was available and was run against every changed doc.

| Doc | Citations | Result |
|---|---|---|
| `…/feat-owner-operator-run-a-plan.md` | 94 | 1 unresolved → **F10** |
| `…-handoff.md` | 0 (1 commit) | PASS |
| `…-deviations.md` | 10 (3 commits) | PASS |
| `docs/context/owner-operator.md` | 0 | PASS |
| `docs/directory/lib-owner-operator.md`, `…/worker-jobs-a.md` | 0 | PASS |
| `blast-radius.md`, `plan-review.md`, roadmap README, ADR 0005 | 0 | PASS |
| `migrations-log.md`, `env-vars.md`, `rls-inventory.md`, `currents.md`, `CONTEXT-MAP.md` | 2 | PASS |
| `.claude/reference/lab-notes/postgres.md` | 1 unresolved | out of scope — `connection.js:170` is pre-existing text, not in this diff's hunk |
| `docs/progresstracking.md` | 3 unresolved "commits" | out of scope — not in this diff's added lines |

Code-comment citations introduced by the diff were re-resolved by hand and all
land correctly except F11: `route-helpers.ts:154` (the `requireWritableOwner`
docblock), `auto-approval/settings.ts:191`, `dashboard/pending-count.ts:35`,
`reviews/status.ts:30` (`DELETED`), `responses/judge.ts:80`.

One doc claim was checked *because* it would have been a P0 and it holds: the
voice route suite's comment that "the `FOR UPDATE` lock, the account-scoped
`WHERE`, and `account_id` bound as a parameter … are asserted against the real
writer in `voice-settings.test.ts`" is true — mutation rt-19 removing
`FOR UPDATE` is killed by that suite, and its bound-value assertions cover the
parameterisation. The intake's observability claim that "the job-failure sink
raises a Sentry issue on terminal exhaustion" is also true: `agentTurnWorker` is
in `workersByQueue` (`worker/index.ts:529`), which `attachJobFailureSink` walks.

## Duty 4 — missed sibling cases

**Search 1 — stale citations into the file this change shortened.**
Pattern `settings/voice/route\.ts:[0-9]+`, scope: the whole worktree excluding
`node_modules`. 27 hits. Of these, the ones this change owns are
`feat-owner-operator-run-a-plan.md` (`:197` → F10; `:102` ×2 → F11's class) and
`src/lib/agents/operator/catalog.ts:99` (→ F11). The remaining 23 sit in
unchanged files — `docs/reviews/PATHFINDER-2026-08-15/*`,
`docs/security-audit/*`, `docs/future-plans/*`, earlier plans — and several are
now stale for the same reason, but opening a front on unchanged documents is out
of scope for this pass and they are recorded here rather than raised.

**Search 2 — the mock-the-module-then-assert-tenant-scope shape.** Scope: the
three new route suites under `src/app/api/operator/__tests__/`. All three
exhibit it (`turns-route.test.ts:31`, `turn-get-route.test.ts:19`,
`conversation-route.test.ts:20`); two produced F3 and F4, the third F7. No
instance outside the diff was pulled in.

**Search 3 — idempotency-payload comparisons whose fixture varies an unrelated
key.** Scope: the changed test surface. One instance, F2. Zero siblings — a
sound search with a null result.

## Duty 5 — operational completeness

Scope: the operator-actionable terminal and swallowed paths this diff adds.

The new terminal failures (`operator_disabled`, `unauthorized`,
`account_offboarding`, `predecessor_stalled`, `model_output_invalid`,
`budget_exceeded`, `exhausted`) are recorded on `agent_turns.failure_reason` and
logged with ids only. BullMQ exhaustion reaches Sentry through the existing
generic `attachJobFailureSink`, tagged `subsystem=worker_job, queue=agent_turn`
— the diff introduces **no new signal identity**, so no new rule row in
`docs/runbooks/beta-launch-alerting.md` is owed. That those generic
`subsystem=worker_job` issues match none of the five live alert filters is a
pre-existing platform-wide condition affecting every queue, not something this
change creates; raising it here would be a new front on unchanged code.

The one swallowed path the diff adds — `failed-hook.ts:76-84`, which logs the
bounded error class and returns — matches the sibling it names
(`worker/jobs/judge/failed-hook.ts`) exactly, including the absence of a
`Sentry.captureException`, and the rolled-back transaction leaves the outbox row
`dispatched` for the watchdog. No finding. Its lack of tests is F6.

## Authorizations

None. No finding on this run is `accepted-risk`.

## Inventory

The complete 62-row inventory — every candidate, executed or not, with the exact
mutation and outcome for each — is in `findings.json` under `inventory`. The 35
`skipped-budget` rows are in-scope candidates left unexecuted when the 30-run
per-round budget was spent; they are why this round cannot report `CLEAR` even
once the P0s are resolved.
