# Public Pages Truthfulness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the copy on the four public marketing pages so every claim is true to the system today, and add regression tests so the false claims cannot silently return.

**Architecture:** Copy-first — edit string content in the four page components plus one pricing data block; no worker/Stripe/schema/flag changes. Each page is one task: update/add a Vitest server-render test (red), apply the exact copy edits (green), commit. Per-tier *feature gating* is not code-enforced (only `tier-config.ts` billing params are), so the pricing matrix is treated as the commercial offering — we fix only the concrete falsehoods, not gut it.

**Tech Stack:** Next.js 16 client components (`.tsx`), Vitest + `react-dom/server` `renderToStaticMarkup`, pnpm.

**Branch:** `fix/public-pages-truthfulness` (already created; spec committed there).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/components/sections/how-it-works/HowItWorksContent.tsx` | How-it-works copy: guarantees, FAQ, steps, hood, artifacts | Modify |
| `src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx` | HIW render assertions | Modify |
| `src/app/(public)/pricing/PricingContent.tsx` | Tiers, matrix, FAQ, annual prices | Modify |
| `src/app/(public)/pricing/__tests__/PricingContent.test.tsx` | Pricing render assertions | Modify |
| `src/components/sections/features/FeaturesContent.tsx` | Features copy: approval, brief, ROI, approval-step caption | Modify |
| `src/components/sections/features/__tests__/FeaturesContent.test.tsx` | Features render assertions | Modify |
| `src/components/sections/landing/Hero.tsx` | Landing hero latency line | Modify |
| `src/components/sections/landing/__tests__/LandingContent.test.tsx` | Landing render assertions | Modify |

Each task is self-contained (one page) and committable on its own.

> **Editing note for the executor:** apply each "OLD → NEW" pair with the Edit tool. The OLD text is the exact current string. If an OLD string is not found verbatim, STOP and report — do not guess. Do not touch trial copy ("14-day free trial", "No charge until day 15", "Free for 14 days") — out of scope.

---

## Task 1: How-it-works page

**Files:**
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx`
- Test: `src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`

- [ ] **Step 1: Add the truthfulness regression test (red)**

Append this `it` block inside the existing `describe('HowItWorksContent', …)` in the test file:

