# Marketing Pages Agentic Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `/features` and `/how-it-works` around the two-tier agent narrative (Copilot/Autopilot, Reply/Guardian/Insights, Judge/Governor), restructuring sections while reusing existing visual patterns, and splitting both oversized components into per-section files.

**Architecture:** Pure presentational change. `FeaturesContent.tsx` (1,215 lines) and `HowItWorksContent.tsx` (768 lines) become thin orchestrators; each feature section / step artifact moves to its own file in the same folder. New sections (Guardian, Autopilot, Watchdogs, Triage, Gate-fork, Judge) reuse the existing reveal/animation patterns and CSS (`rw-*` Tailwind-composed classes on features; `hiw-*` classes from `globals.css` on how-it-works). No new dependencies, no new CSS files, no flag/API changes.

**Tech Stack:** Next.js 16, React, Tailwind (features page), scoped CSS classes in `src/app/globals.css` (how-it-works page), Vitest (`renderToStaticMarkup` content tests + jsdom client test).

**Spec:** `docs/superpowers/specs/2026-07-22-marketing-pages-agentic-refresh-design.md`

**Branch:** `feat/marketing-pages-agentic-refresh` (already created; spec committed).

**Before any UI code:** invoke the `repworth-brand-design` skill (RepWorth UI rule) once at the start of execution.

**Verbatim-move convention used below:** "Move X (lines A–B)" means cut that exact range from the source file into the new file unchanged, then add only the stated imports/exports. Line numbers refer to the files as of commit `8ba54ee5`.

**One implementation-time delta from the spec:** the "Craft and proof" group is ordered Languages → Voice → ROI (not Voice → Languages → ROI) so the light Languages section separates the two dark sections (Watchdogs at 06, Voice at 08). The spec explicitly deferred this to implementation.

---

## Copy blocks (single source of truth for all tasks)

All copy below is final. Tasks reference these blocks; do not improvise wording. Guardrails: no "unlock/supercharge/seamless", no fake named customers, illustrative-data disclaimers stay, "Negative reviews are never auto-posted" appears verbatim on BOTH pages.

### Features page

- **Hero kicker:** `Features · Your agent team`
- **Hero headline line 1 (word-per-span):** `A tireless agent answers every review.`
- **Hero headline line 2:** `Nothing goes public without the gate.` — serif accent (`rw-display-serif text-rw-teal-strong`) on the final word `gate.`
- **Hero lede:** `RepWorth is an AI agent team, not another dashboard. Reply drafts every response, Guardian triages the bad ones, Insights reports on Mondays — and two watchdogs, the Judge and the Governor, oversee anything that posts on its own. You pick the autonomy: approve every reply on Copilot, or let policy-cleared replies post themselves on Autopilot.`
- **Hero metrics:** unchanged (58min / 96% / 30sec + illustrative disclaimer).
- **Index label (right of "Index"):** `3 agents · 2 watchdogs · 2 modes`
- **TOC group labels** (rendered as mono kickers above chip rows): `Your agent team` (01–03), `Care and control` (04–06), `Craft and proof` (07–09).
- **Metadata description (`features/page.tsx`):** `The AI agent team for your reputation — Reply drafts in your voice, Guardian triages negative reviews, Autopilot posts within your policy, and a Judge reviews every auto-post.`
- **CTA kicker** changes from `What's next` to `Early access` (roadmap band now owns "What's next").

Section copy:

**01 Reply** (update of FeatAi; id `f-reply`)
- kicker `Reply · your drafter`; H2 unchanged: `Every reply written from scratch, never from a template.` (serif on `never`)
- body: `Reply is the drafting agent. It reads the actual review, references the specifics the customer mentioned, and writes in a voice that sounds like you wrote it yourself. No "thanks for your feedback" filler.`
- Before/after artifact unchanged.

**02 Guardian** (NEW; id `f-guardian`)
- kicker `Guardian · the negative lane`; H2: `Bad reviews get read first, not just answered.` (serif on `first`)
- body: `Guardian triages every negative review by severity before anything is drafted. Routine gripes flow on to drafting; serious ones — health claims, legal threats, review-bombing — escalate straight to you with the context attached. Guardian never posts anything, anywhere.`
- Timeline artifact rows (reuses the `FeatGate` timeline pattern):
  1. `1★ review lands` / `Negative lane — Guardian reads it first` / `0:00`
  2. `Severity read` / `Routine · elevated · critical — a bounded AI check` / `+0:01`
  3. `Critical → escalation` / `You're notified with the full context` / `+0:02`
  4. (dark) `You acknowledge and resolve` / `Tracked until discharged · never auto-posted` / `—`

**03 Insights** (reframe of FeatBrief; id `f-insights`)
- kicker `Insights · every Monday`; H2 unchanged: `A brief you'll actually read.`
- body: `Insights is the reporting agent. Not a dashboard, not a chart dump — a short, plain-language summary of what customers said this week: what they loved, what they complained about, and one thing worth looking at on the ops side.`
- Brief artifact unchanged.

**04 The Gate (Copilot)** (update of FeatApprove; id `f-gate`)
- kicker `Copilot · your control`; H2 unchanged: `Every reply needs your sign-off.` (serif on `sign-off`)
- body: `On Copilot, every draft comes to you on the channel you choose — email, Telegram, or WhatsApp — with the review and the reply side-by-side. Tap approve, edit inline, or ask for a fresh draft. Nothing is posted without your go-ahead.`
- `APPROVAL_STEPS` step 3 becomes: title `You get a message on your channel`, sub `Email, Telegram, or WhatsApp — review + draft + three buttons`.
- Phone artifact unchanged.

**05 Autopilot** (NEW; id `f-autopilot`)
- kicker `Autopilot · bounded autonomy`; H2: `Hands-off, inside your rules.` (serif on `your`)
- body: `On Autopilot, replies to 4–5★ unflagged reviews can post themselves — but only inside a policy you set. You choose the rating band, the daily cap, and a veto window of 15 or 30 minutes. Until the window closes, the reply is yours to stop with one tap. Negative reviews are never auto-posted.`
- Artifact: veto-window countdown card (full code in Task 6).

