# Review — spec / correctness · ROUND 2 (verification only) · feat/1087-import-offer-arrangement

| | |
|---|---|
| Round | **2 — verification only.** Not a fresh review. Scope is the six round-1 findings and anything a fix disturbed. |
| Post-fix SHA (under test) | **a68c0296** |
| Pre-fix SHA (what round 1 reviewed) | **98cf53c4** |
| Fork point (merge-base with origin/main) | **42078f3913ef0fa3fcaca70d62a8eee6684bf4c9** |
| Round-1 report | `docs/reviews/feat-1087-import-offer-arrangement/spec-correctness.md` |
| Gate at a68c0296 | `.feature/gate-status.json` — all PASS, `reclassify` WARN (expected, D8) |

> **Working-tree note.** `docs/superpowers/plans/feat-1087-import-offer-arrangement-deviations.md`
> carries one uncommitted edit at this SHA (the D8 reclassify paragraph, lines
> 235+). It is not mine — this round wrote nothing but this file. Every deviations
> line I cite is below 235 and is identical in the commit and the working tree.

**Widths swept (24):** 320, 360, 375, 390, 414, 430, 500, 600, 620, 640, 641,
700, 768, 769, 800, 820, 834, 900, 950, 1024, 1180, 1280, 1440, 1920.
Plus a 1-px sweep of the content column 700→820 for the wrap threshold, and a
narrow tail at 240/260/280/300/340 for overflow.

**Method — rendered, not read off the stylesheet.** Headless Chromium
(`@playwright/test@1.60.0` chromium) with, at each of three SHAs (fork / pre-fix /
post-fix): the real `tokens.css` + `console.css` + `settings.css` extracted via
`git show`, the real self-hosted brand faces from `src/app/fonts/`
(`gabarito-latin.woff2`, `figtree-latin.woff2`) bound to `--rw-font-display` /
`--rw-font-body` on `.rw-console`, Tailwind v4 preflight replicated from
`node_modules/.pnpm/tailwindcss@4.3.0/node_modules/tailwindcss/preflight.css`
(including `button { font: inherit }` — this matters, see N4), and the real
containers:

- offer banner → `.rw-console > .shell > .sidebar + .main > .content content--dash`
  (`src/app/(authenticated)/layout.tsx:181-199`, `DashboardContent.tsx:66`)
- auto-approval status banner → `.rw-console > .shell > .sidebar + .main > .settings-content`
  (`src/components/dashboard/settings/SettingsShell.tsx:37`, `settings.css:4`)

Behaviour claims were mutation-tested by running the branch's own suite against
three swapped component bodies (fork, pre-fix, and a hand-built nested-shell
mutant) through a scratchpad vitest config that aliases `../ImportOfferBanner`.
Nothing in the repo was modified; every artefact lives in the session scratchpad.

---

## Verdicts

| fix | verdict |
|---|---|
| F1 — `white-space: nowrap` rescoped to `.banner-actions .banner-cta` | **HOLDS** |
| F2 — media query deleted, `flex-wrap: wrap` + `flex: 1 1 50%` | **HOLDS WITH CAVEAT** |
| F3 — one `BannerShell` for all four post-offer states | **HOLDS** (one test-strength gap → N3) |
| F4 — test retitled, `tests_to_add` amended in both intake copies | **HOLDS** |
| F5 — `:not(:disabled)` on the ghost hover | **DOES NOT HOLD** → N1 |
| F6 — numbers re-measured in `.content--dash` | **HOLDS WITH CAVEAT** → N4 |

---

### F1 — HOLDS

`src/app/(authenticated)/_styles/console.css:1325`

```css
.banner-actions .banner-cta { margin-left: 0; white-space: nowrap; }
```

**(a) `/settings/auto-approval` `PolicyStatusBanner` is byte-identical to the fork
point at every width swept.** Measured in `.settings-content` with the real
`describePolicyStatus` copy for the `canTurnOff: true` branch (the only branch
that renders a `.banner-cta`, `AutoApprovalClient.tsx:728-731`). Banner height,
copy-column width, CTA width and CTA height match the fork point at all 24
widths. The pre-fix sheet is the outlier, exactly as round 1 said:

