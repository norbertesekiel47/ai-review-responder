# Handoff prompts — Pathfinder 2026-08-26

Each block is copy-pasteable into `/make-plan` or a fresh session. Every claim
was measured at HEAD `1d9b251c`.

**Ordering constraint that actually matters:** H1 and H4 both touch
`src/lib/notifications/` and the same five dispatchers. Do not run them in
parallel worktrees. Everything else is independent.

---

## H1 — Name the autonomy control surface (docs-only) · **HIGH, do first**

```
Repo: RepWorth. Branch from `main` (protected — land via PR).
Open with `gh pr create --draft`, then `gh pr ready` — draft PRs run no CI.

Read first:
  docs/reviews/PATHFINDER-2026-08-26/07-handoff-reverification.md  §C
  docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md        U7

This is the 2026-08-24 pass's H3, which did NOT land. It was marked "MUST LAND
BEFORE #633 FLIPS ANYTHING". #633 flipped solicitation send-mode on staging
inside the 08-26 window (#973, #974, #979). The flip shipped; the doc did not.

MEASURED LIVE FLAG STATE (Railway, repworth-worker, 2026-08-26):
  production — every autonomy flag UNSET except AUTOPILOT_PURCHASABLE=false
  staging    — AUTO_APPROVAL_ENABLED=false, TRIAGE_ENABLED=false,
               ESCALATION_ENABLED=false, GOVERNOR_ENABLED=false,
               JUDGE_ENABLED=true,
               SOLICITATION_SEND_ENABLED=true,
               SOLICITATION_AUTO_APPROVAL_ENABLED=true

SAY THIS PLAINLY IN THE PR BODY — production risk is ZERO and invariant #3 is
NOT implicated (this lane does not post to Google). The hazard is operational
and confined to staging. Do not write it up as an incident.

THE HAZARD, stated precisely:
The only two autonomy flags ON anywhere in the deployed estate are the two no
runbook mentions. An operator running the documented check at
agentic-staging-copilot-autopilot-e2e.md:77-82 sees six flags false and
concludes "Copilot baseline" — while staging autonomously sends asks. And the
documented "instant kill switch" AUTO_APPROVAL_ENABLED=false does NOTHING:
it is already false, and `rg -P '(?<!SOLICITATION_)\bAUTO_APPROVAL_ENABLED\b'
src/lib/solicitation/` returns ZERO reads.

DO:
  1. ONE table, ONE owner. Every flag that lets the platform act without an
     owner: what flipping it off stops, and what it does NOT stop.
  2. Correct the two runbooks H3 named:
       launch-flag-readiness.md:104-108 — names AUTO_APPROVAL_ENABLED, says
         "Staging has all of these true"; both solicitation flags absent from
         the whole file.
       agentic-staging-copilot-autopilot-e2e.md:251, :256-258, and the
         copy-pasteable grep at :77-82 that embeds the false "six flags" claim.
  3. CORRECT A THIRD FILE H3 DID NOT LIST, and say why it is the most
     consequential: beta-production-standup.md:143 — the PRODUCTION go-live
     checklist — lists seven flags "all unset/false" and omits both
     solicitation flags.
  4. Record two asymmetries as DECISIONS, not silent divergences:
     (a) The Governor cannot suspend Solicitation alone — writer filters
         persona='reply' (governor.ts:85, suspension.ts:346), reader is
         account-wide (solicitation/auto-approval.ts:190-202).
     (b) "Owner never got the notice" DOWNGRADES in Reply
         (veto-window-gate.ts:93) but silently AGES OUT the batch in
         Solicitation (auto-approval.ts:511-530 + release.ts:1544).
  5. env-vars.md:661 is already correct and thorough. DO NOT REWRITE IT.
     #974 already improved :663-:664. The gap is the composite view, not the
     per-flag rows.

GUARD: do not add a third umbrella flag. Two lanes, two risk profiles, two
go-live orders — one table that says so.
```

---

