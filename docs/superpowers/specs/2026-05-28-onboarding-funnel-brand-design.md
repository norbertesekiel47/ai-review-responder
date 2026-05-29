# Brand the conversion funnel — design

> **Date:** 2026-05-28
> **Status:** Approved (brainstorm) — pending implementation plan
> **Audit item:** `docs/launch-ready-part2.md` → Prioritized fix list → P0 #1 (line 134):
> *"Brand the conversion funnel — apply island layout + teal CTAs + motion to all `onboarding/*` pages, especially `payment-success`."*
> **Branch / worktree:** `fix/launch-p0-onboarding-funnel` @ `/private/tmp/repworth-onboarding-funnel`

---

## 1. Problem

The five onboarding funnel pages — the highest-stakes conversion path — render as
unstyled developer prototypes (`bg-gray-50` backgrounds, `bg-blue-600` CTAs), with
banned amber/orange/yellow bleed-through on the demo page. They carry zero RepWorth
brand identity at the exact moments a prospect decides to pay and a new customer
forms their first impression. The marketing pages already prove the island design
system exists (`PageShell`, `src/components/sections/**`); the funnel simply never
adopted it.

Affected pages and current off-brand anchors:

| Page | Client component | Current anchor |
|---|---|---|
| `/onboarding/start` | `StartLocationClient.tsx` | `bg-gray-50`, `bg-blue-600` |
| `/onboarding/business` | `BusinessWizardClient.tsx` + `Step*` + `ProgressDots` | `bg-gray-50`, blue dots |
| `/onboarding/demo` | `PaywallWithDemoClient.tsx` | `bg-gray-50`, **amber** banner, **yellow** stars, blue AI box |
| `/onboarding/pay` | `pay/page.tsx` + `PlanPickerClient.tsx` | gray page wrapper; picker already mostly teal; lone `text-amber-700` |
| `/onboarding/payment-success` | `PaymentSuccessClient.tsx` | `bg-gray-50`, `bg-blue-600`, no celebration |

## 2. Goal & hard constraints

Apply the RepWorth island system (sage background + white island + teal CTAs +
`motion`) to all five funnel pages through **one shared shell** carrying a
**cross-page step thread**.

- **Presentational only.** No changes to polling, redirects, payloads, guards, or
  any funnel logic. Verified contracts (status polling/backoff, Stripe handoff,
  wizard payload building, place-prefill) stay byte-for-byte intact.
- **Token discipline.** Only approved brand tokens (see §6). No amber, orange,
  stone, yellow, or blue anywhere in the funnel after this change.
- **No regression to the four live marketing pages.** Do not modify `PageShell`.

## 3. Decisions (from brainstorm)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Shell strategy | **New `OnboardingFunnelShell`** (not reuse `PageShell`, not per-page reskin) | `PageShell` is built for tall scrolling marketing pages (scroll-parallax + section dot-nav) — dead weight on short centered forms. A purpose-built form-centric shell gives the funnel one cohesive identity and answers the audit's "no shared shell / progress thread" gap. |
| D2 | PR scope | **Presentational only** | Keeps the PR focused and reviewable. The ≥16px iOS input-zoom fix rides along because we are already restyling those inputs. Behavioral items (silent post-payment redirect, timeout support link) logged as follow-ups. |
| D3 | Step thread granularity | **Top-level milestones**: `Find business → Preview → Plan → Set up` | 4 calm milestones read clearly and fit 375px. The wizard's existing 3 inner dots stay nested inside the "Set up" page. A flat 6-step stepper cramps on mobile and has no clean home for `payment-success`. |
| D4 | Review-card star color | **Teal `#97B3AE` filled**, empty `#cdd9ce` | Audit wants stars off yellow (`#eab308`); teal is the primary brand color and gives clear filled/empty contrast. |

## 4. Architecture — new shared module `src/app/onboarding/_shared/`

Folder convention confirmed against the codebase: private non-route folders use the
`_shared/` prefix (e.g. `src/app/api/dashboard/past-replies/_shared`). Colocated
with the funnel it serves.