| viewport | fork h / copy / cta | **98cf53c4** h / copy / cta | **a68c0296** h / copy / cta |
|---|---|---|---|
| 320 | 296 / 103.1 / 78.9 | **738.5 / 19.5 / 162.5** | 296 / 103.1 / 78.9 |
| 360 | 215 / 143.1 / 78.9 | **518 / 59.5 / 162.5** | 215 / 143.1 / 78.9 |
| 390 | 194 / 173.1 / 78.9 | **336.5 / 89.5 / 162.5** | 194 / 173.1 / 78.9 |
| 430 | 153.5 / 212 / 80 | 255.5 / 129.5 / 162.5 | 153.5 / 212 / 80 |
| 769 | 153.5 / 256.8 / 90.2 | 174.5 / 184.5 / 162.5 | 153.5 / 256.8 / 90.2 |
| 1440 | 93.5 / 552.8 / 157.3 | 93.5 / 547.5 / 162.5 | 93.5 / 552.8 / 157.3 |

(My absolute numbers differ from round 1's 133/212 because the harnesses use
different `describePolicyStatus` inputs; the *fork ≡ post* equality is the claim
and it is exact.)

**(b) The rescoping is unreachable-by-construction, verified by grep of the
selector, not the names.** Exactly one `.banner-actions` element exists in
production (`ImportOfferBanner.tsx:288`); the other two `.banner-cta` call sites
(`AutoApprovalClient.tsx:729`, `ConnectGoogleBanner.tsx:46`) have no
`.banner-actions` ancestor. D4's claim reproduces.

**(c) The label wrap was not reintroduced inside the offer banner's own group.**
Post-fix button heights are `[35.5, 35.5]` — one text line each — at every one of
the 24 widths, and button widths are pinned at max-content `[146.2, 94.8]`. The
fork point wrapped both labels at 1440 (`[55, 55]` = 2 lines each) and wrapped
"Import my reviews" to three lines from 320 to 1180 (`[74.5, 55]`).

---

### F2 — HOLDS WITH CAVEAT

`console.css:1343` `.banner--top { align-items: flex-start; flex-wrap: wrap; }`
`console.css:1360` `.banner--top .banner-copy { flex: 1 1 50%; min-width: 0; }`

Full sweep, offer state, `.content--dash`, `hscroll = 0` at every width in all
three columns:

| vp | content col | fork h / copy | **98cf53c4** h / copy | **a68c0296** h / copy | actions wrapped (post) |
|---|---|---|---|---|---|
| 320 | 320 | 625 / 75.9 | 301.5 / 198 | 301.5 / 198 | yes |
| 360 | 360 | 625 / 75.9 | 262.5 / 238 | 262.5 / 238 | yes |
| 375 | 375 | 625 / 75.9 | 243 / 253 | 243 / 253 | yes |
| 390 | 390 | 526 / 90.4 | 243 / 268 | 243 / 268 | yes |
| 414 | 414 | 407.5 / 114.4 | 243 / 292 | 243 / 292 | yes |
| 430 | 430 | 349 / 130.4 | 243 / 308 | 243 / 308 | yes |
| 500 | 500 | 250 / 200.4 | 204 / 378 | 204 / 378 | yes |
| 600 | 600 | 191.5 / 300.4 | 184.5 / 478 | 184.5 / 478 | yes |
| 620 | 620 | 191.5 / 320.4 | 184.5 / 498 | 184.5 / 498 | yes |
| 640 | 640 | 152.5 / 340.4 | 184.5 / 518 | 184.5 / 518 | yes |
| **641** | 641 | 152.5 / 341.4 | **191.5 / 254** | 184.5 / 519 | yes |
| 700 | 700 | 152.5 / 400.4 | 191.5 / 313 | 184.5 / 578 | yes |
| 768 | 768 | 152.5 / 468.4 | 152.5 / 381 | 152.5 / 381 | no |
| **769** | **517** | 290.5 / 185.4 | **467.5 / 98** | **204 / 363** | yes |
| 800 | 548 | 230.5 / 216.4 | 349 / 129 | 204 / 394 | yes |
| 820 | 568 | 211 / 236.4 | 310 / 149 | 204 / 414 | yes |
| 834 | 582 | 191.5 / 250.4 | 310 / 163 | 204 / 428 | yes |
| 900 | 648 | 191.5 / 316.4 | 211 / 229 | 184.5 / 494 | yes |
| 950 | 698 | 152.5 / 366.4 | 191.5 / 279 | 184.5 / 544 | yes |
| 1024 | 772 | 152.5 / 440.4 | 152.5 / 353 | 152.5 / 353 | no |
| 1180 | 928 | 133 / 596.4 | 133 / 509 | 133 / 509 | no |
| 1280 | 1028 | 113.5 / 676.5 | 133 / 609 | 133 / 609 | no |
| 1440 | 1188 | 113.5 / 802.7 | 113.5 / 769 | 113.5 / 769 | no |
| 1920 | 1668 | 94 / 928.3 | 94 / 1249 | 94 / 1249 | no |

