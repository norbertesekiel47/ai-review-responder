# #631 Auto-approval lane — deviations log

Entries the plan did not anticipate. Each entry gets an orchestrator verdict:
ACCEPT or RE-PLAN (step 6 read-back).

## Pre-execution (planning-time) entries

- [2026-08-23] **Surface amendment 1 of 2 (owner-approved).** The veto-notice
  dispatch mirrors `worker/jobs/pending-post-notice/`, whose claim helpers and
  per-channel send methods live in `src/lib/notifications/`. Added to
  `allowed_edit_surface`: `src/lib/notifications/**`, `src/lib/config/worker.ts`
  (one optional `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` key),
  `docs/runbooks/whatsapp-templates.md`. Both intake copies updated. VERDICT:
  ACCEPT (owner sign-off recorded in session).
- [2026-08-23] **Intake wording correction (not an amendment).** The intake says
  the auto-approval decision runs "at build completion". The code shows
  `built_at` is stamped BEFORE ask generation (`batch-builder.ts` constructBatch),
  and rendered copy exists only after the generation FINALE transaction
  (`ask-generation.ts` ~line 1130). The decision hook therefore runs in the
  generation finale, initial generation only — never on the `regenerateAsk`
  path (regen exists only in `built`, i.e. only for batches the auto lane
  declined). The owner-facing meaning ("the batch auto-approves the moment its
  messages are ready to review") is unchanged. VERDICT: ACCEPT.

## Plan-review round 1 triage (2026-08-23, codex VERDICT: REVISE)

Report: `docs/reviews/631-auto-approval-lane/plan-round-1.md`. All 14
confidence-filtered findings triaged; plan rev 2 incorporates every ACCEPT.

- F1 owner-approval race → quiet `owner_won` outcome — ACCEPT (plan decision 2)
- F2 approval-time reads serialized via account lock — ACCEPT (decision 3)
- F3 release-time TOCTOU → re-read inside the downgrade tx; residual per-row
  window documented as the existing one-tick class — ACCEPT (decision 6)
- F4 B14/B15: subscription lapse holds, master flag stops the phase; neither
  downgrades. Plan mapper was wrong; the INTAKE's locked fork (auto flag off ⇒
  downgrade) stands untouched — ACCEPT (decision 6)
- F5 reason-parameterized downgrade split — ACCEPT (decision 7)
- F6 real tier ids `copilot`/`autopilot` — ACCEPT (decision 15)
- F7 settings PATCH is an operation union — ACCEPT (decision 14)
- F8 literal ON CONFLICT predicate for the upsert — ACCEPT (decision 14)
- F9 `uuidv7()` not `randomUUID()` — ACCEPT (decision 14)
- F10 CTA is `/dashboard/requests`, tokenless; context.ts precedent claim
  corrected — ACCEPT (decision 10)
- F11 systemic failure must cover the zero-enrolled Worker early return —
  ACCEPT (decision 12)
- F12 resend `OWNER_DIRECTED_TEMPLATES` registration, outside rev-1 surface —
  ACCEPT via intake re-lock rev 2 (owner decision; surface now includes
  `worker/ingress/resend.ts` + tests)
- F13 savepoint control flow: 23505 escapes the callback, caught outside —
  ACCEPT (decision 13)
- F14 no PgBouncer bug in the finale; the release-read hazard is F3 — ACCEPT
  (no separate change)

Appendix items resolved by owner re-lock: anchor = `MIN(sent_at)` (the
Reply-lane shipped semantic; Telegram has no delivery receipt); the notice
worker gates on batch state only, no flag reads.

Intake rev 2 also expands `tests_to_add` 19 → 44 (adopting the review's
missing-failing-test list where it pins production wiring, races, and B14/B15
behavior). Owner-approved in session, 2026-08-23.

## Plan-review round 2 triage (2026-08-23, codex VERDICT: REVISE)

Report: `docs/reviews/631-auto-approval-lane/plan-round-2.md`. 12/14 findings
+ both appendix items RESOLVED. Open items and disposition:

