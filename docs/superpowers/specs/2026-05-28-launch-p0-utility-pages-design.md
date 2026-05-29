# Design — Brand `help/contact` + `feedback/thanks` (Launch-Ready P0 #6)

> **Date:** 2026-05-28
> **Source:** `docs/launch-ready-part2.md` → Prioritized fix list → P0 #6 (line 139)
> **Branch:** `fix/launch-p0-utility-pages` (worktree `/private/tmp/repworth-utility-pages`, branched from `origin/main`)
> **Brand reference:** `~/.claude/skills/repworth-brand-design/SKILL.md`

## Problem

Two public utility pages ship as unbranded gray prototypes and strand the user:

- `src/app/(public)/help/contact/page.tsx` — plain `max-w-3xl` prose on white, gray text, **emails as plain text** (not clickable), no island, no brand. Reached almost entirely from the **authenticated owner app** (past-due modal, subscription banner, connect page, security settings) + admin CSV import — i.e. owners in a support moment.
- `src/app/(public)/feedback/thanks/page.tsx` — `bg-gray-50` centered card, a one-line "Thank you!", **no way out** (dead-end). It is the 303 redirect target of `POST /api/feedback`, reached after an owner clicks a rating in their **weekly satisfaction email** (HMAC-signed link).

Both audiences are RepWorth **customers/owners**, not anonymous prospects.

## Scope

**In scope** (confirmed with user):
1. Apply the brand **island layout** to both pages (`PageShell` + brand tokens + motion).
2. Make the three support emails **clickable `mailto:` links**.
3. Add a **CTA out of the dead-end** on both pages → home (`/`).
4. Add a **per-page `metadata` export** (title/description) to both `page.tsx` files.