**The F2 pathology is gone.** At 769px — the console's narrowest reading column
(517px, because `.sidebar` returns at 769px, `console.css:2427`) — the pre-fix
sheet rendered a 98px copy ribbon in a 467.5px banner; post-fix it is a 363px
column in a 204px banner, better than the fork point on both axes. The whole
641–950 band that round 1 named is now better than or equal to the fork point on
copy width, and no width anywhere in the sweep produces a copy column narrower
than 198px (post) against a fork-point minimum of 75.9px.

**Widths where the branch is TALLER than the fork point** (asked for explicitly):

| vp | fork h | post h | delta | what is traded |
|---|---|---|---|---|
| 640 | 152.5 | 184.5 | **+32** | copy 340.4 → 518 (+178); fork labels were 3-line/2-line |
| 641 | 152.5 | 184.5 | **+32** | copy 341.4 → 519 (+178); same |
| 700 | 152.5 | 184.5 | **+32** | copy 400.4 → 578 (+178); same |
| 834 | 191.5 | 204 | **+12.5** | copy 250.4 → 428 (+178) |
| 950 | 152.5 | 184.5 | **+32** | copy 366.4 → 544 (+178) |
| 1280 | 113.5 | 133 | **+19.5** | actions do NOT wrap here; fork was shorter only because both CTA labels wrapped to two lines (`btnH [99.6→55, 73.9→55]`) |

Every one of these six is the same trade: the branch spends one banner row (or,
at 1280, one line of copy) to stop the CTA labels wrapping — which is defect #1
the ticket exists to fix. None of them reproduces the F2 pathology (narrow ribbon
+ tall banner); the copy column is wider in all six. `hscroll = 0` throughout.
I do not read any of these as a regression, but they are the honest answer to
"where is the branch worse", and none of them appears in D5's seven-row table.

**Does `flex-wrap: wrap` now applying at all widths change anything wide?** No.
`.banner--top` exists on exactly one element in the repo
(`ImportOfferBanner.tsx:272`), so the declaration reaches no other banner. At
768/1024/1180/1280/1440/1920 the line never wraps and the geometry is the same as
the pre-fix sheet (identical rows in the table above). The wrap threshold is a
pure function of the banner's inner width, not the viewport, so nothing above the
threshold can be affected.

**Caveat (documentation, not behaviour).** The recorded threshold is wrong by
~14px. `console.css:1362` and `deviations.md:176` both say the actions wrap
"whenever the banner's inner width falls under ~620px". Measured by a 1-px sweep
of the content column: the widest inner width that still wraps is **633px**; the
narrowest that does not is **634px**. (Algebraically: wrap when
`36 + 16 + 0.5·inner + 16 + 249 > inner`, i.e. `inner < 634`.) The tilde makes
this nearly unfalsifiable, but 634 is the number.

---

### F3 — HOLDS

`ImportOfferBanner.tsx:435,447,472`

**(a) The `failed` visible output is byte-identical to the fork point.** I
rendered the `failed` state against the fork-point component and against
a68c0296 through the same test harness and diffed `container.innerHTML`. They are
character-for-character identical — the `section-enter section-enter-2` wrapper,
`role="status" aria-live="polite" class="sr-only"` with the same announcement
text, `class="banner banner-attn" role="alert"`, the alert `Icon` SVG path data,
the `b-title` string, and the `b-sub` including the `mailto:` anchor.

**(b) The announcement is now an update, not a mount.** Mutation-tested:

| component body swapped in | result |
|---|---|
| a68c0296 (post-fix) | **20/20 pass** |
| 98cf53c4 (pre-fix — the faithful F3 mutation) | **1 failed**: `announces the failed outcome…` — `AssertionError: expected '' to be "We couldn't finish importing your reviews."` |
| fork point | 3 failed: the two `.banner-actions` structure tests and the failed-announcement test |

