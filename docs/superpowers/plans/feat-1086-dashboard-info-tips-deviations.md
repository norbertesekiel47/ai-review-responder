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
   (`useMenuPopover.ts` — `preventDefault()` at :131, the `items.length === 0`
   check at :133; cited by that ordering rather than a range, because a range is
   the artefact that goes stale first). A tip has none,
   so reuse would swallow arrow-key page scrolling for no gain.
2. It focuses a `[role^="menuitem"]` on open. A tip has none.
3. `src/components/ui/` has never imported from `src/components/dashboard/`.
   No lint rule blocks it, but the convention holds across every file.

The DESIGN.md rule is written about **menus** (`aria-haspopup="menu"`). A tip is
a disclosure. `InfoTip.test.tsx` carries a regression guard —
"does not swallow arrow keys while it is open" — so the reason cannot rot.

**Approved by:** the owner, on a three-option choice, 2026-09-03.
**Verdict:** ACCEPT — and re-affirmed under review: the maintainability axis
raised the same duplication as M3 and it was rejected on this record.

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
**Verdict:** ACCEPT — one amendment used of the one allowed without a stated
reason; `state.json` records `surfaceAmendments: 1`.

## D3 — Response rate gets no tip

**Plan said:** assumption 3 named six surfaces, not six numbers.

**What the code does:** the hero carries two tips, not three. Response rate has
none.

**Why.** Assumption 4 — a tip is warranted only when a better label will not do.
Response rate already carries `RESPONSE_RATE_PERIOD_CONTEXT` as a sentence under
the stats (`src/components/dashboard/kpi/response-rate-copy.ts`). A tip would
repeat it.

**Approved by:** the owner, at the T3 checkpoint, 2026-09-03.
**Verdict:** ACCEPT — the spec axis independently confirmed the sentence below
the stats already carries this explanation.

## D4 — two of the six planned surfaces carry no tip

**Plan said:** assumption 3 named six surfaces.

**What the code does:** four carry a tip. Five tips in total.

| Surface | Tip | Why |
|---|---|---|
| `ReputationHeroBand` | 2 | Average rating, Time saved |
| `RepPulseCard` | 1 | What the coined score is |
| `WeeklyRecapCard` | 1 | Which week a review counts in |
| `NeedsAttentionList` | 1 | What puts a review here; Guardian never posts |
| `PendingApprovalsStrip` | 0 | Its own sub-line already says what to do and roughly how long it takes |
| `AgentTeamStrip` | 0 | See below |

**`AgentTeamStrip` has a second reason.** Every card already names the agent,
states its role, its windowed activity and the window. The one fact still
unstated is whether an agent posts **without** the owner — and that depends on
the subscription tier and the autonomy flags, which this component never
receives. A static tip could only be true for one tier, so writing one would
trade a gap for a falsehood.

Both omissions are pinned by a test, so a later session cannot quietly add a
tip without meeting assumption 4 first.

**Verdict:** ACCEPT — the pins were strengthened under review (M9): they now
assert structurally, so rewording InfoTip's label cannot silently unpin them.

**Approved by:** the owner approved the same reasoning for Response rate at the
T3 checkpoint; these follow it. Reversible — say the word and either gets one.

## D5 — WITHDRAWN. The architecture review log gets its line on the branch

**This entry first said the opposite, and it was wrong.** It claimed the log's
counter increments on merge, so nothing was owed on the branch. The verify gate
failed `merge-ledger` on that reasoning.

`scripts/ci/merge-ledger-audit.ts` states the design in its own header:

> THE AUDIT RUNS ON THE MERGING PR, NOT ON A POST-MERGE SWEEP, and that is the
> whole design: "the sweep did not run" IS the failure mode, so a check that
> itself runs after the merge inherits it.

It triggers on any non-test file under `src/`, `worker/` or `supabase/` — this
branch changes six — and it requires **one added line**, not a counter edit.
The audit says so explicitly: "The counter number is NOT this audit's business
— leave it to the pass."

The bullet is written to match the form its four map-#1084 siblings use, and
`allowed_edit_surface` already admitted the file. No amendment was needed.

**Lesson for a resumed session:** the gate is the authority on what a branch
owes. A deviation that reasons *from* a doc's prose about when a rule applies
must be checked against the audit that enforces it.

**Verdict:** ACCEPT — the withdrawal stands; `ci:merge-ledger` passes and the
counter reads 15 after the #1082 rebase.

## Defects found during T3, fixed in the same tracer

