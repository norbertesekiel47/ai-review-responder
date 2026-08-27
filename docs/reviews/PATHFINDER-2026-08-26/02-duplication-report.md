# Cross-feature duplication — Pathfinder 2026-08-26

**Axis:** CROSS-FEATURE only. Within-feature duplication was reported by the eight
flowchart agents and is not restated here except where a cross-feature measurement
**corrects or enlarges** what a single feature could see. Every such case names the
flowchart finding it builds on.

**Measured at** `1d9b251c` (branch `docs/617-destination-reached`). Every claim
carries `file:line` read at that commit.

**Method note.** Per SCOPE.md, a citation is not a verification: each ranked item
answers *"is it wrong?"* and *"is it reachable?"* separately. Specialization is not
duplication — three items below are ruled LEGITIMATE and moved to the DO-NOT-UNIFY
register in §3 instead.

---

## 1. Cross-feature duplications, ranked by consequence

### X1 — The `businesses ⋈ accounts` subscription-context read: **33 production sites, not five**

**(a) The concern.** The read that feeds invariant #11 (*"Subscription guard in all
customer-facing workers"*) — `FROM businesses b JOIN accounts a ON a.id = b.account_id`
projecting `a.subscription_status`, `a.past_due_at AS account_past_due_at`,
`a.flags AS account_flags`, and in the notice family a 10-column `ao.*` offboarding
projection. There is **no shared SQL fragment**. The projection's *consuming shape* is
centrally owned — `activeOffboardingStateFromProjection`
(`/Users/norbertesekiel/Developer/startups/RepWorth/src/lib/account-offboarding/gate.ts:98`)
maps the ten `offboarding_*` aliases to a state — but the SQL that produces those
aliases is hand-typed at every site.

**(b) Every location.** The `JOIN accounts a ON a.id = b.account_id` line, 33 sites in
32 files (`src/app/api/zernio/disconnect/route.ts` has two):

`src/app/api/settings/route.ts:149` · `src/app/api/dashboard/route.ts:103` ·
`src/app/api/zernio/disconnect/route.ts:140`, `:195` ·
`src/app/api/zernio/connect/cancel/route.ts:122` ·
`src/app/api/zernio/connect/start/route.ts:121` ·
`src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:86` ·
`src/app/api/zernio/connect/_shared/finalize/authorize.ts:144` ·
`src/lib/admin/business-summary.ts:308` · `src/lib/admin/business-detail/queries.ts:107` ·
`src/lib/shared/writable-subscription.ts:165` · `src/lib/dashboard/service.ts:158` ·
`src/lib/db/account-guard.ts:131` · `src/lib/onboarding/resend-invite.ts:301` ·
`worker/background/schedulers/WeeklySummaryScheduler.ts:70` ·
`worker/background/schedulers/OnboardingDripScheduler.ts:148` ·
`worker/background/schedulers/MonthlyImpactScheduler.ts:59` ·
`worker/background/schedulers/RankingTrackingScheduler.ts:81` ·
`worker/background/pollers/EmailChannelReconcilePoller.ts:123` ·
`worker/background/pollers/EngagementMonitorPoller.ts:90` ·
`worker/jobs/OnboardingDripWorker.ts:124` · `worker/jobs/EngagementAlertWorker.ts:46` ·
`worker/jobs/summary-report-helpers.ts:135` · `worker/jobs/OwnerEmailWorker.ts:72` ·
`worker/jobs/publisher/load-context.ts:66` · `worker/jobs/notification/context.ts:115` ·
`worker/jobs/pending-post-notice/context.ts:157` ·
`worker/jobs/zernio/job-eligibility.ts:85` ·
`worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts:53` ·
`worker/jobs/response-generation/load-context.ts:128` ·
`worker/jobs/solicitation-veto-notice/context.ts:116` ·
`worker/jobs/auto-post-notice/context.ts:120` ·
`worker/jobs/escalation-notice/context.ts:117`

The JOIN predicate is **byte-identical at all 33** (indentation aside). The alias pair
`a.past_due_at AS account_past_due_at, a.flags AS account_flags` — the true fingerprint
of the guard read — appears at **15 production sites**.

**Corrections to F8 DUP-3** (`01-flowcharts/F8-solicitation-attribution.md:463`), which
listed five:
- `SolicitationAttributionWorker.ts:48` → SELECT at `:49`, JOIN at `:53`
- `solicitation-veto-notice/context.ts:103` → SELECT at `:102`, JOIN at `:116`
- `worker/jobs/onboarding-drip/OnboardingDripWorker.ts:120` → **no such directory**;
  real path `worker/jobs/OnboardingDripWorker.ts`, SELECT `:119`, JOIN `:124`
- `summary-report-helpers.ts:130` → `worker/jobs/summary-report-helpers.ts:129`
- **`worker/jobs/autonomy-suspended-notice/context.ts:62` is a FALSE POSITIVE.** That
  file issues two separate queries — an accounts-rooted one (`context.ts:61-86`,
  `FROM accounts a` at `:74`) and a businesses-only one (`:106-113`, `FROM businesses b`
  at `:108`, **no join**). It reaches the same columns from the other direction because
  it is keyed on `accountId`, and says so at `:103-105`.

Column divergence across the four real notice-family members:

| Site | `subscription_status` | `subscription_tier` | `past_due_at` | `flags` | `account_id` | offboarding cols |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `SolicitationAttributionWorker.ts:49` | ✓ | — | ✓ | ✓ | — | — |
| `solicitation-veto-notice/context.ts:102` | ✓ | — | ✓ | ✓ | ✓ | 10 |
| `OnboardingDripWorker.ts:119` | ✓ | — | ✓ | ✓ | ✓ | — |
| `summary-report-helpers.ts:129` | ✓ | **✓** | ✓ | ✓ | ✓ | — |

`WHERE` casts diverge too: attribution and veto-notice write `${businessId}::uuid`,
drip and summary-helpers write bare `${businessId}`.

**(c) Why they diverged.** Nobody ever wrote the fragment. Zero comments anywhere
acknowledge the spread — `rg` for `accountProjection`, `OFFBOARDING_PROJECTION`,
`offboardingProjectionSql`, `subscriptionContextSql` returns **nothing**. Each new
worker copied its nearest sibling and trimmed the projection to what it needed. The
repo already contains the proof that the composable-`Fragment` pattern works here:
`suppressionMatchSql` (`src/lib/solicitation/suppression.ts:75-92`) is composed —
not re-spelled — by four consumers.

