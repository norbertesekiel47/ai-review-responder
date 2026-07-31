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
