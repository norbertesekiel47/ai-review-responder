# Wave 3 · PR 5a — Review Sentiment (schema + classifier + backfill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic sentiment classification to every review at ingest and backfill existing reviews, with an LLM-ready schema — the foundation the PR 5b KPI sentiment-trend reads.

**Architecture:** Migration 052 adds four nullable `sentiment_*` columns to `reviews` plus a bounded, star-based deterministic backfill. A pure `classifySentiment(starRating)` module (star-rating → score + label) is wired into the **three** review-content write sites so new and content-changed reviews are classified in the same transaction as the row write. The classifier is intentionally star-only for v1 so the in-migration SQL backfill and the TS ingest path produce identical results; the `sentiment_source` column lets a later text/LLM classifier supersede it with no schema change.

**Tech Stack:** TypeScript (ESM, strict), Postgres (Postgres.js + Supabase migrations), Vitest. This is the launch-critical slice of Spec 11's sentiment section.

---

## Base Branch & Conventions

- **Branch:** `wave-3-pr5a-sentiment` off **`origin/main`**. Independent of the open PR 4 (eval harness) — this PR touches `reviews` schema + the ingest path, zero overlap. (PR 5b — the KPI query layer — will stack on this branch because its sentiment-trend KPI reads `reviews.sentiment_score`.)
- **Migration head is 051; this PR adds 052.** Next after this is 053.
- **JSONB / DB conventions** don't apply here (no JSONB). Use Postgres.js tagged templates; the new columns are written as ordinary interpolated params at the existing write sites.
- **Imports:** `src/` code uses the `@/` alias (e.g. `@/lib/reviews/sentiment`) — that's the production convention (this is NOT the `tests/llm-eval` harness, which used relative paths for tsx). Follow the alias style already used in `process-review.ts` and `zernio-ingest-shared.ts`.
- **Migration-structure-test convention:** mirror `src/lib/shared/__tests__/migration-050-structure.test.ts` / `migration-051-structure.test.ts` (readFileSync the `.sql`, whitespace-normalize, assert `ADD COLUMN IF NOT EXISTS`, additive/idempotent, no DROP). **Deviation for 052:** unlike 050/051 this migration intentionally contains ONE bounded backfill `UPDATE` — so the test asserts that UPDATE is present and bounded by `WHERE sentiment_label IS NULL`, and does NOT assert "no UPDATE."
- **Stale `.next/` caveat:** if `pnpm typecheck` errors on a `.next/types/**` file you didn't touch, `rm -rf .next` and re-run.
- **`.claude/CLAUDE.md` is orchestrator-only** (Wave 3 subagent self-mod guard) — implementer subagents must not edit it; the Task 4 CLAUDE.md note is done by the orchestrator.
- **Analytics:** do NOT emit a per-review `review_sentiment_classified` event in this PR (noisy, and KPI 5b reads the column, not events). No `docs/analytics/events.md` change → no `ci:analytics-events` impact.
- **Commit trailer:** every commit ends with
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

---

## The deterministic mapping (single source of truth — implement identically in SQL and TS)

| star_rating | label | score |
|---|---|---|
| 5 | positive | 1.0 |
| 4 | positive | 0.5 |
| 3 | neutral | 0.0 |
| 2 | negative | -0.5 |
| 1 | negative | -1.0 |
| NULL | neutral | 0.0 |

Score formula for a non-null star: `(star - 3) / 2`. Label: `star >= 4 → positive`, `star <= 2 → negative`, else `neutral`. `sentiment_source = 'deterministic_star_v1'` everywhere.

---

## File Structure

Created:
- `supabase/migrations/052_reviews_sentiment.sql`
- `src/lib/shared/__tests__/migration-052-structure.test.ts`
- `src/lib/reviews/sentiment.ts`
- `src/lib/reviews/__tests__/sentiment.test.ts`