```tsx
  it('states only claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(HowItWorksContent));

    // removed false/contradicting claims
    expect(html).not.toContain('No auto-post, ever');
    expect(html).not.toContain('Approval is a hard gate');
    expect(html).not.toContain('past 30 owner responses');
    expect(html).not.toContain('import your last 30 owner responses');
    expect(html).not.toContain('Google Business API');
    expect(html).not.toContain('voice model v3');
    expect(html).not.toContain('Matches you');
    expect(html).not.toContain('out of the box');

    // present, corrected claims
    expect(html).toContain('by default');
    expect(html).toContain('approve and edit');
    expect(html).toContain('Multi-location supported on Premium');
  });
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `pnpm vitest run src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`
Expected: FAIL — the false strings are still present.

- [ ] **Step 3: Apply the copy edits**

Apply each pair in `HowItWorksContent.tsx`:

1. GUARANTEE description —
   OLD: `'Every reply needs your tap. No auto-post, ever. No surprise posts on your behalf.'`
   NEW: `'Every reply waits for your approval by default. You can optionally turn on auto-approval (off by default), which only posts after passing automated safety checks.'`

2. FAQ "don't approve a draft" —
   OLD: `'Nothing. Drafts sit and wait. After 48 hours we send a gentle nudge. If you never approve, we never post — the review simply stays unanswered on your end.'`
   NEW: `'Nothing. Drafts sit and wait, and we send you a reminder. If you never approve, we never post — the review simply stays unanswered on your end.'`

3. FAQ "post without asking me" —
   OLD: `'No. Approval is a hard gate. Every reply requires your one-tap confirmation from the email. We built the whole flow around that.'`
   NEW: `'By default, no — every reply waits for your one-tap confirmation from the email. If you want hands-off posting, you can optionally enable auto-approval (off by default), which only posts after passing automated safety checks.'`

4. FAQ "how does it learn my voice" —
   OLD: `'On setup we import your last 30 owner responses from Google and build a voice profile — tone, length, phrasing quirks. You can correct it on the first few drafts; it updates within a day.'`
   NEW: `'RepWorth learns your voice from the replies you approve and edit. As you tweak drafts it picks up your tone, length, and phrasing — the more you use it, the more it sounds like you.'`

5. FAQ "negative reviews" —
   OLD: `"Drafts for 1–3★ reviews are flagged for extra review and routed to you with a longer deadline. We'll never auto-suggest a defensive or dismissive reply — the tone defaults to acknowledging and offering a path forward."`
   NEW: `"Drafts for 1–3★ reviews get extra care: we'll never auto-suggest a defensive or dismissive reply — the tone defaults to acknowledging the issue and offering a path forward, and high-risk drafts are held for your review."`

6. STEP 2 sub —
   OLD: `'We trained on your past 30 owner responses. The model picks up your phrasing, your rhythm, how you handle thanks and how you handle complaints. Each draft renders in under five seconds.'`
   NEW: `'RepWorth learns from the replies you approve and edit. The model picks up your phrasing, your rhythm, how you handle thanks and how you handle complaints. Each draft renders in seconds.'`

7. STEP 2 bullet —
   OLD: `'Trained on your existing owner responses'`
   NEW: `'Learns from the replies you approve and edit'`

8. STEP 1 bullet —
   OLD: `'Multi-location businesses handled out of the box'`
   NEW: `'Multi-location supported on Premium'`

9. STEP 4 sub —
   OLD: `'Once you approve, we post the reply back via the Google Business API. It shows up on your listing within seconds, attributed to the business owner, exactly as it would if you\'d typed it yourself.'`
   NEW: `'Once you approve, we post the reply back to your Google listing. It shows up within seconds, attributed to the business owner, exactly as it would if you\'d typed it yourself.'`

10. HOOD "Post back" tech —
    OLD: `tech: 'Business API'`
    NEW: `tech: 'Google'`

11. HOOD "Approval email" tech —
    OLD: `tech: 'Resend · HMAC'`
    NEW: `tech: 'Resend · signed link'`

12. Step2Artifact cap —
    OLD: `<span>Draft generation · voice model v3</span>`
    NEW: `<span>Draft generation · voice model</span>`

13. Step2Artifact — remove the "Matches you / 96%" voice chip. DELETE this block:
```tsx
          <div className="hiw-voice-chip">
            <span className="hiw-voice-chip-lbl">Matches you</span>
            <span className="hiw-voice-chip-val">96%</span>
          </div>
```

14. Hero meta — add an illustrative caption. Immediately AFTER the closing `</div>` of the `<div className="hiw-hero-meta"> … </div>` block, insert:
```tsx
            <p className="hiw-hero-meta-note" style={{ marginTop: 12, fontSize: 12, fontStyle: 'italic', color: '#6a6a6a' }}>
              Typical figures shown for illustration, not live performance data.
            </p>
```

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `pnpm vitest run src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`
Expected: PASS (both the existing test and the new one).

- [ ] **Step 5: Commit**

```bash
git add src/components/sections/how-it-works/
git commit -m "fix(how-it-works): correct copy to match system (approval, voice, posting)"
```

---

## Task 2: Pricing page

**Files:**
- Modify: `src/app/(public)/pricing/PricingContent.tsx`
- Test: `src/app/(public)/pricing/__tests__/PricingContent.test.tsx`

- [ ] **Step 1: Update existing assertions + add regression test (red)**

In `PricingContent.test.tsx`:

(a) Replace the two volume assertions (currently `expect(html).toContain('Best for up to ~50 review responses/month');` and `expect(html).toContain('High-volume or fair-use unlimited review responses');`) with:
```tsx
    expect(html).toContain('1 Google Business Profile location');
    expect(html).toContain('Multi-location setup available');
