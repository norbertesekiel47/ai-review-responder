# Deviations — feat/1086-dashboard-info-tips

Every departure from the plan or the intake, with the reason and who approved it.

## D1 — InfoTip owns its dismissal instead of reusing `useMenuPopover`

**Plan said:** assumption 1 named a primitive with hover, click, `Escape` and
`aria-describedby`. It did not name a hook.

**What the code does:** `src/components/ui/InfoTip.tsx` implements outside-click
dismissal, `Escape` with focus restored, and Tab-to-close itself.

**Why.** `docs/design/console/DESIGN.md` § Action surfaces names
`useMenuPopover` the single owner of popover behavior. Three facts made reuse
wrong here:

1. The hook calls `event.preventDefault()` on Arrow/Home/End **before** it
   checks whether any `menuitem` exists
   (`src/components/dashboard/shell/useMenuPopover.ts:127-131`). A tip has none,
   so reuse would swallow arrow-key page scrolling for no gain.
2. It focuses a `[role^="menuitem"]` on open. A tip has none.
3. `src/components/ui/` has never imported from `src/components/dashboard/`.
   No lint rule blocks it, but the convention holds across every file.

The DESIGN.md rule is written about **menus** (`aria-haspopup="menu"`). A tip is
a disclosure. `InfoTip.test.tsx` carries a regression guard —
"does not swallow arrow keys while it is open" — so the reason cannot rot.

**Approved by:** the owner, on a three-option choice, 2026-09-03.

## D2 — `allowed_edit_surface` amended to admit six test files

**Intake said:** `tests_to_add` requires "every covered surface names what its
number means" and "adding a tip does not move an existing LiveRegion in the
tree". Neither could be written: no dashboard test file was in
`allowed_edit_surface`.

**What changed:** six existing test files were added to both intake copies.

    src/components/dashboard/__tests__/ReputationHeroBand.test.tsx
    src/components/dashboard/__tests__/PendingApprovalsStrip.test.tsx
    src/components/dashboard/__tests__/AgentTeamStrip.test.tsx
    src/components/dashboard/__tests__/NeedsAttentionList.test.tsx
    src/components/dashboard/kpi/__tests__/RepPulseCard.test.tsx
    src/components/dashboard/kpi/__tests__/WeeklyRecapCard.test.tsx

No production file was added. `.feature/intake.json` and the committed copy stay
byte-identical; `state.json` carries the new `intakeSha256` and
`surfaceAmendments: 1`.

**Approved by:** the owner, 2026-09-03.

## D3 — Response rate gets no tip

**Plan said:** assumption 3 named six surfaces, not six numbers.

**What the code does:** the hero carries two tips, not three. Response rate has
none.

**Why.** Assumption 4 — a tip is warranted only when a better label will not do.
Response rate already carries `RESPONSE_RATE_PERIOD_CONTEXT` as a sentence under
the stats (`src/components/dashboard/kpi/response-rate-copy.ts`). A tip would
repeat it.

**Approved by:** the owner, at the T3 checkpoint, 2026-09-03.

## Defects found during T3, fixed in the same tracer

- **`replace_all` matched one branch of two.** The two `pulse-head` blocks in
  `RepPulseCard.tsx` differ in indentation, so the scored card silently got no
  tip while the ramping card got one. Found by counting tips in the rendered
  HTML, not by reading the diff.
- **Panels overflowed at 390px.** `left: 0` plus an 18rem clamp pushed the panel
  past the right edge and widened the page to 488px. Fixed by a
  `max-width: 768px` rule that spans the page gutters. Verified: the rendered
  page is exactly 390px.
