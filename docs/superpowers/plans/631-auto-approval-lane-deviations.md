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