**06 The watchdogs** (NEW, dark section; id `f-watchdogs`)
- kicker `Judge & Governor · oversight`; H2: `Autonomy that is watched, always.` (serif on `always`)
- body: `Every reply that posts without your tap is reviewed by the Judge — an independent AI check on 100% of Autopilot's public actions. If the Judge is unavailable, auto-posting stops on its own. And if verdicts slip, the Governor suspends that account's autonomy and tells you. Trust is earned per account, never assumed.`
- Artifact: verdict ledger (full code in Task 7).

**07 Languages / 08 Voice / 09 ROI:** copy unchanged; only ids/numbers renumber (`f-lang`→07, `f-voice`→08, `f-roi`→09; on-screen `rw-num-tag` digits update to `07`, `08`, `09`).

**Roadmap band** (replaces FeatComp; unnumbered)
- kicker `What's next` + `In testing` badge kept on the scorecard.
- heading: `The same agent, reaching further.`
- verb row (mono, separated by `·`): `Get reviews · Flag fakes · Watch everywhere`
- supporting line: `Today RepWorth minds your Google reviews. The roster above is what the agent takes on next — including the neighborhood scorecard already in private testing.`
- Right column: the existing anonymized competitor scorecard card verbatim (keeps `Coming soon`/`preview`/`Competitor A–C` strings the tests assert).

### How-it-works page

- **Hero H1:** `One pipeline from new review to public reply — with a gate in the middle.`
- **Hero lead:** `RepWorth watches for new Google reviews, triages them, drafts a reply in your voice, and brings it to the gate. On Copilot you approve every reply with one tap. On Autopilot, replies that clear your policy post themselves after a veto window you control — and the Judge reviews every one of them.`
- **Hero meta strip (4 items):** `~5 min` / `safety-net poll` · `30 sec` / `your time per reply` · `15/30 min` / `veto window on Autopilot` · `100%` / `of auto-posts judged`. Illustrative note kept.
- **Metadata description (`how-it-works/page.tsx`):** `Watch, triage, draft, gate, post, judge. On Copilot you approve every reply; on Autopilot, policy-cleared replies post after a veto window you control.`
- **Dot-nav SECTIONS labels:** `Overview`, `The pipeline`, `Under the hood`, `FAQ`, `Join waitlist` (ids unchanged).
- **Steps header:** eyebrow `The pipeline`, H2 `Six steps from new review to public reply.`, illustrative note kept.

**OVERVIEW strip (6 cells):**
| n | title | time |
|---|---|---|
| 01 | Watch | near real-time |
| 02 | Triage | ~1 sec |
| 03 | Draft | ~4 sec |
| 04 | The Gate | you — or your policy |
| 05 | Post | instant |
| 06 | Judge | automatic |

**STEPS copy (full array in Task 12):**
1. **Watch** — title/sub/bullets unchanged from current Step 1 (keeps the `Multi-location supported on Copilot and Autopilot` bullet).
2. **Triage** (NEW) — title `Guardian reads it before anyone answers.`; sub `Every review is sorted by star sentiment first. Negative reviews get a severity read — routine, elevated, or critical — and critical ones escalate straight to you with the context attached. Positive reviews flow on to drafting.`; bullets: `Negative lane gets a bounded AI severity read` / `Critical issues escalate to you immediately` / `Guardian never posts anything, anywhere`.
3. **Draft** — title/sub unchanged from current Step 2; bullets become: `Learns from the replies you approve and edit` / `Every draft passes a moderation check before the gate` / `Regenerate button if the first pass misses`.
4. **The Gate** (fork) — title `Copilot asks you. Autopilot asks your policy.`; sub `This is the fork. On Copilot, every draft comes to you — email, Telegram, or WhatsApp — with one tap to approve, edit, or regenerate. On Autopilot, replies to 4–5★ unflagged reviews that fit your policy post themselves after a veto window of 15 or 30 minutes, and one tap stops them. Negative reviews are never auto-posted.`; bullets: `One-tap approve on the channel you choose` / `Autopilot posts only inside your rating band and daily cap` / `The veto window is your one-tap stop before anything goes live`.
5. **Post** — title unchanged; sub `Once a reply clears the gate, we post it to your Google listing. It shows up within seconds, attributed to the business owner. Replies that posted on Autopilot send you an FYI the moment they're live.`; bullets: `Shows as "Response from the owner" on Google` / `Auto-posts send an FYI with a link to the live reply` / `Receipt logged in your dashboard for audit`.
6. **Judge** (NEW) — title `Every auto-post gets a second opinion.`; sub `After any reply posts without your tap, the Judge — an independent AI reviewer — checks it against your policy and your brand. Verdicts feed the Governor: if trust slips, it suspends autonomy for that account and notifies you. And if the Judge is ever unavailable, auto-posting stops on its own.`; bullets: `100% of auto-posted replies are reviewed` / `The Governor can suspend autonomy per account` / `Judge unavailable → auto-posting halts`.

**HOOD (6 nodes):**
| title | sub | tech |
|---|---|---|
| Review ingest | Reacts to a provider webhook in near-real-time; a safety-net poll runs every ~5 minutes. | webhook · BullMQ |
| Guardian triage | Severity read on the negative lane; critical reviews escalate to the owner. | severity · escalation |
| Voice model | Drafts a reply in your voice, then runs it through moderation. | LLM · moderated |
| The gate | Owner approval on Copilot; policy + veto window on Autopilot. | approval · veto |
| Post back | Submits the approved reply to Google on your behalf. | Google |
| Judge | Reviews every auto-post; the Governor suspends autonomy if trust slips. | verdicts · governor |

**GUARANTEES (4):** `Nothing posts without passing the gate` — `On Copilot that gate is you. On Autopilot it's your policy, a veto window, moderation, and the Judge. Negative reviews are never auto-posted.` · `Sounds like you wrote it` — unchanged desc · `Pause anytime` — `Toggle a location off in one tap — and if trust ever slips, the Governor pauses autonomy for you.` · keep existing icons; the fourth guarantee is dropped (stays at 3 cards — matches current count, no layout change).