So the new test at `__tests__/ImportOfferBanner.test.tsx:598` is not vacuous: it
is killed by exactly the mutation it was written for and by nothing else.

**(c) No other transition regressed.** I ran four extra probes (scratchpad only)
against a68c0296, all passing:

- `importing → empty`: the live region is the **same node** before and after, its
  text goes `'' → 'No recent reviews found — nothing to import.'`, the shell node
  is unchanged, and there is exactly **one** `[aria-live]`.
- `importing → imported`: same node, `'' → "Imported 7 reviews. …"`, one
  `[aria-live]`, one `.section-enter-2`.
- retire path: the `imported` notice has no `banner--leaving` at t=0, gains it at
  t=8000ms, and the whole subtree unmounts by t=8400ms — unchanged.
- `failed` never gains `banner--leaving` and never unmounts, out to t=60s.

**(d) The `retires` predicate change.** `view.state !== 'importing'` →
`view.state === 'imported' || view.state === 'empty'` differs on exactly one union
member, `failed` (true → false). It is **observationally equivalent** even there,
because `retires` is now only consumed by `if (retires && noticePhase === 'gone')`
and by the `banner--leaving` class inside the non-`failed` arm, and
`noticePhase` can never leave `'visible'` while the state is `failed`:
`noticeState` (`:398`) is `null` for `failed`, `useNoticePhase` starts at
`'visible'`, its effect early-returns on `null` so no timer ever fires, and the
render-time reset re-arms `'visible'` whenever `noticeState` changes. So the new
predicate changes no rendered output — it removes a latent trap that the
restructure created by routing `failed` through code that previously could not
see it. Correct, and strictly safer than what it replaced.

Gap → **N3** below.

---

### F4 — HOLDS

- `.feature/intake.json` and
  `docs/superpowers/plans/feat-1087-import-offer-arrangement-intake.json` are
  **byte-identical** (`diff` reports no output).
- `shasum -a 256` of both = `b46f023f84679e8a0939b5f5bc4c61b9de6e46a201e2346068fcf3009777aef9`,
  which is exactly the `intakeSha256` recorded in `.feature/state.json`.
- `tests_to_add[2]` now reads *"the offer actions sit in the banner action slot
  rather than inline styles"* and the test title at
  `__tests__/ImportOfferBanner.test.tsx:483` ends with that same string, so
  `ci:promised-tests` (fixed-string match) is satisfied — and `gate-status.json`
  records `promised-tests: PASS` at this SHA.
- **The new title does not overclaim.** The body asserts only: `.banner-actions`
  exists; it contains the two buttons in that order; `.banner` carries
  `banner--top`; `.banner-copy` exists; neither button has a `style` attribute;
  "No thanks" carries `banner-cta--ghost`. "sit in the banner action slot rather
  than inline styles" is precisely that set. The word "aligned" is gone, and the
  fork-point component fails the test (`expected null not to be null`), so it is
  load-bearing.

---

### F5 — DOES NOT HOLD

`console.css:1337`

```css
.banner-blue .banner-cta--ghost:hover:not(:disabled) { background: var(--rw-control-hover); }
```

The `:not(:disabled)` stops the ghost's own hover rule matching a disabled
button — and that **un-shadows** `console.css:1302`:

```css
.banner-blue .banner-cta:hover { background: var(--rw-accent-700); }
```

`.banner-blue .banner-cta:hover` is 0-0-3-0 and still matches the disabled ghost.
The ghost's resting rule (`console.css:1327-1331`, 0-0-2-0) loses to it. So the
disabled ghost does not fall back to transparent — it falls back to the **primary
button's hover fill**.

Measured (`getComputedStyle` after a real `page.hover()`, `.banner-blue` context,
transition settled):

| button | fork | 98cf53c4 (pre-fix) | **a68c0296 (post-fix)** |
|---|---|---|---|
| primary, enabled, hover | `rgb(50,87,80)` | `rgb(50,87,80)` | `rgb(50,87,80)` |
| primary, **disabled**, hover | `rgb(50,87,80)` | `rgb(50,87,80)` | `rgb(50,87,80)` |
| ghost, enabled, hover | `rgba(0,0,0,0)` | `rgb(237,241,239)` | `rgb(237,241,239)` |
| ghost, **disabled**, hover | `rgba(0,0,0,0)` | `rgb(237,241,239)` | **`rgb(50,87,80)`** |

