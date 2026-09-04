# Deviations — feat/1087-import-offer-arrangement

## D1 — the plan named the wrong mechanism (T1)

**Planned.** The plan read the defect out of the CSS without rendering it, and
named it: `.banner-cta`'s `margin-left: auto` never reaches the button group, so
"the actions float mid-height **and drift left**, while every other banner's
action is pushed right." Assumption 1 followed from that: give the group a class
so it inherits the auto margin.

**What happened.** T1 rendered the offer state against the real `console.css`,
the real brand faces and the real `.rw-console > .shell > .main > .content`
geometry, at 390px and 1440px. Measured, before any change:

| | 390px | 1440px |
|---|---|---|
| banner height | **507px** | 114px |
| copy block width | **95px** | 809px |
| actions right edge | **355 — identical to `ConnectGoogleBanner`'s CTA** | **1377 — identical to `ConnectGoogleBanner`'s CTA** |

> **These numbers were corrected after review F6.** The T1 harness rendered the
> banner in `.content`; the dashboard renders it in `.content content--dash`
> (`DashboardContent.tsx:66`), which overrides both `max-width` and `padding`.
> Re-measured in the real container the conclusion is *stronger*, not weaker: the
> actions already matched `ConnectGoogleBanner`'s CTA edge at **both** widths, so
> "drift left" was wrong at 390px as well. Every number in this file and in the
> component docstring is now from `.content--dash`.

**Why the plan was wrong.** The actions do **not** drift left. The copy block is
a flex item with a large content width, so it already pushes the group to the
padding edge; at 1440px the group's right edge matched the canonical single-CTA
banner's to the pixel. The auto margin was never the missing piece. Three other
things were:

1. **No `flex-shrink: 0` on the group.** Three lines of copy squeeze it. At
   1440px both labels wrapped to two lines; at 390px nothing wrapped at all,
   because a flex item's default `min-width: auto` is its min-content width — so
   the copy was crushed to a 95px column and the banner grew to 507px.
2. **`align-items: center`** floated the actions at mid-height against a copy
   block four times their height. This half the plan had right.
3. **Two `margin-left: auto` CTAs inside one group.** Whenever the group has
   free space the two auto margins split it between themselves and the buttons
   drift apart. The plan's own fix would have caused this, and did — it appeared
   in the first prototype and was measured out.

