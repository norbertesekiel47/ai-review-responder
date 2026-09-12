# Red team — `feat/owner-operator-run-a`, round 3 (doc-only fix verification)

> **This file supersedes rounds 1 and 2 IN PLACE.** One run
> (`feature-feat-owner-operator-run-a-b83a4f`), one journal, three rounds, each opened by
> `mutation-runner.mjs round-start` over the previous round's closed journal. Round 1 ran at head
> `5b223e33f19499534961bf2d60d8781a41af780f`, round 2 at `3a377f6562ce564051b7fd21bd751c9bd9be49ed`
> (the round-1 fix), round 3 at `7583062a4ea206702bab339930a315fdd6875496` (the round-2 doc fix).
> Round 3 is the owner-authorized third round; a fourth cannot open.

| | |
|---|---|
| mode | `feature` |
| branch | `feat/owner-operator-run-a` |
| fork | `10c9444a9832cae0e45854f1d19cb124bb2ee5e9` |
| merge-base | `10c9444a9832cae0e45854f1d19cb124bb2ee5e9` |
| head | `7583062a4ea206702bab339930a315fdd6875496` |
| fix commit under verification | round 3: `7583062a4ea206702bab339930a315fdd6875496` (docs only) · round 2: `3a377f6562ce564051b7fd21bd751c9bd9be49ed` |
| intake SHA-256 | `43b0b7ef5336f5081e6877cb6eaab8f6f8d138521332e8529df47d47cb43e89d` (after surface amendment #5) |
| risk | `high` |
| round | 3 |
| generated | 2026-09-12T10:33:53Z |
| mutation runs used | round 3: **0** of 30 (doc-only fix — no production line changed, so there is nothing to mutate). Round 2 spent 15. |

## Verdict

**Status: `CLEAR`.** Three rounds, all of this run: round 1 found nine, round 2 verified all
nine `fixed` and opened two P2s, round 3 verified both of those `fixed` and opened one new P2.

No P0 and no P1 has ever been left open. Round 3 was the owner-authorized third round
(`auth-round-3-docs-2026-09-12`), scoped to the two doc hunks P2-2 and P2-3 live in.

One NEW finding, **P2-4** (`open`), inside the round-3 hunk: the bullet's new triage step names a
`turn_id` the Sentry event does not carry. P2 never blocks — and it cannot be verified by a further
round, because the skill caps the loop at three and no fourth can open. It belongs with the runbook
work already owed before `OWNER_OPERATOR_ENABLED` is flipped.

`CLEAR` remains a SCOPE claim, not a coverage claim — see the scope-rule section below.

## Round-2 scope rule and owner decisions

Two owner decisions were taken on 2026-09-12 after round 2 closed, and both are recorded here
because they change what this sidecar asserts.

**Decision 1 — apply the round-2 scope rule** (owner selected "Apply the round-2 scope rule" via
AskUserQuestion). Round 2's mandate is to verify the fix hunks and their direct callers; a front
against unchanged code is forbidden by the skill. Every inventory row that was `skipped-budget`
and whose candidate lies outside that scope is therefore re-labelled `excluded` rather than left
as an unmeasured in-scope debt. **237 rows were re-labelled.** Zero `skipped-budget` rows remain,
which is what moves the computed status from `INCOMPLETE_BUDGET` to `CLEAR`.

**This is a scope statement, not a coverage statement.** Those 237 candidates were never executed
in ANY round of this run — not round 1 (the 30-launch cap was reached at launch 31) and not round 2.
Each carries that fact verbatim in its `reason`. `CLEAR` here means "nothing in round 2's scope is
unmeasured or unresolved", and must not be read as "the branch's test surface has been
mutation-tested". The untested surface is concentrated in
`worker/config/__tests__/startup-assertion.test.ts` (~110 rows),
`src/lib/shared/__tests__/job-outbox-helpers.test.ts` (~29),
`src/lib/account-offboarding/__tests__/*` (~31) and
`src/app/api/settings/voice/__tests__/route.test.ts` (~19) — all unchanged by the fix commit.

**The one borderline call, stated so it is auditable.** Five `skipped-budget` rows lived in
`worker/jobs/agent-turn/__tests__/failed-hook.test.ts`, the test file for `failed-hook.ts` — one of
only two PRODUCTION files the fix commit touched. Scope was applied at **hunk** granularity, not
file granularity, which is how the rule was worded ("the fix commit's hunks and their direct
callers") and how the skill words it ("the fix hunks and their directly affected callers"):

- `:84` ("on exhaustion runs the outbox CAS FIRST …") is the only case that exercises the changed
  line. It was executed in round 2 and **killed** by M5. Its row is `INV-263`, which now carries
  that kill; the separate row I had opened for the same candidate (`INV-273`) was merged into it so
  one test cannot carry both "never measured" and "killed".
- `:58`, `:114`, `:127`, `:142` cover `isExhausted`, the ownership CAS, the catch block and the log
  redaction — all unchanged code. Mutating any of them in round 2 would be precisely the forbidden
  front, so they are `excluded`, not `skipped-budget`.

Had scope been applied at FILE granularity those four would be in-scope debt and the status would
be `INCOMPLETE_BUDGET`. The hunk reading is applied consistently across the whole inventory: no row
was excluded for being in an untouched file while another in the same file was kept.

**Decision 2 — fix the two P2s in a third round** (owner selected "Fix now, third round"). Recorded
in `findings.json` as authorization `auth-round-3-docs-2026-09-12` over findings **P2-2** and
**P2-3**. Its only function is to let `round-start` open round 3 — which the runner permits only
when the sidecar already carries an authorization whose text names the third round. P2-2 and P2-3
keep disposition **`open`** and carry **no** `authorization` field: they are being FIXED, not
accepted as risk, and the two dispositions are exclusive. Round 3 is scoped to the two doc hunks
the wording defects live in — `docs/roadmap/2026-09-11-owner-operator/README.md` line 638 and the
`agent_turn` bullet in `docs/runbooks/beta-launch-alerting.md` §1 — after the orchestrator's fix
commit.

## Round 3 (doc-only)

The owner authorized a third round for P2-2 and P2-3; `round-start` accepted it against the
committed round-2 sidecar and opened round 3 with 30 runs available. **Zero were spent.**
`git diff 3a377f656 7583062a4` touches no production file — only the two docs and the round-2
sidecar commit `0cfee39e0` — so there is no changed production line to mutate, and spending runs on
unchanged code is the forbidden front. Duties 3 and 5 were re-run STATIC, as instructed.

**Every production coordinate was re-resolved at this HEAD rather than carried over from round 2.**
The docs-only diff makes carrying them over tempting and it is exactly what the skill's "green CI is
never proof that a document is true" rule warns against, so the greps were re-run.

| claim in the round-3 text | resolved against HEAD | result |
|---|---|---|
| `TURN_FAILURE_REASON` has seven members | `schema.ts:52-60` — 7 exactly | TRUE |
| six are domain terminals the worker writes | `AgentTurnWorker.ts:119`, `:167`, `:168`, `:201`, `:226`, `:289`, `:331` → 6 distinct reasons | TRUE |
| the seventh, `exhausted`, is written by the failed-hook, not the worker | `failed-hook.ts:70`; no `EXHAUSTED` in `AgentTurnWorker.ts` | TRUE |
| `account_offboarding` is the other outcome of the same reauthorization arm | the ternary at `:166-168`, one shared `logger.warn` at `:171` | TRUE |
| five reasons `logger.warn`, `operator_disabled` `logger.log` | warn `:122`, `:171`, `:204`, `:229`, `:292`; log `:324` | TRUE |
| lease-lost is NOT a terminal, emits `logger.warn`, resolves nothing | `:370` | TRUE |
| none of the six calls Sentry | no `Sentry.`/`capture` in `AgentTurnWorker.ts` | TRUE |
| watchdog = one count-only line `Watchdog recovered stale entries` with `recovered`/`failed`/`stale_dispatching`, no topic field, no Sentry | `OutboxPoller.ts:162-168`; no Sentry in `:101-170` | TRUE, **verbatim** |
| `reportJobFailure` fires on every terminal `failed` event | `job-failure-sink.ts:64-66` — `isFailedEventTerminal` is the only gate | TRUE |
| the failed-hook ends the turn `exhausted` only when its `markOutboxFailed` CAS owns the row | `failed-hook.ts:53-58`, `!owns` return `:59-63`, `EXHAUSTED` `:67-71` | TRUE |
| allowlist entry still present | `health-alert/checks.ts:121` | TRUE |
| sink tags still `subsystem:worker_job` + `queue:agent_turn` | `job-failure-sink.ts:74`, `worker/index.ts:574` | TRUE |
| click-path row 11, all six facets | `beta-launch-alerting.md:412`, unchanged since round 2 | TRUE |
| "Read `agent_turns.status` for the `turn_id`" | event carries `job_id`/`outbox_id`/`attempts_made` only (`job-failure-sink.ts:68-78`); `job_id` = `<outbox_id>_<attempt>` (`OutboxPoller.ts:301`) | **gap → P2-4** |

`prevalidate-plan.py` was re-run over both review docs. Output is byte-identical to round 2 —
neither doc was touched by the round-3 commit — and all three residual issues remain the same
adjudicated false positives (a bare `voice/route.ts:23` shorthand resolved as a repo-root path;
`43b0b7ef` is the intake SHA-256 prefix; `42bc6db1` is the round-1 gate fingerprint).

**Two things accepted by inspection rather than filed**, recorded so the judgement is auditable:

- The README says the six domain terminals are written "through a **fenced** status update". Five
  use `failTurnFenced` (fenced on `attempt_token`); `operator_disabled` at `:328` uses
  `failTurnAndCompleteOutbox`, which fences on the outbox-ownership CAS instead — the code's own
  comment at `:325-327` says so. "Fenced" is true of both in the sense that matters (neither write
  can land from a superseded dispatch) and the line never claims `attempt_token`. Not a false claim.
- The runbook quotes the superseded log text as `agent_turn exhaustion for a superseded dispatch`.
  The actual string is `'agent_turn exhaustion for a superseded dispatch, leaving the turn alone'`
  (`failed-hook.ts:60`) — the quote is a PREFIX, not the full message. An operator grepping the
  quoted text still finds the line, so the truncation costs nothing and misleads about nothing.
  Flagged here rather than filed, since inventing a finding to look thorough is forbidden.

## Findings — round-2 and round-3 disposition

| id | sev | duty | at | round-2 disposition | kill / re-resolution evidence |
|---|---|---|---|---|---|
| `P0-1` | P0 | 1 | `src/lib/agents/operator/turns.ts:250-254` | **fixed** | M1 (lease arm deleted, `turns.ts` `7c5479c27ed0`→`83d244562b94`) → 3 kills: integration `:482` `expected 2 to be 1`; integration `:517` `expected { …(9) } to be null`; `turns.test.ts:131` text oracle |
| `P1-1` | P1 | 1 | `src/lib/agents/operator/render.ts:231-233` | **fixed** | M2 (`!` removed from the `allowedOperations.some` gate, `render.ts:231`) → `render.test.ts:280` `expected true to be false` |
| `P1-7` | P1 | 1 | `worker/jobs/agent-turn/AgentTurnWorker.ts:282-294` | **fixed** | M4 (`isBudgetDecision` → `false`, `AgentTurnWorker.ts:38`) → `promise rejected "CostLimitExceededError" instead of resolving` |
| `P1-2` | P1 | 5 | `worker/background/pollers/health-alert/checks.ts:105-124` | **fixed** | M3 (`AGENT_TURN` removed from the closed allowlist, `checks.ts:124`) → `expected [ 'publish_response', …(6) ] to include 'agent_turn'`; emission path re-resolved through `emit.ts:10-18` |
| `P1-3` | P1 | 5 | `worker/job-failure-sink.ts:64-80` | **fixed** | static: all six facets re-resolved against `job-failure-sink.ts:64-80` + `worker/index.ts:567-575`; none contradicts the emitter |
| `P1-4` | P1 | 5 | `worker/background/pollers/OutboxPoller.ts:93-165` | **fixed** | static: `OutboxPoller.ts:160-166` confirmed log-only, intake promises a row state not an alert, terminal half now alerts via P1-2 — neither half orphaned |
| `P1-5` | P1 | 3 | `docs/roadmap/2026-09-11-owner-operator/README.md:638` | **fixed** | static: `rg "logger\.(log|warn|error)\("` over `AgentTurnWorker.ts` — all seven per-path levels match the rewritten line |
| `P1-6` | P1 | 3 | `.claude/reference/lab-notes/postgres.md:17` | **fixed** | static: `parseReplySegments` resolves to `context.ts:297`, `reads.ts:97`, `reads.ts:213` exactly as the corrected line says |
| `P2-1` | P2 | 4 | `worker/jobs/agent-turn/failed-hook.ts:26-28` | **fixed** | M5 (`boundedErrorClass(err)` → constant, `failed-hook.ts:36`) → `expected [ …(2) ] to include 'agent_turn_exhausted:ProviderTimeout'` |
| `P2-2` | P2 | 3 | `docs/roadmap/2026-09-11-owner-operator/README.md:638` | **fixed** (round 3) | seven members partitioned 6 worker / 1 failed-hook, `account_offboarding` named, lease-lost excluded from the count; watchdog line verified verbatim at `OutboxPoller.ts:162-168` |
| `P2-3` | P2 | 5 | `docs/runbooks/beta-launch-alerting.md:330-339` | **fixed** (round 3) | ownership split now stated: sink fires on every terminal event (`job-failure-sink.ts:64-66`), hook ends the turn `exhausted` only when its CAS owns the row (`failed-hook.ts:53-71`) |
| `P2-4` | P2 | 5 | `docs/runbooks/beta-launch-alerting.md:337-338` | **open** | NEW (round 3) — the triage step names a `turn_id` the event does not carry; `extra` has `job_id`/`outbox_id`/`attempts_made` only |

### P0-1 — P0 (duty 1) — claimTurn's 180 s lease predicate can be deleted with the entire agent-turn suite still green

- **At:** `src/lib/agents/operator/turns.ts:250-254`
- **Disposition:** `fixed`

FIXED by 3a377f656. The lease predicate now has two oracles and M1 (the identical t-m4 deletion) killed both: the claim-race test's new spend assertions (turn-worker.integration.test.ts:472-483 — exactly one runLlmTask call and one recordApiCost call for the racy turn) failed "expected 2 to be 1" at :482, and the new direct case "claimTurn turns a second dispatch away inside the lease…" failed expect(second).toBeNull() at :517. A third, keyless oracle in turns.test.ts:113-136 also failed. INV-023, INV-270, INV-271.

ROUND-1 EVIDENCE (retained): Mutation t-m4 deleted the lease predicate from claimTurn's WHERE clause — the "claimed_at IS NULL OR claimed_at < NOW() - (leaseSeconds * INTERVAL '1 second')" arm — leaving only "status IN ('accepted','running')". The covering test, "worker claim race: two dispatches of one turn produce one completed turn and one proposal set" (src/lib/agents/operator/__tests__/turn-worker.integration.test.ts:319), still PASSED. A confirming run of the whole agent-turn test set under the same mutant — turn-worker.integration.test.ts + worker/jobs/agent-turn/__tests__ + turns.test.ts — reported 23 passed, 0 failed. The behavioural replacement: the concurrent section of that test (turn-worker.integration.test.ts:500-517) should assert that exactly one attempt reached the model and was billed (expect(runLlmTask).toHaveBeenCalledTimes(1) and one recordApiCost / api_costs row for the racy turn), and a direct claimTurn case should prove a second claim inside the lease returns null while one after lease expiry succeeds.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. Not an equivalent mutation. Deleting the lease predicate lets a second dispatch claim a turn whose 180 s lease is live (AGENT_TURN_LEASE_SECONDS, worker/jobs/agent-turn/constants.ts), so two attempts each run step 3, each build a snapshot and each make their own cost-guarded owner_operator model call. The intake's own risk_reasons names this consequence verbatim: "a new BullMQ worker (AgentTurnWorker) makes a cost-guarded LLM call ... a defect can double-bill or strand turns". Not an unexecuted branch either: the test's third section runs two handleAgentTurn calls under Promise.all on one freshly created turn, so both reach claimTurn inside the same lease window, and claimTurn is the first statement either executes after the flag gate. It survives because the assertions describe only the END STATE — one completed turn, one agent_proposals row, outbox completed — and completeTurnFenced's attempt_token fence delivers that end state on its own, independently of the lease. The lease predicate and the completion fence are two separate guards: the fence stops a stale attempt from WRITING, only the lease stops a second attempt from SPENDING. The suite asserts the first and never the second. Independently corroborated without spending a further run: "rg AGENT_TURN_LEASE_SECONDS|leaseSeconds|LEASE" across src/lib/agents/operator/__tests__ and worker/jobs/agent-turn/__tests__ returns no hit, the only two claimed_at writes in the suite (turn-worker.integration.test.ts:549, :585) drive loadPredecessor's age rather than the claim, and the claim-race test makes no runLlmTask or recordApiCost call-count assertion at all. Mutation t-m2, which removed completeTurnFenced's attempt_token fence, was KILLED — so the pair is asymmetric: the written-state half of the protocol is asserted and the spend half is not.

### P1-1 — P1 (duty 1) — The validator's allowedOperations gate is reached by no test

- **At:** `src/lib/agents/operator/render.ts:231-233`
- **Disposition:** `fixed`

FIXED by 3a377f656. render.test.ts:261-307 now proposes set_highlight_facts — registered in CATALOG with a valid input, so it clears the outside-the-catalog branch — against a snapshot that omits it, and asserts the "may not use" reason; a positive control re-runs the same proposal with the id added to allowedOperations and asserts ok. M2 (negating the gate at render.ts:231) killed it at render.test.ts:280. INV-028.

ROUND-1 EVIDENCE (retained): An uncovered behaviour-affecting production hunk (Direction B, Step 2). The rule fires only for a proposal whose operation IS registered in CATALOG but is NOT in snapshot.allowedOperations. Both validator fixtures close that set — render.test.ts:31-35 lists set_tone, set_avoid_facts, read_pending_work; model-call.test.ts:57-60 lists set_tone, read_pending_work — and no test anywhere proposes set_products_services or set_highlight_facts through validateModelOutput (rg over src/lib/agents/operator/__tests__ and src/app/api/operator/__tests__ finds those two ids only in catalog.test.ts's catalog sweep and in two read-path suites that SEED agent_proposals rows directly). The single in-catalog-but-absent id a test does use, set_daily_cap, is not registered at all, so it is rejected by the earlier branch at render.ts:227-229 and continues before reaching 231. Suggested fix: add one case proposing a catalog operation the snapshot omits and assert the "may not use" reason.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. Established statically rather than by mutation, because the per-test cap of 2 mutations was already spent on the only test that could cover this rule. Recorded as P1 (uncovered change) rather than P0: the rule is also unreachable in production today — modelVisibleOperations (src/lib/agents/operator/catalog.ts:193-203) returns every CATALOG entry and ignores its tier parameter, so snapshot.allowedOperations always equals the catalog — which makes this a forward guard for Run B's tier-gated operations rather than a live hole in the no-unapproved-operation path. It still blocks the round as an inconclusive oracle row, because "no test can distinguish this rule from its absence" is a claim about the oracle.

### P1-7 — P1 (duty 1) — The handleTurnError budget-decision terminal branch has no covering test

- **At:** `worker/jobs/agent-turn/AgentTurnWorker.ts:282-294`
- **Disposition:** `fixed`

FIXED by 3a377f656. turn-worker.integration.test.ts:568-590 drives a real CostLimitExceededError through handleAgentTurn on the live DB and asserts it RESOLVES, the turn is failed/budget_exceeded, the outbox row is completed in the same transaction, and job.moveToDelayed was never called. M4 (isBudgetDecision -> false) killed it: the promise rejected instead of resolving. INV-029.

ROUND-1 EVIDENCE (retained): An uncovered behaviour-affecting production hunk (Direction B, Step 2). This is the branch that makes an exhausted account budget TERMINAL instead of burning the BullMQ retry ladder: isBudgetDecision(error) -> failTurnFenced with TURN_FAILURE_REASON.BUDGET_EXCEEDED. Neither budget_exceeded nor BUDGET_EXCEEDED nor isBudgetDecision appears in any test file in the repository, and no test on this lane constructs a CostLimitExceededError or a GlobalCostLimitExceededError. The sibling transient branch immediately below it IS covered ("worker releases its claim on a transient failure so the retry re-claims and completes"), and so is the exhausted reason in failed-hook.test.ts:107 — budget_exceeded is the one terminal reason with no case. The intake names it in both observability ("agent_turns.status and failure_reason distinguish failed reasons (... budget_exceeded)") and edge_cases ("Terminal failure (... budget exceeded ...)").

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. Recorded without spending a mutation run: the absence of the token from every test file is direct evidence that no oracle exists, and the round budget was exhausted. Severity P1 rather than P0 because a miss is bounded — the cost RESERVATION precedes the model call, so a budget-exceeded error that fell through to the retry ladder would spend nothing extra and would end as failure_reason "exhausted" via the failed-hook instead of "budget_exceeded". The defect would therefore be an observability regression on a reason the intake promises to distinguish, not lost money or a stranded turn.

### P1-2 — P1 (duty 5) — agent_turn is missing from checkFailedOutboxByTopic's closed allowlist, so no health-alert finding can fire for a failed turn

- **At:** `worker/background/pollers/health-alert/checks.ts:105-124`
- **Disposition:** `fixed`

FIXED by 3a377f656. QUEUE_NAMES.AGENT_TURN joined checkFailedOutboxByTopic's closed allowlist (worker/background/pollers/health-alert/checks.ts:124) with a regression case; M3 (removing it again) killed that case. Re-resolved the whole emission path at head: emitHealthFindings (worker/background/pollers/health-alert/emit.ts:10-18) raises Sentry.captureMessage with tags subsystem=health_alert and finding=<key>, so key "outbox_failed:agent_turn" at level error rides the existing runbook §1 rule (beta-launch-alerting.md:28-33). failedThreshold defaults to 0 (checks.ts:78), so one failed row raises. INV-272.

ROUND-1 EVIDENCE (retained): A missing alert-path half: the branch adds an owner-impacting outbox topic and no emitting signal watches it. The allowlist binds exactly PUBLISH_RESPONSE, SEND_NOTIFICATION, GENERATE_RESPONSE, BUILD_SOLICITATION_BATCH, GENERATE_SOLICITATION_ASKS and SOLICITATION_VETO_NOTICE; QUEUE_NAMES.AGENT_TURN (src/lib/shared/queue-names.ts:68) is absent. A failed agent_turn row therefore raises no subsystem:health_alert finding, so rule 1 of docs/runbooks/beta-launch-alerting.md can never fire for this lane. Fix: add QUEUE_NAMES.AGENT_TURN to the allowlist, or state in the runbook why a failed turn is not owner-impacting.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. The code comment directly above the allowlist names this exact defect class as a prior incident — "This is a CLOSED allowlist, so a new owner-impacting topic stays invisible until it is added here. generate_solicitation_asks shipped without it (#628 round 5), which silently voided that lane's dead-letter rationale: its terminal handler concedes the batch to 'an operator will see the failed row', and nothing was watching the row." The owner-impact test is met: a failed agent_turn means the owner's Operator message never receives a reply, and the branch's own design leans on the row being seen (docs/roadmap/2026-09-11-owner-operator/README.md:636 defers the stranded-turn case to Run B on exactly that basis). Verified independently of the subagent that surfaced it: I re-read checks.ts:105-124 and confirmed the six bound topics, and "rg -in agent_turn|owner.operator|worker_job docs/runbooks/beta-launch-alerting.md" returns zero matches.

### P1-3 — P1 (duty 5) — The job-failure-sink Sentry signal for queue agent_turn has no rule row in beta-launch-alerting.md

- **At:** `worker/job-failure-sink.ts:64-80`
- **Disposition:** `fixed`

FIXED by 3a377f656. A §1 checklist bullet (beta-launch-alerting.md:325-341) and click-path row 11 (:406) now carry the signal. All six duty-5 facets re-resolved against the emitter at head and none contradicts it: identity = Sentry.captureException in reportJobFailure (worker/job-failure-sink.ts:64-80); filter = tags subsystem='worker_job' AND queue=<queueName> (:75), with attachJobFailureSink applied to every worker including AGENT_TURN (worker/index.ts:567-575, QUEUE_NAMES.AGENT_TURN at :529) so queue resolves to 'agent_turn' (queue-names.ts:68); level = the captureException default error, no override; grouping = Sentry's exception fingerprint, no custom fingerprint; cadence = every event, not a first-seen rule; destination = the Discord integration named in row 11.

ROUND-1 EVIDENCE (retained): The other missing half: an emitted signal with no rule row. worker/index.ts registers agentTurnWorker into workersByQueue, and the existing loop attaches attachJobFailureSink to every entry, so BullMQ terminal exhaustion on this lane fires Sentry.captureException tagged {subsystem: "worker_job", queue: "agent_turn", topic}. That tag set matches no _If_ filter in the runbook's rule table and is not listed in the runbook's own register of signals that knowingly have no dedicated rule. Facet compared and contradicted: signal identity and filter (no rule selects this tag set) and destination action (no documented destination). Fix: add a rule row for subsystem:worker_job scoped to this queue, with a cadence, or extend the existing register to acknowledge it.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. Scoped deliberately to the lane this branch adds rather than opened as a front against the sink, which is unchanged code: the finding is that the branch wires a NEW queue into an existing emitter and ships no rule for it. The runbook keeps an explicit list of signals that have no dedicated rule, which is what makes an unlisted, unrowed signal a reportable omission rather than an accepted posture.

### P1-4 — P1 (duty 5) — The orphaned-lease signal the intake names is a log line only — no Sentry event, no rule row

- **At:** `worker/background/pollers/OutboxPoller.ts:93-165`
- **Disposition:** `fixed`

FIXED by 3a377f656. The gap was a documented-but-unemitted orphaned-lease alert. After the fix neither half of the path is orphaned: the intake's observability line promises only that "a stuck 'dispatched' row past the watchdog window is the signal a lease was orphaned" — a job_outbox row state, not a Sentry alert — and runOutboxWatchdogRecovery (OutboxPoller.ts:160-166) is confirmed at head to emit one aggregated logger.log and no Sentry call, which both changed docs now state explicitly. The half that IS operator-actionable, the row landing failed, now alerts through P1-2's allowlist entry. No rule row claims an alert that nothing emits, and no emitted signal lacks a row, so the duty-5 condition no longer holds. Recorded as fixed rather than accepted-risk for that reason; see new finding P2-3 for one wording imprecision that survives.

ROUND-1 EVIDENCE (retained): The intake's observability section states: "job_outbox rows for topic agent_turn: a stuck 'dispatched' row past the watchdog window is the signal a lease was orphaned." Both branches of runOutboxWatchdogRecovery — re-pending a stale dispatched row, and terminalising it to failed — only emit a structured log line, aggregated across every topic rather than broken out per topic, and neither captures to Sentry. Combined with P1-2, a worker crash that strands an agent_turn row in dispatched past the watchdog window produces zero Sentry event end to end: nothing from the watchdog, and nothing from checkFailedOutboxByTopic once the row lands failed. Facet contradicted: destination action — the contract names a signal that has no operator-actionable destination.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. Reported against the contract the branch wrote rather than against OutboxPoller, which is unchanged: the claim that this row IS the orphaned-lease signal is new on this branch, and it is the claim that fails. Fixing P1-2 alone resolves the terminalised half of this; the re-pend half stays a log line, which is defensible if the runbook says so. Closing either the code or the contract sentence would settle it.

### P1-5 — P1 (duty 3) — A changed doc claim is false: the agent_turn lane does not emit logger.warn uniformly across the six terminal paths

- **At:** `docs/roadmap/2026-09-11-owner-operator/README.md:638`
- **Disposition:** `fixed`

FIXED by 3a377f656. Every claim in the rewritten README:638 bullet re-resolved against head with rg "logger\.(log|warn|error)\(" over worker/jobs/agent-turn/AgentTurnWorker.ts: predecessor_stalled warn (:122), unauthorized reauthorization arm warn (:171), unauthorized vanished-voice arm warn (:229), model_output_invalid warn (:204), budget_exceeded warn (:292), operator_disabled logger.log/info (:324), lease-lost warn (:370). The false uniformity claim is gone and the per-path levels are now correct. Two residual imprecisions in the same line are recorded separately as P2-2 rather than reopening this finding.

ROUND-1 EVIDENCE (retained): The bullet, added by this branch inside the @@ -627,14 +627,37 @@ hunk, asserts that every terminal path in AgentTurnWorker — naming operator_disabled first — "resolves the turn and emits a logger.warn line", and concludes "That is uniform across the six paths, not a gap in one of them". At HEAD the operator_disabled path emits logger.log (worker/jobs/agent-turn/AgentTurnWorker.ts:324, "agent_turn flag-off skip"); the other five use logger.warn (AgentTurnWorker.ts:122, :171, :204, :229, :292). Fix: say five of the six paths warn and the flag-off skip logs at info, or change line 324 to warn.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. Re-derived at HEAD, not taken from the subagent report: I read the bullet and the six call sites myself and confirmed the hunk membership with git diff. Recorded as P1 rather than P0 after weighing the "misleading FALSE claim" bar. The bullet's operative assertions are all true and independently verified here — there is no Sentry call anywhere in AgentTurnWorker.ts, and beta-launch-alerting.md carries no row for the lane — and the same sentence itself describes operator_disabled as "an orderly flag-off skip ... not an incident", which is consistent with logger.log being deliberate. A reader is therefore misled about one path's log LEVEL, not about whether the lane is alerted or about the single go-live decision the bullet defers. The concrete harm is bounded to whoever later implements that deferred decision with a level:warn filter and silently drops every operator_disabled turn. Recorded at P1 with this reasoning so the owner can escalate it to P0 if they weigh the uniformity assertion as load-bearing.

### P1-6 — P1 (duty 3) — The authoritative JSONB parse-site allowlist names the wrong file for the agent_turns.reply parse sites

- **At:** `.claude/reference/lab-notes/postgres.md:17`
- **Disposition:** `fixed`

FIXED by 3a377f656. .claude/reference/lab-notes/postgres.md:17 now reads "called in context.ts and twice in reads.ts"; rg at head resolves parseReplySegments to exactly src/lib/agents/operator/context.ts:297, reads.ts:97 and reads.ts:213 (plus its definition at schema.ts:229). The "(4)" count also re-resolves: one agent_turns.reply field plus agent_proposals.input/.before/.after through parseJsonbObject at proposals.ts:186,198,199.

ROUND-1 EVIDENCE (retained): The Owner Operator bullet added by this branch says parseReplySegments is "called in context.ts and twice in turns.ts". At HEAD it is called once in src/lib/agents/operator/context.ts:297 and twice in src/lib/agents/operator/reads.ts:97 and :213; src/lib/agents/operator/turns.ts contains no call at all (rg parseReplySegments src worker). The owner reads were split out of turns.ts into reads.ts in commit eb21f55c2 and this line was not re-resolved. Fix: name reads.ts. Everything else in the bullet checks out — the site count of four is right and the entry's arithmetic closes (2+1+2+4+2+3+4+5 = 23, matching its own "Exactly 23 production JSONB field-to-parser sites today").

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. This entry is marked AUTHORITATIVE and its one job is to let a reader find every production JSONB parse site, so pointing at a file that has none while leaving the file that has two unnamed defeats that job. Recorded as P1 rather than P0 because the substantive safety claim — each site guards typeof-string, narrows and throws — is true at the real sites, and the enumeration's count and totals are correct; what is wrong is where to look, which is a stale reference of the same family as a stale line number.

### P2-1 — P2 (duty 4) — The branch adds a fifth private boundedErrorClass copy and picks the unhardened shape, while a hardened shared export already exists

- **At:** `worker/jobs/agent-turn/failed-hook.ts:26-28`
- **Disposition:** `fixed`

FIXED by 3a377f656. The private copy in worker/jobs/agent-turn/failed-hook.ts is deleted and the hardened shared export is imported (failed-hook.ts:8). M5 proved the call site is load-bearing and observed: replacing boundedErrorClass(err) with a constant failed failed-hook.test.ts's 'agent_turn_exhausted:ProviderTimeout' assertion. Sibling sweep at head: three private copies remain (worker/job-failure-sink.ts:59, worker/jobs/judge/failed-hook.ts:39, worker/jobs/csv-ingest/failed-hook.ts:94), all pre-existing unchanged code — job-failure-sink.ts documents its err.name shape as a deliberate divergence — and all outside round-2 scope. INV-273.

ROUND-1 EVIDENCE (retained): Missed sibling case. Pattern searched: "function boundedErrorClass" across worker and src. Scope: the whole worker and src trees, no exclusions. Result: five definitions — the shared export at worker/jobs/solicitation-batch/failed-hook-shared.ts:36 (already imported by worker/jobs/solicitation-send/failed-hook.ts, worker/jobs/solicitation-batch/generate-failed-hook.ts and worker/jobs/solicitation-batch/failed-hook.ts) plus four private copies, the newest being this branch's. The shared one validates the class name against /^[A-Za-z][A-Za-z0-9_$]{0,99}$/ and falls back to UnknownError, with a docblock giving the reason ("so a hostile or exotic error type cannot inject structure into the log line"); this branch's copy takes err.name unvalidated and slices it to 100 characters, then interpolates it into markOutboxFailed's reason string at failed-hook.ts:56-61, i.e. into a stored job_outbox error value and a log field. The same refactor commit that produced this HEAD (15bc4a4aa) deduplicated parseJsonbObject for exactly this shape; fallow's duplication gate does not reach a two-line helper. Fix: import boundedErrorClass from the shared module, or move it somewhere both hooks can share.

**Arbiter reasoning.** Round 2 re-derived this disposition from evidence produced in this pass at head 3a377f6562ce564051b7fd21bd751c9bd9be49ed; the round-1 arbiter reasoning is retained below and was not re-used as proof. P2, recorded and non-blocking, because there is no exploitable path today: the errors that reach this hook come from the LLM seam, Postgres and the cost guard, none of which sets .name from provider or owner text, and the value is a bound parameter rather than interpolated SQL. The finding is the divergence itself — the branch replicated the weaker of two existing siblings (worker/jobs/judge/failed-hook.ts:39) when a hardened shared export with a stated rationale was available.

### P2-2 — P2 (duty 3) — The rewritten go-live alerting bullet miscounts its own terminal paths and misnames the watchdog log line

- **At:** `docs/roadmap/2026-09-11-owner-operator/README.md:638`
- **Disposition:** `open`

Two imprecisions inside the fix hunk, neither of them an operationally false claim. (1) The line opens "The six terminal paths in AgentTurnWorker resolve the turn" and then enumerates seven items, the last of which — "a lease lost before completion" — the same sentence says "resolves NOTHING"; and it never names account_offboarding, which IS one of the six domain terminal reasons (src/lib/agents/operator/schema.ts:55) and is written by the very reauthorization arm the line does name (AgentTurnWorker.ts:166-171), so the same logger.warn covers it. The runbook's parallel sentence counts correctly ("the six domain terminal reasons (operator_disabled through budget_exceeded)" = exactly the six non-exhausted members in declaration order). (2) The line calls the watchdog re-pend "a topic-aggregated log line in runOutboxWatchdogRecovery"; at head that call emits logger.log('Watchdog recovered stale entries', { recovered, failed, stale_dispatching }) (worker/background/pollers/OutboxPoller.ts:160-166), which carries NO topic field at all — the counts are aggregated ACROSS topics, not by topic. The same phrase appears in docs/runbooks/beta-launch-alerting.md:338-340. Suggested replacement: "the six domain terminal reasons (operator_disabled through budget_exceeded) resolve the turn; a lease lost before completion resolves nothing", and "an untyped aggregate count in runOutboxWatchdogRecovery's log line".

**Arbiter reasoning.** P2, not P1: the operationally load-bearing claims of the line all re-resolve true at head (which paths warn, which logs info, that none calls Sentry, that the terminal outbox row alerts and the re-pend does not). A reader acting on the line reaches the right conclusion; only the arithmetic and one adjective are wrong, so this records rather than blocks. Not P0 under duty 3 because no claim is misleading about behaviour — account_offboarding is covered by the arm that is named, it is simply unnamed.

### P2-3 — P2 (duty 5) — The new runbook bullet overstates what one agent-turn-exhausted event implies about the turn

- **At:** `docs/runbooks/beta-launch-alerting.md:330-334`
- **Disposition:** `open`

The new §1 bullet tells the operator "One event means one owner's Operator message ran out of BullMQ retries and the turn ended failure_reason = exhausted through worker/jobs/agent-turn/failed-hook.ts, so the owner never receives a reply". The first clause is exact; the rest is not guaranteed. reportJobFailure fires on the terminal 'failed' event unconditionally (worker/job-failure-sink.ts:66-80), while the hook writes TURN_FAILURE_REASON.EXHAUSTED only when markOutboxFailed confirms this dispatch still OWNS the row (failed-hook.ts:52-71); the superseded branch at :59-63 logs 'agent_turn exhaustion for a superseded dispatch, leaving the turn alone' and returns, and a newer attempt may already have completed the turn. So a paged event can correspond to a turn that is running or already completed, and the owner may well receive a reply. Suggested replacement: "…ran out of BullMQ retries. If that dispatch still owned the outbox row the turn ended failure_reason = exhausted and the owner never receives a reply; if a newer dispatch had superseded it the hook leaves the turn alone, so check agent_turns.status before treating it as a lost reply." All six duty-5 facets themselves match the emitter (see P1-3) — this is the event's MEANING, not a facet.

**Arbiter reasoning.** P2, not P1: duty 5's P1 trigger is a missing half of the alert path or a documented FACET that contradicts the emitted signal, and neither applies — identity, filter, level, grouping, cadence and destination all re-resolve true at head. The overstatement is in the interpretation text, and it errs toward over-investigating rather than under-paging, which is the safe direction for a go-live rule. Recorded so the sentence is corrected before OWNER_OPERATOR_ENABLED is flipped, not blocking the PR.

## Duty 1 — hand-mutation

Environment: `mutation-runner.mjs env --tmp-home <mktemp -d> --test-db <localhost:5499>` plus `dotenv-swap --test-db <same>`; every `run` carried the same `--tmp-home` and `--test-db`, `--timeout 120000`, an argument array (no shell string), and a regex-escaped test title verified by `assert-one-test`. A first launch omitted `--test-db` on `run`, so the live-DB suite skipped (`0 test(s) executed` → INCONCLUSIVE) and one of the 30 runs was spent learning that; it is recorded here rather than hidden. Seven green baselines were then re-derived at head before any mutation.

Five mutations, each applied through `mutate` (journaled original→mutant blob OIDs) and hand-restored with `git restore <named path>` before the next so no two mutants were ever live together. Targets were chosen to be the exact production lines the new oracles claim to guard.

| # | production target | mutation | oracles re-run | outcome |
|---|---|---|---|---|
| M1 | `src/lib/agents/operator/turns.ts:256-259` | delete the whole lease arm `claimed_at IS NULL OR claimed_at < NOW() - (leaseSeconds * INTERVAL '1 second')` | 3 | **killed ×3** |
| M2 | `src/lib/agents/operator/render.ts:231` | negate the gate (drop the leading `!`) | 1 | **killed** |
| M3 | `worker/background/pollers/health-alert/checks.ts:124` | remove `${QUEUE_NAMES.AGENT_TURN}` from the closed allowlist (lands on the pre-fix blob `913698b6a5ff` exactly) | 1 | **killed** |
| M4 | `worker/jobs/agent-turn/AgentTurnWorker.ts:38` | `isBudgetDecision` returns `false` | 1 | **killed** |
| M5 | `worker/jobs/agent-turn/failed-hook.ts:36` | `boundedErrorClass(err)` → the constant `'UnknownError'` | 1 | **killed** |

Seven kills, zero survivors, zero inconclusive. M1 is the literal round-1 mutation `t-m4` that survived the whole agent-turn suite at round-1 head; at this head it now fails three separate tests.

**M5 caveat, recorded honestly.** The prompt scoped this as a call-site probe rather than a test of the shared helper, and that is what it is. It proves `failed-hook.test.ts` observes the call site. It does NOT discriminate the behavioural delta the fix introduced: the deleted private copy read `err.name`, the adopted shared export reads `err.constructor.name` (`failed-hook-shared.ts:36-41`), and the test fixture (`class ProviderTimeout extends Error { override name = 'ProviderTimeout'; }`, `failed-hook.test.ts:86`) makes the two values identical, so no test in the repo separates them. The delta is benign — both shapes are bounded, log-safe strings, nothing parses the `agent_turn_exhausted:<class>` reason, and the shared shape is the stricter of the two — so this is noted, not filed as a finding.

## Duty 2 — fragile assertions in the NEW test code

Four new or strengthened oracles were reviewed. **No fragile-assertion finding.** The judgements, since three of them were raised explicitly:

- **`expect(result.ok === false && result.reasons.join(' ')).toContain(...)`** (`render.test.ts:281-282`) — cannot pass vacuously. If `ok` were `true` the expression collapses to the boolean `false`, and Vitest's `toContain` THROWS on a non-string, non-iterable actual rather than passing. It is also already fenced by `expect(result.ok).toBe(false)` on the preceding line, which is the assertion M2 actually killed. The idiom is a TypeScript narrowing device, not a weakened assertion.
- **The SQL-text case in `turns.test.ts:113-136`** — additive, not merely duplicative. It asserts three things about the statement `claimTurn` builds: the `claimed_at IS NULL` arm, the `INTERVAL '1 second'` unit, and that `leaseSeconds` and `accountId` are BOUND (invariant #9) rather than interpolated. The live case is the behavioural oracle, and the file's own comment says so; the text case earns its place because it is the ONLY oracle for this predicate in the keyless lane, where the live suite does not run at all. Its one weakness is the usual text-proxy weakness: a behaviour-preserving rewrite (say `COALESCE(claimed_at, 'epoch') < …`) would fail it spuriously. Acceptable for a guard labelled as a guard.
- **The `checks.test.ts` regression case** — only its LAST assertion is load-bearing. `sql` is a mock whose return is pushed by the test, so the `expect(findings).toEqual([...])` half passes with `AGENT_TURN` absent from the allowlist; M3 was caught by `expect(values).toContain(QUEUE_NAMES.AGENT_TURN)`. That is a bind-value proxy, which is the strongest oracle available in a mocked-`sql` unit suite and is exactly what the sibling `GENERATE_SOLICITATION_ASKS` case does. Not a finding; the real discriminator is present.
- **The claim-race spend assertions** use DELTAS (`runLlmTask.mock.calls.length - llmCallsBefore`), not absolute totals, so they do not break when an unrelated earlier case in the same file changes its call count. Good shape.

## Duty 3 — changed docs vs reality, re-resolved at head

| claim | verified against | result |
|---|---|---|
| README:638 — five paths `logger.warn`, `operator_disabled` `logger.log`, lease-lost `logger.warn` | `rg "logger\.(log|warn|error)\(" worker/jobs/agent-turn/AgentTurnWorker.ts` → `:122`, `:171`, `:204`, `:229`, `:292` warn; `:324` log; `:370` warn | TRUE |
| README:638 — none of the six calls Sentry | no `Sentry.` / `captureException` in `AgentTurnWorker.ts` | TRUE |
| README:638 — `outbox_failed:agent_turn` rides runbook rule 1 | `checks.ts:127-133` key/level, `emit.ts:10-18` tags `subsystem=health_alert`,`finding=<key>`, runbook `:28-33` | TRUE |
| README:638 — exhaustion reaches Sentry tagged `subsystem:worker_job`,`queue:agent_turn` with its own rule row | `job-failure-sink.ts:75`, `worker/index.ts:574`, runbook `:325-341` + row 11 | TRUE |
| README:638 — the watchdog re-pend is a log line, not a Sentry event | `OutboxPoller.ts:160-166` | TRUE on the Sentry half; "topic-aggregated" is wrong → **P2-2** |
| README:638 — "the six terminal paths … resolve the turn" | `schema.ts:52-60` + the seven enumerated items | arithmetic inconsistent → **P2-2** |
| `postgres.md:17` — `parseReplySegments` called in `context.ts` and twice in `reads.ts` | `context.ts:297`, `reads.ts:97`, `reads.ts:213` | TRUE |
| `postgres.md:17` — the "(4)" field count | `agent_turns.reply` + `proposals.ts:186,198,199` | TRUE |
| runbook `:330-334` — "one event means … the turn ended `failure_reason = exhausted`" | `job-failure-sink.ts:66`, `failed-hook.ts:52-71` (superseded branch at `:59-63`) | overstated → **P2-3** |

`prevalidate-plan.py` was run on both changed review docs. Both residual issues are false positives and were confirmed by hand:

```
docs/superpowers/plans/feat-owner-operator-run-a-deviations.md
  CITATIONS: 15 checked, 1 unresolved  — voice/route.ts:23 "file does not exist at HEAD"
  COMMITS:    6 checked, 1 stale       — 43b0b7ef
  PREVALIDATE: 2 ISSUES
docs/reviews/feat-owner-operator-run-a/review-round-3.md
  CITATIONS:  2 checked, 0 unresolved
  COMMITS:    2 checked, 1 stale       — 42bc6db1
  PREVALIDATE: 1 ISSUES
```

- `voice/route.ts:23` — the script resolved the bare shorthand as a repo-root path. `src/app/api/settings/voice/route.ts` exists at head. The hit is at `deviations.md:701`, inside prose that is itself RECORDING that those two citations were replaced by a symbol name; it is a description of the old citation, not a live one.
- `43b0b7ef` is the intake SHA-256 prefix (`deviations.md:824`), not a commit — the same class as the handoff's `f4e02270` Railway deploy id.
- `42bc6db1` is the round-1 gate FINGERPRINT (`review-round-3.md:5`), not a commit. It is correctly scoped to that line's pinned head `5b223e33f…`; the fingerprint at THIS head is `2c065cb8…` (`.feature/codex-gate-fingerprint.json`), regenerated after the fix commit, so the doc's historical value is right and must not be "corrected".

## Duty 4 — missed sibling cases

Two patterns, both searched at head, both exclusions recorded:

1. **Private `boundedErrorClass` copies** (P2-1's shape). `rg -n "function boundedErrorClass" src/ worker/` → one shared export (`worker/jobs/solicitation-batch/failed-hook-shared.ts:36`) and THREE private copies (`worker/job-failure-sink.ts:59`, `worker/jobs/judge/failed-hook.ts:39`, `worker/jobs/csv-ingest/failed-hook.ts:94`). All three are unchanged code that predates this branch, and `job-failure-sink.ts:54-58` documents its `err.name` shape as a DELIBERATE divergence. Round-2 scope forbids a front against unchanged code, so: zero in-scope siblings, three out-of-scope instances recorded for the record.
2. **Owner-impacting `job_outbox` topics missing from the closed allowlist** (P1-2's shape, the #628 class). Scope deliberately bounded to topics THIS BRANCH introduces, since the allowlist as a whole is unchanged code. `git diff <merge-base> <head> -- src/lib/shared/queue-names.ts` adds exactly one member, `AGENT_TURN: 'agent_turn'`, and the fix adds exactly that one to `checks.ts`. **Zero siblings** — a sound search with nothing to report. Whether any of the 30 pre-existing topics outside the seven-member allowlist deserves a row is a real question and an explicit NON-finding here: it is unchanged code, and inventing it would widen round 2's scope.

## Duty 5 — operational completeness of the `agent_turn` alert path

Both halves now exist statically, and the comparison is static as the protocol requires — no staging delivery drill was attempted or implied.

**Half A — the outbox-row signal ↔ runbook rule 1.** `checks.ts:117-133` emits `key = outbox_failed:agent_turn`, `level = error` once `count > failedThreshold` (default `0`, `checks.ts:78`) inside `failedWindowS` (default 3600). `emit.ts:10-18` raises `Sentry.captureMessage` with `tags.subsystem = health_alert` and `tags.finding = <key>`. Runbook §1 (`:28-33`) routes `subsystem:health_alert` at `error` to Discord. Closed.

**Half B — the BullMQ exhaustion signal ↔ the new §1 bullet + click-path row 11.** Facet by facet against the emitter:

| facet | documented | emitted | match |
|---|---|---|---|
| signal identity | `captureException` in `reportJobFailure`, `worker/job-failure-sink.ts` | `job-failure-sink.ts:70` | ✓ |
| filter | `subsystem` = `worker_job` **AND** `queue` = `agent_turn` (tags) | `tags: { subsystem: 'worker_job', queue: queueName, topic: job.name }` `:75`; `attachJobFailureSink(worker, queueName)` over every worker `worker/index.ts:574`, `QUEUE_NAMES.AGENT_TURN` registered `:529`, literal `agent_turn` `queue-names.ts:68` | ✓ |
| level | `error` (the `captureException` default) | no `level` override on the call | ✓ |
| grouping | Sentry's exception fingerprint | no custom fingerprint set | ✓ |
| threshold / cadence | **every event** (both the bullet and row 11) | terminal-attempt gate only (`isFailedEventTerminal`, `:66`) — not a first-seen rule | ✓ |
| destination | Discord channel via the Sentry integration, row 11 named `agent-turn-exhausted → discord` | n/a (Sentry-side) — row 11 is flagged `NOT CONFIGURED BY THIS CHANGE` | ✓, with the build still owed |

No facet contradicts the emitter, so no duty-5 P1. The one defect found here is the bullet's INTERPRETATION of an event, filed as **P2-3**.

## Inventory

274 candidates. Rows carried from round 1 keep their round-1 outcome unless a fix
changed what they measure; four rows were re-executed at the round-2 head, three new rows cover that
fix's other new oracles, 237 unexecuted rows were re-labelled `excluded` under the owner's scope
decision, and round 3 added two `excluded` rows for its two doc hunks.

| outcome | n |
|---|---|
| `killed` | 32 |
| `survived-confirmed-P0` | 0 |
| `equivalent` | 0 |
| `inconclusive` | 0 |
| `skipped-budget` | 0 |
| `excluded` | 242 (5 by protocol rule — migrations, docs, Playwright, plus round 3's two doc hunks; 237 by the round-2 scope rule) |

Rows re-executed or added in round 2:

| id | outcome | test |
|---|---|---|
| `INV-023` | `killed` | worker claim race: two dispatches of one turn produce one completed turn and one proposal set |
| `INV-028` | `killed` | validator rejects a catalog operation the snapshot does not allow this account to use |
| `INV-029` | `killed` | worker fails the turn budget_exceeded terminally instead of burning the retry ladder |
| `INV-263` | `killed` | on exhaustion runs the outbox CAS FIRST and only then fails the turn, in one transaction |
| `INV-270` | `killed` | claimTurn turns a second dispatch away inside the lease and lets one in after it expires |
| `INV-271` | `killed` | claimTurn binds the lease predicate that makes the Turn claim exclusive |
| `INV-272` | `killed` | health alerts include terminal agent_turn outbox failures |

Rows added in round 3 (both `excluded` — documentation carries no executable behaviour, the same
protocol rule as `INV-268`; verified under duties 3 and 5 instead):

| id | outcome | file |
|---|---|---|
| `INV-274` | `excluded` | `docs/roadmap/2026-09-11-owner-operator/README.md:638` |
| `INV-275` | `excluded` | `docs/runbooks/beta-launch-alerting.md:325-348` |

Round 1's 25 carried-forward `killed` rows were NOT re-executed. Their validity rests on a property,
not on trust: each targets a production line and a test body that neither fix commit touches, and
round 3's diff contains no production change at all. The full per-row evidence stays in
`findings.json`.

## Authorizations

Rendered from `findings.json`'s `authorizations` array, which is the authoritative copy.

**`auth-round-3-docs-2026-09-12`** — 2026-09-12 — findings `P2-2`, `P2-3`

> Owner (Norbert) selected "Fix now, third round" via AskUserQuestion on 2026-09-12 after round 2 closed with P2-2 and P2-3 open (wording defects in the two doc hunks the round-1 fix commit 3a377f656 introduced). A third round is authorized, scoped to those two doc hunks — docs/roadmap/2026-09-11-owner-operator/README.md line 638 and the agent_turn bullet in docs/runbooks/beta-launch-alerting.md §1 — after the orchestrator's fix commit.

This authorization granted a third ROUND and has now been CONSUMED — `round-start` validated it
against the committed round-2 sidecar and opened round 3, which verified both findings `fixed`. It
accepted no risk: neither P2-2 nor P2-3 ever carried an `authorization` field. No authorization
covers P2-4, and none is needed — an open P2 does not block, and the checker requires authorization
only for an open P1 on a high-risk run. A FOURTH round cannot be opened under any authorization.

## Restoration

**Round 3 mutated nothing** — zero runs, zero `mutate` calls, so there is nothing to restore. The
journal for round 3 carries no mutation entries, and `git status --porcelain --untracked-files=no`
shows only this run's two report artifacts against HEAD
`7583062a4ea206702bab339930a315fdd6875496`. `finalize` is deliberately NOT run here; the
orchestrator owns it.

Round 2's five mutations were hand-restored during that round and then confirmed by the
orchestrator's `finalize`: all five entries read `restored`, the dotenv swap is closed and
`.env.local.red-team-backup` is gone.
