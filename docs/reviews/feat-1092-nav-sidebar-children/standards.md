# Standards & Maintainability review — feat-1092-nav-sidebar-children

| | |
|---|---|
| SHA read | `cacfa521` ("test(#1092): execute the moved Review QR page") |
| Merge base | `862a039d1a9ffc1f2f7b048eb4d9b4101fa13fa9` |
| Measured production diff | **535 lines** — **above the 300-line threshold**, which is why this axis is in the wave |
| My recount (`git diff --numstat -M`, `src/` only) | 532 changed lines total; **156 of them non-test production**, 376 test |
| Posture | `thermo-nuclear-code-quality-review` (invoked), applied against `.claude/CLAUDE.md` + `docs/directory.md` |
| Method | Committed tree only (`git show cacfa521:<path>`, `git diff <merge-base>..cacfa521`). Read-only; no edits, no staging, no commits. |

Rename note: 7 files are a `git mv` from `settings/review-qr/` to `dashboard/requests/qr/`.
With `-M` the move costs ~14 lines of path rewrite. I weighted the genuinely new
code (Sidebar children, the CSS marker, `RequestsTabs`' third link, four new test
files) far more heavily, and separately audited every moved file for edits made
during the move — findings 7 and A6 come out of that audit.

---

## Verdict

The feature is small, the shape is broadly right, and the split — desktop = sidebar
children, mobile = routed pills, one breakpoint governing both — is a genuinely good
decision, not a workaround. Two things stop this from being a clean pass:

1. **The mechanism that makes the whole feature work is a hand-typed CSS class at
   three call sites, and two of the three are unpinned by any test.** The new CSS
   source test proves the *stylesheet* is right and says nothing about the
   *components*. That is the enforcement gap of the change.
2. **A structural a11y/visual defect is newly replicated into the Analytics
   section**: parent row and self-child both mark themselves current.

Both have obvious code-judo remedies that also delete duplication rather than
rearrange it. Neither is a blocker for correctness-of-behaviour today; both are the
kind of thing that quietly stops being true on the next edit.

---

## Findings

| severity | file:line | finding |
|---|---|---|
| high | `src/components/dashboard/shell/Sidebar.tsx:135-141` | On `/dashboard/analytics` the `Analytics` NavItem and the `Metrics` NavChild both render `aria-current="page"` and `.active` — two current-page markers in one nav |
| high | `src/components/dashboard/reviews/ReviewsTabs.tsx:21`, `src/components/dashboard/analytics/AnalyticsTabs.tsx:26` | The `tabs--routed` marker is a hand-typed string at 3 sites; no test asserts it on 2 of them, so dropping it leaves the suite green and restores the desktop double-nav #1089 forbids |
| medium | `src/app/(authenticated)/dashboard/requests/RequestsTabs.tsx:19`, `src/components/dashboard/reviews/ReviewsContent.tsx:76,122` | The marker hides the inner `<nav>` but not its layout row (`.rq-subnav` / `.reviews-subnav`, both `padding: 20px 32px 0`), leaving an empty 20px strip on desktop and silently re-flowing the `space-between` row on `/dashboard/reviews/history` |
| medium | `src/components/dashboard/shell/Sidebar.tsx:112,120` | `solicitationEnabled` is spelled twice across two sibling JSX nodes to keep a child group from outliving its parent row — the exact trap the comment at :117 names; the sibling `SettingsSidebar.tsx:31` already has the canonical table-driven form |
| medium | `src/app/(authenticated)/_styles/__tests__/routed-tabs-breakpoint.test.ts:59-63` | Test titled "uses ONE breakpoint number" asserts a selector *count*, not a breakpoint: changing `768px`→`900px` still passes, and a harmless third `.tabs--routed` rule fails a working feature |
| low | `src/app/(authenticated)/dashboard/requests/qr/page.tsx:3-9` | The moved page's header comment still calls the surface a "Review QR **settings** section" with "the STANDARD **settings** posture" and a `shouldShowLocationsSettings` caveat that no longer means anything under Requests |
| low | `src/components/dashboard/shell/Sidebar.tsx:124-125` | A 7-line comment on a 1-line `NavChild` justifies an omission by citing `RequestsClient.tsx:209` — accurate at `cacfa521` (verified), unguarded, and rots on the next edit to that file |

