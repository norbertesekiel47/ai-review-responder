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
| 390 | 390 | 507 / 95 | 239 / 268 | 239 / 268 |
| 641 | 641 | 153 / 346 | 192 / 261 | 180 / 519 |
| 768 | 768 | 153 / 473 | 153 / 388 | 153 / 388 |
| **769** | **517** | 250 / 190 | **447 / 105** | **200 / 363** |
| 820 | 568 | 211 / 241 | 310 / 156 | 200 / 414 |
| 900 | 648 | 192 / 321 | 211 / 236 | 180 / 494 |
| 1440 | 1188 | 114 / 809 | 114 / 776 | 114 / 776 |

At 769px the first fix produced **exactly the pathology it was written to
remove** — a 105px ribbon of text running the full height of a 447px banner —
one breakpoint over from where I screenshotted.

**Fix.** Delete the breakpoint. `.banner--top` wraps at every width and
`.banner--top .banner-copy { flex: 1 1 50% }` decides when: a percentage
`flex-basis` resolves against the **container**, so the actions take their own
row whenever the banner's inner width falls under ~620px, wherever that happens.
One rule, no magic pixel, and it follows the column instead of the window.

**Why 50% and not a pixel floor.** A fixed basis cannot satisfy both ends: the
icon and copy only share a row at 360px if the basis is ≤ 244px, and the actions
only wrap at 900px if it is > 274px. Swept 200/220/240/260/300/320/360px and
50/55/60% — every pixel value loses one end or the other; 50% wins both because
it scales.

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
outranked every author selector and so silently suppressed it. Restored exactly,
and no wider, with `:not(:disabled)`.

**F6.** Handled above — D1's table and the docstring numbers are re-measured in
`.content--dash`.

**Reclassify (gate WARN, not a review finding).** 121 production lines against an
`estimated_prod_lines` of 60. Re-classified and unchanged: `small` / `normal` /
`ui` / `db_touching: false`. The estimate was made against the plan's one-rule
fix; D1 and D5 needed four. No dependency, migration, flag or worker surface is
involved, and the rollback is still "revert the squash commit".