Modified:
- `src/lib/reviews/process-review.ts` — classify + write sentiment at the NEW insert and the content-changed UPDATE.
- `src/lib/reviews/__tests__/process-review.test.ts` — assert sentiment is written at both sites.
- `worker/jobs/zernio/zernio-ingest-shared.ts` — classify + write sentiment in `insertImportedReview`.
- `worker/jobs/zernio/__tests__/*` (the test covering `insertImportedReview` / `reconcileExternallyAnsweredReview`) — assert sentiment is written.
- `docs/progresstracking.md` — note PR 5a (Task 4).
- `.claude/CLAUDE.md` — migration head 051→052 + sentiment note (Task 4, **orchestrator-only**).

---

### Task 1: Migration 052 + structure test

**Files:**
- Create: `supabase/migrations/052_reviews_sentiment.sql`
- Test: `src/lib/shared/__tests__/migration-052-structure.test.ts`

- [ ] **Step 1: Write the migration `supabase/migrations/052_reviews_sentiment.sql`**

```sql
-- 052_reviews_sentiment.sql
-- Wave 3 PR 5a: deterministic review sentiment.
-- Adds nullable sentiment_* columns to reviews (LLM-ready via sentiment_source),
-- a label domain CHECK, and a one-time star-based deterministic backfill.
-- Additive + idempotent. RLS already enabled on reviews (migration 001); the
-- existing reviews_owner_select policy covers the new columns.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_label TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_classified_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_source TEXT;

-- Label domain guard (idempotent via catalog check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_sentiment_label_check'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_sentiment_label_check
      CHECK (sentiment_label IS NULL OR sentiment_label IN ('positive', 'neutral', 'negative'));
  END IF;
END $$;

-- One-time deterministic backfill (star-based; matches src/lib/reviews/sentiment.ts).
-- Bounded by sentiment_label IS NULL so re-running the migration is a no-op.
UPDATE reviews
SET sentiment_label = CASE
      WHEN star_rating >= 4 THEN 'positive'
      WHEN star_rating <= 2 THEN 'negative'
      ELSE 'neutral'
    END,
    sentiment_score = CASE
      WHEN star_rating IS NULL THEN 0
      ELSE (LEAST(GREATEST(star_rating, 1), 5) - 3) / 2.0
    END,
    sentiment_classified_at = NOW(),
    sentiment_source = 'deterministic_star_v1'
WHERE sentiment_label IS NULL;
```

- [ ] **Step 2: Write the structure test `src/lib/shared/__tests__/migration-052-structure.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/052_reviews_sentiment.sql',
);

let sql: string;
let normalized: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

describe('migration 052 — reviews sentiment columns', () => {
  it.each([
    'sentiment_score NUMERIC',
    'sentiment_label TEXT',
    'sentiment_classified_at TIMESTAMPTZ',
    'sentiment_source TEXT',
  ])('adds nullable %s with IF NOT EXISTS', (column) => {
    const [name, type] = column.split(' ');
    expect(normalized).toContain(
      `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${name} ${type}`,
    );
  });

  it('adds all four columns idempotently', () => {
    const additions = sql.match(/ADD\s+COLUMN\b/gi) ?? [];
    const idempotent = sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
    expect(additions).toHaveLength(4);
    expect(idempotent).toHaveLength(4);
  });

  it('guards the label domain with a CHECK constraint', () => {
    expect(normalized).toContain('reviews_sentiment_label_check');
    expect(normalized).toMatch(
      /CHECK \(sentiment_label IS NULL OR sentiment_label IN \('positive', 'neutral', 'negative'\)\)/,
    );
  });

  it('adds the constraint idempotently (guarded by pg_constraint)', () => {
    expect(normalized).toContain("conname = 'reviews_sentiment_label_check'");
  });
});

describe('migration 052 — deterministic backfill', () => {
  it('backfills sentiment with the star-based mapping', () => {
    expect(normalized).toContain('UPDATE reviews');
    expect(normalized).toContain("sentiment_source = 'deterministic_star_v1'");
    expect(normalized).toContain('WHEN star_rating >= 4 THEN \'positive\'');
    expect(normalized).toContain('WHEN star_rating <= 2 THEN \'negative\'');
  });

  it('bounds the backfill so re-running is a no-op', () => {
    expect(normalized).toMatch(/WHERE sentiment_label IS NULL/);
  });

  it('does not drop or mutate unrelated structure', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    // The only UPDATE permitted is the bounded sentiment backfill.
    const updates = sql.match(/UPDATE\s+reviews/gi) ?? [];
    expect(updates).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run src/lib/shared/__tests__/migration-052-structure.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/052_reviews_sentiment.sql src/lib/shared/__tests__/migration-052-structure.test.ts
git commit -m "feat(sentiment): migration 052 — reviews sentiment columns + star backfill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Sentiment classifier module

**Files:**
- Create: `src/lib/reviews/sentiment.ts`
- Test: `src/lib/reviews/__tests__/sentiment.test.ts`

- [ ] **Step 1: Write the failing test `src/lib/reviews/__tests__/sentiment.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  classifySentiment,
  SENTIMENT_SOURCE,
  type SentimentClassification,
} from '../sentiment';

