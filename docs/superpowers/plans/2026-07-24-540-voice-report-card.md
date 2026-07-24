# Voice Report Card (ticket #540) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production Voice Report Card — an owner-facing section on `/settings/voice` reporting the five evidenced register traits voice learning inferred from the owner's draft→edit pairs, with the N-of-5 activation state. Deterministic derivation, no new data collection.

**Architecture:** Deepen `voice-learning.ts` with `getVoiceCorpusStatus` (one query, one owner of corpus semantics; `getApprovedResponsePairs` delegates to it). Add one new deep module `voice-report-card.ts`: pure function `deriveVoiceReportCard(examples)` hiding all five heuristics + the detection bar. A thin sibling route `GET /api/settings/voice/report-card` composes the two; a client component `VoiceReportCard` renders below `BrandVoicePanel`, driven by the existing location selector.

**Tech Stack:** Next.js route handler + Vitest (existing idioms only — no new deps).

**Intake contract:** `.feature/intake.json` (committed copy `docs/superpowers/plans/feat-540-voice-report-card-intake.json`). Glossary terms: **Voice Report Card**, **Register trait** (Task 5 adds them to `CONTEXT.md`).

**Locked decisions (grilling 2026-07-24):** deterministic heuristics computed on read; undetected traits omitted (zero-trait fallback line); corpus = exactly `getApprovedResponsePairs`' 5 pairs; new sibling route; card follows the location selector below the Brand Voice panel; no flag/tier gate; detection bar = strict majority of applicable pairs AND ≥2 conforming, Critical reviews exempted to ≥1 negative pair (star ≤2 via `classifySentiment`) with claim scoped to its evidence.

**Interface contract (shared by all tasks):**

```ts
// voice-learning.ts (deepened)
export interface VoiceCorpusStatus {
  editedCount: number;          // 0..10 (LIMIT 10 window; UI caps display at 5)
  examples: VoiceExample[];     // [] below MIN_EXAMPLES_FOR_ACTIVATION, else exactly 5, most-recent-first
}
export async function getVoiceCorpusStatus(sql: Sql, businessId: string): Promise<VoiceCorpusStatus>
export async function getApprovedResponsePairs(sql: Sql, businessId: string): Promise<VoiceExample[]> // delegates

// voice-report-card.ts (new)
export type RegisterTraitKey = 'greeting' | 'length' | 'signoff' | 'point_of_view' | 'critical';
export interface TraitSnippet { before: string; after: string }
export interface RegisterTrait { key: RegisterTraitKey; name: string; claim: string; snippet: TraitSnippet }
export interface VoiceReportCardData { traits: RegisterTrait[]; fallbackSnippet: TraitSnippet | null }
export function deriveVoiceReportCard(examples: VoiceExample[]): VoiceReportCardData
// PRECONDITION: examples are most-recent-first (as returned by getVoiceCorpusStatus).
// examples.length === 0 → { traits: [], fallbackSnippet: null }.
// fallbackSnippet is non-null ONLY when examples exist and zero traits detected.

// GET /api/settings/voice/report-card?locationId=<uuid> response (200):
// { locationId, activationThreshold: 5, editedCount, activated, traits, fallbackSnippet }
// 400 missing/invalid locationId · 404 foreign/archived location · auth failures per requireOwnerWithAccount
```

---

### Task 1: Deepen voice-learning with getVoiceCorpusStatus

**Files:**
- Modify: `src/lib/responses/voice-learning.ts`
- Test (create): `src/lib/responses/__tests__/voice-learning.test.ts`

- [ ] **Step 1: Write the failing tests** (titles VERBATIM — promised-tests gate checks them)