---

## Detail

### 1. Two `aria-current="page"` in the Analytics section — high

`NavItem` marks itself active from `activeNav === section`; `NavChild` marks itself
active from `pathname === href`. Both are true simultaneously whenever a section's
self-child points at the section root:

- `Analytics` (`href="/dashboard/analytics"`, section `analytics`) — `Sidebar.tsx:135`
- `Metrics` (`href="/dashboard/analytics"`) — `Sidebar.tsx:140`

On `/dashboard/analytics`, `deriveNavSection` returns `analytics` and `pathname ===
href`, so both links render `aria-current="page"` and `class="… active"`. A screen
reader announces two current pages in one `nav[aria-label="Main"]`; visually two rows
light at once.

This directly contradicts two comments this codebase wrote about itself:

- `active-nav.ts:7-8` — "Returning ONE section instead of a set of independent
  booleans also defines away the invalid state where two rows highlight at once."
- `Sidebar.tsx:22-23` — "Pairing className and aria-current here keeps the visual
  active state and the assistive-tech current-page state from drifting."

It is not newly *invented* here — the Reviews pair (`Reviews` / `Needs Action`,
`Sidebar.tsx:100,106`) predates the branch. But this diff **replicates it into
Analytics**, and the branch's own `Sidebar.test.tsx:279-291,313-327` renders exactly
these states without asserting `aria-current` on either row, so the suite is blind to
it. The Requests comment at `:122-128` even reasons about "two identical links to the
same href" as a thing to avoid — and then Reviews and Analytics do it anyway with
different labels. The stated rationale is about the *name*, not the duplicate href;
the comment overstates what the omission buys.

**Remedy.** Give `NavChild` the parent's activeness: when the child href equals the
section root, suppress `active`/`aria-current` on the *parent* row (the child is the
finer-grained truth), or take the current marker from a single derivation shared by
both. Either way it should be one decision in one place, not two components each
computing "am I current?" from a different input.

### 2. The marker class is unenforced at 2 of 3 sites — high

The entire mobile/desktop split hangs off one literal:

```
src/app/(authenticated)/dashboard/requests/RequestsTabs.tsx:20   nav className="tabs tabs--routed"
src/components/dashboard/analytics/AnalyticsTabs.tsx:26          nav className="tabs tabs--routed"
src/components/dashboard/reviews/ReviewsTabs.tsx:21              nav className="tabs tabs--routed"
```

Tests that pin it: `requests-tabs.test.tsx:38-41` and `qr/__tests__/page.test.tsx:92`
— both `RequestsTabs`. `ReviewsTabs.test.tsx` and `AnalyticsTabs.test.tsx` were not
touched by this branch and assert hrefs/labels only. `routed-tabs-breakpoint.test.ts`
reads `console.css` off disk — it can never observe a component.

**Concrete failure.** Someone refactors `ReviewsTabs` to a `clsx`/template className
(or adds a conditional class and rewrites the literal) and drops `tabs--routed`.
`pnpm test` is green: `ReviewsTabs.test.tsx` still finds its two links,
`routed-tabs-breakpoint.test.ts` still finds two `.tabs--routed` rules in the CSS.
The Reviews pill bar reappears on desktop beside the sidebar children — the double
navigation #1089 exists to prevent — and nothing catches it until a human looks at a
1440px screenshot.

**Code judo.** The three components are the same component with different data. All
three are: `nav.tabs.tabs--routed[aria-label]` containing N × `Link.tab[.active]
[aria-current]`. Collapse to one:

```tsx
// src/components/dashboard/shell/RoutedTabs.tsx
export function RoutedTabs({ label, items, active }: {
  label: string;
  items: ReadonlyArray<{ key: string; href: string; label: string }>;
  active: string;
}) { … }
```

`ReviewsTabs`/`AnalyticsTabs`/`RequestsTabs` become three data arrays. This deletes
the three-way className duplication *and* the three-way `active === '…' ? 'active' :
''` + `aria-current` duplication the task asked about in `RequestsTabs`, makes the
marker structurally impossible to forget, gives the `active` prop one place to be
typed against its item keys, and reduces "does a fourth routed bar get scoped
correctly?" from a review question to a compile-time one. One test on `RoutedTabs`
then covers all three bars.

