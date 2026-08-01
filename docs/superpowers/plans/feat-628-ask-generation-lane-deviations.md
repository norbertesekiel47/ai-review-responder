# Deviations — feat-628-ask-generation-lane

Entries are appended by implementation subagents when reality diverges from the
plan; each gets an ACCEPT / RE-PLAN verdict at step 6.5.

## Pre-implementation coordination notes

- [2026-07-30] **Surface overlap with `feat-625-consent-ledger`** on
  `src/lib/solicitation/**`; the one real collision file is
  `src/lib/solicitation/batch-builder.ts` (#625 rewrites the consent read in
  the candidate query; #628 adds the generation enqueue to the `built_at`
  transaction). **Agreed merge order (owner-approved): #625 merges first;
  #628 rebases over it before its gate/review rounds.** Same note recorded in
  feat-625's deviations file.
- [2026-07-30] **Postal-address column dependency (locked at grilling):**
  renders bake `businesses.solicitation_postal_address` (#622 D7), but the
  column ships with #627 (unlanded; head = 092). #628 lands **inert**: footer
  assembly takes `postalAddress` as an explicit parameter; the loader SQL
  references the column but is unreachable while `SOLICITATION_SEND_ENABLED`
  is off/nonexistent. Full-path staging proof deferred to the #633 runbook
  campaign. Latent dependency: the loader query crashes if executed before
  #627's migration — do not flip the flag anywhere before #627 lands.
- [2026-07-30] **Adversarial round-1 spec gaps resolved in the plan** (codex session
  019fb5dc, VERDICT: REVISE → plan decisions 4–10): (a) never-moderated withheld rows
  (`lint_failed`, budget-refused) fill `moderation_status='error'` — 091 has no
  "not run" member and this ticket ships no migration; **candidate vocabulary widening
  for a later migration ticket**: a `skipped` moderation status and a `budget_exceeded`
  disposition reason would make these rows self-describing. (b) SPEC §1.1's bucket table
  starts at 1 day — same-day visits render bucket `today` (spec delta). (c) SPEC §7.4's
  "live render" idempotency wording is superseded by the stricter any-non-cancelled-row
  check — live-only would re-generate terminal withheld children on job retry.
- [2026-07-30] **Spec §10 offboarding obligation void:** the "adds the
  offboarding table-disposition entry" binding targeted the superseded
  `solicitation_ask_messages` table (B1); `solicitation_outreach` disposition
  is #624's and already shipped. Nothing to do in #628.
- [2026-07-30] **Task 1 (spec §4.4 prerequisite): Anthropic temperature
  forwarding changes the FALLBACK behavior of existing tasks.**
  `anthropic-provider.ts` now forwards `request.temperature` (key omitted when
  undefined, preserving the SDK default), so the Anthropic fallback path of
  `reply_generation` now runs at 0.7 and `insights` at 0.5 instead of the SDK
  default. The change rides deliberately with a pinning regression test
  (`changes reply_generation and insights anthropic fallback temperature
  knowingly` in `src/lib/llm/__tests__/anthropic-provider.test.ts`). Minor
  scope addition beyond the planned file list: the now-stale "NOT forwarded by
  anthropic today" doc comment on `LLMTaskDescriptor.temperature` in
  `src/lib/llm/types.ts` was updated in the same change (stale cross-references
  are bugs per repo rules).
  Spec-review addendum: the same forwarding also moves the Anthropic fallback
  of `triage` and `judge` (registry temperature 0) from the SDK default to 0 —
  beneficial (deterministic classification on fallback) but part of the blast
  radius the spec's §9 wording understated.
- [2026-07-30] **Task 5: `AskLintInput` gains a required fourth field
  `subjectDisallowedValues` beyond the plan's pinned three-field shape.** The
  plan defines the B5 subject-PII check as "any interpolated value other than
  `contact_first_name`/`business_name` appearing in subject", but the pinned
  flat `interpolationValues: readonly string[]` carries no labels, so that
  half of the check is unimplementable as pinned — and a literal "everything
  but first/business name" reading would make the bucket phrase (`last week`)
  and vertical block ordinary subjects, which are closed vocabularies and not
  PII. Resolution: the caller passes the PII-capable subset (today: the
  admitted visit note) as `subjectDisallowedValues`; the field is REQUIRED so
  Task 8's call site must decide explicitly (fail-closed by construction).
  Email and separator-stripped digit-run(≥7) patterns cover the pattern half.
- [2026-07-30] **Task 5: class 6 (provenance) excludes the assembled footer
  region; footer byte facts exported from `ask-render.ts`.** SPEC §2.4 says
  "over subject + body", but the assembled body bakes the owner-attested
  postal address, whose digit runs (`123`, `78701`) and capitalized
  street/city tokens are not §1.1 interpolation values — a literal scope
  would block EVERY render, making the class unsatisfiable rather than
  conservative. The lint therefore checks subject + the model-authored body
  above the LAST occurrence of the assembly-produced footer anchor
  (`\n\n---\n\nSent by RepWorth on behalf of `); lastIndexOf means a model
  emitting the anchor itself only moves more of its own text INTO the checked
  region. To keep one owner of the footer bytes, `ask-render.ts` (Task 4's
  file) additionally exports `FOOTER_SEPARATOR`,
  `SENDER_IDENTIFICATION_PREFIX`, and `UNSUBSCRIBE_LINE_PREFIX`, now used by
  its own `assembleAskBody` and by lint classes 6/7 (byte contract unchanged —
  the exact-bytes test in ask-render.test.ts is untouched and green). Related:
  §2.4's "closed scaffolding allowlist" names categories (greetings,
  weekday/month words, fixed template scaffolding) without enumerating
  tokens; the enumeration now lives in the golden-filed
  `PROVENANCE_ALLOWLIST` (includes `RepWorth`, belt-and-braces on top of the
  footer exclusion). One deliberate pattern tune recorded in the golden file:
  class 1's `free <noun>` carries `(?!to\b)` so the near-universal polite
  idiom "feel free to …" does not block every render; "free coffee" still
  blocks.
