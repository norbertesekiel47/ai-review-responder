# Public Folder Reorganization — Design

**Date:** 2026-05-04
**Branch:** `feat/pre-paywall-demo-pr2`
**Status:** Approved, ready for implementation plan
**Scope:** `src/app/(public)/` only (Scope A); Scope C (auth co-located clients) deferred

## Problem

`src/app/(public)/` ships a parallel `components/` subfolder that duplicates the canonical `src/components/` tree. Auth pages already follow the canonical convention (`from '@/components/auth/...'`), but every marketing page reaches into the route-local folder (`from '../components/shared/SiteNav'`). The split causes three concrete problems:

1. **Inconsistency** — half the public routes import from `@/components/...`, half from `../components/...`.
2. **Discoverability** — there is no single answer to "where do RepWorth components live?"
3. **No place for new sections** — the project has no `components/ui/` or `components/sections/` folders, so future marketing work has nowhere conventional to land.

This refactor is purely structural: move files, fix imports, change no logic.

## Goals

- Eliminate `src/app/(public)/components/`.
- Establish two new global homes: `src/components/ui/` (shared layout primitives) and `src/components/sections/<route>/` (page-specific marketing sections).
- All public-route imports for the moved files use the `@/components/...` alias.
- Type check, lint, and dev server pass with no errors after the move.

## Non-goals

- No changes to `src/components/auth/`, `admin/`, `dashboard/` — they already follow the convention.
- No changes to signup/login/forgot-password/reset-password/approve/demo/feedback routes (those are Scope C and beyond).
- No extraction of inline `const` arrays (`STEPS`, `FEATURES`, `PLANS`, `DEMO_BULLETS`, `TRUST_SIGNALS`) to `src/constants/`. No new `src/types/` entries.
- No splitting of `book-a-demo/page.tsx`, `pricing/page.tsx`, `privacy/page.tsx`, or `terms/page.tsx` — they keep their inline UI.
- No new code, no behavior changes, no test changes.

## Approach

### Target tree

```
src/components/
├── auth/                    (unchanged)
├── admin/                   (unchanged)
├── dashboard/               (unchanged)
├── ui/                      ← NEW
│   ├── PageShell.tsx
│   └── SiteNav.tsx
└── sections/                ← NEW
    ├── landing/
    │   ├── LandingContent.tsx
    │   ├── HowItWorksCarousel.tsx
    │   └── ContactForm.tsx
    ├── book-a-demo/
    │   └── BookDemoForm.tsx
    ├── features/
    │   └── FeaturesContent.tsx
    └── how-it-works/
        └── HowItWorksContent.tsx
```

After the move, `src/app/(public)/components/` is deleted entirely. `features/` and `how-it-works/` route folders contain only `page.tsx`.

### Why this layout

- `components/ui/` for `PageShell` + `SiteNav` because both are reused across every marketing page (landing, features, how-it-works, pricing, book-a-demo, privacy, terms). They are layout primitives, not section content.
- `components/sections/<route>/` mirrors the route tree, so "where is the Pricing hero?" maps trivially to `components/sections/pricing/...`. The convention generalizes when marketing content grows: every new section lands in the folder for its route.
- Group-by-route rather than flat: a flat `components/sections/` with eight files works today but does not scale — once any route gains a second section, the flat tree becomes ambiguous. Establishing the folder convention now avoids a second reorg.

### File moves (8 files)

| # | From | To |
|---|---|---|
| 1 | `src/app/(public)/components/landing/LandingContent.tsx` | `src/components/sections/landing/LandingContent.tsx` |
| 2 | `src/app/(public)/components/landing/HowItWorksCarousel.tsx` | `src/components/sections/landing/HowItWorksCarousel.tsx` |
| 3 | `src/app/(public)/components/landing/ContactForm.tsx` | `src/components/sections/landing/ContactForm.tsx` |
| 4 | `src/app/(public)/components/landing/BookDemoForm.tsx` | `src/components/sections/book-a-demo/BookDemoForm.tsx` |
| 5 | `src/app/(public)/components/shared/PageShell.tsx` | `src/components/ui/PageShell.tsx` |
| 6 | `src/app/(public)/components/shared/SiteNav.tsx` | `src/components/ui/SiteNav.tsx` |
| 7 | `src/app/(public)/features/FeaturesContent.tsx` | `src/components/sections/features/FeaturesContent.tsx` |
| 8 | `src/app/(public)/how-it-works/HowItWorksContent.tsx` | `src/components/sections/how-it-works/HowItWorksContent.tsx` |

