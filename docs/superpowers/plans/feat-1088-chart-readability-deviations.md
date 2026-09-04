# Deviations — feat/1088-chart-readability

## Surface overlap with feat/1087-import-offer-arrangement

Both branches claim `src/app/(authenticated)/_styles/console.css`.

**Agreed order: #1087 lands first, this branch rebases onto it.** #1087 has
code on the branch; this one had none at the time the order was agreed
(2026-09-04, phase `plan_approved`, prep commits only). #1087's edit is confined
to the banner block — four rules appended after `.banner-blue .banner-cta:hover`,
plus one `max-width: 640px` media query — so a textual conflict with the chart
block is unlikely and a semantic one is not possible.

**Resolved 2026-09-04.** #1087 merged to `main` as `dec98bab`. This branch
rebased its three prep commits onto `origin/main` before any chart code was
written, so the overlap closed at zero cost — no gate result, fingerprint or
review round existed to void.

## #1086 landed while this branch was parked

Four #1086 commits are now on `main`, including the info-tip affordance and its
coverage guard `src/components/dashboard/__tests__/info-tip-coverage.test.tsx`.
Plan assumption 3 ("a label beats a tooltip") is therefore checkable against
real code rather than forecast. The boundary itself does not move: charts take
no info tips, and a missing unit stays a LABEL fix owned here.

## The plan's headline measurement is FALSE. Corrected here.

The plan opens with: *"Four of five charts carry no `aria-label`, no `<title>`
and no `role="img"`. To a screen reader they are nothing at all."* That is the
stated justification for the whole ticket, and it does not survive reading the
files.

The grep behind it searched for `aria-label`, `role="img"` and `<title>`. It
missed the pattern two of the charts actually use, and it misread a third.

**Every one of the five charts is reachable by a screen reader today.**

| Chart | Reachable? | Mechanism |
|---|---|---|
| `VelocityChart` | yes | `<table className="sr-only">` + `<caption>Review velocity history</caption>`; the SVG is `aria-hidden="true" focusable="false"` (L76–L98) |
| `RankingChart` | yes | same pattern, `<caption>Search ranking history</caption>` (L72–L98) |
| `ReputationTrendChart` | yes | `role="img"` + `aria-label` (L91–L92) |
| `RecentRatingBreakdown` | yes | per-row `aria-label` on each `<li>`, visuals `aria-hidden` (L40) |
| `RecentSentimentMix` | yes | same per-row pattern (L55) |

`.sr-only` is Tailwind v4's built-in visually-hidden utility (`globals.css:1`
imports `tailwindcss`), so those tables are hidden from sight and present in the
accessibility tree. `VelocityChart` and `RankingChart` therefore expose the FULL
data series as a table — a stronger affordance than the `aria-label` summary the
plan proposed to copy onto them, not a weaker one.

**Consequence: tracer T2 ("the four silent charts get names and descriptions")
has no work in it and is void as written.** No chart is silent.

## What the goal DOES still buy, measured

The intake `goal` and all four `user_visible_behavior` lines survive intact —
only the plan's measurement and T2 fall. The real gaps, each verified in the
files:

1. **No `sr-only` caption states a window.** "Review velocity history", "Search
   ranking history", "Review velocity by location" — a screen-reader user gets
   every number and no period. The on-screen "last N weeks" lives in the card
   header (`VelocityCard.tsx:27–29`, `AggregateVelocityCard.tsx:56–58`), outside
   the table and unassociated with it. This is `user_visible_behavior` line 3,
   and it is the largest genuine gap.
2. **`VelocityChart`'s y-axis ticks are unitless** — bare `0`, `max/2`, `max`
   (L111–L118). The sr-only cells say "N reviews", so the screen reader gets the
   unit and the sighted reader does not. Same in `StackedVelocityChart`
   (L147–L154). This is `user_visible_behavior` line 2.
3. **The aggregate and per-location velocity charts disagree about week
   labels.** `VelocityChart` renders `weekShortLabel`; `StackedVelocityChart`
   puts the raw ISO `weekStart` in its row headers (L129) and draws no x labels
   at all. This is `user_visible_behavior` line 4 and invariant 2.
