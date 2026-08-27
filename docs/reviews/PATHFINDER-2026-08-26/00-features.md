# Feature inventory — Pathfinder 2026-08-26

Window `72dc58ac..1d9b251c`. **89 changed production files, all placed, zero
unplaced.** Discovery measured 14 features; the orchestrator charts **8** and
records the remaining 3 as no-chart, with reasons.

---

## Boundary decisions the orchestrator made

Discovery proposed 14. Three adjustments:

1. **F3 + F4 + F5 merged into one charted feature (F3 Landing sections).**
   Discovery split the eight landing sections three ways on shared-primitive
   usage and flagged the merge as legitimate. For a flowchart the three share
   one composition root, one CSS cascade and one arrival model — charting them
   apart would draw the same diagram three times. The primitive-usage table that
   justified the split is preserved in §3 below, because the **duplication**
   phase needs it even though the **flowchart** phase does not.

2. **F12, F13, F14 are not charted.** All three changed by comment only in this
   window — #969 (13 insertions, zero behaviour change), #962 (11 files, 44
   insertions, **100% comments**). A flowchart of an unchanged runtime path
   costs a subagent and tells this pass nothing. Their content feeds the
   duplication and process axes instead.

3. **F1 + F2 stay separate.** They are the smallest charted units and the most
   architecturally loaded — the CSS import block and the shared motion
   primitives are where this window's open questions live.

---

## Charted features (8)

| # | Feature | Files | Lines | Merges |
|---|---|---:|---:|---|
| F1 | Landing Experience — composition root & chrome | 6 | 1,431 | #953, #968 |
| F2 | Landing motion & interaction primitives | 7 | 1,204 | #955, #959, #968 |
| F3 | Landing sections (bookends + carousel band + argument) | 26 | 5,605 | #953, #959, #968 |
| F6 | Island design system — chrome, tokens, arrival motion | 14 | 2,990 | #976, #970 |
| F7 | Daylight marketing pages (Features · How It Works · Pricing) | 25 | 4,851 | #976 |
| F8 | Solicitation attribution (`review_attributed`) — **new** | 5 (+8 touched) | 1,056 | #954 |
| F9 | Suppression ledger & unsubscribe | 5 | 1,925 | #970, #975, #962 |
| F10 | Ask composition, compliance lint & dispatch | 6 | 3,495 | #964 |
| F11 | Owner offboarding purge & verification | 4 | 2,263 | #972, #970, #975 |

> That is nine rows for eight charted features — F3 absorbs the former F4 and F5.

### Entry points

- **F1** `src/components/sections/landing/LandingExperience.tsx:110`
- **F2** `staged.tsx:68` · `carousel.tsx:116`, `:193` · `agent-flip-card.tsx:129` ·
  `ambient-motion.tsx:78`, `:100`, `:161`
- **F3** `hero/HeroSection.tsx:216` · `cta/CtaSection.tsx:180` ·
  `fleet/FleetSection.tsx:415` · `personas/PersonasSection.tsx:40` ·
  `watchdogs/WatchdogsSection.tsx:42` · `future/FutureSection.tsx:90` ·
  `problem/ProblemSection.tsx:46` · `tiers/TiersSection.tsx:73`
- **F6** `ui/SiteShell.tsx:34` · `SiteFooter.tsx:38` · `HeroWash.tsx:22` ·
  `Reveal.tsx:12` · `src/hooks/useReveal.ts:24`
- **F7** `FeaturesContent.tsx:312` · `HowItWorksContent.tsx:173` ·
  `PricingContent.tsx:573`
- **F8** `worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts:139` ·
  `src/lib/solicitation/attribution.ts:256`, `:136`, `:416` ·
  `job-outbox-helpers.ts:855` · `api/dashboard/solicitation/attributed/route.ts:25`
- **F9** `worker/ingress/resend/solicitation-lane.ts:307` ·
  `solicitation/suppression.ts:233`, `:75` · `admin/suppressions-service.ts:63`
- **F10** `solicitation/dispatch.ts:1897`, `:943`, `:237` ·
  `ask-compliance-lint.ts:776` · `ask-prompt-policy.ts:126` ·
  `messaging/messaging-adapter.ts:75`
- **F11** `account-offboarding/purge-verification.ts:40` ·
  `purge-sentinels.ts:51` · `worker/jobs/account-offboarding/purge-stages.ts:111`

---

## Not charted (3) — comment-only in this window