**Adaptation.** Four additive rules rather than one: `.banner-actions` (the slot,
with `flex: 0 0 auto`), `.banner-actions .banner-cta { margin-left: 0 }`,
`.banner-cta { white-space: nowrap }`, and `.banner--top` +
`.banner--top .banner-copy { flex: 1 1 0; min-width: 0 }` for the vertical axis
and the phone wrap. Assumption 2 ("`align-items: flex-start` only where the copy
is multi-line") is honoured through the opt-in `.banner--top` modifier, so
`.banner` itself is byte-unchanged and the other seven states plus
`ConnectGoogleBanner` render exactly as before — verified in the same screenshot.

**Cost.** No surface amendment: every file touched was already in
`allowed_edit_surface`. Two class names the plan did not name (`.banner-copy`,
`.banner-cta--ghost`) and one media query. Every locked intake bullet is still
met, including the edge case "390px: the actions wrap below the copy rather than
being squeezed" — which the plan listed and the code did not do.

## D2 — the shell IS remounted between `offer` and `importing`

**Planned.** `tests_to_add` asked for "BannerShell occupies the same tree
position across importing and imported". T2 first wrote it as node identity
across `offer → importing`, the transition #1087 actually rearranges.

**What happened.** It failed. `ImportOfferBanner` returns `BannerShell` for
`offer` and `ImportStatusBanner` for `importing`, so React sees two different
component types at one position and replaces the whole subtree.

**Why this is not a defect.** The round-1 A6c contract is about the TERMINAL
announcement: the region must exist while the import runs and be the same node
when the message lands. `importing → imported` satisfies that, and the suite
already pins it by node identity (`renders the imported count and announces the
terminal transition through LiveRegion`). The `offer` state's announcement is
the empty string, so nothing is lost by remounting on the way in.

**Adaptation.** No intake retitle. The test keeps the promised title and now
earns it: it walks `offer → importing → imported`, asserts the shell's SHAPE at
each — `BannerShell` is the element at the return position, exactly one live
region exists, it is the shell's first child, and `OfferPrompt` renders the
inner `.banner` rather than nesting a second shell — and then asserts node
IDENTITY across `importing → imported`, which is the transition the contract is
about and which does hold.

Recorded here because a reader of the A6c doc could reasonably believe identity
holds across every transition. It does not, and it does not need to; the test's
comment says so at the point where someone would otherwise "fix" it.

**Mutation-checked, not asserted.** Reinstating an inline `style` on the
secondary action fails the right-aligned/inline-styled test and nothing else.
Nesting a second `BannerShell` inside `OfferPrompt` fails this test and nothing
else. Neither test is vacuous.

## D3 — `console.css` surface overlap with feat/1088-chart-readability

`scripts/feature-surface-check.sh` reports two armed worktrees claiming
`src/app/(authenticated)/_styles/console.css`:

- **feat/1086-dashboard-info-tips** — phase `shipped`. Already on `main` as
  #1117–#1120; this branch was rebased onto it before any code was written, so
  there is no live collision.
- **feat/1088-chart-readability** — phase `plan_approved`, **no code written**
  (`git log` shows the three prep commits only).

**Agreed order: #1087 lands first, #1088 rebases onto it.** #1087 has the code;
#1088 has none, so rebasing costs it nothing. The regions do not touch either —
#1087 appends after `.banner-blue .banner-cta:hover` in the banner block and
adds no rule outside it; chart readability works in the chart block. A textual
conflict is unlikely and a semantic one is not possible.


---

# Round 1 — spec/correctness review

One axis (measured production diff 120 lines, under the 300-line threshold;
`normal` risk, so the red-team member is waived). Six findings, **six ACCEPT**.
The reviewer did not read the CSS and reason about it — it measured the rendered
result in headless Chromium across 360–1440px, which is why it found two things
T1 did not.

## D4 — F1: "additive" was asserted over an enumeration one call site short

**What I claimed.** D1 and the component docstring both said the change "cannot
reach" any other banner, because `.banner` is byte-unchanged and the other rules
are scoped to `.banner--top` / `.banner-actions`.

**What was true.** One rule was NOT scoped: `.banner-cta { white-space: nowrap }`.
And there are **three** production `.banner-cta` call sites, not the two I
enumerated — `AutoApprovalClient.tsx:729` ("Turn off auto-posting") is neither an
`ImportOfferBanner` state nor `ConnectGoogleBanner`. Measured in
`.settings-content`, that banner went **133px → 212px** tall at 390px with its
copy crushed 167px → 93px, and **133px → 293px** at 360px with a 63px column.
The rule I wrote to *stop* a squeeze caused one somewhere else.

**Fix.** `.banner-actions .banner-cta { white-space: nowrap }`. The squeeze it
exists for only ever happened inside the group, so scoping costs nothing. The
selector now requires a `.banner-actions` ancestor, and `grep` finds exactly one
such element in the repo (`ImportOfferBanner.tsx:288`) — so the third call site is
unreachable by construction, not by inspection.

**The lesson, which is the transferable part.** I did grep — for the NEW class
names, which by definition had no other call sites. I never grepped the class the
rule actually selects. **Before claiming a rule touches only your component, grep
the selector, not the names you added.**

## D5 — F2: the wrap gate was on the wrong side of the sidebar breakpoint

**What I shipped.** `@media (max-width: 640px)` to give the actions their own row
on a phone.

**Why it was wrong.** The console's reading column is **not monotonic in viewport
width**. `.sidebar` is hidden at `max-width: 768px`, so the column is *widest* at
768px and *narrowest one pixel later* at 769px, when the 240px rail returns. A
viewport-width media query cannot express a container-width condition, and mine
sat on the wrong side of the worst case:

| viewport | column | fork h / copy | first fix h / copy | now h / copy |
|---|---|---|---|---|
| 360 | 360 | 585 / 78 | 258 / 238 | 263 / 238 |
| 390 | 390 | 507 / 95 | 239 / 268 | 243 / 268 |
| 641 | 641 | 153 / 346 | 192 / 261 | 185 / 519 |
| 700 | 700 | 153 / 405 | 192 / 320 | 192 / 320 |
| 768 | 768 | 153 / 473 | 153 / 388 | 153 / 388 |
| **769** | **517** | 250 / 190 | **447 / 105** | **204 / 363** |
| 820 | 568 | 211 / 241 | 310 / 156 | 204 / 414 |
| 900 | 648 | 192 / 321 | 211 / 236 | 185 / 494 |
| 1280 | 1028 | 114 / 682 | 133 / 616 | 133 / 616 |
| 1440 | 1188 | 114 / 809 | 114 / 776 | 114 / 776 |

**Where the branch is TALLER than the fork, and why.** 700px (+39px) and 1280px
(+19px) trade height for CTA labels that stay on one line — the defect the ticket
exists to remove. The fork bought its shorter banner by wrapping "Import my
reviews" onto two lines at 1440px and three at 390px. That trade is the ticket.

At 769px the first fix produced **exactly the pathology it was written to
remove** — a 105px ribbon of text running the full height of a 447px banner —
one breakpoint over from where I screenshotted.

**Fix.** Delete the breakpoint. `.banner--top` wraps at every width and
`.banner--top .banner-copy { flex: 1 1 50% }` decides when: a percentage
`flex-basis` resolves against the **container**, so the actions take their own
row whenever the banner's inner width falls under **621px** (1-pixel sweep,
560–1000px viewport), wherever that happens. One rule, no magic pixel, and it
follows the column instead of the window.

