# Handoff prompts — Pathfinder 2026-08-24

Copy a block directly into `/make-plan`. Each is self-contained and cites
`file:line` verified at `main` @ `0278366c`.

**Do these as separate PRs.** H1 and H2 both touch
`src/lib/notifications/delivery.ts` and the same five dispatchers — sequence
them, do not run them in parallel worktrees.

**Standing environment note for every block below.** The live-DB suites SKIP
SILENTLY without these, and you will report a false pass:

```
export TEST_DATABASE_POOL_URL=postgresql://test@localhost:5499/test_ws4
export DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL
```

Container `repworth-testdb`; confirm it is at migrations head (113) or run
`pnpm test:db:setup`. A live-DB file must be named `*.integration.test.ts` and
execute **no** run-time DDL, or `ci:live-db-suites` fails.

---

## H1 — Make the bounced-owner email skip structural (rank 1)

```
Repo: RepWorth. Branch from `main` (protected — land via PR, never push direct).
Open with `gh pr create --draft`, then `gh pr ready` — draft PRs run no CI.

Read first:
  docs/reviews/PATHFINDER-2026-08-24/02-duplication-report.md  (BUG 1)
  docs/reviews/PATHFINDER-2026-08-24/03-unified-proposal.md    (U2)

THE DEFECT, measured at HEAD 0278366c.

`worker/ingress/resend.ts:97-99` enrolls `auto_post_notice` in
OWNER_DIRECTED_TEMPLATES, so a hard bounce on the auto-post FYI SETS
businesses.owner_email_bounced = TRUE (resend.ts:262-264).

Nothing in the auto-post path ever READS it. Reference counts for
`owner_email_bounced`, per notice member:

  notification 8 · escalation-notice 7 · pending-post-notice 7
  autonomy-suspended-notice 7 · solicitation-veto-notice 7
  auto-post-notice ................................. 0

It cannot be caught downstream: auto-post-notice/context.ts:106 selects
`b.google_maps_url` where every sibling selects `b.owner_email_bounced`, so the
value never reaches the dispatcher. resolve-channels.ts:76-96 filters only
archived_at and enrolments. email-channel.ts:60-72 sends unconditionally.

Impact: every auto-posted reply on an account with a bounced owner address
generates a fresh hard bounce, repeatedly, on the highest-volume notice in the
family — against the promise resend.ts:287 makes to the operator.

DO NOT just add the check to auto-post-notice. That is the shape that was
skipped for six weeks; it would be skipped again by member seven.

DO
  1. Add the owner_email_bounced -> drop-email-channel filter to
     `resolveChannels` (src/lib/notifications/resolve-channels.ts:76-96), the
     layer every member already crosses.
  2. Add `b.owner_email_bounced` to auto-post-notice/context.ts:106's projection
     and to AutoPostBusinessRow (context.ts:47-56).
  3. DELETE the five private copies now made redundant:
     escalation-notice/dispatch.ts:91-97, pending-post-notice/dispatch.ts:101-107,
     solicitation-veto-notice/dispatch.ts:85-91,
     autonomy-suspended-notice/dispatch.ts:49-53,
     notification/dispatch.ts:197.
  4. Correct TWO documents that are false today, in this same PR:
     - docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md:258-262
       claims pending-post-notice was cloned from auto-post-notice "including the
       bounced-owner email skip". There was no skip to inherit.
     - worker/jobs/solicitation-veto-notice/dispatch.ts:83 says "same rule as
       every other notice dispatcher". False for one of five.
  5. The WS4 spec names a "known follow-up #3a". `grep -rn "#3a" docs/` returns
     ONLY that sentence — no ticket anywhere. Open a real issue or delete the
     dangling reference.

ANTI-PATTERN GUARDS
  - Do NOT add a per-member opt-out parameter. The whole point is that no member
    can decline the precondition.
  - Do NOT filter it in each dispatcher. That is the current state.
  - The skip drops the EMAIL channel only. Telegram and WhatsApp are unaffected
    by an email bounce — do not drop the whole enrollment set.

TEST: a case per member asserting no email channel is returned for a business
with owner_email_bounced = TRUE, and that non-email channels still are. The
auto-post case is the regression test — it fails today.

VERIFY: pnpm lint && pnpm typecheck && pnpm test
```