- F3/F14 (release-side TOCTOU on the PASSING arm-level check) — ACCEPT, fixed
  in plan rev 2.1: the four-condition guard moves INTO `releaseOutreachRow`'s
  transaction for auto_policy batches (account lock, in-tx re-read, new
  `auto_conditions` withhold reason). Affordable because
  RELEASE_PER_TICK_BUDGET=2/60s (ADR 0022). Intake edge_cases updated to
  match (intake-field correction, not an amendment).
- Appendix nit (Task 5 title count 6 → 7) — ACCEPT, fixed.

## Task 2 execution (2026-08-23)

- [2026-08-23] **Surface amendment 1 of 2 against intake rev 2 (auto-approved
  class).** The `ci:merge-ledger` audit (#896, landed 2026-08-23 — AFTER this
  intake was drafted) fails any production-diff PR that adds no line to
  `.claude/reference/arch-review-log.md`. That file was missing from the
  surface. Added it: a ≤2-file addition inside the `.claude/reference/`
  registry directory the intake already edits (env-vars.md, migrations-log.md),
  and the edit is mandated by the workflow's own audit. Ledger row for #631
  added (PR number to be filled at step 8). Both intake copies updated.
  VERDICT: ACCEPT.

## Task 6 read-back + amendment (2026-08-23)

- [2026-08-23] **Surface amendment 2 of 2 against intake rev 2 (owner-approved
  in session). BUDGET EXHAUSTED — any further surface discovery forces
  teardown + post-mortem per the abort criteria.** Added:
  `src/lib/agents/run-spine.ts` (one-line STEP_PERSONA key for
  `veto_window_granted`, so the step rides the single spine writer and Task
  6's duplicated `recordVetoWindowGrantedStep` helper is DELETED — the
  run-spine single-writer convention holds) and
  `scripts/ci/tenant-scope-allowlist.ts` (entries for the tenant-column-less
  `agent_run_steps` reads, per the copy-paste-ready list Task 6 logged in its
  own section). Task 7 executes both fixes. Both intake copies updated.
  VERDICT: ACCEPT.

## Step 5 finale (2026-08-24) — two owner overrides

- [2026-08-24] **Third out-of-surface file, OWNER OVERRIDE of the abort
  criterion (recorded in session).** The spine-writer meta-guard
  `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` requires every
  new `recordStep` caller to be classified in its CALLER_ALLOWLIST with the
  reviews-lock-order analysis; `auto-approval.ts` is a new caller.
  The fix is the guard's own prescribed action; every amendment on this run
  was registry/guard-class discovery, never feature-scope creep. File added
  to the surface; the abort criteria stay exhausted for anything further.
  VERDICT: ACCEPT (owner override).
- [2026-08-24] **Reclassify trigger fired: production 2,929 vs 1,250 estimate
  (2.34×); tests 2,558 vs 3,600 (under). OWNER CALL: record and continue
  (#629 precedent).** Overshoot drivers, measured not guessed: the
  three-round plan review's mandated hardening (in-tx release guard, the
  reason-parameterized downgrade split refactor), the notice family's three
  channel adapters + email template file, and the settings operation-union
  extension. Carry-forward lesson for map #617: a RISK=high estimate must
  price the review's hardening pass — #629 (2.2×) and #631 (2.34×) both
  overshot on review-driven scope, not on feature drift. The reclassify WARN
  stays visible in the gate output and is disclosed in the PR description.
  VERDICT: ACCEPT (owner call).

## Task 1 execution (2026-08-23)

- [2026-08-23] #656 promised-test integrity meta-test (postal-address.test.ts:70)
  forbids it.todo in ask-generation.integration.test.ts → the 4 finale eval
  titles moved to auto-approval.integration.test.ts; Task 4 authors their
  bodies there (they drive generateAsksForBatch by import, so placement is
  equivalent). Plan Task 1 item 3 superseded.