### Import updates (15 lines, 8 files)

**Caller-side (route files inside `(public)`):**

`src/app/(public)/page.tsx`
- `from './components/landing/LandingContent'` → `from '@/components/sections/landing/LandingContent'`

`src/app/(public)/book-a-demo/page.tsx`
- `from '../components/shared/PageShell'` → `from '@/components/ui/PageShell'`
- `from '../components/shared/SiteNav'` → `from '@/components/ui/SiteNav'`
- `from '../components/landing/BookDemoForm'` → `from '@/components/sections/book-a-demo/BookDemoForm'`

`src/app/(public)/features/page.tsx`
- `from './FeaturesContent'` → `from '@/components/sections/features/FeaturesContent'`

`src/app/(public)/how-it-works/page.tsx`
- `from './HowItWorksContent'` → `from '@/components/sections/how-it-works/HowItWorksContent'`

`src/app/(public)/pricing/page.tsx`
- `from '../components/shared/PageShell'` → `from '@/components/ui/PageShell'`
- `from '../components/shared/SiteNav'` → `from '@/components/ui/SiteNav'`

`src/app/(public)/privacy/page.tsx` — same two as pricing.

`src/app/(public)/terms/page.tsx` — same two as pricing.

**Internal imports (inside moved files, after they land at the new path):**

`src/components/sections/landing/LandingContent.tsx`
- `from '../shared/SiteNav'` → `from '@/components/ui/SiteNav'`
- (`./HowItWorksCarousel` and `./ContactForm` stay relative — they move into the same folder.)

`src/components/sections/features/FeaturesContent.tsx`
- `from '../components/shared/PageShell'` → `from '@/components/ui/PageShell'`
- `from '../components/shared/SiteNav'` → `from '@/components/ui/SiteNav'`

`src/components/sections/how-it-works/HowItWorksContent.tsx`
- Same two as `FeaturesContent`.

`HowItWorksCarousel.tsx`, `ContactForm.tsx`, `BookDemoForm.tsx`, `PageShell.tsx`, `SiteNav.tsx` have no project-local imports and need no internal edits.

## Blast radius

A grep for every component name (`LandingContent`, `HowItWorksCarousel`, `ContactForm`, `BookDemoForm`, `PageShell`, `SiteNav`, `FeaturesContent`, `HowItWorksContent`) returned 15 hits — all 15 are inside `src/app/(public)/` or the source files themselves. No tests reference these components. No other route group imports them. The diff is contained.

## Verification

After the move, all four checks must pass:

1. `pnpm tsc --noEmit` — every broken import surfaces as a TS error. Must be zero errors.
2. `pnpm lint` — catches unused-import dust left over from edits.
3. `pnpm dev` — start the dev server and load each affected route in a browser:
   - `/` (landing)
   - `/features`
   - `/how-it-works`
   - `/pricing`
   - `/book-a-demo`
   - `/privacy`
   - `/terms`
   Each must render with no console errors.
4. `src/app/(public)/components/` directory no longer exists on disk.

## Risks

- **Path-alias misconfig** — if `tsconfig.json` `paths` does not resolve `@/components/...`, every new import breaks. Mitigation: `pnpm tsc --noEmit` catches this immediately.
- **Case-insensitive Windows filesystem** — `book-a-demo` (kebab) is fine, but creating a folder named differently from the route would not error locally and would fail in Vercel's Linux build. Mitigation: explicit folder names in the move list mirror the route segment exactly.
- **Other route groups silently importing** — already ruled out by the grep above.

## Out of scope (Scope C, deferred)

A follow-up will move the four co-located auth/approval clients into the canonical tree:

- `src/app/(public)/signup/SignupFormClient.tsx` → `src/components/auth/SignupFormClient.tsx`
- `src/app/(public)/signup/check-email/CheckEmailClient.tsx` → `src/components/auth/CheckEmailClient.tsx`
- `src/app/(public)/signup/finish/FinishSignupClient.tsx` → `src/components/auth/FinishSignupClient.tsx`
- `src/app/(public)/approve/[token]/approval-client.tsx` → TBD (likely `src/components/approval/approval-client.tsx` since it's not strictly auth).

That work is tracked separately and depends on this spec landing first.
