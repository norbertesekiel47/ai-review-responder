# feat/1086 — dashboard info tips

Decision ticket [#1086](https://github.com/RepWorth/ai-review-responder/issues/1086) ·
build ticket [#1094](https://github.com/RepWorth/ai-review-responder/issues/1094) ·
map [#1084](https://github.com/RepWorth/ai-review-responder/issues/1084).

Owner's words, item 2: *"Add info tips to the dashboard wherever necessary to
help the user understand whats there, whats the information, how to do, etc."*

## Why this needed a decision at all

"Wherever necessary" is a goal, not a surface list, and **there is no primitive
to reuse**. `src/components/ui/` holds `BrandLogo`, `HeroWash`, `LiveRegion`,
`MarqueeBackground`, `PageShell`, `Reveal`, `SiteFooter`, `SiteNav`, `SiteShell`
and `be-ui-tilt-card`. No tooltip, no popover, no info affordance. So this
ticket designs a new shared component, which is why it was not simply built.

## The constraint that kills the obvious answer

**A hover tooltip is unreachable on a phone.** The Console hides `.sidebar`
below 768px and ships a `MobileTabBar`, so a meaningful share of use is touch.
Whatever is built opens on click/tap as well as hover, and is keyboard
reachable.

## Assumptions recorded, not asked

Reversible, per the intake contract's question policy. Override on resume.

1. **One primitive**, `src/components/ui/InfoTip.tsx` — a small trigger beside a
   heading that reveals short text. Hover to preview, click/tap to pin,
   `Escape` to close, `aria-describedby` to associate.
2. **Copy lives at the call site**, not in a central table. A tip is written
   about one surface and read next to it; a shared table drifts from what it
   describes.
3. **Six surfaces to start** — `ReputationHeroBand`, `RepPulseCard`,
   `WeeklyRecapCard`, `PendingApprovalsStrip`, `AgentTeamStrip`,
   `NeedsAttentionList`. Charts are deliberately excluded.
4. **The rule for "necessary"**: a tip is warranted when a number's meaning
   cannot be fixed by a better label. If a label would do, change the label.
   That makes "wherever necessary" testable instead of a matter of taste.

## The boundary with #1088

Charts get NO tips from this ticket. A missing unit or an unlabelled axis is a
labelling defect and belongs to #1088. Settle that boundary before either
builds, or the two tickets will fight over the same files.

## What must not break

- `LiveRegion` tree positions. Several surfaces depend on a region existing
  before its message; a tip inserted nearby must not move one.
- The complexity gate. Several dashboard components were split specifically to
  stay under it. Check `pnpm test:coverage && pnpm ci:fallow:coverage` — a bare
  `fallow audit` does not predict that gate.

## Suggested tracers

| # | Slice |
|---|---|
| T1 | Eval tests for the primitive's interaction and a11y contract |
| T2 | `InfoTip` + its Console styling |
| T3 | Three placements, screenshotted at 390px and 1440px for the owner |
| T4 | The remaining placements |
| T5 | Docs, directory row, merge ledger |