- The primary button is unchanged in every state — that half of the brief checks
  out.
- The enabled ghost gains `--rw-control-hover` (`#EDF1EF`). That is the
  deliberate improvement round 1 endorsed.
- **The disabled ghost is worse than both the fork point and the state F5 was
  filed against.** It was transparent at the fork, a faint `#EDF1EF` tint pre-fix,
  and is now `#325750` (`--rw-accent-700`, `tokens.css:142`) — a solid dark-teal
  primary-button fill — while `color` stays `#5C6B72` (`--rw-app-text-muted`,
  `tokens.css:79`, inherited from the ghost's 0-0-2-0 rule, which line 1302 does
  not override). **Contrast of `#5C6B72` on `#325750` is 1.45:1**, far under the
  4.5:1 (and even the 3:1 large-text) WCAG 2.1 AA floor.

**Failure scenario.** Owner clicks "Import my reviews". `ImportOfferBanner.tsx:296,304`
set `disabled={pending}` on both buttons for the length of the POST. The owner
moves the pointer over "No thanks": it repaints as a solid dark-teal button — it
now looks *more* interactive than the enabled primary beside it — with its label
effectively invisible. Releasing the pointer does nothing.

**The recorded rationale is falsified.** `console.css:1332-1336` states:

> `:not(:disabled)` restores what the inline style used to do for free … `:hover`
> matches a disabled button, so the class form needs this to say the same thing

It does not say the same thing. The inline `background: transparent` won against
*every* author selector including `:1302`; `:not(:disabled)` only removes one
selector from the match set and hands the cascade to `:1302`. `deviations.md`
D8's "Restored exactly, and no wider" is false for the disabled state.

(A `.banner-cta:disabled` rule — or keeping a `.banner-blue .banner-cta--ghost:hover`
arm that pins `background: transparent` — would close it. Not prescribing.)

---

### F6 — HOLDS WITH CAVEAT

**Reproduced exactly:**

- The 1440px right-edge equality D1 rests on, re-measured in `.content--dash`:
  `.banner-actions` right edge = **1377**, `ConnectGoogleBanner`'s CTA right edge
  = **1377**. Identical. The same equality also holds at 390px (**355** / **355**),
  which the arch-review-log row asserts.
- Every content-column width in D5's table: 390→390, 641→641, 768→768,
  **769→517**, 820→568, 900→648, 1440→1188. All exact.
- Every copy-column width in D5's "now" column: 268, 519, 388, 363, 414, 494, 776.
  All exact against my post-fix measurements (268, 519, 381*, 363, 414, 494, 769*).
  (*768 and 1440 differ by 7px; the other five are exact.)
- The docstring's *"at 1440px both button labels wrapped to two lines"* — fork
  `btnH [55, 55]`, i.e. two 19.5px lines plus 16px padding. Confirmed.
- `ImportOfferBanner.tsx:250-256` — three `.banner-cta` call sites, one
  `.banner-actions` element. Confirmed by grep.

**Not reproduced** → **N4** below.

---

## New findings

| ID | severity | file:line | claim |
|---|---|---|---|
| **N1** | **medium** | `src/app/(authenticated)/_styles/console.css:1337` (+ `:1302`) | The F5 fix un-shadows `.banner-blue .banner-cta:hover`, so the **disabled** ghost button now paints `--rw-accent-700` (`#325750`) with `#5C6B72` text — **1.45:1 contrast** — where the fork point painted transparent and the pre-fix sheet painted `#EDF1EF`. Worse than both. Detail under F5. |
| **N2** | low | `docs/superpowers/plans/feat-1087-import-offer-arrangement-deviations.md:179-182` and `.claude/reference/arch-review-log.md:1663` | "A fixed basis cannot satisfy both ends … every fixed value loses either the 360px icon row or the 900px wrap" is **false**. Measured: `flex-basis: 230px` and `235px` both keep the icon and copy on one row at 360px **and** wrap the actions at 900px. The seven values swept (200/220/240/260/300/320/360) straddle the ~230–239px window without landing in it. |
| **N3** | low | `src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx:598-633` vs `ImportOfferBanner.tsx:468-472` | The new `failed` test asserts announcement + node identity but never asserts the shell **shape**, so the contract the fix added to `FailedBanner`'s docstring ("Renders the inner `.banner` ONLY, never its own `BannerShell`") is unenforced. Demonstrated: a mutant that keeps `BannerShell` at the position **and** restores `FailedBanner`'s own nested `BannerShell` — producing **two** `[aria-live]` regions in the `failed` state — passes all 20 tests. |
| **N4** | low | `ImportOfferBanner.tsx:236-238`; `deviations.md:38,176`; `console.css:1355-1362`; `arch-review-log.md:1663` | Recorded measurements that do not reproduce at a68c0296. Detail below. |
| **N5** | low | `console.css:1325` + `:1360` | Below ~296px viewport the 249px nowrap action group exceeds the banner's inner width. At **280px** (Galaxy Z Fold cover display) the "No thanks" button's right edge is at **284px** against a `.main` right edge of **280px**; `.main { overflow: clip }` (`console.css:486`) clips it and `document.scrollWidth == clientWidth`, so there is no scroll to reach it. The fork point did not overflow until ≤260px. |

