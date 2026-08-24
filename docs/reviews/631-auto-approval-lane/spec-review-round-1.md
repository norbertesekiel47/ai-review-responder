# #631 Auto-approval lane — SPEC & CORRECTNESS review, round 1

Reviewer: spec/correctness agent (read-only). Base `a7dd67ee` → HEAD `0427eef3`
(24 commits, 48 files, ~7.1k insertions). Inputs read in order: intake rev 2
(`.feature/intake.json`), the fully-triaged deviations log, the blast-radius
map, then the full diff with production files read in full.

## Verdict

**NO FINDINGS at ≥80% confidence.** Every `user_visible_behavior` item,
every `invariants` item, and every `edge_cases` item is implemented and
tested; all 44 promised test titles exist verbatim with substantive bodies
(20+ bodies read line-by-line across all five clusters); no file outside the
allowed edit surface; no behavior drift beyond the intake. Verified
executable evidence, run by this review in the worktree:

- Unit suites (auto-approval, settings, veto-notice dispatch + worker,
  ask-generation): **110/110 pass**.
- Live-DB integration (auto-approval.integration + release.integration
  against the local `repworth-testdb` at migrations head incl. 113):
  **69/69 pass**.
- `worker/__tests__/queue-routing.test.ts` + `src/lib/shared/__tests__`:
  **1087 pass / 194 skipped**.
- `pnpm typecheck`: clean.
- CI audits `ci:outbox-status`, `ci:outbox-seam`, `ci:tenant-scope`,
  `ci:db-imports`, `ci:static-policy`, `ci:live-db-suites`,
  `ci:directory-map`: **all PASS**.

## 1. user_visible_behavior — field by field

| # | Intake behavior | Evidence | Status |
|---|---|---|---|
| 1 | Finale auto-approval under both flags + tier + policy row + no suspension, in the finale tx; raced owner approval wins quietly | `src/lib/solicitation/ask-generation.ts:1193-1203` calls `runFinaleAutoApproval` inside the finale tx (outbox CAS → advisory lock → batch `FOR UPDATE` already held); `src/lib/solicitation/auto-approval.ts` `decideAutoApproval`/`autoApproveBatch`; `owner_won` probe after CAS miss. Tests: finale auto-approves title + owner-won race driven through the REAL `generateAsksForBatch` with `approveBatch` injected between last render and finale (auto-approval.integration.test.ts:678) | HOLDS |
| 2 | Veto notice on enrolled channels; window (30/60, default 60) starts at FIRST provider-accepted send (`sent_at`), not approval | `anchorOneBatch` CAS: `SET veto_deadline_at = MIN(nd.sent_at) + make_interval(mins => granted)` computed in SQL; `autoApproveBatch` never writes the deadline (asserted in tests). Notice family `worker/jobs/solicitation-veto-notice/*` mirrors pending-post-notice with claim-before-send | HOLDS |
| 3 | Owner halt (owner_veto) during the window on the existing Requests surface; admin via admin surface | No new code needed and none added: `haltBatch` admits states `approved`/`veto_window` (refuses only halted/closed/pending, approval.ts:656-659) and `ownerHaltReason` maps every non-`sending` state to `owner_veto` (approval.ts:129-131). Auto-approved-but-unanchored batches derive `approved` (deriveBatchState handles NULL deadline) and are haltable | HOLDS |
| 4 | Releaser re-checks each tick; four exact downgrade reasons; subscription lapse HOLDS (B14); master flag stops the phase (B15) | `runBatchArm` 5.5 arm → `findAutoDowngradeReason` (narrow `AutoDowngradeReason` union, exactly the four intake reasons) → `applyAutoDowngrade` with in-tx `confirmReason` re-read under batch+account locks. `runAccountArm` withholds `subscription` BEFORE the batch arm ever runs (release.ts:1400-1407) so B14 holds even under compound failures; the send flag stops the phase before any arm. All six release-side titles verified with substantive bodies incl. `toEqual({ reason })` on the spine detail | HOLDS |
| 5 | /settings/auto-approval Solicitation section: opt-in toggle via new discriminated-union operation, cap dial 1..50, window dial 30/60 default 60, API-driven, both flags gate visibility | `types.ts` adds `set_solicitation_account_default`/`clear_solicitation_account_default` strict objects to `AutoApprovalPatchSchema`; `settings.ts` `applySolicitationMutation` (uuidv7, literal `ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL`); `AutoApprovalClient.tsx` renders `SolicitationSection` only when `data.solicitation.available` (server-computed: both flags && `tierGrantsAutopilot`). All six settings titles verified | HOLDS |

## 2. invariants — field by field