- [2026-07-30] **Task 5 closes the Task 4 placeholder-uniqueness
  carry-forward:** class 7 asserts each placeholder appears EXACTLY once — a
  duplicated `{{unsubscribe_url}}`/`{{review_link}}` (e.g. emitted by the LLM
  body itself) is now a `missing_required_element` block. SPEC §2.3 row 7's
  "lacks" wording does not contradict exactly-once (the table is
  "illustrative, not exhaustive — the implementing table is the contract"),
  so no NEEDS_CONTEXT was required. Class 7 also asserts the postal-address
  block structurally: ≥1 non-blank line strictly between the identification
  line and the unsubscribe line of the assembled footer.
- [2026-07-30] **Task 5 spec-review observation (no code change): classes 1–4
  still scan the FOOTER region.** The §2.5 exemption covers only interpolated
  values, so a postal address containing an incentive-looking token (e.g.
  "10 Points Blvd") terminally blocks every render for that business via
  class 1. Spec-literal today (classes 1–4 run over `subject + '\n' + body`,
  footer included); candidate future tune is adding the footer/postal region
  to the class 1–4 exemption in an `ASK_LINT_VERSION` bump.
- [2026-07-30] **Task 5 finding — an effectively-empty (whitespace-only) LLM
  body passes the lint.** Verified: `assembleAskBody('   ', …)` yields a
  render with both placeholders and the address block, and no SPEC §2.3 class
  owns body-emptiness (class 5's non-empty bound is subject-only per B5).
  Per instruction, NO rule was invented. Exposure: zod `body.min(1)` blocks
  the empty case; a whitespace-only body would render as a footer-only ask
  that the owner sees (generate-then-approve) and would regenerate/exclude.
  Candidate fix for a later `ASK_LINT_VERSION` bump with map-owner sign-off:
  add "non-blank model-authored body" to class 7.
- [2026-07-30] **Task 4 spec-review carry-forward: placeholder uniqueness is
  unowned.** If the LLM body itself emitted `{{unsubscribe_url}}` /
  `{{review_link}}`, assembly would yield two occurrences: lint class 7 checks
  presence only, provenance (class 6) ignores lowercase tokens, and AMEND B4
  does not specify duplicate-substitution behavior for #630. Task 5 SHOULD
  close this cheaply by making class 7 assert exactly-once (a duplicated
  placeholder becomes a lint_failed render); otherwise it falls to #630's
  substitution contract.
- [2026-07-30] **Task 6: the "verbatim" untrusted-data line swaps its referent
  from "the review text" to "the visit note".** A byte-for-byte copy of
  prompt-policy.ts's line would tell the model to distrust "the review text",
  a field that does not exist in the ask prompt — the ask's only untrusted
  surface is the visit note. SPEC §1.3's own quotation elides exactly that
  middle span ("contained inside … as untrusted"), so the surrounding phrasing
  is carried verbatim and only the referent changes. Pinned structurally, not
  by copy: the test derives the expected line FROM `SYSTEM_PROMPT_BASE` at run
  time (referent substitution only), so a reply-side rewording of that line
  fails the ask suite instead of drifting silently. Also per §1.3, the ask
  base is the ENTIRE system prompt (no dynamic append like the reply lane), so
  it additionally carries task framing + the JSON-envelope instruction
  (triage.ts precedent) on top of the six policy lines.
- [2026-07-30] **Task 6 quality-review follow-up deferred (out of edit
  surface):** a reciprocal marker comment on the untrusted-data line in
  `src/lib/responses/prompt-policy.ts` (noting it is pinned by
  `ask-prompt-policy.test.ts`'s referent-swap derivation) would localize the
  far-from-cause failure a reply-side rewording produces — but that file is
  outside this ticket's allowed_edit_surface. Carry as a one-line follow-up
  for the next ticket that touches `src/lib/responses/`. The in-surface half
  (a backtick-fence admissibility test tying the prompt module's fence
  guarantee to enforced lint behavior) landed with Task 6.
- [2026-07-30] **Task 7 mandated finding — `closeBatchIfSettled` ALREADY
  produces D14's `generation_failed`; no extension was needed.** Its
  `deriveDisposition` maps `input.failure.code === 'generation_failed'` →
  disposition `generation_failed` → parent `failed` via
  `failSolicitationBatchRun` (which also writes the error jsonb with
  `failed_count`/`withheld_count`), and the pre-existing #624 integration test
  `closeBatchIfSettled maps the generation_failed disposition to a failed
  parent run` proves it end-to-end. The disposition is deliberately NOT
  derivable from the outreach tallies (`exhausted` and `generation_failed` can
  produce identical counts), so the obligation transfers to Task 8: the finale
  must pass `failure: { code: 'generation_failed', failedCount, withheldCount }`
  to its single `closeBatchIfSettled` call when every render failed or was
  withheld (k=0), and must NOT call `failSolicitationBatchRun` for the send
  parent itself (the batch→run lock-order contract on
  `CloseBatchIfSettledInput.failure`).
- [2026-07-30] **Task 9 plan gap — `worker/queues.ts` needs the
  `generate_solicitation_asks` Queue + `topicToQueue` entry, but the file is
  outside `allowed_edit_surface` and the edit-surface hook blocked the edit.**
  Adding `GENERATE_SOLICITATION_ASKS` to `QUEUE_NAMES` (a mandatory Task 9
  step) makes `worker/__tests__/queue-routing.test.ts`'s completeness guard
  fail: `topicToQueue is missing 'generate_solicitation_asks'`. Neither
  Task 9 nor Task 10 lists `worker/queues.ts` in its file list, and the
  intake surface omits it entirely — Task 10's `worker/index.ts` Worker
  registration cannot discharge it either, so this needs a surface amendment
  (user sign-off) before the final gate. **Known-red test at the Task 9
  commit:** exactly that one completeness assertion; every Task 9 gate passes
  (batch-builder unit+integration, job-outbox-helpers, `ci:outbox-seam`,
  `ci:outbox-topics`, `ci:outbox-status`, typecheck, eslint). The fix is two
  mechanical lines: in `worker/queues.ts` add
  `generateSolicitationAsks: new Queue(QUEUE_NAMES.GENERATE_SOLICITATION_ASKS,
  { connection: opts, defaultJobOptions: llmJobOptions })` to `queues`
  (LLM-bound lane ⇒ `llmJobOptions`, the `generateResponse` precedent — the
  ask lane's retries are spend-safe via the cost reservation + live-render
  skip) and `[QUEUE_NAMES.GENERATE_SOLICITATION_ASKS]:
  queues.generateSolicitationAsks` to `topicToQueue`.
- [2026-07-30] **Task 9 test addition beyond the plan's named titles
  (in-surface):** `batch-builder.integration.test.ts` gained `flag-on build
  with send asks enqueues one generation row and the real 091 index dedups a
  second enqueue` — the only execution-level proof of the byte-for-byte
  ON CONFLICT contract, since Postgres performs partial-unique-index inference
  at plan time (a drifted spelling throws 42P10 or double-inserts; the test
  asserts the second enqueue returns `null` instead). The suite's `afterEach`
  also now clears `SOLICITATION_SEND_ENABLED` and deletes generation outbox
  rows batch-scoped (their payload carries no `business_id`).
- [2026-07-30] **Task 7: `recordGenerationSteps` step ids are
  `gen_random_uuid()`, not UUIDv7.** The plan mandates ONE set-based
  `INSERT … SELECT` and Postgres 16 has no `uuidv7()`, so per-row v7 ids cannot
  be generated inside the statement. Migration 046's comment blesses
  `gen_random_uuid()` as the database fallback, and step ORDER is owned by
  `step_index`, never by id — nothing reads step ids time-ordered. Also
  recorded: the plan named no step key for the bulk generation steps; Task 7
  chose `ask_generated` (STEP_PERSONA → `solicitation`), sibling to the build
  lane's `ask_evaluated`, covering both rendered and withheld rows ("the
  generation attempt produced a row").
- [2026-07-30] **INTAKE AMENDMENT (controller-applied, pending owner
  retroactive sign-off): `worker/queues.ts` added to allowed_edit_surface**
  (both copies, kept in sync). Rationale: a registered outbox topic without a
  Queue + `topicToQueue` entry is a broken lane — `queue-routing.test.ts`'s
  completeness guard proves it red — and Task 10 (in-plan) registers a Worker
  on `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS`, which presupposes the Queue.
  The omission was an intake oversight, not a scope boundary. The two
  mechanical lines recorded in the previous entry were applied with the
  amendment; `llmJobOptions` per the generateResponse precedent.
- [2026-07-31] **Task 8: `OutboxHandle` lives in `ask-generation.ts`, not
  `src/lib/solicitation/outbox.ts`.** The plan's named home does not exist —
  the primitives (`markOutboxCompletedIfOwned`, `extractOutboxHandle`) live in
  `src/lib/shared/outbox.ts`, which is OUTSIDE allowed_edit_surface (the
  edit-surface hook blocked adding the type there). `ask-generation.ts`
  declares and exports `OutboxHandle` structurally identical to
  `extractOutboxHandle`'s return; if a later ticket touches shared/outbox.ts,
  move the type to its natural owner and re-export.
- [2026-07-31] **Task 8 interface deviation: `business_id` added to
  `GenerateSolicitationAsksPayload` / `enqueueGenerateSolicitationAsks` /
  both module inputs.** The plan's pinned `{ batchId, outboxHandle }` input is
  unimplementable under `ci:tenant-scope`: the audit requires a BOUND tenant
  value in the batch-context query, and a bare batch UUID carries no tenant
  proof (invariant #8). `BuildSolicitationBatchPayload` is the precedent.
  Task 9's helper, build-tx call site, and test assertions updated in the same
  change; the 091 in-flight dedup index is unaffected (keys on aggregate_id).
  #629's regen route must pass `businessId` when it enqueues.
- [2026-07-31] **Task 8 fixed a PRE-EXISTING red `ci:tenant-scope` from
  Task 7:** `recordGenerationSteps`' `WITH base AS (SELECT … FROM
  agent_run_steps …)` was unscopable (the table has no tenant columns; the
  audit strips subquery bodies; the allowlist file is out of surface).
  Refactored: base index now comes from a shared private `nextStepIndex(tx,
  { runId })` whose query text byte-matches the EXISTING run-spine allowlist
  entry, and `appendRunStep` uses the same helper (one owner of that query).
  Lock-then-read semantics unchanged; run-spine unit + live-DB suites green.
- [2026-07-31] **Task 8 postal-address inert-landing upgrade:** the context
  loader reads `to_jsonb(b) ->> 'solicitation_postal_address'` instead of the
  raw column, so pre-#627 execution reads NULL (fail-closed: withheld
  `lint_failed`/`missing_required_element`) instead of raising 42703. This
  retires the earlier "loader crashes if executed before #627" latent
  dependency AND is what makes the mandated live-DB integration test runnable
  at head 092 (it asserts the fail-closed postal path against the real 091
  constraints). Replace with a direct column read once #627 lands.
- [2026-07-31] **Task 8 additions beyond the plan's literal regen pre-check
  list (all fail-closed):** (a) `solicitationSendEnabled()` +
  `subscriptionGrantsFullAccess` gates on the regen door (invariant #11
  symmetry with the batch door); (b) `RegenBudgetExceededError` and
  `CostLimitExceededError`/`GlobalCostLimitExceededError` during regen are
  REFUSALS (outbox completed, prior render kept live) — terminal errors must
  not strand the dispatched row or burn retries; (c) the regen step reuses
  step key `ask_generated` with `regenerated: true` in detail (no
  `STEP_PERSONA` widening needed); (d) the batch door's parent-run tx is
  gated on `lockDispatchedOutboxAttemptIfOwned` (prepareBatch precedent) so a
  stale replay whose finale already terminalized the parent cannot mint a
  second forever-running send parent; (e) the flag gate runs BEFORE the
  context load (the plan listed load first) so the lane stays no-op-safe
  while the flag is off. The finale derives k=0 from the DATABASE (zero rows
  in rendered/queued/sending/sent), not in-memory tallies, so a resumed retry
  decides correctly; `failedCount` = `render_failed` rows, `withheldCount` =
  `lint_failed` + `moderation_high` rows (D14's two-count story).
- [2026-07-31] **Task 8 whitespace-body guard (as instructed):** effectively
  empty structured output (`body.trim() === ''`) is treated as
  LLMStructuredOutputError-equivalent — withheld `render_failed` with the
  locked decision-2 fills — closing the Task 5 known gap at the orchestration
  layer.
- [2026-07-31] **Task 8 self-review addition beyond the plan's pinned swap-tx
  contents: the regen swap calls `closeBatchIfSettled` after the insert.** A
  withheld replacement TERMINALIZES the ask, and outreach.ts's single-join
  contract (D11) binds every terminalizing writer to join in the SAME
  transaction — without it, regenerating the batch's last live render into a
  block would strand the batch un-settled until the 7-day expiry. A rendered
  replacement no-ops (`not_settled`). No `failure` is passed: such a batch
  settles `exhausted` (renders existed and were approvable), not
  `generation_failed`.
- [2026-07-31] **Task 10: `GENERATE_SOLICITATION_ASKS` registers in
  `assertSummedLlmWorkerSlots` as `flagGated: true`, not as a sum
  contribution.** The plan said "the sum contribution is its BullMQ
  concurrency of 1", but the non-flag-gated sum already sits AT the cap
  (GENERATE_RESPONSE=5 + GENERATE_DEMO/WEEKLY_SUMMARY/SEND_MONTHLY_IMPACT/
  ONBOARDING_DEMO_RESPONSE=1 each = 9 = SUMMED_LLM_WORKER_SLOT_CAP), so a
  non-gated entry fails every boot. The lane is genuinely flag-gated —
  `SOLICITATION_SEND_ENABLED` gates both the enqueue seam and the domain
  module (flag off ⇒ no-op success, zero LLM calls) — which is exactly the
  judge_verdict posture the assert's flag-gated arm exists for; concurrency 1
  satisfies `FLAG_GATED_LLM_WORKER_SLOT_CAP`. startup-assert.ts doc comment
  updated to name both flag-gated queues.
- [2026-07-31] **Task 10: `generate-failed-hook.ts` marks the outbox attempt
  failed but deliberately does NOT terminalize the send parent** (the build
  failed-hook's coupled transition is not mirrored). Three reasons: the
  batch→run single-join contract makes `closeBatchIfSettled` the sole owner
  of send-parent terminal transitions; only the domain finale can know
  whether the batch settled; and on the regeneration path the parent is
  healthy (the prior render stays live), so failing it would corrupt a
  working batch. An operator re-drive of the failed row resumes idempotently
  (§7.4 any-non-cancelled-row skip). Matches the plan's literal "Sentry +
  outbox failure marking" scope; Sentry arrives via the shared
  `workersByQueue` failed-breadcrumb loop.
- [2026-07-31] **Task 10: handler-level regen-budget classification is a
  no-op by construction** — Task 8's landed `regenerateAsk` catches
  `RegenBudgetExceededError` internally and refuses (outbox completed,
  terminal), so it never reaches the handler. The INTAKE test `enforces the
  three-per-day ask regeneration budget in the worker` therefore drives the
  REAL `regenerateAsk` through the handler (vi.mock `spy: true` passthrough)
  with only `checkAskRegenBudget`/LLM/outbox-CAS mocked, proving: handler
  resolves (no BullMQ retry), zero LLM calls, outbox attempt completed. The
  second INTAKE title landed in `ask-generation.integration.test.ts` (live
  DB): all-withheld batch ⇒ parent `failed` with `generation_failed` error
  jsonb + `send_batch_closed` receipt; the suite's shared `afterEach` now
  also resets `solicitation_batches.send_closed_at` for test independence.
- [2026-07-31] **Task 10 spec-review advisory (carried to Task 12):** the
  flag-gated arm of `assertSummedLlmWorkerSlots` has per-entry caps but no
  AGGREGATE bound, so the all-flags-on worst case is now 9+1+1 = 11 in-flight
  LLM calls — brushing ADR 0005's "~10 requires the global Redis semaphore"
  trigger, and each future flag-gated lane silently widens it by 1. Task 12
  should add an aggregate worst-case bound (non-gated sum + flag-gated count
  ≤ 11, documented as the ADR 0005 flag-on envelope) in
  `worker/config/startup-assert.ts` (in surface) so a third gated lane forces
  the semaphore conversation.
- [2026-07-31] **Task 10 quality-review follow-up (out of scope here):**
  `isExhausted`/`boundedErrorClass`/`logFailureSafely` now exist as a third
  verbatim copy across colocated failed hooks (solicitation-batch, csv-ingest,
  judge, + generate). Mechanical helpers, not per-worker knowledge — candidate
  for one shared owner in a future ticket that may touch all hook files
  (cross-worker surface, outside this intake). Also noted: when #627 lands the
  postal-address column, the all-withheld integration case (which relies on
  head-092 column absence) needs an explicit fixture knob instead.
- [2026-07-31] **Task 11: extending `BatchView`'s `built` arm with a required
  `attempts: AskAttemptView[]` breaks two out-of-surface UI-test fixtures.**
  `src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx`
  (`builtView()`, `satisfies BatchView`) and
  `.../batch-report.test.tsx` (`builtBatch()`) construct `built` views and are
  outside `allowed_edit_surface`; the edit-surface hook blocked the fix.
  **Known-red at the Task 11 commit: `pnpm typecheck` fails with exactly 6
  errors confined to those two files.** Both suites still PASS at runtime
  (37/37 — vitest transforms without typechecking), and every in-surface gate
  is green. The fix is one mechanical line per fixture: add `attempts: []`
  before `...overrides`. Needs a surface amendment naming the two exact file
  paths (owner sign-off — the Task 9 `worker/queues.ts` precedent) before the
  Task 12 final gate. `attempts` is deliberately REQUIRED, not optional:
  `readLatestBatch` always returns it, and an optional field would force every
  consumer (#629's approval screen) to handle an `undefined` that cannot occur.
- [2026-07-31] **INTAKE AMENDMENT 2 (controller-applied, pending owner
  retroactive sign-off): the two requests-UI test fixture files added to
  allowed_edit_surface** (`requests-client.test.tsx`, `batch-report.test.tsx`;
  both copies in sync). Task 11's `BatchView.built` gained the required
  `attempts` field — deliberately required, not optional, so #629 never
  handles an impossible `undefined` — which compile-breaks the two fixture
  builders. Fix is one mechanical `attempts: []` line per builder, applied
  with the amendment.
- [2026-07-31] **INTAKE AMENDMENT 3 (controller-applied, pending owner
  retroactive sign-off): `worker/config/__tests__/startup-assertion.test.ts`
  added to allowed_edit_surface.** The surface declared
  `worker/config/startup-assert.ts` but not its colocated test; the Task 10
  spec-review advisory carried to Task 12 explicitly requires extending BOTH
  (the flag-on envelope bound needs a regression test around the protected
  contract). Same mechanical-narrowness class as amendment 2.
- [2026-07-31] **Task 12: the CLAUDE.md JSONB allowlist entry names
  `batch-view.ts` as the parsers' only consumer, not `ask-generation.ts`.**
  The task brief said the three `parseOutreach*` parsers are consumed by both;
  the code disagrees — `ask-generation.ts` re-ASSEMBLES interpolation inputs
  from batch context on every path (regen included) and never re-reads the
  JSONB columns, so the sole production consumer is the Requests read model in
  `src/lib/solicitation/batch-view.ts`. The codebase wins.
- [2026-07-31] **INTAKE AMENDMENT 4 (controller-applied, pending owner
  retroactive sign-off): four gate-guard/assertion test files added to
  allowed_edit_surface, and the prose `verification_commands` entry replaced
  with a runnable `pnpm vitest run …` over the five changed integration
  suites.** The files: `src/__tests__/cost-guard-contract.test.ts` and
  `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` — tripwire
  guards DESIGNED to force a new caller to declare itself, so when the branch
  introduces a new `runLlmTask` caller / spine writer
  (`src/lib/solicitation/ask-generation.ts`, Task 10) the guards' allowlists
  are inherently part of the intake's surface; ask-generation entered
  `NON_REVIEW_SUBJECT_CALLERS` with a written justification (batch → run
  single order per its file header, reviews never touched) and the carve-out
  pin test now lists all three members. Plus
  `src/lib/responses/__tests__/generator.test.ts` and
  `src/lib/responses/__tests__/review-summary.test.ts` — Task 3 arity
  fallout: `reserveCost`/`releaseCost`/`finalizeCost` gained the trailing
  task-scoped `estimateCents` param, so `toHaveBeenCalledWith` assertions
  carry the explicit trailing `undefined` (the `cost-guard.test.ts`
  precedent, documenting "omitted ⇒ 15¢ default").
- [2026-07-31] **Codex adversarial review round 1: needs-attention (3
  findings).** (1) high — subject lint whole-substring match misses partial
  visit-note PII fragments (lint class 5/PII, ask-compliance-lint.ts:450-454);
  (2) high — generate-failed-hook terminalizes transient exhaustion, killing
  watchdog recovery (generate-failed-hook.ts:55-81); (3) medium — regen budget
  charged per processor invocation, BullMQ retries of one logical regen burn
  the 3/day allowance (ask-generation.ts:1111-1118). Full text + fix guidance
  in the handoff doc; fixes to be re-submitted to codex thread
  019fb9be-13ac-7352-b506-81f0bc2d3699.
- [2026-07-31] **Codex round-1 fix (finding 1): subject lint fragment-level
  detection.** `deceptiveSubject` now blocks on ANY content token of a
  disallowed value (tokenized with the class-6 `TOKEN_PATTERN`, possessive +
  plural folded), not only the whole value as one substring. Exemptions:
  the new golden-filed `SUBJECT_NOTE_TOKEN_ALLOWLIST` (function words +
  ask-copy scaffolding like "visit"/"week") and tokens that also appear in a
  subject-SAFE interpolation value (the §2.5 admitted-via-a-safe-channel
  logic — a first name inside the note stays subject-legal). The whole-value
  check is retained for values made entirely of allowlisted tokens.
  `ASK_LINT_VERSION` bumped to `ask_lint_2026-07-31.1`; golden file rides the
  change; 6 regression cases added (partial medical fragment, single
  distinctive token, plural echo, identity fragment, function-word-only
  overlap passes, safe-channel token passes).
- [2026-07-31] **Codex round-1 fix (finding 2): retryable exhaustion stays
  watchdog-eligible.** `generate-failed-hook` now classifies before
  terminalizing: `TransientLLMError` / `CostInfraUnavailableError` (exactly
  the two classes the domain rethrows for retry, §7.5) leave the outbox row
  `dispatched` — the watchdog re-pends it, bounded by `max_attempts`, and
  §7.4 idempotency makes the re-drive resume past persisted renders;
  `recordOutboxTransientError` stamps `last_error` for observability. All
  other classes keep the terminal CAS. DELIBERATELY lane-local (strict
  allowlist, crash-net precedent): the build sibling's failures are DB-shaped
  (no LLM call) and its coupled transition terminalizes the parent; the
  publisher hook already classifies via `ZernioTransientError`. The
  csv-ingest and judge hooks are OUT of this intake's surface — auditing them
  for the same shape is a follow-up ticket, not a silent surface widening.
- [2026-07-31] **Codex round-1 fix (finding 3): regen budget charged per
  logical request.** `checkAskRegenBudget(askId, outboxId)` claims a
  `SET NX` charge marker keyed by the outbox id (the logical regeneration:
  BullMQ retries and watchdog re-drives replay the same row; a new owner
  regen is a new row) before running the shared INCR-with-cap Lua; replays
  find the marker and charge nothing; a budget refusal releases the marker.
  Chose a TS-level marker over extending the shared Lua: the shared
  primitive stays untouched (one mechanism, two doors) and the idempotency
  is provable at the mocked-Redis seam ("replayed attempts consume one
  unit" test), where a Lua-internal branch would be invisible to the unit
  suite. The marker-claimed-then-charge-crashed race UNDERCHARGES by design —
  the cost-guard's documented fail-open direction.
- [2026-07-31] **Codex adversarial review round 2: needs-attention (4
  findings, all fixed same-day).** (1) high — structured-output failures
  released the reservation and skipped api_costs despite billed completions;
  (2) high — the whole-batch path could insert live renders after a
  halt/expiry/close committed mid-generation; (3) high — checkAskRegenBudget
  transport errors surfaced raw and the failed hook terminalized them;
  (4) high — terminal whole-batch exhaustion marked only the outbox failed,
  stranding a running send parent behind missing outreach rows.
- [2026-07-31] **Codex round-2 fix (finding 1): billed structured-output
  spend is finalized and audited.** `LLMStructuredOutputError` now carries
  `billedAttempts` (provider/model/usage per validation-failed completion;
  `throwExhaustedAttempts` merges the primary's into the rethrown fallback
  error), and `generateChildRender` catches it INSIDE the cost-guarded
  callback — returning `actualCostCents` from the billed attempts so the
  guard FINALIZES instead of releasing. `ChildRenderShared.llm` became
  `llmAttempts: readonly ChildLlmMeta[]` — one api_costs row per billed
  attempt (summing usage across two models into one row would misattribute
  tokens in margin data). Residual documented gaps: a structured-fail
  attempt followed by a transient/terminal PROVIDER error on the other
  provider still escapes finalization (needs both failure modes in one job
  attempt — rare², bounded by the small structured-task maxTokens), and a
  failover-after-invalid-primary SUCCESS still under-reports by one attempt
  (pre-existing seam note, unchanged).
- [2026-07-31] **Codex round-2 fix (finding 2): per-child persist
  revalidation.** `persistChildRender` now runs the regen swap's exact
  ladder in the child-insert transaction: outbox attempt ownership
  (`lockDispatchedOutboxAttemptIfOwned`) → advisory lock → batch row FOR
  UPDATE → `deriveBatchState` re-check; only `built` admits an insert
  (stopped states return a discriminated result — halt/expiry/close wins the
  race, the render is discarded, its spend audited, the outbox completed as
  a no-op SUCCESS; a stale attempt writes nothing and leaves the outbox to
  its new owner). `settleBudgetStop` threads the same guard. The finale's
  post-persist window (stop landing between last child and finale) is
  tolerated: the finale is CAS-gated and `closeBatchIfSettled` no-ops on an
  already-closed batch.
- [2026-07-31] **Codex round-2 fix (finding 3): regen-budget transport
  errors are retryable.** `checkAskRegenBudget` wraps SET/EVAL transport
  failures as `CostInfraUnavailableError` (new touchpoint member
  `checkAskRegenBudget`); `RegenBudgetExceededError` stays terminal (#255
  boundary in both directions). With the round-1 fix, exhaustion on an
  Upstash outage now stays watchdog-eligible instead of silently losing the
  owner's regeneration.
- [2026-07-31] **Codex round-2 fix (finding 4): whole-batch dead-letter
  settlement.** New `settleGenerationExhaustion` (ask-generation.ts owns the
  lane's failure behavior; the hook stays an orchestrator): ONE transaction
  couples the `markOutboxFailed` CAS (first statement, build failed-hook
  precedent) with the domain settlement — withheld `render_failed` fills for
  every send ask holding no non-cancelled row (the budget-stop shape; 091's
  closed `cancelled` vocabulary has no generation-failure member, so
  cancelling live rows was not an option), generation steps when a send
  parent exists, then `closeBatchIfSettled` handed `generation_failed` only
  when nothing is live. DELIBERATE: genuinely rendered rows stay live —
  partial generation is a degraded batch, not a poisoned one; the parent
  legitimately runs toward approval or expiry. Regeneration exhaustion keeps
  the bare CAS (its parent/render are healthy). Residual documented gap:
  watchdog `max_attempts` exhaustion (the OutboxPoller terminalizes the row
  itself) has no domain hook — OutboxPoller is OUT of this intake's surface;
  the failed row pages via the existing failed-outbox alerting, and an
  operator re-drive is now SAFE because the finding-2 revalidation refuses
  stale inserts. Candidate follow-up ticket alongside the sibling-hook
  audit. **SUPERSEDED by the round-3 finding-1 fix below** — the hook now
  dead-letters on the final watchdog attempt, so the generic terminalizer
  only fires for a worker that crashed mid-job on its last attempt.
- [2026-07-31] **Codex adversarial review round 3: needs-attention (4
  findings, all addressed same-day; new thread
  019fbadf-5969-7381-8849-a8af7be9920c).**
- [2026-07-31] **Codex round-3 fix (finding 1): the failed hook dead-letters
  on the FINAL watchdog attempt.** `watchdogRetryRemaining` reads
  `job_outbox.attempts < max_attempts`; a retryable class with no re-drive
  budget left falls through to the terminal arms (whole-batch →
  `settleGenerationExhaustion`, regen → bare CAS) instead of leaving the row
  for the generic OutboxPoller terminalizer, which knows nothing about this
  lane. Best-effort read errs toward the watchdog (logged). Remaining
  residual: a worker that CRASHES mid-job on its final attempt (no failed
  hook runs) still reaches the generic terminalizer — that window needs the
  out-of-surface OutboxPoller hook (follow-up ticket); it is crash-during-
  last-attempt narrow and pages via failed-outbox alerting.
- [2026-07-31] **Codex round-3 fix (finding 2): lifecycle gate at parent
  mint + stopped lanes close-if-settled.** The mint transaction now runs the
  full ladder (attempt ownership → advisory → batch FOR UPDATE →
  `deriveBatchState`); a batch not `built` refuses to mint, closes any
  settled orphan parent from a prior attempt, and completes the outbox as a
  no-op. Both stopped-after-parent paths (child persist, budget settle) now
  call `closeStoppedLane` (advisory + `closeBatchIfSettled`) so an expired
  batch with nothing live terminalizes its parent instead of orphaning it —
  a halted batch was already closed by the halt writer (its close no-ops
  here). DELIBERATE residual: an expired batch with LIVE rendered rows keeps
  its parent running — closing it requires cancelling rows via the
  `batch_expired` halt latch, which is #629/#630's machinery (091's
  `cancelled` reasons are a closed set this lane may not spend).
- [2026-07-31] **Codex round-3 fix (finding 3): incentive vocabulary
  expanded.** complimentary / on the house / sweepstakes / chance-
  opportunity-drawing to win / win a-an-one of / prize(s) / winner(s) /
  cash back / store credit added to class 1; Codex's two accepted sentences
  ("enjoy a complimentary coffee as our thanks", "leave a review for a
  chance to win a prize") plus paraphrases are regression cases.
  `ASK_LINT_VERSION` → `ask_lint_2026-07-31.2`, golden updated.
- [2026-07-31] **Codex round-3 fix (finding 4): deterministic unverifiable-
  claim patterns — NOT the recommended semantic verifier.** Class 6 gains a
  golden-filed `claimPatterns` arm (lowercase invented history/reputation/
  ownership shapes: served-the-community, for-years/decades, award-winning,
  family/locally/woman/veteran-owned, voted best, top-rated, trusted by,
  thousands of, longest-running, proudly serv/support) evaluated over
  subject + model-authored body with the §2.5 interpolated-value exemption.
  Codex's recommendation of mechanical clause assembly or a semantic
  verifier is a DESIGN CHANGE the intake explicitly defers: "Judge content
  review of asks (deliberately unresolved — #631's decision)" is a locked
  non-goal, and an LLM-judge is the only honest general verifier of
  arbitrary factual claims. Pattern hardening is the strongest enforcement
  the deterministic lint can give; the general gap rides to #631. OWNER
  should confirm this boundary at triage.
- [2026-07-31] **Codex adversarial review round 4: needs-attention (3
  findings, checkpointed for a fresh session; thread in the round-4 review
  output).** (1) high — the whole-batch dead-letter's catch suppresses a
  settlement failure on the FINAL outbox attempt, leaving the row dispatched
  for the generic terminalizer to strand (generate-failed-hook.ts:171-179);
  (2) high — note admissibility rejects only 7+ CONTIGUOUS digits, so
  separator-formatted phone numbers ("555-123-4567") are admitted into the
  prompt (ask-compliance-lint.ts:116-124, contact_channel rules); (3) high —
  written-out percentages ("ten percent off") pass the incentive lint
  (ask-compliance-lint.ts class 1). Full text + fix guidance in the handoff
  doc.
- [2026-07-31] **Codex round-4 fix (finding 1): the whole-batch dead-letter
  splits its two failure cases by watchdog budget.** The single catch could
  not tell "the watchdog will re-drive this" from "nothing ever will", so it
  logged `terminal_checkpoint_failed` for both and the second case was left
  to the generic OutboxPoller terminalizer. The branch is now
  `deadLetterWholeBatch`: on a settlement failure it re-reads
  `watchdogRetryRemaining` — budget REMAINS → leave the row dispatched
  exactly as before (the watchdog owns the re-drive; retrying in a bare
  `failed` listener would only duplicate it); budget EXHAUSTED → retry the
  settlement itself, bounded (`FINAL_SETTLEMENT_RETRIES=2`,
  200 ms backoff — short because this runs inside a bare BullMQ listener and
  the realistic failure is a pool blip). Once spent, the lane is conceded
  under its OWN status, `terminal_settlement_abandoned`, deliberately
  distinct from `terminal_checkpoint_failed`: only the new one means nothing
  will retry, so only it is worth paging on. Tests: settlement failure with
  budget remaining (one attempt, unchanged status), final-attempt retry that
  succeeds on the second try, and retries-spent concession. The round-3
  residual is UNCHANGED and still open — a worker that CRASHES mid-job on its
  final attempt runs no failed hook at all and still reaches the generic
  terminalizer; that window needs the out-of-surface OutboxPoller hook.
  Incidental: `leaves the row dispatched when the failure CAS itself throws`
  was passing for the wrong reason (it named the regeneration branch's bare
  CAS but passed a whole-batch payload, where the CAS lives inside the mocked
  settlement); it now passes `ask_id` and exercises the branch it names.
- [2026-07-31] **Codex round-4 fix (finding 2): phone-shaped PII is one fact
  with one owner, tested separator-stripped.** `PII_DIGIT_RUN_LENGTH` /
  `PII_DIGIT_RUN_PATTERN` moved out of the class-5 block into a shared
  phone-PII block alongside a new `stripPhoneSeparators`, and note
  admissibility's `contact_channel` rule gained a `separatorStrippedPatterns`
  arm carrying the digit run. The domain patterns stay on the raw note (`.`
  carries the TLD), which is the same split class 5 already made. Class 5 now
  calls the shared helper instead of its own inline strip, which adds `+` to
  its separator set (a tightening; country-prefixed forms). Strictly broader
  than before: stripping removes separators, never digits. DELIBERATE cost —
  a hyphenated date ("2026-07-31") now reads as a digit run and the note is
  omitted; that is the fail-closed side, since an inadmissible note is a
  DEGRADATION (generation proceeds on the four structured fields) while a
  leaked phone number reaches a stranger. Regressions: hyphen, paren, space,
  `+1` and dotted forms all reject `contact_channel`, plus a short-digit note
  that must still be admitted.
- [2026-07-31] **Codex round-4 fix (finding 3): written-out percentages.**
  Class 1 gains `/\b(?:percent|per\s?cent)\s+off\b/gi` and
  `/\bhalf[\s-]?(?:off|price)\b/gi`. Matching the "… off" SHAPE rather than
  enumerating written numbers subsumes every one of them in two patterns
  instead of a list that would rot; "fifty percent discount" was already
  class 1 via `/discount/`. Codex's exact sentence ("we'll take ten percent
  off your next visit") plus half-off/half-price are regression cases.
  Codex's re-recommendation of a semantic verifier before dispatch is
  UNCHANGED from round 3 finding 4 — that boundary is #631's decision and a
  locked intake non-goal; keeping it deterministic here still needs OWNER
  confirmation at triage.
- [2026-07-31] **Round-4 version bump: `ASK_LINT_VERSION` →
  `ask_lint_2026-07-31.3`**, golden file regenerated (visible diff: two class-1
  patterns, the `separatorStrippedPatterns` split on `contact_channel`).
- [2026-07-31] **Codex adversarial review round 5: needs-attention (4
  findings), plus 2 findings from the parallel self-triage. All 6 fixed
  same-day.**
- [2026-07-31] **Round-5 fix (Codex finding 1): a parentless batch could never
  close.** `closeBatchIfSettled` looked up the send parent BEFORE tallying and
  returned `no_send_parent` without ever reaching the `send_closed_at` CAS, so
  a batch whose generation died before minting a parent stayed open forever —
  nothing mints one afterwards and no later writer calls back in. The tally now
  runs FIRST, which also matches the glossary ("no outreach row left in
  rendered/queued/sending" — a definition that never mentions `agent_runs`),
  and a parentless settled batch closes under a new
  `closed_without_parent` result **only when the caller declares a `failure`**.
  That gate is the whole safety argument: without it the releaser backstop
  would slam `send_closed_at` on any ordinary built batch awaiting approval.
  No receipt step is filed (there is no run to file it against), which is why
  this could not reuse the parented path. Two integration regressions
  (closes-with-failure, idempotent-second-call); the pre-existing
  no-failure-no-mutation test still passes unchanged.
- [2026-07-31] **Round-5 fix (Codex finding 2): terminal settlement is durable
  now, not merely retried.** Round 4's two 200 ms in-hook retries covered a
  blip and nothing longer — Codex was right that conceding to an ephemeral
  listener is not durability. `grantSettlementRedrive` raises the row's
  `max_attempts` by one, which moves it from the OutboxPoller watchdog's
  TERMINALIZE arm (`attempts >= max_attempts`) to its RECOVER arm
  (`attempts < max_attempts`); the job re-runs minutes later and re-attempts
  the whole settlement, resumed rather than re-spent by §7.4 DB-existence
  idempotency. The recovery trigger becomes persistent state instead of a
  listener that has already died, and it needs no new topic, no new poller
  (the single-replica P2 budget stays unspent) and no domain knowledge in the
  generic OutboxPoller — the alternative Codex offered, which is a cross-lane
  change every domain-coupled dead-letter would need, not this branch's.
  Bounded by `SETTLEMENT_REDRIVE_CEILING = 20`; only a REFUSED grant concedes
  the batch as `terminal_settlement_abandoned`. Also closes Codex's sub-point:
  `watchdogRetryRemaining` no longer errs toward the watchdog on a failed
  read — reporting "no budget" routes a settlement failure to the durable
  grant, which is safe even when budget did remain.
- [2026-07-31] **Round-5 fix (Codex finding 3): direct compensation.** Class 1
  enumerated GOODS only, so "We will pay you ten dollars for sharing a review"
  linted CLEAN — the most literal breach of the no-consideration rule was the
  one shape the vocabulary could not see. Added pay/payment/compensate/
  reimburse, the payment rails (venmo/paypal/zelle/cash app), any `$`-prefixed
  or written currency amount, `in return for`, and `for your trouble`. `cash`
  replaces the round-3 `cash ?back`, which it subsumes. **Deliberate
  precedence shift:** `$25` in a fabricated price now blocks as
  `incentive_language` rather than `unverifiable_fact` — still blocked, and
  class 6 still records in `matches`, so the tuning signal survives; the class-6
  provenance test moved to a currency-free fixture and a new test pins the
  new ownership.
- [2026-07-31] **Round-5 fix (Codex finding 4 + self-triage): phone PII stops
  being a separator allowlist.** Round 4 stripped `[\s().+-]` and still missed
  `555/123/4567` and every Unicode dash. `PHONE_SHAPED_DIGITS` now matches
  7+ digits separated by ANY run of `\p{P}`/`\p{S}`/whitespace, so slashes,
  en/em dashes and the non-breaking hyphen are covered by construction rather
  than by extending a list. Letters are not separators, so "table 12, party of
  4" stays admissible. This also fixes the self-triage finding that the
  allowlist rejected `2026-07-31` but admitted `07/15/2026` — date handling is
  now uniform (both rejected), and the over-reach onto dates and invoice
  references remains the accepted fail-closed cost: an inadmissible note is a
  DEGRADATION, a leaked phone number is not.
- [2026-07-31] **Round-5 fix (self-triage finding 1): the lane's dead-letter
  had no alerting.** `checkFailedOutboxByTopic` filters on a CLOSED topic
  allowlist and `generate_solicitation_asks` was absent, so every terminal
  failure in this lane was invisible — which silently voided both the round-3
  and round-4 rationale, each of which concedes a stranded batch to "an
  operator will see the failed row". Topic added, regression test added, and
  the closed-allowlist trap is now documented at the call site so the next
  topic does not repeat it. **INTAKE AMENDMENT 5 (PENDING OWNER RETROACTIVE
  SIGN-OFF):** `allowed_edit_surface` gained
  `worker/background/pollers/health-alert/checks.ts` + its test — the
  edit-surface guard correctly blocked this as drift, and the fix is a
  one-topic addition to an existing closed list, not new alerting machinery.
- [2026-07-31] **Round-5 fix (self-triage finding 2): discount shapes the
  round-4 patterns missed.** `a quarter off` / `a third off` (bare fractions
  never say "percent") and `twenty percent-off` (a HYPHEN, where round 4
  required whitespace) all linted CLEAN. The round-4 comment claiming the
  shape-match "subsumes every written number" was wrong and is gone. Fraction
  and hyphen-tolerant shapes added; all four probe sentences are regressions.
- [2026-07-31] **Round-5 version bump: `ASK_LINT_VERSION` →
  `ask_lint_2026-07-31.4`**, golden regenerated. **Standing owner decision,
  now third-time-asked:** Codex has recommended a semantic verifier in rounds
  3, 4 and 5. Three consecutive rounds of enumerated patterns losing to a
  paraphrase is evidence about the INSTRUMENT, not just the vocabulary. The
  deterministic lint stays (an LLM ask-Judge is a locked intake non-goal
  deferred to #631) but the owner should treat "deterministic lint + #631
  escalation" as an explicit decision rather than a default.
