# Review — SPEC & CORRECTNESS axis · feat/1092-nav-sidebar-children

- **SHA read:** `cacfa521` (`test(#1092): execute the moved Review QR page`)
- **Merge base:** `862a039d` — diff read via `git diff 862a039d..cacfa521`
- **Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1092-nav-sidebar-children`
- **Mode:** read-only. Committed tree only; the working tree was not consulted.

## Inputs used

- `docs/superpowers/plans/feat-1092-nav-sidebar-children-intake.json` (locked scope contract)
- `docs/superpowers/plans/feat-1092-nav-sidebar-children.md` (plan)
- `docs/superpowers/plans/feat-1092-nav-sidebar-children-deviations.md` (D1–D5, all ACCEPT)
- `docs/reviews/feat-1092-nav-sidebar-children/blast-radius.md`
- `CONTEXT.md` § "Review QR — locked 2026-08-26" (**Review QR**, **QR redirect**)
- `.claude/reference/env-vars.md` (`SOLICITATION_WATCH_ENABLED`), `docs/eservices-variables.md`
- Full source of every changed file plus the untouched neighbours they depend on:
  `console.css`, `settings.css`, `requests.css`, `(authenticated)/layout.tsx`,
  `settings/layout.tsx`, `MobileTabBar.tsx`, `active-nav.ts`,
  `dashboard/requests/{page,contacts/page}.tsx`, `AskList.tsx`,
  `dashboard/add-location/page.tsx`.

---

## Contract check — field by field

### `invariants`

| Invariant | Verdict | Evidence |
|---|---|---|
| Every sub-route reachable on a phone today stays reachable on a phone | **PASS (CSS), with a caveat** | `console.css:2347` `.tabs--routed{display:none}` sits at line 2347, AFTER the base `.tabs{display:flex}` at `console.css:1462` and at equal specificity (0,1,0), so it wins on desktop. `console.css:2354` restores `display:flex` inside the same `@media (max-width:768px)` block that hides `.sidebar` (line 2353) and is later still, so it wins below the breakpoint. `.reviews-subnav .tabs` (804) and `.rq-subnav .tabs` (`requests.css:33`) are higher-specificity but set only `margin-bottom`, so they cannot resurrect the bar. All three bars carry the marker (`ReviewsTabs.tsx:21`, `AnalyticsTabs.tsx:26`, `RequestsTabs.tsx:20`). The four routes each have a live pill: history and restraint from their siblings' bars, contacts + qr from `RequestsTabs`. **Caveat:** `/dashboard/requests/qr` is reachable on a phone only while `SOLICITATION_WATCH_ENABLED` is on — see finding **S2**. |
| `deriveNavSection` remains the single owner; Sidebar and MobileTabBar both read it | **PASS** | `src/components/dashboard/shell/active-nav.ts` is byte-unchanged in the diff. `Sidebar.tsx:74` and `MobileTabBar.tsx:25` both call it. No second `startsWith` chain was introduced. |
| `GET /q/[businessId]` and `src/lib/locations/review-qr.ts` untouched | **PASS** | Neither path appears in `git diff --stat`. `src/app/q/[businessId]/route.ts` still imports `resolveQrRedirect` from the unmoved module. The QR **payload** (`qrTargetUrl` = `<app>/q/<businessId>`) is produced by that module, so printed codes are unaffected. |
| Requests section and all children hidden when the solicitation flag is off | **PASS structurally** | `Sidebar.tsx:112` gates the parent on `solicitationEnabled`; `Sidebar.tsx:117` gates the children block on `solicitationEnabled && activeNav === 'requests'` — the child group cannot outlive the parent. Pinned by `Sidebar.test.tsx` "the Requests section and its children are hidden when solicitation is disabled". The *consequence* of that gate is finding **S2**. |
| Exactly one nav row highlights for any pathname | **PASS at the section level** | `deriveNavSection` returns one `NavSection`. Two *elements* carry `aria-current="page"` on `/dashboard/analytics` (parent row + `Metrics` child) — see the low-confidence appendix; the same shape already shipped for Reviews. |
| The 768px boundary is read from the existing rule, never re-spelled | **PASS** | One `@media (max-width: 768px)` block in `console.css` carries both `.sidebar{display:none}` and `.tabs--routed{display:flex}`. `routed-tabs-breakpoint.test.ts` pins exactly two `.tabs--routed` occurrences and asserts they live in the same block as the `.sidebar` hide. |

### `user_visible_behavior`

| Promise | Verdict | Evidence |
|---|---|---|
| Above 768px Reviews/Requests/Analytics render no pill bar | **PASS** | `.tabs--routed{display:none}` base rule; all three bars marked. |
| Sidebar lists Needs Action / All Reviews, Contacts / Review QR, Metrics / Restraint | **PASS** | `Sidebar.tsx:105-107`, `:127-131`, `:138-141`. Three `Sidebar.test.tsx` cases assert label + href. Requests deliberately has no self-child (deviation D1). |
| At/below 768px each page still renders its bar; Requests gains a third pill | **PASS** | `console.css:2354`; `RequestsTabs.tsx:41-47` adds the `Review QR` pill; `requests-tabs.test.tsx` asserts all three hrefs. |
| Review QR answers at `/dashboard/requests/qr`, print at `/dashboard/requests/qr/print/[businessId]` | **PASS (routing)** | Both files exist under the new tree; the old ones are gone. Contents are byte-identical to the originals except the three self-referential paths. **But see S1** — the page's stylesheet does not follow it. |
| Old `/settings/review-qr` redirects rather than 404s | **PASS for the parent only** | `settings/review-qr/page.tsx:12-13` calls `redirect('/dashboard/requests/qr')`; `redirect.test.ts` pins the target. The nested print path gets nothing — finding **S4**. |
| Settings sidebar no longer lists Review QR | **PASS** | `SettingsSidebar.tsx:44` row deleted; `SettingsSidebar.test.tsx` now asserts absence. |

### `edge_cases`

| Case | Verdict |
|---|---|
| Flag off → Requests parent + children all absent | Holds. The *unstated* consequence is S2/S3. |
| Moved QR path folds to `requests`, not the dashboard catch-all | **PASS** — `active-nav.ts` `/dashboard/requests` prefix; `active-nav.test.ts` pins `/dashboard/requests/qr` and `/dashboard/requests/qr/print/abc-123`. |
| Bare `/settings` still highlights `SETTINGS_DEFAULT_HREF` | **PASS** — `SETTINGS_DEFAULT_HREF` untouched, still `/settings/voice`. |
| Aggregate scope still reaches Review QR; surface decides eligibility | **PASS** — page reads `getOwnerReviewQrLocations(sql, access.accountId, …)`, scope-independent. |
| Ineligible location gets the explanatory card | **PASS** — `ReviewQrClient.tsx` ineligible branch unchanged; `ReviewQrClient.test.tsx` covers it. |
| `ContactsClient` / `ReviewsContent` render the bar in **both** branches | **PASS** — `ContactsClient.tsx:45` and `:73`; `ReviewsContent.tsx:76` (aggregate) and `:122` (per-location). |

### `non_goals` — none violated

`ReviewsTabs`/`RequestsTabs`/`AnalyticsTabs` retained; `/q/[businessId]` and
`subscriptionAllowsQrRedirect` untouched; `MobileTabBar` gained no children row;
`SETTINGS_DEFAULT_HREF` unchanged; `.tabs`/`.tab` not hidden (`routed-tabs-breakpoint.test.ts`
asserts the bare `.tabs` rule carries no `display:none`) and `CardViewTabs`
(`CardViewTabs.tsx:73`, class `card-view-tabs`, no `tabs--routed`) still renders
on desktop; the solicitation flag's meaning is unchanged.

### `allowed_edit_surface`

Every changed path is on the (thrice-amended) surface. The amendments are
recorded in D3/D4 and are all test paths. One plan claim did not materialise and
did not need to: the plan said the `past-reply-card-states.test.tsx:422`
reachability assertion "moves to the sidebar", but that file is not in the diff.
It still passes (jsdom applies no CSS, and `ReviewsTabs` still renders the link),
and the guarantee is separately pinned in `Sidebar.test.tsx`. Not a defect.

### Drift — in the diff but not named in `user_visible_behavior`

- `Sidebar.tsx:106` — the Reviews self-child label changed `Needs action` →
  `Needs Action`. Justified (it now matches the pill it opens, UX audit D16) but
  it is a user-visible string change the contract does not name. Listed as **S7**.
- Everything else in the diff is either named, a test, a doc, or the internal
  `tabs--routed` marker.

---

## Findings

Only findings I would stake >=80% confidence on. Everything softer is in the appendix.

| severity | file:line | finding |
|---|---|---|
| high | `src/app/(authenticated)/dashboard/requests/qr/page.tsx:11-39` | **S1 — the moved page renders unstyled: its stylesheet did not move with it.** `ReviewQrClient` is built from `SettingsShell` + `.settings-content` / `.set-section` / `.set-section-head` / `.set-section-icon` / `.set-section-title` / `.set-section-sub` / `.settings-body-copy` / `.field` / `.field-label` / `.field-hint`. **Every one of those classes is defined only in `src/app/(authenticated)/_styles/settings.css`** (lines 4, 17, 27, 33, 46, 52, 76, 103, 108, 116), which is imported only by `src/app/(authenticated)/settings/layout.tsx:5` — `(authenticated)/layout.tsx:30-31` loads just `tokens.css` + `console.css`. The repo already states this in prose: `src/app/(authenticated)/dashboard/requests/AskList.tsx:335-336` — "`.btn-danger` lives in `settings.css`, **which the requests route never loads**". Scenario: an owner loads `https://app…/dashboard/requests/qr` directly (or via the `/settings/review-qr` redirect) with an empty CSS cache → no card, no border, no padding, no icon chip, no code-block styling; the QR images and text render flush against the canvas. No test can see this (jsdom applies no CSS; `qr/__tests__/page.test.tsx` only asserts DOM presence). Fix precedent already in-tree: `src/app/(authenticated)/dashboard/add-location/page.tsx:22` imports `settings.css` explicitly for exactly this reason. |
| medium | `src/components/dashboard/shell/Sidebar.tsx:112-133` | **S2 — with the flag in its production state, Review QR ends up with zero navigation entry points.** `SOLICITATION_WATCH_ENABLED` is off by default (`.claude/reference/env-vars.md:676` "default off/unset everywhere"; `docs/eservices-variables.md:218` ⬜). After this change: the sidebar's Requests parent AND the `Review QR` child are both behind `solicitationEnabled` (`Sidebar.tsx:112`, `:117`); `MobileTabBar.tsx:44` hides the Requests tab on the same flag; and the Settings row was deleted (`SettingsSidebar.tsx`, Account group). The QR route itself is *not* flag-gated, so the surface still exists — reachable only by typing the URL. Scenario: prod today, flag off, owner wants to reprint a counter QR → there is no link to it anywhere in either nav. This also falsifies `CONTEXT.md:136`, which this very PR rewrote and which still asserts "The surface is visible to every owner — deliberately NOT behind `shouldShowLocationsSettings`". The intake's edge-case line anticipates the mechanism but not this consequence, and no `user_visible_behavior` entry covers it. |
| medium | `src/app/(authenticated)/dashboard/requests/qr/page.tsx:35` | **S3 — the pill bar on the QR page offers two dead links when the solicitation flag is off.** `RequestsTabs` unconditionally renders links to `/dashboard/requests` and `/dashboard/requests/contacts`; both pages call `notFound()` when `solicitationWatchEnabled()` is false (`dashboard/requests/page.tsx:14`, `dashboard/requests/contacts/page.tsx:14`). Since `qr/page.tsx` has no such gate, an owner who reaches `/dashboard/requests/qr` with the flag off (the prod default — via the `/settings/review-qr` bookmark redirect) sees, below 768px, a three-pill bar where two pills 404. Violates the standard this very component's sibling states in `ReviewQrClient.tsx:38-40`: "that route 404s when the multi-location flag is off … no owner may ever get a dead link." |
| medium | `src/app/(authenticated)/settings/review-qr/page.tsx:12` | **S4 — only the parent old path redirects; the old print path now 404s.** `settings/review-qr/print/[businessId]/page.tsx` was moved with no replacement left behind (confirmed by `git ls-tree -r cacfa521 -- 'src/app/(authenticated)/settings'` — the folder contains only `page.tsx` + its test, and there is no catch-all under `settings/`). Scenario: an owner with `/settings/review-qr/print/019db8c1-…` open in a pinned tab or bookmarked for reprinting hits 404, while `/settings/review-qr` redirects fine. The file's own rationale (lines 3-5, "a 404 on a page that worked yesterday reads as data loss") applies equally to the nested path and is not honoured there. |
| low | `src/app/(authenticated)/dashboard/requests/requests.css:26-32` | **S5 — the sub-nav wrappers keep their padding after their only child is hidden, leaving a stray band on desktop.** `.rq-subnav` sets `padding: 20px 32px 0` and its sole child is the now-`display:none` `<nav>` (`RequestsTabs.tsx:19-20`), so `/dashboard/requests`, `/dashboard/requests/contacts` and `/dashboard/requests/qr` render a 20px-tall empty row between TopBar and content above 768px. Same for `.reviews-subnav` (`console.css:794`) on `/dashboard/reviews`, where both branches put only the tabs inside it (`ReviewsContent.tsx:76`, `:122`). `/dashboard/reviews/history` is unaffected — it also renders `.reviews-showing` (`history/page.tsx:52`). Analytics is unaffected (the bar is a direct child of `.content--analytics`, no wrapper). |
| low | `src/components/dashboard/settings/SettingsSidebar.tsx:17,82-101` | **S6 — dead code left by the removed row.** Deleting the only `icon: 'qr'` entry makes `type NavIcon = IconName \| 'qr'` a widening no item uses and makes `NavGlyph`'s `if (icon !== 'qr') return <Icon …>` guard permanently true, so the ~18-line inline QR `<svg>` (with its `data-icon="qr"` hook) is unreachable. `SettingsSidebar.test.tsx:58` now asserts that glyph's absence, confirming nothing renders it. Repo rule: when deleting a surface, clean every cross-reference in the same change. |
| low | `src/components/dashboard/shell/Sidebar.tsx:106` | **S7 — undeclared user-visible string change (drift).** `Needs action` → `Needs Action`. It is an improvement (it now matches the `Needs Action` pill in `ReviewsTabs.tsx:26` and the `Sidebar.test.tsx` assertion), but no `user_visible_behavior` entry names a label change, so by the contract's own definition it is drift. Flagging for the record, not for reversal. |