## H2 — Every enumerated guard gets a completeness rule · **HIGH**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first:
  docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md  U2
  docs/reviews/PATHFINDER-2026-08-26/02-duplication-report.md  (guard census)
  docs/reviews/PATHFINDER-2026-08-18/  — its "X10" meta-class finding

THE FINDING: the 08-18 pass named this class. It named it, and the class
produced FIVE new findings two windows later:

  ci:directory-map        scoped worker/+src/lib/  -> missed the orphaned
                          reveal.tsx; docs/directory.md:103 still calls it
                          "the one arrival motion"
  table-disposition.test.ts:112  keys on tenant column/FK -> missed owner_leads,
                          which has NEITHER BY DESIGN and retains owner PII
                          through a purge
  ci:pool-fanout          SCAN_DIRS excludes src/lib/solicitation/ ->
                          missed contacts-repo.ts:103, the two-way Promise.all
                          on the singleton that #893 reverted elsewhere
  ci:tenant-scope         enumeration in scripts/ci/tenant-tables.ts
  the force-dynamic test  keys on a DB import -> missed the three Daylight
                          pages; /pricing freezes isFoundingWindowOpen() at
                          build (see H5)

DO NOT "derive every scope". Enumeration is often CORRECT — the 08-18 pass
measured that widening TENANT_TABLES produces 63 red lines and 0 security fixes.

THE RULE: every enumerated guard must be able to FAIL on an unclassified
subject. #894 Step 3 already built exactly this and is the model to copy:

  every live public table sits in EXACTLY ONE of TENANT_TABLES or
  REVIEWED_NOT_TENANT_SCOPED, with a stated reason
    scripts/ci/tenant-tables.ts:189-240
    asserted by tenant-tables.integration.test.ts:55

Apply that shape to the other four. Per guard: a universe, an
excluded-with-reason list, and a test that every subject is in exactly one.

THE CENSUS (02-duplication-report.md) reframes this — 46 guards censused:
  18 Class A — pure subject enumeration
  25 Class S — NEW CLASS: derived discovery NARROWED BY A HAND-WRITTEN SCAN ROOT
   4 Class C — derived, unnarrowed
   6 total   — the only ones that detect an EMPTY scan

Class S is bigger than Class A and is the real problem. ci:pool-fanout proves
it: the #505 fan-out pins did not disappear when they became a rule, they
BECAME SCAN_DIRS. The enumeration changed shape.

It is NOT the same four guards the 08-18 pass named: one identical, three
DESCENDED, two new. The class has GROWN.

NEW FAILURE MODE — "exemption transit". owner_leads carries a CORRECT Class-B
exemption at tenant-tables.ts:210, and that correct exemption silently became
an OMISSION in table-disposition.test.ts's required set. Nobody erred. A true
statement in one guard's vocabulary became a missing row in another's.
The 08-22 pass's proposed two-line linkedColumnPattern fix would NOT have
caught this.

DO THE TWO-STEP GENERAL FIX FIRST — it is cheaper than the ci:guard-scope
meta-audit 08-22 deferred, and strictly wider:

  STEP 1 — make an empty scan FATAL. Only 6 of 46 guards notice when their scan
    matches nothing. Add a `scannedCount === 0` fatal inside ratchet-harness.ts:
    one place, covers every harness user. A guard silently inspecting zero files
    is worse than no guard — it reports green.

  STEP 2 — make scan roots INSPECTABLE. Export every SCAN_DIRS and add ONE
    ci-audit-wiring case that FAILS on a directory covered by zero audits. That
    is the check that would have caught src/lib/solicitation/ sitting outside
    ci:pool-fanout.

THEN the per-guard completeness lists, starting with table-disposition — the
proof it is cheap: the vocabulary already exists. TABLE_DISPOSITIONS has a
not_applicable/not_checked pair used by ZERO of 48 rows. Nobody was ever asked
to use it.