describe('classifySentiment', () => {
  it.each([
    [5, 'positive', 1],
    [4, 'positive', 0.5],
    [3, 'neutral', 0],
    [2, 'negative', -0.5],
    [1, 'negative', -1],
  ] as const)('star %i → %s (score %f)', (star, label, score) => {
    const result = classifySentiment(star);
    expect(result.label).toBe(label);
    expect(result.score).toBe(score);
    expect(result.source).toBe(SENTIMENT_SOURCE);
  });

  it('treats a null star rating as neutral with score 0', () => {
    const result = classifySentiment(null);
    expect(result).toEqual<SentimentClassification>({
      score: 0,
      label: 'neutral',
      source: SENTIMENT_SOURCE,
    });
  });

  it('clamps out-of-range ratings to the 1..5 band', () => {
    expect(classifySentiment(7).label).toBe('positive');
    expect(classifySentiment(0).label).toBe('negative');
  });

  it('uses the deterministic_star_v1 source tag', () => {
    expect(SENTIMENT_SOURCE).toBe('deterministic_star_v1');
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `pnpm vitest run src/lib/reviews/__tests__/sentiment.test.ts`
Expected: FAIL — cannot resolve `../sentiment`.

- [ ] **Step 3: Write `src/lib/reviews/sentiment.ts`**

```ts
// Deterministic review sentiment (v1). Star-rating driven so the SQL backfill
// in migration 052 and this ingest-path classifier produce identical results.
// `source` is recorded on reviews.sentiment_source; a later text/LLM classifier
// can supersede this with a new source tag and no schema change.

export type SentimentLabel = 'positive' | 'neutral' | 'negative';

export interface SentimentClassification {
  /** -1 (most negative) .. 1 (most positive). */
  score: number;
  label: SentimentLabel;
  source: string;
}

export const SENTIMENT_SOURCE = 'deterministic_star_v1';

/**
 * Classify a review from its star rating. A null rating (rating-less review)
 * is treated as neutral. Ratings outside 1..5 are clamped.
 */
export function classifySentiment(
  starRating: number | null,
): SentimentClassification {
  if (starRating == null) {
    return { score: 0, label: 'neutral', source: SENTIMENT_SOURCE };
  }

  const clamped = Math.min(Math.max(starRating, 1), 5);
  const score = (clamped - 3) / 2;
  const label: SentimentLabel =
    clamped >= 4 ? 'positive' : clamped <= 2 ? 'negative' : 'neutral';

  return { score, label, source: SENTIMENT_SOURCE };
}
```

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `pnpm vitest run src/lib/reviews/__tests__/sentiment.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck` — expect clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reviews/sentiment.ts src/lib/reviews/__tests__/sentiment.test.ts
git commit -m "feat(sentiment): deterministic star-based classifier (classifySentiment)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the classifier into all three review-content write sites

**Files:**
- Modify: `src/lib/reviews/process-review.ts`
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`
- Modify: `worker/jobs/zernio/zernio-ingest-shared.ts`
- Modify: the existing test covering `insertImportedReview` (find it: `worker/jobs/zernio/__tests__/` — likely the file exercising `reconcileExternallyAnsweredReview` / `insertImportedReview`; grep `insertImportedReview` and `external_reply_ingested_at` to locate it)

> **The multi-site rule:** review content is written at THREE sites. Sentiment must be computed and written at ALL THREE, or some ingest paths silently leave `sentiment_*` NULL:
> 1. `process-review.ts` NEW insert (~L56).
> 2. `process-review.ts` content-changed UPDATE (~L235).
> 3. `zernio-ingest-shared.ts` `insertImportedReview` INSERT (~L378) — bypasses `processReview` entirely (external-reply path).
> The two status-only writes (`process-review.ts` ~L198 deleted→new; `ZernioRecentReviewPoller.ts` ~L180 soft-delete) do NOT touch content and must NOT be changed.

- [ ] **Step 1: Add the import + classify in `process-review.ts`**

At the top with the other `@/lib/...` imports add:
```ts
import { classifySentiment } from '@/lib/reviews/sentiment';
```

In the NEW-insert branch (the `INSERT INTO reviews (...)` around L55), compute sentiment from the incoming review just before the insert:
```ts
const sentiment = classifySentiment(review.starRating);
```
and extend the column list + VALUES to include the four sentiment columns. The INSERT becomes (add the four columns at the end of the list, before the closing paren, and the matching values):
```ts
const inserted = await tx<{ id: string }[]>`
  INSERT INTO reviews (
    id, business_id, provider, provider_review_id,
    provider_review_name, provider_location_name,
    reviewer_name, star_rating, review_text, review_date,
    detected_language, review_content_hash, status, detected_at,
    sentiment_score, sentiment_label, sentiment_classified_at, sentiment_source
  ) VALUES (
    ${reviewId}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
    ${identity.providerReviewName}, ${identity.providerLocationName},
    ${review.reviewerName}, ${review.starRating}, ${review.reviewText}, ${review.reviewDate},
    ${review.detectedLanguage}, ${contentHash}, 'new', NOW(),
    ${sentiment.score}, ${sentiment.label}, NOW(), ${sentiment.source}
  )
  ON CONFLICT (provider, provider_review_name) DO NOTHING
  RETURNING id
`;
```

- [ ] **Step 2: Classify in the content-changed UPDATE in `process-review.ts`**

In `processExistingReview`, in the CONTENT-CHANGED block (the `UPDATE reviews SET reviewer_name = ... review_content_hash = ...` around L234), compute sentiment from the new content and add the four columns to the SET list:
```ts
const sentiment = classifySentiment(review.starRating);
await tx`
  UPDATE reviews
  SET reviewer_name = ${review.reviewerName},
      star_rating = ${review.starRating},
      review_text = ${review.reviewText},
      review_date = ${review.reviewDate},
      detected_language = ${review.detectedLanguage},
      review_content_hash = ${contentHash},
      sentiment_score = ${sentiment.score},
      sentiment_label = ${sentiment.label},
      sentiment_classified_at = NOW(),
      sentiment_source = ${sentiment.source},
      status = CASE WHEN status = 'deleted' THEN 'new' ELSE status END,
      detected_at = CASE WHEN status = 'deleted' THEN NOW() ELSE detected_at END
  WHERE id = ${existing.id}
`;
```
Do NOT touch the status-only UPDATE in the `existingHash === contentHash` branch (~L198).

- [ ] **Step 3: Classify in `insertImportedReview` (`zernio-ingest-shared.ts` ~L378)**

Add the import (match the file's existing import style — check whether it uses `@/lib/...` or a relative path and follow it):
```ts
import { classifySentiment } from '@/lib/reviews/sentiment';
```
Just before the `INSERT INTO reviews (...)`, compute sentiment from the imported review's star rating (use whatever local variable holds the star rating in that function — read the function to find it, e.g. `starRating`/`review.starRating`):
```ts
const sentiment = classifySentiment(<the star rating variable in this function>);
```
Add the four columns to the INSERT column list and VALUES (place them right after `external_reply_ingested_at` or wherever is cleanest in the existing list), e.g.:
```ts
  ...,
  external_reply_ingested_at,
  sentiment_score, sentiment_label, sentiment_classified_at, sentiment_source
)
VALUES (
  ...,
  NOW(),
  ${sentiment.score}, ${sentiment.label}, NOW(), ${sentiment.source}
)
ON CONFLICT (provider, provider_review_name) DO UPDATE SET id = reviews.id
```
Keep the existing `ON CONFLICT ... DO UPDATE SET id = reviews.id` exactly as-is (this path's conflict behavior is unrelated to sentiment — do not expand it to update sentiment on conflict; a re-import of an unchanged external-replied review should not churn sentiment).

- [ ] **Step 4: Add tests proving sentiment is written at the process-review sites**

In `src/lib/reviews/__tests__/process-review.test.ts`, follow the file's existing capture pattern (the `sql.begin` mock + `tx` tagged-template capture that other tests use to read query strings/params — reuse exactly that mechanism; do not invent a new one). Add:
- A test on the NEW-review path: a 5-star review's INSERT query string contains `sentiment_label` and `sentiment_source`, and the captured params include `'positive'` and `'deterministic_star_v1'`.
- A test on the content-changed path: when an existing review's content changes to a 1-star review, the content UPDATE query string contains `sentiment_label`, and the params include `'negative'`.
- A guard test: the status-only revival path (`deleted` → `new`, same hash) does NOT include `sentiment_label` in its UPDATE (sentiment untouched when content is unchanged).

Use the same fixture builder (`makeMonitoredReview`) already in the file; set `starRating` via its overrides (extend the builder if it doesn't expose `starRating`).

- [ ] **Step 5: Add a test proving sentiment is written in `insertImportedReview`**

In the zernio-ingest test file you located, follow that file's existing mock/capture pattern and add a test asserting the `INSERT INTO reviews` issued by `insertImportedReview` (via `reconcileExternallyAnsweredReview`) includes `sentiment_label`/`sentiment_source` and the params carry the star-derived label + `'deterministic_star_v1'`. If that file uses an integration-style harness rather than a query-capture mock, assert at the level that file already asserts at (match the established style).

- [ ] **Step 6: Run the affected suites**

Run: `pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts`
Run: `pnpm vitest run worker/jobs/zernio` (or the specific test file you edited)
Expected: PASS, including the new sentiment assertions and all pre-existing tests (no regressions).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck` — expect clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reviews/process-review.ts src/lib/reviews/__tests__/process-review.test.ts worker/jobs/zernio/zernio-ingest-shared.ts worker/jobs/zernio/__tests__/
git commit -m "feat(sentiment): classify on ingest at all three review-content write sites

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification + living docs + PR

**Files:**
- Modify: `docs/progresstracking.md`
- Modify: `.claude/CLAUDE.md` (**orchestrator-only**)

- [ ] **Step 1: Full verification**

Run: `pnpm test` — expect the whole suite green (new sentiment + migration + wiring tests included; no regressions).
Run: `pnpm typecheck` — clean. (Stale `.next/types/**` → `rm -rf .next` and re-run.)
Run: `pnpm build` — success.
Run: `pnpm ci:tenant-scope` — expect pass. NOTE: this PR adds columns to existing `reviews` queries in `process-review.ts` and `zernio-ingest-shared.ts`. The tenant-scope audit matches query SQL against allowlist `sqlSnippet`s; **adding columns to a tenant-table INSERT/UPDATE can break an existing allowlist snippet** (the Wave 2 lab note). If `ci:tenant-scope` fails with a "missing scope"/"unused allowlist entry" pair, update the affected allowlist entry's snippet in `scripts/ci/tenant-scope-allowlist.ts` to the new normalized SQL — after confirming each flagged query is still correctly `business_id`-scoped (these writes are inherently single-review, business-scoped; sentiment columns add no tenant surface). Run `pnpm ci:tenant-scope` locally, not just `pnpm lint`.

- [ ] **Step 2: Update `docs/progresstracking.md`** (Wave 3 section): add a PR 5a "what was done" note — migration 052 adds `reviews.sentiment_*`; deterministic star-based `classifySentiment` wired into the three ingest write sites; in-migration star backfill; LLM-ready via `sentiment_source`; KPI consumption + sentiment trend deferred to PR 5b. Update the PR table to add the 5a row. Move "sentiment classifier/backfill" out of the PR 5 deferred description, leaving "KPI reconciliation + trend" for 5b.

- [ ] **Step 3: Update `.claude/CLAUDE.md` (orchestrator-only)**

- Database section: bump "Current head: migration **051** (next: **052**)" → "Current head: migration **052** (next: **053**)".
- Add a one-line note (near the reviews/ingest or analytics area) that `reviews.sentiment_*` is populated by `classifySentiment` (`src/lib/reviews/sentiment.ts`, deterministic star-based `deterministic_star_v1`) at all three ingest write sites, backfilled in migration 052, LLM-ready via `sentiment_source`.

- [ ] **Step 4: Commit docs**

```bash
git add docs/progresstracking.md .claude/CLAUDE.md
git commit -m "docs: Wave 3 PR 5a — review sentiment schema + classifier

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin wave-3-pr5a-sentiment
gh pr create --base main --head wave-3-pr5a-sentiment \
  --title "Wave 3 · PR 5a — Review sentiment (schema + classifier + backfill)" \
  --body "$(cat <<'EOF'
## Summary
- Migration 052 adds nullable `reviews.sentiment_score / sentiment_label / sentiment_classified_at / sentiment_source` (+ label-domain CHECK) and a one-time, bounded, star-based deterministic backfill of existing reviews.
- `classifySentiment(starRating)` (`src/lib/reviews/sentiment.ts`) — deterministic v1, star-rating driven so the SQL backfill and the ingest path produce identical results. LLM-ready: `sentiment_source` lets a future text/LLM classifier supersede with no schema change.
- Wired into all THREE review-content write sites (new insert + content-changed update in `process-review.ts`, and `insertImportedReview` in `zernio-ingest-shared.ts` which bypasses processReview). Status-only writes are untouched.

## Notes
- Migration head 051 → 052. Off `main`; independent of PR 4. PR 5b (KPI reconciliation + sentiment trend) stacks on this branch.
- No per-review analytics event (KPI reads the column). Deferred: text/LLM classifier, KPI surface + dashboard cards, CSV export.

## Test plan
- `pnpm vitest run src/lib/reviews/__tests__/sentiment.test.ts src/lib/shared/__tests__/migration-052-structure.test.ts src/lib/reviews/__tests__/process-review.test.ts` + the zernio-ingest suite — green
- `pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm ci:tenant-scope` — green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage (Spec 11 sentiment section):**
- `reviews.sentiment_score / sentiment_label / sentiment_classified_at / sentiment_source` → Task 1.
- Worker-owned classification on ingest → Task 3 (all three write sites).
- Deterministic fallback using star rating → Task 2 (`classifySentiment`).
- Backfill existing reviews deterministically → Task 1 (in-migration star-based UPDATE).
- Labels positive/neutral/negative → Task 1 CHECK + Task 2 type.
- Optional LLM classifier later → enabled by `sentiment_source` (deferred per scope decision).
- Trend/index/KPI consumption → deferred to PR 5b (documented).

**Placeholder scan:** Task 1 & 2 are fully concrete. Task 3 Steps 4/5 describe test intent + exact assertions but defer the precise mock wiring to the file's established capture pattern (the harness is custom — `sql.begin` mock with `tx` query capture); the implementer must reuse it, not invent. Step 3 references "the star rating variable in this function" because the exact local name must be read from `insertImportedReview` — the implementer reads it. These are deliberate, bounded reads, not vague placeholders.

**Type consistency:** `SentimentClassification` / `SentimentLabel` / `SENTIMENT_SOURCE` / `classifySentiment` defined in Task 2 and used identically in Task 3. The SQL backfill mapping (Task 1) and the TS mapping (Task 2) implement the same table at the top of this plan — both are independently tested against it.
