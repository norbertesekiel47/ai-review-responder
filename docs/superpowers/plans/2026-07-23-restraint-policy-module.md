# Restraint Policy Module (#542) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, sentiment-blind restraint policy module — `evaluateAsk` (five per-candidate gates) + `evaluateBatch` (adds `velocity_banked`) — exactly per `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md` and ADR 0012.

**Architecture:** One deep module at `src/lib/solicitation/restraint-policy.ts`: small interface (`evaluateAsk`, `evaluateBatch`, `resolveVertical`, closed enums, versioned constants), all gate mechanics hidden. Pure — no DB, no clock; `decided_at` and business category arrive via context. Evidence payload field names are snake_case verbatim from the spec table (they are a serialization contract stored in JSONB later); TS input types are camelCase.

**Tech Stack:** TypeScript strict, Vitest, fast-check (installed). Precedents: `src/lib/responses/prompt-policy.ts` (versioned policy constant), `src/lib/reviews/sentiment.ts` (+ its test's fast-check "invariants" describe block).

**Intake contract:** `docs/superpowers/plans/feat-542-restraint-policy-intake.json` — the drift detector. Edit surface: `src/lib/solicitation/**`, the spec file, `docs/superpowers/plans/**`, `docs/reviews/**`.

**Glossary (CONTEXT.md, verbatim):** *Restraint policy* — the deterministic, sentiment-blind rule set that decides send vs withhold for each Solicitation candidate. *Withhold reason* — one code from the closed six-reason enum; first-match precedence; one reason per withhold. *Freshness window* — per-Vertical day count beyond which the last visit is too stale. *Velocity banking* — withholding an otherwise-eligible candidate solely because the batch cap is reached; most-recent-visit-first kept. *Evidence snapshot* — immutable per-withhold record, `policy_version` + `decided_at` envelope, candidate by ID only, never PII, never a star rating.

**Decisions made at plan time (not in the spec):**
- `MIN_GAP_DAYS = 30` — the spec locks `over_contacted`'s evidence shape but gives no day-one gap constant. 30 is the conservative middle (matches the `other` freshness window); it lives in the same tunable-constants block, is recorded in every `over_contacted` evidence snapshot, and is free to tune in watch-mode. Flag in the PR description.
- `over_contacted` boundary: fires iff `days_since_prior_decision < MIN_GAP_DAYS` (a gap of exactly 30 days is allowed — symmetric with `stale_visit`'s "boundary day is fresh").
- Vertical keyword matching: candidate category lowercased; keywords matched with a **left word-boundary** regex (`\bkeyword`) so stems work (`plumb` → "plumbing") without `car` matching "carpet"; table iterated in a fixed specific-first order, first match wins.
- `evaluateBatch` returns one decision per candidate **in input order**.

---

### Task 1: Types, constants, vertical mapper, and `evaluateAsk` (five per-candidate gates)

**Files:**
- Create: `src/lib/solicitation/restraint-policy.ts`
- Create: `src/lib/solicitation/__tests__/restraint-policy.test.ts`

- [ ] **Step 1: Write the failing tests** — create the test file with the builder + Task 1 describes:

```typescript
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BATCH_CAP,
  evaluateAsk,
  evaluateBatch,
  FRESHNESS_WINDOW_DAYS,
  MIN_GAP_DAYS,
  RESTRAINT_POLICY_VERSION,
  resolveVertical,
  VERTICALS,
  WITHHOLD_REASONS,
  type AskCandidate,
  type BatchContext,
} from '../restraint-policy';

/** Candidate that passes every per-candidate gate under the default context. */
function eligibleCandidate(overrides: Partial<AskCandidate> = {}): AskCandidate {
  return {
    contactId: '01980000-0000-7000-8000-000000000001',
    lastVisitDate: '2026-07-20',
    consent: { attested: true, uploadId: 'upload-1' },
    suppression: null,
    matchedReview: null,
    priorBatch: null,
    ...overrides,
  };
}

const context: BatchContext = {
  decidedAt: '2026-07-23T12:00:00.000Z',
  businessCategory: 'Coffee shop',
};

describe('withhold-reason enum (contract)', () => {
  it('is exactly the closed six-reason set, in precedence order', () => {
    expect(WITHHOLD_REASONS).toEqual([
      'no_consent',
      'suppressed',
      'already_reviewed',
      'stale_visit',
      'over_contacted',
      'velocity_banked',
    ]);
  });

  it('exposes the closed eight-vertical enum', () => {
    expect(VERTICALS).toEqual([
      'food_and_drink',
      'retail',
      'personal_care',
      'fitness',
      'medical_dental',
      'automotive',
      'home_services',
      'other',
    ]);
  });

  it('locks the day-one freshness windows to the spec table', () => {
    expect(FRESHNESS_WINDOW_DAYS).toEqual({
      food_and_drink: 14,
      retail: 14,
      personal_care: 21,
      fitness: 21,
      medical_dental: 30,
      automotive: 30,
      home_services: 45,
      other: 30,
    });
  });

  it('locks the day-one batch cap and contact gap', () => {
    expect(BATCH_CAP).toBe(25);
    expect(MIN_GAP_DAYS).toBe(30);
  });
});

describe('resolveVertical', () => {
  it.each([
    ['Joe\'s Pizza & Grill', 'food_and_drink', 'pizza'],
    ['Downtown Boutique', 'retail', 'boutique'],
    ['Shear Bliss Hair Salon', 'personal_care', 'salon'],
    ['Iron Temple Gym', 'fitness', 'gym'],
    ['Bright Smile Dental', 'medical_dental', 'dental'],
    ['Precision Auto Repair', 'automotive', 'auto'],
    ['Rapid Plumbing Co', 'home_services', 'plumb'],
  ] as const)('%s → %s (keyword %s)', (category, vertical, keyword) => {
    expect(resolveVertical(category)).toEqual({ vertical, matchedKeyword: keyword });
  });

  it('falls back to other with no matched keyword', () => {
    expect(resolveVertical('Quantum Flux Consulting')).toEqual({ vertical: 'other', matchedKeyword: null });
    expect(resolveVertical('')).toEqual({ vertical: 'other', matchedKeyword: null });
    expect(resolveVertical(null)).toEqual({ vertical: 'other', matchedKeyword: null });
  });

  it('resolves barber to personal_care, not food_and_drink via "bar"', () => {
    expect(resolveVertical('Fadeaway Barber Shop').vertical).toBe('personal_care');
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (category) => {
        expect(resolveVertical(category)).toEqual(resolveVertical(category));
      }),
    );
  });
});

describe('evaluateAsk — per-reason contracts', () => {
  it('send: eligible candidate gets the bare envelope, no evidence payload', () => {
    expect(evaluateAsk(eligibleCandidate(), context)).toEqual({
      decision: 'send',
      contact_id: '01980000-0000-7000-8000-000000000001',
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: '2026-07-23T12:00:00.000Z',
    });
  });

  it('no_consent: unattested candidate withheld with upload_id evidence (cannot fire in v-watch — #535 attestation is blocking; contract-tested for enum stability)', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ consent: { attested: false, uploadId: 'upload-9' } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'no_consent',
      upload_id: 'upload-9',
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: context.decidedAt,
    });
  });

  it('suppressed: suppression source + timestamp in evidence (no v-watch source; contract-tested for enum stability)', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'suppressed',
      suppression_source: 'owner_manual',
      suppressed_at: '2026-07-01T00:00:00.000Z',
    });
  });

  it('already_reviewed: review_id + review_date, fires on existence of a review — the input type carries no rating (ADR 0012)', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ matchedReview: { reviewId: 'rev-1', reviewDate: '2026-06-15' } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'already_reviewed',
      review_id: 'rev-1',
      review_date: '2026-06-15',
    });
    expect(JSON.stringify(decision)).not.toMatch(/rating|star|sentiment/i);
  });

  it('stale_visit: fires strictly beyond the vertical window, with full arithmetic evidence', () => {
    // Coffee shop → food_and_drink, window 14. decidedAt is 2026-07-23.
    const boundary = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-09' }), context); // exactly 14 days
    expect(boundary.decision).toBe('send');

    const stale = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-08' }), context); // 15 days
    expect(stale).toMatchObject({
      decision: 'withhold',
      reason: 'stale_visit',
      last_visit_date: '2026-07-08',
      days_since_visit: 15,
      vertical: 'food_and_drink',
      matched_keyword: 'coffee',
      freshness_window_days: 14,
    });
  });

  it('stale_visit: unmapped category uses the other window (30) and records matched_keyword null', () => {
    const ctx: BatchContext = { ...context, businessCategory: 'Quantum Flux Consulting' };
    expect(evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-06-23' }), ctx).decision).toBe('send'); // exactly 30
    const stale = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-06-22' }), ctx); // 31
    expect(stale).toMatchObject({
      reason: 'stale_visit',
      vertical: 'other',
      matched_keyword: null,
      freshness_window_days: 30,
    });
  });

  it('over_contacted: prior would-have-sent inclusion within MIN_GAP_DAYS withholds with gap evidence', () => {
    const recent = evaluateAsk(
      eligibleCandidate({ priorBatch: { batchId: 'batch-7', decidedAt: '2026-07-10T09:00:00.000Z' } }),
      context,
    );
    expect(recent).toMatchObject({
      decision: 'withhold',
      reason: 'over_contacted',
      prior_batch_id: 'batch-7',
      prior_decision_at: '2026-07-10T09:00:00.000Z',
      min_gap_days: 30,
    });
  });

  it('over_contacted boundary: a gap of exactly MIN_GAP_DAYS is allowed', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ priorBatch: { batchId: 'batch-6', decidedAt: '2026-06-23T09:00:00.000Z' } }),
      context,
    );
    expect(decision.decision).toBe('send');
  });
});

describe('evaluateAsk — first-match precedence', () => {
  /** Fails every per-candidate gate at once. */
  function failsEverything(): AskCandidate {
    return {
      contactId: '01980000-0000-7000-8000-00000000000f',
      lastVisitDate: '2020-01-01',
      consent: { attested: false, uploadId: 'upload-x' },
      suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' },
      matchedReview: { reviewId: 'rev-x', reviewDate: '2026-06-01' },
      priorBatch: { batchId: 'batch-x', decidedAt: '2026-07-20T00:00:00.000Z' },
    };
  }

  it('reports exactly the first failing gate in precedence order', () => {
    const all = failsEverything();
    expect(evaluateAsk(all, context)).toMatchObject({ reason: 'no_consent' });
    expect(evaluateAsk({ ...all, consent: { attested: true, uploadId: 'u' } }, context)).toMatchObject({ reason: 'suppressed' });
    expect(evaluateAsk({ ...all, consent: { attested: true, uploadId: 'u' }, suppression: null }, context)).toMatchObject({ reason: 'already_reviewed' });
    expect(evaluateAsk({ ...all, consent: { attested: true, uploadId: 'u' }, suppression: null, matchedReview: null }, context)).toMatchObject({ reason: 'stale_visit' });
    expect(
      evaluateAsk(
        { ...all, consent: { attested: true, uploadId: 'u' }, suppression: null, matchedReview: null, lastVisitDate: '2026-07-20' },
        context,
      ),
    ).toMatchObject({ reason: 'over_contacted' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-542-restraint-policy && pnpm vitest run src/lib/solicitation --reporter=dot 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module** — `src/lib/solicitation/restraint-policy.ts`:

```typescript
/**
 * Restraint policy (v-watch): the deterministic, sentiment-blind rule set
 * deciding send vs withhold for each Solicitation candidate.
 *
 * Locked contract: docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md
 * (#533, built by #542). Sentiment-blindness: ADR 0012 — `recent_negative` is
 * permanently rejected; no sentiment, star rating, or review content may enter
 * this module's inputs or evidence.
 *
 * Pure module: no DB access, no clock reads — `decided_at` and the business
 * category arrive via context, so identical inputs produce identical decisions.
 * Precondition (spec §1 boundary rule): callers pass only valid candidates —
 * ingest hygiene (malformed handles, unparseable/future dates) is #535
 * upload-time rejection, so dates here are trusted `YYYY-MM-DD`/ISO strings.
 *
 * v-watch footnote: `no_consent` (like `suppressed`) cannot fire in v-watch —
 * the #535 consent attestation is blocking, so every uploaded candidate is
 * covered by construction. Both gates ship and are contract-tested so the enum
 * is stable when send-mode lands.
 */

/** Bump when the constants table or gate logic changes (prompt-policy.ts pattern). */
export const RESTRAINT_POLICY_VERSION = 'restraint_v_watch_2026-07-23.1';

/** Closed withhold-reason enum, listed in precedence order (spec §2). */
export const WITHHOLD_REASONS = [
  'no_consent',
  'suppressed',
  'already_reviewed',
  'stale_visit',
  'over_contacted',
  'velocity_banked',
] as const;
export type WithholdReason = (typeof WITHHOLD_REASONS)[number];

/** Closed vertical enum (spec §3.1). */
export const VERTICALS = [
  'food_and_drink',
  'retail',
  'personal_care',
  'fitness',
  'medical_dental',
  'automotive',
  'home_services',
  'other',
] as const;
export type Vertical = (typeof VERTICALS)[number];

// ---------------------------------------------------------------------------
// Tunable day-one constants (spec §3.2, §5.3) — one table, single owner.
// Replaced by learned curves later behind the same gates; every evidence
// snapshot records the value that was applied.
// ---------------------------------------------------------------------------

/** Hard freshness window per vertical: stale iff today − last_visit > window. */
export const FRESHNESS_WINDOW_DAYS: Record<Vertical, number> = {
  food_and_drink: 14,
  retail: 14,
  personal_care: 21,
  fitness: 21,
  medical_dental: 30,
  automotive: 30,
  home_services: 45,
  other: 30,
};

/** Day-one batch cap (spec §5.3). */
export const BATCH_CAP = 25;

/**
 * Day-one minimum days between would-have-sent inclusions of the same
 * candidate. The spec locks over_contacted's evidence shape but no day-one
 * value; 30 is the conservative middle, free to tune in watch-mode. A gap of
 * exactly MIN_GAP_DAYS is allowed (symmetric with stale_visit's boundary).
 */
export const MIN_GAP_DAYS = 30;

// ---------------------------------------------------------------------------
// Inputs — loaded entirely by the caller (#543); no PII beyond what gates need,
// and never any sentiment or rating field (ADR 0012).
// ---------------------------------------------------------------------------

export interface AskCandidate {
  /** contacts row id (UUIDv7) — the only candidate reference evidence carries. */
  contactId: string;
  /** Most recent visit date (visits ledger), YYYY-MM-DD. */
  lastVisitDate: string;
  /** Attestation coverage inherited from the upload (#535 §4). */
  consent: { attested: boolean; uploadId: string };
  /** Suppression-ledger hit, if any (no v-watch source; send-mode scope). */
  suppression: { source: string; suppressedAt: string } | null;
  /** Existing review matched to this contact — any rating; the rating itself is never an input. */
  matchedReview: { reviewId: string; reviewDate: string } | null;
  /** Most recent would-have-sent inclusion in a prior batch (simulated contact history). */
  priorBatch: { batchId: string; decidedAt: string } | null;
}

export interface BatchContext {
  /** Decision timestamp (ISO 8601). "Today" for gate arithmetic is its UTC date. */
  decidedAt: string;
  /** Owner-typed free text `businesses.category`; resolved via resolveVertical. */
  businessCategory: string | null;
}

// ---------------------------------------------------------------------------
// Decisions — evidence field names are snake_case verbatim from the spec §4
// table: they are a serialization contract (stored in JSONB, rendered by the
// batch UI), not internal TS shape.
// ---------------------------------------------------------------------------

export type WithholdEvidence =
  | { reason: 'no_consent'; upload_id: string }
  | { reason: 'suppressed'; suppression_source: string; suppressed_at: string }
  | { reason: 'already_reviewed'; review_id: string; review_date: string }
  | {
      reason: 'stale_visit';
      last_visit_date: string;
      days_since_visit: number;
      vertical: Vertical;
      matched_keyword: string | null;
      freshness_window_days: number;
    }
  | { reason: 'over_contacted'; prior_batch_id: string; prior_decision_at: string; min_gap_days: number }
  | {
      reason: 'velocity_banked';
      batch_cap: number;
      eligible_count: number;
      ordering_basis: { last_visit_date: string; contact_id: string };
    };

/** The five reasons evaluateAsk can assign; velocity_banked is batch-relative and only evaluateBatch assigns it. */
export type PerCandidateWithholdEvidence = Exclude<WithholdEvidence, { reason: 'velocity_banked' }>;

interface DecisionEnvelope {
  contact_id: string;
  policy_version: typeof RESTRAINT_POLICY_VERSION;
  decided_at: string;
}

export type SendDecision = DecisionEnvelope & { decision: 'send' };
export type WithholdDecision = DecisionEnvelope & { decision: 'withhold' } & WithholdEvidence;
export type PerCandidateDecision = SendDecision | (DecisionEnvelope & { decision: 'withhold' } & PerCandidateWithholdEvidence);
export type AskDecision = SendDecision | WithholdDecision;

// ---------------------------------------------------------------------------
// Vertical resolution (spec §3.1): pure, deterministic keyword mapper.
// ---------------------------------------------------------------------------

export interface VerticalResolution {
  vertical: Vertical;
  matchedKeyword: string | null;
}

/**
 * Ordered specific-first; within a vertical, keywords are checked in listed
 * order and the first left-word-boundary match wins (stems like "plumb" match
 * "plumbing"; "car" cannot match "carpet"). `retail` is last: its keywords are
 * the most generic.
 */
const VERTICAL_KEYWORDS: ReadonlyArray<readonly [Vertical, ReadonlyArray<string>]> = [
  ['medical_dental', ['dental', 'dentist', 'orthodont', 'medical', 'clinic', 'doctor', 'physician', 'pediatric', 'chiropract', 'optometr', 'veterinar', 'urgent care', 'dermatolog']],
  ['automotive', ['auto', 'car wash', 'car repair', 'tire', 'mechanic', 'oil change', 'body shop', 'collision', 'dealership', 'smog']],
  ['home_services', ['plumb', 'roof', 'hvac', 'electric', 'landscap', 'contractor', 'pest', 'cleaning', 'painting', 'remodel', 'handyman', 'mover', 'moving', 'locksmith', 'garage door']],
  ['personal_care', ['salon', 'spa', 'barber', 'nail', 'lash', 'brow', 'beauty', 'hair', 'massage', 'tattoo', 'waxing', 'tanning']],
  ['fitness', ['gym', 'fitness', 'yoga', 'pilates', 'crossfit', 'martial arts', 'dance studio', 'personal train', 'boxing']],
  ['food_and_drink', ['restaurant', 'cafe', 'coffee', 'bakery', 'bar', 'pizza', 'food', 'diner', 'bistro', 'grill', 'pub', 'brewery', 'deli', 'taco', 'sushi', 'bbq', 'juice', 'ice cream', 'catering']],
  ['retail', ['shop', 'store', 'boutique', 'retail', 'market', 'florist', 'jewel', 'bookstore', 'clothing', 'furniture', 'pet supply']],
];

/** Resolve the owner-typed category text to a Vertical; `other` when unmapped. */
export function resolveVertical(businessCategory: string | null): VerticalResolution {
  const normalized = (businessCategory ?? '').toLowerCase();
  if (normalized.length > 0) {
    for (const [vertical, keywords] of VERTICAL_KEYWORDS) {
      for (const keyword of keywords) {
        if (new RegExp(`\\b${keyword}`).test(normalized)) {
          return { vertical, matchedKeyword: keyword };
        }
      }
    }
  }
  return { vertical: 'other', matchedKeyword: null };
}

// ---------------------------------------------------------------------------
// Date arithmetic — calendar-day differences on UTC dates.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** UTC day number of a YYYY-MM-DD date (or the date part of an ISO timestamp). */
function utcDayNumber(date: string): number {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Run the five per-candidate gates in precedence order (spec §2):
 * no_consent → suppressed → already_reviewed → stale_visit → over_contacted.
 * First failing gate wins; a withhold carries exactly one reason.
 * velocity_banked is batch-relative — use evaluateBatch for the complete decision.
 */
export function evaluateAsk(candidate: AskCandidate, context: BatchContext): PerCandidateDecision {
  const envelope: DecisionEnvelope = {
    contact_id: candidate.contactId,
    policy_version: RESTRAINT_POLICY_VERSION,
    decided_at: context.decidedAt,
  };

  if (!candidate.consent.attested) {
    return { ...envelope, decision: 'withhold', reason: 'no_consent', upload_id: candidate.consent.uploadId };
  }

  if (candidate.suppression !== null) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'suppressed',
      suppression_source: candidate.suppression.source,
      suppressed_at: candidate.suppression.suppressedAt,
    };
  }

  if (candidate.matchedReview !== null) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'already_reviewed',
      review_id: candidate.matchedReview.reviewId,
      review_date: candidate.matchedReview.reviewDate,
    };
  }

  const today = utcDayNumber(context.decidedAt);
  const daysSinceVisit = today - utcDayNumber(candidate.lastVisitDate);
  const { vertical, matchedKeyword } = resolveVertical(context.businessCategory);
  const windowDays = FRESHNESS_WINDOW_DAYS[vertical];
  if (daysSinceVisit > windowDays) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'stale_visit',
      last_visit_date: candidate.lastVisitDate,
      days_since_visit: daysSinceVisit,
      vertical,
      matched_keyword: matchedKeyword,
      freshness_window_days: windowDays,
    };
  }

  if (candidate.priorBatch !== null && today - utcDayNumber(candidate.priorBatch.decidedAt) < MIN_GAP_DAYS) {
    return {
      ...envelope,
      decision: 'withhold',
      reason: 'over_contacted',
      prior_batch_id: candidate.priorBatch.batchId,
      prior_decision_at: candidate.priorBatch.decidedAt,
      min_gap_days: MIN_GAP_DAYS,
    };
  }

  return { ...envelope, decision: 'send' };
}

