# Brand `help/contact` + `feedback/thanks` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the two unbranded gray utility pages (`help/contact`, `feedback/thanks`) into RepWorth island pages with clickable `mailto:` links and a CTA back to home, plus per-page metadata.

**Architecture:** Each page splits into a server `page.tsx` (owns `metadata`, reads env) + a co-located `'use client'` content component that composes the shared `PageShell` island — mirroring `book-a-demo/{page.tsx,BookADemoContent.tsx}`. `PageShell` gains an optional `maxWidthClassName` prop so the narrow `feedback/thanks` pane reuses the island instead of duplicating it.

**Tech Stack:** Next.js 16 (App Router), React 19, `motion/react` v12, Tailwind v4, Vitest (`renderToStaticMarkup`).

**Spec:** `docs/superpowers/specs/2026-05-28-launch-p0-utility-pages-design.md`

**Working directory:** worktree `/private/tmp/repworth-utility-pages` on branch `fix/launch-p0-utility-pages`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/ui/PageShell.tsx` | **Modify** — add optional `maxWidthClassName` prop (default `'max-w-5xl'`) |
| `src/components/ui/__tests__/PageShell.test.tsx` | **Create** — guards the new prop + default |
| `src/app/(public)/feedback/thanks/FeedbackThanksContent.tsx` | **Create** — branded narrow confirmation pane |
| `src/app/(public)/feedback/thanks/page.tsx` | **Rewrite** — server: metadata (noindex) + render content |
| `src/app/(public)/feedback/thanks/__tests__/FeedbackThanksContent.test.tsx` | **Create** |
| `src/app/(public)/help/contact/ContactContent.tsx` | **Create** — branded channel-card support page |
| `src/app/(public)/help/contact/page.tsx` | **Rewrite** — server: metadata + env + render content |
| `src/app/(public)/help/contact/__tests__/ContactContent.test.tsx` | **Create** |

Conventions (do not deviate): import `motion` from `motion/react` (never `framer-motion`); inline SVGs only (no icon libraries); only brand tokens (`#D2E0D3`, `#97B3AE`, `#F2C3B9`, `#D6CBBF`, `#F0EEEA`, `#2a2a2a`, `#6a6a6a`); no `amber`/`orange`/`stone`/`yellow`/`bg-gray-*`/`bg-blue-*`. Home CTAs use Next `<Link>` with Tailwind hover/active transitions; `mailto:` pills use `motion.a`.

All commit messages end with the trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 1: Add `maxWidthClassName` prop to `PageShell`

**Files:**
- Create: `src/components/ui/__tests__/PageShell.test.tsx`
- Modify: `src/components/ui/PageShell.tsx` (props interface + island `motion.div` className)

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/__tests__/PageShell.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageShell } from '../PageShell';

