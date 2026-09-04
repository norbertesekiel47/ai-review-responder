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

## The measurement, restated after re-verification

The plan's "four of five charts carry no accessible name" is correct **at chart
level**, but two of the four are not silent. `RecentRatingBreakdown` labels each
row (`aria-label` per `<li>`, with the visual spans `aria-hidden`), and
`RecentSentimentMix` does the same. Adding a chart-level name to those two must
not double-label the rows that already speak.