- **`replace_all` matched one branch of two.** The two `pulse-head` blocks in
  `RepPulseCard.tsx` differ in indentation, so the scored card silently got no
  tip while the ramping card got one. Found by counting tips in the rendered
  HTML, not by reading the diff.
- **Panels overflowed at 390px.** `left: 0` plus an 18rem clamp pushed the panel
  past the right edge and widened the page to 488px. Fixed by a
  `max-width: 768px` rule that spans the page gutters. Verified: the rendered
  page is exactly 390px. **That fix was incomplete — the panel also overflowed
  ABOVE the breakpoint, which the review caught (F6) and `align="end"` fixed.**

**Verdict:** ACCEPT — both defects are fixed and each is covered by a check
that would catch a regression.

## D6 — the aggregate location scope carries no tip, and that is a decision

Intake `edge_cases[3]` required the aggregate card set to be covered **or given
a stated reason**. The spec review found neither, which is the half that was a
real defect: a later session could not tell whether the gap was chosen or
missed. The reason, recorded now:

Aggregate renders a **different metric under the same word**. Its "Time saved"
is lifetime and summed across locations; the per-location hero's is 30-day and
single-location. A tip written for one is false for the other, and this branch's
own rule — a tip must be true against the query, not the label — makes copying
it the wrong move. Covering aggregate honestly means writing new copy against
`AggregateKpiCards`, which is **not** in `allowed_edit_surface` and would need a
second surface amendment.

**Decision: aggregate is out of scope for #1086, deliberately.** It is the first
thing a follow-up ticket should take.

**Verdict:** ACCEPT — the intake asked for coverage OR a stated reason; this is
the stated reason.

## D7 — findings accepted from the review wave, and three rejected

The wave raised 25 findings across two axes. 22 were accepted and fixed on this
branch. The three rejections, with reasons, so they are not re-litigated:

**Verdict:** ACCEPT — every accepted finding is fixed and the gate is green on
the fixed tree; the three rejections carry reasons and are logged as owed
follow-up, not as silent dismissals.

- **M3 — the dismissal machinery duplicates `useMenuPopover`.** Correct, and
  already the subject of D1. The owner was shown this exact tradeoff as a
  three-option choice *before* implementation and chose "InfoTip owns a small
  disclosure" over "extract a shared `useDisclosurePopover` and have the menu
  hook compose it". The extraction also needs a second surface amendment —
  which `feature-state.sh` now refuses without a stated reason — and puts
  `AccountMenu` and `LocationPicker` in the blast radius of a presentation-only
  ticket. **Owed follow-up, not a defect to fix here.**
- **M14 — a Console-only primitive lives in `components/ui/`.** The reviewer
  filed it as a next-time placement call, not a change request: the intake fixed
  that path, so the branch could not have chosen otherwise. Moving it now buys
  zero behaviour change for one more amendment.
- **M15 — `docs/design/console/DESIGN.md` gains no entry for the new primitive.**
  Correct and owed. That file is **not** in `allowed_edit_surface`; editing it
  is a scope breach. Recorded here so it survives the merge.

### The three copy defects the wave caught

Worth naming, because they are the class this branch is most likely to
reintroduce. All three were tips that read plausibly and described the wrong
computation:

1. **Average rating** said reviews "received" in "the last 30 days". The query
   buckets on the Review-time anchor `LEAST(review_date, detected_at)` — when
   the review was *written* — and the component also renders on
   `/dashboard/analytics` under a 7d/30d/90d/12w selector, so the window was
   doubly wrong.
2. **Rep Pulse** stated 70/30 unconditionally. `repPulseScore` renormalises the
   rating to carry all 100 points when the response rate is null, and the "What
   moved it" list right below already renders `… / 100` — the tip contradicted
   the card by inches.
3. **Needs attention** said Guardian "reads every review". `runTriage` returns
   early on positive sentiment, and 4★/5★ are positive.

The second sentence of (3) — Guardian never replies and never posts — was
independently verified TRUE and unconditional, on any tier, and stands.

### One accessibility limit, recorded rather than hidden

`aria-describedby` is announced on focus. A screen-reader user in focus mode who
opens the tip with the trigger *already focused* hears the panel on the next
focus move, not on the keypress. Browse-mode users arrow into the now-unhidden
panel and it works. The trigger's accessible name ("What &lt;subject&gt; means")
carries the association either way. Fixing the focus-mode case properly wants a
live region, which would collide with the intake's own invariant about not
disturbing existing ones.