```

(b) Add a new `it` block inside the `describe`:
```tsx
  it('states only billing claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    // removed false / metering claims
    expect(html).not.toContain('refund the unused months');
    expect(html).not.toContain('review responses/month');
    expect(html).not.toContain('What counts as a');
    expect(html).not.toContain('go over my monthly limit');
    expect(html).not.toContain('Multiple approval notification channels');
    expect(html).not.toContain('3-year price lock');

    // corrected claims present
    expect(html).toContain('not refunded for unused time');
    expect(html).toContain('apply immediately and are prorated');
    expect(html).toContain('Locked-in founder pricing');
    // annual price corrected so "20% off" is literally true (Standard 63*12=756)
    expect(html).toContain('Billed annually ($756/yr) - 20% off $79/mo');
  });
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `pnpm vitest run "src/app/(public)/pricing/__tests__/PricingContent.test.tsx"`
Expected: FAIL.

- [ ] **Step 3: Apply the data + copy edits in `PricingContent.tsx`**

**Tiers — drop volume hl lines and re-anchor:**

1. Founders feature —
   OLD: `{ text: '3-year price lock', hl: true },`
   NEW: `{ text: 'Locked-in founder pricing', hl: true },`

2. Basic — remove the volume line and promote the location line. Replace:
   OLD: `{ text: 'Best for up to ~50 review responses/month', hl: true },`
   `      { text: '1 Google Business Profile location' },`
   NEW: `{ text: '1 Google Business Profile location', hl: true },`

3. Standard — remove the volume line and promote the digest line. Replace:
   OLD: `{ text: 'Best for up to ~300 review responses/month', hl: true },`
   (and later in the same array) `{ text: 'Weekly and monthly review digest' },`
   Do TWO edits:
   - DELETE the line `{ text: 'Best for up to ~300 review responses/month', hl: true },`
   - OLD: `{ text: 'Weekly and monthly review digest' },` (Standard array) → NEW: `{ text: 'Weekly and monthly review digest', hl: true },`

4. Premium — remove the volume line and promote the multi-location line. Do TWO edits:
   - DELETE the line `{ text: 'High-volume or fair-use unlimited review responses', hl: true },`
   - OLD: `{ text: 'Multi-location setup available' },` → NEW: `{ text: 'Multi-location setup available', hl: true },`

5. Premium channel feature —
   OLD: `{ text: 'Multiple approval notification channels' },`
   NEW: `{ text: 'Email plus one mobile channel (SMS, Telegram, or WhatsApp)' },`

**Annual prices (display-only, no Stripe backing):**

6. OLD (basic): `annual: 24,` → NEW: `annual: 23,`
7. OLD (standard): `annual: 64,` → NEW: `annual: 63,`

**Matrix:**

8. DELETE the volume row:
   `{ label: 'Best-fit monthly review volume', values: ['~300', '~50', '~300', 'High-volume fair use'] },`

9. Price-lock row —
   OLD: `{ label: 'Price lock', values: ['3 years', false, false, false] },`
   NEW: `{ label: 'Price lock', values: ['Locked in', false, false, false] },`

10. Regenerate row —
    OLD: `{ label: 'Regenerate with feedback', values: [true, true, true, true] },`
    NEW: `{ label: 'Regenerate drafts', values: [true, true, true, true] },`

11. Backfill row (Standard does NOT get it — premium-only in code) —
    OLD: `{ label: 'Historical unanswered review backfill', values: [false, false, true, true] },`
    NEW: `{ label: 'Historical unanswered review backfill', values: [false, false, false, true] },`

12. DELETE the impossible multi-channel row:
    `{ label: 'Multiple approval notification channels', values: [false, false, false, true] },`

**FAQ:**