## Task 4 execution (2026-08-23)

- [2026-08-23] **Interim red the plan's task split implies, made explicit.**
  `worker/__tests__/queue-routing.test.ts` (the WS3 completeness guard) fails
  between Task 4 and Task 5: Task 4 adds `SOLICITATION_VETO_NOTICE` to
  QUEUE_NAMES (its file list), but the matching `worker/queues.ts` Queue +
  `topicToQueue` entry is Task 5's surface. Same-branch, same-PR; Task 5 (its
  registration step) clears it before any CI run. Not a production hazard:
  the producer is gated behind SOLICITATION_AUTO_APPROVAL_ENABLED (off
  everywhere) and OutboxPoller routing only consults topicToQueue, which
  Task 5 completes. VERDICT: pending (planned sequencing, not an improvised
  change — no file outside the Task 4 surface was touched).
- [2026-08-23] **Migration 113 schema assertion is suite-local for now.**
  `schema-ready.ts` (the shared SchemaRequirement registry) is outside Task
  4's edit surface, so auto-approval.integration.test.ts declares a local
  `MIGRATION_113_SOLICITATION_AUTO_APPROVAL_LANE: SchemaRequirement` (plain
  data — identical failure behavior). The Task 5/6 suites that also need 113
  should hoist it into schema-ready.ts and point this suite at the shared
  export. VERDICT: pending.

## Task 5 execution (2026-08-23)