describe('PageShell', () => {
  it('defaults the island to max-w-5xl and renders its children', () => {
    const html = renderToStaticMarkup(
      createElement(PageShell, { sections: [] }, 'island-child'),
    );
    expect(html).toContain('max-w-5xl');
    expect(html).toContain('island-child');
  });

  it('applies a custom island max-width when provided', () => {
    const html = renderToStaticMarkup(
      createElement(PageShell, { sections: [], maxWidthClassName: 'max-w-md' }, 'x'),
    );
    expect(html).toContain('max-w-md');
    expect(html).not.toContain('max-w-5xl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/PageShell.test.tsx`
Expected: the second test FAILS (output still contains `max-w-5xl`, never `max-w-md`) because the prop does not exist yet.

- [ ] **Step 3: Add the prop to the interface**

In `src/components/ui/PageShell.tsx`, replace the `PageShellProps` interface (lines 11-14):

```tsx
interface PageShellProps {
  sections: PageSection[];
  children: React.ReactNode;
  /** Tailwind max-width class for the island. Defaults to 'max-w-5xl'. */
  maxWidthClassName?: string;
}
```

- [ ] **Step 4: Destructure and apply the prop**

In the same file, change the function signature (line 16):

```tsx
export function PageShell({ sections, children, maxWidthClassName = 'max-w-5xl' }: PageShellProps) {
```

Then change the island `motion.div` className (line 76) from:

```tsx
          className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl"
```

to:

```tsx
          className={`w-full ${maxWidthClassName} bg-white rounded-[3rem] shadow-2xl`}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/components/ui/__tests__/PageShell.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Confirm existing callers still compile**

Run: `pnpm typecheck`
Expected: no errors (existing callers omit the optional prop and get the default).

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/PageShell.tsx src/components/ui/__tests__/PageShell.test.tsx
git commit -m "feat(ui): add optional maxWidthClassName prop to PageShell

Lets single-pane pages (feedback/thanks) reuse the island/parallax at a
narrower width without duplicating the shell. Defaults to max-w-5xl so
existing callers are unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Brand `feedback/thanks`

**Files:**
- Create: `src/app/(public)/feedback/thanks/__tests__/FeedbackThanksContent.test.tsx`
- Create: `src/app/(public)/feedback/thanks/FeedbackThanksContent.tsx`
- Modify (rewrite): `src/app/(public)/feedback/thanks/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(public)/feedback/thanks/__tests__/FeedbackThanksContent.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FeedbackThanksContent } from '../FeedbackThanksContent';

vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('FeedbackThanksContent', () => {
  it('confirms the feedback and offers a way back to RepWorth', () => {
    const html = renderToStaticMarkup(createElement(FeedbackThanksContent));
    expect(html).toContain('Thank you');
    expect(html).toContain('Your feedback has been recorded');
    expect(html).toContain('Back to RepWorth');
    expect(html).toContain('href="/"');
    expect(html).toContain('RepWorth');
  });

  it('uses only brand tokens (no gray/blue prototype styling)', () => {
    const html = renderToStaticMarkup(createElement(FeedbackThanksContent));
    expect(html).not.toContain('bg-gray-50');
    expect(html).not.toContain('bg-blue-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/'(public)'/feedback/thanks/__tests__/FeedbackThanksContent.test.tsx`
Expected: FAIL — cannot resolve `../FeedbackThanksContent` (module does not exist yet).

- [ ] **Step 3: Create the content component**

Create `src/app/(public)/feedback/thanks/FeedbackThanksContent.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';

export function FeedbackThanksContent() {
  return (
    <PageShell sections={[]} maxWidthClassName="max-w-md">
      {/* Minimal brand header */}
      <div className="flex items-center justify-center gap-2 px-8 pt-8">
        <div
          className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80"
          aria-hidden="true"
        />
        <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
      </div>

      <motion.div
        className="px-8 pb-12 pt-6 text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        <div
          className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-[#97B3AE]/15"
          aria-hidden="true"
        >
          <svg className="h-8 w-8 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h1 className="mb-3 text-3xl font-medium text-[#2a2a2a]">Thank you</h1>
        <p className="mb-8 leading-relaxed text-[#6a6a6a]">
          Your feedback has been recorded. It goes straight to the team that builds RepWorth.
        </p>

        <Link
          href="/"
          className="inline-block rounded-full bg-[#97B3AE] px-8 py-4 text-white shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:shadow-xl active:scale-95"
        >
          Back to RepWorth →
        </Link>
      </motion.div>
    </PageShell>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/'(public)'/feedback/thanks/__tests__/FeedbackThanksContent.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewrite the server page with metadata**

Replace the entire contents of `src/app/(public)/feedback/thanks/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { FeedbackThanksContent } from './FeedbackThanksContent';

export const metadata: Metadata = {
  title: 'Thank you · RepWorth',
  description: 'Your feedback has been recorded.',
  robots: { index: false, follow: false },
};

export default function FeedbackThanksPage() {
  return <FeedbackThanksContent />;
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/feedback/thanks/"
git commit -m "feat(feedback): brand the feedback/thanks confirmation page

Island layout with minimal brand header, success check, and a CTA back
to home so the page is no longer a gray dead-end. Adds noindex metadata.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Brand `help/contact`

**Files:**
- Create: `src/app/(public)/help/contact/__tests__/ContactContent.test.tsx`
- Create: `src/app/(public)/help/contact/ContactContent.tsx`
- Modify (rewrite): `src/app/(public)/help/contact/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(public)/help/contact/__tests__/ContactContent.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContactContent } from '../ContactContent';

vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('ContactContent', () => {
  it('renders a clickable mailto link for every support channel', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain('href="mailto:support@repworth.net"');
    expect(html).toContain('href="mailto:billing@repworth.net"');
    expect(html).toContain('href="mailto:security@repworth.net"');
  });

  it('preserves the response targets and help topics copy', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain('Basic and Founders: 24 business hours');
    expect(html).toContain('Premium: 2 business hours');
    expect(html).toContain('Importing locations by CSV');
  });

  it('offers a branded way back to RepWorth', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain('Back to RepWorth');
    expect(html).toContain('href="/"');
  });

  it('uses only brand tokens (no prototype gray/blue/amber/yellow)', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).not.toContain('bg-gray-50');
    expect(html).not.toContain('bg-blue-');
    expect(html).not.toContain('amber');
    expect(html).not.toContain('text-yellow-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/'(public)'/help/contact/__tests__/ContactContent.test.tsx`
Expected: FAIL — cannot resolve `../ContactContent` (module does not exist yet).

- [ ] **Step 3: Create the content component**

Create `src/app/(public)/help/contact/ContactContent.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

type IconKey = 'mail' | 'card' | 'shield';

interface SupportChannel {
  title: string;
  purpose: string;
  email: string;
  circle: string;
  icon: IconKey;
}

const CHANNELS: SupportChannel[] = [
  {
    title: 'Account help',
    purpose: 'Connecting Google, locations, and day-to-day questions',
    email: 'support@repworth.net',
    circle: 'from-[#97B3AE] to-[#97B3AE]/80',
    icon: 'mail',
  },
  {
    title: 'Billing',
    purpose: 'Invoices, plan changes, and past-due recovery',
    email: 'billing@repworth.net',
    circle: 'from-[#F2C3B9] to-[#F2C3B9]/80',
    icon: 'card',
  },
  {
    title: 'Security',
    purpose: 'Report a vulnerability or security incident',
    email: 'security@repworth.net',
    circle: 'from-[#D6CBBF] to-[#D6CBBF]/80',
    icon: 'shield',
  },
];

const ICON_PATHS: Record<IconKey, string> = {
  mail: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  card: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
  shield: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
};

const RESPONSE_TARGETS = [
  'Basic and Founders: 24 business hours',
  'Standard: 8 business hours',
  'Premium: 2 business hours',
];

const HELP_TOPICS = [
  'Connecting your Google Business Profile',
  'Billing and past-due recovery',
  'Importing locations by CSV',
];

export function ContactContent({ selfServeEnabled = false }: { selfServeEnabled?: boolean }) {
  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />

      <div className="px-8 py-16 md:py-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <p className="mb-4 text-sm uppercase tracking-wider text-[#97B3AE]">Support</p>
          <h1 className="mb-4 text-4xl font-medium leading-tight text-[#2a2a2a] md:text-5xl">
            How can we help?
          </h1>
          <p className="mb-10 text-lg leading-relaxed text-[#6a6a6a]">
            Pick the channel that fits. We answer fastest by email.
          </p>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-3">
          {CHANNELS.map((channel, i) => (
            <motion.div
              key={channel.email}
              className="flex flex-col rounded-2xl border border-[#97B3AE]/10 bg-white p-6 shadow-lg"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
            >
              <div
                className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br shadow-md ${channel.circle}`}
                aria-hidden="true"
              >
                <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={ICON_PATHS[channel.icon]} />
                </svg>
              </div>
              <h3 className="mb-2 text-xl font-medium text-[#2a2a2a]">{channel.title}</h3>
              <p className="mb-6 flex-1 text-[#6a6a6a]">{channel.purpose}</p>
              <motion.a
                href={`mailto:${channel.email}`}
                className="inline-block rounded-full border border-[#97B3AE]/20 bg-[#97B3AE]/10 px-5 py-3 text-center font-medium text-[#97B3AE] transition-colors hover:bg-[#97B3AE]/20"
                whileHover={{ scale: 1.04, y: -2 }}
                whileTap={{ scale: 0.98 }}
              >
                {channel.email}
              </motion.a>
            </motion.div>
          ))}
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <motion.div
            className="rounded-2xl border border-[#97B3AE]/10 bg-[#F0EEEA]/60 p-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6 }}
          >
            <h2 className="mb-4 text-xl font-medium text-[#2a2a2a]">Response targets</h2>
            <ul className="space-y-2 text-[#6a6a6a]">
              {RESPONSE_TARGETS.map((target) => (
                <li key={target}>{target}</li>
              ))}
            </ul>
          </motion.div>

          <motion.div
            className="rounded-2xl border border-[#97B3AE]/10 bg-[#F0EEEA]/60 p-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <h2 className="mb-4 text-xl font-medium text-[#2a2a2a]">Common help topics</h2>
            <ul className="space-y-2 text-[#6a6a6a]">
              {HELP_TOPICS.map((topic) => (
                <li key={topic}>{topic}</li>
              ))}
            </ul>
          </motion.div>
        </div>
      </div>

      <section className="rounded-b-[3rem] bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 px-8 py-12 text-center text-white">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <p className="mb-6 text-lg text-white/90">Looking for something else?</p>
          <Link
            href="/"
            className="inline-block rounded-full bg-white px-8 py-4 font-medium text-[#97B3AE] shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:shadow-xl active:scale-95"
          >
            Back to RepWorth →
          </Link>
        </motion.div>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/'(public)'/help/contact/__tests__/ContactContent.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewrite the server page with metadata + env**

Replace the entire contents of `src/app/(public)/help/contact/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { ContactContent } from './ContactContent';

export const metadata: Metadata = {
  title: 'Contact support · RepWorth',
  description:
    'Email RepWorth support, billing, or security — plus response-time targets by plan.',
};

export default function HelpContactPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <ContactContent selfServeEnabled={selfServeEnabled} />;
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/help/contact/"
git commit -m "feat(contact): brand the help/contact support page

Island layout with three mailto: channel cards (account/billing/security),
response-target + help-topic panels, and a CTA back to home. Adds per-page
metadata. Replaces the unbranded gray prototype.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

**Files:** none (validation only).

- [ ] **Step 1: Run lint**

Run: `pnpm lint`
Expected: no errors (no `<a>`-for-internal-link warnings — home CTAs use `<Link>`; the `mailto:` anchors are external and allowed).

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass, including the three new test files.

- [ ] **Step 4: Confirm clean tree**

Run: `git status --short`
Expected: empty (everything committed in Tasks 1-3).

- [ ] **Step 5 (if Step 4 shows changes): commit any stragglers**

```bash
git add -A
git commit -m "chore(utility-pages): finalize branding pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** island layout → Tasks 2-3 (`PageShell`); clickable mailto → Task 3 channel cards; CTA out of dead-end → Tasks 2-3 home CTA; per-page metadata → Tasks 2-3 server pages; `PageShell` narrow pane → Task 1. All spec sections mapped.
- **Placeholder scan:** every code step contains complete, runnable code; no TBD/TODO.
- **Type consistency:** `PageShellProps.maxWidthClassName` (Task 1) matches its use in `FeedbackThanksContent` (Task 2). `SupportChannel.icon: IconKey` matches `ICON_PATHS: Record<IconKey, string>` (Task 3). `selfServeEnabled` prop matches the server page's usage (Task 3).
- **Out of scope (untouched):** domain `.com`/`.net` standardization, SiteNav hamburger, PageShell `type="button"` dot-nav fix.