---

## H2 — One claim contract for the notice family (rank 2)

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first:
  docs/reviews/PATHFINDER-2026-08-24/02-duplication-report.md  (BUG 2)
  docs/reviews/PATHFINDER-2026-08-24/03-unified-proposal.md    (U3)

DO H1 FIRST if it is not merged — both touch the same five dispatchers.

THE DEFECT — two halves that compound into silent permanent loss.

HALF A — no stale-claim reap. Measured:
  NO REAP  claimAutoPostNoticeDelivery         delivery.ts:84
  NO REAP  claimEscalationNoticeDelivery       delivery.ts:113
  REAP     claimPendingPostNoticeDelivery      delivery.ts:143
  REAP     claimAutonomySuspendedNoticeDelivery delivery.ts:194
  REAP     claimSolicitationVetoNoticeDelivery  delivery.ts:278

The three reapers DELETE an unfinalized claim older than 15 minutes before
inserting. delivery.ts:151-157 states the failure mode: a dispatcher that
crashed between claim and finalize leaves a pending row that dedup-blocks every
future send.

Nothing else reaps them. NotificationFailoverPoller is scoped to
`template = 'approval_request'` at ALL FIVE of its query sites (:206, :243,
:340, :345, :464). ArchivalPoller.ts:153-171 deletes at 90 days.

HALF B — a conflict is read as a harmless dedup. APN dispatch.ts:101-107 and
ESC :137-143 treat the null return as "already claimed", increment `skipped`,
continue — and the Worker then COMPLETES the outbox. SVN :116-127 and ASN :71-85
distinguish settled from pending and THROW on pending. Rationale is already
written at delivery.ts:314-318.

COMBINED: one crash between the claim INSERT and finalizeDeliverySent leaves an
immortal pending row. Every retry reads it as a dedup and marks the outbox
complete. A Guardian escalation notice — the Guardian persona's ONLY
owner-facing output — is silently and permanently lost, and the outbox reports
success.

DO
  1. Give claimAutoPostNoticeDelivery (delivery.ts:84) and
     claimEscalationNoticeDelivery (:113) the same 15-minute stale-claim DELETE
     the other three have. Copy the shape from :143.
  2. Change both to return the discriminated union
     'claimed' | 'settled' | 'pending' instead of `string | null`, matching
     :273-276 and :189-192.
  3. Update APN dispatch.ts:101-107 and ESC :137-143 to THROW on 'pending' so
     the outbox row stays incomplete. Follow SVN dispatch.ts:116-127.

ANTI-PATTERN GUARDS
  - Do NOT unify the ON CONFLICT predicates or the key columns. Five migrations,
    three key columns; a bind parameter inside ON CONFLICT ... WHERE defeats
    partial-index inference. This is on the DO-NOT-UNIFY register — the reap and
    the return contract are the ONLY things being shared.
  - Do NOT make the reap window configurable. 15 minutes, matching the three
    existing copies.
  - Assert the OBSERVABLE OUTCOME, never the SQL text.

TEST (live-DB, *.integration.test.ts, no run-time DDL):
  - Insert an unfinalized claim older than 15 min; assert a fresh claim succeeds.
  - Insert a FRESH unfinalized claim; assert the dispatcher throws and the outbox
    row is NOT completed. This is the regression test — it fails today.

VERIFY: pnpm lint && pnpm typecheck && pnpm test
```

---

## H3 — Name the autonomy control surface (rank 3, docs-only)

```
Repo: RepWorth. Branch from `main`. Docs-only, so the `changes` classifier will
short-circuit the heavy CI jobs — that is by design, not a failure.

Read first:
  docs/reviews/PATHFINDER-2026-08-24/02-duplication-report.md  (seed 4, part A)
  docs/reviews/PATHFINDER-2026-08-24/03-unified-proposal.md    (U7)

THE GAP. There are now TWO independent autonomy kill-switch families:
  Reply lane:        AUTO_APPROVAL_ENABLED
  Solicitation lane: SOLICITATION_SEND_ENABLED
                     + SOLICITATION_AUTO_APPROVAL_ENABLED