GUARDS:
  - Do NOT collapse the 25 SCAN_DIRS into one shared constant. The guards have
    genuinely different universes; one constant makes every guard's scope wrong
    for a different reason. Export separately, check the UNION.
  - Do NOT merge the tenant-scoping inventory with the retention inventory.
    Different questions about the same tables.

TEST: for each guard, add a subject to the universe and assert the guard FAILS
until it is classified. Assert the observable outcome, never the list contents.
```

---

## H9 — One owner for the 33-site subscription-context read · **MEDIUM**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-26/02-duplication-report.md  X1
            docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md    U9

The `businesses ⋈ accounts` subscription-context read is spelled 33 TIMES with
a byte-identical JOIN predicate. The alias pair account_past_due_at /
account_flags appears at 15 of them. No shared fragment. NO COMMENT ANYWHERE
saying these are the same read. Largest blast radius measured in six passes.

THIS CORRECTS AN EARLIER FINDING IN THE SAME PASS — do not trust the smaller
number if you see it quoted: the F8 flowchart reported FIVE sites. Those five
were one sub-family of thirty-three, AND one of them
(autonomy-suspended-notice/context.ts) does not do the join at all.
Re-derive the 33 yourself before you start; do not take either number on trust.

DO: one named SQL fragment in src/lib/shared/ owning the join predicate and the
alias pair. Every site composes it.

PRECEDENT TO FOLLOW: src/lib/kpi/fragments.ts already does exactly this for the
review-time anchor (ADR 0019, #688/#757). Same shape, same seam.

GUARD: compose a FRAGMENT, do not build a getSubscriptionContext() function.
The 33 sites select different neighbouring columns — a function would need 33
shapes; a fragment needs none.
```

---

## H10 — Finish #972: the `'scrubbed:'` literal class · **HIGH**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-26/02-duplication-report.md  X2
            docs/reviews/PATHFINDER-2026-08-26/07-handoff-reverification.md  §D1

#972 gave the PURGE TOMBSTONE SENTINELS one owner (purge-sentinels.ts:51, nine
members, both sides bound) and stopped ONE LITERAL CLASS SHORT.

The purge writer and verifier still hand-share:
  'scrubbed:' prefix  — 20 copies, split 10 writer / 10 verifier
  'account purged'    — 2 copies (purge-stages.ts:661, purge-verification.ts:535)

(The F11 flowchart measured the split as 7 <-> 9; the cross-feature phase
re-measured 10 <-> 10. Re-derive before you start.)

WHY THIS IS HIGH AND NOT A TIDY-UP: the verifier is a FAIL-CLOSED COMPLIANCE
GATE. A drift on the WRITER side fails loudly. A drift on the VERIFIER side
does not — it silently converts a failing purge into a PASS. This is a
data-deletion guarantee that can go green while being wrong.

DO: two new members on the existing frozen const. No new file, no new
abstraction — purge-sentinels.ts already exists and both consumers already
import it.

GUARDS:
  - PURGE_TOMBSTONE_SENTINELS holds VALUES, NOT SQL. Do not let it grow query
    fragments. (On the DO-NOT-UNIFY register.)
  - Keep the 'scrubbed:%' real-wildcard NOT LIKE checks distinct from the
    sentinel IS DISTINCT FROM comparisons. #972 correctly left those alone;
    they are a different class again.