### N2 — detail

`deviations.md:179-182`:

> **Why 50% and not a pixel floor.** A fixed basis cannot satisfy both ends: the
> icon and copy only share a row at 360px if the basis is ≤ 244px, and the actions
> only wrap at 900px if it is > 274px. Swept 200/220/240/260/300/320/360px and
> 50/55/60% — every pixel value loses one end or the other

Measured by overriding `.banner--top .banner-copy { flex-basis: … }` in the real
sheet and probing both ends:

| basis | 360px: icon+copy share a row | 900px: actions wrap | both |
|---|---|---|---|
| 220px | yes | no | no |
| 229px | yes | no | no |
| **230px** | **yes** | **yes** | **YES** |
| **235px** | **yes** | **yes** | **YES** |
| 240px | no | yes | no |
| 244px | no | yes | no |
| 274px | no | yes | no |
| 50% / 55% / 60% | yes | yes | YES |

Both recorded bounds are off (the icon-row bound is ≤239px, not ≤244px; the
900px-wrap bound is >229px, not >274px), and the conclusion drawn from them is
wrong: a ~10px-wide window of fixed values wins both ends.

This does **not** argue for changing the fix — `50%` is still the better rule,
because it tracks the container rather than one pair of test widths, and that is
D5's real argument. What is wrong is the recorded *evidence*: a sweep too coarse
to see the answer, written up as proof that no answer exists. That is the same
failure mode as the two round-1 findings, in a lesson block whose stated moral is
"a pair is what let both defects through". `arch-review-log.md:1663` also says
"Swept **eight** pixel floors" where D5 lists **seven**.

### N3 — detail

Mutant: a68c0296's component, unchanged except that `FailedBanner` is restored to
wrapping its body in its own `BannerShell` while `ImportStatusBanner` keeps the
shared `BannerShell` at the position. Result: **20/20 pass**.

D6's recorded nuance —

> Only a **component-type change at the position** breaks reconciliation; wrapping
> the inner content does not. … **A mutation that passes is not evidence the test
> is weak until you have checked the mutation is faithful.**

— is **true as stated about reconciliation**, and I verified both halves of it
(the faithful mutation fails; the nesting mutation passes). So the lesson is not
false. But the passing mutation is not *harmless*: it renders two live regions in
the `failed` state, which is exactly what the sibling test guards against for the
other three states via `assertShellShape`'s
`expect(container.querySelectorAll('[aria-live]')).toHaveLength(1)`
(`:551`). The new test omits that one line, so the `failed` state is the only
state whose shell shape nothing pins. My scratchpad probe confirms the shape is
correct today (`[aria-live]` length 1 in `failed`) — the gap is in the suite, not
in the shipped code.

### N4 — detail

Everything below was measured with Tailwind preflight's `button { font: inherit }`
in place, which the real app has (`globals.css:1` → `@import 'tailwindcss'`) and
which sets the CTA's line-height to `1.5 × 13px = 19.5px` (button height 35.5px).