4. **`RecentRatingBreakdown` and `RecentSentimentMix` state DIFFERENT windows
   while sitting side by side** — "Across N reviews in the selected period" (the
   windowed aggregate, #405) versus "Share of your N most recent reviews" (the
   recent sample). Both are honest alone and confusing together. Presentation
   only; neither number changes.
5. **`RankingChart` states no window anywhere**, on screen or in the caption.
6. **Neither `Recent*` chart carries a chart-level name** — the rows speak, the
   chart does not. Adding one must not make the rows speak twice.

## Empty series: the intake edge case contradicts a deliberate design

The intake lists *"Empty series: the chart must still say what it would have
plotted."* Both `Recent*` charts deliberately `return null` at `total === 0`
(`RecentRatingBreakdown.tsx:22`, `RecentSentimentMix.tsx:39`), each with a
docblock saying it renders nothing "so the caller can drop the slot cleanly".
`ReputationTrendChart` does the opposite and renders an empty-state sentence
(L82).

The two cannot both be satisfied without a decision.

**Owner decision, 2026-09-04: `return null` wins.** The existing design is
deliberate and both docblocks say so. The intake edge case is SUPERSEDED for
these two charts: the CALLER owns the empty slot, and a chart that renders
nothing is the contract, not an oversight.

The edge case is not dropped — it is re-pointed. `ReputationTrendChart` DOES
render an empty state (L82: "Not enough reviews yet to chart a trend"), and that
sentence names neither the unit nor the window it would have covered. That is
where the promised test earns its keep.

`tests_to_add` line 3 keeps its VERBATIM title — the gate's `promised-tests` row
matches on the title string, and retitling it would trade a real check for a
green row. Only its target narrows, and a retitle would be a deviations entry
rather than a surface amendment in any case.

## T1

### BLOCKER: the intake's two test-directory surfaces admit no file

`.feature/intake.json` declares T1's whole edit surface as two bare directory
paths:

```
"src/components/dashboard/charts/__tests__",
"src/components/dashboard/kpi/__tests__",
```

`edit-surface-guard.sh` matches with bash `[[ "$REL_PATH" == $GLOB ]]`. Those two
entries carry no wildcard, so they match ONLY the literal directory string and
can never match a file inside it. Writing
`src/components/dashboard/kpi/__tests__/chart-readability.test.tsx` is blocked,
and so would be an edit to the existing `VelocityChart.test.tsx`. **T1 is
declared as tests-only and its declared surface permits zero test files.**

Reproduced against the committed intake: replaying the guard's own escape +
match loop over every `allowed_edit_surface` entry yields no match for either a
new or an existing file under those directories.

This is a spelling bug, not scope drift. `scripts/ci/feature-surface-audit.ts`
independently fails an entry that "match(es) NO file (tracked at HEAD or changed
on this branch)" — both entries are in that class today, so the audit would fail
this branch at merge even if nothing were written. The fix is the trailing glob
the guard's own comment prescribes (`'*' crosses '/' here`):

```
"src/components/dashboard/charts/__tests__/*",
"src/components/dashboard/kpi/__tests__/*",
```

Narrowing-or-correcting a spelling so an entry matches the files it was always
meant to match is the amendment the audit text calls for, but it is an intake
change and needs owner sign-off — T1 did not make it. Both intake copies
(`.feature/intake.json` and the committed
`docs/superpowers/plans/feat-1088-chart-readability-intake.json`) need it.

### The five promised tests are written, typechecked, and verified red