**Why 50% and not a pixel floor.** A pixel floor has to satisfy two opposing
constraints at once — the icon and copy must share a row at 360px, and the
actions must wrap at 900px — and the window between them, if it exists at all, is
a few pixels wide. Measured here the two bounds do not overlap: ≤235px keeps the
360px icon row, ≥239px wraps at 900px, and nothing satisfies both.

> **Round 2 measured that differently** (N2), finding 230px and 235px satisfy
> both. The disagreement is harness calibration, not arithmetic: its action group
> measures 249px against this harness's 242px, which moves both bounds. **Neither
> number is the point, and asserting one over the other would repeat the mistake.**
> A mechanism whose correctness turns on a 4-pixel window that shifts with font
> metrics and button label length is the wrong mechanism *whichever* harness is
> right. `50%` needs no window: it scales with the container, which is the
> property F2 was about.

Swept seven pixel floors (200/220/240/260/300/320/360px) and three percentages
(50/55/60%).

**Precedent.** This is the accepted #1086 finding verbatim: a gutter fix gated at
768px, proven with screenshots at 390 and 1440 that straddled it. **Two widths
either side of a breakpoint prove nothing about the breakpoint.** Evidence is now
a 14-width sweep, and the sweep is what belongs in a UI ticket's T1, not a pair.

## D6 — F3: the `failed` announcement was never read out

**What review found.** `ImportStatusBanner` early-returned `<FailedBanner />`
where its sibling returned `<BannerShell>`. React reconciles by component type at
a position, so that remounted the live region with the failure text already in
its first paint — the exact condition this file's own A6c doc says produces no
announcement. It is reached on the ordinary path (the `importing` poll returns
`failed`), and it is the message an owner most needs read to them.

**Pre-existing, and still mine to fix.** D2 examined this contract and cleared
only `offer → importing`. Leaving a hole exactly where the invariant breaks,
under a deviation that reads as having cleared it, is worse than not having
looked.

**Fix.** One `BannerShell` for all four post-offer states; `FailedBanner` renders
the inner `.banner` only, the same contract `OfferPrompt` keeps. `role="alert"`
and every visible string are unchanged.

**A nuance worth keeping, found by a mutation that did NOT fail.** My first
mutation kept `BannerShell` at the position and nested `FailedBanner` inside it —
the test passed, correctly. Only a **component-type change at the position**
breaks reconciliation; wrapping the inner content does not. The faithful
mutation (restore the early return of a different type) fails the new test.
**A mutation that passes is not evidence the test is weak until you have checked
the mutation is faithful.**

## D7 — F4: a test title that promised what jsdom cannot see

"the offer actions are right-aligned rather than inline-styled" — jsdom applies
no stylesheet, so the body asserts structure only, and F2 then proved alignment
was exactly the half that regressed. Retitled to "the offer actions sit in the
banner action slot rather than inline styles".