This is the "delete complexity rather than rearrange it" move. The current diff
rearranged it: it took three copies of a nav bar and gave each of them a fourth
duplicated literal.

### 3. The hide boundary is not the layout boundary — medium

`.tabs--routed { display: none }` hides the `<nav>`. The row that positions it is a
different element, and it still renders:

- `RequestsTabs.tsx:19` — `<div className="rq-subnav">` wraps the nav and has no other
  children. `requests.css:26-32` gives it `padding: 20px 32px 0`. On desktop, every
  Requests-family page (including the newly moved `/dashboard/requests/qr`) paints an
  empty 20px strip between the TopBar and the content.
- `ReviewsContent.tsx:76` and `:122` — `<div className="reviews-subnav">` with
  `<ReviewsTabs>` as its only child. `console.css:794-803` gives it the same
  `padding: 20px 32px 0`. Same empty strip on `/dashboard/reviews`.
- `reviews/history/page.tsx:45-58` — `.reviews-subnav` here also holds
  `.reviews-showing`, and the row is `justify-content: space-between`. With the tabs
  gone the "Showing: <location>" text silently slides from the right edge to the left.
  Nobody decided that; it fell out of hiding a flex child.

Analytics is clean — `AnalyticsTabs` is rendered without a wrapper row
(`AnalyticsContent.tsx:46`, `AnalyticsAggregateView.tsx:46`,
`AnalyticsPerLocationView.tsx:56`), and a `display:none` element contributes no
margin.

**Maintenance failure.** The wrapper's spacing now governs desktop layout on pages
that show no subnav at all. A future tweak to `.rq-subnav { padding }` moves desktop
content for a row that is invisible there — an edit whose effect is impossible to
predict from the rule being edited. Put the marker on the row (`rq-subnav
tabs--routed`, `reviews-subnav tabs--routed`), or have the routed-tabs component own
its own row so the unit that appears and disappears is one element.

Note this also means the `.rq-subnav` / `.reviews-subnav` desktop-vs-mobile behaviour
is now *not* covered by the new CSS test, which only reasons about `.tabs--routed`.

### 4. Duplicated flag guard across sibling nodes — medium

```
Sidebar.tsx:112  {solicitationEnabled && (            ← parent row
Sidebar.tsx:120  {solicitationEnabled && activeNav === 'requests' && (   ← child group
```

The comment at `:117-119` states the invariant precisely — "Children hang from the
flag-gated parent, never beside it: a Review QR row under a hidden Requests row would
be a route with no visible way back." The implementation enforces it by remembering
to type `solicitationEnabled &&` twice, in two sibling JSX expressions separated by
seven lines. A comment is doing the work of a structure.

The task asked whether the three near-identical child blocks want a data-driven table
or whether explicitness is correct. **I commit to: the table.** Not on
duplication-aesthetics grounds — three blocks is a defensible amount of
explicitness — but because of this specific guard. Nesting `children` inside the item
they hang from makes the invariant unrepresentable:

```ts
const NAV: NavRow[] = [
  { section: 'dashboard', href: '/dashboard', icon: 'home', label: 'Dashboard' },
  { section: 'reviews',   href: '/dashboard/reviews', icon: 'inbox', label: 'Reviews',
    badge: 'pending',
    children: [{ href: '/dashboard/reviews', label: 'Needs Action' },
               { href: '/dashboard/reviews/history', label: 'All Reviews' }] },
  { section: 'requests',  href: '/dashboard/requests', icon: 'trend', label: 'Requests',
    gate: 'solicitation',
    children: [{ href: '/dashboard/requests/contacts', label: 'Contacts' },
               { href: '/dashboard/requests/qr', label: 'Review QR' }] },
  { section: 'analytics', … },
];
```

One `gate`, consumed once at render. The repo already has this exact shape one
directory over — `SettingsSidebar.tsx:24-53` (`interface NavGroup`, `NAV_GROUPS:
NavGroup[]`, `NAV_GROUPS.flatMap`), which is also where this branch *deleted* the
Review QR row (`SettingsSidebar.tsx:45`, one line, no ceremony — the payoff of the
table form, demonstrated in the same diff). Using the imperative form in one nav and
the declarative form in its sibling is architectural drift, and CLAUDE.md's working
rules point at reusing the canonical shape rather than normalizing drift.

