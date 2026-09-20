# Paste-ready prompt — the top three

Verified against `main` @ `6edacd0b0` on 2026-09-12. Source:
`04-handoff-prompts.md` H1-A, H1-B, H1-C. Full detail lives there; this is the
distilled version for a fresh session.

**All three are Owner Operator Run B pre-work.** They are small, disjoint, and
every one of them is cheaper to land *before* Run B than after.

```
Repo: RepWorth. Branch from `main` (protected — land via PR, never push direct).
Open PRs with `gh pr create --draft`, then `gh pr ready` — draft PRs run no CI.

Read first, in this order:
  docs/reviews/PATHFINDER-2026-09-12/03-unified-proposal.md   (U1 is the whole brief)
  docs/reviews/PATHFINDER-2026-09-12/01-flowcharts/F1-owner-operator-run-a.md
  docs/reviews/PATHFINDER-2026-09-12/04-handoff-prompts.md    (H1-A, H1-B, H1-C, H1-D)

These came from an architecture pass on 2026-09-12. Every claim was measured at
HEAD 6edacd0b0, not inferred. EVERYTHING BELOW IS LATENT — OWNER_OPERATOR_ENABLED
is unset in every environment (docs/currents.md:16). None of this is an incident.
Respect the LIVE/LATENT distinction in your PR bodies; two prior passes shipped a
wrong headline by collapsing it.

Do these as THREE SEPARATE PRs. They touch disjoint surfaces and may run in
parallel worktrees. PR 1 must land before Run B's first writing route.

════════════════════════════════════════════════════════════════════════
PR 1 — /api/operator joins the owner-API AAL2 allowlist
════════════════════════════════════════════════════════════════════════

MEASURED:
  $ rg -n 'operator' src/lib/shared/protected-routes.ts \
                     src/lib/shared/__tests__/protected-routes.test.ts
  (no output)

isProtectedOwnerApiRoute (src/lib/shared/protected-routes.ts:47-59) enumerates
/api/dashboard, /api/settings, /api/account, /api/billing, /api/locations and
three Zernio paths. /api/operator is in NONE of them. So proxy branch 6
(src/proxy.ts:349-364), which applies getAalGate() (:260-271), never runs for
an Operator route.

SAY THIS PLAINLY IN THE PR BODY — the routes are NOT unguarded:
  withSameOrigin()            turns/route.ts:101
  requireWritableOwner()      turns/route.ts:37 -> route-helpers.ts:133-146
    = role + account_id + writable-subscription + isProcessingBlocked offboarding
THE MISSING PIECE IS AAL2/MFA ONLY. And it is LATENT on TWO independent
grounds: the flag is off, AND getAalGate returns 'ok' whenever
mfaEnforcementEnabled() is false (src/proxy.ts:261-263, src/lib/auth/flags.ts:33-35).
The pass did NOT read the deployed MFA_ENFORCEMENT_ENABLED value.

WHY IT IS STILL FIRST: Run B is two POST routes that move real owner state —
voice config now, auto-approval policy later — and PATCH /api/settings/voice
changes the SAME ROWS from behind the MFA bar. Ship the asymmetry and it
becomes invisible.

  1. ONE entry in the existing allowlist:
       normalized === '/api/operator' || normalized.startsWith('/api/operator/')
  2. A test in src/lib/shared/__tests__/protected-routes.test.ts covering
     /api/operator, /api/operator/turns, /api/operator/conversation, and the two
     Run B routes.

GUARD: do NOT add a fourth branch to proxy.ts. One allowlist entry.

════════════════════════════════════════════════════════════════════════
PR 2 — Extract hasImpersonationCookie BEFORE Run B adds copies 3 and 4
════════════════════════════════════════════════════════════════════════

Two byte-identical private copies today:
  src/app/api/operator/turns/route.ts:97-99
  src/app/api/settings/auto-approval/route.ts:116-118
both:  Boolean(request.cookies.get(IMPERSONATION_COOKIE_NAME)?.value)

src/lib/admin/impersonation/cookie.ts exports the cookie NAME (:38) and the
sign/verify helpers (:23-36). There is NO boolean-check export.

Run B's `apply` and `decline` BOTH need this check — an impersonating admin may
look, never act (the rule is written out at turns/route.ts:40-44). Land the
extraction now and it is 2 edits; land it after Run B and it is 4.

  1. One definition, in src/lib/auth/route-helpers.ts beside the other gate
     helpers, or in impersonation/cookie.ts beside the name.
  2. Both existing call sites import it.
  3. Acceptance: rg -c 'function hasImpersonationCookie' returns 1.

════════════════════════════════════════════════════════════════════════
PR 3 — Export patchAutoApprovalSettingsInTransaction  (RUN B IS BLOCKED)
════════════════════════════════════════════════════════════════════════

MEASURED:
  $ rg -n 'patchAutoApprovalSettingsInTransaction' .
  docs/roadmap/2026-09-11-owner-operator.md:397
  docs/roadmap/2026-09-11-owner-operator.md:532
  docs/superpowers/plans/feat-owner-operator-run-a-intake.json:16
  docs/superpowers/plans/feat-owner-operator-run-a-plan.md:19

FOUR HITS, ALL SPECS. ZERO IN CODE.

patchAutoApprovalSettings(sql: Sql, input) — src/lib/auto-approval/settings.ts:199-209
— is narrowed to Sql (not the SqlExecutor alias at :49) and opens its OWN
sql.begin at :206. Apply cannot call it from inside Apply's transaction.
The transaction-aware pieces are module-PRIVATE:
  updatePolicyInTransaction  settings.ts:216
  lockAccount                settings.ts:379
  ($ rg -n '^export' src/lib/auto-approval/settings.ts  lists only the two
   types, the error class, getAutoApprovalSettings, patchAutoApprovalSettings)

THE SPEC ALREADY CHOSE THE SHAPE — README.md:532: "export
patchAutoApprovalSettingsInTransaction(tx, input) (the current private
updatePolicyInTransaction plus the settings reload), keep
patchAutoApprovalSettings as the thin sql.begin wrapper the route uses."
README.md:643 lists it as an accepted Run A design finding — known and planned,
not built. DO IT THE SPEC'S WAY, not a parallel executor.

  1. Export patchAutoApprovalSettingsInTransaction(tx, input).
  2. Keep patchAutoApprovalSettings as the thin wrapper.
  3. Behaviour unchanged — locks, exposure classification, archived-policy rule,
     readiness, confirmation, writeAccountAuditLog — pinned by the existing suite.
  4. Re-check the two real callers:
       src/app/api/settings/auto-approval/route.ts:57
       scripts/ws8-staging-smoke.ts:500

════════════════════════════════════════════════════════════════════════
WHILE YOU ARE IN THERE — two facts Run B's intake has WRONG
════════════════════════════════════════════════════════════════════════

(a) "The summary panel REUSES the dashboard payload" is wrong. Measured
    field by field (03-unified-proposal.md U1-G):
      rating band   PRESENT-BUT-SHAPED-WRONG. ReputationSummary.averageStar
                    (types.ts:33) and RatingBreakdown (:58-62) bucket ALL rated
                    reviews. The Operator wants PENDING DRAFTS by star
                    (catalog.ts:132). Run A already built readStarBands
                    (operator/context.ts:192-232).
      pending count PRESENT, and Run A already reuses the right helper
                    (pending-count.ts:35-55 at operator/reads.ts:236).
      posted count  ABSENT. totalReviewsHandled (types.ts:66) is all-time;
                    recentReviewCount (:213) is a capped RECEIVED sample.
                    Run A's readPosted7d (context.ts:241-251) is correct.
      location list ABSENT from the per-location DTO (types.ts:107). The roster
                    is getLocationsForAccount (src/lib/locations/repo.ts:64).
    Both dashboard builders DO take sql and need no React context
    (service.ts:129-140, aggregate-service.ts:92) — that half holds. But the
    assembled DTOs drag in a 45s Redis TTL cache (service.ts:64), ranking,
    velocity and briefs, and TWO OF FOUR FIELDS WOULD STILL BE WRONG.
    RUN A'S PATTERN — call the granular helpers — IS CORRECT. Do not "fix" it.

(b) The arch log says the agent_turn lane's "six domain terminals emit logs
    only". Read literally that is FALSE — all six write the turn row to 'failed'
    AND complete the outbox row in ONE transaction (AgentTurnWorker.ts:114/167/
    168/226/201/289 -> failTurnFenced, turns.ts:424-446). The claim is true only
    about the ALERTING CHANNEL: none of the six calls Sentry. The one genuinely
    write-nothing exit is the LEASE-LOST branch at AgentTurnWorker.ts:367-372,
    which is not a terminal at all. Do not reason about what a failed turn
    leaves behind from the compressed sentence.

════════════════════════════════════════════════════════════════════════
ALSO OWED BEFORE THE FLAG FLIPS (not part of these three PRs)
════════════════════════════════════════════════════════════════════════
The rule-11 Sentry build. attachJobFailureSink (worker/index.ts:566-573) DOES
fire Sentry.captureException tagged subsystem:worker_job, queue:agent_turn on an
exhausted job today. What is missing is the external Sentry->Discord RULE:
docs/runbooks/beta-launch-alerting.md:412 marks row 11 "REQUIRED BEFORE
OWNER_OPERATOR_ENABLED GOES ON; NOT CONFIGURED BY THIS CHANGE".
Re-resolves true at HEAD. Already tracked at docs/progresstracking.md:1072.

════════════════════════════════════════════════════════════════════════
BEFORE YOU START
════════════════════════════════════════════════════════════════════════
- No sequencing hazard on the arch log: the two open PRs (#1134, #1133) are both
  Dependabot workflow bumps and neither touches
  .claude/reference/arch-review-log.md. Verified with gh pr diff --name-only.
- Live-DB suites SKIP SILENTLY without these and you will report a false pass:
    export TEST_DATABASE_POOL_URL=postgresql://test@localhost:5499/test_ws4
    export DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL
  Container `repworth-testdb`; migrations head is 120 — run `pnpm test:db:setup`
  if behind.
- Verify: pnpm lint && pnpm typecheck && pnpm test before claiming done.
  This pass ran lint, typecheck and all 22 ci:* audits (green) but NOT the test
  suite — test health at HEAD is unmeasured.
- Migrations 115-120 are in LOCKSTEP across both Supabase projects, verified by
  introspection on 2026-09-12 (26 fingerprint rows, all byte-identical). You do
  not need to re-check them; do not re-derive the 077/078 statement either.
- Do not touch docs/reviews/PATHFINDER-2026-09-12/ except to tick an item.

════════════════════════════════════════════════════════════════════════
AND THE STANDING RULE THAT FINALLY HAS ITS EVIDENCE
════════════════════════════════════════════════════════════════════════
Three passes have now recommended: a follow-up named in a spec gets an issue
number in the same PR, or it does not get named. It has never been adopted —
and the 2026-08-26 pass's recommendation of it was ITSELF a prose handoff, so
it did not land either.

The evidence is now a controlled experiment:
  08-18  H1-H7 filed as issues #890-#896   ->  3 of 3 tracked items LANDED
  08-24  H1-H3 prose only                  ->  0 of 3
  08-26  H1-H10 prose only                 ->  0 of 3 top-ranked (1 partial)
Two windows, one of them 177 MERGES LONG, zero prose handoffs landed.

The sharpest instance: the 08-26 pass asked for ONE ROW in TABLE_DISPOSITIONS
for owner_leads. On 2026-09-12, PR #1270 edited
src/lib/account-offboarding/table-disposition.ts — to add the four Owner
Operator tables — and owner_leads was not added. NOBODY ERRED. The requirement
lived in a review document, and nothing in the file, the test, or CI could
mention it.

This pass therefore files its own: 04-handoff-prompts.md ends with a ready-to-run
`gh issue create` block for all 17 handoffs. RUN IT WHEN THE ARTIFACTS PR LANDS.
It belongs in CLAUDE.md, not in another findings document.
```