```ts
// src/lib/responses/__tests__/voice-learning.test.ts
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { getVoiceCorpusStatus, getApprovedResponsePairs } from '../voice-learning';
import { deriveVoiceReportCard } from '../voice-report-card';

interface CorpusRow { original_draft_text: string; edited_text: string; star_rating: number }

function fakeSql(rows: CorpusRow[]): Sql {
  return ((..._args: unknown[]) => Promise.resolve(rows)) as unknown as Sql;
}

function row(i: number, star = 5): CorpusRow {
  return { original_draft_text: `Dear customer, draft number ${i} thanks you kindly.`, edited_text: `Hi — thanks! (${i})`, star_rating: star };
}

const BUSINESS_ID = 'b0000000-0000-4000-8000-000000000001';

describe('getVoiceCorpusStatus', () => {
  it('returns no traits and editedCount below activation threshold', async () => {
    const status = await getVoiceCorpusStatus(fakeSql([row(1), row(2), row(3)]), BUSINESS_ID);
    expect(status.editedCount).toBe(3);
    expect(status.examples).toEqual([]);
    expect(deriveVoiceReportCard(status.examples)).toEqual({ traits: [], fallbackSnippet: null });
  });

  it('reports edited-reply count for the progress state', async () => {
    const status = await getVoiceCorpusStatus(fakeSql([row(1), row(2), row(3), row(4)]), BUSINESS_ID);
    expect(status.editedCount).toBe(4);
    expect(status.examples).toEqual([]);
  });

  it('returns exactly 5 most-recent examples once activated', async () => {
    const status = await getVoiceCorpusStatus(fakeSql([row(1), row(2), row(3), row(4), row(5), row(6), row(7)]), BUSINESS_ID);
    expect(status.editedCount).toBe(7);
    expect(status.examples).toHaveLength(5);
    expect(status.examples[0]).toEqual({ originalDraft: row(1).original_draft_text, editedVersion: row(1).edited_text, reviewStarRating: 5 });
  });

  it('getApprovedResponsePairs delegates to getVoiceCorpusStatus', async () => {
    const pairs = await getApprovedResponsePairs(fakeSql([row(1), row(2), row(3), row(4), row(5)]), BUSINESS_ID);
    expect(pairs).toHaveLength(5);
  });
});
```