Verified: grep over src/lib/solicitation/ and the solicitation workers returns
ZERO reads of AUTO_APPROVAL_ENABLED (only a comment at auto-approval.ts:439).
Setting AUTO_APPROVAL_ENABLED=false has NO EFFECT on solicitation auto-approval.

SCOPE THIS CORRECTLY — it is smaller than it first looks:
  - env-vars.md:661 is already correct and thorough. Do not rewrite it.
  - Invariant #3 is about posting a response to Google, which this lane does not
    do. It is NOT violated. Do not "fix" it.
  - Production Railway has NONE of the three flags set. There is zero live
    hazard. This is a pre-go-live gap, not an incident.

What is actually missing is the COMPOSITE view an operator needs mid-incident.

DO
  1. One table, one owner: every flag that can cause the platform to act without
     an owner, what flipping it off stops, and what it does NOT stop.
  2. Update the two runbooks that enumerate "the autonomy flags" and predate this
     lane:
     - docs/runbooks/launch-flag-readiness.md:105
     - docs/runbooks/agentic-staging-copilot-autopilot-e2e.md:250
       ("all six autonomy flags -> false") and :256-258 ("Instant kill switches")
  3. Record TWO asymmetries as DECISIONS rather than silent divergences:
     (a) The Governor cannot suspend Solicitation on its own terms — the writer
         filters `persona = 'reply'` (governor.ts:85, suspension.ts:346) while
         the reader is account-wide (solicitation/auto-approval.ts:190-202).
         Either widen the writer or write down that Reply is deliberately the
         only trip wire.
     (b) "Owner never got the notice" DOWNGRADES in the Reply lane
         (veto-window-gate.ts:93) and silently AGES OUT the batch in the
         Solicitation lane (auto-approval.ts:511-530 + release.ts:1544). D9 says
         fail-closed is intended; say whether losing the batch is the accepted
         cost.

THIS MUST LAND BEFORE #633 FLIPS ANYTHING.

ANTI-PATTERN GUARD: do not add a third umbrella flag to "unify" the two
families. The lanes have different risk profiles and different go-live orders;
a shared master switch would remove the ability to enable one without the other.
```

---

## H4 — DB lifecycle outside the provider catch (rank 4)

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-24/02-duplication-report.md (BUG 3)

THE DEFECT. auto-post-notice/dispatch.ts:92-146, escalation-notice :128-183 and
pending-post-notice :126-235 put claim -> send -> FINALIZE inside ONE try,
guarded only by a `deliveryId === null` sentinel that is spent once deliveryId is
set. If finalizeDeliverySent or releaseDeliveryClaim throws, the catch runs the
PROVIDER classifier on a POSTGRES error and may call failDelivery — recording as
failed a notice the provider already accepted.

THIS IS NOT A DESIGN DECISION TO MAKE. The codebase already made it twice. The
target shape and its rationale are written verbatim at
autonomy-suspended-notice/dispatch.ts:60-63 and echoed at
solicitation-veto-notice/dispatch.ts:104-108:

  "Delivery lifecycle DB work is deliberately OUTSIDE the provider-send catch.
   A claim/finalize/release/fail error is infrastructure failure and must
   rethrow unchanged; classifying it as a provider error can falsely settle a
   notice whose provider side effect already succeeded."

DO: restructure the three older dispatchers to that shape. The provider try wraps
ONLY the send; claim, finalize, release and fail sit outside and rethrow.

ANTI-PATTERN GUARDS
  - Do NOT widen the deliveryId sentinel to cover more cases. The sentinel is
    the workaround; moving the boundary is the fix.
  - Do NOT catch-and-log the DB error. It must rethrow so the job retries.

TEST: force finalizeDeliverySent to throw after a successful provider send;
assert the job throws (retryable) and NO failDelivery row is written. Fails today.

VERIFY: pnpm lint && pnpm typecheck && pnpm test
```

---

## H5 — `classifyChannelSendError`, and the two drifts (ranks 5–7)