Two honest counter-arguments, neither decisive: (a) the three blocks differ (badge on
Reviews, gate on Requests, no self-child on Requests) — but all three are ordinary
optional fields; (b) "no abstractions for a single caller" — there are three callers
plus a precedent, so it does not apply. The one real cost is that the deliberate
absence of a Requests self-child stops being visible as an absence; that belongs in a
comment on the `requests` row, which is where it already effectively is.

### 5. The breakpoint test asserts the wrong thing — medium

`routed-tabs-breakpoint.test.ts:59-63`:

```ts
it('uses ONE breakpoint number, not a second copy', () => {
  const routedRules = consoleCss.match(/\.tabs--routed/g) ?? [];
  expect(routedRules.length).toBe(2);
});
```

The title claims a breakpoint invariant; the body counts selector occurrences. The
two are not the same property:

- **Passes while broken**: edit the media block to `@media (max-width: 900px)`. Count
  is still 2 → green. The sidebar now hides at 768px and the pills return at 900px,
  so between those widths both navigations are on screen. That is precisely the
  "two navigation models disagreeing about the boundary" the test says it prevents.
  (The *previous* test, `:49-57`, does catch this — it locates the media block that
  hides `.sidebar` and asserts `.tabs--routed` is restored inside it. That is the real
  guarantee, and it is good. This one adds nothing on top of it.)
- **Fails while working**: add `.rq-subnav .tabs--routed { margin-bottom: 0; }`, or
  the finding-3 remedy which moves the marker onto the row selectors. Count becomes
  3+ → red, with a failure message about breakpoint numbers that has nothing to do
  with what the author did.

**Answering the task's question directly on the file as a whole:** the CSS
source-scanning seam is *reasonable*, and the header comment justifies it correctly —
jsdom does not evaluate media queries, so a render test genuinely cannot observe this
rule. Tests `:41-47` and `:49-57` are good: they assert the two behaviours that
matter (hidden at base, restored inside the same block that hides `.sidebar`) and the
`sidebarBreakpointBlock()` helper couples them to `.sidebar` rather than to a literal
number, which is the right coupling. It is test `:59-63` specifically that is a
brittle string match, and `:66-73` that is near-vacuous (see appendix). Delete both;
keep the first two.

### 6. Moved-file comment now describes the wrong home — low

`dashboard/requests/qr/page.tsx:3-9` was carried across the `git mv` unchanged except
the path on line 1:

```
// Review QR settings section (CONTEXT.md "Review QR"): one card per
// non-archived location. Deliberately NOT behind shouldShowLocationsSettings
// … the STANDARD settings posture (intake edge case corrected in codex R1);
```

The change whose entire point is "this is no longer a settings section" leaves the
file telling its next reader that it is one. "Deliberately NOT behind
`shouldShowLocationsSettings`" was a meaningful caveat when the page sat in Settings
next to the Locations row; under `/dashboard/requests` it is a comparison to nothing.
"The STANDARD settings posture" now needs the reader to know what the settings
posture is in order to understand a page that is not in settings.

Contrast with `settings/review-qr/page.tsx:1-8`, which the same commit rewrote
carefully, and with `qr/print/[businessId]/page.tsx`, whose header survives the move
correctly because it never described its neighbourhood. Rewrite the moved page's
header to say why the surface lives under Requests and that `requireOwnerAccess` is
the standard authenticated-owner posture.

### 7. Line-number citation in a comment — low

