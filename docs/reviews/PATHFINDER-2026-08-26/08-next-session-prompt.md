# Paste-ready prompt — the top three

Verified against `main` @ `1d9b251c` on 2026-08-26. Source:
`04-handoff-prompts.md` H1–H3. Full detail lives there; this is the distilled
version for a fresh session.

```
Repo: RepWorth. Branch from `main` (protected — land via PR, never push direct).
Open PRs with `gh pr create --draft`, then `gh pr ready` — draft PRs run no CI.

Read first, in this order:
  docs/reviews/PATHFINDER-2026-08-26/07-handoff-reverification.md  (§C is the headline)
  docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md        (U7, U2, U8)
  docs/reviews/PATHFINDER-2026-08-26/04-handoff-prompts.md         (H1, H2, H3 in full)

These came from an architecture pass on 2026-08-26. Every claim was measured at
HEAD 1d9b251c, not inferred. Where a finding is LATENT rather than live, the doc
says so — respect that distinction in your PR bodies. The prior pass shipped a
wrong headline by not making it.

Do these as THREE SEPARATE PRs, in this order. They touch disjoint surfaces and
may run in parallel worktrees.

════════════════════════════════════════════════════════════════════════
PR 1 — Name the autonomy control surface (docs-only)
════════════════════════════════════════════════════════════════════════

This is the 2026-08-24 pass's H3. It did NOT land. It was marked "MUST LAND
BEFORE #633 FLIPS ANYTHING", and #633 flipped solicitation send-mode on staging
inside this window (#973, #974, #979). The flip shipped; the doc did not.

MEASURED LIVE (Railway, repworth-worker, 2026-08-26):
  production — every autonomy flag UNSET except AUTOPILOT_PURCHASABLE=false
  staging    — AUTO_APPROVAL_ENABLED=false · TRIAGE_ENABLED=false
               ESCALATION_ENABLED=false · GOVERNOR_ENABLED=false
               JUDGE_ENABLED=true
               SOLICITATION_SEND_ENABLED=true
               SOLICITATION_AUTO_APPROVAL_ENABLED=true

SAY THIS PLAINLY IN THE PR BODY: production risk is ZERO, and invariant #3 is
NOT implicated — this lane does not post to Google. It is an operational hazard
confined to staging. Do not write it up as an incident.

THE HAZARD:
The only two autonomy flags ON anywhere in the deployed estate are the two no
runbook mentions. An operator running the documented check at
agentic-staging-copilot-autopilot-e2e.md:77-82 sees six flags false and
concludes "Copilot baseline" — while staging autonomously sends asks. The
documented "instant kill switch" AUTO_APPROVAL_ENABLED=false does NOTHING:
`rg -P '(?<!SOLICITATION_)\bAUTO_APPROVAL_ENABLED\b' src/lib/solicitation/`
returns ZERO reads.

  1. ONE table, ONE owner: every flag that lets the platform act without an
     owner, what flipping it off stops, and what it does NOT stop.
  2. Fix the two runbooks H3 named: launch-flag-readiness.md:104-108 and
     agentic-staging-copilot-autopilot-e2e.md:251, :256-258, plus the
     copy-pasteable grep at :77-82 that embeds the false "six flags" claim.
  3. Fix a THIRD file H3 never listed, and say why it is the most
     consequential: beta-production-standup.md:143 — the PRODUCTION go-live
     checklist — omits both solicitation flags.
  4. Record two asymmetries as DECISIONS, not silent divergences:
     (a) the Governor cannot suspend Solicitation alone (writer filters
         persona='reply' at governor.ts:85 / suspension.ts:346; reader is
         account-wide at solicitation/auto-approval.ts:190-202);
     (b) "owner never got the notice" DOWNGRADES in Reply
         (veto-window-gate.ts:93) but silently AGES OUT the batch in
         Solicitation (auto-approval.ts:511-530 + release.ts:1544).
  5. env-vars.md:661 is already correct and thorough. DO NOT REWRITE IT.
     #974 already improved :663-:664. The gap is the composite view.

GUARD: do not add a third umbrella flag. Two lanes, two risk profiles, two
go-live orders — one table that says so.

════════════════════════════════════════════════════════════════════════
PR 2 — Every enumerated guard gets a completeness rule
════════════════════════════════════════════════════════════════════════

The 2026-08-18 pass NAMED this meta-class. It named it, and the class produced
FIVE new findings two windows later:

  ci:directory-map        scoped worker/+src/lib/ -> missed the orphaned
                          reveal.tsx; docs/directory.md:103 still calls it
                          "the one arrival motion"
  table-disposition.test.ts:112  keys on tenant column/FK -> missed owner_leads,
                          which has NEITHER BY DESIGN and retains owner PII
                          through an account purge
  ci:pool-fanout          SCAN_DIRS excludes src/lib/solicitation/ -> missed
                          contacts-repo.ts:103, the two-way Promise.all on the
                          singleton that #893 reverted elsewhere
  ci:tenant-scope         enumeration in scripts/ci/tenant-tables.ts
  the force-dynamic test  keys on a DB import -> missed the three Daylight
                          pages (see PR 3's note)

THE CENSUS — 46 mechanical guards, and the class is BIGGER than "enumeration":
  18 Class A — pure subject enumeration
  25 Class S — NEW CLASS: derived discovery NARROWED BY A HAND-WRITTEN SCAN ROOT
   4 Class C — derived, unnarrowed
   6 total   — the only guards that detect an EMPTY scan

Class S is bigger than Class A and is the real problem. A guard that discovers
subjects correctly but looks in three hand-written directories is a list wearing
a derivation's clothes. ci:pool-fanout proves it: the #505 fan-out pins did not
disappear when they became a rule — they BECAME SCAN_DIRS.

NOT the same four guards as 08-18: one identical, three DESCENDED, two new.
THE CLASS HAS GROWN.

NEW FAILURE MODE — "exemption transit": owner_leads carries a CORRECT Class-B
exemption at tenant-tables.ts:210, and that correct exemption silently became an
OMISSION in table-disposition.test.ts's required set. Nobody erred. 08-22's
proposed two-line linkedColumnPattern fix would NOT have caught it.

DO THE TWO-STEP GENERAL FIX FIRST — cheaper than the ci:guard-scope meta-audit
08-22 deferred, and strictly wider:
  STEP 1  `scannedCount === 0` fatal inside ratchet-harness.ts — one place,
          covers every harness user. Only 6 of 46 guards notice an empty scan
          today, and a guard silently inspecting zero files reports GREEN.
  STEP 2  export every SCAN_DIRS + ONE ci-audit-wiring case that fails on a
          directory covered by zero audits. That is what would have caught
          src/lib/solicitation/ sitting outside ci:pool-fanout.

DO NOT "derive every scope". Enumeration is often CORRECT — the 08-18 pass
MEASURED that widening TENANT_TABLES yields 63 red lines and 0 security fixes.
And do NOT collapse the 25 SCAN_DIRS into one constant: different universes,
one constant makes every guard wrong differently. Export separately, check the
UNION.

THE RULE: every enumerated guard must be able to FAIL on an unclassified
subject. #894 Step 3 already built exactly this, and it is the model to copy:
every live public table sits in EXACTLY ONE of TENANT_TABLES or
REVIEWED_NOT_TENANT_SCOPED with a stated reason (tenant-tables.ts:189-240,
asserted by tenant-tables.integration.test.ts:55).

START WITH table-disposition — proof it is cheap: TABLE_DISPOSITIONS already
has a not_applicable/not_checked pair, used by ZERO of 48 rows. The vocabulary
to record a conscious exclusion exists and has never once been used.

TEST: per guard, add a subject to the universe and assert the guard FAILS until
it is classified. Assert the observable outcome, never the list contents.

════════════════════════════════════════════════════════════════════════
PR 3 — owner_leads gets a disposition
════════════════════════════════════════════════════════════════════════

owner_leads retains name, email, business_name and maps_url through an account
purge. No disposition row, no sweep, no verification branch.

REACHABLE: yes, CONDITIONALLY — iff the owner used the public lead form
(src/app/api/lead-intake/route.ts:261) before signing up. Say "conditionally"
in the PR body; do not overstate it.

Coverage measured: 51 live tables, 48 dispositions. poller_cursors and
solicitation_send_breaker are correctly out of scope. owner_leads is the gap.

  1. ONE row in TABLE_DISPOSITIONS. The classification is a PRODUCT decision
     this pass does not make — scrub, delete, or CONSCIOUSLY RETAIN with a
     stated reason. All three are legitimate. Silence is not.
  2. If scrub or delete: add the verification branch too. Writer and verifier
     are a matched pair. NOTE there are EIGHT stage runners, not seven —
     runParentTombstonePurgeStage (purge-stages.ts:671) writes every sentinel.
  3. Fix the guard in the same PR or this recurs — see PR 2.

GUARD: do NOT add a tenant column to owner_leads to make the guard see it.
The table is pre-signup by nature; that is tail-wagging-dog.

════════════════════════════════════════════════════════════════════════
BEFORE YOU START
════════════════════════════════════════════════════════════════════════
- No sequencing hazard on the arch log this time: the two open PRs (#927
  dependabot, #646 suppression glossary) do not touch it. Apply
  09-arch-log-entry.md whenever the artifacts PR lands.
- Live-DB suites SKIP SILENTLY without these and you will report a false pass:
    export TEST_DATABASE_POOL_URL=postgresql://test@localhost:5499/test_ws4
    export DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL
  Container `repworth-testdb`; migrations head is 114 — run `pnpm test:db:setup`
  if behind.
- Verify: pnpm lint && pnpm typecheck && pnpm test before claiming done.
  This pass ran lint, typecheck and all 21 ci:* audits (green) but NOT the
  test suite — test health at HEAD is unmeasured.
- Do not touch docs/reviews/PATHFINDER-2026-08-26/ except to tick an item.

════════════════════════════════════════════════════════════════════════
AND ONE STANDING RULE THIS PASS RECOMMENDS ADOPTING
════════════════════════════════════════════════════════════════════════
Three consecutive passes have now found the same class: work that leaves no
trace outside the document that mentions it does not get done. Three forms —
uncounted merges (fixed by ci:merge-ledger), the `#3a` spec parenthetical
(still live at nine weeks), and now a pass's own prose handoffs (0 of 3 landed
from 08-24, while 3 of 3 ISSUE-NUMBERED items from 08-18 did).

The rule the 08-24 pass proposed and nobody adopted: **a follow-up named in a
spec gets an issue number in the same PR, or it does not get named.** It belongs
in CLAUDE.md, not in another findings document. Consider extending it: a
Pathfinder handoff gets an issue number when the pass ships, or it is not a
handoff.
```