**(d) Verdict: ACCIDENTAL.** The JOIN and the alias pair are one fact with 33 owners.
**Reachable:** yes, trivially — these are the hot reads of every worker, poller,
scheduler and owner route. **Consequence** is not a present bug but blast radius: a
change to how subscription context is derived (a new status, a tier column, the
`trialing` semantics of invariant #11) is a 33-file edit with no audit that can tell
you when you missed one. This is the largest single duplication measured in six passes.

**Scope for a fix.** Do **not** propose one mega-fragment. The natural seam is the
15-site alias pair plus the 10-column `ao.*` projection whose consumer is already
single-owner — two exported `Fragment`s in `src/lib/account-offboarding/gate.ts` and a
sibling, composed exactly as `suppressionMatchSql` is. The SELECT lists stay private.

---

### X2 — `'scrubbed:'` and `'account purged'`: 22 hand-typed literals holding a fail-closed compliance gate together

**(a) The concern.** The purge WRITER (`worker/jobs/account-offboarding/purge-stages.ts`)
and the purge VERIFIER (`src/lib/account-offboarding/purge-verification.ts`) agree on
two magic strings by convention only. #972 gave the *tombstone* sentinels one owner and
stopped one class short.

**(b) Every location.** Exact counts, measured:

`'scrubbed:'` writer sites (10) — `purge-stages.ts:206`, `:217`, `:488`, `:576`, `:577`,
`:599`, `:600`, `:611`, `:612`, `:660`.
`'scrubbed:%'` verifier sites (10) — `purge-verification.ts:283`, `:284`, `:300`, `:301`,
`:354`, `:360`, `:389`, `:390`, `:402`, `:534`. Plus one comment-only mention at `:386`.

`'account purged'` — `purge-stages.ts:661` (`reason = 'account purged'`) ↔
`purge-verification.ts:535` (`reason <> 'account purged'`). Byte-identical literal in
opposite-polarity predicates.

The owner module that exists:
`src/lib/account-offboarding/purge-sentinels.ts:51-69` exports exactly one thing,
`PURGE_TOMBSTONE_SENTINELS`, with **nine** members (`businessName`, `tone`, `ownerName`,
`accountName`, `userName`, `trackedKeywords`, `accountFlags`, `emailPrefix`,
`emailSuffix`). Both sites import it (`purge-verification.ts:2`, `purge-stages.ts:10`)
and reference it nine times each. Neither `'scrubbed:'` nor `'account purged'` is a
member.

**Corrects F11 finding C** (`01-flowcharts/F11-purge-verification.md:458`), which reads
*"7 writer sites ↔ 9 verifier sites, 22 production occurrences"*. The split is **10 ↔ 10**
literals (21 occurrences in the two files, 22 counting the unrelated English sentence at
`src/lib/shared/worker-types.ts:288`). The aggregate was right; the split was not.

**(c) Why they diverged.** `purge-sentinels.ts:15-23` states a deliberate boundary:
*"It holds VALUES, not SQL… A shared fragment builder would need an `Sql` parameter and
would hide that asymmetry."* That argument is correct **and does not apply to
`'account purged'`**, which is a plain value — precisely what the module exists to hold.
`'scrubbed:'` is a prefix, equally a value. The boundary was drawn around the
`CREATE`-time tombstones and never re-examined.

**(d) Verdict: ACCIDENTAL, and the highest-severity duplication in the backend.**
**Is it wrong?** Yes. **Is it reachable?** Yes — every `purge` run executes both sides.
The failure mode is asymmetric and silent: a typo on the WRITER side leaves residue and
the verifier fails loudly (safe); a typo or drift on the VERIFIER side turns a
fail-closed compliance gate into a **silent PASS on residue**. That is exactly the
failure `purge-sentinels.ts:11-13` was written to prevent — *"A verifier that drifts
from its writer is worse than no verifier."*

**Cheapest fix:** two more members on `PURGE_TOMBSTONE_SENTINELS`
(`scrubbedPrefix: 'scrubbed:'`, `impersonationReason: 'account purged'`) and 22 call-site
substitutions. No new file, no `Sql` parameter, no violation of the module's own stated
boundary.

---

### X3 — There is no brand-wide motion token layer; two ease curves are hand-spelled 35 times across three design systems

**(a) The concern.** Motion easing is a design-system value. The **Console** declares the
whole family. The **Island** and **Landing** declare nothing and copy values — including
the Console's own `--rw-ease` value, across a layout boundary that makes the token
unreachable.

**(b) Every location.**

*Curve A — `cubic-bezier(0.22, 0.61, 0.36, 1)`, the marketing arrival ease. 31 sites,
zero tokens:*
`(public)/_styles/how-it-works.css` ×9 · `features.css` ×10 · `island.css` ×6 ·
`pricing.css` ×4 (29 CSS literals) · `sections/landing/staged.tsx:45` (`const EASE`) ·
`sections/landing/problem/ProblemSection.tsx:41` (`const EASE`, identical tuple).
Confirms **F6 DC-1** and **DC-4**.

*Curve B — `cubic-bezier(0.25, 0.46, 0.45, 0.94)`, which **is** the Console's `--rw-ease`
value:*
declared once at `src/app/(authenticated)/_styles/tokens.css:237`; spelled literally at
`src/app/(public)/_styles/island.css:145`, `:220` (spaced) and
`src/components/auth/auth-island/auth-island.css:70`, `:119` (**unspaced**,
`cubic-bezier(0.25,0.46,0.45,0.94)` — already whitespace-drifted, so a naive literal
audit misses two of the four). Confirms **F6 DC-2**.

*The token that exists and cannot be reached:* `tokens.css:237-242` declares
`--rw-ease` / `--rw-ease-inout` / `--rw-ease-decelerate` / `--rw-dur-fast|base|slow`.
Measured: `var(--rw-ease*)` appears **65 times, all inside
`src/app/(authenticated)/_styles/`, zero times outside**. `tokens.css` has exactly one
importer, `src/app/(authenticated)/layout.tsx:import './_styles/tokens.css'`.

**(c) Why they diverged.** *This is the cross-feature half neither F2 nor F6 could see.*
The token file is **layout-scoped**, so `var(--rw-ease)` genuinely resolves to nothing on
`/login` and on every `(public)` route. The four literal copies of Curve B are therefore
**forced by the stylesheet architecture**, not by carelessness — and that is the finding.
The repo has already solved this exact problem once and wrote down the solution:
`src/app/globals.css:106-112` and `:125-131` hoist the Extended Island tints and the
bright alert reds out of the Console `tokens.css` into `globals.css` for issue #373,
with the rationale in-source — *"globals.css loads on every route, so
onboarding/auth/approval/admin (none of which load the Console tokens.css) can all
consume them."* That sentence is a verbatim description of the motion case, one layer
down. `design-scope-purity.test.ts` already forces `globals.css`'s `:root` as the only
legal home for a `--rw-*` declaration that must cross systems.

**(d) Verdict: ACCIDENTAL — and the cause is architectural, not stylistic.**
**Reachable:** the drift is already present (Curve B's whitespace fork; the shadow ink
diverging to literal `rgba(0,0,0,0.25)` per F6 DC-6). **Do not unify the two curves** —
F6 DC-1 is right that they are different curves for different systems. Unify the
*mechanism*: one `:root` motion block in `globals.css` naming both families, exactly as
#373 did for colour.

---

### X4 — The shared client-hook layer is bypassed once per design system, and the code map cannot see it

**(a) The concern.** `src/hooks/` holds four canonical browser hooks. Each is
re-implemented privately somewhere, **and in three of four cases the private copy sits in
a different design system from the owner's consumers** — which is why no single feature
agent could see the pattern.

**(b) Every location.**

| Concern | Canonical owner | Private copies | System of the copy |
|---|---|---|---|
| reduced motion | `src/hooks/usePrefersReducedMotion.ts:43` (33 importers) | `motion/react`'s `useReducedMotion` at `src/components/ui/be-ui-tilt-card.tsx:58`; `src/app/mfa/challenge/MfaChallengeForm.tsx:69`, `:165` | Island; auth |
| pointer capability | `src/hooks/useMediaQuery.ts:26`, used at `sections/landing/agent-flip-card.tsx:146` | `useHoverCapable()` `src/components/ui/be-ui-tilt-card.tsx:31-47`; inline `useState`+`useEffect` `sections/landing/footer/LandingFooter.tsx:85-92` | Island; Landing |
| mounted-yet | **none — the owner does not exist** | `useHasMounted` + 3 module consts, byte-identical: `sections/landing/hero/HeroSection.tsx:44-46, 57-59` and `sections/landing/cta/CtaSection.tsx:63-65, 70-72` | Landing ×2 |
| count-up | `src/hooks/useCountUp.ts:26` (Console `ValueKpiGrid.tsx:26-28` **and** marketing `FeaturesContent.tsx:336-338`) | `useCountTo` `sections/how-it-works/StatCards.tsx:27-45` | Daylight |

**Two of these carry their own indictment in the owner's docstring.**
`usePrefersReducedMotion.ts:38-40`: *"This is the canonical reduced-motion hook for the
app: **prefer it over `motion/react`'s `useReducedMotion`** so call sites share one source
and one snapshot semantics."* `useMediaQuery.ts:12-15`: the `useSyncExternalStore` shape
exists because it *"never calls setState from an effect body — **which
`react-hooks/set-state-in-effect` rejects**."* That rule is `'error'` at
`eslint.config.mjs:142` — and both private copies (`be-ui-tilt-card.tsx:34-44`,
`LandingFooter.tsx:86-92`) call `setState` from an effect body. They pass because the
call is inside a `matchMedia` callback the rule does not follow, so the lint rule the
docstring cites as the reason does not in fact catch the shape it was cited against.

**(c) Why they diverged — the measured cause.** `docs/directory.md § src/hooks/`
(`:442-450`) lists **two** of the **twelve** production files in that folder. **Eight have
zero mentions anywhere in `docs/directory.md`** (measured by grepping each of the twelve
filenames against the whole map): `settings-form-patch.ts`, `useAccountData.ts`,
`useCountUp.ts`, `useMediaQuery.ts`, `useOffboardingStatus.ts`,
`usePrefersReducedMotion.ts`, `useReveal.ts`, `useSyncPendingCount.ts`. **All four hooks in
the table above are among the eight.** CLAUDE.md's own working rule is *"Default is 'no new file' — check
`docs/directory.md` first."* An engineer who follows that rule for a reduced-motion hook,
a media-query hook, a count-up hook or a reveal hook is told nothing exists. And
`ci:directory-map`'s scope is `SCAN_DIRS = ['worker', 'src/lib']`
(`scripts/ci/directory-map-audit.ts:45`), so **no audit can see any of it** — see §2.

**(d) Verdict: ACCIDENTAL, with one legitimate exception.** `useCountTo`, `useHasMounted`
×2, `useHoverCapable` and `LandingFooter`'s inline copy are accidental. The
`MfaChallengeForm` use of `motion/react`'s `useReducedMotion` is **borderline** — that file
is already inside a `LazyMotion`/`m` context where the motion library's own hook is the
idiomatic read, and the docstring's argument ("one snapshot semantics") is weaker there.
**Reachable:** yes for `useCountTo` (renders on `/how-it-works` on every load) and for the
`useHasMounted` copies. The consequence of the *absence* of a `useHasMounted` owner is
`ProblemSection.tsx` — see X5.

**Builds on** F7 D3 (`useCountTo`), which found the count-up copy inside F7 but not the
Console consumer that makes `useCountUp` a three-system hook, and not the four-hook
pattern.

---

### X5 — The mobile-disclosure state machine: four spellings, three design systems, and the Console already has the extracted owner

**(a) The concern.** "A panel is open: move focus in, close on Escape, restore focus to
the trigger." One behaviour contract, four implementations.

**(b) Every location.**

| Site | System | Escape listener | Focus IN on open | Restore focus | Tab trap | Scroll lock |
|---|---|---|---|:-:|:-:|:-:|
| `src/components/sections/landing/LandingExperience.tsx:136-150` | Landing | `window` (`:148`) | **none** | `:138` | — | — |
| `src/components/ui/SiteNav.tsx:56-79` | Island | `document` (`:69`) | first link (`:76-78`) | `:59-62` | — | — |
| `src/components/admin/AdminSidebar.tsx:72-97` | Console | `document` (`:92`) | panel (`:74`) | `:77` | — | ✓ (`:93`) |
| `src/components/dashboard/reviews/edit-reply/useFocusTrap.ts:18-60` | Console | `document` | first tabbable, else panel (`:29-34`) | ✓ | ✓ | — |

**(c) Why they diverged.** The extracted owner exists but is **parked inside one
feature's folder** — `dashboard/reviews/edit-reply/` — so it reads as the edit-reply
drawer's helper rather than the app's disclosure contract. `AdminSidebar` is in the same
design system as `useFocusTrap` and still hand-rolls it. The two marketing copies were
written against different chrome components in different systems and never met.

**(d) Verdict: ACCIDENTAL on the behaviour, LEGITIMATE on the chrome.** The two chrome
components (Landing vs Island nav) are correctly separate — different design systems, and
08-22's register already protects that split for `Reveal`. What is not legitimate is that
**the same site ships two mobile menus with different keyboard behaviour**: open
`LandingExperience`'s menu and focus stays on the toggle; open `SiteNav`'s and focus moves
to the first link. **Is it wrong?** The Landing copy is not *broken* — it sets
`hidden={!menuOpen}` (`:229`), so a keyboard user simply tabs forward. It is an
inconsistency, not a WCAG failure. **Is it reachable?** Yes, on every narrow viewport;
`/` renders `LandingExperience`, `/features`, `/how-it-works` and `/pricing` render
`SiteNav`. Ranked here for the *divergence*, not for a defect.

---

### X6 — The signup-door derivation: five spellings, three answers, on one site

**(a) The concern.** "What does the primary CTA say, and where does it point, given
`SELF_SERVE_SIGNUP_ENABLED` and `TRIAL_ENABLED`?" Invariant #13 makes this
server-authoritative, and it is — but the *derivation* has no owner.

**(b) Every location.**

1. `src/app/(public)/features/page.tsx:13-20` — ``selfServeEnabled ? (isTrialEnabled() ? `Start your ${trialPeriodDays()}-day free trial` : 'Create account') : null``
2. `src/app/(public)/how-it-works/page.tsx:13-22` — **byte-identical expression**
3. `src/app/(public)/page.tsx:15-25` — deliberately different: `'Get early access'` (not
   `'Create account'`), never null, and additionally derives
   `primaryCtaHref = selfServeEnabled ? '/signup' : '/book-a-demo'` which neither of the
   first two computes
4. `src/app/(public)/pricing/page.tsx:14-19` — computes **no label**; routes the same two
   flags through `buildPlanPresentation`. `PricingContent.tsx:556` then hard-codes
   `Create account`
5. `src/components/ui/SiteNav.tsx:49` — `trialEnabled ? 'Start free trial' : 'Create account'`
   — **no day count** — and this pill renders on all three Daylight pages

The `trialOn = selfServeEnabled && isTrialEnabled()` conjunction is spelled four times
(`features/page.tsx:14`, `how-it-works/page.tsx:14`, `pricing/page.tsx:19`,
`(public)/page.tsx:19` with the operands reversed).

**(c) Why they diverged.** `features/page.tsx:15` says *"Same door as the landing page
and /pricing (see how-it-works/page.tsx)"* — a copy citing another copy as its authority,
naming `/pricing` as a participant that does not implement it. Nobody wrote the function.

**(d) Verdict: ACCIDENTAL.** **Reachable:** whenever both flags are on, `/features`,
`/how-it-works` and `/pricing` render a nav pill saying *"Start free trial"* beside body
copy saying *"Start your 30-day free trial"* or *"Create account"*. This pass did not read
live flag state from Railway/Vercel; the inconsistency is config-reachable, not proven
live.

**Builds on** F7 D1 and F7 §"Where the label is decided (four places, three answers)"
(`01-flowcharts/F7-daylight-pages.md:248`), which found four. The fifth — that
`SiteNav.tsx:49`'s pill and the page body render **different labels for the same door on
the same page** — needs the F1/F6 chrome and the F7 pages in one view.

---

### X7 — The footer column model: two systems, byte-identical type, diverged heading level and link order

**(a) The concern.** One footer data model rendered by two components on one site.

**(b) Every location.**

- Type: `interface FooterColumn { heading: string; links: ReadonlyArray<{label; href}> }`
  — **byte-identical** at `src/components/sections/landing/footer/LandingFooter.tsx:40-43`
  and `src/components/ui/SiteFooter.tsx:18-21`.
- Data: `const FOOTER_COLUMNS` — same name, `LandingFooter.tsx:54-59` vs
  `SiteFooter.tsx:23-36`.
- Render: `.map(column => <nav aria-label={heading}><hN><ul>…` —
  `LandingFooter.tsx:205-219` vs `SiteFooter.tsx:52-66`.

**Three measured divergences:**

1. **Heading level.** `LandingFooter.tsx:208` renders `<h2>`; `SiteFooter.tsx:57` renders
   `<h3>` and carries the reason in-source (`:54-56`): *"h3, not h4: pages put their
   sections at h2, so h4 skipped a level and broke the outline."* **The landing page also
   puts its sections at `h2`** — verified at `hero`… `FutureSection.tsx:156`,
   `CtaSection.tsx:190`, `PersonasSection.tsx:48`, `ProblemSection.tsx:59`,
   `WatchdogsSection.tsx:50`, `TiersSection.tsx:111`, `FleetSection.tsx:454`. So the
   argument written on `SiteFooter` applies unchanged to `LandingFooter` and was never
   applied: the landing footer's column headings are siblings of its section headings.
2. **Product column order.** Landing: features, howItWorks, pricing
   (`LandingFooter.tsx:56`). Site: features, **pricing, howItWorks**
   (`SiteFooter.tsx:26`). Same three links, same site, different order.
3. **Legal.** A column in `SiteFooter.tsx:28-31`; a bottom-bar row in `LandingFooter`,
   with a written rationale at `:47-53` (the 6/1/3 imbalance).

**(c) Why they diverged.** `marketing-links.ts` is already the single owner of
label/href, and `footer-copy.ts:11-14` says so explicitly — *"each surface owns its own
ordering."* The *ordering* decision is therefore deliberate; the *type*, the *render
shape* and the *heading level* are not.

**(d) Verdict: MIXED. Divergence (3) and the link-owner split are LEGITIMATE
specialization** — two design systems, one with a written layout rationale — **and go on
the DO-NOT-UNIFY register (§3).** Divergence (1) is an accidental a11y regression:
**is it wrong?** yes, by the standard `SiteFooter` itself states; **is it reachable?**
yes, on every render of `/`. Divergence (2) is accidental drift with no consequence
beyond inconsistency. Note `SiteFooter` has a test
(`src/components/ui/__tests__/SiteFooter.test.tsx`); `LandingFooter` has **none**.

---

### X8 — The presentation-formatter layer: `Intl` and money formatters forked across the marketing/Console boundary

**(a) The concern.** Locale-aware formatting of counts, dates and money.

**(b) Every location.**

*Counts and dates (the requests family — four copies, not three):*
`NUMBER_FORMAT = new Intl.NumberFormat()` byte-identical at
`src/app/(authenticated)/dashboard/requests/AttributedReviews.tsx:189`,
`BatchReport.tsx:217`, `GhostPipeline.tsx:40` (**the fourth copy, and the only one with
no comment**). The `{year:'numeric', month:'short', day:'numeric', timeZone:'UTC'}`
options object is byte-identical at `AttributedReviews.tsx:190-195`,
`BatchReport.tsx:218-223`, `ContactList.tsx:757-762` (named `VISIT_DATE_FORMATTER`).
The ISO-coercion expression
`` /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00') ``
is byte-identical at `AttributedReviews.tsx:211-213` and `BatchReport.tsx:235-237`.

*Money — across the marketing/Console boundary:*
`formatDollars` `src/app/(public)/pricing/PricingContent.tsx:165-168` returns `49` for
`4900` (integer-aware, `.toFixed(2)` only when needed);
`formatMoney` `src/components/dashboard/settings/BillingPanel.tsx:98` returns `$49.00`
for the same input. Both format a `*_cents` value that originates in `TIER_CONFIG`
(`src/lib/accounts/tier-config.ts:75`) — the marketing page via `buildPlanPresentation`,
the Console via the stored `accounts` snapshot (invariant #9a). **The same price is
rendered two ways on two surfaces the same owner sees.**

*The rest of the app:* an owner module for exactly this exists and is scoped to admin
only — `src/components/admin/ui/format.ts` (`DATE_TIME_FORMAT` `:36`, `DATE_FORMAT` `:48`,
`COUNT_FORMAT` `:55`), whose header at `:21` reads *"never construct a bare
`Intl.DateTimeFormat`, anywhere under"* — a rule that stops at the admin folder boundary.
The dashboard side has ~14 further independent `Intl.DateTimeFormat` constructions, most
pinned to `'en-US'` where the requests family uses `undefined` (viewer locale).

**(c) Why they diverged.** A three-way circular cross-reference that names the copying
and justifies the wrong thing: `AttributedReviews.tsx:187-188` points at `BatchReport`,
`BatchReport.tsx:215-216` points at `ContactList`, `ContactList.tsx:755-756` points at
nothing. **All three justify *module scope*; none justifies the copy.**

**(d) Verdict: MIXED.** The `Intl` count/date copies are ACCIDENTAL — one owner
(`src/components/admin/ui/format.ts` widened, or a sibling under `src/lib/shared/`) covers
all four. **Reachable:** yes, every requests-page render. Two adjacent defects surfaced
while measuring, worth handing to the defect axis rather than the duplication axis:
`BatchReport.tsx:204` renders a server-computed `days_since_visit` with a hardcoded plural
(*"1 days ago"* is reachable), and `AttributedReviews.tsx:170` lacks the
`Number.isFinite` guard its sibling `approval-client.tsx:165` documents as load-bearing.

**The money fork is separately ranked** and is the only item here that crosses the
marketing/pipeline boundary: `$49` vs `$49.00` for one price, from one source constant.

**Builds on** F8 DUP-1 (three copies, same directory). The fourth copy, the money fork
and the admin owner module are the cross-feature layer.

---

### X9 — Four spellings of the human `/u/<token>` unsubscribe URL

**(a) The concern.** Minting the recipient-facing opt-out URL — a statutory artifact.

**(b) Every location.**
- `src/lib/solicitation/dispatch.ts:786-794` `buildUnsubscribeUrl` — the ask footer
- `worker/ingress/unsubscribe.ts:194-208` `resolveAppUrl` + `landingPageUrl` — the
  post-POST redirect
- `src/app/api/u/[token]/route.ts:37` — a **relative** `` `/u/${encodeURIComponent(token)}` ``
- `src/app/(public)/u/[token]/page.tsx:141` — the form action `` `/api/u/${encodeURIComponent(token)}` ``

The first two share the accessor `getWorkerConfig().NEXT_PUBLIC_APP_URL?.trim()`, the
trailing-slash strip `.replace(/\/+$/, '')`, the `/u/${encodeURIComponent(rawToken)}`
suffix and the fail-closed throw. Divergences: different error strings; the ingress
factors origin resolution into a named helper so the boot assertion can share it.

**(c) Why they diverged.** `dispatch.ts:776-784` names the other side explicitly —
*"through the SAME accessor and the same route the unsubscribe ingress reads"* — and
copies it rather than importing it.

**(d) Verdict: ACCIDENTAL for the first two; the other two are LEGITIMATE.**
`api/u/[token]/route.ts:37` is deliberately relative to avoid trusting the `Host` header
(`:31-36`) — already noted by F10 D1 as excluded. **Correcting the brief:** #964/#966 did
**not** add "a third mint" of the same URL. `buildUnsubscribeOneClickUrl`
(`dispatch.ts:814-822`) targets a **different origin and a different path**
(`WORKER_PUBLIC_URL` + `/ingress/unsubscribe/`), and its docstring at `:796-813` is a
forceful argument against collapsing the two: *"A mail client POSTs the `List-Unsubscribe`
HTTPS member with no interaction, so that member must hit a handler that WRITES the
suppression… Found live at #633's staging flip, where the header pointed at the page and
the ledger stayed empty."* **That pair goes on the DO-NOT-UNIFY register (§3), not on the
fix list.**

**Builds on** F10 D1, correcting its "#964 added a third mint" characterisation.

---

### X10 — `completeOutboxNoop`, two owners with a written destination and a third wrapper already at that destination

**(a) The concern.** Completing an owned outbox attempt after a no-op refusal.

**(b) Every location.** `src/lib/solicitation/dispatch.ts:438-446` (takes an
`OutboxHandle`, folds in the exact-attempt throw) · `src/lib/solicitation/ask-generation.ts:793-801`
(takes `(outboxId, attempt)` pre-split). Identical three-line body:
`sql.begin(tx => markOutboxCompletedIfOwned(tx, outboxId, attempt))`. The throw that
dispatch inlines is already factored out on the other side as
`requireAttempt(handle, door)` (`ask-generation.ts:436-441`) — so it is a **third**
duplication of the same guard.

**(c) Why they diverged.** `dispatch.ts:424-437` names the destination — *"The eventual
owner of this is `src/lib/shared/outbox.ts`, beside `markOutboxCompletedIfOwned` — hoist
it there the next time that file is open"* — and forbids exporting it from
`ask-generation.ts` because a value import would drag the LLM seam and cost guard into the
dispatch module graph. `dispatch.ts:58` admits the fork outright.

**(d) Verdict: ACCIDENTAL, and cheaper than the note assumes.** The named destination
**already ships a near-degenerate sibling**: `markOutboxCompleted`
(`src/lib/shared/outbox.ts:87-93`) whose whole body is
`await markOutboxCompletedIfOwned(exec, outboxId, attempt)` — it just does not open the
transaction. The hoist is one exported function beside a function that is already there.
**Reachable:** call sites at `dispatch.ts:1914`, `:1935` and `ask-generation.ts:936`,
`:1343`, `:1541`.

**Builds on** F10 D2, adding the third wrapper at the destination.

---

### X11 — The person-name normaliser, an acknowledged one-directional fork

**(a) The concern.** NFD → strip combining marks → lowercase → collapse whitespace.

**(b) Every location.** `src/lib/solicitation/attribution.ts:80-88`
(`normalizePersonName`, exported, used at `:91` and `:142`) ·
`src/lib/reviews/place-id-resolver.ts:161-168` (`normalizeName`, module-private, used at
`:88`, `:103`). **Correcting the brief:** the second path is `src/lib/reviews/`, not
`src/lib/locations/` — the lines are right.

**Two real divergences.** (i) attribution adds `.replace(/[.,]/g, ' ')` (`:84`), without
which its own `isInitial` check (`:95`, `token.length === 1`) would not work — so the
extra line is load-bearing. (ii) the combining-mark class is spelled with **literal
U+0300/U+036F characters** in `attribution.ts:83` and with the **escaped form
`̀-ͯ`** in `place-id-resolver.ts:164` — semantically equal, and the attribution
spelling is the fragile one (invisible combining marks a reformatter can mangle).

**(c) Why they diverged.** `attribution.ts:76-79` says *"Follows `normalizeName` in
`src/lib/reviews/place-id-resolver.ts`"* — **"Follows", not "shares with"**. The copied-from
side has no docstring and no back-reference, so the dependency is invisible from there.

**(d) Verdict: LEGITIMATE SPLIT, ACCIDENTAL SPELLING.** The punctuation step is a genuine
behavioural difference between "match a person's name" and "match a business's name" — do
not merge the functions. **Fix the byte-level fork only**: normalise
`attribution.ts:83` to the escaped form, and add a back-reference at
`place-id-resolver.ts:161` so the dependency is visible from both ends.

**Builds on** F8 DUP-2, adding the escape-form divergence and the path correction.

---

### X12 — The global-wins ordering clause, hand-copied off its locked owner

**(a) The concern.** The `CONTEXT.md`-locked precedence *"global wins a double match."*

**(b) Every location.** `src/lib/solicitation/suppression.ts:90` (inside
`suppressionMatchSql`, where it **is** the rule, with `LIMIT 1`) ·
`src/lib/admin/suppressions-service.ts:97` (inside `lookupSuppressions`, as list
ordering, no `LIMIT`). Byte-identical 58 characters, indentation aside.

**(c) Why they diverged.** The fragment cannot be reused as-is (different SELECT list,
`LEFT JOIN accounts`, cross-tenant by design). But the *ordering literal* was still hand
copied, and the admin side carries **no** comment — `suppression.ts:52-53` and `:12-14`
claim sole ownership of the precedence and the admin copy is silent on it.
`src/__tests__/ci-audit-wiring.test.ts:125` references *"`suppressionMatchSql`'s
global-wins ordering"* — the guard covers the fragment, not the copy.

**(d) Verdict: ACCIDENTAL, low severity, cheapest possible fix.** **Is it wrong?** The
second is presentation, not the gate. **Is it reachable?** The clause runs on every admin
lookup; the *drift* is hypothetical until the precedence changes, at which point the admin
console would show the account row first while every gate honoured the global one. F9 D3
is right that a comment naming the owner beats a shared fragment here.

**Builds on** F9 D3 — restated because the cross-feature point is that a `CONTEXT.md`
LOCKED term has two SQL spellings and only one of them knows it.

---

### X13 — `.hiw-flow-cap*` re-implements `.rw-dl-cap*`, and both render on the same page

**(a) The concern.** The card caption row — dot, label, right-aligned tail.

**(b) Every location.** Owner: `src/app/(public)/_styles/island.css:1351-1364`
(`.rw-dl-cap`, `.rw-dl-cap-dot`, `.rw-dl-cap-dot.is-bar`, `.rw-dl-cap-tail`), consumed by
**12 components** including six of the how-it-works step artifacts
(`DraftArtifact.tsx:40`, `TriageArtifact.tsx:6`, `WatchArtifact.tsx:40`,
`JudgeArtifact.tsx:8`, `PostArtifact.tsx:6`, `GateArtifact.tsx:12`, `:63`).
Copy: `src/app/(public)/_styles/how-it-works.css:131-147` (`.hiw-flow-cap`,
`.hiw-flow-cap-dot`, `.hiw-flow-cap-tail`), consumed by **one** component,
`HeroFlowArtifact.tsx:28`. `.hiw-flow-cap-tail` (`:147`) is byte-identical to
`.rw-dl-cap-tail` (`island.css:1364`): `{ margin-left: auto; white-space: nowrap; }`.
`.hiw-flow-cap-dot` (`:140-146`) is the same five declarations as `.rw-dl-cap-dot`
(`island.css:1362`), expanded across seven lines instead of one.

**(c) Why they diverged.** `HeroFlowArtifact` is the one artifact that is a server
component in the hero slot; whoever wrote it started a private `.hiw-flow-*` namespace
for the flow rail and carried the caption row into it rather than reaching across to the
Island primitive.

**(d) Verdict: PARTIALLY LEGITIMATE.** The server-component and hero-slot differences are
real specialization (F7 D6 is right). The caption trio is not — three classes reproducing
three shared primitives, one byte-identical, **on a page that renders the shared
primitives six times in the same scroll**. **Reachable:** every `/how-it-works` load.
Narrow fix: adopt `.rw-dl-cap*` in `HeroFlowArtifact` and keep the rest of `hiw-flow-*`
private.

**Builds on** F7 D6, which found it from the F7 side; the F6 half (12 consumers of the
owner, 6 of them on the same page as the copy) is the cross-feature measurement.

---

### Also confirmed, no cross-feature addition

These were fully reported within a feature and are listed only so §3's register and the
next pass can find them from one place:

- Hero-entrance effect verbatim ×3 — `FeaturesContent.tsx:329-333`,
  `HowItWorksContent.tsx:185-189`, `PricingContent.tsx:588-592`. **F7 D2.**
- FAQ accordion ×2 — `HowItWorksContent.tsx:355-379`, `PricingContent.tsx:462-486`.
  **F7 D4.** Worth one line the flowchart did not draw: the *CSS* has one owner
  (`.rw-dl-faq*` in `island.css`; 08-22 explicitly REFUTED a `pricing.css` fork), so this
  is the exact complement — one CSS owner, two JSX+state owners for one a11y contract.
- Dark CTA band ×3 — `FeaturesContent.tsx:258-301`, `HowItWorksContent.tsx:385-422`,
  `PricingContent.tsx:528-571`. **F7 D5.** Cross-feature addition: the three use *three
  different copy mechanisms* — inline ternary (Features), inline ternary (HowItWorks), and
  a `ctaCopy()` resolver over a `CTA_COPY` table (`PricingContent.tsx:154-157`) — and the
  two inline ones have **already diverged on a shared string**:
  `'Connect your Google Business Profile and get your first drafts in minutes.'`
  (`FeaturesContent.tsx:273`) vs the same sentence plus *"Every reply waits for your tap
  until you say otherwise."* (`HowItWorksContent.tsx:393`).
- Star run ×2 — `AttributedReviews.tsx:166-183`, `approval-client.tsx:161-166`. **F8
  DUP-4.** The line `:162` in the brief is `:161`.
- `Promise.all` fan-out at `contacts-repo.ts:103`. **F9 D1.** Guard-scope cause in §2.
- `owner_leads` PII through purge. **F11 finding A.** Guard-scope cause in §2.
- `Staged`'s `EASE` documented as the hero's and not used by it. **F2 D1** — confirmed:
  `staged.tsx:44` calls `[0.22,0.61,0.36,1]` *"The hero entrance's ease"*, and
  `HeroSection.tsx:212` uses `ease: 'easeOut'`, a different curve. Cross-feature note: the
  landing system mixes exactly two curve families across five arrival implementations —
  the tuple at `staged.tsx:45` and `ProblemSection.tsx:41`, and `'easeOut'` at
  `HeroSection.tsx:212`, `FleetSection.tsx:105`, `FutureSection.tsx:63`,
  `LandingFooter.tsx:137`.

---

## 2. The enumerated-scope guard census

### 2.1 The answer to the three questions the brief asked

**Q: Is it the SAME four guards as 08-18's X10?** **No — one is the same, three are its
descendants, and two are new.**

| 08-18 X10 named | State at `1d9b251c` |
|---|---|
| `ci:tenant-scope` (`TENANT_TABLES`, 43) | **SAME guard, still in the class.** `TENANT_TABLES` is still a hand-written array (`scripts/ci/tenant-tables.ts:1-101`) and is still the subject set for two audits (`rls-audit.ts:14` sets `REQUIRED_RLS_TABLES = TENANT_TABLES`). **It has, however, been partly closed** — `scripts/ci/__tests__/tenant-tables.integration.test.ts` now reconciles against `information_schema`, both directions, so an unlisted live table is LOUD. That is a Class-C transition (see 2.2) and 08-22's recommendation #1 was implemented. |
| #505/#773 fan-out pins (9 imported subjects, 4 files) | **DESCENDED, not fixed.** #893 replaced the four pin files with a real audit, `ci:pool-fanout`. The enumeration did not disappear — it **changed shape**, from 9 named subjects to 3 named directories: `export const SCAN_DIRS = ['src/lib/admin','src/lib/dashboard','src/lib/locations']` (`scripts/ci/pool-fanout-audit.ts:142`). The live miss moved with it: 08-18's was `lookupSuppressions`; today's is `contacts-repo.ts:103` (F9 D1). |
| `design-scope-purity` (hard-coded directory list) | **DESCENDED.** Now a derived `cssFilesUnder()` walk (`design-scope-purity.test.ts:67`, `:136`) over two hand-written roots (`LANDING_DIR` `:33`, `ISLAND_PAGE_DIR` `:34`), plus a hard-coded four-file equality at `:128-133`. Strictly better; still in the class. |
| `ci:admin-aal2` (file-text level, not verb level) | **DESCENDED and partly closed.** The pre-auth admin path set is now **derived** from `src/proxy.ts` (`admin-aal2-audit.ts:749`) with a zero-derived-paths fatal at `:750-755` — a Class-C transition. The two walk roots remain hand-written (`:713`, `:728`). |
| — | **NEW: `ci:directory-map`.** `const SCAN_DIRS = ['worker','src/lib']` (`directory-map-audit.ts:45`). |
| — | **NEW: `table-disposition.test.ts`.** Two regexes at `:57-58` and `:63-64` plus two hand-written table lists at `:20-26` and `:28-32`. |

**Q: Has the class grown?** **Yes, and it is larger than any prior pass measured — because
prior passes were looking for the wrong shape.** 08-18 counted 4; 08-22 counted 7 silent
instances against ten-plus loud ones. The full census below finds **46 mechanical guards**,
of which **18 are pure subject enumerations (Class A)** and **25 are scope-narrowed
derivations (Class S)** — a shape no prior pass named, because by the 08-22 rule as
written a filesystem-derived guard *is* Class B. It derives its subjects honestly. It just
derives them from a hand-written root.

**Q: Is there a general fix, or is enumeration the only tractable scope?** **Enumeration of
SUBJECTS is often not tractable and 08-22's second-side-derivation fix is right.
Enumeration of SCOPE is different: it is tractable, and it is not currently visible.** See
2.4.

---

### 2.2 The classifier, extended

08-22 established the rule and its amendment. This pass adds one class and one failure
mode.

- **Class A — subject enumeration.** A hand-written list names the subjects. A new,
  correct, unlisted subject **passes silently**. (08-22's shape.)
- **Class B — derived subjects + exemption list.** Deny-by-default scan; the list excuses
  rather than selects. Healthy, *provided* the exemption list has stale-entry detection.
- **Class C — was A, became B** by a second-side derivation that produces the subjects
  independently. `SQL_TAG_NAMES` is the worked example 08-22 found; three more have since
  made the transition (`TENANT_TABLES`, `admin-aal2`'s pre-auth paths,
  `console-admin-palette`'s admin `page.tsx` sweep).
- **Class S — NEW: scope-narrowed derivation.** Subject discovery is genuinely derived
  (a filesystem walk, a git listing, a migration replay) but the walk's **root** is a
  hand-written directory list. A correct-and-wrong subject placed outside the root passes
  **silently**, and the guard reports success. **This is the shape of every one of the four
  guards the brief named.**

> **Class S restated in one sentence:** *a derived guard is only as wide as its root, and
> nothing in this repo records which roots are uncovered.*

**And a new failure mode that is not a class but a composition — EXEMPTION TRANSIT.**

`owner_leads` is the demonstration.

1. `scripts/ci/tenant-tables.ts:210-214` places it in `REVIEWED_NOT_TENANT_SCOPED` with a
   correct, written reason: *"Pre-signup marketing intake: no account exists yet, so there
   is no tenant to scope by."* That is a **Class-B exemption, correctly made.**
2. `src/lib/account-offboarding/__tests__/table-disposition.test.ts:100-104` builds its
   required set as `TENANT_TABLES ∪ REQUIRED_EXPLICIT_TABLES (:20-26) ∪
   REQUIRED_SPEC_ONLY_TABLES (:28-32)`. `owner_leads` is in none of the three, **because
   step 1 put it in the other list.**
3. The schema-derived catch (`:111-120`, `linkedColumnPattern` `:57-58` +
   `referencesTenantRootPattern` `:63-64`) finds nothing: `owner_leads` (migration 033)
   has no `account_id`/`business_id` column and no FK to `accounts`/`businesses`. Both
   regexes return false.
4. Result: a table holding `name`, `email`, `email_normalized`, `business_name`,
   `google_maps_url` has no purge disposition, no sweep and no verification branch
   (`grep owner_leads worker/ src/lib/account-offboarding/` → **zero hits**). F11 finding A.

**Every guard on that path is individually well built.** The exemption at step 1 is
reasoned and correct *for the scoping question*. The composition is blind because a
"deliberately not tenant-scoped" answer was silently reused as "deliberately not in the
retention inventory" — two different questions, one list. The F14 sentence from this same
window is the exact statement of it (`pending-count.ts:34`): *"Silence means 'not
audited', never 'reviewed'."*

The repo already ships the fix and does not use it: `table-disposition.ts:6`, `:30` define
a `not_applicable` / `not_checked` disposition pair that **zero of 48 rows use.** It exists
precisely to record a consciously-excluded table.

---

### 2.3 The census — 46 guards

**Scope of the census:** every executable audit in `scripts/ci/*.ts` (21), every mechanical
sweep in `src/__tests__/*.test.ts(x)` (24, excluding the two behavioural suites `proxy.test.ts`
and `tenant-isolation.integration.test.ts`), plus `table-disposition.test.ts` pulled in from
`src/lib/account-offboarding/__tests__/` because two prior findings point at it. Data
modules (`tenant-tables.ts`, `tenant-scope-allowlist.ts`, `process-env-baseline.ts`,
`config-coverage-baseline.ts`), the two shared libs and the non-guard
`normalize-v8-coverage.ts` are listed for provenance but not counted.

`Root` = the hand-written scope literal, where one exists. `Stale?` = does the guard detect
an exemption entry that no longer offends.

#### `scripts/ci/` — 21 executable audits

| Guard | Class | Subject-set mechanism (file:line) | Root / narrowing | Stale? | Silent on… |
|---|:-:|---|---|:-:|---|
| `ci:admin-aal2` | **S** + C | recursive walk `:655-676`; pre-auth paths **derived** from `src/proxy.ts` `:749` (zero-derived is fatal `:750-755`) | `resolve(root,'src','app','api','admin')` `:713`, `resolve(root,'src','app','admin')` `:728` | — | an admin mutation route outside `src/app/api/admin/**` |
| `ci:agent-config` | **A** | `PROJECT_SKILLS` `:11-26`, `HOOK_SCRIPTS` `:30-36` | — | — | a new skill in `.agents/skills/` not added to the list |
| `ci:analytics-events` | **A** | `ANALYTICS_EVENT_NAMES` (`src/lib/analytics/events.ts:4-31`) | `DOC_PATH` `:11` | — | a `track()` of a name not in the array |
| `ci:config-coverage` | **A** | `REQUIRED_VAR_DECLARATIONS` (baseline `:21-33`) | — | exact-count gate `:37-41` | a boot-required var in **neither** list — 08-22's A6, unchanged |
| `ci:db-imports` | **S** + B | walk `:257`; worker roots **derived** from `worker/index.ts` registration `:64-` | `SCAN_DIRS = ['src','worker']` **`:20`** | baseline deleted (strict) | a `db/server` import from `scripts/`, `e2e/` |
| `ci:directory-map` | **S** | walk `:236`; `isInScope` `:204-207` | `SCAN_DIRS = ['worker','src/lib']` **`:45`** | rows are checked both ways *within scope* | **`src/app/**`, `src/components/**`, `src/hooks/**`** — see 2.5 |
| `ci:dropped-columns` | **S** + B | migration replay (`MIGRATIONS_DIR` `:50`) + walk `:258` | `SCAN_DIRS = ['src','worker']` **`:51`** | — | `scripts/`, `e2e/`, any `__tests__/` |
| `ci:env-registry` | **S** | walk `:622-650`; schema files enumerated `:189-194` | `RAW_SCAN_ROOTS = ['src','worker']` **`:620`** | — (missing rows only) | a var read only in `scripts/` |
| `ci:feature-surface` | **B** | git diff + `readdirSync` of intakes `:176` | `INTAKE_DIR` `:52`; `ALWAYS_ALLOWED` `:68` | **yes** `:99-110` | only when no intake exists `:230-235` |
| `ci:live-db-suites` | **S** | `git ls-files` with 4 pathspecs `:517-525` | pathspec list `:520`; membership via `LIVE_DB_MARKERS` `:173-178` | **no** on any of 4 allowlists | a live-DB reach naming none of the 4 markers |
| `ci:merge-ledger` | **S** | branch diff, classified against two path lists | `PRODUCTION_ROOTS` `:52`, `GOVERNANCE_PATHS` `:63-74` | — | a diff wholly outside those paths |
| `ci:outbox-seam` | **S** + B | walk `:445`; helper coverage **derived** from `job-outbox-helpers.ts` `:19-25` | `SCAN_DIRS = ['src/lib','src/app','worker']` **`:80`** | — | a raw `job_outbox` INSERT in `src/components/**`, `scripts/**` |
| `ci:outbox-status` | **S** + B | walk `:291-296`; vocabulary derived-import `:7-10` | `TS_SCAN_DIRS = ['src','worker']` **`:53`** + migrations `:54` | **no** (size only printed `:304`) | `scripts/`, `e2e/` |
| `ci:outbox-topics` | **S** + B | walk `:115`; vocabulary from `ALL_QUEUE_NAMES` `:46` | `SCAN_DIRS = ['src/lib','src/app','worker']` **`:50`** | — | `src/components/**`, `scripts/**` |
| `ci:pool-fanout` | **S** | walk `:491`, `:579`; sql bindings **derived-type** `:160`, `:224-` | `SCAN_DIRS = ['src/lib/admin','src/lib/dashboard','src/lib/locations']` **`:142`** | pragma sites printed `:565-568`; zero uses | **`src/lib/solicitation/`, every other `src/lib/*`, `src/app/**`, `worker/**`** |
| `ci:process-env` | **S** + B | walk `:174` + harness ratchet | `SCAN_DIRS = ['src/lib','src/app','src/components','worker']` **`:19`** | **yes** (harness `:120-122`) | `scripts/`, `e2e/` |
| `ci:response-status` | **S** | walk `:223` | `SCAN_DIRS = ['src']` **`:39`** — **`worker/**` deliberately deferred `:22-23`** | — | the entire worker tree |
| `ci:reviews-status` | **S** + A | walk `:161`; **alias set hand-written** `REVIEWS_ALIAS_ALLOWLIST` `:87` | `SCAN_DIRS = ['src/lib','src/app','worker']` **`:60`** | — | a new alias (`rv.status = …`); `:84-85` says "Grow this set" |
| `ci:rls-audit` | **A** → **C** | `REQUIRED_RLS_TABLES = TENANT_TABLES` **`:14`**; migration replay `:73`, `:127` | `MIGRATIONS_DIR` `:30` | — | in-file: any table not in `TENANT_TABLES`. **Closed out-of-file** by `tenant-tables.integration.test.ts` |
| `ci:static-policy` | **S** | two walks `:1130`, `:1141`; 11 rules | `SCAN_DIRS = ['src','worker','scripts']` **`:50`**; `LEGACY_TIER_SCAN_DIRS` **`:51`**; per-rule prefix `^worker[/\\]` **`:828-830`** | **no** on 4 allowlists (`ALLOWED_NEXT_PUBLIC` `:41-48`, `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` `:213-267`, `NODE_ENV_READ_EXEMPT_FILES` `:753-755`, `LEGACY_TIER_HISTORY_EXCLUSIONS` `:61-67`) | `e2e/`, `tests/`, `__tests__/` (except the legacy-tier rule) |
| `ci:tenant-scope` | **A** (subjects) + **B** (exemptions) | own walk `:1421-1435`; subjects = `TENANT_TABLES` | `SCANNED_ROOTS = ['src','worker']` **`:44`** | **yes, three ways** — duplicate `:1287`, unused `:1300`, exact count vs `ALLOWLIST_BASELINE = 369` `:1312`, `:1320` | a table not in `TENANT_TABLES`; `scripts/`, `e2e/`, `__tests__/` |

> **`ci:tenant-scope` is the repo's best exemption ratchet and its subject set is still an
> enumeration.** 369 entries, three independent stale checks, category path invariants —
> and one table missing from `tenant-tables.ts` is invisible to all of it. That is the
> cleanest statement of why Class A and Class B are orthogonal axes, not a spectrum.

#### `src/__tests__/` — 24 mechanical sweeps (all vitest-only; none backs a `ci:*` script)

| Guard | Class | Subject-set mechanism | Root / narrowing | Stale? |
|---|:-:|---|---|:-:|
| `ci-audit-wiring.test.ts` | **B** + S | `package.json` `ci:` keys `:55-60`; `readdirSync(WORKFLOWS_DIR)` `:65-69`; suite walk `:172-185` | `WORKFLOWS_DIR` `:18`; walk roots `:182-183` | **yes** `:112-115`, `:94-103` |
| `console-admin-palette.test.ts` | **A** → **C** | `SWEPT_FILES` `:14-77` **plus** a derived `src/app/admin/**/page.tsx` walk `:183-205` | `ADMIN_ROOTS` `:116` | **yes, twice** `:152-160`, `:169-173` |
| `cost-guard-contract.test.ts` | **S** + B | walk `:60-70` | `SCAN_ROOTS = ['src','worker','tests/llm-eval']` `:43` | **yes** `:87-95` |
| `design-doc-token-pin.test.ts` | **S** | `SYSTEMS` `:40-52`; landing files derived `cssFilesUnder` | 3 doc paths + 3 token roots `:28-52` | row-count floor `:128-129` |
| `design-scope-purity.test.ts` | **S** | two `cssFilesUnder` walks `:67`, `:136`; `ISLAND_PAGE_IMPORTS` `:40-45` | `LANDING_DIR` `:33`, `ISLAND_PAGE_DIR` `:34` | **no** on `PAGE_LOCAL_PROPERTIES` `:51-54` |
| `design-token-single-source.test.ts` | **A** + S | `ISLAND_COLOR_TOKENS` `:80-107`, `BRAND_FONT_TOKENS` `:71-77`; auth files derived `:351` | `AUTH_DIR` `:31` | — |
| `domain-canonical.test.ts` | **S** | walk `:10-21` | `SRC = 'src'` `:8` — `worker/` out of scope | count floor `:26-28` |
| `eslint-boundaries.test.ts` | **A** | `FORBIDDEN_RUNTIME` `:45-52`, `FORBIDDEN_DYNAMIC` `:56-64` | virtual file paths `:70` | — |
| `instrumentation-stripe-config.test.ts` | **B** | `STRIPE_PRICE_ENV_VARS` derived-import `:2` | — | — |
| `public-pages-teal-contrast.test.ts` | **S** | walk `:34-46` | `ROOTS` `:19-25` + `CHROME_FILES` `:26-32` | — |
| `claude-md-shape.test.ts` | **A** | single file `:25`, sections by literal `:55` | — | **no** on `claude-md-cap-ignore` `:33` |
| `focus-visible-marketing.test.ts` | **A** | `FOCUS_RULES` `:60-94` over 11 files `:15-58` | — | — |
| `no-yellow-star-colors.test.ts` | **A** | 4 inline path arrays `:25-29`, `:35-48`, `:55-61`, `:70-73` | — | — |
| `page-metadata.test.ts` | **A** | `AUTH_NOINDEX` `:11-19`, `PUBLIC_INDEXABLE` `:37-49` | — | — |
| `tap-targets.test.ts` | **A** | inline paths `:10`, `:15`, `:19`, `:23`, `:30` | — | — |
| `tablet-grid-breakpoints.test.ts` | **A** | `CASES` `:8-19` | — | — |
| `island-overflow.test.ts` | **A** | `ISLAND_ROOTS` `:11-24` | — | zero-blocks throw `:35-37` |
| `save-bar-sidebar-width.test.ts` | **A** | 3 files `:9-11` | — | — |
| `agent-team-contrast.test.ts` | **A** | 1 file `:5` | — | — |
| `auth-island-mobile.test.ts` | **A** | 1 file `:9-12` | — | — |
| `how-it-works-palette.test.ts` | **A** | 1 file `:11-14` | — | — |
| `runbook-empty-polish.test.ts` | **A** | 2 files `:9`, `:14` | — | — |
| `security-legal-typography.test.ts` | **A** | 2 files `:7-8` | — | — |
| `self-serve-signup-flag-scope.test.tsx` | **A** | 4 page imports `:41-48` | — | — |

#### Pulled in from `src/lib/**/__tests__/`

| Guard | Class | Subject-set mechanism | Root / narrowing | Stale? |
|---|:-:|---|---|:-:|
| `account-offboarding/__tests__/table-disposition.test.ts` | **B** (schema) over **A** (input) | `accountLinkedTablesFromMigrations()` `:55-96` — `CREATE TABLE` body `:68-77`, `ALTER … ADD COLUMN` `:78-84`, named-constraint FK `:86-92`; **completeness set** = `TENANT_TABLES` ∪ `REQUIRED_EXPLICIT_TABLES` `:20-26` ∪ `REQUIRED_SPEC_ONLY_TABLES` `:28-32` `:99-109` | `'supabase/migrations'` `:47`, `:51`; `linkedColumnPattern` **`:57-58`** (12 column names); `referencesTenantRootPattern` **`:63-64`** (2 roots) | sentinel `toContain` `:117-118` proves the derivation is non-empty |

> This remains 08-22's A7 and the amendment applies verbatim: **a derivation is only as
> loud as the enumerations on its path.** 08-22's live miss was `solicitation_send_breaker`
> (`reset_by UUID REFERENCES users(id)`). This window's is `owner_leads`, and it arrives by
> a *different* route — exemption transit (2.2), not a missing column name. **08-22's
> proposed two-line fix (add `\breset_by\b`, widen the roots to include `users`) would NOT
> have caught `owner_leads`**, which has no FK at all. That is worth recording: the fix on
> the register is still correct and is no longer sufficient.

#### Provenance rows (not counted as guards)

`scripts/ci/lib/ratchet-harness.ts` — the shared walk. **Provides a mechanism and
deliberately no scope**: `scanDirs` is a required caller field (`:65-74`) and the header
says so (`:5-7`). Shared filters only: `DEFAULT_SCAN_EXT` `:23`, `DEFAULT_SKIP_DIRS` `:26-33`,
`DEFAULT_SKIP_FILE` `:36`; shared stale-entry loop `evaluateAgainstBaseline` `:114-124`.
11 consumers.
`scripts/ci/lib/sql-tag-scan.ts` — `SQL_TAG_NAMES` `:40`, the **Class C** worked example,
closed by `static-policy-audit.ts:722-738`.
`scripts/ci/tenant-tables.ts` · `tenant-scope-allowlist.ts` · `process-env-baseline.ts` ·
`config-coverage-baseline.ts` — data.
`scripts/ci/normalize-v8-coverage.ts` — a repair step, not a guard.
`src/__tests__/proxy.test.ts` · `tenant-isolation.integration.test.ts` — behavioural.

---

### 2.4 The headline numbers, and the general fix

**46 guards. 18 Class A. 25 Class S. 4 Class C. 6 defend against an empty scan.**

Three measurements matter more than the totals.

**(1) `SCAN_DIRS` is the dominant enumeration in this repo, and nothing reviews it.**
Twenty-five guards narrow an honest derivation with a hand-written directory list. Those
25 lists name **fourteen distinct roots**. Nowhere — not in a doc, not in a test, not in
`ci-audit-wiring.test.ts` which already reads every `ci:` script and every workflow — is
there an artefact that says *which directories under `src/` and `worker/` are in **zero**
audit's scope*. `src/lib/solicitation/`, `src/hooks/`, `src/components/` and most of
`src/app/**` are, in different combinations, in that set. Every one of this pass's
guard-attributable findings lands there.

**(2) A typo'd scope root is silently green.** `ratchet-harness.ts:51-55` catches the
`readdir` error for a missing scan directory and returns, documented at `:78-80`. Eleven
audits inherit that. **Only `pool-fanout-audit.ts:537-539` has a `scannedCount === 0`
fatal.** Five more guards defend by other means (`design-scope-purity.test.ts:59-65`,
`:125-134`; `design-token-single-source.test.ts:348`; `domain-canonical.test.ts:26-28`;
`admin-aal2-audit.ts:750-755`; `design-doc-token-pin.test.ts:128-129`). **Forty of
forty-six do not.** The mechanism that implements the class's scope is itself silent on a
bad scope.

**(3) Stale-entry detection is present on 7 of the ~20 exemption lists.** Present:
`ci:tenant-scope` (three ways), `ci:feature-surface`, `ci:process-env` (via the harness),
`ci-audit-wiring`, `console-admin-palette` (twice), `ci:config-coverage` (exact count),
`ci:db-imports` (baseline deleted outright). Absent: all four `static-policy` allowlists,
all four `live-db-suites` file sets, `outbox-status`'s `MIGRATION_ALLOWLIST` (size printed
only), `design-scope-purity`'s `PAGE_LOCAL_PROPERTIES`, `claude-md-shape`'s ignore markers,
`response-status`'s `EXEMPT`.

#### Is enumeration genuinely the only tractable scope?

**For subjects, often yes** — and 08-22's answer (a second-side derivation, Class C) is
right and has now been implemented three more times. Nothing here changes that
recommendation.

**For scope, no — and the fix is cheaper than the meta-audit 08-22 deferred.** 08-22 said
build `ci:guard-scope` *"only if the class recurs a ninth time."* It has recurred, but the
right build is not an audit over exported readonly arrays. It is two changes, in this
order:

1. **Make an empty scan fatal, once.** Add the `scannedCount === 0` check to
   `ratchet-harness.ts` itself rather than to eleven callers — the harness already knows
   how many files it produced. `pool-fanout-audit.ts:537-539` is the worked example to
   copy. **~10 lines; turns 40 silent guards loud on a typo'd or renamed root.**
2. **Make the scope gap a committed artefact.** Export `SCAN_DIRS` from every audit that
   has one (12 already do; `pool-fanout-audit.ts:142` is the model) and add one case to
   `src/__tests__/ci-audit-wiring.test.ts` — which already imports `package.json`, walks
   `.github/workflows/` and walks `src/` and `worker/` — that computes, for every immediate
   subdirectory of `src/` and `worker/`, which audits cover it, and **fails when a
   directory is covered by zero**, with a `GUARD_SCOPE_GAPS` exemption list carrying a
   one-line reason per entry and a stale-entry check. `src/lib/solicitation/` and
   `src/hooks/` would have to be written down with a reason on the day someone chose not
   to cover them. **That converts Class S into Class B for the whole census at once**, by
   the same move that closed `SQL_TAG_NAMES`: keep the enumeration, derive the other side.

Ranked against 08-22's list: this is cheaper than its item 4 (the `ci:guard-scope`
meta-audit) and strictly wider than its items 2 and 3. Its item 1 has landed. **Item 3
(widen `linkedColumnPattern`) should stay on the list and be re-scoped** — see the note
under the `table-disposition` row: it no longer covers the live miss this window produced.

---

### 2.5 The three live consequences attributable to a guard's scope

Each is reported in full by a flowchart agent; recorded here because they share one cause.

| Consequence | Guard | Why it is outside the scope |
|---|---|---|
| **`owner_leads` retains owner PII through a `delete_data` purge.** Reachable — F11 A. | `table-disposition.test.ts` | Exemption transit (2.2) plus a schema derivation that keys on columns the table does not have by design. |
| **A two-way `Promise.all` DB fan-out on a Vercel-served owner path** (`contacts-repo.ts:103`). Reachable — F9 D1. | `ci:pool-fanout` | `SCAN_DIRS` is three service dirs; `src/lib/solicitation/` is not one. The header at `:99-112` reasons carefully about `src/app/**` and never about the other `src/lib/*` services. |
| **`docs/directory.md` names `reveal.tsx` as "the one arrival motion" when it has zero importers, and omits 10 of the 12 files in `src/hooks/`.** | `ci:directory-map` | `SCAN_DIRS = ['worker','src/lib']`. Measured: `reveal.tsx` had three importers at `72dc58ac` and **zero** at HEAD; `docs/directory.md:103` still describes it. And of the twelve files in `src/hooks/`, only two have a row in that folder's section and **eight have no mention anywhere in `docs/directory.md`** — including all four hooks that X4 shows being privately re-implemented. |

The third is the one that closes the loop between §1 and §2: **the guard whose scope
excludes `src/hooks/` is the reason CLAUDE.md's "check `docs/directory.md` first" rule
cannot prevent a duplicate hook, and X4 is what that costs.**

---

## 3. Additions to the DO-NOT-UNIFY register

Written to survive re-discovery. Nothing here re-proposes an entry from
`PATHFINDER-2026-08-18/02-duplication-report.md:397`,
`PATHFINDER-2026-08-22/02-duplication-report.md:409` or
`PATHFINDER-2026-08-24/02-duplication-report.md:454`.

| Pair | Why it stays separate | Evidence |
|---|---|---|
| **The two ease-curve FAMILIES (Landing/Island `0.22,0.61,0.36,1` vs Console `0.25,0.46,0.45,0.94`)** | Two design systems chose two curves on purpose. X3 unifies the *mechanism* (one `:root` motion block in `globals.css`, the #373 precedent) and must not collapse the values. A single `--rw-ease` for all three systems re-times every Console transition. | `tokens.css:237` vs `staged.tsx:45`; F6 DC-1 |
| **`buildUnsubscribeUrl` vs `buildUnsubscribeOneClickUrl`** | Different origin, different path, different HTTP contract. The human page renders a confirm button and **writes nothing**; the RFC 8058 member must hit a handler that WRITES. Collapsing them ships a header that silently 200-no-ops — observed live at #633's staging flip. | `dispatch.ts:786` vs `:814`; rationale `:796-813`, call site `:981-985` |
| **`api/u/[token]/route.ts:37`'s relative `/u/<token>`** | Deliberately relative so the redirect never trusts the `Host` header. Any "one URL owner" that returns an absolute origin breaks that property. | `src/app/api/u/[token]/route.ts:31-37` |
| **`normalizePersonName` vs `normalizeName`** | The `.replace(/[.,]/g,' ')` step is load-bearing for `isInitial` (`attribution.ts:95`) and would be wrong for a business name. Merge the SPELLING of the combining-mark class, never the functions. | `attribution.ts:80-88` vs `src/lib/reviews/place-id-resolver.ts:161-168` |
| **The Landing footer's Legal-in-the-bottom-bar vs `SiteFooter`'s Legal column** | Two design systems, and the Landing choice carries a written layout rationale (the 6/1/3 imbalance). `marketing-links.ts` already owns label/href; `footer-copy.ts:11-14` states that ordering is per-surface. Unify the TYPE and the heading level (X7), not the composition. | `LandingFooter.tsx:47-53`, `footer-copy.ts:11-14` |
| **`.hiw-flow-*` (minus the caption trio) vs `.rw-dl-*`** | `HeroFlowArtifact` is the only server-component artifact, in the only hero slot, using `<figure>`/`<figcaption>`. The flow rail is a genuinely different illustration. Adopt `.rw-dl-cap*` for the caption row only. **Do not** propose collapsing the seven step artifacts into one component. | F7 D6; `how-it-works.css:108-230` |
| **`useFocusTrap` vs the three disclosure copies — unify the CONTRACT, not the component** | `useFocusTrap` traps Tab because a modal drawer must; a nav disclosure that traps Tab is a bug. `AdminSidebar` locks body scroll because a full-screen drawer must; the two marketing menus must not. A shared owner needs a "which disclosure posture am I under" parameter — the shape 08-22 and 08-24 have already ruled against twice. **Extract the Escape+restore-focus pair; leave trap and scroll-lock at the call site.** | `useFocusTrap.ts:18-60` vs `AdminSidebar.tsx:72-97`, `SiteNav.tsx:56-79`, `LandingExperience.tsx:136-150` |
| **`formatDollars` (marketing) vs `formatMoney` (Console) — unify the FORMAT, not the reader** | The two read different sources by invariant #9a: `/pricing` reads live `TIER_CONFIG`, Billing reads the stored `accounts` snapshot. That split is correct and must survive. What must NOT survive is the two of them disagreeing on `$49` vs `$49.00` for one number. | `PricingContent.tsx:165-168` vs `BillingPanel.tsx:98`; F7 §"Pricing's data source" |
| **`PURGE_TOMBSTONE_SENTINELS` holds VALUES, not SQL** | X2 adds two members and must not become a fragment builder. `purge-sentinels.ts:15-23` states why: the writer's `=` and the verifier's `IS DISTINCT FROM` asymmetry belongs visible at the call site. | `purge-sentinels.ts:15-23` |
| **The 25 `SCAN_DIRS` literals — do NOT collapse them into one shared constant** | Each audit's scope is a *decision*, and several are load-bearing and reasoned in-source: `ci:response-status` deliberately defers `worker/**` (`:22-23`); `ci:static-policy` runs a *wider* second walk for one rule (`:51`); `ci:pool-fanout` argues its three dirs against `src/app/**` (`:99-112`). One shared root would make every audit as wide as the widest and drown three of them in findings. §2.4's fix **keeps all 25 and derives the other side** — the `SQL_TAG_NAMES` move, not a merge. | `ratchet-harness.ts:5-7` (*"Each audit still OWNS its SCAN_DIRS"*), `pool-fanout-audit.ts:99-112`, `response-status-audit.ts:22-23` |
| **`REVIEWED_NOT_TENANT_SCOPED` vs a purge disposition — two questions, and they must stay two lists** | The `owner_leads` bug (2.2) is NOT an argument for merging the scoping inventory with the retention inventory. "No tenant to scope by" and "not subject to purge" are independent facts — `job_outbox` and `impersonation_sessions` are exempt from the first and present in the second. The fix is to make `table-disposition.ts`'s existing `not_applicable` / `not_checked` pair mandatory-and-used, not to make one list answer both. | `tenant-tables.ts:189-229` vs `table-disposition.ts:6`, `:30` |

---

## 4. Sources consulted

**Pass artifacts, read in full or in the cited ranges:**
`docs/reviews/PATHFINDER-2026-08-26/SCOPE.md` · `00-features.md` ·
`01-flowcharts/{F1,F2,F3,F6,F7,F8,F9,F10,F11}-*.md` (section headings for all nine;
F2 `:362-400`, F6 `:351-430`, F7 `:216-275`, `:485-600`, F8 `:463-480`, F9 `:484-562`,
F10 `:513-530`, F11 `:412-470` in full) ·
`PATHFINDER-2026-08-18/02-duplication-report.md:360-418` (X9, X10, register) ·
`PATHFINDER-2026-08-22/02-duplication-report.md:400-509` (register, X10 verdict) ·
`PATHFINDER-2026-08-22/01-flowcharts/F7-F8-postal-gate-and-allowlist.md:300-419`
(the Class A/B/C classifier and its census) ·
`PATHFINDER-2026-08-24/02-duplication-report.md:440-475` (register, corrections).

**Production source, read at `1d9b251c`:**
`src/components/sections/landing/{LandingExperience,staged,reveal,ambient-motion,agent-flip-card}.tsx` ·
`sections/landing/{hero/HeroSection,cta/CtaSection,problem/ProblemSection,fleet/FleetSection,future/FutureSection,footer/LandingFooter,footer/footer-copy}.tsx|ts` ·
`src/components/ui/{SiteNav,SiteFooter,be-ui-tilt-card}.tsx` ·
`src/hooks/{usePrefersReducedMotion,useMediaQuery,useCountUp,useReveal}.ts` ·
`src/components/sections/{features/FeaturesContent,how-it-works/HowItWorksContent,how-it-works/StatCards}.tsx` ·
`src/app/(public)/pricing/PricingContent.tsx` ·
`src/app/(public)/{page,features/page,how-it-works/page,pricing/page}.tsx` ·
`src/app/globals.css:1-200` · `src/app/(authenticated)/_styles/tokens.css:225-250` ·
`src/app/(public)/_styles/{island.css:1340-1375,how-it-works.css:120-160}` ·
`src/components/admin/AdminSidebar.tsx:70-110` ·
`src/components/dashboard/reviews/edit-reply/useFocusTrap.ts` ·
`src/components/dashboard/settings/BillingPanel.tsx:88-100` ·
`supabase/migrations/033_owner_leads.sql` · `scripts/ci/tenant-tables.ts:189-225` ·
`src/lib/account-offboarding/__tests__/table-disposition.test.ts:1-130` ·
`scripts/ci/{directory-map-audit.ts:1-50,pool-fanout-audit.ts:53-146}` ·
`src/lib/solicitation/contacts-repo.ts:95-115` · `docs/directory.md:103,442-470` ·
`eslint.config.mjs:140-146`.

**Guard census (§2), read in full:** every `*.ts` in `scripts/ci/` except
`scripts/ci/__tests__/` and `scripts/ci/self-hosted-runner/` (28 files) · every
`*.test.ts(x)` directly in `src/__tests__/` (26 files) ·
`src/lib/account-offboarding/__tests__/table-disposition.test.ts` ·
`scripts/ci/lib/{ratchet-harness,sql-tag-scan}.ts` · the `ci:*` block of `package.json`.
Every `SCAN_DIRS` / `SCANNED_ROOTS` / `ROOTS` / pathspec literal quoted in §2.3 was read at
the cited line, and the verbatim dumps of all 25 are held in the census working notes.

Backend candidates L–S (X1, X2, X8–X12) and the §2 census were each verified line-by-line
by a dedicated read-only agent; their per-candidate and per-guard evidence — including the
`od -c` byte dump behind X11's combining-mark finding, the 33-site enumeration behind X1,
and the class assignment for all 46 guards — is reproduced above rather than summarised.

**Exhaustive greps whose full output was inspected** (negative claims rest on these):
`cubic-bezier(0.22, 0.61, 0.36, 1)` (31 hits) · `cubic-bezier(0.25,?0.46,?0.45,?0.94)`
(5) · `var(--rw-ease` (65, all under `(authenticated)/_styles/`) ·
`'(hover: hover) and (pointer: fine)'` (6) · `'Escape'` (6) · `useReducedMotion` (7) ·
`setHeroIn` (6) · `useCountTo|useCountUp` (20) · `rw-dl-cta"` (3) · `rw-dl-cap` (44) ·
`owner_leads` (14, non-test) · `scrubbed:` (21 in the two purge files) ·
`signupCtaLabel` (16) · each of the twelve `src/hooks/` filenames against
`docs/directory.md`.

**Gaps.** (1) No test suite was executed; every "no guard catches this" claim comes from
reading the guard's own scope literal, not from a mutation experiment. (2) X6's
reachability is config-dependent — live `SELF_SERVE_SIGNUP_ENABLED` / `TRIAL_ENABLED`
values on Railway and Vercel were **not** read. (3) `features.css` and `pricing.css` were
counted for the ease census but not read in full, so a CSS-level duplication inside them
is possible and unmeasured. (4) The §2 census covers `scripts/ci/**` and
`src/__tests__/*.test.ts*`; guards living in `**/__tests__/` beside their subject
(e.g. `table-disposition.test.ts`) are included only where a prior pass or this pass's
findings pointed at them — that set is **not** exhaustive and is flagged as such in §2.
