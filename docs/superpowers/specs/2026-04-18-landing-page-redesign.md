# Landing Page Redesign — Design Spec
**Date:** 2026-04-18  
**Branch:** `feat/landing-page-redesign`  
**Status:** Approved, ready for implementation

---

## Overview

Replace RepWorth's current amber/stone landing page with the Figma-designed "island" layout. Adopts the Figma's full sage green palette, Framer Motion animations, and sales-led CTA flow (inline contact form → API route). Removes the inline Pricing section; Pricing moves to a separate `/pricing` page linked from the navbar.

---

## Files Changed / Added

```
src/app/(public)/
  page.tsx                             ← rewritten (layout shell + static sections)
  components/landing/
    HowItWorksCarousel.tsx             ← new ('use client', AnimatePresence slider)
    ContactForm.tsx                    ← new ('use client', controlled form)
src/app/api/contact/
  route.ts                             ← new (POST handler — validates + sends via Resend or logs)
```

**Dependency added:** `motion` (Framer Motion v11+)  
**No files deleted.** Existing approval, demo, and feedback routes are untouched. `(public)/layout.tsx` stays as-is.

---

## Color Palette

| Role | Value | Usage |
|---|---|---|
| Page background | `#D2E0D3` | Behind the island |
| Primary | `#97B3AE` | Buttons, nav hover, CTA bg |
| Accent | `#F2C3B9` | Feature card icons, step card tints |
| Muted | `#D6CBBF` | Secondary accents |
| Foreground | `#2a2a2a` | Headings |
| Body text | `#6a6a6a` | Paragraphs, subtitles |
| Island bg | `#ffffff` | The main card container |

All amber/stone Tailwind tokens are removed from `page.tsx`.

---

## Page Structure

### Persistent elements (outside island)
- **Parallax background**: 4 `position: fixed` glassmorphism card silhouettes (`bg-white/40 backdrop-blur-md rounded-3xl`). Each moves at a different scroll rate via `useScroll` + `useTransform` (y offsets –200px to –500px).
- **Right-side dot nav** (desktop only): 5 dots, `position: fixed`, each scrolls to a section ref on click. Styled as `rounded-full` pills, teal on hover.

### Island container
`max-w-5xl`, `rounded-[3rem]`, `bg-white`, `shadow-2xl`. Entry animation: `opacity 0→1`, `scale 0.95→1`, 0.8s ease-out on mount.

#### 1. Navbar
- Left: text links — "Features", "How it works", "Platforms", "Pricing" (`/pricing` — separate page, not built in this sprint)
- Right: teal circle + "REPWORTH" uppercase wordmark
- `border-b border-[#97B3AE]/10`

#### 2. Hero
- Eyebrow: "REPWORTH" (small caps, teal)
- H1: "Every review gets the reply it deserves" (5xl–7xl responsive)
- Subtitle: "Automated responses that sound authentically human, crafted in your brand voice."
- CTA: "Book a Demo" pill button (`bg-[#97B3AE]`, `rounded-full`), scrolls to CTA/contact form section
- Staggered fade-up animations (0.2s delay per element)

#### 3. Features (`ref={featuresRef}`)
- H2: "Save 15 hours every week"
- Body: "RepWorth learns your brand voice and responds to reviews instantly. No templates, no generic messages — just thoughtful replies that build customer loyalty."
- 3 cards in a `md:grid-cols-3` grid:
  | Card | Icon colour | Title | Subtitle |
  |---|---|---|---|
  | 1 | `#97B3AE` (teal) | Your voice, automated | Trained on your best responses |
  | 2 | `#F2C3B9` (blush) | Instant responses | Reply within minutes, not days |
  | 3 | `#D6CBBF` (beige) | Always on brand | Consistent tone across all platforms |
- `whileInView` fade-up with stagger; `whileHover` lifts `y: -5` + shadow

