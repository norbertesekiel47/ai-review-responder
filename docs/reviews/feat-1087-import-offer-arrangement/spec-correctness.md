# Review — spec / correctness · feat/1087-import-offer-arrangement

| | |
|---|---|
| Reviewed SHA | **98cf53c4** |
| Fork point (merge-base with origin/main) | **42078f3913ef0fa3fcaca70d62a8eee6684bf4c9** |
| Measured production diff (excl. tests + workflow paperwork) | **120 lines** |
| Axis decision | one axis: 120 < 300-line maintainability threshold, risk normal |

**Method.** Every file read at `98cf53c4` via `git show`. Layout claims were not
derived from the CSS — they were **measured in a headless Chromium** against the
real `tokens.css` + `console.css` (before sheet at the fork point, after sheet at
98cf53c4), the two real brand faces, and the real containers the components
actually render in: `.rw-console > .shell > .sidebar + .main > .content
content--dash` for the offer banner (`DashboardContent.tsx:66,332`) and
`.settings-content` for the auto-approval banner (`SettingsShell.tsx:36`,
`settings.css:4`). Screenshots at the widths named below back F1 and F2.

## Findings

| ID | severity | file:line | claim |
|---|---|---|---|
| F1 | high | `src/app/(authenticated)/_styles/console.css:1307` | The un-scoped `.banner-cta { white-space: nowrap }` is a visible regression on `/settings/auto-approval` at phone widths — 390px: banner 133px → **212px** tall, copy column 167px → **93px**. That call site was never enumerated, never screenshotted, and the deviations doc + component docstring both assert it cannot happen. |
| F2 | high | `src/app/(authenticated)/_styles/console.css:1315-1348` | `.banner-actions { flex: 0 0 auto }` with the wrap gate at `max-width: 640px` puts the gate on the wrong side of the **768px sidebar breakpoint**. In the 641–~950px band the offer banner is measurably worse than before: at 769px 250px → **447px** tall, copy 190px → **105px**; iPad-portrait 820px 211px → 310px. |
| F3 | medium | `src/components/dashboard/account-state/ImportOfferBanner.tsx:412` | Intake invariant "BannerShell remains the element at the parent component's return position in every state, so the terminal announcement is not lost" is **false for the `failed` state**. D2 clears only `offer → importing`; the new shape test never reaches `failed`. |
| F4 | low | `src/components/dashboard/account-state/__tests__/ImportOfferBanner.test.tsx:483` | Test title claims "right-aligned"; the body asserts no alignment and the in-test comment says so. The title still overclaims (accepted-finding precedent: InfoTip test retitle, #1086). |
| F5 | low | `src/app/(authenticated)/_styles/console.css:1331` | The **disabled** ghost button now lights up on hover. The old inline `background: transparent` outranked every hover selector; the new class does not, and there is no `.banner-cta:disabled` rule anywhere in `console.css`. |
| F6 | low | `docs/superpowers/plans/feat-1087-import-offer-arrangement-deviations.md` (D1 table) | D1's headline 1440px evidence ("actions right edge **1337** — identical to `ConnectGoogleBanner`'s CTA to the pixel") was measured in `.content`, not the `.content content--dash` the dashboard uses. Re-measured in the real container both edges are **1377**. The conclusion survives; the recorded number is unreproducible. |

---

### F1 — high — `console.css:1307`: the one un-modifier-scoped rule regresses a third call site

**The claim under review.** Deviations D1: *"`.banner` itself is byte-unchanged
and the other seven banner states plus `ConnectGoogleBanner` render exactly as
before — verified in the same screenshot."* `ImportOfferBanner.tsx:246-247`
repeats it: *"the seven other states and `ConnectGoogleBanner`, which shares this
slot, render exactly as before."*

**The evidence.** There are **three** production `.banner-cta` call sites, not two:

```
src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx:729
  <button type="button" className="banner-cta" onClick={onTurnOff} disabled={busy}>
    Turn off auto-posting
  </button>
src/components/dashboard/account-state/ConnectGoogleBanner.tsx:46   ("Connect" / "Reconnect")
src/components/dashboard/account-state/ImportOfferBanner.tsx:287,295
```

`AutoApprovalClient`'s `PolicyStatusBanner` (`:701-736`) is neither one of
`ImportOfferBanner`'s eight states nor `ConnectGoogleBanner`. Its label is three
words. The new rule at `console.css:1307` is scoped to no modifier, so it applies
there.

**Measured, `.settings-content` container, real fonts** — `#policy` banner:

| viewport | before h / cta w / copy w | after h / cta w / copy w |
|---|---|---|
| 360px | 133 / 78 / **144** | **293** / 159 / **63** |
| 390px | 133 / 85 / **167** | **212** / 159 / **93** |
| 430px | 133 / 95 / 197 | 152 / 159 / 133 |
| 769px | 92 / 108 / 239 | 133 / 159 / 188 |
| 820px | 92 / 120 / 278 | 92 / 159 / 239 |

**Failure scenario.** An owner opens `/settings/auto-approval` on an iPhone
(390px). Before this branch the status banner is 133px tall and reads in three
lines. After it is 212px tall with the sentence "Up to 5 replies a day post
themselves after a 15-minute veto window." rendered in a 93px column — six lines
in a ~12-character gutter beside a full-width green pill. At 360px (iPhone SE,
Galaxy S) the same banner is **293px** tall with a **63px** copy column.
Screenshots: `policy-before-390.png` / `policy-after-390.png` in the review
scratchpad; the difference is obvious at a glance.

**Named standard violated.** Global CLAUDE.md → Design work: *"Prove the change
with before/after screenshots at 390px and 1440px before asking for approval."*
390px was proven for the banner the ticket owns, and the same rule regresses a
different page at exactly that width. The intake's `user_visible_behavior[3]` and
D1's "renders exactly as before" are both stated over an enumeration that is one
call site short.

**Note on the fix, not prescribing one:** the label-wrap defect D1 measured was
inside `.banner-actions`. Scoping the rule (`.banner-actions .banner-cta { white-space: nowrap }`)
keeps every claim in the docstring true; the global form does not.

---

### F2 — high — `console.css:1315-1348`: the wrap gate is on the wrong side of the sidebar breakpoint

**The rules.**

```css
.banner-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }   /* :1315 */
.banner--top .banner-copy { flex: 1 1 0; min-width: 0; }                                                /* :1342 */
@media (max-width: 640px) { .banner--top { flex-wrap: wrap; }
                            .banner--top .banner-actions { flex-basis: 100%; margin-left: 0; } }        /* :1345 */
```

`flex: 0 0 auto` pins the action group at its max-content width (measured: 242px)
and forbids it from shrinking. The escape hatch — wrapping it onto its own row —
fires on **viewport** width ≤ 640px. But `console.css:2414-2415` hides the
sidebar at `max-width: 768px`, so the console's reading column does not shrink
monotonically with the viewport: it is **widest at 768px (768px content) and
narrowest one pixel later at 769px (517px content)**, where the 240px sidebar
appears (`--rw-sidebar-width: 240px`, `tokens.css:136`).

**Measured, real `.content content--dash` geometry** — offer banner:

| viewport | content col | before h / copy w | after h / copy w |
|---|---|---|---|
| 390 | 390 | 507 / 95 | **239 / 268**  ← the fix works |
| 641 | 641 | 153 / 346 | 192 / 261 |
| 700 | 700 | 153 / 405 | 192 / 320 |
| 768 | 768 | 153 / 473 | 153 / 388 |
| **769** | **517** | **250 / 190** | **447 / 105** |
| 800 | 548 | 211 / 221 | 349 / 136 |
| **820** (iPad Air portrait) | 568 | **211 / 241** | **310 / 156** |
| **834** (iPad Pro 11″ portrait) | 582 | 192 / 255 | 291 / 170 |
| 900 | 648 | 192 / 321 | 211 / 236 |
| 1024 | 772 | 153 / 445 | 153 / 360 |
| 1440 | 1188 | 114 / 809 | **114 / 776**  ← the fix works |

`hscroll = 0` at every width, so this is not an overflow — it is the exact
pathology D1 named as the defect, reproduced one breakpoint over.

**Failure scenario.** An owner opens the dashboard on an iPad Air in portrait
(820 CSS px) or in a ~800px-wide desktop window. The Import offer banner renders
**310px tall with the three-paragraph body in a 156px column** where the fork
point renders it 211px tall in a 241px column. At 769px it is 447px vs 250px —
see `offer-before-769.png` / `offer-after-769.png`: the after shot is a
twelve-character ribbon of text running the full height of the banner with the
two buttons parked at the top right.

**Named standard violated.** Intake `user_visible_behavior[0]`/`edge_cases[2]`:
*"390px: the actions wrap below the copy rather than being squeezed."* The
squeeze the intake forbids now happens at 769–~900px instead, and
`user_visible_behavior[3]` ("the other seven banner states are visually
unchanged") is a claim measured only at the two widths that straddle the band.

**Precedent.** This is the accepted #1086 finding class, verbatim: *"Panel
overflows the viewport above 768px; the gutter-spanning fix is gated at max-width
768px … My T3 screenshots at 390 and 1440 straddled it."* Same trap, same branch
family, one breakpoint different.

---

### F3 — medium — `ImportOfferBanner.tsx:412`: the `failed` terminal announcement is lost, and neither D2 nor the new test covers it

**Intake invariant.** *"BannerShell remains the element at the parent component's
return position in every state, so the terminal announcement is not lost."*

**Evidence.** `ImportStatusBanner` has two return positions with different
element types:

```tsx
412:  if (view.state === 'failed') return <FailedBanner />;
...
430:  return (<BannerShell announcement={retires ? message : ''}> …
```

and `FailedBanner` mounts its own shell with a **non-empty** announcement already
in place:

```tsx
448: function FailedBanner() {
450:   <BannerShell announcement="We couldn't finish importing your reviews.">
```

React reconciles by element type at a position; `BannerShell` → `FailedBanner` is
a type change, so the whole subtree — including the live region — is unmounted
and remounted. `LiveRegion` (`src/components/ui/LiveRegion.tsx:14-23`) renders
`{message}` inline with no deferral, so the remounted region carries its text
from its first paint. That is exactly the condition this file's own A6c doc
(`ImportOfferBanner.tsx:129-134`) says produces no announcement.

**Reachable path.** `importing` polls every 4s (`:318-319`); when the worker marks
the import failed the GET returns `state: 'failed'` and the component takes line
412. That is the ordinary failure path, and the failure notice is the one an owner
most needs read to them.

**Why it belongs in this review even though it predates the branch.** D2 examined
precisely this contract and cleared only `offer → importing` ("the offer state's
announcement is the empty string"). The new test
(`__tests__/ImportOfferBanner.test.tsx:530`) walks `offer → importing → imported`
and asserts shape at each, but never enters `failed` — so the suite's shape
assertion has a hole exactly where the contract breaks. Either fix it, or record
it the way D2 records the benign case, so the next reader does not take D2 as
having cleared the whole invariant.

*(For completeness: the retryable path the brief asked about is safe. In the
offer state a non-empty `announcement` (`:371-373`) always arrives as an **update**
to an already-mounted region — the offer state renders with `announcement=''`
before any click can produce `decide.error` — so it is announced before any
remount. D2's reasoning holds there.)*

---

### F4 — low — test title overclaims what the assertions prove

`__tests__/ImportOfferBanner.test.tsx:483`:

> `it('ImportOfferBanner — the offer actions are right-aligned rather than inline-styled', …)`

The body asserts: `.banner-actions` exists, contains the two buttons in order,
`.banner` carries `banner--top`, `.banner-copy` exists, no button has an inline
`style`, and "No thanks" carries `banner-cta--ghost`. None of that is alignment —
jsdom applies no stylesheet, and the test's own comment (`:484-490`) says so
plainly and honestly.

The comment is not the problem; the title is. A reader scanning the suite names
(or a future session grepping for coverage of the alignment) reads a promise the
test does not keep, and F2 shows the alignment claim is the half that actually
regressed. Precedent, accepted on #1086: *"The 'associated with the element it
describes' test proves only that the trigger describes itself … Retitling to what
is actually proven."* The other three new tests are sound and non-vacuous —
`:527` (`actions!.textContent` exact-match) would fail if the buttons rendered
alongside the notice, and `assertShellShape`'s `[aria-live]` length-1 assertion
does fail on a nested second shell, as D2 claims.

---

### F5 — low — the disabled ghost button now responds to hover

`console.css:1331`: `.banner-blue .banner-cta--ghost:hover { background: var(--rw-control-hover); }`

CSS `:hover` matches disabled buttons. `ImportOfferBanner.tsx:296` sets
`disabled={pending}` on that button while the decision POST is in flight, and
there is **no** `.banner-cta:disabled` rule anywhere in `console.css` (`.btn:disabled`
at `:729` and `.acct-menu-item:disabled` at `:458` are different classes).

Before this change the button carried `style={{ background: 'transparent', … }}`,
and an inline declaration outranks every author selector without `!important` —
so `.banner-blue .banner-cta:hover` was defeated and the old "No thanks" had no
hover response at all. Moving to a class is the right call, but it means a button
that is currently un-clickable now paints an interactive hover state.

**Failure scenario.** Owner clicks "Import my reviews"; both buttons go
`disabled` for the length of the POST; the owner moves the pointer to "No thanks"
and it lights up as if it will respond. Nothing happens. Adding a
`.banner-cta:disabled` rule (opacity + `cursor: default`) would close it for both
buttons; the primary button has always had the same gap.

---

### F6 — low — D1's 1440px evidence was measured in the wrong container

D1's table records *"actions right edge — **1337** — identical to
`ConnectGoogleBanner`'s CTA"* and the component docstring
(`ImportOfferBanner.tsx:235-241`) records "at 390px … crushed to a 95px column
and the banner grew to 507px" as permanent comments.

The T1 harness renders the banner in `<div class="content">`. The dashboard
renders it in `<div className="content content--dash">`
(`DashboardContent.tsx:66,274,332`), and `.content--dash` (`console.css:774`)
sets `max-width: none` + `padding: 18px 32px` where `.content` (`:607`) sets
`max-width: 1140px` + `padding: 26px clamp(20px,4vw,48px)`.

Re-measured in the real container at 1440px: the actions' right edge and
`ConnectGoogleBanner`'s CTA right edge are both **1377**, not 1337 — so the
*equality* the deviation rests on is real and survives; only the absolute number
is from geometry the page never uses. The 390px numbers (507px banner, 95px
column) reproduce **exactly** in the real container, so nothing else in D1 is
affected. Flagged because the numbers are now permanent code comments and the
harness is not committed, so the next reader cannot re-derive them.

---

## Checked and clean

- **Copy locked verbatim.** `git diff` shows both `b-sub` blocks and the `b-title`
  as unchanged context lines; the only edit to the copy container is
  `<div>` → `<div className="banner-copy">` (`:268`). The three
  `DECISION_REJECTIONS` strings, `DECISION_FAILED_MESSAGE`, `FailedBanner` and
  `ImportStatusBanner`'s three messages are untouched. `non_goals[0]` met.
- **`BannerShell` position across the changed branch.** `OfferPrompt` still returns
  the inner `.banner` only and is still wrapped by `BannerShell` at `:372-381`.
  `non_goals[1]` met.
- **No behaviour change.** Query key, `refetchInterval`, `useMutation`,
  `postDecision`, `useNoticePhase`, the rejection precedence at `:351` and the
  `state: 'none'` self-null at `:367` are byte-identical. `non_goals[2]` met.
- **`ConnectGoogleBanner` markup unchanged** — the file is not in the diff, and its
  single short CTA is unaffected by `white-space: nowrap` (measured: cta width 96px
  and banner height identical before/after at every width from 390 to 1440).
- **`.banner` is byte-unchanged**; `.banner--top`, `.banner-copy`, `.banner-actions`
  and `.banner-cta--ghost` collide with no other selector in any stylesheet in the
  repo (grep over `*.css`).
- **Specificity, worked by hand and confirmed by measurement.**
  `.banner-cta--ghost, .banner-blue .banner-cta--ghost` (`:1326-1330`) — the second
  arm is 0-0-2-0, tying `.banner-blue .banner-cta` (`:1301`) and winning on order.
  Hover: `.banner-blue .banner-cta--ghost:hover` (0-0-3-0, `:1331`) ties
  `.banner-blue .banner-cta:hover` (0-0-3-0, `:1302`) and wins on order.
  `.banner-actions .banner-cta { margin-left: 0 }` (0-0-2-0) beats
  `.banner-cta { margin-left: auto }` (0-0-1-0). Every intended override wins.
- **Focus ring survives.** `.rw-console :where(a,button,…):focus-visible`
  (`console.css:26`, 0-0-2-0, `outline: 2px solid var(--rw-focus)`) is not
  overridden by any new rule; the ghost button keeps a visible ring on both
  backgrounds.
- **Reduced motion.** No new `animation`/`transition`; `.banner`'s
  `prefers-reduced-motion` resolution near the foot of the file is untouched.
- **Read-only branch renders and does not overflow.** The `<p>` lands inside
  `.banner-actions` at every width; at ≤640px the media query gives it its own
  full-width row; `hscroll = 0` from 360px to 1440px. Its width defect above 640px
  is the same root cause as F2, counted there and not double-counted here.
- **Edit surface.** Every code file touched is in `allowed_edit_surface`. The four
  `docs/superpowers/plans/*` files are /feature workflow paperwork, not a surface
  breach.

## Speculative / not actionable

- `.banner-cta--ghost` used inside a `.banner-attn` banner would turn **solid
  accent-800 on hover**: `.banner-attn .banner-cta:hover` (`console.css:1300`,
  0-0-3-0) has no ghost counterpart, and the ghost's own hover rule is scoped to
  `.banner-blue`. No such call site exists today, so there is no failure scenario —
  only a trap for the next multi-action banner.
- `.banner-cta` has **no `:disabled` treatment at all**, so during the in-flight
  POST both buttons keep `cursor: pointer` and full contrast. Pre-existing for the
  primary button and unchanged by this diff; the hover half is F5.
- `ReadOnlyNotice` (`ImportOfferBanner.tsx:209`) keeps an inline
  `style={{ color: … }}` while the sibling change removed inline styles from the
  buttons on the stated principle "A class, not two inline overrides on the
  element". It deliberately mirrors `ConnectGoogleBanner.ReadOnlyNotice:14`, so
  diverging would be worse than the inconsistency. Its `mt-1` also now offsets the
  notice 4px from the top of a top-anchored slot rather than centring it; no
  concrete wrong outcome observed.