---

## Low-confidence appendix (NOT findings — do not action without a decision)

- **`redirect()` is a 307, not a permanent redirect.** `settings/review-qr/page.tsx:3-4` describes the page as "a permanent redirect"; Next's `redirect()` in a Server Component issues a temporary redirect — `permanentRedirect()` is the 308 form. On an authenticated, noindexed route the practical difference is near zero, and the comment may simply mean "kept forever". Comment/behaviour mismatch only.
- **Two `aria-current="page"` on `/dashboard/analytics`.** The parent `Analytics` `NavItem` (`Sidebar.tsx:36-42`) and the `Metrics` `NavChild` (`Sidebar.tsx:60-66`) both mark themselves current. The identical shape already ships for Reviews / `Needs Action`, so this is an extension of an accepted pattern rather than a new defect; it is arguably in tension with the intake's "Exactly one nav row highlights".
- **The breakpoint test does not pin cascade order.** `routed-tabs-breakpoint.test.ts` asserts that both `.tabs--routed` rules exist and that the restore lives in the `.sidebar` block, but nothing asserts that the base rule stays *after* `.tabs{display:flex}` (`console.css:1462`). Moving the `.tabs` block below line 2347 would silently un-hide every routed bar on desktop with a green suite. A one-line index comparison would close it.
- **`docs/progresstracking.md:5321-5323`** still names `/settings/review-qr` + the `SettingsSidebar` entry as the Review QR owner surface. That file reads as an append-only historical log, so leaving it is probably correct — worth one confirmation given the repo's "grep the filename and fix every cross-reference" rule.
- **Stale "settings" wording in the moved files.** `qr/page.tsx:3` still says "Review QR **settings** section" and ":7" "the STANDARD **settings** posture"; `ReviewQrClient.tsx:3` says "Review QR settings client". Accurate about the visual system it borrows, misleading about where the page lives.
- **No visual proof at 390px / 1440px on the branch.** The global design rule asks for before/after screenshots at both widths before approval. Given S1 and S5 are both invisible to the test suite and visible in a browser, a screenshot pass is the cheapest way to settle them.
