# Red team — `feat/owner-operator-run-a`, round 1 (fresh run)

Adversarial verification of a finished branch. Everything below is evidence produced in this pass;
the previous closed run under `…-b83a4f-rounds1-3/` was not consulted for any conclusion.

| | |
|---|---|
| Run id | `feature-feat-owner-operator-run-a-b83a4f` |
| Mode / round / risk | feature / round 1 of a fresh run / **high** |
| Fork ref (`origin/main`) | `10c9444a9832cae0e45854f1d19cb124bb2ee5e9` |
| Merge base | `10c9444a9832cae0e45854f1d19cb124bb2ee5e9` |
| Head | `5b223e33f19499534961bf2d60d8781a41af780f` |
| Intake SHA-256 | `4e5d3007b7eff17128373e835d2b079ecc315965a13cd6467e7636898af20554` |
| Generated | 2026-09-12T09:33:06Z |
| **Status** | **OPEN_P0** |

Preconditions, all checked and passing before anything ran: `git status --porcelain` empty at head;
`mutation-runner watchers` reported none; `round-start` opened round 1 with 30 runs available. The
environment was the runner's allowlist with a temporary `HOME`, and `.env.local` was swapped for a
scrubbed copy for the whole mutation phase. No environment value, token, or owner/review text is quoted
anywhere in this report.

## Verdict

One **P0**: `claimTurn`'s 180 s lease predicate — the guard that makes exactly one dispatch reach the paid
model call — can be deleted with the entire agent-turn test set still green (23/23). The written-state half
of the claim protocol is well asserted (the `attempt_token` fence mutant was killed); the *spend* half is
asserted nowhere.

Seven **P1**s: two uncovered production branches, three broken alert paths on the new `agent_turn` lane, and
two false claims in docs this branch changed. One **P2**: a missed sibling on a duplicated error-class helper.

The round is also `INCOMPLETE_BUDGET` and `INCOMPLETE_ORACLE` on its own terms — 30 of 30 runs spent, 238
in-scope candidates unexecuted, 2 inconclusive oracle rows — but `OPEN_P0` takes precedence.

## Findings

| id | sev | duty | title | at | disposition |
|---|---|---|---|---|---|
| P0-1 | P0 | 1 | claimTurn's 180 s lease predicate can be deleted with the entire agent-turn suite still green | `src/lib/agents/operator/turns.ts:250-254` | open |
| P1-1 | P1 | 1 | The validator's allowedOperations gate is reached by no test | `src/lib/agents/operator/render.ts:231-233` | open |
| P1-7 | P1 | 1 | The handleTurnError budget-decision terminal branch has no covering test | `worker/jobs/agent-turn/AgentTurnWorker.ts:282-294` | open |
| P1-2 | P1 | 5 | agent_turn is missing from checkFailedOutboxByTopic's closed allowlist, so no health-alert finding can fire for a failed turn | `worker/background/pollers/health-alert/checks.ts:105-124` | open |
| P1-3 | P1 | 5 | The job-failure-sink Sentry signal for queue agent_turn has no rule row in beta-launch-alerting.md | `worker/job-failure-sink.ts:64-80` | open |
| P1-4 | P1 | 5 | The orphaned-lease signal the intake names is a log line only — no Sentry event, no rule row | `worker/background/pollers/OutboxPoller.ts:93-165` | open |
| P1-5 | P1 | 3 | A changed doc claim is false: the agent_turn lane does not emit logger.warn uniformly across the six terminal paths | `docs/roadmap/2026-09-11-owner-operator/README.md:638` | open |
| P1-6 | P1 | 3 | The authoritative JSONB parse-site allowlist names the wrong file for the agent_turns.reply parse sites | `.claude/reference/lab-notes/postgres.md:17` | open |
| P2-1 | P2 | 4 | The branch adds a fifth private boundedErrorClass copy and picks the unhardened shape, while a hardened shared export already exists | `worker/jobs/agent-turn/failed-hook.ts:26-28` | open |

### P0-1 — P0 (duty 1) — claimTurn's 180 s lease predicate can be deleted with the entire agent-turn suite still green

**At** `src/lib/agents/operator/turns.ts:250-254` · **disposition** `open`

**Evidence**

Mutation t-m4 deleted the lease predicate from claimTurn's WHERE clause — the "claimed_at IS NULL OR claimed_at < NOW() - (leaseSeconds * INTERVAL '1 second')" arm — leaving only "status IN ('accepted','running')". The covering test, "worker claim race: two dispatches of one turn produce one completed turn and one proposal set" (src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:319), still PASSED. A confirming run of the whole agent-turn test set under the same mutant — turn-worker.integration.test.ts + worker/jobs/agent-turn/__tests__ + turns.test.ts — reported 23 passed, 0 failed. The behavioural replacement: the concurrent section of that test (turn-worker.integration.test.ts:500-517) should assert that exactly one attempt reached the model and was billed (expect(runLlmTask).toHaveBeenCalledTimes(1) and one recordApiCost / api_costs row for the racy turn), and a direct claimTurn case should prove a second claim inside the lease returns null while one after lease expiry succeeds.