TEST: a mutation test. Change the verifier's copy of one literal and assert the
suite FAILS. Today it does not — that is the whole finding.
```

---

## H3 — `owner_leads` gets a disposition · **HIGH**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-26/01-flowcharts/F11-purge-verification.md
            docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md  U8

owner_leads retains name, email, business_name and maps_url through an account
purge. No disposition row, no sweep, no verification branch.

REACHABLE: yes, CONDITIONALLY — iff the owner used the public lead form
(src/app/api/lead-intake/route.ts:261) before signing up. Say "conditionally"
in the PR body; do not overstate it.

Coverage measured: 51 live tables, 48 dispositions. poller_cursors and
solicitation_send_breaker are correctly out of scope (platform-scoped, no
tenant column). owner_leads is the gap.

DO:
  1. Add ONE row to TABLE_DISPOSITIONS. The classification is a PRODUCT
     decision this pass does not make — scrub, delete, or CONSCIOUSLY RETAIN
     with a stated reason. All three are legitimate. Silence is not.
  2. If the answer is scrub or delete: add the verification branch too. The
     purge writer and verifier are a matched pair (F11 charts all eight stage
     runners — note there are EIGHT, not seven; runParentTombstonePurgeStage
     at purge-stages.ts:671 is the one that writes every sentinel).
  3. Fix the guard in the same PR, or this recurs. See H2 — the completeness
     test at table-disposition.test.ts:112 keys on tenant columns/FKs, which
     owner_leads does not have BY DESIGN.

GUARD: do not add a tenant column to owner_leads to make the guard see it.
The table is pre-signup by nature; that would be tail-wagging-dog.
```

---

## H4 — Land the 08-24 pass's H1 and H2, with the tense corrected · **MEDIUM**

```
Repo: RepWorth. Branch from `main`. TWO SEPARATE PRs, in this order.
Both touch src/lib/notifications/ — do NOT run them in parallel worktrees.

Read first:
  docs/reviews/PATHFINDER-2026-08-24/08-next-session-prompt.md  (PR 1 and PR 2
    in full — the prompts are still accurate about the code)
  docs/reviews/PATHFINDER-2026-08-26/07-handoff-reverification.md  §A, §B

VERIFIED AT HEAD: neither landed. `git log 72dc58ac..HEAD` over
src/lib/notifications/ and all six notice-member directories returns NOTHING.
delivery.ts:84 and :113 are at their 08-24 line numbers, unchanged.

MANDATORY CORRECTION BEFORE EITHER SHIPS — the 08-24 prompts describe these as
currently-firing bugs. THEY ARE NOT. Both are LATENT:
  auto-policy-publish.ts:555-562 (evaluateRuntimeGate) downgrades every
  unposted auto_policy response while the flag is off, and Railway shows
  AUTO_APPROVAL_ENABLED unset in prod / false in staging;
  ESCALATION_ENABLED false in staging, unset in prod.
A PR body claiming "repeated fresh hard bounces" today would be WRONG.

Frame it correctly: these are pre-flip fixes. They become live the instant
those flags flip, which is exactly why they land BEFORE the flip.

ONE MEASUREMENT CORRECTION: the 08-24 pass published per-member
owner_email_bounced reference counts of 7/8. Re-measured at HEAD they are 5
and 9. The zero for auto-post-notice reproduces exactly. Use the measured
numbers; the shape of the finding is unchanged.

Everything else in the 08-24 prompts — the five private copies to delete, the
resolveChannels filter, the 15-minute reap, the three-state return union, the
two dispatchers that must throw — is still correct at HEAD.
```

---

## H5 — The three Daylight routes lose their build-frozen flags · **MEDIUM, scheduled**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-26/01-flowcharts/F7-daylight-pages.md

MEASURED: .next/prerender-manifest.json shows "compute":"static" and
initialRevalidateSeconds:false for /features, /how-it-works and /pricing.
The landing route / is absent because page.tsx:6 declares force-dynamic,
CITING INVARIANT #13.

CONSEQUENCE — verified reachable at src/app/(public)/pricing/page.tsx:17:
    priceVariant: isFoundingWindowOpen() ? 'founding' : 'list',
isFoundingWindowOpen() defaults to new Date() (founding-window.ts:29) and is
evaluated AT BUILD. The checkout path (create-business.ts:169) calls the same
function at REQUEST time. After the deadline passes, /pricing advertises
founding pricing while checkout charges list.

SEVERITY IS DATE-BOUNDED — say so in the PR body. FOUNDING_DEADLINE is
2027-01-01T00:00:00Z. This CANNOT fire before then, and any production deploy
after that date clears it until the next build goes stale. There is a known
date to beat.