### 4.1 `OnboardingFunnelShell.tsx` (`'use client'`)
The island wrapper. One deep component hiding all the brand chrome behind a small
interface. Renders:
- Sage `#D2E0D3` root, `relative`, **no `overflow-hidden`** (iOS Safari rule).
- **Static** muted glassmorphism atmosphere (same 4-card motif as `PageShell`)
  rendered with `aria-hidden="true"`, but **without** `useScroll`/`useTransform` —
  funnel pages don't scroll, so parallax would be inert. This is genuinely
  different behavior from `PageShell`, not duplicated logic.
- Island: `bg-white rounded-[3rem] shadow-2xl` with the brand entry animation
  (`initial opacity:0,y:40,scale:0.95 → animate …`, `duration:0.8`).
- RepWorth wordmark nav as the island's first child (teal circle + uppercase
  `RepWorth`), per the brand nav-bar spec.
- `<FunnelStepThread>` directly under the nav when `showThread`.

Interface:
```ts
interface OnboardingFunnelShellProps {
  step?: 'find' | 'preview' | 'plan' | 'setup'; // current milestone
  showThread?: boolean;                          // default true; only the legacy wizard passes false
  maxWidth?: '2xl' | '6xl';                      // forms = '2xl' (default), plan picker = '6xl'
  children: React.ReactNode;
}
```

`showThread` defaults to `true`: `start`/`demo`/`pay`/`payment-success` exist only
in the demo flow and always show the thread; the `business` wizard passes
`showThread={demoFlowEnabled}` so the legacy (admin-created) flow shows only its
inner `ProgressDots`.

### 4.2 `FunnelStepThread.tsx`
Pure presentational thread of the four milestones. Maps `step` →
`done | current | todo`:
- `find`→1, `preview`→2, `plan`→3, `setup`→4. Steps before `current` render
  `done` (teal solid + check), `current` renders teal solid with focus ring,
  later steps render muted `#cdd9ce`.
- `aria-current="step"` on the current node; connectors teal when the prior step
  is done.
- `payment-success` and `business` both pass `step="setup"`; `payment-success`
  shows the thread only (no sub-dots), the wizard additionally shows its inner
  `ProgressDots`.

### 4.3 `field-styles.ts`
Exported `className` constants so every funnel field derives from **one owner**:
`fieldClass`, `labelClass`, `errorBannerClass`, `infoBannerClass`. Inputs use
`text-base` (16px) to eliminate the iOS focus-zoom (audit M2). Consumed by
`StartLocationClient` and the four wizard `Step*` components.

## 5. Per-page changes (wrap + reskin only)

| Page | Change |
|---|---|
| `start/page.tsx` → `StartLocationClient` | Replace `bg-gray-50` root with `<OnboardingFunnelShell step="find">`. h1 → brand scale; inputs → `fieldClass`; "Generate my demo" → teal `motion.button` (brand hover/tap); error → `errorBannerClass`; "Or paste a Google Maps URL" link → teal. |
| `business/page.tsx` → `BusinessWizardClient` + `Step*` | Wrap in `<OnboardingFunnelShell step="setup" showThread={demoFlowEnabled}>`. Reteal `ProgressDots`. Restyle the four `Step*` inputs/labels → `fieldClass`/`labelClass`; step CTAs → teal pill `motion.button`. Blue "You're in…" note → brand text (`#6a6a6a`). |
| `demo/page.tsx` → `PaywallWithDemoClient` | Wrap in `<OnboardingFunnelShell step="preview">`. Amber fallback banner (`:103`) → `infoBannerClass` (`#F0EEEA`); blue spinner → teal; "Choose a plan →" → teal `motion.button`; review cards branded (border `#97B3AE/10`); **stars teal `#97B3AE`** / empty `#cdd9ce`; AI-response box blue → `#F0EEEA` bg + teal uppercase label; `⚠️` emoji → inline SVG in a brand icon-circle; "Regenerate demo" → teal link. |
| `pay/page.tsx` → `PlanPickerClient` | Replace gray page wrapper with `<OnboardingFunnelShell step="plan" maxWidth="6xl">`; heading + 4-card grid live inside one white island (brand rule: no content directly on sage). Fix lone `text-amber-700` (`:60`) → `#6a6a6a`. Wrap plan CTAs in `motion.button`. Add per-card horizontal padding so cards don't hug the screen edge on mobile (audit M11). |
| `payment-success/page.tsx` → `PaymentSuccessClient` | Wrap in `<OnboardingFunnelShell step="setup">` (thread only, no sub-dots). Brand all three states; "Welcome to RepWorth!" gets a restrained teal check-circle + scale-in entry; teal "Go to dashboard" pill; teal spinner for processing/timeout. **All polling logic untouched.** |