**FAQ (6 items):**
1. `What can Autopilot post without asking me?` → `Only replies to 4–5★ unflagged reviews that fit your owner-set policy — and only after the veto window passes and moderation, judge, and governor safeguards clear it. Negative reviews are never auto-posted.`
2. `What happens if I don't approve a draft?` → current answer unchanged.
3. `What about negative reviews?` → `Guardian reads them first and grades severity; serious ones escalate straight to you. Drafts for 1–3★ reviews always wait for your approval — they are never auto-posted — and the tone defaults to acknowledging the issue and offering a path forward.`
4. `How does it learn my voice?` → current answer unchanged.
5. `What if the AI safety checks go down?` → `Auto-posting stops. The Judge's availability is a precondition for posting without your tap — if it can't review, pending auto-approved replies fall back to your normal approval queue.`
6. `Which review platforms do you support?` → current answer unchanged.

---

### Task 1: Features — extract `useReveal` and move the three unchanged sections to their own files

**Files:**
- Create: `src/components/sections/features/useReveal.ts`
- Create: `src/components/sections/features/FeatLang.tsx`
- Create: `src/components/sections/features/FeatVoice.tsx`
- Create: `src/components/sections/features/FeatRoi.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`

- [ ] **Step 1: Create `useReveal.ts`**

Move the `useReveal` hook (FeaturesContent.tsx lines 115–143) verbatim into the new file with:

```ts
import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export function useReveal<T extends HTMLElement>() {
  // …moved body unchanged…
}
```

- [ ] **Step 2: Create `FeatLang.tsx`, `FeatVoice.tsx`, `FeatRoi.tsx`**

For each, move the function + its module-level data verbatim and delete the `FeatureSection` wrapper by inlining a plain `<section>`:

- `FeatLang.tsx`: move `FEATURE_LANGS` (lines 72–79) and `FeatLang` (lines 624–723). Replace the `<FeatureSection innerRef={innerRef} id="f-lang" label="Multilingual support" className="…">` wrapper with `<section ref={innerRef} id="f-lang" aria-label="Multilingual support" className="…">` (same className). Change the `07` display: `<span className="rw-num-tag …">02</span>` → `07` (and the section keeps its existing colors). Imports: `'use client';`, `usePrefersReducedMotion`, `useReveal` from `./useReveal`, `type RefObject` from `react`. Export: `export function FeatLang({ innerRef }: { innerRef: RefObject<HTMLElement | null> })`.
- `FeatVoice.tsx`: move `VOICE_BARS` (88–97) and `FeatVoice` (838–911), same `<section>` inlining, number `04` → `08`.
- `FeatRoi.tsx`: move `FeatRoi` (1012–1141), same inlining, number `06` → `09`.

Each new file starts with `'use client';`.

- [ ] **Step 3: Rewire `FeaturesContent.tsx`**

Delete the moved code (`useReveal`, `FeatureSection`, `FEATURE_LANGS`, `VOICE_BARS`, the three section functions) and add imports:

```tsx
import { useReveal } from './useReveal';
import { FeatLang } from './FeatLang';
import { FeatVoice } from './FeatVoice';
import { FeatRoi } from './FeatRoi';
```

The remaining in-file sections (`FeatAi`, `FeatApprove`, `FeatBrief`, `FeatComp`) also lose their `FeatureSection` wrapper (inline `<section ref={innerRef} id=… aria-label=… className=…>`) since the helper is deleted.

- [ ] **Step 4: Verify the page still renders identically**

Run: `pnpm vitest run src/components/sections/features`
Expected: all existing tests PASS (content is unchanged in this task except the renumbered `07/08/09` digits, which no test asserts).

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/sections/features
git commit -m "refactor: split unchanged feature sections into files, extract useReveal"
```

---

### Task 2: Features — `FeatAi` → `FeatReply` with Reply-persona copy

**Files:**
- Create: `src/components/sections/features/FeatReply.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to the existing describe block:

```tsx
it('presents Reply as the drafting agent', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Reply · your drafter');
  expect(html).toContain('Reply is the drafting agent');
  expect(html).toContain('never</span> from a template');
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Reply · your drafter` not found)