Invariant #13 is clean ON THE LETTER: zero NEXT_PUBLIC_*, every read through
readFlag/getServerConfig. Frozen-at-build is a DIFFERENT failure from the one
the invariant names. Do not report it as an invariant violation.

DO:
  1. Restore force-dynamic on the three routes, OR move the founding decision
     to request time. Pick one and say why. force-dynamic was REMOVED by
     a457c237 (#19) — read that PR before re-adding it, in case the removal
     had a reason worth preserving.
  2. Extend the render-mode guard so it can see these pages. It currently keys
     on a DB import they do not have. This is H2's instance — coordinate.
  3. While in PricingContent: the CTA is hardcoded 'Create account'
     (PricingContent.tsx:554) while /features and /how-it-works render
     'Start your N-day free trial'. Pricing already shows the trial FAQ on
     that posture. PricingContent.test.tsx:60 PINS THE DIVERGENCE IN PLACE —
     that is a test defending a bug. Fix the code, replace the assertion.
     The hardcoded day count (:89, :633 vs trialPeriodDays()) is LATENT —
     fix it in the same pass.
```

---

## H6 — One arrival motion per system, one Island motion token · **LOW**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first:
  docs/reviews/PATHFINDER-2026-08-26/01-flowcharts/F2-motion-primitives.md
  docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md  U3, U4

SIX spellings of one arrival idea. PROOF they are one system, not six:
carousel.css:112-113 neutralises all three live Landing spellings with a single
opacity/transform !important. One CSS rule already knows about every variant.

DO:
  1. Staged is the single Landing owner. FutureSection.tsx:56-64 is a
     hand-rolled `Staged rise={0}` — replace it. FleetSection.tsx:99-104's
     opacity-only variant becomes Staged with an explicit prop.
  2. The hero KEEPS its on-load trigger (a real difference) and LOSES its
     easeOut in favour of the bezier. staged.tsx:44 already FALSELY documents
     its bezier as "the hero entrance's ease" — fix the comment too.
  3. DELETE landing/reveal.tsx — zero importers, verified by git grep at both
     window endpoints — and its docs/directory.md:103 row, which still calls
     it "the one arrival motion".
  4. Add --rw-dl-ease to the Island :root. cubic-bezier(0.22,0.61,0.36,1) is
     29 CSS literals + 2 JS copies and Island has ZERO motion tokens.
  5. Extract src/hooks/useHasMounted.ts (U4) — beside the useReveal.ts that
     #976 already consolidated there. Three call sites: the two existing
     private copies (HeroSection.tsx:57, CtaSection.tsx:70) plus
     ProblemSection.tsx:47, WHICH IS THE LIVE DEFECT:
       usePrefersReducedMotion's server snapshot is hard-false
       (usePrefersReducedMotion.ts:24-26), page.tsx:6 is force-dynamic, so
       every reduced-motion visitor is served the video branch until
       hydration. HeroSection.tsx:48-56's own docstring names this exact bug.
     Severity MEDIUM, not high: ProblemSection.tsx:100 sets preload="none",
     so the download consequence the docstring warns about is mitigated.
  6. Move the reduced-motion check INSIDE AmbientVideo (ambient-motion.tsx:95-98).
     It is currently copied at four call sites; three work.

GUARDS:
  - DO NOT unify Staged and useReveal. Two design systems, different triggers.
    On the DO-NOT-UNIFY register.
  - DO NOT point Island's ease at Console's --rw-ease (tokens.css:237-242).
    Different curve, deliberately.
  - problem/ and tiers/ are new in this window and have ZERO tests, while
    LandingExperience.test.tsx:8-9 claims each stubbed section "is covered by
    its own suite". Add the ProblemSection test with this fix.
```

---

## H7 — The entropy counter gets one owner · **MEDIUM**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-26/05-process-findings.md  §1
            docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md  U1

SIX consecutive passes have reported this counter wrong. The 08-24 pass
reported it RIGHT and credited ci:merge-ledger. That did not survive one window.

MEASURED THIS WINDOW: the log says 8. The bullet list counts 8. The window
measures 12. Missing: #976, #964, #962, #954. `rg '#962'` and `rg '#954'`
against the log both return ZERO — both are recorded under their ISSUE number.

THE LOG'S OWN PRESCRIBED FIX IS UNSOUND. It says "count the lines below … the
lines are the only source that cannot drift." ci:merge-ledger fires on
production OR GOVERNANCE files (merge-ledger-audit.ts:22-32); the counting rule
is production ONLY. Three merges this window prove it — #957, #960, #961 each
have ZERO production files, each was REQUIRED by CI to add a line, and each
must NOT increment. They sit in the bottom table beside merges that DO count,
with nothing marking the difference.

DO:
  1. ONE location: the bottom table. Delete the bullet list as a counting
     surface; keep prose inside a table cell.
  2. ONE key: the merge SHA. Never a PR number, never an issue number.
  3. ONE new boolean column, `counts`, computed by the classifier the audit
     ALREADY EXPORTS AND DISCARDS: isProductionFile (merge-ledger-audit.ts:87).
     classifyDiff runs on every audit invocation and the result is thrown away
     at passReport.
  4. Extend ci:merge-ledger to assert the ROW SHAPE and that `counts` agrees
     with its own classifier.

GUARD: do NOT make the audit write the counter number. Its header at
merge-ledger-audit.ts:39-43 argues correctly that an audit asserting that
judgement on every PR is wrong. It asserts the row; the pass reads the count.

ALSO CORRECT THE RECORD: the 08-24 pass's process finding #1 credited
ci:merge-ledger with counter correctness. The audit explicitly declines that
job. The audit is working; the counter was never in its scope.
```

---

## H8 — The two chrome families stop drifting · **LOW**

```
Repo: RepWorth. Branch from `main`. Draft PR first.

Read first: docs/reviews/PATHFINDER-2026-08-26/03-unified-proposal.md  U5

THIS IS NOT ONE COMPONENT. Landing and Island are two design systems with
different tokens and different chrome. DO NOT build a shared <Nav>.

What is NOT specialization, and has ALREADY diverged visibly:
  1. Disclosure behaviour — LandingExperience.tsx:132-150 vs SiteNav.tsx:51-77.
     Same state, toggle ref, closeMenu, open-gated Escape. Diverges only on
     window vs document listener. Extract useDisclosure; both keep their markup.
  2. Footer column ORDER — LandingFooter.tsx:206-219 renders
     features, howItWorks, pricing; SiteFooter.tsx:53-57 renders
     features, pricing, howItWorks. SAME SITE, TWO ORDERS. marketing-links.ts
     already owns the link facts; it must own the order too.
  3. Heading level — h2 (LandingFooter.tsx:40-59) vs h3 (SiteFooter.tsx:19-35).
     That is an accessibility fact, not a design choice. Pick one.

ALSO: BrandLogo.tsx:15-19 claims to be the "single owner of public/logo.svg".
False — SiteNav.tsx:89, SiteFooter.tsx:44 and global-error.tsx:74 render it
directly. Either make the claim true or delete it.
```

---

## Not carried forward

**The `#3a` dangling reference.** Nine weeks live, one substantive hit
(`ws4-trust-dial-veto-window-design.md:260`), still false, no issue ever opened.
Its sibling `#3b` — same era, same kind of identifier — is tracked in four
places including two production files.

H1 of the 08-24 pass already said *"open a real issue or delete the dangling
reference"* and it was not done. **Do not carry it a third time.** It is folded
into H4, whose PR deletes the false sentence as part of the work it describes.

The process rule it was meant to establish — *a follow-up named in a spec gets
an issue number in the same PR, or it does not get named* — was proposed by the
08-24 pass and not adopted. It belongs in `CLAUDE.md`, not in another pass's
findings document.
