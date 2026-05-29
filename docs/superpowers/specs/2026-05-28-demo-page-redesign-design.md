# Prospect Demo Page Redesign — Design Spec

> **Date:** 2026-05-28
> **Audit item:** `docs/launch-ready-part2.md` → Prioritized fix list → P0 #5
> **Branch:** `fix/launch-p0-demo-page`
> **Brand reference:** `~/.claude/skills/repworth-brand-design/SKILL.md`

## Problem

`src/app/(public)/demo/[slug]/page.tsx` is the lead-gen asset sales sends to
prospects: it renders a business's real reviews with RepWorth-drafted replies.
It is currently an unbranded gray/blue prototype and is one of the highest-stakes
external touchpoints. Specific defects from the audit:

- `bg-gray-50` page, `bg-blue-600` CTA, `bg-purple-*` multilingual badge,
  `text-green-600` stat, `text-yellow-400` stars — none on-brand.
- No island, no sage background, no motion.
- Loading state uses an in-body `<meta http-equiv="refresh" content="5">` —
  invalid placement and a jarring full-page reload.
- Failed state is a bare `"!"` character with no recovery path.
- CTA is a `mailto:` link instead of pointing at `/book-a-demo`.
- Missing/expired demos call `notFound()`, which falls through to the default,
  unbranded Next.js 404 (no `not-found.tsx` exists in the `(public)` segment).

## Goals

Bring all demo-page states onto the RepWorth island brand system without
changing any data behavior (query, view-count increment, expiry check, state
branching). Specifically:

1. **Completed** state on the island, single-column feed (review → reply pairs),
   teal CTA → `/book-a-demo`.
2. **Loading** state on the island with a teal spinner and a client-side
   `router.refresh()` poller replacing the `<meta refresh>`.
3. **Failed** state on the island with a real error presentation and a recovery
   CTA.
4. **Expired / not-found** state: a new branded `not-found.tsx`.
5. `robots: { index: false, follow: false }` on the route — it is per-prospect
   tokenized content exposing a business's reviews and must not be crawled.

## Non-goals

- No change to the demo data model, `prospect_demos` query, view-count logic,
  or expiry semantics.
- No new public API endpoint (the loading poller reuses the server query via
  `router.refresh()`).
- No mobile-nav (`SiteNav` hamburger) work — that is audit item M1/P1, tracked
  separately. `SiteNav` is reused as-is.
- No SerpAPI/generation/worker changes — this is a presentational redesign.

## Layout direction

**Option A — single-column feed** (selected over a two-column "report" layout and
a sectioned dot-nav layout). It matches the proven `BookADemoContent` pattern,
scales to any review count, and keeps the prospect's eye on the proof.

## Architecture

The page stays a server component for data + branching; presentation moves into
client components (the island/`PageShell` requires `'use client'`), mirroring the
established `page.tsx → XContent.tsx` split used by every other public page.

### `page.tsx` (server, keeps `export const dynamic = 'force-dynamic'`)

Orchestration only — no presentation:

- `export const metadata = { robots: { index: false, follow: false } }` (new).
- Read `selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true'`.
- `getDemo(slug)` query — **unchanged**.
- `if (!demo || demo.expires_at < new Date()) notFound()` — **unchanged**
  (now renders the new `not-found.tsx`).
- `view_count` increment for completed demos only, with the existing `.catch`
  error log — **unchanged**.
- JSONB `typeof x === 'string' ? JSON.parse(x) : x` guard for
  `reviews_snapshot` / `generated_responses` — **unchanged**.
- Branch:
  - `queued` | `running` → `<DemoStatusIsland variant="loading" …>`
  - `failed` → `<DemoStatusIsland variant="error" …>`
  - completed → `<DemoViewerContent …>`
- Pass `selfServeEnabled` into each so `SiteNav` renders correctly.

### Files