Note: the first test imports `deriveVoiceReportCard` — Task 2 creates it. Run Tasks 1+2 red phases together OR stub the import last. Simplest honest order: write this file, expect the suite to fail on the missing module too; Task 2 turns it green. (Tasks 1 and 2 are one blocking chain: Task 2 blocks on Task 1's types only.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/responses/__tests__/voice-learning.test.ts` → FAIL (`getVoiceCorpusStatus` not exported; `../voice-report-card` unresolved).

- [ ] **Step 3: Implement** — replace the body of `voice-learning.ts` (keep the file-top doc comment style; same single query, now owned by `getVoiceCorpusStatus`):

```ts
import type { Sql } from 'postgres';
import type { VoiceExample } from './types';

const MIN_EXAMPLES_FOR_ACTIVATION = 5;

export interface VoiceCorpusStatus {
  /** Posted, owner-edited replies visible in the LIMIT-10 corpus window. */
  editedCount: number;
  /** [] below activation; else exactly the 5 most-recent pairs the prompt path uses. */
  examples: VoiceExample[];
}

/**
 * Single owner of voice-corpus selection semantics.
 *
 * Returns the activation count plus the exact few-shot pairs the prompt
 * path consumes. examples stays [] until the business has at least 5
 * posted responses where the owner made edits — the voice hook activates
 * naturally as customers use the product.
 *
 * Uses the idx_responses_voice partial index:
 *   WHERE status = 'posted' AND edited_text IS NOT NULL
 */
export async function getVoiceCorpusStatus(
  sql: Sql,
  businessId: string,
): Promise<VoiceCorpusStatus> {
  const rows = await sql<{
    original_draft_text: string;
    edited_text: string;
    star_rating: number;
  }[]>`
    SELECT resp.original_draft_text, resp.edited_text, r.star_rating
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.business_id = ${businessId}
      AND resp.status = 'posted'
      AND resp.edited_text IS NOT NULL
    ORDER BY resp.posted_at DESC
    LIMIT 10
  `;

  if (rows.length < MIN_EXAMPLES_FOR_ACTIVATION) {
    return { editedCount: rows.length, examples: [] };
  }

  return {
    editedCount: rows.length,
    examples: rows.slice(0, 5).map((row) => ({
      originalDraft: row.original_draft_text,
      editedVersion: row.edited_text,
      reviewStarRating: row.star_rating,
    })),
  };
}

/** Few-shot voice examples for the prompt path. Delegates to getVoiceCorpusStatus. */
export async function getApprovedResponsePairs(
  sql: Sql,
  businessId: string,
): Promise<VoiceExample[]> {
  return (await getVoiceCorpusStatus(sql, businessId)).examples;
}
```

- [ ] **Step 4: Verify green after Task 2** (this suite goes fully green once `voice-report-card.ts` exists). Typecheck now: `pnpm typecheck` on everything except the missing-module import is not possible — so proceed to Task 2 before committing.

- [ ] **Step 5: Commit (with Task 2)** — single commit `feat(540): voice corpus status + report-card derivation (T1+T2)`.

---

### Task 2: voice-report-card derivation module (the deep module)

**Files:**
- Create: `src/lib/responses/voice-report-card.ts`
- Test (create): `src/lib/responses/__tests__/voice-report-card.test.ts`

Detection bar (intake invariant, applies everywhere): `conforming ≥ 2 AND conforming * 2 > applicable`; Critical reviews: applicable = negative pairs (star ≤2 via `classifySentiment`), detects at ≥1 meaningful negative pair, claim scoped when only 1. Pairs with `originalDraft.trim() === editedVersion.trim()` are never conforming.

- [ ] **Step 1: Write the failing tests** (titles VERBATIM)

```ts
// src/lib/responses/__tests__/voice-report-card.test.ts
import { describe, it, expect } from 'vitest';
import type { VoiceExample } from '../types';
import { deriveVoiceReportCard } from '../voice-report-card';

function pair(originalDraft: string, editedVersion: string, reviewStarRating = 5): VoiceExample {
  return { originalDraft, editedVersion, reviewStarRating };
}

const FORMAL_DRAFT = 'Dear Amanda, thank you so much for taking the time to share your wonderful feedback with us today.';
const CASUAL_EDIT = 'Hi Amanda — thanks so much! See you next week. — Maria';

describe('deriveVoiceReportCard', () => {
  it('derives greeting trait only when a strict majority of pairs conform', () => {
    const conformingThree = [
      pair(FORMAL_DRAFT, 'Hi Amanda — thanks!'),
      pair('Dear Tom, we appreciate your feedback.', 'Hi Tom — glad it landed.'),
      pair('Dear Rosa, we are so happy to hear this.', 'Hi Rosa — you made our day.'),
      pair('Dear Priya, thank you for your kind words.', 'Priya, the buns sell out for a reason.'),
      pair('Dear Derek, we sincerely apologize.', 'Derek, that one is on me.'),
    ];
    const detected = deriveVoiceReportCard(conformingThree);
    expect(detected.traits.map((t) => t.key)).toContain('greeting');

    const conformingTwo = [
      pair(FORMAL_DRAFT, 'Hi Amanda — thanks!'),
      pair('Dear Tom, we appreciate your feedback.', 'Hi Tom — glad it landed.'),
      pair('Dear Rosa, we are so happy.', 'Rosa — you made our day.'),
      pair('Dear Priya, thank you kindly.', 'Priya, the buns sell out for a reason.'),
      pair('Dear Derek, we apologize.', 'Derek, that one is on me.'),
    ];
    expect(deriveVoiceReportCard(conformingTwo).traits.map((t) => t.key)).not.toContain('greeting');
  });

  it('omits critical-reviews trait when no negative pairs exist', () => {
    const allPositive = Array.from({ length: 5 }, () => pair(FORMAL_DRAFT, CASUAL_EDIT, 5));
    expect(deriveVoiceReportCard(allPositive).traits.map((t) => t.key)).not.toContain('critical');
  });

  it('detects critical-reviews trait from a single negative pair with evidence-scoped claim', () => {
    const examples = [
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
      pair(
        'Dear Derek, we sincerely apologize for any inconvenience you may have experienced during your recent visit to our establishment.',
        'Derek, I am sorry — a 20-minute wait is not okay. Next one is on the house.',
        2,
      ),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 4),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
      pair(FORMAL_DRAFT, CASUAL_EDIT, 5),
    ];
    const critical = deriveVoiceReportCard(examples).traits.find((t) => t.key === 'critical');
    expect(critical).toBeDefined();
    expect(critical!.claim).toContain('2-star');       // scoped to its single evidence pair
    expect(critical!.claim).not.toMatch(/critical reviews you/i); // no generalized register claim off one example
    expect(critical!.snippet.after).toContain('Derek');
  });

  it("every detected trait's snippet comes from a conforming pair", () => {
    const examples = [
      pair('Dear Amanda, thank you so much for taking the time to share your wonderful feedback with us today and always.', 'Hi Amanda — thanks so much!'),
      pair('Dear Tom, we appreciate your feedback about the seating situation on weekends.', 'Hi Tom — glad the flat white landed.'),
      pair('Dear Rosa, we are so happy to hear that our team made your morning special.', 'Hi Rosa — I read your review to the crew.'),
      pair('Dear Priya, thank you for your kind words about our pastries and atmosphere.', 'Hi Priya — the cardamom buns sell out by 10am.'),
      pair('Dear Derek, we sincerely apologize for any inconvenience you may have experienced.', 'Hi Derek — that wait was not okay.'),
    ];
    const { traits } = deriveVoiceReportCard(examples);
    expect(traits.length).toBeGreaterThan(0);
    for (const trait of traits) {
      const source = examples.find(
        (p) => p.originalDraft.startsWith(trait.snippet.before.slice(0, 12)) || trait.snippet.before.includes('words')
          ? true
          : false,
      );
      expect(source).toBeDefined();
      // Every snippet's after-text must appear in some pair's edited version:
      const afterCore = trait.snippet.after.replace(/[…]|\(\d+ words\)/g, '').trim().slice(0, 12);
      expect(examples.some((p) => p.editedVersion.includes(afterCore) || afterCore.startsWith('—'))).toBe(true);
    }
  });

  it('returns zero traits with activation when no heuristic clears the bar', () => {
    // 5 meaningful edits with no consistent pattern: mixed greetings, mixed
    // lengths (some longer), no sign-offs, we-voice edits, no negative stars.
    const examples = [
      pair('Thanks for visiting us.', 'We appreciate you taking the time to leave such a detailed and thoughtful review of your visit.'),
      pair('Hello there, thank you kindly for the review.', 'Thanks.'),
      pair('We appreciate the feedback.', 'We hear you and we are working on the weekend seating suggestions you mentioned.'),
      pair('Thank you for the five stars.', 'Much appreciated from all of us on the morning team here.'),
      pair('We are glad you enjoyed it.', 'Our whole crew says thanks for this one.'),
    ];
    const result = deriveVoiceReportCard(examples);
    expect(result.traits).toEqual([]);
    expect(result.fallbackSnippet).not.toBeNull();
    expect(result.fallbackSnippet!.before).toContain('Thanks for visiting');
  });

  it('treats a pair with identical draft and edit as non-conforming for every heuristic', () => {
    const identical = 'Hi Amanda — thanks so much! — Maria';
    const examples = Array.from({ length: 5 }, () => pair(identical, identical, 2));
    expect(deriveVoiceReportCard(examples).traits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/lib/responses/__tests__/voice-report-card.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/responses/voice-report-card.ts`:**

```ts
// Deterministic register-trait derivation for the Voice Report Card
// (/settings/voice). Pure function over the SAME VoiceExample pairs the
// prompt path few-shots from — the card never claims a pattern the prompt
// isn't using (intake invariant, ticket #540).
//
// Detection bar: a trait renders only when its pattern holds in a strict
// majority of applicable pairs AND >=2 pairs conform. Critical reviews is
// exempted (applicable set = negative pairs, star <=2 per classifySentiment,
// usually size 0-1): it detects at >=1 meaningful negative pair, with claim
// text scoped to its single evidence pair when only one exists.
// Pairs whose edit is identical to the draft are never conforming.

import { classifySentiment } from '@/lib/reviews/sentiment';
import type { VoiceExample } from './types';

export type RegisterTraitKey = 'greeting' | 'length' | 'signoff' | 'point_of_view' | 'critical';

export interface TraitSnippet {
  before: string;
  after: string;
}

export interface RegisterTrait {
  key: RegisterTraitKey;
  name: string;
  claim: string;
  snippet: TraitSnippet;
}

export interface VoiceReportCardData {
  traits: RegisterTrait[];
  /** Most recent pair's evidence; non-null only when examples exist and zero traits detected. */
  fallbackSnippet: TraitSnippet | null;
}

const MIN_CONFORMING_PAIRS = 2;
const SNIPPET_MAX_CHARS = 140;
const LENGTH_CUT_RATIO = 0.75;

const GREETING_RE = /^\s*(hi|hey|hello)\b/i;
const DEAR_RE = /^\s*dear\b/i;
const OWN_LINE_SIGNOFF_RE = /^[—–-]{1,2}\s*(.+)$/;
const TRAILING_SIGNOFF_RE = /[—–]\s*([^—–\n]{1,40})$/;
const FIRST_SINGULAR_RE = /\b(i|i'm|i'll|i've|i'd|my|me|mine)\b/gi;
const FIRST_PLURAL_RE = /\b(we|we're|we'll|we've|we'd|our|us|ours)\b/gi;

function truncate(text: string, max = SNIPPET_MAX_CHARS): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

function isMeaningfulEdit(pair: VoiceExample): boolean {
  return pair.originalDraft.trim() !== pair.editedVersion.trim();
}

function clearsBar(conforming: number, applicable: number): boolean {
  return conforming >= MIN_CONFORMING_PAIRS && conforming * 2 > applicable;
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function deriveGreeting(pairs: VoiceExample[]): RegisterTrait | null {
  const conforming = pairs.filter((p) => isMeaningfulEdit(p) && GREETING_RE.test(p.editedVersion));
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const words = conforming.map((p) => {
    const raw = p.editedVersion.match(GREETING_RE)?.[1] ?? 'hi';
    return raw.toLowerCase();
  });
  const word = mostFrequent(words);
  const cased = word.charAt(0).toUpperCase() + word.slice(1);
  const draftsUsedDear = pairs.some((p) => DEAR_RE.test(p.originalDraft));
  const noEditUsesDear = pairs.every((p) => !DEAR_RE.test(p.editedVersion));
  const claim = draftsUsedDear && noEditUsesDear
    ? `You open with “${cased}” — never “Dear.”`
    : `You open with “${cased}.”`;

  const evidence = conforming.find((p) => p.editedVersion.toLowerCase().trim().startsWith(word)) ?? conforming[0];
  return {
    key: 'greeting',
    name: 'Greeting',
    claim,
    snippet: { before: truncate(firstLine(evidence.originalDraft), 90), after: truncate(firstLine(evidence.editedVersion), 90) },
  };
}

function deriveLength(pairs: VoiceExample[]): RegisterTrait | null {
  const conforming = pairs.filter(
    (p) => isMeaningfulEdit(p) && wordCount(p.editedVersion) <= LENGTH_CUT_RATIO * wordCount(p.originalDraft),
  );
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const average = (values: number[]) => Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
  const avgDraft = average(pairs.map((p) => wordCount(p.originalDraft)));
  const avgEdit = average(pairs.map((p) => wordCount(p.editedVersion)));
  const evidence = conforming[0];
  return {
    key: 'length',
    name: 'Length',
    claim: `You tighten replies: your edits average ${avgEdit} words; drafts average ${avgDraft}.`,
    snippet: {
      before: `${truncate(evidence.originalDraft)} (${wordCount(evidence.originalDraft)} words)`,
      after: `${truncate(evidence.editedVersion)} (${wordCount(evidence.editedVersion)} words)`,
    },
  };
}

function signoffOf(text: string): string | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const ownLine = last.match(OWN_LINE_SIGNOFF_RE);
  if (ownLine) return ownLine[1].trim();
  const trailing = last.match(TRAILING_SIGNOFF_RE);
  return trailing ? trailing[1].trim() : null;
}

function deriveSignoff(pairs: VoiceExample[]): RegisterTrait | null {
  const withSignoff = pairs.filter((p) => {
    if (!isMeaningfulEdit(p)) return false;
    const edited = signoffOf(p.editedVersion);
    if (!edited) return false;
    return edited.toLowerCase() !== (signoffOf(p.originalDraft) ?? '').toLowerCase();
  });
  if (withSignoff.length === 0) return null;

  const majority = mostFrequent(withSignoff.map((p) => (signoffOf(p.editedVersion) ?? '').toLowerCase()));
  const conforming = withSignoff.filter((p) => (signoffOf(p.editedVersion) ?? '').toLowerCase() === majority);
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const display = signoffOf(conforming[0].editedVersion) ?? majority;
  const evidence = conforming[0];
  const draftSignoff = signoffOf(evidence.originalDraft);
  return {
    key: 'signoff',
    name: 'Sign-off',
    claim: `You sign as “— ${display}.”`,
    snippet: {
      before: draftSignoff ? `— ${draftSignoff}` : truncate(evidence.originalDraft, 90),
      after: `— ${display}`,
    },
  };
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function derivePointOfView(pairs: VoiceExample[]): RegisterTrait | null {
  const conforming = pairs.filter((p) => {
    if (!isMeaningfulEdit(p)) return false;
    const editedSingular = countMatches(p.editedVersion, FIRST_SINGULAR_RE) > countMatches(p.editedVersion, FIRST_PLURAL_RE);
    const draftPlural = countMatches(p.originalDraft, FIRST_PLURAL_RE) > countMatches(p.originalDraft, FIRST_SINGULAR_RE);
    return editedSingular && draftPlural;
  });
  if (!clearsBar(conforming.length, pairs.length)) return null;

  const evidence = conforming[0];
  return {
    key: 'point_of_view',
    name: 'Point of view',
    claim: 'You write as “I,” not “we.”',
    snippet: { before: truncate(evidence.originalDraft, 110), after: truncate(evidence.editedVersion, 110) },
  };
}

function deriveCritical(pairs: VoiceExample[]): RegisterTrait | null {
  const negative = pairs.filter((p) => classifySentiment(p.reviewStarRating).label === 'negative');
  const conforming = negative.filter(isMeaningfulEdit);
  if (conforming.length === 0) return null;

  const evidence = conforming[0];
  const draftWords = wordCount(evidence.originalDraft);
  const editWords = wordCount(evidence.editedVersion);
  const generalized = conforming.length >= MIN_CONFORMING_PAIRS && conforming.length * 2 > negative.length;

  let claim: string;
  if (generalized) {
    claim = 'On critical reviews you rewrite the draft in your own words.';
  } else if (editWords < draftWords) {
    claim = `On your ${evidence.reviewStarRating}-star review you cut the draft's ${draftWords} words to ${editWords} of your own.`;
  } else {
    claim = `On your ${evidence.reviewStarRating}-star review you replaced the draft with your own words.`;
  }

  return {
    key: 'critical',
    name: 'Critical reviews',
    claim,
    snippet: { before: truncate(evidence.originalDraft), after: truncate(evidence.editedVersion) },
  };
}

