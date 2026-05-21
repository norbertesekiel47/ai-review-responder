# Landing Page Design Spec

**Date:** 2026-04-13
**Purpose:** Demo-ready landing page for showing Sprint 1-4 features to the team.

---

## Layout

Product Marketing Page — single-page, no new routes. Replaces the placeholder `<div>Landing Page</div>` at `src/app/(public)/page.tsx`.

## Visual Tone

Warm & Friendly — approachable for SMB restaurant/salon owners.

- **Background:** Alternating cream (`bg-amber-50`) and white sections
- **Accent color:** Amber (`amber-600` for CTAs, `amber-100` for circles/badges)
- **Text:** Warm grays (`stone-900` headings, `stone-600` body, `stone-400` footer)
- **Cards:** White with `border-stone-200`, rounded-lg
- **No new dependencies** — Tailwind only (already installed)

## Sections

### 1. Nav Bar
- White background, `border-b border-stone-200`
- Left: "RepWorth" text logo (`text-xl font-bold text-stone-900`)
- Right: "Admin Login" button → links to `/admin/login`
- Not sticky (simple page, no need)

### 2. Hero
- Cream background (`bg-amber-50`)
- Headline: "Every review answered." + "Zero effort." in `text-amber-600`
- Subtext: one paragraph explaining the product (monitor → AI draft → one-tap approve → posted)
- Two CTAs:
  - "Get Started" — amber solid button → `/admin/login`
  - "See How It Works" — outline button → `#how-it-works` anchor scroll

### 3. How It Works
- White background
- ID: `how-it-works` (anchor target)
- Section title: "How It Works"
- Subtitle: "A continuous loop that runs in the background for each business."
- 4-step horizontal grid (`sm:grid-cols-2 lg:grid-cols-4`):
  1. **Monitor** — "We poll your Google reviews every 60 minutes automatically."
  2. **Generate** — "AI drafts a personalized response that sounds like you wrote it."
  3. **Approve** — "You get an email. Tap approve, edit, or regenerate. 30 seconds."
  4. **Post** — "The approved response is posted to Google on your behalf."
- Each step: amber number circle + title + description

### 4. Features
- Cream background (`bg-amber-50`)
- Section title: "Built for Small Businesses"
- 6 cards in grid (`sm:grid-cols-2 lg:grid-cols-3`):
  1. Multilingual — auto-detects language, responds in kind
  2. Owner Approval Required — nothing posted without explicit approval
  3. Under 1 Hour — new review to draft in inbox
  4. Specific, Not Generic — references exact dishes/services/staff mentioned
  5. Weekly Summaries — Monday morning stats email
  6. 10x Cheaper Than Enterprise — $99 vs Birdeye's $300-450

### 5. Pricing
- White background
- Section title: "Simple Pricing"
- Subtitle: "No setup fees. No contracts. Cancel anytime."
- 2 cards side by side (`sm:grid-cols-2`):
  - **Founding Member** ($99/mo) — highlighted with amber ring + "Limited" badge. Features: Google review monitoring, AI-drafted responses, one-tap email approval, multilingual support, weekly summary emails.
  - **Standard** ($149/mo) — default border. Features: Everything in Founding, priority support, custom voice training, ROI dashboard.
- Amber checkmarks on feature lists

### 6. Footer
- White background, `border-t border-stone-100`
- Left: "RepWorth · AI Review Responder"
- Right: "Admin" link → `/admin/login`

## Navigation Flow

```
Landing Page (/)
├── Nav: "Admin Login" → /admin/login
├── Hero: "Get Started" → /admin/login
├── Hero: "See How It Works" → #how-it-works (smooth scroll)
└── Footer: "Admin" → /admin/login
```

After login at `/admin/login`:
```
/admin/login (authenticated)
└── Success → /admin/overview
    ├── Business table rows → /admin/businesses/[id]
    ├── "Add Business" → /admin/businesses/new
    ├── Sidebar/nav → /admin/costs, /admin/notifications, /admin/jobs, /admin/demos
    └── /admin/demos → generates demo → /demo/[slug] (public viewer)
```

## Files Changed

| File | Action |
|------|--------|
| `src/app/(public)/page.tsx` | **REWRITE** — replace placeholder with full landing page |
| `docs/currents.MD` | **MODIFY** — add Page Workflow section documenting navigation links |

## Out of Scope

- No Calendly / "Book a Call" links
- No live demo links from landing page (requires auth)
- No animations or JS beyond smooth scroll
- No new npm dependencies
- No changes to any other pages or API routes
