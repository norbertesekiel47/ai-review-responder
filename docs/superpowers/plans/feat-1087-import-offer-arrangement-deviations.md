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
| copy block width | **95px** | 746px |
| actions right edge | 355 (banner ends 374) | **1337 — identical to `ConnectGoogleBanner`'s CTA** |

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

**Adaptation.** The new test asserts the invariant the intake actually locks —
`BannerShell` is the element at the return position, exactly one live region
exists, it is the shell's first child, and `OfferPrompt` renders the inner
`.banner` only rather than nesting a second shell. It runs that assertion in
both states. Recorded here because a reader of the A6c doc could reasonably
believe identity holds across every transition. It does not, and it does not
need to.

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