**Arbiter reasoning**

Not an equivalent mutation. Deleting the lease predicate lets a second dispatch claim a turn whose 180 s lease is live (AGENT_TURN_LEASE_SECONDS, worker/jobs/agent-turn/constants.ts), so two attempts each run step 3, each build a snapshot and each make their own cost-guarded owner_operator model call. The intake's own risk_reasons names this consequence verbatim: "a new BullMQ worker (AgentTurnWorker) makes a cost-guarded LLM call ... a defect can double-bill or strand turns". Not an unexecuted branch either: the test's third section runs two handleAgentTurn calls under Promise.all on one freshly created turn, so both reach claimTurn inside the same lease window, and claimTurn is the first statement either executes after the flag gate. It survives because the assertions describe only the END STATE — one completed turn, one agent_proposals row, outbox completed — and completeTurnFenced's attempt_token fence delivers that end state on its own, independently of the lease. The lease predicate and the completion fence are two separate guards: the fence stops a stale attempt from WRITING, only the lease stops a second attempt from SPENDING. The suite asserts the first and never the second. Independently corroborated without spending a further run: "rg AGENT_TURN_LEASE_SECONDS|leaseSeconds|LEASE" across src/lib/agents/operator/__tests__ and worker/jobs/agent-turn/__tests__ returns no hit, the only two claimed_at writes in the suite (turn-worker.integration.test.ts:549, :585) drive loadPredecessor's age rather than the claim, and the claim-race test makes no runLlmTask or recordApiCost call-count assertion at all. Mutation t-m2, which removed completeTurnFenced's attempt_token fence, was KILLED — so the pair is asymmetric: the written-state half of the protocol is asserted and the spend half is not.

### P1-1 — P1 (duty 1) — The validator's allowedOperations gate is reached by no test

**At** `src/lib/agents/operator/render.ts:231-233` · **disposition** `open`

**Evidence**