### 5.1 `ProgressDots.tsx` reteal (colors only, API unchanged)
`bg-blue-600` → `bg-[#97B3AE]`; active ring `ring-blue-100` → `ring-[#97B3AE]/25`;
`bg-gray-200` → `bg-[#e3ddd3]`; text `text-gray-500/900` → `text-[#9a948a]/[#2a2a2a]`.
`LEGACY_STEPS` and `DEMO_STEPS` label sets unchanged.

## 6. Brand token mapping

| Use | Token |
|---|---|
| Page background | `#D2E0D3` |
| Island surface | `#ffffff` |
| Primary / CTA | `#97B3AE` (hover `#7e9b96`) |
| Tinted panel / AI box / ghost button | `#F0EEEA` |
| Heading text | `#2a2a2a` |
| Body text | `#6a6a6a` |
| Muted / todo / empty star | `#cdd9ce` / `#e3ddd3` |
| Filled review star | `#97B3AE` |

Errors keep a softened red (semantic, not decorative). No amber/orange/stone/yellow/blue.

## 7. Motion & accessibility
- `import { motion } from 'motion/react'` (project convention; never `framer-motion`).
- CTAs → `motion.button` with brand hover (`scale:1.05, y:-2, boxShadow …`) / tap
  (`scale:0.98`). Island entry animation; light section reveals where natural.
- `aria-current="step"` on the active milestone and active `ProgressDots` step.
- Preserve existing form labels; keep `aria-label` on rating stars.

## 8. Testing
- Run the three markup-asserting tests and update assertions that key off old
  gray/blue copy or classes: `start/__tests__/page.test.tsx`,
  `demo/__tests__/page.test.tsx`, `pay/__tests__/PlanPickerClient.test.tsx`.
- Logic tests stay green untouched: `business/__tests__/{guard,payload}.test.ts`,
  `pay/__tests__/plan-options.test.ts`.
- **New focused test** `_shared/__tests__/FunnelStepThread.test.tsx`: for each
  `step`, assert the correct milestone is `current`, earlier ones `done`, later
  ones `todo`, and `aria-current="step"` is on exactly one node. (This is the only
  new logic.)
- Completion gate: `pnpm lint && pnpm typecheck && pnpm test`.

## 9. Out of scope (follow-ups)
- `PlaceAutocomplete` internals — shared by dashboard add-location + admin (6 call
  sites). Left neutral; the funnel brands the label/CTA/text-inputs around it only.
- Behavioral fixes: silent post-payment redirect; payment-success timeout support
  link (audit P1 #20).
- Other audit items: mobile nav (M1), MFA (P0 #4), approval loop (P0 #2), auth
  forms, prospect `demo/[slug]` page (P0 #5).

## 10. Risks & mitigations
- **Test churn** from class/copy assertions → expected; handled in §8.
- **Plan-picker width inside the island** → `maxWidth="6xl"` prop prevents cramping
  4 cards.
- **Atmosphere markup duplication** vs `PageShell` → accepted and contained; the
  funnel variant is static (no scroll coupling), a genuinely different behavior, so
  not pure duplication. Not refactoring `PageShell` avoids regressing 4 live pages.

## 11. File manifest
**New:**
- `src/app/onboarding/_shared/OnboardingFunnelShell.tsx`
- `src/app/onboarding/_shared/FunnelStepThread.tsx`
- `src/app/onboarding/_shared/field-styles.ts`
- `src/app/onboarding/_shared/__tests__/FunnelStepThread.test.tsx`

**Modified:**
- `src/app/onboarding/start/StartLocationClient.tsx`
- `src/app/onboarding/business/BusinessWizardClient.tsx`
- `src/app/onboarding/business/ProgressDots.tsx`
- `src/app/onboarding/business/{StepLocation,StepProfile,StepVoice,StepConnect}.tsx`
- `src/app/onboarding/demo/PaywallWithDemoClient.tsx`
- `src/app/onboarding/pay/page.tsx`
- `src/app/onboarding/pay/PlanPickerClient.tsx`
- `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`
- Test updates: `start/__tests__/page.test.tsx`, `demo/__tests__/page.test.tsx`, `pay/__tests__/PlanPickerClient.test.tsx`
