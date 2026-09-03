# Review triage — feat/1086-dashboard-info-tips

Reviewed SHA `af89487f` · fork point `d50e270e` · production diff **354 lines**

Wave: spec-correctness + standards-maintainability (the second axis joined because 354 > the 300-line threshold). Risk is `normal`, so the wave carried no red-team member; the waiver is recorded from the signed-off intake.

**25 findings — 22 ACCEPT, 3 REJECT.** Rejection reasons are in the deviations file under D7.

```
round 1 · spec-correctness · REVISE
  F1 medium ACCEPT · Average-rating tip says reviews 'received'; the query buckets on when the review was WRITTEN (src/components/dashboard/kpi/ReputationHeroBand.tsx:158)
  F2 medium ACCEPT · Average-rating tip hardcodes 'last 30 days' but the component also renders on /dashboard/analytics with a 7d/30d/90d/12w selector (src/components/dashboard/kpi/ReputationHeroBand.tsx:159)
  F3 medium ACCEPT · Rep Pulse tip states 70/30 unconditionally; repPulseScore renormalises rating to 100 when responseRate is null (src/components/dashboard/kpi/RepPulseCard.tsx:36)
  F4 medium ACCEPT · 'Guardian reads every review' is false: triage skips positive-sentiment reviews and the lane is flag-gated (src/components/dashboard/NeedsAttentionList.tsx:125)
  F5 medium ACCEPT · Intake edge case requiring aggregate scope covered or a stated reason is unmet and unrecorded (docs/superpowers/plans/feat-1086-dashboard-info-tips-deviations.md)
  F6 medium ACCEPT · Panel overflows the viewport above 768px; the gutter-spanning fix is gated at max-width 768px (src/app/(authenticated)/_styles/console.css:3010)
  F7 low ACCEPT · The LiveRegion promise is discharged by a test on a component that mounts no LiveRegion (src/components/dashboard/kpi/__tests__/RepPulseCard.test.tsx:141)
  F8 low ACCEPT · The 'associated with the element it describes' test proves only that the trigger describes itself (src/components/ui/__tests__/InfoTip.test.tsx:111)
  F9 low ACCEPT · A CSS comment names the wrong containing block; .section-enter keeps a persisting transform (src/app/(authenticated)/_styles/console.css:3082)
  F10 low ACCEPT · Deviation D1 cites useMenuPopover.ts:127-131; the preventDefault is at 131 and the length check at 133 (docs/superpowers/plans/feat-1086-dashboard-info-tips-deviations.md)
round 2 · standards-maintainability · REVISE
  M1 medium ACCEPT · Hover handlers sit on the button, not the container, so the panel is unreachable by pointer (WCAG 1.4.13 Hoverable) (src/components/ui/InfoTip.tsx:135)
  M2 medium ACCEPT · useHasHover re-implements src/hooks/useMediaQuery.ts, which already has a hover-capability caller with a DIFFERENT predicate (src/components/ui/InfoTip.tsx:14)
  M3 medium REJECT · The dismissal machinery is a near-verbatim copy of useMenuPopover, comment included (src/components/ui/InfoTip.tsx:82)
  M4 medium ACCEPT · The trigger focus ring computes to 1.44:1 on the inverted deep panel (WCAG 1.4.11 needs 3:1) (src/app/(authenticated)/_styles/console.css:3002)
  M5 medium ACCEPT · Outside-dismissal listens on mousedown only; iOS Safari does not synthesise it for a tap on a plain div (src/components/ui/InfoTip.tsx:105)
  M6 medium ACCEPT · docs/directory.md claims every host section is aria-labelledby its h2; the hero is a plain div with no h2 and its tips sit inside a label span (docs/directory.md:516)
  M7 low ACCEPT · The panel declares an opacity transition that can never run, then suppresses it under reduced motion (src/app/(authenticated)/_styles/console.css:3028)
  M8 low ACCEPT · The LiveRegion test asserts nextElementSibling adjacency, so a harmless subtitle would fail a test about announcements (src/components/dashboard/kpi/__tests__/RepPulseCard.test.tsx:138)
  M9 low ACCEPT · The three no-tip pins are negative assertions coupled to InfoTip's private sr-only string (src/components/dashboard/__tests__/AgentTeamStrip.test.tsx:155)
  M10 low ACCEPT · The test whose point is that copy cannot drift from the arithmetic hardcodes the arithmetic (src/components/dashboard/kpi/__tests__/RepPulseCard.test.tsx:127)
  M11 low ACCEPT · The mobile block comment states a false mechanism for the static position of an abspos flex child (src/app/(authenticated)/_styles/console.css:3047)
  M12 low ACCEPT · A host-component class is defined 800 lines from its siblings and reads as the BEM parent of an unrelated class (src/app/(authenticated)/_styles/console.css:3060)
  M13 low ACCEPT · Four different structural mechanisms for the same job, with no stated rule for which to use (docs/directory.md:516)
  M14 low REJECT · A Console-only primitive lives in the folder that otherwise holds the public-site shell and fails silently outside .rw-console (src/components/ui/InfoTip.tsx)
  M15 low REJECT · The Console design of record gains no entry for the Console's newest primitive (docs/design/console/DESIGN.md)
```