const TRAIT_DERIVERS = [deriveGreeting, deriveLength, deriveSignoff, derivePointOfView, deriveCritical];

export function deriveVoiceReportCard(examples: VoiceExample[]): VoiceReportCardData {
  if (examples.length === 0) {
    return { traits: [], fallbackSnippet: null };
  }

  const traits = TRAIT_DERIVERS
    .map((derive) => derive(examples))
    .filter((trait): trait is RegisterTrait => trait !== null);

  const mostRecent = examples[0];
  const fallbackSnippet = traits.length === 0
    ? { before: truncate(mostRecent.originalDraft), after: truncate(mostRecent.editedVersion) }
    : null;

  return { traits, fallbackSnippet };
}
```

- [ ] **Step 4: Run both suites green** — `pnpm vitest run src/lib/responses/__tests__/voice-report-card.test.ts src/lib/responses/__tests__/voice-learning.test.ts` → PASS (all). If a heuristic fails a test, fix the implementation, not the test — the tests encode the intake's detection bar.

- [ ] **Step 5: Typecheck + commit** — `pnpm typecheck` → clean. `git add src/lib/responses && git commit -m "feat(540): voice corpus status + report-card derivation (T1+T2)"`.

---

### Task 3: Sibling route GET /api/settings/voice/report-card

**Blocking edge:** Tasks 1+2 (imports both modules).

**Files:**
- Create: `src/app/api/settings/voice/report-card/route.ts`
- Test (create): `src/app/api/settings/voice/report-card/__tests__/route.test.ts`

Read `src/app/api/settings/voice/__tests__/route.test.ts` FIRST and mirror its mocking idiom exactly (hoisted `mockRequireRole` + tagged-template `mockSqlQuery` dispatch, mocks before route import).

- [ ] **Step 1: Write the failing tests** (titles VERBATIM):

```ts
// src/app/api/settings/voice/report-card/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockGetVoiceCorpusStatus, mockSqlQuery } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetVoiceCorpusStatus: vi.fn(),
  mockSqlQuery: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
});