1. **#3 analog** — P4's release predicate requires `approved_at IS NOT NULL
   AND veto_deadline_at IS NOT NULL AND NOW() >= veto_deadline_at`; the auto
   lane's extra gates (tier, both flags, Judge at release, anchored window)
   all sit in front of the outbox enqueue. HOLDS.
2. **D9 fail-closed** — no sent notice ⇒ no anchor ⇒ `veto_deadline_at` stays
   NULL ⇒ never a P4 candidate (release.ts:1652-1653); the batch terminalizes
   via the existing P2 send-window sweep (`approved_at <= NOW() - 72h`,
   release.ts:1067), which selects approved-but-unanchored batches. HOLDS.
3. **Deadline written once via CAS from MIN(sent_at), in SQL** — `anchorOneBatch`
   CAS with `WHERE … veto_deadline_at IS NULL`, `MIN(nd.sent_at)` in the FROM
   subquery, `::text` round-trips in the RETURNING (no JS Date, #520 honored);
   append-only `veto_window_granted` step through run-spine's `recordStep`
   (STEP_PERSONA key added). Exactly-once + idempotence tested. HOLDS.
4. **Granted window from the policy row AT approval, read back from the
   `batch_approved` step** — `autoApproveBatch` records `veto_window_minutes`
   on the step; `anchorOneBatch` reads the LATEST `batch_approved` step, never
   the live policy row; "ignores later policy edits" test mutates the row to
   30 and asserts the 60-minute anchor. HOLDS.
5. **Four-condition opt-in; rows server-only (#14)** — absence of the
   `persona='solicitation' AND action_class='sending' AND location_id IS NULL`
   row = lane off (`policy: null` → declined `no_policy_row`); writes only via
   the PATCH union in `settings.ts`; `ci:static-policy` passes. HOLDS.
6. **Governor account-wide read (D19), serialized via batch-then-account** —
   `readAutoApprovalConditions`' suspension EXISTS is account-wide with no
   persona filter; `lockAutonomyAccount` (accounts row FOR UPDATE) is taken by
   the finale, the downgrade confirm hook, and `releaseOutreachRow`'s guard —
   the SAME row settings' `lockAccount` and the Governor's writer lock. The
   outcome-anchor-pairing meta-guard's new `auto-approval.ts` entry documents
   the batch → account → run order. HOLDS.
7. **#2 same-tx enqueue, typed helper** — `enqueueSolicitationVetoNotice` in
   `job-outbox-helpers.ts` (byte-matching migration 113's partial-index
   predicate), called inside `autoApproveBatch` on the caller's `tx`;
   atomicity proven by the rollback-arm test. `ci:outbox-seam`/`ci:outbox-status`
   pass. HOLDS.
8. **#11** — `subscriptionGrantsFullAccess` in `decideAutoApproval`; no raw
   status compare anywhere in the lane; trialing+autopilot integration test
   passes. HOLDS.
9. **Judge stays release-owned** — no Judge read anywhere in
   `auto-approval.ts`'s approval path; `runBatchArm` still routes auto batches
   through `applyJudgeSplit` after the 5.5 arm; "Judge unavailability at
   approval time does not block auto approval" passes with `JUDGE_ENABLED=false`. HOLDS.
10. **Notice worker gates on batch state only, zero flag reads** — grep of the
    family confirms no flag/`readFlag` import; context gates are
    `approval_method`/`halted_at`/`send_closed_at` only; anchored is
    deliberately NOT a skip (retries must still feed the anchor). HOLDS.

## 3. edge_cases — all implemented AND tested

- **owner_won race** — real-race integration test (approveBatch injected via
  the `recordApiCost` spy between last child persist and the finale). ✓
- **No channels/all fail** — systemic-failure logged on BOTH halves: dispatch
  zero-sent (dispatch.ts tail) and worker zero-enrolled early return
  (SolicitationVetoNoticeWorker.ts); both tested. ✓
- **Judge down at first tick** — existing `applyJudgeSplit` path untouched
  (its five tests pass byte-identical); Judge counters disjoint from
  `autoDowngradedByReason`. ✓
- **slot_held via savepoint, 23505 classified OUTSIDE** — `tx.savepoint`
  callback lets the error escape; `isUniqueViolationOn` narrows to the one
  constraint; any other 23505 rethrown — proven with a REAL pkey 23505 raised
  inside a proxied savepoint. ✓
- **Halted-batch anchor refusal** — CAS re-asserts `halted_at IS NULL` under
  the batch lock; tested with a send landing after the halt. ✓
- **Duplicate sends** — per-channel claim rows on migration 113's partial
  unique index; `pending` claims throw (no silent double-send); MIN(sent_at)
  first-wins tested with two sends. ✓
- **No retroactive sweep** — flag-flip test proves the built batch stays put
  until a new finale. ✓
- **Policy deleted between approval and release** — three layers: arm-level
  quick read, in-downgrade-tx `confirmReason` re-read under both locks, and
  the rev-2.1 in-tx guard inside `releaseOutreachRow` (batch lock →
  `lockAutonomyAccount` → re-read → `withheld_auto_conditions`, row stays
  `rendered`, counted once per batch, loop breaks). The raced arm is tested
  with a `precedingExecutor` that deletes the row at the top of every tx. ✓
- **Subscription lapse holds (B14)** — account arm withholds before the batch
  arm; batch row byte-identical before/after; tested. ✓
- **Master flag off (B15)** — phase stops (`flag_off`) before any arm; notice
  worker reads no flags so queued notices still dispatch. ✓
- **Telegram-only owner** — anchors via `sent_at` (the channel returns
  sent + externalMessageId; `finalizeDeliverySent` stamps `sent_at`); no
  delivery-receipt dependency anywhere. ✓
- **Hard-bounced owner email** — `solicitation_veto_notice` added to
  `OWNER_DIRECTED_TEMPLATES` (resend.ts:109); bounce test asserts
  `owner_email_bounced = TRUE`; dispatch pre-filters bounced emails before
  any claim. ✓

## 4. tests_to_add — 44/44 verbatim, bodies spot-checked

All 44 titles matched verbatim by exact substring against the branch's test
files (script-verified; mapping in review notes). Bodies read in full for 20+
across all five clusters: the 7 unit gate titles (incl. the fast-check
property test over all six decline reasons), 17 auto-approval.integration
titles (approval verb, finale wiring, 5 anchor titles), 8
release.integration titles (4 downgrade reasons + B14 + mid-drip hold + exact
reason under a simultaneous Judge outage + phase wiring), 6 notice titles, 1
bounce title, 6 settings titles. **No vacuous body found** — the strongest
bodies drive real races (spy-injected owner approval, precedingExecutor
policy deletion, proxied-savepoint 23505) rather than fixture UPDATEs.

## 5. Deviations log — every ACCEPTed adaptation re-verified in code

- Finale (not build-completion) hook; regen structurally excluded
  (`isRegenerableBatchState` = `'built'` only). ✓
- Flag-first perf reorder (`decideFlags` before `lockAutonomyAccount`); the
  shared `decideFlags` keeps the pre-check and the full decision from
  drifting. ✓
- Anchor returns `{handled, failed}` through `tallyPhase`; `isolateAnchorItem`
  duplicated with the circular-import justification (flagged to standards
  review, not a correctness issue). ✓
- Task 7 fix A: duplicate spine writer deleted; `veto_window_granted:
  'solicitation'` in STEP_PERSONA; `anchorOneBatch` calls `recordStep`. ✓
- Task 7 fix B: exactly 3 allowlist entries + baseline 393 + refreshed
  `RELEASE_CANDIDATE_SCAN_SQL` (now carries `approval_method`) + category
  path rule; `ci:tenant-scope` passes repo-wide. ✓
- `downgradeApproval(tx, batch, reason, confirmReason?)`: confirm hook runs
  AFTER the batch lock, BEFORE the CAS; `null` ⇒ `undefined` ⇒ `skipped`;
  the CONFIRMED reason rides the step/tag/counter. Judge arm byte-identical
  (bare constant, no resolver). ✓
- `releaseOutreachRow` 3-member union; `auto_conditions` counted once per
  batch with a loop break. ✓
- Task 8: `autopilotAvailable = tierGrantsAutopilot` ONLY (no
  `autopilotPurchasable`) in both PATCH gate and GET `available` — they cannot
  disagree; expansion classification through `resolveAccountDailySendCap`'s
  clamp (50-over-30 = `no_change`); disable is a persona-scoped DELETE,
  laundering-safe because the Governor writes suspension on the Reply
  account-default row and the gate reads suspension account-wide. ✓
- Pre-existing ask-generation.test.ts red: resolved (40/40 in this review's
  run). ✓

## 6. Blast radius — changed semantics vs listed callers

- `releaseOutreachRow` widened return: sole caller `runBatchArm` (in-file),
  updated with explicit outcome handling. ✓
- `downgradeApproval` gained parameters: sole caller `applyDowngradeSplit`
  (in-file); external callers (test suites) use the public seam. ✓
- `ReleaseCycleReport` gained `anchored` + `autoDowngradedByReason`:
  `SolicitationReleasePoller` logs `{ ...report }` (spread — new fields flow
  through automatically); health-alert checks untouched by the shape. ✓
- `deriveBatchState` consumers now see approved batches with NULL
  `veto_deadline_at`: `deriveBatchState` already guards (`veto_deadline_at
  !== null && now < deadline` ⇒ else `approved`); `haltBatch` admits
  `approved`; batch-view renders NULL deadline as plain approved; P2 sweep
  catches the never-anchored case at 72h. No caller assumed approved ⇒
  non-null deadline. ✓
- `run-spine.ts` STEP_PERSONA gained a key (57 importers): additive;
  `safeFactsForStep` falls back to `[]` for unlisted keys, timeline renders
  the identifier. Typecheck clean. ✓
- `worker-types.ts`/`queue-names.ts`/`flags.ts`/`channels/types.ts`: additive
  interface members; `NotificationChannel` gained a method — all three
  channel classes implement it (typecheck enforces). ✓

## 7. Drift check

`git diff --name-only` (55 files) audited against `allowed_edit_surface`:
**zero files outside the surface.** Surface entries granted but untouched
(`worker/config/startup-assert.ts`, `worker/background/pollers/SolicitationReleasePoller.ts`,
`src/app/api/settings/auto-approval/**`, `docs/adr/**`) are benign: the route
is a thin shim over the extended schema+settings seam; no new boot assert is
needed (the WhatsApp SID is optional-with-skip, and the auto flag's env needs
are covered by the existing `SOLICITATION_SEND_ENABLED=true` assert block that
the flag structurally requires). No behavior in the diff falls outside
`user_visible_behavior` + `observability` (health-alert topic addition and
registry/doc rows are surface-listed observability/registry work).

Non-goals respected: no ask-level Judge verdict path, no flag flips, no
billing, no BATCH_CAP change, no retroactive sweep, no new analytics events,
tokenless CTA, no Requests-panel copy change.

## 8. Architecture invariants (CLAUDE.md) touched by the diff

- **#2** outbox one-tx: helper + same-tx call + rollback-arm test +
  `ci:outbox-seam`/`ci:outbox-status` PASS. ✓
- **#3-analog**: covered in §2. ✓
- **#11**: `subscriptionGrantsFullAccess` everywhere; trialing test. ✓
- **#13**: no `NEXT_PUBLIC_*` companion; client learns via GET
  `solicitation.available`; `ci:static-policy` PASS. ✓
- **#14**: policy writes only through `settings.ts` server seam. ✓
- **#15**: `auto-approval.ts`, the notice family, `delivery.ts`, channel
  code all take `sql`/`tx` as parameters; only composition roots
  (`worker/index.ts`, poller) import the singleton; `ci:db-imports` PASS. ✓

## Low-confidence appendix (observations, NOT findings)

1. **Anchor CAS tenant-scope asymmetry (defensive only).**
   `selectAnchorCandidates`' EXISTS matches deliveries by `entity_id` +
   template alone, while the CAS's `MIN(sent_at)` subquery additionally binds
   `nd.account_id`/`nd.business_id`. A delivery row with the right entity_id
   but mismatched tenant columns would make the scan select a batch whose CAS
   computes `MIN = NULL`, setting `veto_deadline_at = NULL` (a matching row —
   RETURNING fires), recording a `veto_window_granted` step with a NULL
   deadline and re-selecting the batch every tick. **Unreachable through
   current writers** (the claim derives its tenant columns from the same
   scoped batch lookup), hence appendix. Cheap hardening: make the scan's
   EXISTS bind the same tenant columns, or treat `cas.veto_deadline_at ===
   null` as a corrupt-candidate throw.
2. **Stale-anchor on re-auto-approval.** If a downgraded batch were ever
   re-auto-approved via a REPLAYED generation dispatch (no production enqueue
   path does this; the integration retro test drives it manually), the claim
   dedup means no fresh notice send, and the anchor would compute the deadline
   from the ORIGINAL cycle's `sent_at` — potentially already elapsed. The
   owner was notified once about this same batch, so D9's letter holds;
   noting for a future "re-approval" feature.
3. **`autoApproveBatch` owner-won probe** classifies a vanished batch row
   (`b === undefined`) as `owner_won` (`undefined !== null`). Unreachable
   under the caller's held batch lock; an explicit `b === undefined` throw
   would be marginally more honest.
4. **Settings card visibility vs writability.** GET `available` is
   flags+tier only, so a non-writable (e.g. cancelled) Autopilot account still
   sees the card; its expansion PATCH is correctly refused
   (`subscription_not_writable`) and contraction correctly allowed. UX-only
   asymmetry, matches the Reply lane's split of availability vs readiness.
5. **`isolateAnchorItem`/`VetoAnchorTally` duplication** (circular-import
   avoidance) — already flagged by the deviations log to the standards
   review; no correctness impact.