| File | Status | Responsibility |
|---|---|---|
| `demo/[slug]/page.tsx` | modified | Server: query, expiry, view-count, branch, metadata |
| `demo/[slug]/DemoViewerContent.tsx` | new (`'use client'`) | Completed island: `PageShell` + `SiteNav` + hero + review/reply feed + teal CTA footer. Houses `ReviewCard` + `Stars` (moved here, recolored). |
| `demo/[slug]/DemoStatusIsland.tsx` | new (`'use client'`) | Shared centered island for `loading` / `error` / `expired` via a `variant` prop. The `loading` variant runs the `router.refresh()` poller. |
| `demo/[slug]/not-found.tsx` | new (server) | Reads `selfServeEnabled`, renders `<DemoStatusIsland variant="expired" …>`. |

One shared `DemoStatusIsland` (three callers) is preferred over three near-identical
state components — it is a single deep module: callers pass a `variant` and copy,
the island owns layout, spinner/icon, motion, and the poller.

### `DemoStatusIsland` contract

```ts
type DemoStatusVariant = 'loading' | 'error' | 'expired';

interface DemoStatusIslandProps {
  variant: DemoStatusVariant;
  businessName?: string;       // shown for loading/error; omitted for expired (unknown)
  selfServeEnabled: boolean;   // forwarded to SiteNav
}
```

- Wraps `PageShell` (no `sections` → dot-nav hidden) + `SiteNav`.
- Centered content block inside the island, `role="status"` for async feedback
  (accessibility: the audit flags missing `aria-live`/`role="status"`).
- `loading`: teal spinner (`border-[#97B3AE]/20 border-t-[#97B3AE]`), business
  name, "Your demo is being generated…", "This usually takes about 30–60
  seconds." A `useEffect` sets an interval that calls `router.refresh()` every
  5000ms; cleared on unmount. The interval only runs for `variant === 'loading'`.
- `error`: sage icon circle with an inline SVG (alert glyph), "We couldn't
  generate this demo", "Something went wrong creating the demo for
  {businessName}. We'd still love to show you RepWorth.", teal "Book a demo" pill
  → `/book-a-demo`, secondary "Back to RepWorth" link → `/`.
- `expired`: sage icon circle (inline SVG), "This demo link has expired",
  "Demo links are only active for a short time. Request a fresh look at RepWorth
  for your business.", same CTA + home link.

### `DemoViewerContent` (completed)

- `'use client'`, wraps `PageShell` + `SiteNav`.
- **Hero band** (`bg-gradient-to-b from-white to-[#F0EEEA]/30`): eyebrow
  "RepWorth demo" (`text-[#97B3AE]` uppercase), business name
  `text-4xl md:text-5xl font-medium text-[#2a2a2a]`, and stat chips.
- **Stat chips** (`#6a6a6a` text, `#F0EEEA` bg, `border-[#97B3AE]/25`):
  - "{reviews.length} reviews"
  - "{successCount} replies drafted" (`successCount` = non-null responses, the
    existing computed value)
  - "{N} languages handled" where `N` = the count of distinct language codes
    across `review.detectedLanguage` and `response.language`; **rendered only
    when `N > 1`** (i.e. at least one non-English language is present —
    truthful, no invented chip).
- **Feed**: vertical list of `ReviewCard`s, each scroll-revealed
  (`whileInView`, staggered by index).
- **CTA footer** (`bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white
  rounded-b-[3rem]`): "Want replies like these for your reviews?" +
  "RepWorth drafts every reply — you approve before it posts." (honors the
  no-auto-post invariant) + white "Book a demo" pill → `Link href="/book-a-demo"`
  wrapped in `motion`.

### `ReviewCard` + `Stars` (recolored, moved into `DemoViewerContent`)

- Card: `border-[#97B3AE]/10`, reply block `bg-[#F0EEEA]` +
  `border-[#97B3AE]/20`.
- Reply label: teal eyebrow **"RepWorth reply"** (was blue "AI Response").
- Multilingual badge: `bg-[#97B3AE]/15 text-[#97B3AE]` pill (was purple).
- `Stars`: filled `#97B3AE`, empty `text-[#2a2a2a]/15`; keeps the existing
  `aria-label={"${rating} out of 5 stars"}`.
