# Paste-ready prompt — the top three

Verified against `main` @ `0278366c` on 2026-08-24. Source:
`04-handoff-prompts.md` H1–H3. Full detail lives there; this is the distilled
version for a fresh session.

```
Repo: RepWorth. Branch from `main` (protected — land via PR, never push direct).
Open PRs with `gh pr create --draft`, then `gh pr ready` — draft PRs run no CI.

Read first, in this order:
  docs/reviews/PATHFINDER-2026-08-24/02-duplication-report.md  (BUG 1, BUG 2, seed 4)
  docs/reviews/PATHFINDER-2026-08-24/03-unified-proposal.md    (U2, U3, U7)
  docs/reviews/PATHFINDER-2026-08-24/04-handoff-prompts.md     (H1, H2, H3 in full)

These came from an architecture pass on 2026-08-24. Every claim was measured at
HEAD 0278366c, not inferred. Where a claim is latent rather than live, the doc
says so — respect that distinction in your PR bodies.

Do these as THREE SEPARATE PRs, in this order. PR 1 and PR 2 both touch
src/lib/notifications/delivery.ts and the same five dispatchers — do NOT run
them in parallel worktrees.

════════════════════════════════════════════════════════════════════════
PR 1 — Make the bounced-owner email skip structural
════════════════════════════════════════════════════════════════════════

worker/ingress/resend.ts:97-99 enrolls `auto_post_notice` in
OWNER_DIRECTED_TEMPLATES, so a hard bounce SETS businesses.owner_email_bounced
(resend.ts:262-264). Nothing in that path ever READS it. Measured reference
counts for `owner_email_bounced` per notice member:

  notification 8 · escalation-notice 7 · pending-post-notice 7
  autonomy-suspended-notice 7 · solicitation-veto-notice 7
  auto-post-notice ................................. 0

auto-post-notice/context.ts:106 selects b.google_maps_url where every sibling
selects b.owner_email_bounced, so the value never reaches the dispatcher.
resolve-channels.ts:76-96 does not filter it. email-channel.ts:60-72 sends
unconditionally. Result: repeated fresh hard bounces on the highest-volume
notice in the family.

DO NOT just add the check to auto-post-notice — that is the shape that was
skipped for six weeks and would be skipped again by member seven.

  1. Put the owner_email_bounced -> drop-EMAIL-channel filter in
     resolveChannels (src/lib/notifications/resolve-channels.ts:76-96).
  2. Add b.owner_email_bounced to auto-post-notice/context.ts:106 and
     AutoPostBusinessRow (context.ts:47-56).
  3. DELETE the five now-redundant private copies: escalation-notice
     dispatch.ts:91-97, pending-post-notice :101-107, solicitation-veto-notice
     :85-91, autonomy-suspended-notice :49-53, notification/dispatch.ts:197.
  4. Correct two documents that are FALSE today:
     docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md:258-262
     (claims a skip that never existed) and
     worker/jobs/solicitation-veto-notice/dispatch.ts:83 ("every other notice
     dispatcher" — false for one of five).
  5. That spec names "known follow-up #3a". `grep -rn "#3a" docs/` returns ONLY
     that sentence. Open a real issue or delete the dangling reference.

GUARDS: no per-member opt-out parameter. The skip drops the EMAIL channel only —
Telegram and WhatsApp are unaffected by an email bounce.

TEST: per member, assert no email channel for owner_email_bounced = TRUE and
that non-email channels still resolve. The auto-post case fails today.

════════════════════════════════════════════════════════════════════════
PR 2 — One claim contract for the notice family
════════════════════════════════════════════════════════════════════════

Two halves compound into silent permanent loss.

HALF A — measured:
  NO REAP  claimAutoPostNoticeDelivery          delivery.ts:84
  NO REAP  claimEscalationNoticeDelivery        delivery.ts:113
  REAP     claimPendingPostNoticeDelivery       delivery.ts:143
  REAP     claimAutonomySuspendedNoticeDelivery delivery.ts:194
  REAP     claimSolicitationVetoNoticeDelivery  delivery.ts:278
Nothing else reaps: NotificationFailoverPoller is template='approval_request'
at ALL FIVE query sites (:206,:243,:340,:345,:464); ArchivalPoller deletes at
90 days. The failure mode is stated at delivery.ts:151-157.

HALF B — APN dispatch.ts:101-107 and ESC :137-143 treat the null return as a
harmless dedup, increment `skipped`, and the Worker COMPLETES the outbox.
SVN :116-127 and ASN :71-85 distinguish settled from pending and THROW.
Rationale already written at delivery.ts:314-318.

COMBINED: one crash between the claim INSERT and finalizeDeliverySent leaves an
immortal pending row; every retry reads it as a dedup and completes the outbox.
A Guardian escalation notice — that persona's ONLY owner-facing output — is
silently and permanently lost while the outbox reports success.

  1. Give delivery.ts:84 and :113 the same 15-minute stale-claim DELETE as :143.
  2. Return 'claimed' | 'settled' | 'pending' instead of `string | null`.
  3. Make APN and ESC dispatchers THROW on 'pending', per SVN dispatch.ts:116-127.

GUARDS: do NOT unify the ON CONFLICT predicates or key columns — five
migrations, three key columns, and a bind parameter inside ON CONFLICT ... WHERE
defeats partial-index inference. That is on the DO-NOT-UNIFY register; only the
reap and the return contract are being shared. Reap window stays 15 minutes.
Assert the OBSERVABLE OUTCOME, never the SQL text.

TEST (live-DB, *.integration.test.ts, NO run-time DDL): a >15-min unfinalized
claim lets a fresh claim through; a FRESH unfinalized claim makes the dispatcher
throw and leaves the outbox row incomplete. The second fails today.

════════════════════════════════════════════════════════════════════════
PR 3 — Name the autonomy control surface (docs-only)
════════════════════════════════════════════════════════════════════════

There are now TWO independent autonomy kill-switch families:
  Reply:        AUTO_APPROVAL_ENABLED
  Solicitation: SOLICITATION_SEND_ENABLED + SOLICITATION_AUTO_APPROVAL_ENABLED

Verified: grep over src/lib/solicitation/ returns ZERO reads of
AUTO_APPROVAL_ENABLED (one comment at auto-approval.ts:439). Flipping it off has
NO EFFECT on this lane.

SCOPE THIS CORRECTLY — it is smaller than it looks:
  - env-vars.md:661 is already correct and thorough. Do not rewrite it.
  - Invariant #3 is about posting to Google. This lane does not. NOT violated.
  - Production Railway has none of the three flags set. ZERO live hazard.
    This is a pre-go-live gap, not an incident. Say so in the PR body.

  1. One table, one owner: every flag that lets the platform act without an
     owner, what flipping it off stops, and what it does NOT stop.
  2. Update the two runbooks that predate this lane and enumerate "the autonomy
     flags": launch-flag-readiness.md:105 and
     agentic-staging-copilot-autopilot-e2e.md:250 and :256-258.
  3. Record two asymmetries as DECISIONS, not silent divergences:
     (a) The Governor cannot suspend Solicitation alone — writer filters
         persona='reply' (governor.ts:85, suspension.ts:346), reader is
         account-wide (solicitation/auto-approval.ts:190-202).
     (b) "Owner never got the notice" DOWNGRADES in Reply
         (veto-window-gate.ts:93) but silently AGES OUT the batch in
         Solicitation (auto-approval.ts:511-530 + release.ts:1544).

MUST LAND BEFORE #633 FLIPS ANYTHING.

GUARD: do not add a third umbrella flag. The lanes have different risk profiles
and different go-live orders.

════════════════════════════════════════════════════════════════════════
BEFORE YOU START
════════════════════════════════════════════════════════════════════════
- PR #951 (docs post-merge sweep) may still be OPEN. It touches
  .claude/reference/arch-review-log.md. If you are applying this pass's
  arch-log entry (09-arch-log-entry.md), #951 merges FIRST.
- Live-DB suites SKIP SILENTLY without these and you will report a false pass:
    export TEST_DATABASE_POOL_URL=postgresql://test@localhost:5499/test_ws4
    export DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL
  Container `repworth-testdb`; confirm migrations head 113 or run
  `pnpm test:db:setup`.
- Verify: pnpm lint && pnpm typecheck && pnpm test before claiming done.
- Do not touch docs/reviews/PATHFINDER-2026-08-24/ except to tick an item.
```