vi.mock('@/lib/db/server', () => ({
  sql: (...args: unknown[]) => mockSqlQuery(args[0], ...args.slice(1)),
}));

vi.mock('@/lib/responses/voice-learning', () => ({
  getVoiceCorpusStatus: (...args: unknown[]) => mockGetVoiceCorpusStatus(...args),
}));

import { GET } from '../route';

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID = 'b1111111-0000-4000-8000-000000000001';

function makeRequest(locationId?: string): NextRequest {
  const url = locationId
    ? `http://localhost/api/settings/voice/report-card?locationId=${locationId}`
    : 'http://localhost/api/settings/voice/report-card';
  return new NextRequest(url);
}

function ownerUser() {
  return { id: 'u1', accountId: ACCOUNT_ID, role: 'owner' };
}

// Adjust ownerUser()/mockRequireRole wiring to whatever requireOwnerWithAccount
// actually consumes — mirror the sibling test file, do not invent shapes.

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ownerUser());
});

describe('GET /api/settings/voice/report-card', () => {
  it('returns 404 for a location outside the caller\'s account', async () => {
    mockSqlQuery.mockResolvedValueOnce([]); // ownership SELECT finds nothing
    const res = await GET(makeRequest(LOCATION_ID));
    expect(res.status).toBe(404);
  });

  it('returns activation progress for a location below threshold', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ id: LOCATION_ID }]);
    mockGetVoiceCorpusStatus.mockResolvedValueOnce({ editedCount: 2, examples: [] });
    const res = await GET(makeRequest(LOCATION_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ locationId: LOCATION_ID, activationThreshold: 5, editedCount: 2, activated: false, traits: [] });
  });

  it('returns derived traits for an activated location', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ id: LOCATION_ID }]);
    mockGetVoiceCorpusStatus.mockResolvedValueOnce({
      editedCount: 6,
      examples: [
        { originalDraft: 'Dear Amanda, thank you so much for the wonderful feedback you shared.', editedVersion: 'Hi Amanda — thanks so much!', reviewStarRating: 5 },
        { originalDraft: 'Dear Tom, we appreciate your detailed feedback about the seating.', editedVersion: 'Hi Tom — glad the flat white landed.', reviewStarRating: 4 },
        { originalDraft: 'Dear Rosa, we are so happy to hear our team made your morning.', editedVersion: 'Hi Rosa — the crew says thanks.', reviewStarRating: 5 },
        { originalDraft: 'Dear Priya, thank you for your kind words about our pastries.', editedVersion: 'Hi Priya — the buns sell out by 10am.', reviewStarRating: 5 },
        { originalDraft: 'Dear Derek, we sincerely apologize for the inconvenience caused.', editedVersion: 'Hi Derek — that wait was not okay.', reviewStarRating: 2 },
      ],
    });
    const res = await GET(makeRequest(LOCATION_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activated).toBe(true);
    expect(body.traits.length).toBeGreaterThan(0);
    expect(body.traits.map((t: { key: string }) => t.key)).toContain('greeting');
  });

  it('returns 400 when locationId is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/app/api/settings/voice/report-card/__tests__/route.test.ts` → FAIL (route missing).

- [ ] **Step 3: Implement the route:**

```ts
// src/app/api/settings/voice/report-card/route.ts
//
// Voice Report Card read model (ticket #540). Derives the five register
// traits from the SAME voice-learning corpus the prompt path uses —
// deterministic, on read, nothing persisted.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { getVoiceCorpusStatus } from '@/lib/responses/voice-learning';
import { deriveVoiceReportCard } from '@/lib/responses/voice-report-card';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

const ACTIVATION_THRESHOLD = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const user = owner.user;

  const locationId = request.nextUrl.searchParams.get('locationId');
  if (!locationId || !UUID_RE.test(locationId)) {
    return jsonResponse({ error: 'locationId is required' }, 400);
  }

  const [location] = await sql<{ id: string }[]>`
    SELECT id FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${user.accountId}::uuid
      AND archived_at IS NULL
  `;
  if (!location) {
    return jsonResponse({ error: 'Location not found' }, 404);
  }

  try {
    const status = await getVoiceCorpusStatus(sql, locationId);
    const card = deriveVoiceReportCard(status.examples);
    return jsonResponse({
      locationId,
      activationThreshold: ACTIVATION_THRESHOLD,
      editedCount: status.editedCount,
      activated: status.examples.length > 0,
      traits: card.traits,
      fallbackSnippet: card.fallbackSnippet,
    });
  } catch (error) {
    reportCaughtError('api/settings/voice/report-card GET', error, { locationId });
    return jsonResponse({ error: 'Failed to load voice report card' }, 500);
  }
}
```

Check `requireOwnerWithAccount`'s actual return shape in `src/lib/auth/route-helpers.ts` before writing — mirror the sibling route's usage verbatim.

- [ ] **Step 4: Run green** — `pnpm vitest run src/app/api/settings/voice/report-card/__tests__/route.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/app/api/settings/voice/report-card && git commit -m "feat(540): voice report-card read route"`.

---

### Task 4: UI — VoiceReportCard section on /settings/voice

**Blocking edge:** Task 3 (fetches the route).

**Files:**
- Create: `src/app/(authenticated)/settings/voice/VoiceReportCard.tsx`
- Modify: `src/app/(authenticated)/settings/voice/VoiceClient.tsx` (render the section below `BrandVoicePanel`)

**MANDATORY:** invoke the `repworth-brand-design` skill BEFORE writing JSX; follow the `set-section` idiom already in `VoiceClient.tsx` and `SettingsShell`. Read `src/hooks/useLocationVoiceForm.ts` to find the correct location-id source for single-location accounts (if `selectedLocationId` is null there, fall back to `f.locations[0]?.locationId` — verify, don't guess).

- [ ] **Step 1: Implement `VoiceReportCard.tsx`** (client component; no test promised — component is presentation-only; logic lives in Tasks 1–3):

```tsx
'use client';

// Voice Report Card section (ticket #540): what voice learning inferred from
// the owner's own edits. States: loading, error, pre-activation progress
// (N of 5), detected traits, zero-trait fallback.

import { useEffect, useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';

interface TraitSnippet { before: string; after: string }
interface RegisterTrait { key: string; name: string; claim: string; snippet: TraitSnippet }
interface ReportCardResponse {
  activationThreshold: number;
  editedCount: number;
  activated: boolean;
  traits: RegisterTrait[];
  fallbackSnippet: TraitSnippet | null;
}

export function VoiceReportCard({ locationId }: { locationId: string }) {
  const [data, setData] = useState<ReportCardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/settings/voice/report-card?locationId=${encodeURIComponent(locationId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load your voice report card.');
        return (await res.json()) as ReportCardResponse;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [locationId]);

  // …render per state (see design notes below); brand skill governs visuals.
}
```

Render contract (each a distinct state, all inside one `set-section`):
- **Header:** icon + title "Voice Report Card" + sub "What RepWorth has learned from your own edits."
- **Loading:** skeleton (reuse `SettingsSkeleton` row idiom or a minimal shimmer block).
- **Error:** the section renders with the error message (visible degradation — intake observability).
- **Pre-activation** (`!activated`): 5 progress dots, `min(editedCount, 5)` filled; copy: "**{editedCount} of 5 edited replies.** Only replies you've edited and posted count. The report card switches on by itself — keep editing drafts that don't sound like you."
- **Traits** (`activated && traits.length > 0`): one row per trait — trait name label, claim text, then before→after snippet (before struck/muted in a recessed block, after emphasized). Before/after visual idiom from the prototype: muted "Draft" block above highlighted "Your edit" block.
- **Zero-trait fallback** (`activated && traits.length === 0 && fallbackSnippet`): line "You've edited {editedCount} replies — no consistent pattern stands out yet." over the fallback snippet's before→after block.

- [ ] **Step 2: Wire into `VoiceClient.tsx`** — after `<BrandVoicePanel …/>` (and after the save-error `<p>`), render:

```tsx
{reportCardLocationId && <VoiceReportCard locationId={reportCardLocationId} />}
```

where `reportCardLocationId = f.selectedLocationId ?? f.locations[0]?.locationId ?? null` (verify against the hook's actual single-location shape first).

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm lint` clean; `pnpm vitest run src/app/api/settings/voice` still green; `pnpm build` succeeds (UI surface).

- [ ] **Step 4: Commit** — `git add 'src/app/(authenticated)/settings/voice' && git commit -m "feat(540): voice report card section on settings/voice"`.

---

### Task 5: Glossary + docs

**Blocking edge:** none (can run after Task 2).

**Files:**
- Modify: `CONTEXT.md` (append a new section)

- [ ] **Step 1: Append to `CONTEXT.md`:**

```markdown
## Voice Report Card (locked 2026-07-24 — ticket #540, prototype #536)

- **Voice Report Card**: the owner-facing section on `/settings/voice` reporting what voice learning inferred — five Register traits, each a plain-language claim backed by one before→after snippet from the owner's own edits. Derives on read from EXACTLY the corpus the prompt path uses (`getVoiceCorpusStatus`/`getApprovedResponsePairs`); below activation (5 posted owner-edited replies) it shows "N of 5" progress and never partial traits. Deterministic only — no LLM, nothing persisted, no flag/tier gate. *(coined in #536 prototype; locked in #540 grilling)*
- **Register trait**: one of five deterministic voice patterns (greeting, length, sign-off, point of view, critical-review register) derived heuristically from `VoiceExample` pairs. Renders only when its pattern holds in a strict majority of applicable pairs with ≥2 conforming; Critical reviews is exempted (applicable = negative pairs per `classifySentiment`, detects at ≥1, claim scoped to its evidence when single). Undetected traits are omitted — the card never claims what wasn't learned. *(coined in #536 prototype; detection bar locked in #540 grilling)*
```

- [ ] **Step 2: Commit** — `git add CONTEXT.md && git commit -m "docs(540): glossary — Voice Report Card, Register trait"`.

---

## Self-review (done at plan time)

- **Spec coverage:** all 10 promised test titles appear verbatim (T1: titles 1,7 + 2 supporting; T2: titles 2–6 + identical-pair edge; T3: titles 8–10 + 400 case). All 7 intake edge cases have a home (0/4 count → T1+T3; zero-trait → T2; no negative pairs → T2; identical pair → T2; location switch → T4 effect on `locationId`; foreign locationId → T3).
- **Type consistency:** `VoiceCorpusStatus`, `RegisterTrait`, `TraitSnippet`, `VoiceReportCardData` defined once in the interface contract and reused verbatim in every task.
- **Placeholder scan:** Task 4 render section is deliberately design-guided (brand skill owns visuals) but every state's content/copy is specified.