13. DELETE the metering FAQ entry:
    `{ q: 'What counts as a "review response"?', a: 'Any reply we draft, whether you approve, edit, or regenerate it. If you regenerate a draft three times, that counts as one response — not three.' },`

14. DELETE the over-limit FAQ entry:
    `{ q: 'What happens if I go over my monthly limit?', a: "We'll keep drafting so nothing falls through the cracks, and nudge you to upgrade. We never block responses without warning." },`

15. Plan-change FAQ —
    OLD: `{ q: 'Can I change plans later?', a: 'Yes. Upgrade, downgrade, or cancel any time from the settings page. Upgrades apply instantly; downgrades take effect at the end of your current billing cycle.' },`
    NEW: `{ q: 'Can I change plans later?', a: 'Yes. Upgrade, downgrade, or cancel any time from the settings page. Plan changes apply immediately and are prorated.' },`

16. Approval FAQ —
    OLD: `{ q: 'Do I have to approve every reply?', a: "Yes. That's the whole point — you stay in control of your brand voice. Approval takes one tap on your phone. Owners typically clear a week's worth of reviews in under five minutes." },`
    NEW: `{ q: 'Do I have to approve every reply?', a: "By default, yes — every reply waits for your one-tap approval, so you stay in control of your brand voice. You can optionally enable auto-approval (off by default) if you later want hands-off posting. Approval takes one tap on your phone." },`

17. Contract/refund FAQ —
    OLD: `{ q: 'Is there a contract?', a: 'No. Monthly plans are month-to-month. Annual plans lock in a 20% discount but can still be cancelled — we refund the unused months, pro-rated.' },`
    NEW: `{ q: 'Is there a contract?', a: 'No. Monthly plans are month-to-month; annual plans are paid upfront for the year. Cancel any time — your access continues through the end of the paid period and you are not charged again. Annual plans are not refunded for unused time.' },`

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `pnpm vitest run "src/app/(public)/pricing/__tests__/PricingContent.test.tsx"`
Expected: PASS. (Note: the existing `expect(html).toContain('Billed annually ($1908/yr) - 20% off $199/mo');` for Premium stays valid — Premium annual unchanged.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/pricing/"
git commit -m "fix(pricing): drop unenforced volume, correct refund/plan-change/matrix copy"
```

---

## Task 3: Features page

**Files:**
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Add the regression test (red)**

Append inside the existing `describe`:
```tsx
  it('states only feature claims true to the system', () => {
    const html = renderToStaticMarkup(createElement(FeaturesContent));

    expect(html).not.toContain('Top mentions, scored by sentiment');
    expect(html).not.toContain('over 90 days');
    expect(html).not.toContain('Webhook from Google');
    expect(html).not.toContain('ever posted without your explicit go-ahead');

    expect(html).toContain('By default, nothing is posted without your go-ahead');
  });
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `pnpm vitest run src/components/sections/features/__tests__/FeaturesContent.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Apply the copy edits in `FeaturesContent.tsx`**

1. FeatApprove paragraph —
   OLD: `You get an email with the customer&apos;s review and the AI draft side-by-side. Tap
            approve, edit inline, or ask for a fresh draft. Nothing is ever posted without your
            explicit go-ahead.`
   NEW: `You get an email with the customer&apos;s review and the AI draft side-by-side. Tap
            approve, edit inline, or ask for a fresh draft. By default, nothing is posted without your
            go-ahead.`

2. FeatBrief bullets — replace the array:
   OLD:
```tsx
              'Top mentions, scored by sentiment',
              'Week-over-week review volume & stars',
              'One concrete operational suggestion',
```
   NEW:
```tsx
              'Week-over-week review volume',
              'One concrete operational suggestion',
```

3. FeatRoi paragraph —
   OLD: `Response rate before and after. Average time to respond. Where you sit in local search over
            90 days. The kind of numbers that justify the line item.`
   NEW: `Response rate before and after. Average time to respond. Where you sit in local search.
            The kind of numbers that justify the line item.`

4. APPROVAL_STEPS step 01 sub —
   OLD: `{ n: '01', title: 'New review lands', sub: 'Webhook from Google · detected in < 60 seconds', t: '0:00', dark: false, d: '100ms' },`
   NEW: `{ n: '01', title: 'New review lands', sub: 'New review detected via webhook', t: '0:00', dark: false, d: '100ms' },`

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `pnpm vitest run src/components/sections/features/__tests__/FeaturesContent.test.tsx`
Expected: PASS (existing `toContain('96')` hero-metric assertion still valid).

- [ ] **Step 5: Commit**

```bash
git add src/components/sections/features/
git commit -m "fix(features): correct brief/ROI/approval copy to match system"
```

---

## Task 4: Landing hero

**Files:**
- Modify: `src/components/sections/landing/Hero.tsx`
- Test: `src/components/sections/landing/__tests__/LandingContent.test.tsx`

- [ ] **Step 1: Add the regression assertion (red)**

Append inside the existing `describe('LandingContent', …)`:
```tsx
  it('uses a consistent, non-overpromised latency phrase', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));
    expect(html).not.toContain('Draft ready in 8 seconds');
    expect(html).toContain('Draft ready in seconds');
  });