**`tests_to_add` amended in BOTH intake copies**, because `promised-tests` matches
titles as fixed strings. Not a surface amendment — `allowed_edit_surface` did not
move — so the amendment counter is untouched (#1092 precedent). Recorded
`intakeSha256` refreshed to match.

## D8 — F5, F6, and the reclassify verdict

**F5.** `.banner-blue .banner-cta--ghost:hover` lit up a *disabled* button.
`:hover` matches disabled elements; the old inline `background: transparent`
outranked every author selector and so silently suppressed it. Fixed with
`:not(:disabled)` — **which round 2 showed made it worse. See D9.**

**F6.** Handled above — D1's table and the docstring numbers are re-measured in
`.content--dash`.

**Reclassify (gate WARN, not a review finding).** After the review round: **215
production lines against an `estimated_prod_lines` of 60, and 181 test lines
against 90.** Re-classified and unchanged: `small` / `normal` / `ui` /
`db_touching: false`. The estimate was made against the plan's one-rule fix; D1
needed four rules, D5 replaced the strategy, and D6 restructured
`ImportStatusBanner`. Most of the production count is prose — the CSS block
carries more comment than declaration, because every rule in it now records a
measurement or a defect it exists to stop. No dependency, migration, flag or
worker surface is involved; the rollback is still "revert the squash commit".


---

# Round 2 — verification only

Same axis, verifying the six round-1 fixes rather than re-reviewing the branch.
Verdicts: **F1, F3, F4 HOLD. F2 and F6 HOLD WITH CAVEAT. F5 DOES NOT HOLD.**
Five new findings, all accepted.

> **A records note.** Round 2's findings are logged under round 1 in
> `.feature/review-transcript.jsonl`. `review-log.mjs round-start` rejected the
> axis name I passed (`spec-correctness-verify` is not in its enum) and the
> `finding` calls then appended to the round that was still open. The content is
> intact and the `N` prefix separates them; only the round number is wrong.

## D9 — N1: the F5 fix was worse than the defect it fixed

**What I wrote.** `.banner-blue .banner-cta--ghost:hover:not(:disabled)`, and in
both the CSS comment and D8: *"the class form needs this to say the same thing"*,
*"Restored exactly, and no wider."*

**What it did.** Both statements were false, and measurably so. Dropping the
ghost arm on a disabled button does not fall back to *nothing* — it falls through
to `.banner-blue .banner-cta:hover` (`console.css:1302`, 0-0-3-0), which is the
**primary** treatment and still matches a disabled button. Measured hover
background on the disabled ghost:

| | fork | first fix | `:not(:disabled)` |
|---|---|---|---|
| background | `rgba(0,0,0,0)` | `rgb(237,241,239)` | **`rgb(50,87,80)`** |

That is `--rw-accent-700` under `#5C6B72` muted text — **1.45:1 contrast**, worse
than both states before it. I had reasoned about which selector to *remove*
without checking what the removal exposed.

**Fix.** An override must be more specific than what it overrides, not merely
absent: `.banner-blue .banner-cta--ghost:disabled:hover` (0-0-4-0) beats
`.banner-blue .banner-cta:hover` (0-0-3-0) and sets `transparent`. Verified by
measuring the computed background on a disabled ghost button:
`rgba(0, 0, 0, 0)`, identical to the fork point. The primary button is unchanged
at all three SHAs — pre-existing, and out of scope, as both rounds recorded.

**The lesson.** `:not()` does not disable a declaration; it *un-shadows whatever
was underneath*. Before writing one, look at what is underneath.

## D10 — N5: an inert rule with a comment that claimed otherwise

Below ~296px of banner the 242px nowrap action group is wider than the banner and
`overflow: clip` on `.main` swallows the second button with no scroll to recover
it. I added `flex-wrap: wrap` to the group and wrote a comment saying it "puts
the buttons on two rows instead".

**It did nothing.** `flex: 0 0 auto` sizes the group to its own content, so its
line can never overflow and the wrap never engages. `max-width: 100%` is what
makes the group narrower than its content and gives the wrap something to do.
Measured with both: nothing clips at any width down to 260px, the buttons take
two rows at 260/280/296, and 320px upward is byte-identical without them.

Caught only because round 2 rewarded checking, and worth recording as its own
deviation: **a rule that does nothing, under a comment that says it does
something, is worse than no rule.**

## D11 — N3: a test whose assertion the named mutant walked past

The new `failed` test asserted live-region node *identity* across
`importing → failed`. Round 2 found the gap: a `FailedBanner` that nests a
**second** `BannerShell` inside the shared one leaves the outer node intact, so
identity still holds — two live regions, all 20 tests green.

Added `[aria-live]` and `.section-enter-2` length-1 assertions, and
mutation-checked with that exact mutant: it now fails, and only that test.

**Related, and the reason D6's lesson survives.** D6 recorded that only a
component-*type* change at the position breaks reconciliation. Round 2 verified
that claim true. The gap was never the lesson — it was that identity alone does
not enforce `FailedBanner`'s stated "renders the inner `.banner` only" contract.

## D12 — N2 and N4: the numbers, and what makes a number reproducible

**N4.** Round 2 could not reproduce several recorded measurements. Root cause: the
T1 harness omitted Tailwind preflight's `button { font: inherit }`, which the real
app loads via `globals.css`. Every wrapped row was ~4.5px short. The harness now
carries preflight and every table above is re-measured; the wrap threshold is
**621px**, not "~620px"; the arch-log said "eight pixel floors" where seven were
swept.

**N2 is recorded but not adopted** — see the box under D5. My bounds were wrong
and round 2's do not reproduce here either, because the two harnesses disagree on
the action group's width (242px vs 249px).

**The transferable part is not any of these numbers.** It is that an uncommitted
harness makes every absolute number in a permanent code comment unverifiable by
the next reader, and two careful people measuring the same branch got different
figures. So: the harness definition is now stated wherever numbers are cited —
`.rw-console > .shell > .sidebar + .main > .content content--dash`, the real
Gabarito/Figtree faces, Tailwind preflight's button reset — and the claims that
carry weight are **comparisons** (fork vs branch, equal or not), which held
across both harnesses, rather than absolutes, which did not.