- "Rating only — no written review" empty text stays, recolored to `#6a6a6a`/italic.

## Brand recolor map

| Element | Now | Becomes |
|---|---|---|
| Page background | `bg-gray-50` | sage `#D2E0D3` via `PageShell` island |
| Eyebrow | `text-blue-600` | `text-[#97B3AE]` uppercase tracking |
| Stat counts | `text-green-600` | neutral `#6a6a6a` chips |
| Review card border | `border-gray-200` | `border-[#97B3AE]/10` |
| Reply block | `bg-blue-50 border-blue-100` | `bg-[#F0EEEA] border-[#97B3AE]/20` |
| Reply label | `text-blue-600` "AI Response" | `text-[#97B3AE]` "RepWorth reply" |
| Multilingual badge | `bg-purple-100 text-purple-700` | `bg-[#97B3AE]/15 text-[#97B3AE]` |
| Stars | `text-yellow-400` / `text-gray-300` | `#97B3AE` / `text-[#2a2a2a]/15` |
| CTA | `bg-blue-600` → `mailto:` | teal-gradient footer + white pill → `/book-a-demo` |
| Loading | `<meta refresh>` + blue spinner | teal spinner + `router.refresh()` poller |
| Error | bare `"!"` | sage icon circle + heading + recovery CTA |

## Motion (per brand skill)

- Island mount handled by `PageShell` (`opacity/y/scale`, 0.8s).
- Hero elements: `initial={{opacity:0,y:20}} animate={{opacity:1,y:0}}` with
  delay stagger.
- Review cards: scroll reveal (`whileInView`, `viewport={{once:true}}`, stagger
  via index).
- CTA button: primary hover/tap variant (`scale:1.05,y:-2` / `scale:0.98`).
- All `motion` imported from `motion/react` (never `framer-motion`).

## Accessibility

- `role="status"` on loading/error/expired centered blocks (async feedback).
- `Stars` keeps its `aria-label`.
- CTA is a real `Link`/anchor with discernible text; "Back to RepWorth" is a
  labeled link.
- Inline SVGs only (no icon libraries); decorative SVGs `aria-hidden`.

## Anti-slop checks

- No invented metrics: stat chips derive from actual `reviews.length` /
  non-null response count / detected languages. The "languages" chip is omitted
  when everything is English.
- No fake testimonials/avatars/logos.
- Copy avoids hype; "RepWorth reply" and the no-auto-post line are truthful to
  the product.
- Only RepWorth tokens; teal accent used sparingly.

## Edge cases

- **0 reviews / 0 responses in a completed demo**: feed renders empty; hero still
  shows "0 replies drafted" and the CTA. (Should be rare — generation produces
  responses — but renders gracefully.)
- **Response present but review text empty**: existing "Rating only" branch
  preserved.
- **`businessName` on expired**: unknown (no row), so the expired copy is
  business-agnostic.
- **Poller after completion**: once status flips to completed, the server
  re-render returns `DemoViewerContent` and the loading island (with its
  interval) unmounts — the interval is cleared in the `useEffect` cleanup.

## Testing & verification

Focused component tests (Vitest + Testing Library, matching existing client
component tests):

- `DemoStatusIsland` loading variant calls `router.refresh()` on the interval
  (fake timers) and clears it on unmount.
- `error` and `expired` variants render a recovery CTA with
  `href="/book-a-demo"` and a home link.
- `DemoViewerContent`: renders one card per review, omits the "languages" chip
  when all reviews are English, shows it when a non-English review/response is
  present, and the CTA links to `/book-a-demo` (not `mailto:`).

Then: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus a manual
visual pass of all four states (companion mockups in `.superpowers/brainstorm/`).

## Out of scope / follow-ups (other audit items)

- `SiteNav` mobile hamburger (M1/P1).
- iOS input-zoom and other funnel pages (separate P0 items #1–#4).
- These are intentionally not bundled here to keep the PR scoped to item #5.