| # | Feature | Why not charted |
|---|---|---|
| F12 | Batch approval / halt wire projection | #969 is **comment-only** — re-attributes the no-internal-id rule from "ADR 0012" to "#629 round-2 F10". 13 insertions, 8 deletions, zero behaviour change. #970 adds 16 lines to one panel. |
| F13 | Moderation held-draft & flagged queue | #962 adds 20 comment lines across five files, each stating which statements `ci:tenant-scope` is **silent** on because `flagged_responses` is absent from `scripts/ci/tenant-tables.ts`. No executable change. |
| F14 | `ci:tenant-scope` blind-spot annotation sweep (#894) | Cross-cutting by **audit surface**, not a runtime feature. #962 is 11 files / 44 insertions / **100% comments**. It exists in this inventory only because three files — `api/lead-intake/route.ts:209`, `admin/nav-counts-service.ts:18`, `worker/background/pollers/health-alert/checks.ts:81` — have no other feature home. |

> F14's own governing sentence, verbatim from `pending-count.ts:34`:
> *"Silence means 'not audited', never 'reviewed'."* That is the window's best
> one-line statement of what an enumerated-scope guard buys and does not buy.

---

## §3 — Measured facts the duplication phase needs

### The arch log's CSS import-order claim is WRONG

The scope brief, taken from the arch log, reports two unguarded dependencies:
`agent-flip-card.css` and `carousel.css` "must stay last".

**At HEAD `agent-flip-card.css` is imported FIRST** (`LandingExperience.tsx:18`).
Measured reality:

| # | Dependency | Declared at | Guarded? |
|---|---|---|---|
| 1 | `carousel.css` after **every** section stylesheet — ties 0,2,0 with `.rw-lp-fleet-tier[data-tier='watchdog']` | `LandingExperience.tsx:29-33` + `carousel.css:18-25` | **NO** |
| 2 | `watchdogs.css` after `agent-flip-card.css` — "0,2,0 selectors … win on order alone" | `watchdogs.css:195-198` | **NO** — and **absent from the arch log entirely** |
| 3 | `landing-experience.css` after `agent-flip-card.css` | `agent-flip-card.css:67-72` | N/A — **deliberately not** a dependency; the flip card out-specifies to `.rw-lp-flip .rw-lp-flip-face` precisely so the layout does not depend on import order |
| 4 | `globals.css` order of the four Island page sheets | `globals.css:186-189` | **YES** — `src/__tests__/design-scope-purity.test.ts:39-45` pins the four strings in order |
| 5 | `how-it-works.css` intra-file — `.hiw-step::before` reset must follow the `@supports` block | `how-it-works.css:556-560` | **NO** (intra-file, not import order) |

**Three unguarded order dependencies, not two.** The one the log names does not
exist in that form, one the log never mentions does, and the one dependency that
*is* guarded gets no credit.

### Motion primitives — four shared, one private, one orphaned

| Section | `Staged` | `useCarousel` | `AmbientVideo` | `AgentFlipCard` |
|---|:-:|:-:|:-:|:-:|
| hero | private variant | — | ✓ `:133` | — |
| cta | — | — | ✓ `:117` | — |
| problem | ✓ `:7` | — | ✓ `:95` | — |
| fleet | ✓ `:10` | ✓ `:260` | — | via `fleet.css` |
| personas | ✓ `:5` | ✓ `:41` | — | ✓ |
| watchdogs | ✓ `:7` | ✓ `:43` | — | ✓ |
| future | ✓ `:8` | ✓ `:93` | — | — |
| tiers | ✓ `:6` | — | — | — |

`Staged` triggers on `whileInView` (`staged.tsx:64`). **The hero's arrival is a
private `delay: 0.15 + step * 0.11` on load** (`HeroSection.tsx:212`) — a
different trigger, so possibly specialization. The duplication phase rules on
it; discovery deliberately did not.

### Dead code with a stale doc row

`src/components/sections/landing/reveal.tsx` (70 lines) had **three importers at
`72dc58ac`** — `FutureSection.tsx:5`, `PersonasSection.tsx:4`,
`WatchdogsSection.tsx:4` — and **zero at `1d9b251c`**. #959/#968 replaced every
`Reveal` with `Staged` and left the file behind. Proven by `git grep` at both
window endpoints.

`docs/directory.md:103` still calls `reveal.tsx` **"the one arrival motion."**

**Nothing catches this.** `ci:directory-map` is scoped to `worker/` + `src/lib/`
(CLAUDE.md), so a stale row for a `src/components/` file fails no audit.

### A de-duplication that DID land

#976 deleted `src/components/sections/features/useReveal.ts` and added
`src/hooks/useReveal.ts`; `src/components/ui/Reveal.tsx:12` now wraps it and 12
`Feat*` files import the hook directly. Proven by `git diff --name-status`
(`D` / `A`). Two reveal hooks with disagreeing thresholds became one.

### Straddle to watch

`RequestsClient.tsx` (741 lines) and `requests.css` (702) are shared between
**F8** (attribution) and **F12** (approval/halt wire). Two features writing one
surface.