**Out of scope** (separate tickets):
- Domain `.com`/`.net` standardization (audit P2) — emails stay `.net`.
- `SiteNav` mobile hamburger (M1 / P1 #13).
- `PageShell` dot-nav `type="button"` (P1 #18) — neither page nests the dot-nav in a `<form>`, so the submit bug does not bite here; left untouched to keep blast radius tight.
- `overflow:hidden` island fix (P0 #7) — already absent from `PageShell`.

## Locked decisions

| Decision | Choice |
|---|---|
| Contact layout | **Channel cards** — three labeled support cards, each a tappable `mailto:` pill |
| feedback/thanks header | **Minimal centered** — teal-dot + REPWORTH wordmark only (no nav links) |
| CTA target (both) | **Home `/`** ("Back to RepWorth →") |
| `feedback/thanks` indexing | **`robots: noindex`** (thin post-action confirmation, no SEO value) |
| `help/contact` indexing | **Indexable** (useful public support info) |

## Architecture & files

Each page splits into a **server `page.tsx`** (owns `metadata` + env) and a co-located **`'use client'` content component** — mirroring `src/app/(public)/book-a-demo/{page.tsx,BookADemoContent.tsx}`. The island requires `motion`/`useScroll` (client-only), while per-page `metadata` requires a server component, so the split is forced and follows the established pattern.

| File | Change |
|---|---|
| `src/components/ui/PageShell.tsx` | **Edit** — add optional `maxWidthClassName?: string` prop (default `'max-w-5xl'`); apply it to the island `motion.div` className |
| `src/app/(public)/help/contact/page.tsx` | **Rewrite** — server component: export `metadata`, read `SELF_SERVE_SIGNUP_ENABLED`, render `<ContactContent selfServeEnabled={…} />` |
| `src/app/(public)/help/contact/ContactContent.tsx` | **New** — `'use client'` branded page |
| `src/app/(public)/feedback/thanks/page.tsx` | **Rewrite** — server component: export `metadata` (incl. `robots` noindex), render `<FeedbackThanksContent />` |
| `src/app/(public)/feedback/thanks/FeedbackThanksContent.tsx` | **New** — `'use client'` branded page |
| `src/app/(public)/help/contact/__tests__/ContactContent.test.tsx` | **New** |
| `src/app/(public)/feedback/thanks/__tests__/FeedbackThanksContent.test.tsx` | **New** |

### `PageShell` enhancement

Add `maxWidthClassName?: string` (default `'max-w-5xl'`). Justified by a concrete second caller (the narrow `feedback/thanks` pane needs `max-w-md`), not speculation — it lets the thanks page reuse the island/parallax/entry-motion instead of duplicating them. Existing callers (`BookADemoContent`, etc.) are unaffected by the default.

```tsx
interface PageShellProps {
  sections: PageSection[];
  children: React.ReactNode;
  /** Tailwind max-width class for the island. Defaults to a full-width 'max-w-5xl'. */
  maxWidthClassName?: string;
}
// island className: `w-full ${maxWidthClassName} bg-white rounded-[3rem] shadow-2xl`
```

## Page spec — `help/contact` (Channel cards)

- **Shell:** `PageShell` with `sections={[]}` (short page → no dot-nav clutter; full-width island via default `max-w-5xl`) + `<SiteNav selfServeEnabled={…} />` as first child.
- **Header block:** eyebrow `Support` → h1 `How can we help?` (brand h1 scale) → intro `Pick the channel that fits — we answer fastest by email.`
- **Three channel cards** (responsive grid: 3-col desktop, 1-col mobile). Each card follows the brand Feature/Info-Card pattern: a rotating **token** icon circle (`#97B3AE` → `#F2C3B9` → `#D6CBBF`) holding an **inline white SVG** (envelope / credit-card / shield), an h3 title, a one-line purpose, and a real `mailto:` pill (`motion.a` with brand hover/tap):

  | Card | Title | Purpose | `mailto:` |
  |---|---|---|---|
  | 1 | Account help | Connecting Google, locations, and day-to-day questions | `support@repworth.net` |
  | 2 | Billing | Invoices, plan changes, and past-due recovery | `billing@repworth.net` |
  | 3 | Security | Report a vulnerability or security incident | `security@repworth.net` |

- **Two tinted panels** (side-by-side desktop, stacked mobile), copy preserved verbatim from the current page:
  - **Response targets** — Basic and Founders: 24 business hours · Standard: 8 business hours · Premium: 2 business hours.
  - **Common help topics** — Connecting your Google Business Profile · Billing and past-due recovery · Importing locations by CSV.
- **CTA footer:** teal gradient section `rounded-b-[3rem]` (`from-[#97B3AE] to-[#97B3AE]/80 text-white`) with a white "Back to RepWorth →" pill linking `/` (Next `Link`, motion hover/tap).

## Page spec — `feedback/thanks` (minimal header)

- **Shell:** `PageShell sections={[]} maxWidthClassName="max-w-md"` (narrow centered pane).
- **Header:** inline minimal brand header — teal-dot (`bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80`) + `RepWorth` wordmark (`text-sm tracking-wider uppercase text-[#97B3AE]`), centered. Inlined (~6 lines); single caller, so not extracted into a shared component.
- **Body** (centered): teal check circle (inline SVG check `M5 13l4 4L19 7`, wrapper `aria-hidden`) → h1 `Thank you` → body `Your feedback has been recorded. It goes straight to the team that builds RepWorth.` → teal "Back to RepWorth →" pill linking `/`.
- **Motion:** brand section-entry fade/slide on the inner content.

## Metadata

- `help/contact`: `{ title: 'Contact support · RepWorth', description: 'Email RepWorth support, billing, or security — plus response-time targets by plan.' }` (indexable).
- `feedback/thanks`: `{ title: 'Thank you · RepWorth', description: 'Your feedback has been recorded.', robots: { index: false, follow: false } }`.

## Accessibility

- Exactly one `<h1>` per page; card titles are `<h3>`.
- Decorative icon circles and the success check carry `aria-hidden="true"`.
- `mailto:` links use the email address as visible link text (self-describing).
- Brand text tokens (`#2a2a2a` heading, `#6a6a6a` body) meet WCAG AA on white.
- All interactive elements are real `<a>`/`Link` with discernible text.

## Motion (brand conventions)

- Island entry + parallax: provided by `PageShell`.
- Inner content: brand section-entry / scroll-reveal (`initial/animate` or `whileInView`), card stagger via index delay.
- Pills/links: `motion.a` / motion-wrapped `Link` with primary-button hover (`scale: 1.05, y: -2`) and `whileTap: { scale: 0.98 }`.
- Import from `motion/react` (never `framer-motion`).

## Testing (TDD)

Mirror `src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx`: render with `renderToStaticMarkup`, mock `@/components/ui/PageShell` to a passthrough `<div>`. Write tests **before** the components.

**`ContactContent.test.tsx`:**
- renders the three `mailto:` hrefs (`mailto:support@repworth.net`, `mailto:billing@repworth.net`, `mailto:security@repworth.net`);
- renders the SLA copy (e.g. `24 business hours`, `Premium`) and help-topic copy (e.g. `Importing locations by CSV`);
- renders a "Back to RepWorth" CTA whose `href="/"`;
- renders the RepWorth wordmark (SiteNav present);
- asserts **no** banned palette token leaks into output (`amber`, `yellow`, `bg-blue-`).

**`FeedbackThanksContent.test.tsx`:**
- renders `Thank you`;
- renders a CTA whose `href="/"`;
- renders the RepWorth wordmark.

**Optional metadata assertions:** import `metadata` from each server `page.tsx` and assert `title` / `robots` where applicable.

## Verification

Run in the worktree (out-of-repo → no module-resolution leak):

```bash
pnpm lint && pnpm typecheck && pnpm test
```

No DB/schema changes → tenant-scope and RLS audits are not required.

## Workflow

Implement in the `fix/launch-p0-utility-pages` worktree (TDD). `main` is protected — land via PR with the four CI checks green.