`Sidebar.tsx:124-125`: `The Requests screen is titled "Requests"
(\`RequestsClient.tsx:209\`)`. I checked: at `cacfa521`, `RequestsClient.tsx:209` is
`title="Requests"`. It is true today. It has no guard, and the global rule this repo
operates under is "re-check cited line numbers and doc claims against current HEAD
before repeating them" — a citation nobody can re-check cheaply is one that quietly
becomes a lie. Cite the symbol (`RequestsClient`'s `TopBar title`), which survives any
edit above it.

---

## On the two questions I was asked that did not produce table findings

**Comment density.** Justified, with one exception (finding 6). The 13-line
`console.css:2334-2346` block explains *why* a marker class rather than bare `.tabs`,
and *why* both rules sit at one boundary — neither is recoverable from the two
declarations it precedes, and the second point is the load-bearing decision of the
whole feature. `Sidebar.tsx:47-56` and the `RequestsTabs.tsx:35-38` comment likewise
carry information the code cannot. The `:122-128` block is the longest per line of
code, but it documents an *absence*, which is the one thing a reader can never infer
from the file. This is the house style and the new comments meet it.

**Are the new tests behaviour or implementation?** Mostly behaviour, and better than
the branch needed. `qr/__tests__/page.test.tsx` executes a server component that was
previously never executed and asserts three real things — that it mounts, that it
renders the mobile-only path to its siblings, and (`:110-115`) that the location read
is scoped to the account `requireOwnerAccess` returned, which is invariant #8 stated
as a test rather than a comment. `Sidebar.test.tsx:313-327` ("the Requests section and
its children are hidden when solicitation is disabled") and `:329-338` ("opens only
the ACTIVE section") assert the two invariants that matter, as absences. The
`SettingsSidebar.test.tsx` rewrite converting a presence assertion into an absence
assertion, rather than deleting the test, is exactly right and the comment explaining
why is worth its length. The weak spots are the two noted above and in the appendix.

---

## Appendix — low-confidence / style, deliberately NOT in the table

These have no concrete failure scenario or no named standard behind them. They are
preferences; treat accordingly.

- **A1.** `NavChild` uses exact `pathname === href`, so on
  `/dashboard/requests/qr/print/[businessId]` the Requests parent lights but no child
  does. Defensible (the print view is a leaf outside the child set) and pre-existing
  semantics; noted only because the print route is newly under a section that now has
  children.
- **A2.** `sidebarBreakpointBlock()` (`routed-tabs-breakpoint.test.ts:26-38`) does a
  raw balanced-brace scan that is not comment-aware. A future CSS comment containing
  `{` inside the scanned media block would mis-terminate it. Low probability; the
  failure would be loud, not silent.
- **A3.** `routed-tabs-breakpoint.test.ts:66-73` ("does not hide the bare `.tabs`
  container") asserts that `.tabs { display: flex; … }` does not say `display: none`.
  Near-vacuous — no plausible edit makes it fail without also failing several render
  tests.
- **A4.** `active-nav.test.ts:56-59` ("no longer treats a Review QR path as a Settings
  path") asserts `!== 'settings'` on a pathname the line above already asserted
  `=== 'requests'` for. Redundant. Both new cases are pins on unchanged
  `deriveNavSection` behaviour (the `/dashboard/requests` prefix already covered
  `/qr`), which is fine as documentation but worth knowing they test no new code.
- **A5.** `Sidebar.tsx:106` changes the label `"Needs action"` → `"Needs Action"`. It
  aligns the child with the tab name (UX audit D16) and is almost certainly right, but
  it is a casing change riding along in a navigation-restructure diff.
- **A6.** Audit of the moved files for edits beyond the path rewrite: `PrintButton.tsx`
  and `PrintButton.test.tsx` are byte-identical (100% similarity). `ReviewQrClient.tsx`
  (98%) changes exactly one href. `ReviewQrClient.test.tsx` (97%) changes exactly the
  matching assertion. `print/[businessId]/page.tsx` (92%) changes three lines: the
  header path, the `PrintButton` import, and the `rightLink` back-href — all mechanical
  and all mirrored in `print-page-source.test.ts`. Nothing hid inside the move except
  the stale header comment on the new `page.tsx` (finding 6). Clean.
- **A7.** `qr/page.tsx` keeps `rightLink={{ href: '/dashboard', label: 'Back to
  dashboard' }}` from its Settings life. Under Requests, "back" arguably now means
  `/dashboard/requests`. UX call, not a standards one — flagging for the UX axis.
- **A8.** `qr/__tests__/page.test.tsx` mocks six modules to render one server
  component. It works and the assertions are real, but the mock surface is large enough
  that a future refactor of the page's imports will fail the test for reasons unrelated
  to the page's behaviour.