#### 4. How It Works (`ref={howItWorksRef}`)
- H2: "How it works"
- Subtitle: "Use arrows to explore"
- `<HowItWorksCarousel>` (client component) — **4 RepWorth steps** (not Figma's 5):
  | Step | Title | Description | Card colour |
  |---|---|---|---|
  | 01 | Monitor | We poll your Google reviews every 60 minutes automatically. | `#D2E0D3` |
  | 02 | Generate | AI drafts a personalised response that sounds like you wrote it. | `#F0DDD6` |
  | 03 | Approve | You get an email. Tap approve, edit, or regenerate. 30 seconds. | `#F2C3B9` |
  | 04 | Post | The approved response is posted to Google on your behalf. | `#D6CBBF` |
- Left/right arrow buttons with `AnimatePresence` 3D card flip (`rotateY: 90°→0°→-90°`)
- Dot step indicators below card; clickable

#### 5. Platforms (`ref={platformsRef}`)
- H2: "Works where your customers review you"
- Body: "Connect your Google account. One dashboard, all your reviews."
- Subtle note: "More platforms coming soon" (italic, teal, small)
- Google wordmark only (not Yelp/Trustpilot/Facebook — MVP scope)
- Dashboard mockup collage:
  - Stats: Total Reviews 1,234 | Replied 1,180 | Avg Response 8 min
  - 3 placeholder review rows with reply previews
  - Floating accent cards: "Response Rate 96%" (blush tint), "This Week +127" (teal tint), `rotate: ±5deg` on scroll entry

#### 6. CTA + Contact Form (`ref={ctaRef}`)
- Background: `bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80`, `rounded-b-[3rem]`
- H2: "Start responding smarter today"
- `<ContactForm>` (client component, see below)

---

## ContactForm Component

**File:** `src/app/(public)/components/landing/ContactForm.tsx`  
**Directive:** `'use client'`

### Fields
| Field | Type | Validation |
|---|---|---|
| Name | text input | Required, non-empty |
| Email | email input | Required, valid email format |
| Business Name | text input | Required, non-empty |

### States
- **Idle**: form displayed
- **Loading**: submit button shows spinner, inputs disabled
- **Success**: form replaced with "We'll be in touch within 24 hours" confirmation
- **Error**: inline error message below form, inputs re-enabled

### Styling
- `rounded-2xl bg-white/10 p-8` on dark CTA background
- Input fields: `rounded-lg bg-white/20 border border-white/30 text-white placeholder-white/60`
- Submit button: `bg-white text-[#97B3AE] rounded-full`

### Behaviour
- On submit: `POST /api/contact` with `{ name, email, businessName }`
- Reads JSON response; `ok` → success state; error → error state with message

---

## Contact API Route

**File:** `src/app/api/contact/route.ts`

### POST handler
1. Parse JSON body; validate `name`, `email`, `businessName` all present and non-empty; validate email with regex
2. Return `400` + error message on validation failure
3. Log submission: `console.log('[contact]', { name, email, businessName, timestamp })`
4. If `RESEND_API_KEY` is set: send notification email to `norbertesekiel@gmail.com` using existing `resend` client with subject "New Demo Request — RepWorth" and plain-text body listing the three fields + timestamp
5. Return `200 { success: true }` on success; `500` if Resend throws

No database writes. No new env vars required beyond the existing `RESEND_API_KEY`.

---

## HowItWorksCarousel Component

**File:** `src/app/(public)/components/landing/HowItWorksCarousel.tsx`  
**Directive:** `'use client'`

- `useState` for `currentStep: number` and `direction: number`
- `AnimatePresence mode="wait"` wraps the active card
- Card enter/exit: `rotateY: ±90° → 0° → ∓90°`, `opacity: 0→1→0`, `x: ±100→0→∓100`, 0.5s ease-in-out
- `style={{ perspective: "1200px", transformStyle: "preserve-3d" }}` on container
- Prev/next arrow buttons disabled at boundaries (`opacity-30 cursor-not-allowed`)
- Dot indicators: active dot is `w-8 bg-[#97B3AE]`; inactive is `w-2 bg-[#97B3AE]/30`
- Receives `steps` array as prop (defined in `page.tsx`)

---

## Animations Summary

| Element | Trigger | Animation |
|---|---|---|
| Island container | Mount | `opacity 0→1`, `scale 0.95→1`, 0.8s |
| Parallax bg cards | Scroll | `y` transform –200 to –500px per card |
| Hero (eyebrow, h1, subtitle, button) | Mount | Staggered fade-up, 0.2s delay each |
| Feature cards | In viewport | Fade-up with stagger, `whileHover y: -5` |
| How It Works card | Prev/next click | 3D flip via `AnimatePresence` |
| Platforms mockup | In viewport | Fade-up; floating cards `rotate: ±5deg` |
| CTA section | In viewport | Fade-up stagger |

Not animated: navbar, form input fields.

---

## Constraints & Invariants

- **No admin routes changed.** `/admin/login` still exists; the landing page no longer links to it directly (sales-led flow instead).
- **No Pricing page built** in this sprint — navbar link to `/pricing` will 404 until a follow-up sprint adds that page.
- **No auto-posting.** Contact form only captures lead info — no review sync or response generation is triggered.
- **Resend optional.** API route degrades gracefully (logs only) when `RESEND_API_KEY` is absent (e.g. local dev without env var).
- **`motion` package** must be installed before implementation (`pnpm add motion`).