| where | recorded | measured at a68c0296 |
|---|---|---|
| `ImportOfferBanner.tsx:237` / `deviations.md:38` / `arch-review-log.md:1663` — fork banner at 390px | 507px tall, 95px copy | **526px tall, 90.4px copy** |
| `ImportOfferBanner.tsx:238` / `arch-review-log.md:1663` — fork banner at 360px | 585px tall, 78px copy | **625px tall, 75.9px copy** |
| `console.css:1356-1357` — pre-fix banner at 769px | 447px tall, 105px copy | **467.5px tall, 98px copy** |
| `console.css:1364` — "the 390px banner grew to 507px" | 507px | **526px** |
| `deviations.md:176` / `console.css:1362` — wrap threshold | inner width ~620px | **634px** |
| `deviations.md` D5 "now" column heights on wrapped rows (390→239, 641→180, 769→200, 820→200, 900→180) | | **243, 184.5, 204, 204, 184.5** — a systematic **+4.5px**, exactly one CTA line-height delta, i.e. round 1's harness rendered the button at `line-height: normal` rather than the inherited `1.5` |
| `arch-review-log.md:1663` — "Swept eight pixel floors" | eight | **seven** listed in D5 |

The **direction** of every fork-point number is right and my figures make the
fork-point defect *worse* than recorded, so no conclusion on this branch changes.
Flagged because these are now permanent code comments and a permanent
architecture-log row, the harness is still not committed, and round 1's accepted
F6 was this exact class — the fix re-measured in the right container but did not
make the numbers re-derivable.

One further wording problem in the same comment block
(`ImportOfferBanner.tsx:236-237`): *"At 1440px both button labels wrapped to two
lines; at 390px nothing wrapped at all"*. Read as the parallel it is written as,
the second clause says the labels did not wrap at 390px — measured, they wrapped
harder there than at 1440 (`btnH [74.5, 55]` = three lines and two lines). The
intended reading is presumably "no row wrapped", which is true; as written it
contradicts the clause before it.

---

## Checked and clean (fixes did not disturb these)

- **The seven other banner states are byte-identical fork → post at all 24
  widths.** `ConnectGoogleBanner`, `FailedBanner`, the `imported`/`empty` notice
  and the three `DECISION_REJECTIONS` banners each match on banner height, copy
  width, CTA width and `hscroll` at every width. `user_visible_behavior[3]` holds.
- **`hscroll = 0`** for the offer banner at every one of the 24 widths, in all
  three columns, in the plain, `retryable` (four `b-sub` lines) and `readOnly`
  variants. `edge_cases[1]` holds.
- **`edge_cases[2]`** — "390px: the actions wrap below the copy rather than being
  squeezed" — holds; the actions wrap at 390 and at every width down to 320.
- **The suite is green** at a68c0296: 20/20 in
  `src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx`,
  and `.feature/gate-status.json` records every gate PASS with only the expected
  `reclassify: WARN`.
- **Specificity of the F1 rescoping.** `.banner-actions .banner-cta` (0-0-2-0)
  still beats `.banner-cta { margin-left: auto }` (0-0-1-0); measured button
  widths confirm both `margin-left: 0` and `white-space: nowrap` take effect
  inside the group at every width.
- **`readOnly` still lands in the slot** at every width; `actions.textContent` is
  exactly the notice string (test at `:520`). Its column is 265–428px in the
  600–900 band versus 381–415px at the fork point — narrower at five widths,
  wider at eleven, no pathology, no overflow.
- **Edit surface.** The only production files changed 98cf53c4 → a68c0296 are
  `console.css` and `ImportOfferBanner.tsx`, both in `allowed_edit_surface`;
  the rest are tests, `arch-review-log.md` (in surface) and `docs/**` workflow
  paperwork.

## Speculative / not actionable

- The disabled **primary** button has the same missing `:disabled` treatment
  (`rgb(50,87,80)` on hover while disabled, identical at all three SHAs). It is
  pre-existing and unchanged by this branch; round 1 recorded it as speculative
  and it stays there. N1 is only about the half the branch changed.
- `.banner-cta--ghost` inside a `.banner-attn` banner would still hover to
  `--rw-accent-800` (`console.css:1300` has no ghost counterpart, and the ghost's
  hover arm is scoped to `.banner-blue`). No such call site exists; carried
  forward from round 1 unchanged.
- At 1280px the post-fix banner is 19.5px taller than the fork point with a 67px
  narrower copy column, without wrapping. This is the `flex: 1 1 50%` basis
  holding 249px in reserve for actions that fit anyway. Cosmetic, and the
  alternative (labels wrapping to two lines) is the defect the ticket exists to
  remove.