An uncovered behaviour-affecting production hunk (Direction B, Step 2). The rule fires only for a proposal whose operation IS registered in CATALOG but is NOT in snapshot.allowedOperations. Both validator fixtures close that set — render.test.ts:31-35 lists set_tone, set_avoid_facts, read_pending_work; model-call.test.ts:57-60 lists set_tone, read_pending_work — and no test anywhere proposes set_products_services or set_highlight_facts through validateModelOutput (rg over src/lib/agents/operator/__tests__ and src/app/api/operator/__tests__ finds those two ids only in catalog.test.ts's catalog sweep and in two read-path suites that SEED agent_proposals rows directly). The single in-catalog-but-absent id a test does use, set_daily_cap, is not registered at all, so it is rejected by the earlier branch at render.ts:227-229 and continues before reaching 231. Suggested fix: add one case proposing a catalog operation the snapshot omits and assert the "may not use" reason.

**Arbiter reasoning**

Established statically rather than by mutation, because the per-test cap of 2 mutations was already spent on the only test that could cover this rule. Recorded as P1 (uncovered change) rather than P0: the rule is also unreachable in production today — modelVisibleOperations (src/lib/agents/operator/catalog.ts:193-203) returns every CATALOG entry and ignores its tier parameter, so snapshot.allowedOperations always equals the catalog — which makes this a forward guard for Run B's tier-gated operations rather than a live hole in the no-unapproved-operation path. It still blocks the round as an inconclusive oracle row, because "no test can distinguish this rule from its absence" is a claim about the oracle.

### P1-7 — P1 (duty 1) — The handleTurnError budget-decision terminal branch has no covering test

**At** `worker/jobs/agent-turn/AgentTurnWorker.ts:282-294` · **disposition** `open`

**Evidence**

An uncovered behaviour-affecting production hunk (Direction B, Step 2). This is the branch that makes an exhausted account budget TERMINAL instead of burning the BullMQ retry ladder: isBudgetDecision(error) -> failTurnFenced with TURN_FAILURE_REASON.BUDGET_EXCEEDED. Neither budget_exceeded nor BUDGET_EXCEEDED nor isBudgetDecision appears in any test file in the repository, and no test on this lane constructs a CostLimitExceededError or a GlobalCostLimitExceededError. The sibling transient branch immediately below it IS covered ("worker releases its claim on a transient failure so the retry re-claims and completes"), and so is the exhausted reason in failed-hook.test.ts:107 — budget_exceeded is the one terminal reason with no case. The intake names it in both observability ("agent_turns.status and failure_reason distinguish failed reasons (... budget_exceeded)") and edge_cases ("Terminal failure (... budget exceeded ...)").

**Arbiter reasoning**

Recorded without spending a mutation run: the absence of the token from every test file is direct evidence that no oracle exists, and the round budget was exhausted. Severity P1 rather than P0 because a miss is bounded — the cost RESERVATION precedes the model call, so a budget-exceeded error that fell through to the retry ladder would spend nothing extra and would end as failure_reason "exhausted" via the failed-hook instead of "budget_exceeded". The defect would therefore be an observability regression on a reason the intake promises to distinguish, not lost money or a stranded turn.

### P1-2 — P1 (duty 5) — agent_turn is missing from checkFailedOutboxByTopic's closed allowlist, so no health-alert finding can fire for a failed turn

**At** `worker/background/pollers/health-alert/checks.ts:105-124` · **disposition** `open`

**Evidence**

A missing alert-path half: the branch adds an owner-impacting outbox topic and no emitting signal watches it. The allowlist binds exactly PUBLISH_RESPONSE, SEND_NOTIFICATION, GENERATE_RESPONSE, BUILD_SOLICITATION_BATCH, GENERATE_SOLICITATION_ASKS and SOLICITATION_VETO_NOTICE; QUEUE_NAMES.AGENT_TURN (src/lib/shared/queue-names.ts:68) is absent. A failed agent_turn row therefore raises no subsystem:health_alert finding, so rule 1 of docs/runbooks/beta-launch-alerting.md can never fire for this lane. Fix: add QUEUE_NAMES.AGENT_TURN to the allowlist, or state in the runbook why a failed turn is not owner-impacting.

**Arbiter reasoning**

The code comment directly above the allowlist names this exact defect class as a prior incident — "This is a CLOSED allowlist, so a new owner-impacting topic stays invisible until it is added here. generate_solicitation_asks shipped without it (#628 round 5), which silently voided that lane's dead-letter rationale: its terminal handler concedes the batch to 'an operator will see the failed row', and nothing was watching the row." The owner-impact test is met: a failed agent_turn means the owner's Operator message never receives a reply, and the branch's own design leans on the row being seen (docs/roadmap/2026-09-11-owner-operator/README.md:636 defers the stranded-turn case to Run B on exactly that basis). Verified independently of the subagent that surfaced it: I re-read checks.ts:105-124 and confirmed the six bound topics, and "rg -in agent_turn|owner.operator|worker_job docs/runbooks/beta-launch-alerting.md" returns zero matches.

### P1-3 — P1 (duty 5) — The job-failure-sink Sentry signal for queue agent_turn has no rule row in beta-launch-alerting.md

**At** `worker/job-failure-sink.ts:64-80` · **disposition** `open`

**Evidence**

The other missing half: an emitted signal with no rule row. worker/index.ts registers agentTurnWorker into workersByQueue, and the existing loop attaches attachJobFailureSink to every entry, so BullMQ terminal exhaustion on this lane fires Sentry.captureException tagged {subsystem: "worker_job", queue: "agent_turn", topic}. That tag set matches no _If_ filter in the runbook's rule table and is not listed in the runbook's own register of signals that knowingly have no dedicated rule. Facet compared and contradicted: signal identity and filter (no rule selects this tag set) and destination action (no documented destination). Fix: add a rule row for subsystem:worker_job scoped to this queue, with a cadence, or extend the existing register to acknowledge it.

**Arbiter reasoning**

Scoped deliberately to the lane this branch adds rather than opened as a front against the sink, which is unchanged code: the finding is that the branch wires a NEW queue into an existing emitter and ships no rule for it. The runbook keeps an explicit list of signals that have no dedicated rule, which is what makes an unlisted, unrowed signal a reportable omission rather than an accepted posture.

### P1-4 — P1 (duty 5) — The orphaned-lease signal the intake names is a log line only — no Sentry event, no rule row

**At** `worker/background/pollers/OutboxPoller.ts:93-165` · **disposition** `open`

**Evidence**

The intake's observability section states: "job_outbox rows for topic agent_turn: a stuck 'dispatched' row past the watchdog window is the signal a lease was orphaned." Both branches of runOutboxWatchdogRecovery — re-pending a stale dispatched row, and terminalising it to failed — only emit a structured log line, aggregated across every topic rather than broken out per topic, and neither captures to Sentry. Combined with P1-2, a worker crash that strands an agent_turn row in dispatched past the watchdog window produces zero Sentry event end to end: nothing from the watchdog, and nothing from checkFailedOutboxByTopic once the row lands failed. Facet contradicted: destination action — the contract names a signal that has no operator-actionable destination.

**Arbiter reasoning**

Reported against the contract the branch wrote rather than against OutboxPoller, which is unchanged: the claim that this row IS the orphaned-lease signal is new on this branch, and it is the claim that fails. Fixing P1-2 alone resolves the terminalised half of this; the re-pend half stays a log line, which is defensible if the runbook says so. Closing either the code or the contract sentence would settle it.

### P1-5 — P1 (duty 3) — A changed doc claim is false: the agent_turn lane does not emit logger.warn uniformly across the six terminal paths

**At** `docs/roadmap/2026-09-11-owner-operator/README.md:638` · **disposition** `open`

**Evidence**

The bullet, added by this branch inside the @@ -627,14 +627,37 @@ hunk, asserts that every terminal path in AgentTurnWorker — naming operator_disabled first — "resolves the turn and emits a logger.warn line", and concludes "That is uniform across the six paths, not a gap in one of them". At HEAD the operator_disabled path emits logger.log (worker/jobs/agent-turn/AgentTurnWorker.ts:324, "agent_turn flag-off skip"); the other five use logger.warn (AgentTurnWorker.ts:122, :171, :204, :229, :292). Fix: say five of the six paths warn and the flag-off skip logs at info, or change line 324 to warn.

**Arbiter reasoning**

Re-derived at HEAD, not taken from the subagent report: I read the bullet and the six call sites myself and confirmed the hunk membership with git diff. Recorded as P1 rather than P0 after weighing the "misleading FALSE claim" bar. The bullet's operative assertions are all true and independently verified here — there is no Sentry call anywhere in AgentTurnWorker.ts, and beta-launch-alerting.md carries no row for the lane — and the same sentence itself describes operator_disabled as "an orderly flag-off skip ... not an incident", which is consistent with logger.log being deliberate. A reader is therefore misled about one path's log LEVEL, not about whether the lane is alerted or about the single go-live decision the bullet defers. The concrete harm is bounded to whoever later implements that deferred decision with a level:warn filter and silently drops every operator_disabled turn. Recorded at P1 with this reasoning so the owner can escalate it to P0 if they weigh the uniformity assertion as load-bearing.

### P1-6 — P1 (duty 3) — The authoritative JSONB parse-site allowlist names the wrong file for the agent_turns.reply parse sites

**At** `.claude/reference/lab-notes/postgres.md:17` · **disposition** `open`

**Evidence**

The Owner Operator bullet added by this branch says parseReplySegments is "called in context.ts and twice in turns.ts". At HEAD it is called once in src/lib/agents/operator/context.ts:297 and twice in src/lib/agents/operator/reads.ts:97 and :213; src/lib/agents/operator/turns.ts contains no call at all (rg parseReplySegments src worker). The owner reads were split out of turns.ts into reads.ts in commit eb21f55c2 and this line was not re-resolved. Fix: name reads.ts. Everything else in the bullet checks out — the site count of four is right and the entry's arithmetic closes (2+1+2+4+2+3+4+5 = 23, matching its own "Exactly 23 production JSONB field-to-parser sites today").

**Arbiter reasoning**

This entry is marked AUTHORITATIVE and its one job is to let a reader find every production JSONB parse site, so pointing at a file that has none while leaving the file that has two unnamed defeats that job. Recorded as P1 rather than P0 because the substantive safety claim — each site guards typeof-string, narrows and throws — is true at the real sites, and the enumeration's count and totals are correct; what is wrong is where to look, which is a stale reference of the same family as a stale line number.

### P2-1 — P2 (duty 4) — The branch adds a fifth private boundedErrorClass copy and picks the unhardened shape, while a hardened shared export already exists

**At** `worker/jobs/agent-turn/failed-hook.ts:26-28` · **disposition** `open`

**Evidence**

Missed sibling case. Pattern searched: "function boundedErrorClass" across worker and src. Scope: the whole worker and src trees, no exclusions. Result: five definitions — the shared export at worker/jobs/solicitation-batch/failed-hook-shared.ts:36 (already imported by worker/jobs/solicitation-send/failed-hook.ts, worker/jobs/solicitation-batch/generate-failed-hook.ts and worker/jobs/solicitation-batch/failed-hook.ts) plus four private copies, the newest being this branch's. The shared one validates the class name against /^[A-Za-z][A-Za-z0-9_$]{0,99}$/ and falls back to UnknownError, with a docblock giving the reason ("so a hostile or exotic error type cannot inject structure into the log line"); this branch's copy takes err.name unvalidated and slices it to 100 characters, then interpolates it into markOutboxFailed's reason string at failed-hook.ts:56-61, i.e. into a stored job_outbox error value and a log field. The same refactor commit that produced this HEAD (15bc4a4aa) deduplicated parseJsonbObject for exactly this shape; fallow's duplication gate does not reach a two-line helper. Fix: import boundedErrorClass from the shared module, or move it somewhere both hooks can share.

**Arbiter reasoning**

P2, recorded and non-blocking, because there is no exploitable path today: the errors that reach this hook come from the LLM seam, Postgres and the cost guard, none of which sets .name from provider or owner text, and the value is a bound parameter rather than interpolated SQL. The finding is the divergence itself — the branch replicated the weaker of two existing siblings (worker/jobs/judge/failed-hook.ts:39) when a hardened shared export with a stated rationale was available.

## Duty 1 — hand-mutation

30 supervised runs, the whole round budget. Three were green baselines re-derived at HEAD (never taken from
`gate-status.json`): `render.test.ts` 11/11, the two `worker/jobs/agent-turn/__tests__` files 7/7, and the
live-DB `turn-worker.integration.test.ts` 15/15 against the local test database at migration 120. Twenty-six
were mutant runs, each `assert-one-test`-confirmed to have executed exactly one test; one was a confirming
full-suite re-run of the single survivor. Launch 31 was refused by the runner, which is why `t-m6` (the
`failTurnFenced` token fence) is recorded `skipped-budget` rather than measured.

Budget was spent as instructed: first every validator rule at its new home in `render.ts` after commit
`15bc4a4aa`, then the four `AgentTurnWorker` step helpers (`settleClaimMiss`, `waitOrFailOnPredecessor`,
`generateAndAssemble`, `handleTurnError`) and the fenced transitions in `turns.ts` they settle through.

| result | n |
|---|---|
| killed | 25 |
| survived, confirmed P0 | 1 |
| equivalent | 0 |
| inconclusive (oracle) | 2 |
| skipped — budget | 238 |
| excluded by rule | 3 |
| **inventory total** | **269** |

Every one of the 11 validator-rule mutants died, including the two off-by-one/inversion mutants
(`proposal_ref` bound `>=`→`>`, `scope_check` stored-location comparison inverted) and both scrub mutants
(block splitting removed, rating-header no longer carrying the following block). The refactor moved those
rules into five private helpers without leaving any of them unasserted. The same is true of the handler
split: the scrub-to-prompt hand-off, the scrub flag, the proposal-id binding, the offboarding/unauthorized
reason split, the vanished-voice reason, the stall threshold, both claim releases, the terminal-turn outbox
completion, the CAS-before-fail ordering, the in-transaction outbox completion, the completion fence and the
supersession replacements all have tests that notice when they change.

## Duty 2 — fragile assertions

**No finding.** All 15 changed test files were scanned for absence-of-tag proxies, exact string/row counts and
order assertions with no ordering contract. Four candidates were examined and each is sound:

- `render.test.ts:300-301` and `turn-worker.integration.test.ts:430-431` — `expect(json).not.toContain('status_ref')`
  is the absence-of-tag shape, but each sits beside a real behavioural assertion in the same block
  (`expect(stored).toEqual([…])` at `render.test.ts:286`, the round-trip `parseReplySegments(json)).toEqual(stored)`
  at `:303`, the filtered `.toEqual([{type:'proposal', proposalId}])` at `turn-worker.integration.test.ts:423`).
  The proxy is redundant, not load-bearing.
- `context.test.ts:90` — `expect(sqlCalls).toHaveLength(5)` is an exact statement count, but deliberately a
  *closed list* whose purpose is stated in-comment ("a sixth, unscoped read is exactly the regression this
  asserts against") and every call is separately asserted to bind the account. The closed list **is** the
  behavioural assertion here.
- `catalog.test.ts:81-82` — `not.toContain('undefined')` / `not.toContain('[object Object]')` are backed by
  actually invoking `op.describe(parsed.input)` on a real parsed sample at `:75-80`, which is the point the
  comment makes ("asserting `typeof op.describe === 'function'` would pass for a stub").

E2E/Playwright specs: none changed, so that set is empty.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was run against all three branch docs:

| doc | verdict | resolution |
|---|---|---|
| `…-plan.md` | `PREVALIDATE: PASS` — 92 citations, 31 fixtures, 0 commits, 0 issues | clean |
| `…-handoff.md` | `PREVALIDATE: 1 ISSUES` — `f4e02270` does not resolve to a commit | **excluded by instruction**: it is a Railway deploy id, not a git SHA, and the surrounding sentence says so |
| `…-deviations.md` | `PREVALIDATE: 1 ISSUES` — `voice/route.ts:23` does not exist | **script false positive**: `deviations.md:701` quotes that citation as a *superseded* style while saying the plan now names the symbol instead. `src/app/api/settings/voice/route.ts` exists, and the plan carries no literal `:23` citation for it any more |

`docs/roadmap/2026-09-11-owner-operator/README.md` contains no `path:line` citations anywhere, so every
substantive file/symbol claim in the branch's changed hunks (lines 8, 18, 627-661) was re-resolved by hand
instead. All checked out except line 638 — see **P1-5**. Verified correct: the flag accessor and its 404
behaviour, the `owner_operator` task's pinned models and limits, all three `agent-turn/constants.ts` numbers
against the watchdog default, the `readTerminalTurn` → `markOutboxCompletedIfOwned` wiring, migration 120's
four tables with deny-all RLS, `enqueueAgentTurn`, the catalog's 3 read + 4 proposable + 1 capture shape, the
three new routes, and ADR 0005's 11 → 12 envelope against `FLAG_ON_LLM_ENVELOPE_CAP`.

The refactor claim in commit `15bc4a4aa` was audited symbol by symbol and is exact: seven exports dropped
(`PASTED_REVIEW_SEGMENT`, `SegmentSchema`, `StoredSegmentSchema`, `ProposedOperationSchema`,
`UnsupportedRequestSchema`, `OWNER_OPERATOR_SYSTEM_PROMPT`, `VoiceField`), three symbols deleted
(`CATALOG_OPERATION_IDS`, `ProposedOperation`, `UnsupportedRequest`), `parseJsonbObject` moved to
`src/lib/agents/read.ts:222` and re-exported from `operator/schema.ts:222`. Every `parseJsonbObject` call site
passes a fully-qualified column name, so the message-prefix change from `agents/operator:`/`agents/read:` to
`agents:` loses nothing. The second doc defect this audit found is in the parse-site allowlist — see **P1-6**.

`feat-owner-operator-run-a-plan.md` still shows the pre-refactor shape in its code blocks. Not reported:
the plan is the pre-build blueprint and the later-dated `deviations.md` entry for PR #1270 is the doc of
record that supersedes it, accurately describing the post-refactor shape and retiring its own earlier note.

## Duty 4 — missed sibling cases

One **P2** (see above). Three sibling searches returned a sound zero, and one divergence was considered and
deliberately not reported:

- **Pattern:** a `timestamptz` used as a *version token* round-tripped through a JS `Date`. This is the shape
  commit `d21db9ecd` fixed, changing `updateVoiceConfig` to `RETURNING updated_at::text` because
  `new Date(…).toISOString()` truncates the microseconds Postgres stores (the #520 gotcha).
  **Searched:** `toISOString\(\)|new Date\(` and `::text` over `src/lib/agents/operator`,
  `src/lib/responses/voice-settings.ts`, `worker/jobs/agent-turn`. **Excluded:** test fixtures, and unchanged
  code outside the operator surface. **Result: zero siblings.** The three production hits are
  `context.ts:374` and `reads.ts:271` (`asOf: new Date().toISOString()` — the instant the server read, not a
  DB value) and `reads.ts:277` (`nullableIso`, applied only to `agent_conversations.last_turn_at`, a display
  timestamp never compared against a DB-side value). The real token path is consistent end to end:
  `readVoiceConfig` returns `updated_at::text` (`voice-settings.ts:85`) and `buildProposalRows` stores it
  verbatim as `preparedVersionToken.updatedAt` (`proposals.ts:81`).
- **Pattern:** `markOutboxCompletedIfOwned` / `markOutboxFailed` called *outside* the transaction that makes
  the terminal state change (invariant #2). **Searched:** all four new call sites — `completeTurnFenced`
  (`turns.ts:415`), `failTurnFenced` (`:441`), `failTurnAndCompleteOutbox` (`:497`), `handleAgentTurnFailed`
  (`failed-hook.ts:55-74`). **Result: zero siblings.** All four are inside one `sql.begin`, CAS-first wherever
  no attempt token exists. Mutants `t-m5` (completion moved beside the transaction) and `t-m1` (CAS ordering
  reversed) both died, so this is asserted, not merely true.
- **Pattern:** a statement over one of the four new tables with no `account_id` predicate (invariant #9).
  **Searched:** every `FROM|INTO|UPDATE agent_(turns|conversations|proposals|unsupported_requests)` across
  `src/lib/agents/operator`, `worker/jobs/agent-turn`, `worker/jobs/account-offboarding` and
  `src/lib/account-offboarding` — 36 production statements, each `WHERE` read individually. **Excluded:**
  `__tests__` fixtures. **Result: zero siblings.**
- **Considered and not reported:** in-process budget-decision classification by error *name* string rather
  than `instanceof`. `AgentTurnWorker.ts:32-39` matches `worker/jobs/judge/failed-hook.ts:27-38` — the pattern
  the intake explicitly names as the one to follow — while `generate-draft.ts:47-48` and
  `ask-generation.ts:952-956` use `instanceof` in the same in-process position. Not a finding: the name-list
  idiom is the sanctioned precedent, and a miss costs nothing extra because the cost reservation precedes the
  model call — the turn would end `exhausted` instead of `budget_exceeded`. (That reason having no test at all
  *is* reported, as **P1-7**.)

## Duty 5 — operational completeness

Static comparison only; staging delivery drills stay runbook acceptance work. Three **P1**s: **P1-2**, **P1-3**,
**P1-4**.

All seven `TURN_FAILURE_REASON` members resolve through a fenced status write and a structured log line; none
calls Sentry directly, which the branch documents as a deliberate single go-live decision. That posture is not
itself reported. What is reported is the alert path around it: `docs/runbooks/beta-launch-alerting.md` was read
in full and grepped for `agent_turn`, `AGENT_TURN`, `owner operator`, `operator_disabled`, `account_offboarding`,
`predecessor_stalled`, `model_output_invalid`, `budget_exceeded` and `worker_job` — **zero matches for every
term**, which is what makes the three findings auditable rather than assertions.

| failure path | emitted signal | runbook row | verdict |
|---|---|---|---|
| `exhausted` (BullMQ retry exhaustion) | `captureException` tagged `{subsystem:worker_job, queue:agent_turn, topic}` | none | **P1-3** — signal, no row |
| failed `agent_turn` outbox row | none (`checkFailedOutboxByTopic` allowlist omits the topic) | rule 1 would cover it | **P1-2** — row, no signal |
| stuck `dispatched` row past the watchdog window | none (log line only, topic-aggregated) | none | **P1-4** — the contract names a signal that does not exist |
| `agent_turn` pending backlog / stale dispatching | `outbox_pending_age`, `outbox_stale_dispatching`, `backlog_depth:job_outbox` (topic-agnostic) | rule 1 | **covered** |
| the six domain terminal reasons | none, by design (the job completes normally) | n/a | **not a gap** — consistent with the Judge lane's own per-turn posture |
| three new route 500s via `reportCaughtError` | `captureException` tagged `endpoint` | none | **not reported** — the same unrowed state as nearly every `reportCaughtError` site; not branch-specific |

Both intake observability claims were tested. *"The job-failure sink raises a Sentry issue on terminal
exhaustion"* is **true but incomplete** — it fires only when BullMQ itself marks the job failed, never on the
SQL-only watchdog path, and the resulting signal has no rule (**P1-3**). *"A stuck 'dispatched' row past the
watchdog window is the signal a lease was orphaned"* is **misleading** — it is a forensic DB artifact, not a
signal, and nothing routes it (**P1-2**, **P1-4**).

## Inventory

269 rows, one per candidate, in `findings.json`. Every in-scope candidate has a row: executed,
`skipped-budget`, or `excluded` with its reason. The 238 `skipped-budget` rows are the honest cost of a 30-run
round against a ~2 800-production-line / ~2 400-test-line branch; they are not silent sampling. The two
`inconclusive` rows carry class `oracle` and are the two uncovered production branches reported as **P1-1** and
**P1-7**. Three `excluded` rows cover `supabase/migrations/120_owner_operator.sql` (the database is provisioned
to head before the run, so mutating a migration changes nothing under test), the 24 changed documentation and
reference pages (no executable behaviour — verified under duty 3 instead), and Playwright (none changed).

Executed candidates, all 27:

| mutation | file | rule | covering test | outcome |
|---|---|---|---|---|
| `r-m1` | `render.ts` | validateTextSegments invented-count rule (render.ts:134-136) | `render.test.ts` · validator rejects a text segment that invents a count next to a metric word | killed |
| `r-m2` | `render.ts` | validateTextSegments completion-claim rule (render.ts:137-139) | `render.test.ts` · validator rejects a text segment that claims a change was applied before any click | killed |
| `r-m3` | `render.ts` | validateTextSegments prose-member guard, question arm (render.ts:133) | `render.test.ts` · validator applies the count and completion patterns to question segments, not only text | killed |
| `r-m4` | `render.ts` | validateRefSegments status_ref membership rule (render.ts:152-154) | `render.test.ts` · validator rejects a proposal_ref index with no proposal and a status_ref metric outside the snapshot | killed |
| `r-m5` | `render.ts` | validateRefSegments proposal_ref bound, >= to > (render.ts:155) | `render.test.ts` · validator rejects a proposal_ref index with no proposal and a status_ref metric outside the snapshot | killed |
| `r-m6` | `render.ts` | validateScopeCheck stored-location comparison inverted (render.ts:172) | `render.test.ts` · validator rejects a scope_check that names the stored location or coexists with a proposal for the stored location | killed |
| `r-m8` | `render.ts` | validateScopeCheck coexistence rule (render.ts:183-185) | `render.test.ts` · validator rejects a scope_check that names the stored location or coexists with a proposal for the stored location | killed |
| `r-m11` | `render.ts` | validateProposalScope location-scoped-must-name-location rule (render.ts:207-209) | `render.test.ts` · validator rejects a proposal whose operation is outside the catalog or whose scope is neither the stored location nor the account default | killed |
| `r-m12` | `render.ts` | validateProposals unknown-operation rule (render.ts:227-229) | `render.test.ts` · validator rejects a proposal whose operation is outside the catalog or whose scope is neither the stored location nor the account default | killed |
| `r-m15` | `render.ts` | scrubPastedReview block splitting (render.ts:64) | `render.test.ts` · scrubber replaces a pasted review block with the marker and leaves ordinary owner text untouched | killed |
| `r-m16` | `render.ts` | scrubPastedReview rating-header carries the next block (render.ts:73-75) | `render.test.ts` · scrubber replaces a pasted review block with the marker and leaves ordinary owner text untouched | killed |
| `w-m14` | `AgentTurnWorker.ts` | handleAgentTurn kill-switch gate (AgentTurnWorker.ts:323) | `AgentTurnWorker.test.ts` · worker flag-off fails the turn operator_disabled and completes the outbox without loading tenant context | killed |
| `t-m1` | `turns.ts` | failTurnAndCompleteOutbox CAS-before-fail ordering (turns.ts:496-499) | `AgentTurnWorker.test.ts` · worker flag-off fails the turn operator_disabled and completes the outbox without loading tenant context | killed |
| `w-m7` | `AgentTurnWorker.ts` | generateAndAssemble vanished-voice terminal reason (AgentTurnWorker.ts:226) | `AgentTurnWorker.test.ts` · worker fails the turn unauthorized when the location voice row vanished after authorization | killed |
| `t-m5` | `turns.ts` | failTurnFenced outbox completion inside the transaction (turns.ts:441) | `AgentTurnWorker.test.ts` · worker fails the turn unauthorized when the location voice row vanished after authorization | killed |
| `w-m10` | `AgentTurnWorker.ts` | generateAndAssemble passes the SCRUBBED text to the model (AgentTurnWorker.ts:193) | `turn-worker.integration.test.ts` · worker scrubs a pasted review out of the prompt and stores the notice as the first segment | killed |
| `w-m9` | `AgentTurnWorker.ts` | generateAndAssemble scrub flag reaches materializeReply (AgentTurnWorker.ts:264) | `turn-worker.integration.test.ts` · worker scrubs a pasted review out of the prompt and stores the notice as the first segment | killed |
| `w-m12` | `AgentTurnWorker.ts` | handleTurnError releases the claim before a transient rethrow (AgentTurnWorker.ts:309-313) | `turn-worker.integration.test.ts` · worker releases its claim on a transient failure so the retry re-claims and completes | killed |
| `w-m3` | `AgentTurnWorker.ts` | waitOrFailOnPredecessor stall threshold comparison (AgentTurnWorker.ts:114) | `turn-worker.integration.test.ts` · worker fails the turn predecessor_stalled after the stall limit | killed |
| `w-m4` | `AgentTurnWorker.ts` | waitOrFailOnPredecessor releases the claim before moveToDelayed (AgentTurnWorker.ts:132-136) | `turn-worker.integration.test.ts` · worker predecessor wait releases the claim and delays the job without spending retry budget | killed |
| `w-m6` | `AgentTurnWorker.ts` | generateAndAssemble offboarding-vs-unauthorized reason split (AgentTurnWorker.ts:166-168) | `turn-worker.integration.test.ts` · worker step 3 fails the turn account_offboarding for an offboarding account and builds no snapshot | killed |
| `w-m8` | `AgentTurnWorker.ts` | generateAndAssemble binds stored proposal ids by index (AgentTurnWorker.ts:263) | `turn-worker.integration.test.ts` · worker claim race: two dispatches of one turn produce one completed turn and one proposal set | killed |
| `t-m4` | `turns.ts` | claimTurn 180 s lease predicate (turns.ts:250-254) | `turn-worker.integration.test.ts` · worker claim race: two dispatches of one turn produce one completed turn and one proposal set | **SURVIVED → P0-1** |
| `t-m2` | `turns.ts` | completeTurnFenced attempt_token fence (turns.ts:386) | `turn-worker.integration.test.ts` · worker fenced completion discards an attempt whose lease was lost | killed |
| `w-m18` | `AgentTurnWorker.ts` | settleClaimMiss terminal-turn outbox completion (AgentTurnWorker.ts:87) | `turn-worker.integration.test.ts` · worker claim race: two dispatches of one turn produce one completed turn and one proposal set | killed |
| `t-m3` | `turns.ts` | completeTurnFenced supersession replacements (turns.ts:400-404) | `turn-worker.integration.test.ts` · worker supersedes earlier pending proposals with the same operation and scope | killed |
| `t-m6` | `turns.ts` | failTurnFenced attempt_token fence (turns.ts:434) | `turn-worker.integration.test.ts` · worker step 3 fails the turn unauthorized for a revoked owner and builds no snapshot | skipped — budget |

## Authorizations

None. This pass has no authority to accept risk; every finding is `open`.

## Restoration

All three mutated files were verified byte-identical to HEAD before a single report byte was written:
`render.ts`, `AgentTurnWorker.ts` and `turns.ts` all hash to their `5b223e33f` blobs, and
`git status --porcelain` is empty apart from this report's two artifacts. The journal still carries its
`applied` entries and the dotenv swap is still open, because `finalize` is the orchestrator's step, not this
pass's — `red-team-status.mjs` reports exactly those two conditions and nothing else.