/** Most-recent-visit-first; ties on contact row ID ascending (UUIDv7 is time-ordered) so ordering is total. */
function byBankingPriority(a: AskCandidate, b: AskCandidate): number {
  if (a.lastVisitDate !== b.lastVisitDate) {
    return a.lastVisitDate < b.lastVisitDate ? 1 : -1;
  }
  return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
}

/**
 * The complete batch evaluation: evaluateAsk per candidate, then the
 * batch-relative velocity gate (spec §2, §5.2–5.3) — when more than BATCH_CAP
 * candidates survive every per-candidate gate, keep the freshest visits and
 * bank the rest as velocity_banked. Returns one decision per candidate, in
 * input order.
 */
export function evaluateBatch(candidates: AskCandidate[], context: BatchContext): AskDecision[] {
  const evaluated = candidates.map((candidate) => ({ candidate, decision: evaluateAsk(candidate, context) }));
  const eligible = evaluated.filter(({ decision }) => decision.decision === 'send');

  if (eligible.length <= BATCH_CAP) {
    return evaluated.map(({ decision }) => decision);
  }

  const kept = new Set(
    eligible
      .map(({ candidate }) => candidate)
      .sort(byBankingPriority)
      .slice(0, BATCH_CAP)
      .map((candidate) => candidate.contactId),
  );

  return evaluated.map(({ candidate, decision }) => {
    if (decision.decision !== 'send' || kept.has(candidate.contactId)) {
      return decision;
    }
    return {
      contact_id: candidate.contactId,
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: context.decidedAt,
      decision: 'withhold',
      reason: 'velocity_banked',
      batch_cap: BATCH_CAP,
      eligible_count: eligible.length,
      ordering_basis: { last_visit_date: candidate.lastVisitDate, contact_id: candidate.contactId },
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-542-restraint-policy && pnpm vitest run src/lib/solicitation --reporter=dot 2>&1 | tail -10`
Expected: PASS (all Task 1 describes green — the `evaluateBatch` import is exercised in Task 2).

- [ ] **Step 5: Typecheck and commit**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-542-restraint-policy && pnpm typecheck 2>&1 | tail -5`
Expected: clean.

```bash
git add src/lib/solicitation docs/superpowers/plans/feat-542-restraint-policy-intake.json docs/superpowers/plans/2026-07-23-restraint-policy-module.md
git commit -m "feat(solicitation): restraint policy per-candidate gates + vertical mapper (#542)"
```

---

### Task 2: `evaluateBatch` velocity banking tests, property tests, spec footnote

**Files:**
- Modify: `src/lib/solicitation/__tests__/restraint-policy.test.ts` (append describes)
- Modify: `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md` (§1, after the `suppressed` paragraph)

- [ ] **Step 1: Append the failing/green batch + property tests** to the test file:

```typescript
describe('evaluateBatch — velocity banking', () => {
  /** n eligible candidates with sequential UUIDv7-ish ids and distinct recent visit dates. */
  function eligiblePool(n: number): AskCandidate[] {
    return Array.from({ length: n }, (_, i) =>
      eligibleCandidate({
        contactId: `01980000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        // decidedAt is 2026-07-23; keep all within the 14-day food_and_drink window.
        lastVisitDate: `2026-07-${String(10 + (i % 13)).padStart(2, '0')}`,
      }),
    );
  }

  it('returns an empty list for an empty batch', () => {
    expect(evaluateBatch([], context)).toEqual([]);
  });

  it('banks nothing at or under the cap', () => {
    const atCap = evaluateBatch(eligiblePool(BATCH_CAP), context);
    expect(atCap.every((d) => d.decision === 'send')).toBe(true);
    const underCap = evaluateBatch(eligiblePool(3), context);
    expect(underCap.every((d) => d.decision === 'send')).toBe(true);
  });

  it('banks overflow with full evidence, keeping most-recent-visit-first', () => {
    const pool = eligiblePool(BATCH_CAP + 5);
    const decisions = evaluateBatch(pool, context);
    const sends = decisions.filter((d) => d.decision === 'send');
    const banked = decisions.filter((d) => d.decision === 'withhold');
    expect(sends).toHaveLength(BATCH_CAP);
    expect(banked).toHaveLength(5);
    for (const decision of banked) {
      expect(decision).toMatchObject({
        reason: 'velocity_banked',
        batch_cap: BATCH_CAP,
        eligible_count: BATCH_CAP + 5,
      });
    }
    // Every banked candidate's visit is no fresher than every kept candidate's.
    const visitOf = new Map(pool.map((c) => [c.contactId, c.lastVisitDate]));
    const oldestKept = sends.map((d) => visitOf.get(d.contact_id) as string).sort()[0];
    for (const decision of banked) {
      expect((visitOf.get(decision.contact_id) as string) <= oldestKept).toBe(true);
    }
  });

  it('breaks same-date ties on contact row ID ascending (lower ID kept)', () => {
    const pool = Array.from({ length: BATCH_CAP + 1 }, (_, i) =>
      eligibleCandidate({
        contactId: `01980000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        lastVisitDate: '2026-07-20',
      }),
    );
    const decisions = evaluateBatch(pool, context);
    const bankedIds = decisions.filter((d) => d.decision === 'withhold').map((d) => d.contact_id);
    expect(bankedIds).toEqual([`01980000-0000-7000-8000-${String(BATCH_CAP).padStart(12, '0')}`]);
  });

  it('preserves input order and mixes per-candidate withholds untouched', () => {
    const suppressed = eligibleCandidate({
      contactId: '01980000-0000-7000-8000-00000000ffff',
      suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' },
    });
    const pool = [suppressed, ...eligiblePool(2)];
    const decisions = evaluateBatch(pool, context);
    expect(decisions.map((d) => d.contact_id)).toEqual(pool.map((c) => c.contactId));
    expect(decisions[0]).toMatchObject({ reason: 'suppressed' });
  });
});

// Property tests (fast-check): the house style for invariant-level coverage
// (see src/lib/reviews/__tests__/sentiment.test.ts).
describe('restraint policy invariants', () => {
  const hex12 = fc.integer({ min: 0, max: 0xffffff }).map((n) => n.toString(16).padStart(12, '0'));
  const isoDate = fc
    .integer({ min: 0, max: 400 })
    .map((daysAgo) => new Date(Date.UTC(2026, 6, 23) - daysAgo * 86_400_000).toISOString().slice(0, 10));

  const arbCandidate: fc.Arbitrary<AskCandidate> = fc.record({
    contactId: hex12.map((h) => `01980000-0000-7000-8000-${h}`),
    lastVisitDate: isoDate,
    consent: fc.record({ attested: fc.boolean(), uploadId: fc.constant('upload-1') }),
    suppression: fc.option(
      fc.record({ source: fc.constant('owner_manual'), suppressedAt: fc.constant('2026-07-01T00:00:00.000Z') }),
      { nil: null },
    ),
    matchedReview: fc.option(
      fc.record({ reviewId: fc.constant('rev-1'), reviewDate: fc.constant('2026-06-15') }),
      { nil: null },
    ),
    priorBatch: fc.option(
      fc.record({ batchId: fc.constant('batch-1'), decidedAt: isoDate.map((d) => `${d}T00:00:00.000Z`) }),
      { nil: null },
    ),
  });
  const arbBatch = fc.array(arbCandidate, { maxLength: 60 });

  it('is deterministic: same batch + context twice → identical decisions', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        expect(evaluateBatch(candidates, context)).toEqual(evaluateBatch(candidates, context));
      }),
    );
  });

  it('every decision carries the envelope; every withhold exactly one closed-enum reason', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        for (const decision of evaluateBatch(candidates, context)) {
          expect(decision.policy_version).toBe(RESTRAINT_POLICY_VERSION);
          expect(decision.decided_at).toBe(context.decidedAt);
          if (decision.decision === 'withhold') {
            expect(WITHHOLD_REASONS).toContain(decision.reason);
          }
        }
      }),
    );
  });

  it('sends never exceed the cap, and velocity banking only fires when eligible_count > cap', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        const decisions = evaluateBatch(candidates, context);
        const sends = decisions.filter((d) => d.decision === 'send').length;
        const banked = decisions.filter((d) => d.decision === 'withhold' && d.reason === 'velocity_banked').length;
        expect(sends).toBeLessThanOrEqual(BATCH_CAP);
        if (banked > 0) {
          expect(sends).toBe(BATCH_CAP);
          expect(sends + banked).toBeGreaterThan(BATCH_CAP);
        }
      }),
    );
  });

  it('evidence never contains PII or sentiment: no name/email/phone/rating/star keys in any serialized decision', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        const serialized = JSON.stringify(evaluateBatch(candidates, context));
        expect(serialized).not.toMatch(/"(name|email|phone|rating|stars?|sentiment)"/i);
      }),
    );
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-542-restraint-policy && pnpm vitest run src/lib/solicitation --reporter=dot 2>&1 | tail -10`
Expected: PASS. If a batch test fails, fix `evaluateBatch` (Task 1 Step 3 already implements it — failures here are implementation bugs, not missing code).

- [ ] **Step 3: Add the spec footnote** — in `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`, insert AFTER the paragraph ending "keeps the enum stable when send-mode lands." (§1):

```markdown
`no_consent` likewise cannot fire in v-watch: the #535 consent attestation is
blocking — no upload happens without it, and every contact/visit row inherits
attestation provenance via its upload FK, so every candidate the policy sees
is covered by construction. Like `suppressed`, the code ships (and #542
contract-tests it) purely for enum stability against send-mode, where per-row
consent semantics (the open counsel question, #531 §6.1) can make it live.
```

- [ ] **Step 4: Typecheck, lint, commit**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-542-restraint-policy && pnpm typecheck 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3`
Expected: clean.

```bash
git add src/lib/solicitation docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md
git commit -m "feat(solicitation): velocity banking + policy invariants; no_consent v-watch footnote (#542)"
```

---

## Self-review notes

- Spec coverage: §1 enum + boundary rule (Task 1 contract tests + module precondition doc), §2 precedence (Task 1), §3 windows + mapper (Task 1), §4 evidence shapes (both tasks; snake_case verbatim), §5 conservatism (pure module, banking order, cap; Task 2). Footnote from cross-review: Task 2 Step 3.
- `MIN_GAP_DAYS = 30` is a plan-time decision (spec gap) — flagged for the PR description.
- Types referenced in Task 2 (`AskCandidate`, `BATCH_CAP`, `WITHHOLD_REASONS`, `evaluateBatch`) are all defined in Task 1 with matching names.