- [2026-08-23] **Delegated file list was narrower than the recorded intake
  surface — reconciled to the intake, not the delegation.** This task's
  delegation prompt scoped email/telegram/whatsapp work to
  `src/lib/notifications/channels/**` only, omitting
  `src/lib/notifications/email/templates/**` and
  `docs/runbooks/whatsapp-templates.md`. The recorded
  `631-auto-approval-lane-intake.json` `allowed_edit_surface` (pre-approved,
  "Surface amendment 1 of 2 (owner-approved)" entry above) already grants
  both — `src/lib/notifications/**` (full tree) and the whatsapp-templates
  runbook — specifically so this family's email content lives in its own
  `email/templates/<family>.ts` file, matching all 6 sibling notice families
  (pending-post-notice, autonomy-suspended-notice, escalation-notice,
  auto-post-notice, approval, and the rest). No sibling task touches either
  path (the parallel agents' disjoint territories are `src/lib/solicitation/`
  and `src/lib/auto-approval/**`). Built accordingly:
  - Created `src/lib/notifications/email/templates/solicitation-veto-notice.ts`
    (subject/HTML/send, mirrors `pending-post-notice.ts`'s shape) and added it
    to the `email.ts` barrel export list.
  - Added the "Solicitation veto notice" section to
    `docs/runbooks/whatsapp-templates.md` (template name, body, variable map,
    button contract, submission JSON, environment-SID table), matching every
    other template's documented shape.
  - `email-channel.ts`/`telegram-channel.ts`/`whatsapp-channel.ts` and
    `telegram-body.ts`/`whatsapp-body.ts` (all `channels/**`, in every version
    of the surface) implement `sendSolicitationVetoNotice` by delegating to
    those content builders — same wiring shape as every other notice.
  - Did NOT touch `docs/directory.md`, `.claude/reference/env-vars.md`, or
    `CONTEXT.md` — the plan (line ~572-579) assigns directory-map rows,
    env-var rows, and glossary terms to Task 9 explicitly, which runs after
    this task. Leaving those for Task 9 avoids a race on files a sibling task
    owns even though they're in the same intake surface.
  VERDICT: pending (broadened within the pre-approved intake surface, zero
  collision risk with either parallel sibling; not an improvised surface
  grant).

## Task 8 execution (2026-08-23)

- [2026-08-23] **Enable-gate composition: the plan's tier-only refusal wins
  over a literal "exactly like the Reply lane" port.** The Reply lane's
  expansion readiness gates on `tierGrantsAutopilot(tier) &&
  autopilotPurchasable()` (a paused sale blocks even an existing Autopilot
  subscriber's expansion — pinned by the settings tests). Task 8's text
  instead says "refuse when `!tierGrantsAutopilot(tier)`" and defines GET
  `available` without purchasability. Resolved in favor of the plan's explicit
  formula: `assertSolicitationExpansionAllowed` feeds
  `buildAutoApprovalReadiness` with `autopilotAvailable =
  tierGrantsAutopilot(tier)` ONLY, so an existing Autopilot subscriber can
  opt in during a sales pause and PATCH/GET availability cannot disagree.
  The rest of the machinery is the straight port: `standard` confirmation via
  the shared `assertConfirmationProvided`, and blockReasons from the shared
  readiness builder (`auto_approval_disabled` = either lane flag off,
  invariant #13; `policy_suspended` = the D19 account-WIDE suspension read
  matching `decideAutoApproval`, not just the Reply default's flag;
  `subscription_not_writable`; `preview_environment`). No new
  `AutoApprovalReadinessBlockReason` member, no route change (the thin shim
  already maps `AutoApprovalExpansionBlockedError`).
- [2026-08-23] **"Enabling routes through the expansion machinery" is
  implemented as exposure CLASSIFICATION, not an enable-only special case.**
  On an existing row, shortening the veto window or raising the ENFORCED cap
  (compared through `resolveAccountDailySendCap`'s <=10 clamp, so storing 50
  over 30 is `no_change` — both enforce 10) also classifies `expansion` and
  demands confirmation; pure contractions (cap lowering, window lengthening,
  disable) submit unconfirmed and unblocked, mirroring the Reply lane's
  contraction rules. Disable is a plain DELETE per the plan — laundering-safe
  because the Governor's suspension writer (`suspendAccountAutonomy`) targets
  the REPLY account-default row, which this lane never touches.
  VERDICT: no surface change; judgment calls recorded for review.

## Task 6 notes (2026-08-23)

- [2026-08-23] `src/lib/agents/run-spine.ts` has no entry anywhere in
  `.feature/intake.json`'s `allowed_edit_surface` (checked directly), so it is
  outside the whole feature's surface, not just this task's narrower file
  list. Plan decision 5 needs a new spine step key, `veto_window_granted`,
  written via `recordStep`. That function's `stepKey` parameter is typed
  against the `STEP_PERSONA` map in `run-spine.ts`, so landing the key needs
  one entry added there. Chosen resolution: `auto-approval.ts` gained a
  small private helper, `recordVetoWindowGrantedStep`, that inserts one
  `agent_run_steps` row in the same shape `recordStep` produces (run-row
  lock first, `step_index` computed the same way, jsonb detail), with
  `attributed_agent` set to the literal `'solicitation'` — a value the DB's
  `agent_run_steps_attributed_agent_check` (migration 088) already admits.
  Follow-up for a future task with access to `run-spine.ts`: add
  `veto_window_granted: 'solicitation'` to `STEP_PERSONA` there (same shape
  as the existing `approval_downgraded` entry), then swap
  `recordVetoWindowGrantedStep`'s call site for a plain `recordStep` call and
  remove the helper. VERDICT: pending owner review.
- [2026-08-23] `anchorVetoDeadlines` returns `Promise<{ handled: number;
  failed: number }>`, not the literal `Promise<number>` the plan's Step 1
  header names. The plan's Step 2 wiring line routes the return value
  through `tallyPhase`, whose second parameter is `PhaseTally` (`{ handled,
  failed }`) — the same shape every other phase in `release.ts` returns.
  Resolved in favor of the literal wiring code: `anchorVetoDeadlines`
  isolates each candidate with a local `isolateAnchorItem` helper
  (`release.ts`'s `isolateItem`, duplicated rather than imported, to avoid a
  circular import back into `release.ts`), tallies `{ handled, failed }`
  like its siblings, and the tests assert on `.handled`/`.failed`. VERDICT:
  pending — flagging the prose/code mismatch for owner awareness.
- [2026-08-23] `pnpm ci:tenant-scope` fails on 4 findings in
  `auto-approval.ts` (down from 6 after tightening scoping — see next
  entry), and `scripts/ci/tenant-scope-allowlist.ts` has no entry anywhere
  in `.feature/intake.json`'s `allowed_edit_surface` either, so the fix
  (adding allowlist entries + bumping `ALLOWLIST_BASELINE`) cannot land from
  this task. VERDICT: pending — needs the same surface widening as the
  run-spine.ts entry above, or a follow-up task to apply it.
- [2026-08-23] The two REAL findings that a genuine scoping fix could
  remove were fixed in code rather than allowlisted: `anchorOneBatch`'s
  agent_runs lock (`recordVetoWindowGrantedStep`) and the CAS UPDATE's
  notification_deliveries subquery now both bind `account_id`/`business_id`
  to `batch.account_id`/`batch.business_id` — real values, not correlated
  columns, which is what the audit accepts. `recordVetoWindowGrantedStep`
  gained two required parameters (`accountId`, `businessId`) for this.
- [2026-08-23] The remaining 4 findings are the ones the schema cannot
  scope: `selectAnchorCandidates` is a platform-wide background scan (the
  same shape as `release.ts`'s already-allowlisted `BATCH_EXPIRED_SWEEP_SCAN`
  etc. — `category: 'background-global-scan'`), and the two
  `agent_run_steps` reads have no `account_id`/`business_id` column on that
  table at all (same shape as `run-spine.ts`'s and `read.ts`'s already-
  allowlisted entries — `category: 'worker-job-scoped'`). Ready-to-paste
  entries for `scripts/ci/tenant-scope-allowlist.ts` (add all 4, then
  `ALLOWLIST_BASELINE = 390 + 4 = 394`) follow in the next 4 log entries,
  one per finding, each with its exact normalized `sqlSnippet` (verified via
  `extractSqlTemplates`, not hand-transcribed).
  ```
  {
    file: "src/lib/solicitation/auto-approval.ts",
    table: "solicitation_batches",
    sqlSnippet: "SELECT b.id, b.account_id, b.business_id FROM solicitation_batches b WHERE b.approval_method = 'auto_policy' AND b.veto_deadline_at IS NULL AND b.halted_at IS NULL AND b.send_closed_at IS NULL AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.entity_id = b.id AND nd.template = 'solicitation_veto_notice' AND nd.sent_at IS NOT NULL ) LIMIT ${scanLimit}",
    category: 'background-global-scan',
    reason: "selectAnchorCandidates (#631 Task 6, decision 4) — the Veto anchor's platform-wide scan for auto_policy batches whose Veto notice has been provider-accepted at least once. Cross-account BY DESIGN, same shape as release.ts's sibling scans (BATCH_EXPIRED_SWEEP_SCAN etc.): a background release-cycle phase must find every account's unanchored batches, not one. Read-only, projects three ids and nothing else.",
  },
  {
    file: "src/lib/solicitation/auto-approval.ts",
    table: "notification_deliveries",
    sqlSnippet: "SELECT b.id, b.account_id, b.business_id FROM solicitation_batches b WHERE b.approval_method = 'auto_policy' AND b.veto_deadline_at IS NULL AND b.halted_at IS NULL AND b.send_closed_at IS NULL AND EXISTS ( SELECT 1 FROM notification_deliveries nd WHERE nd.entity_id = b.id AND nd.template = 'solicitation_veto_notice' AND nd.sent_at IS NOT NULL ) LIMIT ${scanLimit}",
    category: 'background-global-scan',
    reason: "Same statement as the solicitation_batches entry above — the notification_deliveries EXISTS arm is correlated to the outer row's id, not to a fixed account/business value, so the audit reports it as a second table finding on the one global-scan statement (the release.ts BATCH_EXPIRED_SWEEP_SCAN precedent does the same for its agent_runs EXISTS arm).",
  },
  {
    file: "src/lib/solicitation/auto-approval.ts",
    table: "agent_run_steps",
    sqlSnippet: "SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index FROM agent_run_steps WHERE agent_run_id = ${runId}::uuid",
    category: 'worker-job-scoped',
    reason: "recordVetoWindowGrantedStep's step_index computation, reproducing run-spine.ts's own nextStepIndex (already allowlisted there under the identical reason) for one step key run-spine.ts's STEP_PERSONA map does not yet carry — see this file's Task 6 notes. agent_run_steps has no account_id/business_id column; the caller already holds the run-scoped lock this statement follows.",
  },
  {
    file: "src/lib/solicitation/auto-approval.ts",
    table: "agent_run_steps",
    sqlSnippet: "SELECT (detail->>'veto_window_minutes')::int AS granted_window_minutes FROM agent_run_steps WHERE agent_run_id = ${sendParentRunId}::uuid AND step_key = 'batch_approved' ORDER BY step_index DESC LIMIT 1",
    category: 'worker-job-scoped',
    reason: "anchorOneBatch reads the granted veto window back from the LATEST batch_approved step on the send parent run it just locked (account_id/business_id-scoped) two statements above. agent_run_steps has no account_id/business_id column of its own; the run_id it filters by came off that scoped lock.",
  },
  ```
  Then add 4 to `ALLOWLIST_BASELINE` (390 → 394) in the same file.

## Task 7 execution (2026-08-24)

- [2026-08-24] **Folded-in fix A applied; attribution resolved to
  `'solicitation'`.** `STEP_PERSONA` gained `veto_window_granted:
  'solicitation'` — the exact follow-up the Task 6 notes above prescribe
  ("same shape as the existing `approval_downgraded` entry") and the value the
  deleted duplicate writer already stamped on committed rows. The delegation
  prompt's parenthetical "system actor" is satisfied by the step DETAIL's
  `actor: 'system'` field, which the `recordStep` call preserves — reading it
  as the `attributed_agent` value would have changed the durable row shape and
  broken equivalence with Task 6's committed tests. `recordVetoWindowGrantedStep`
  deleted; `anchorOneBatch` now calls run-spine's `recordStep`; the 16
  auto-approval integration tests (5 anchor titles included) re-ran green
  UNCHANGED before any Task 7 build step. VERDICT: pending owner review.
- [2026-08-24] **Folded-in fix B applied with a delta the Task 6 note could
  not have known: THREE allowlist entries, not four, baseline 390 → 393.**
  The prepared `agent_run_steps` step_index entry described the duplicated
  writer fix A deleted — its statement no longer exists in
  `auto-approval.ts` (the write now rides run-spine.ts's already-allowlisted
  statements), and the audit fails on unused entries, so it could not land.
  Two additional same-file edits the note also could not anticipate:
  (a) `RELEASE_CANDIDATE_SCAN_SQL` refreshed — Task 7 step 1 adds
  `b.approval_method`/`c.approval_method` to the P4 scan and the allowlist
  keys on exact normalized SQL, so the stale constant read as two unused
  entries; (b) `src/lib/solicitation/auto-approval.ts` added to
  `CATEGORY_PATH_RULES['background-global-scan'].allowedFiles` (release.ts's
  sibling comment), or the two scan entries would fail the category's path
  invariant. `pnpm ci:tenant-scope` passes repo-wide; no query loosened.
  VERDICT: pending owner review.
- [2026-08-24] **`downgradeApproval` takes the reason parameter PLUS an
  optional in-tx `confirmReason` resolver.** Plan decision 7 says the reason
  is a parameter; rev 2.1's decision 6 says the auto arm re-reads the four
  conditions INSIDE the downgrade transaction under the batch + account
  locks. Both cannot hold with a plain value parameter alone — the re-read
  must run between the batch lock and the CAS, which are both inside
  `downgradeApproval`. Resolution: `applyDowngradeSplit(sql, batch, reason,
  confirmReason?)` is the one shared implementation (held/skipped arms +
  Sentry-then-log); the Judge arm passes the bare
  `'judge_unavailable'` constant and no resolver; `applyAutoDowngrade` passes
  the arm-level reason plus a resolver that takes `lockAutonomyAccount`
  (batch-then-account) and re-runs `findAutoDowngradeReason` — `null` skips,
  and the CONFIRMED reason (which may differ from the arm-level one) is what
  the spine detail, Sentry tag and report counter carry. The auto lane gets
  its own stable Sentry title (`… auto-approval conditions failed`) so a
  Governor trip never files into the Judge-outage issue; the Judge arm's
  title, tag and behavior are byte-identical to before (its five existing
  tests pass untouched). VERDICT: pending owner review.
- [2026-08-24] **`releaseOutreachRow` returns a 3-member outcome union, and
  `auto_conditions` is counted once per batch.** The boolean return could not
  express the rev-2.1 withhold, so it widened to
  `'released' | 'skipped' | 'withheld_auto_conditions'`. On a withhold the
  row loop BREAKS after counting `auto_conditions` once: the failed condition
  is account-level, so every sibling row of the batch would withhold
  identically, and `withheldByReason` counts per-batch/per-account acts, not
  rows (the `judge_unhealthy`/`account_cap` convention). The next tick's
  arm-level check owns the durable downgrade. VERDICT: pending owner review.
- [2026-08-24] **PRE-EXISTING red found, NOT fixed (outside this task's
  surface): `src/lib/solicitation/__tests__/ask-generation.test.ts` fails 9
  of 40 at HEAD `0c015253`** — verified by stash-run-unstash BEFORE this
  task's changes, and unchanged by them. Every failure is
  `AutonomyAccountNotFoundError` from `lockAutonomyAccount` inside
  `runFinaleAutoApproval` (`ask-generation.ts:1196`): Task 4's finale hook
  added the `SELECT id FROM accounts … FOR UPDATE` account-lock statement to
  the finale transaction, and the unit suite's `mock-sql` fake answers `[]`
  for it (no `accounts` route), so every case whose flow reaches an OWNED
  finale throws. The integration suites (which Task 4 ran) use live Postgres
  and never see it. Fix belongs to whoever owns
  `worker/__tests__/helpers/mock-sql.ts` / `ask-generation.test.ts` — neither
  is in Task 7's allowed file list, and the surface amendment budget is
  exhausted. Task 7's own Verify set (release.integration, release.test,
  auto-approval.integration + tenant-scope/lint/typecheck) is fully green.
  VERDICT: pending — needs a follow-up assignment before the branch's
  `pnpm test` gate can pass.

## Step 6 deviations read-back (2026-08-24) — orchestrator verdicts

Every `pending` entry above is closed here. No entry invalidates a locked
intake decision; nothing triggers RE-PLAN.

- Task 4 / interim queue-routing red — ACCEPT (resolved by Task 5's
  registration; queue-routing green since `f401bb2f`).
- Task 4 / suite-local schema requirement — ACCEPT (resolved by Task 6's
  hoist into schema-ready.ts).
- Task 5 / template-file + runbook broadening — ACCEPT (inside the
  pre-approved amendment-1 surface; matches the 6 sibling notice families).
- Task 6 / duplicated spine writer — ACCEPT as a historical record (deleted
  by Task 7 fix A; the single-writer convention holds at HEAD).
- Task 6 / anchor returns {handled, failed} — ACCEPT (the tallyPhase
  contract wins over the plan's prose). The locally duplicated
  isolateAnchorItem (circular-import avoidance) is flagged to the step 7
  standards review as a possible extraction.
- Task 6 / tenant-scope prep — ACCEPT (superseded by Task 7 fix B).
- Task 8 / tier-only refusal over autopilotPurchasable — ACCEPT (the plan's
  explicit formula; PATCH and GET availability cannot disagree; an existing
  Autopilot subscriber can opt in during a sales pause).
- Task 8 / exposure classification for dial widening — ACCEPT (the
  restraint-only D20 principle applied at the write seam; disable-DELETE is
  laundering-safe because suspension lives on the Reply account-default row
  and the gate reads suspension account-WIDE).
- Task 7 / fix A attribution ('solicitation' + detail actor:'system') —
  ACCEPT (equivalence proven: committed tests re-ran green unchanged).
- Task 7 / fix B three entries, baseline 393 — ACCEPT (the audit fails on
  unused entries; measured, not guessed).
- Task 7 / confirmReason resolver on downgradeApproval — ACCEPT (the only
  shape satisfying decisions 6 and 7 together; the auto lane's own Sentry
  title is an improvement; Judge arm byte-identical, its tests untouched).
- Task 7 / releaseOutreachRow 3-member union + per-batch auto_conditions
  counting — ACCEPT (matches the withholdByReason per-act convention).
- Task 7 / pre-existing ask-generation.test.ts red — ACCEPT (resolved by the
  follow-up fixes `6e0267ea` + `4a310289`; whole suite 40/40, and the
  flag-first reorder removed the unconditional account lock from every
  flag-off finale).
- Step 5 finale / two owner overrides — ACCEPT (recorded above with the
  owner's calls).

## Round-1 review-fix deviations (2026-08-24)

- [2026-08-24] **F-Q5's premise is already satisfied at HEAD — no code change
  was needed for the Sentry half.** The fix directive said "the
  auto-downgrade path's alert constant only reaches logger.error"; at HEAD,
  `applyDowngradeSplit` (release.ts) already calls `Sentry.captureMessage`
  with the auto lane's own stable title
  (`AUTO_DOWNGRADE_ALERT_MESSAGE`) + the confirmed reason as a tag, in the
  guarded best-effort Sentry-then-log shape, on EVERY release-time auto
  downgrade — and the integration test "the auto downgrade records its exact
  reason and never judge_unavailable" already pins that captureMessage call
  (title + reason tag). The intake observability promise holds. What WAS
  wrong is quality finding F4's comment: the Veto anchor's duplicated
  `isolateAnchorItem` carried a constant (`ANCHOR_ITEM_FAILURE_MESSAGE`)
  that never reached Sentry, under a comment claiming `captureException`
  groups by message text. F-Q3's extraction deletes that function, its
  constant and the wrong comment outright — the anchor now fails through the
  shared `release-phases.ts` seam (captureException + `phase: 'veto_anchor'`
  tag, the one stable `ITEM_FAILURE_MESSAGE` log text), which is the
  alignment quality F3 prescribed. The Judge arm's own Sentry call is not
  separately test-pinned, so the "mirror the assertion" clause did not
  trigger. VERDICT: pending orchestrator review.
- [2026-08-24] **One glossary site sits outside the allowed file surface:
  `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`** (the "its
  auto-lane paths" comment quality F1 lists among the 12 sites). The fix
  directive names "the 3 test files the quality report names", which
  includes it, so the one-word comment-only edit was applied there despite
  the file living outside `src/lib/solicitation/**` /
  `src/lib/auto-approval/**` — no behavior, no test titles, no assertions
  touched. VERDICT: pending orchestrator review.
- [2026-08-24] **F-A2 forced one line in
  `scripts/ci/tenant-scope-allowlist.ts` (outside the allowed surface).**
  The allowlist pins the Veto anchor's candidate scan as a byte-identical
  SQL snippet (`VETO_ANCHOR_SCAN_SQL`); adding `AND nd.failed_at IS NULL`
  to the scan changed its template hash, so `ci:tenant-scope` failed with
  two unused-entry + two missing-scope findings until the snippet (and its
  reason's first sentence) tracked the new predicate. Snippet updated in
  place — same two entries, baseline unchanged at 393. A mandatory
  consequence of the accepted F-A2 fix, not new scope. VERDICT: pending
  orchestrator review.