```
(If `LandingContent` is not already imported in this test file, the executor must add `import { LandingContent } from '../LandingContent';` — check the existing imports first.)

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `pnpm vitest run src/components/sections/landing/__tests__/LandingContent.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Apply the copy edit in `Hero.tsx`**

OLD: `Draft ready in 8 seconds`
NEW: `Draft ready in seconds`

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `pnpm vitest run src/components/sections/landing/__tests__/LandingContent.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sections/landing/
git commit -m "fix(landing): standardize draft-latency phrasing"
```

---

## Task 5: Full validation + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm ci:static-policy`
Expected: all PASS. (No DB/flag/analytics changes; static-policy run because UI files changed.)

- [ ] **Step 2: Build sanity**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/public-pages-truthfulness
gh pr create --title "Fix public-pages truthfulness (copy correction)" --body "$(cat <<'EOF'
Corrects false/imprecise marketing claims found in the 2026-06-21 audit so the
four public pages match the system. Copy-first; no backend changes. Trial excluded.

- How-it-works: drop "no auto-post ever"/"hard gate" → default-approval + opt-in auto disclosure; voice "30 from Google" → learns from your edits; "Google Business API" → "your Google listing"; HMAC→signed link; remove "voice model v3"/"96% match"; multi-location "out of the box" → "supported on Premium".
- Pricing: drop unenforced volume metering + metering FAQs; refund claim → matches legal terms (not refunded); downgrade → "applies immediately, prorated"; matrix backfill → premium-only; remove impossible "multiple channels"; "3-year lock" → "locked-in"; annual prices nudged so "Save 20%" is literally true.
- Features: remove unbuilt "top mentions, scored by sentiment"; ROI "over 90 days" → removed; "Webhook from Google" → "via webhook"; soften "ever".
- Landing: standardize "Draft ready in seconds".
- Adds per-page truthfulness regression tests.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage:** every spec change row maps to a task — HIW (T1), Pricing incl. matrix/annual/FAQ (T2), Features (T3), Landing latency (T4), validation+tests (all + T5). Landing "15h"/"96%" retained as illustrative (Example-framed) per the spec's typical-value allowance; only the inconsistent latency figure is standardized.
- **Placeholder scan:** all steps contain exact strings/commands. No TBD.
- **Type/string consistency:** new test strings (`'Draft ready in seconds'`, `'not refunded for unused time'`, `'apply immediately and are prorated'`, `'Locked-in founder pricing'`, `'Multi-location supported on Premium'`, `'By default, nothing is posted without your go-ahead'`, `'($756/yr) - 20% off $79/mo'`) exactly match the NEW copy in their tasks.