```
Repo: RepWorth. Branch from `main`. Draft PR first. Small, mechanical, low risk.

Read first: docs/reviews/PATHFINDER-2026-08-24/03-unified-proposal.md (U1, U5, U6)

PART 1 — one error classifier, five deletions.
All five errors.ts files reduce to the same two lines delegating to the same
single-owner predicate isTransientChannelSendError:

    const reason = err instanceof Error ? err.message : String(err);
    return { retryable: isTransientChannelSendError(err), reason };

  auto-post-notice/errors.ts:24-27 · escalation-notice/errors.ts:22-25
  pending-post-notice/errors.ts:25-28 · solicitation-veto-notice/errors.ts:21-26
  autonomy-suspended-notice/errors.ts:8-15

Zero behavioural variance. Create worker/jobs/notification/classify-send-error.ts
owning `classifyChannelSendError(err)`, delete all five, update imports.
A new file under worker/ ships with its docs/directory.md row in the SAME PR
(ci:directory-map).

PART 2 — APN adopts the wrapper. auto-post-notice/Worker.ts:54-64 still
hand-spells the object literal that eligibility.ts:114-119 exists to own — its
own docstring says the mapping "was duplicated verbatim across the three notice
workers". APN's ctx.business (context.ts:47-56) exposes exactly the four
EligibilityBusiness fields, so the swap is behaviour-neutral.
  DO NOT touch ASN's inline form at Worker.ts:41-47 — its split
  context.account/context.business shape genuinely does not fit. That is not
  drift.

PART 3 — one systemic-failure form. Four spellings today:
  APN Worker.ts:117-122  .error  failed only
  ESC Worker.ts:128-133  .error  failed only
  PPN Worker.ts:126-132  .warn   skipped+failed
  ASN Worker.ts:94-97    .warn   skipped+failed
  SVN dispatch.ts:179-185 .warn  skipped+failed   <- and in a different FILE
logger.error writes to console.error where .warn does not, so the same condition
is alertable for two members and not for three. Adopt the newer form (.warn,
skipped+failed, in the Worker). Also adopt SVN's zero-enrolled systemic-failure
warn (Worker.ts:70-74) across all members — its argument is equally true of all.

PART 4 — open the health-alert allowlist. health-alert/checks.ts:90-97 lists six
topics; #950 added only its own. Add AUTO_POST_NOTICE, ESCALATION_NOTICE,
PENDING_POST_NOTICE, AUTONOMY_SUSPENDED_NOTICE. The file's comment :76-80 already
names this failure class.

ANTI-PATTERN GUARD: do NOT extract the 21-line businesses+accounts+offboarding
SELECT into the notice family. It appears in 18 FILES repo-wide; a family-scoped
owner fixes 4 of 18 and creates a second owner for the same SQL. If extracted it
belongs at src/lib/account-offboarding/gate.ts. This is on the DO-NOT-UNIFY
register.

VERIFY: pnpm lint && pnpm typecheck && pnpm test
```

---

## H6 — Finish `#909`, and record the `#880`/`#886` decision (ranks 8, 10)

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-24/02-duplication-report.md
            (the admin surface section — note seed 3 was REFUTED; the four
             seams DO compose cleanly. These are the secondary findings.)

PART 1 — requireAdminJson owns 3 of 25 admin mutation routes.
Byte-shape-identical duplicates survive at:
  src/app/api/admin/billing/grant-extension/route.ts:41-58
  src/app/api/admin/impersonation/start/route.ts:26-49
    (interleaves assertImpersonationCookieConfigured() at :31 — a straight
     migration is not free here; handle it deliberately)
A THIRD, DIVERGENT shape survives at:
  src/app/api/admin/businesses/[id]/ranking/route.ts:24-43
    — different strings ('Invalid input', 'Invalid request body'), no
      NO_STORE_HEADERS, and the try wraps BOTH json() and safeParse.
Eight more admin routes still call request.json() raw.

ci:admin-aal2 accepts all of them: it checks that a gate is REACHED, never that
the preamble is the shared one.