The suite was authored in full and run out-of-tree (scratchpad vitest config,
`root` pinned to the worktree so the `@` alias, `vitest.setup.ts` and the JSX
transform are the repo's own). No repo file was written.

| Promised title | Result | Why |
|---|---|---|
| `every dashboard chart exposes an accessible name` | **FAIL (intended)** | `['RecentRatingBreakdown', 'RecentSentimentMix']` carry no chart-level name — G6 |
| `every dashboard chart states the window it covers` | **FAIL (intended)** | `['VelocityChart', 'RankingChart', 'StackedVelocityChart']` — G1, G5 |
| `a chart with an empty series still says what it would plot` | **FAIL (intended)** | the empty state reads "Not enough reviews yet to chart a trend." — names neither unit nor window |
| `a per-location chart and its aggregate peer describe the same measure identically` | **FAIL (intended)** | stacked row headers are raw ISO `['2026-06-01', '2026-06-08', '2026-06-15']` — G3 |
| `no chart changes the values it plots` | **PASS** | the regression pin, green today |

`pnpm exec tsc` over the file is clean. The two existing test directories are
green at 11 files / 55 tests without it.

Draft file, ready to move once the surface is corrected:
`<scratchpad>/chart-readability.test.tsx` → destination
`src/components/dashboard/kpi/__tests__/chart-readability.test.tsx`.

### Two decisions recorded inside the suite

1. **Test 2 runs over the four plotted charts, not all six surfaces.** The two
   `Recent*` charts have no chart-level name at all, so including them would
   have made test 2 re-fail G6 rather than G1/G5. Their window disagreement is
   G4 and is pinned by test 4 instead.
2. **Test 3 uses eight weekly buckets each carrying `starEquivalent: null`,**
   not `trend={[]}`. That is a real window with an empty series — the chart
   knows the span it would have covered — whereas `[]` would let the fix
   satisfy the test with the meaningless "last 0 weeks".

### Surface amendment 1 of 2 — applied 2026-09-04, owner-approved

Both intake copies now read `src/components/dashboard/charts/__tests__/*` and
`src/components/dashboard/kpi/__tests__/*`. Counted:
`surfaceAmendments=1`. **One amendment remains before the abort trigger fires,
so no further surface change may be spent casually.**

Verified after the change: replaying the guard's own escape-and-match loop
admits both a new file and the existing `VelocityChart.test.tsx`, and no
`allowed_edit_surface` entry matches zero files any more. The Write into
`src/components/dashboard/kpi/__tests__/chart-readability.test.tsx` then
succeeded, which is this run's step-4 enforcement spot check: the guard binds
for the editor tools, and it bound on a path the amendment had just admitted.

**Replay this under `bash`, never `zsh`.** The guard is `#!/usr/bin/env bash`.
The Bash tool here runs zsh, whose `[[ ]]` does not treat an unquoted parameter
as a glob the same way, so a zsh replay reports NO MATCH for a correct
`.../__tests__/*` entry — a false negative that reads exactly like the real bug
it is meant to diagnose. Wrap the replay in `bash -c '…'`.

### G4 was overstated. Corrected here.

T1's draft asserted the two `Recent*` charts must state the SAME window phrase.
That cannot be built: `RecentRatingBreakdown` reads the windowed
`RatingBreakdown` aggregate (#405) and `RecentSentimentMix` derives from the
recent-review sample, so a single shared phrase would mean changing what one of
them computes — forbidden by invariant 1 and by the presentation-only line. A
later tracer could only have satisfied it by falsifying a label.

The assertion now requires each to state a window and the two to stay visibly
distinct. **That passes today**, which is the honest finding: both charts
already state their window, and the two already differ. So G4 drives no change
— it is a regression pin, guarding against a later tracer collapsing the two
into one phrase or dropping one. **G3 is the only red in that title.**

The original six-gap list overstated G4 as a gap. G1, G2, G3, G5 and G6 stand.

## Owner decision on the plan itself

**2026-09-04: revise the plan in place, intake unamended.** Every `goal` line,
`user_visible_behavior` line and invariant survived the corrected measurement —
only the plan's prose measurement and its T2 slice were wrong. That makes this a
deviations entry, NOT a surface amendment, so `incr-amendment` is not called and
the abort budget is untouched.

(The surface amendment recorded above is a SEPARATE matter — a spelling bug in
the intake, found by T1, not a consequence of the plan revision.)