Run: `pnpm vitest run src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 3: Create `FeatReply.tsx`**

Move `AI_REPLIES` (47–70) and `FeatAi` (525–622) into the file, rename the function to `FeatReply`, change `id="f-ai"` → `id="f-reply"`, `label="AI drafting"` → `label="Reply — the drafting agent"`, kicker text `The engine` → `Reply · your drafter`, and replace the body paragraph with the **01 Reply** copy block. The H2, number `01`, before/after tabs and both cards stay byte-identical.

- [ ] **Step 4: Rewire orchestrator**

In `FeaturesContent.tsx`: import `FeatReply`, delete the old in-file `FeatAi` + `AI_REPLIES`, render `<FeatReply innerRef={aiRef} />`, and update the `FEATURES` entry + `refMap` key from `f-ai` → `f-reply` (label `Reply`, sub `The drafter`). Update the `activeSection` initial state to `'f-reply'`.

- [ ] **Step 5: Run tests — expect PASS.** Then commit:

```bash
git add src/components/sections/features src/components/sections/features/__tests__
git commit -m "feat: reframe AI drafting section as the Reply agent"
```

---

### Task 3: Features — `FeatApprove` → `FeatGate` (channels + Copilot framing)

**Files:**
- Create: `src/components/sections/features/FeatGate.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('describes the Copilot gate with all three channels', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Copilot · your control');
  expect(html).toContain('email, Telegram, or WhatsApp');
  expect(html).toContain('Nothing is posted without your go-ahead');
});
```

Also update the existing `states only feature claims true to the system` test: replace the `expect(html).toContain('By default, nothing is posted without your go-ahead')` line with `expect(html).toContain('Nothing is posted without your go-ahead')` (the qualifier now lives on the Autopilot section instead).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `FeatGate.tsx`**

Move `APPROVAL_STEPS` (81–86) and `FeatApprove` (725–836), rename to `FeatGate`, `id="f-approve"` → `id="f-gate"`, `label="One-tap approval"` → `label="The gate — Copilot approval"`, kicker `Your control` → `Copilot · your control`, body paragraph → the **04 The Gate** copy block, `APPROVAL_STEPS[2]` → the updated step-3 title/sub from the copy block. Number display `03` → `04`. Phone artifact unchanged.

- [ ] **Step 4: Rewire orchestrator** (`f-approve` → `f-gate`, label `The Gate`, sub `Copilot`), run tests — expect PASS.

- [ ] **Step 5: Commit** — `feat: reframe approval section as the Copilot gate with channel choice`

---

### Task 4: Features — `FeatBrief` → `FeatInsights`

**Files:**
- Create: `src/components/sections/features/FeatInsights.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it('presents the weekly brief as the Insights agent', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Insights · every Monday');
  expect(html).toContain('Insights is the reporting agent');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Create `FeatInsights.tsx`** — move `BRIEF_MENTIONS` (99–104) + `FeatBrief` (913–1010), rename to `FeatInsights`, `id="f-brief"` → `id="f-insights"`, kicker `Every Monday morning` → `Insights · every Monday`, body paragraph → **03 Insights** copy block, number `05` → `03`. Brief artifact + `Every Monday`-adjacent strings elsewhere unchanged (the existing test's `Every Monday morning` assertion: update it to `Insights · every Monday`).

- [ ] **Step 4: Rewire orchestrator** (`f-brief` → `f-insights`, label `Insights`, sub `Mondays`; render order moves it to position 03 — see Task 8 for the final order). Run tests — PASS.

- [ ] **Step 5: Commit** — `feat: reframe weekly brief as the Insights agent`

---

### Task 5: Features — NEW `FeatGuardian`

**Files:**
- Create: `src/components/sections/features/FeatGuardian.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it('introduces Guardian triage and escalation without public actions', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Guardian · the negative lane');
  expect(html).toContain('Guardian never posts anything, anywhere');
  expect(html).toContain('Severity read');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Create `FeatGuardian.tsx`** (full file):

```tsx
'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

const GUARDIAN_STEPS = [
  { n: '01', title: '1★ review lands', sub: 'Negative lane — Guardian reads it first', t: '0:00', dark: false, d: '100ms' },
  { n: '02', title: 'Severity read', sub: 'Routine · elevated · critical — a bounded AI check', t: '+0:01', dark: false, d: '300ms' },
  { n: '03', title: 'Critical → escalation', sub: "You're notified with the full context", t: '+0:02', dark: false, d: '500ms' },
  { n: '04', title: 'You acknowledge and resolve', sub: 'Tracked until discharged · never auto-posted', t: '—', dark: true, d: '700ms' },
];

export function FeatGuardian({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [tlRef, tlSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-guardian"
      aria-label="Guardian — negative-review triage"
      className="px-8 md:px-16 py-20 bg-gradient-to-b from-white to-rw-cream/50 relative"
    >
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-12 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-rw-peach/80" aria-hidden="true">02</span>
        <div className="flex-1">
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Guardian · the negative lane</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight max-w-2xl">
            Bad reviews get read <span className="rw-display-serif text-rw-teal-strong">first</span>, not just answered.
          </h2>
          <p className="text-rw-ink-soft mt-4 max-w-xl leading-relaxed">
            Guardian triages every negative review by severity before anything is drafted. Routine
            gripes flow on to drafting; serious ones — health claims, legal threats, review-bombing —
            escalate straight to you with the context attached. Guardian never posts anything, anywhere.
          </p>
        </div>
      </div>

      <div ref={tlRef} className={`rw-reveal max-w-2xl ${tlSeen ? 'in' : ''}`}>
        <ol className="space-y-4">
          {GUARDIAN_STEPS.map((s) => (
            <li key={s.n} className="rw-t-step flex gap-4 items-start" style={{ ['--step-d' as string]: s.d }}>
              <div
                className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center rw-label-mono text-sm ${
                  s.dark ? 'bg-rw-ink text-white' : 'bg-rw-peach/25 text-rw-teal-strong'
                }`}
              >
                {s.n}
              </div>
              <div
                className={`flex-1 rounded-2xl p-4 border ${
                  s.dark ? 'bg-rw-ink text-white border-rw-ink' : 'bg-white text-rw-ink border-rw-teal/15'
                }`}
              >
                <p className="text-sm font-medium">{s.title}</p>
                <p className={`text-xs mt-0.5 ${s.dark ? 'opacity-80' : 'text-rw-ink-soft'}`}>{s.sub}</p>
              </div>
              <span className="rw-label-mono text-xs text-rw-ink-soft self-center">{s.t}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Rewire orchestrator** — add `guardianRef`, `f-guardian` in `FEATURES` (label `Guardian`, sub `Negative lane`) and `refMap`, render `<FeatGuardian innerRef={guardianRef} />` after `FeatReply`. Run tests — PASS.

- [ ] **Step 5: Commit** — `feat: add Guardian triage/escalation feature section`

---

### Task 6: Features — NEW `FeatAutopilot` (veto-window artifact)

**Files:**
- Create: `src/components/sections/features/FeatAutopilot.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it('describes Autopilot as bounded autonomy with a veto window', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Autopilot · bounded autonomy');
  expect(html).toContain('veto window');
  expect(html).toContain('Negative reviews are never auto-posted');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Create `FeatAutopilot.tsx`** (full file):

```tsx
'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

const POLICY_CHIPS = [
  { label: 'Rating band', value: '4–5★ only' },
  { label: 'Daily cap', value: '10 / day' },
  { label: 'Veto window', value: '15 min' },
];

export function FeatAutopilot({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-autopilot"
      aria-label="Autopilot — bounded autonomy"
      className="px-8 md:px-16 py-20 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={headRef} className={`rw-reveal from-left md:col-span-5 ${headSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-rw-teal/40 block mb-4" aria-hidden="true">05</span>
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Autopilot · bounded autonomy</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight mb-5">
            Hands-off, inside <span className="rw-display-serif text-rw-teal-strong">your</span> rules.
          </h2>
          <p className="text-rw-ink-soft max-w-md leading-relaxed">
            On Autopilot, replies to 4–5★ unflagged reviews can post themselves — but only inside a
            policy you set. You choose the rating band, the daily cap, and a veto window of 15 or 30
            minutes. Until the window closes, the reply is yours to stop with one tap. Negative
            reviews are never auto-posted.
          </p>
        </div>

        <div ref={cardRef} className={`rw-reveal from-right md:col-span-7 ${cardSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 md:p-8 border border-rw-teal/15 shadow-lg max-w-lg">
            <div className="flex items-center justify-between mb-5">
              <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">Queued auto-post · sample</p>
              <span className="rw-label-mono text-[10px] uppercase text-rw-ink-soft">policy matched</span>
            </div>

            <div className="rounded-2xl p-4 border border-rw-teal/25 mb-5" style={{ background: 'rgba(151,179,174,0.08)' }}>
              <p className="rw-label-mono text-[10px] uppercase text-rw-teal-strong mb-1">Reply · ready to post</p>
              <p className="text-sm text-rw-ink leading-relaxed">
                &ldquo;Thank you so much! We&apos;re thrilled the al pastor tacos hit the spot —
                looking forward to your next visit!&rdquo;
              </p>
            </div>

            <div className="flex items-center gap-5 mb-5">
              <div className="relative size-20 shrink-0" role="img" aria-label="Veto window: 14 minutes 32 seconds remaining">
                <svg viewBox="0 0 80 80" className="size-20 -rotate-90" aria-hidden>
                  <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(151,179,174,0.2)" strokeWidth="6" />
                  <circle
                    cx="40" cy="40" r="34" fill="none" stroke="#557069" strokeWidth="6"
                    strokeLinecap="round" strokeDasharray="213.6" strokeDashoffset="21"
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center rw-label-mono text-sm text-rw-ink">
                  14:32
                </span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-rw-ink">Posting when the window closes</p>
                <p className="text-xs text-rw-ink-soft mt-0.5">One tap stops it — nothing is final until then</p>
                <span className="mt-2 inline-flex items-center gap-1.5 py-1.5 px-4 rounded-full text-xs border border-rw-teal/30 text-rw-ink-soft select-none">
                  Veto this reply
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 pt-4 border-t border-rw-teal/10">
              {POLICY_CHIPS.map((c) => (
                <div key={c.label}>
                  <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">{c.label}</p>
                  <p className="text-sm font-medium text-rw-ink">{c.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

(The countdown ring is a static illustrative frame — no timer, so no reduced-motion branch is needed.)

- [ ] **Step 4: Rewire orchestrator** — add ref, `FEATURES` entry (label `Autopilot`, sub `Bounded autonomy`), render after `FeatGate`. Run tests — PASS.

- [ ] **Step 5: Commit** — `feat: add Autopilot bounded-autonomy section with veto-window artifact`

---

### Task 7: Features — NEW `FeatWatchdogs` (dark section, verdict ledger)

**Files:**
- Create: `src/components/sections/features/FeatWatchdogs.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it('explains the Judge and Governor watchdogs', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Judge &amp; Governor · oversight');
  expect(html).toContain('auto-posting stops');
  expect(html).toContain('Governor suspends');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Create `FeatWatchdogs.tsx`** (full file):

```tsx
'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

const VERDICT_ROWS = [
  { time: 'Mon 10:41', excerpt: '"Thank you so much! We\'re thrilled…"', verdict: 'pass' as const },
  { time: 'Mon 12:03', excerpt: '"So glad the mole landed — see you…"', verdict: 'pass' as const },
  { time: 'Tue 09:17', excerpt: '"We appreciate the shout-out about…"', verdict: 'pass' as const },
  { time: 'Tue 14:52', excerpt: '"Glad Saturday worked out — the…"', verdict: 'flag' as const },
];

export function FeatWatchdogs({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [ledgerRef, ledgerSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-watchdogs"
      aria-label="Judge and Governor — oversight"
      className="px-8 md:px-16 py-20 bg-rw-ink text-white relative overflow-hidden"
    >
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.6) 1px, transparent 1.5px)',
          backgroundSize: '3px 3px',
        }}
        aria-hidden
      />
      <div className="relative grid md:grid-cols-12 gap-10 items-start">
        <div ref={headRef} className={`rw-reveal md:col-span-5 ${headSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-white/20 block mb-4" aria-hidden="true">06</span>
          <p className="rw-label-mono text-xs uppercase text-rw-peach mb-3">Judge &amp; Governor · oversight</p>
          <h2 className="text-4xl md:text-5xl font-medium leading-tight mb-4">
            Autonomy that is watched, <span className="rw-display-serif text-rw-peach">always</span>.
          </h2>
          <p className="text-white/70 max-w-md leading-relaxed">
            Every reply that posts without your tap is reviewed by the Judge — an independent AI
            check on 100% of Autopilot&apos;s public actions. If the Judge is unavailable,
            auto-posting stops on its own. And if verdicts slip, the Governor suspends that
            account&apos;s autonomy and tells you. Trust is earned per account, never assumed.
          </p>
        </div>

        <div ref={ledgerRef} className={`rw-reveal md:col-span-7 ${ledgerSeen ? 'in' : ''}`}>
          <div className="rounded-3xl border border-white/15 bg-white/5 p-6">
            <div className="flex items-center justify-between mb-4">
              <p className="rw-label-mono text-xs uppercase text-white/60">Judge verdicts · sample week</p>
              <span className="rw-label-mono text-[10px] uppercase text-rw-peach">100% of auto-posts</span>
            </div>
            <div className="space-y-2">
              {VERDICT_ROWS.map((r) => (
                <div key={r.time} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-sm">
                  <span className="rw-label-mono text-[10px] text-white/50 w-20 shrink-0">{r.time}</span>
                  <span className="flex-1 text-white/85 truncate">{r.excerpt}</span>
                  <span
                    className={`rw-label-mono text-[10px] uppercase px-2 py-0.5 rounded-full ${
                      r.verdict === 'pass'
                        ? 'bg-rw-teal/25 text-white'
                        : 'bg-rw-peach/25 text-rw-peach'
                    }`}
                  >
                    {r.verdict === 'pass' ? 'Pass' : 'Flagged'}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-white/10 flex items-center gap-3">
              <span className="size-2 rounded-full bg-rw-peach shrink-0" aria-hidden />
              <p className="text-xs text-white/70">
                Flagged verdict → the Governor suspends autonomy for this account and notifies the owner.
                Replies go back to your approval queue.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Rewire orchestrator** — add ref, `FEATURES` entry (label `Watchdogs`, sub `Judge & Governor`), render after `FeatAutopilot`. Run tests — PASS.

- [ ] **Step 5: Commit** — `feat: add Judge and Governor watchdogs section`

---

### Task 8: Features — roadmap band, hero rewrite, grouped TOC, metadata, final order + test sweep

**Files:**
- Create: `src/components/sections/features/RoadmapBand.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Modify: `src/app/(public)/features/page.tsx`
- Test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`

- [ ] **Step 1: Update the test file for hero/TOC/roadmap claims**

Replace the now-stale assertions in `FeaturesContent.test.tsx`:
- In `describes the feature count honestly…`: rename the test to `describes the lineup honestly (agents, watchdogs, modes)` and assert `expect(html).toContain('3 agents · 2 watchdogs · 2 modes')`, `expect(html).not.toContain('Six features today')`, `expect(html).not.toContain('6 live · 1 in testing')`.
- Add:

```tsx
it('leads with the trusted-autonomy narrative', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('tireless');
  expect(html).toContain('gate.');
  expect(html).toContain('Your agent team');
  expect(html).toContain('Care and control');
  expect(html).toContain('Craft and proof');
});

it('keeps roadmap items as verb phrases, not shipped claims', () => {
  const html = renderToStaticMarkup(createElement(FeaturesContent));
  expect(html).toContain('Get reviews · Flag fakes · Watch everywhere');
  expect(html).toContain('Coming soon');
  expect(html).toContain('preview');
});
```

- The existing `keeps the competitor feature labeled as not-yet-released` test stays as-is (roadmap band keeps `Coming soon` + `preview`).

- [ ] **Step 2: Run — expect the new tests to FAIL.**

- [ ] **Step 3: Create `RoadmapBand.tsx`**

Move `COMPETITOR_ROWS` (106–113) + the right-column scorecard JSX from `FeatComp` (the `div` with the `preview` badge and `COMPETITOR_ROWS.map`, lines 1170–1211) verbatim into the new file. Replace `FeatComp`'s left column with the roadmap copy; the section is unnumbered (no `07` num-tag):

```tsx
'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

// COMPETITOR_ROWS moved verbatim here

export function RoadmapBand({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  return (
    <section ref={innerRef} id="f-roadmap" aria-label="What the agent takes on next" className="px-8 md:px-16 py-20 bg-rw-cream/40 relative">
      <div className="grid md:grid-cols-12 gap-10 items-center">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-6 ${leftSeen ? 'in' : ''}`}>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">What&apos;s next</p>
            <span className="inline-block w-px h-4 bg-rw-teal/30" />
            <p className="rw-label-mono text-xs uppercase text-rw-ink-soft">Coming soon</p>
          </div>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight mb-5">
            The same agent, <span className="rw-display-serif text-rw-teal-strong">reaching</span> further.
          </h2>
          <p className="rw-label-mono text-sm uppercase tracking-wider text-rw-teal-strong mb-4">
            Get reviews · Flag fakes · Watch everywhere
          </p>
          <p className="text-rw-ink-soft max-w-md leading-relaxed">
            Today RepWorth minds your Google reviews. The roster above is what the agent takes on
            next — including the neighborhood scorecard already in private testing.
          </p>
        </div>
        {/* right column: moved scorecard card, ref/class names unchanged */}
        <div ref={rightRef} className={`rw-reveal from-right md:col-span-6 ${rightSeen ? 'in' : ''}`}>
          {/* …moved scorecard JSX verbatim… */}
        </div>
      </div>
    </section>
  );
}
```

Delete `FeatComp` from the orchestrator.

- [ ] **Step 4: Rewrite the orchestrator's hero, TOC, and order**

In `FeaturesContent.tsx`:

```tsx
const FEATURES = [
  { id: 'f-reply',     n: '01', label: 'Reply',      sub: 'The drafter',       group: 'Your agent team' },
  { id: 'f-guardian',  n: '02', label: 'Guardian',   sub: 'Negative lane',     group: 'Your agent team' },
  { id: 'f-insights',  n: '03', label: 'Insights',   sub: 'Mondays',           group: 'Your agent team' },
  { id: 'f-gate',      n: '04', label: 'The Gate',   sub: 'Copilot',           group: 'Care and control' },
  { id: 'f-autopilot', n: '05', label: 'Autopilot',  sub: 'Bounded autonomy',  group: 'Care and control' },
  { id: 'f-watchdogs', n: '06', label: 'Watchdogs',  sub: 'Judge & Governor',  group: 'Care and control' },
  { id: 'f-lang',      n: '07', label: 'Languages',  sub: 'Reach',             group: 'Craft and proof' },
  { id: 'f-voice',     n: '08', label: 'Voice',      sub: 'Over time',         group: 'Craft and proof' },
  { id: 'f-roi',       n: '09', label: 'ROI',        sub: 'Proof',             group: 'Craft and proof' },
];

const HERO_WORDS_LINE_1 = ['A', 'tireless', 'agent', 'answers', 'every', 'review.'];
const HERO_WORDS_LINE_2 = ['Nothing', 'goes', 'public', 'without', 'the'];
const HERO_SERIF_WORD = 'gate.';
```

Hero JSX: line 2 renders `HERO_WORDS_LINE_2` as plain words then `HERO_SERIF_WORD` as the serif-accented span (delay continues the sequence). Kicker text → `Features · Your agent team`. Lede → the hero-lede copy block.

`FeatureTOC`: render three group rows — for each group label, a mono kicker line then a chip grid of that group's entries (chip markup unchanged; grid becomes `grid-cols-2 md:grid-cols-3` per row). Index label → `3 agents · 2 watchdogs · 2 modes`.

Render order: `FeatReply, FeatGuardian, FeatInsights, FeatGate, FeatAutopilot, FeatWatchdogs, FeatLang, FeatVoice, FeatRoi, RoadmapBand`. Refs: add `roadmapRef` (not in `FEATURES`/dot-nav — the band is unnumbered). CTA kicker → `Early access`.

- [ ] **Step 5: Update `src/app/(public)/features/page.tsx`** metadata description to the copy block value.

- [ ] **Step 6: Full features test run**

Run: `pnpm vitest run src/components/sections/features && pnpm typecheck`
Expected: PASS. Fix any stale-string assertions the sweep surfaces (the old copy must be gone: `Six features today`, `done-for-you service`, `Everything', 'your', 'reviews`).

- [ ] **Step 7: Commit** — `feat: features page tells the two-tier agent story (hero, grouped TOC, roadmap band)`

---

### Task 9: How-it-works — extract `Reveal` + move the four existing artifacts to files

**Files:**
- Create: `src/components/sections/how-it-works/Reveal.tsx`
- Create: `src/components/sections/how-it-works/WatchArtifact.tsx`
- Create: `src/components/sections/how-it-works/DraftArtifact.tsx`
- Create: `src/components/sections/how-it-works/CopilotGateCard.tsx`
- Create: `src/components/sections/how-it-works/PostArtifact.tsx`
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx`

- [ ] **Step 1: Create the files (verbatim moves, renames only)**

- `Reveal.tsx`: move `Reveal` (HowItWorksContent.tsx lines 34–62) + its `ReactNode` import; `export function Reveal…`. Add `'use client';`.
- `WatchArtifact.tsx`: move `STEP1_ROWS`, `STEP1_COLORS`, `Step1Artifact` (66–116); rename function to `WatchArtifact`.
- `DraftArtifact.tsx`: move `Step2Artifact` (118–193); rename to `DraftArtifact`.
- `CopilotGateCard.tsx`: move `Step3Artifact` (195–308); rename to `CopilotGateCard` (it becomes the Copilot half of the gate fork in Task 11).
- `PostArtifact.tsx`: move `Step4Artifact` (310–368); rename to `PostArtifact`.

Each file: `'use client';` + the imports its body needs (`usePrefersReducedMotion`, react hooks).

- [ ] **Step 2: Rewire `HowItWorksContent.tsx`** — import the five, point the `STEPS` array's `Artifact` fields at the renamed components, delete moved code.

- [ ] **Step 3: Verify**

Run: `pnpm vitest run src/components/sections/how-it-works && pnpm typecheck`
Expected: all 3 existing tests PASS (no content changed).

- [ ] **Step 4: Commit** — `refactor: split how-it-works artifacts into files, extract Reveal`

---

### Task 10: How-it-works — NEW `TriageArtifact` + NEW `JudgeArtifact`

**Files:**
- Create: `src/components/sections/how-it-works/TriageArtifact.tsx`
- Create: `src/components/sections/how-it-works/JudgeArtifact.tsx`

(Wired into the page in Task 12 — these are standalone components in this task; the failing/passing test cycle happens in Task 12 where they render.)

- [ ] **Step 1: Create `TriageArtifact.tsx`** (full file — reuses `hiw-artifact`, `hiw-receipt` classes from `globals.css`):

```tsx
'use client';

export function TriageArtifact() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" style={{ background: '#F2C3B9', boxShadow: '0 0 0 4px rgba(242,195,185,0.2)' }} />
        <span>Guardian triage · negative lane</span>
        <span className="hiw-artifact-cap-tail">~1 sec</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-draft-src">
          <div className="hiw-draft-src-meta">
            Input · 2★ review ·{' '}
            <span aria-label="2 out of 5 stars">
              <span aria-hidden="true">★★</span>
              <span aria-hidden="true" style={{ color: '#e5e5e5' }}>★★★</span>
            </span>
          </div>
          Waited forty minutes for a pickup that was promised in ten. Nobody at the counter could
          tell me where my order was.
        </div>
        <div className="hiw-receipt" style={{ marginTop: 14 }}>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Severity</span>
            <span className="hiw-receipt-val">
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#F2C3B9', display: 'inline-block' }} />
              Elevated
            </span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Route</span>
            <span className="hiw-receipt-val">Draft with care</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">If critical</span>
            <span className="hiw-receipt-val">Escalate to owner</span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `JudgeArtifact.tsx`** (full file):

```tsx
'use client';

export function JudgeArtifact() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Judge review · after auto-post</span>
        <span className="hiw-artifact-cap-tail">43 sec after posting</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-draft-out" style={{ marginBottom: 14 }}>
          <span className="hiw-draft-badge">Auto-posted reply · under review</span>
          <p>
            Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
            because we know your schedule doesn&apos;t wait for ours. See you again soon.
          </p>
        </div>
        <div className="hiw-receipt">
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Verdict</span>
            <span className="hiw-receipt-val">
              <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#97B3AE', display: 'inline-block' }} />
              Pass
            </span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Coverage</span>
            <span className="hiw-receipt-val">100% of auto-posts</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Governor</span>
            <span className="hiw-receipt-val">Autonomy active</span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck only** (not rendered anywhere yet): `pnpm typecheck` — expect clean.

- [ ] **Step 4: Commit** — `feat: add Triage and Judge step artifacts for how-it-works`

---

### Task 11: How-it-works — `GateArtifact` (the fork)

**Files:**
- Create: `src/components/sections/how-it-works/GateArtifact.tsx`
- Modify: `src/components/sections/how-it-works/CopilotGateCard.tsx` (caption tweak only)

- [ ] **Step 1: Create `GateArtifact.tsx`** (full file):

```tsx
'use client';

import { CopilotGateCard } from './CopilotGateCard';

function AutopilotGateCard() {
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span className="hiw-artifact-cap-dot" />
        <span>Autopilot · policy check + veto window</span>
        <span className="hiw-artifact-cap-tail">posting in 14:32</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-receipt" style={{ marginBottom: 14 }}>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Policy</span>
            <span className="hiw-receipt-val">4–5★ · unflagged</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Daily cap</span>
            <span className="hiw-receipt-val">3 of 10 used</span>
          </div>
          <div className="hiw-receipt-cell">
            <span className="hiw-receipt-lbl">Veto window</span>
            <span className="hiw-receipt-val">15 min</span>
          </div>
        </div>
        <div className="hiw-draft-out">
          <span className="hiw-draft-badge">Cleared to post · one tap stops it</span>
          <p>
            Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
            because we know your schedule doesn&apos;t wait for ours. See you again soon.
          </p>
        </div>
        <div className="hiw-email-actions" style={{ marginTop: 14 }}>
          <button type="button" className="hiw-btn hiw-btn-ghost">Veto this reply</button>
        </div>
      </div>
    </div>
  );
}

export function GateArtifact() {
  return (
    <div style={{ display: 'grid', gap: 16 }} className="hiw-gate-fork">
      <div>
        <p className="hiw-eyebrow" style={{ marginBottom: 8 }}>Copilot — you approve</p>
        <CopilotGateCard />
      </div>
      <div>
        <p className="hiw-eyebrow" style={{ marginBottom: 8 }}>Autopilot — your policy approves</p>
        <AutopilotGateCard />
      </div>
    </div>
  );
}
```

(Stacked on all viewports via the grid default; the two labeled halves make the fork legible without new CSS. If `hiw-eyebrow` renders too large in context, use `rw-label-mono text-xs uppercase` equivalents already available — resolve visually at implementation, no new globals.css entries.)

- [ ] **Step 2: In `CopilotGateCard.tsx`**, change the email subject line `New 5★ review from Sarah L., ready to approve` — unchanged — but update the footer line `One-tap · no login` to `One tap · email, Telegram, or WhatsApp`.

- [ ] **Step 3: `pnpm typecheck`** — clean.

- [ ] **Step 4: Commit** — `feat: add gate-fork artifact (Copilot approval vs Autopilot veto window)`

---

### Task 12: How-it-works — orchestrator rewrite (6 steps, hero, hood, guarantees, FAQ, metadata) + test sweep

**Files:**
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx`
- Modify: `src/app/(public)/how-it-works/page.tsx`
- Test: `src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`

- [ ] **Step 1: Update the content test first**

In `HowItWorksContent.test.tsx`, extend `states only claims true to the system`:

```tsx
// kept claims
expect(html).toContain('Multi-location supported on Copilot and Autopilot');
// new pipeline claims
expect(html).toContain('Guardian reads it before anyone answers.');
expect(html).toContain('Copilot asks you. Autopilot asks your policy.');
expect(html).toContain('Every auto-post gets a second opinion.');
expect(html).toContain('Negative reviews are never auto-posted');
expect(html).toContain('of auto-posts judged');
// stale claims gone
expect(html).not.toContain('Four steps from new review');
expect(html).not.toContain('15 hrs');
expect(html).not.toContain('saved weekly');
expect(html).not.toContain('just four well-behaved services');
```

- [ ] **Step 2: Run — FAIL.**

Run: `pnpm vitest run src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`

- [ ] **Step 3: Rewrite the orchestrator's data + hero**

In `HowItWorksContent.tsx`, using the **How-it-works copy blocks** above verbatim:
- Imports: `WatchArtifact`, `TriageArtifact`, `DraftArtifact`, `GateArtifact`, `PostArtifact`, `JudgeArtifact`, `Reveal`.
- `STEPS` becomes 6 entries — colors `#D2E0D3`, `#F2C3B9`, `#F0DDD6`, `#D6CBBF`, `#D2E0D3`, `#F0DDD6`; ticks `T + 0:00`, `T + 0:01`, `T + 0:12`, `T + 0:20`, `T + 1:04`, `T + 1:47`; kickers `Watch`, `Triage`, `Draft`, `The Gate`, `Post`, `Judge`; titles/subs/bullets from the copy block; `Artifact` fields point at the six components.
- Hero H1/lead/meta strip from the copy block (4 meta items: `~5 min`/`safety-net poll`, `30 sec`/`your time per reply`, `15/30 min`/`veto window on Autopilot`, `100%`/`of auto-posts judged`). Keep the illustrative note.
- `OVERVIEW` becomes the 6 cells from the copy table. Reuse the existing four glyph SVGs for cells 01/03/04(gate uses the old mail glyph)/05; for Triage use the shield path already in `GUARANTEES[0]`'s icon; for Judge reuse the existing check `IconCheck` path scaled to 18px (`<polyline points="20 6 9 17 4 12" />`). The overview grid class stays; 6 cells wrap naturally.
- `HOOD` becomes the 6 nodes from the copy table (colors: reuse the 4 existing + repeat `#D2E0D3`, `#F2C3B9`; glyphs: `⏱ ⚑ ✎ ✋ ↗ ⚖`).
- `GUARANTEES` → the 3 updated cards from the copy block (icons unchanged).
- `FAQ_ITEMS` → the 6 items from the copy block.
- `SECTIONS` labels → `Overview`, `The pipeline`, `Under the hood`, `FAQ`, `Join waitlist`.
- Steps section header → eyebrow `The pipeline`, H2 `Six steps from new review to public reply.`
- Under-the-hood lead → `A webhook, a triage read, a voice model, a gate, a posting call, and a judge. Six well-behaved services — and two of them exist only to say no.`

- [ ] **Step 4: Update `src/app/(public)/how-it-works/page.tsx`** metadata description per copy block.

- [ ] **Step 5: Run all how-it-works tests**

Run: `pnpm vitest run src/components/sections/how-it-works`
Expected: PASS — including `HowItWorksContent.client.test.tsx` unchanged (the `hiw-guarantees` block and its `<Reveal delay={120}>` wrapper, the section-nav observer with 4 thresholds, and reveal thresholds all survive the rewrite; do not change those structural attributes).

- [ ] **Step 6: Commit** — `feat: how-it-works tells the six-step forked-gate pipeline`

---

### Task 13: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. (`pnpm test` covers both pages' suites plus the repo's other unit tests; nothing outside these two page trees was touched.)

- [ ] **Step 2: Visual sanity pass**

Run: `pnpm dev` and eyeball `http://localhost:3000/features` and `http://localhost:3000/how-it-works` — check: grouped TOC renders 3 rows; dot nav has 9 entries and tracks scroll; the two dark sections (Watchdogs, Voice) are separated by Languages; the gate fork reads as two labeled halves; reduced-motion (OS setting or DevTools emulation) still shows all content.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/marketing-pages-agentic-refresh
gh pr create --title "feat: features + how-it-works agentic-platform refresh" --body "$(cat <<'EOF'
Rewrites /features and /how-it-works around the two-tier agent narrative
(Copilot/Autopilot, Reply/Guardian/Insights, Judge/Governor), per the spec
docs/superpowers/specs/2026-07-22-marketing-pages-agentic-refresh-design.md.

- Features: 9 grouped sections + roadmap band; new Guardian, Autopilot
  (veto-window artifact), Watchdogs (verdict ledger) sections
- How-it-works: 6-step pipeline with the Copilot/Autopilot gate fork
- Both oversized components split into per-section files
- Content tests updated; brand guardrails (illustrative data, no
  auto-posted negatives claim) asserted

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01HuWk4Jxx4ub47UoVd4KMNL
EOF
)"
```

Expected: pre-push hook (lint, typecheck, CI audits, affected tests) passes; PR opens with CI running.