DO
  1. Migrate the two identical routes to requireAdminJson (admin-mfa-gate.ts:124).
  2. Normalise the divergent ranking route — same strings, NO_STORE_HEADERS.
  3. WIDEN ci:admin-aal2 to require the shared preamble on admin mutation routes,
     or route 26 spells it by hand again.
  4. If the eight remaining raw request.json() routes are deliberately out of
     scope, list which and why. Do not leave it implicit.

PART 2 — record a decision nobody made.
useAdminActionForm (#880) and useLaneWrites (#886) are two owners for one client
submit concern, authored EIGHT MINUTES APART, neither referencing the other, and
NEITHER guarded by any CI audit. They are deliberate opposites:
  useAdminActionForm.ts:40-44  owns state, REFUSES transport
  lane-writes.ts:210,395-396   owns transport AND state
The surfaces genuinely differ — AAL2 operator control plane vs tenant-scoped
owner lane — so this is plausibly legitimate specialization.

The finding is NOT that it is wrong. It is that nobody decided. Either add it to
the DO-NOT-UNIFY register with its reason, or unify. Both are acceptable; the
current undocumented split is not.

ANTI-PATTERN GUARD: a new/changed ci:* audit must be wired into ci.yml's `lint`
job AND lefthook.yml or src/__tests__/ci-audit-wiring.test.ts fails — which is
correct and is the point.

VERIFY: pnpm lint && pnpm typecheck && pnpm test && pnpm ci:admin-aal2
```

---

## H7 — Carry-forward: three handoffs untouched across two windows

```
Repo: RepWorth. Branch from `main`.

Read first: docs/reviews/PATHFINDER-2026-08-24/07-handoff-reverification.md

#892, #894 and #895 were left open by the 2026-08-18 pass, were NOT touched by
the 2026-08-22 window, and are NOT touched by this one. All three were
re-verified against current source at HEAD 0278366c and are unchanged, not
stale. Details and exact line numbers are in the re-verification doc; do not
restate the old handoff text — re-derive from source.

  #892 — purge tombstone sentinels: seven writer/verifier literal pairs still
         byte-duplicated across purge-stages.ts:657-696 and
         purge-verification.ts:113-161. Also: docs/directory.md:1221 still says
         27 predicates; the measured count is 28, and it still claims `tone` is
         the only restored column when tracked_keywords = '[]'::jsonb is the
         second (purge-stages.ts:672).

  #894 — tenant-scope blind spot: the false reason is still verbatim at
         pending-count.ts:29-30. Step-1 production adoption is still exactly one
         (batch-view.ts:399). scripts/ci/rls-audit.ts:12 is still
         REQUIRED_RLS_TABLES = TENANT_TABLES.

  #895 — five of six items live: (a) SolicitationBatchPanel.tsx:343 unguarded
         index; (c) purge-stages.ts:794 says "zero production callers" when there
         are FOUR; (d) purge-stages.ts:391-395 one-sided lock-order comment;
         (e) solicitation-lane.ts:456-462 omits business_id where :425-431 logs
         it; (f) auth-island.css:6-15 re-declares 10 tokens outside every
         design-scope-purity guard.

ALSO FOLD IN — two stale references found this pass, neither a regression:
  src/lib/costs/tracker.ts:83 cites canonicalBatchId at solicitation/approval.ts;
    PR #933 moved the owner to solicitation/outreach.ts:94.
  src/lib/solicitation/approval.ts:467 asserts "ALREADY canonical" in prose only.

AND — rank 9, the #891 residue. approve/route.ts:60 + approval.ts:448 still use
the negation `close.status === 'not_settled' ? null : close` that batchDidClose
was built to replace. IMPORTANT: this is LATENT, NOT a live bug — approveBatch
guards send_parent_run_id at approval.ts:305-308, and that subquery
(approval.ts:209-219) uses the IDENTICAL predicate as closeBatchIfSettled's
parent lookup (outreach.ts:430-439), so `no_send_parent` is unreachable here.
Fix it as hygiene: the route is correct BY DISTANCE, and its `closed` field has
ZERO test coverage (the #891 test at approval-routes.test.ts:375 is inside the
HALT describe block at :297). Do not describe it as a defect in the PR body.
```
