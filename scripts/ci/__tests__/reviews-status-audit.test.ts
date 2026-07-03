import { describe, it, expect } from 'vitest';
import { evaluateFindings, fileHasRawReviewStatusPredicate } from '../reviews-status-audit';

describe('reviews-status-audit', () => {
  it('flags review-status literals in reviews-table sql templates', () => {
    const src = "await sql`UPDATE reviews SET status = 'new' WHERE id = ${id}`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('ignores the same words outside reviews-table sql', () => {
    expect(fileHasRawReviewStatusPredicate(`const label = 'new';`)).toBe(false);
    expect(
      fileHasRawReviewStatusPredicate("await sql`UPDATE channel_enrollments SET status = 'failed'`;"),
    ).toBe(false);
  });

  it('honors the pragma', () => {
    const src =
      "await sql`UPDATE reviews SET status = 'new' -- review-status-ignore\n WHERE id = ${id}`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(false);
  });

  // ── additional coverage beyond the minimal spec ──

  it('detects a typed sql<Type[]> tagged template (Postgres.js type-argument form)', () => {
    const src = "const rows = sql<Row[]>`SELECT 1 FROM reviews WHERE status = 'deleted'`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('detects a tx-tagged template (sql.begin transaction scope)', () => {
    const src = "await tx`UPDATE reviews SET status = 'generating' WHERE id = ${id}`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('detects a db-tagged template (SqlExecutor client-or-transaction param convention)', () => {
    const src = "await db`UPDATE reviews SET status = 'deleted' WHERE id = ${id}`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('does NOT flag a single-status equality outside sql/tx templates entirely', () => {
    expect(fileHasRawReviewStatusPredicate(`if (review.status === 'posted') { doThing(); }`)).toBe(
      false,
    );
  });

  it('does NOT flag a reviews-mentioning sql template with no status comparison', () => {
    const src = 'await sql`SELECT id FROM reviews WHERE business_id = ${businessId}`;';
    expect(fileHasRawReviewStatusPredicate(src)).toBe(false);
  });

  it('honors the TS // review-status-ignore pragma on the preceding line', () => {
    const src =
      "// review-status-ignore: reason\nawait sql`UPDATE reviews SET status = 'approved' WHERE id = ${id}`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(false);
  });

  it('detects an IN(...) predicate against the review-status vocabulary', () => {
    const src =
      "await sql`SELECT id FROM reviews WHERE status IN ('new', 'generating')`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('flags a bare SECOND predicate even when the FIRST predicate in the template is pragma\'d', () => {
    // Every match must be walked with its own pragma check (mirrors the
    // outbox-topics audit) — a pragma on the first predicate must not
    // fail-open the rest of the template.
    const src = `await sql\`
      UPDATE reviews
      SET status = 'approved' -- review-status-ignore: transition guard
      WHERE status = 'pending_approval'
    \`;`;
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  // ── column attribution (reviews-alias qualifier allowlist) ──

  it('does NOT flag a foreign-qualified status predicate (resp.status) inside a reviews JOIN', () => {
    const src =
      "await sql`SELECT r.id FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE resp.status = 'posted'`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(false);
  });

  it('flags an r-qualified status predicate inside a reviews JOIN', () => {
    const src =
      "await sql`SELECT r.id FROM responses resp JOIN reviews r ON r.id = resp.review_id WHERE r.status = 'posted'`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('flags a reviews.status-qualified predicate', () => {
    const src = "await sql`SELECT id FROM reviews WHERE reviews.status = 'posted'`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('flags a rev-qualified predicate (dashboard/service.ts alias convention)', () => {
    const src = "await sql`SELECT rev.id FROM reviews rev WHERE rev.status <> 'deleted'`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  it('flags a bare status predicate in an UPDATE reviews template', () => {
    const src = "await sql`UPDATE reviews SET status = 'new' WHERE id = ${id}`;";
    expect(fileHasRawReviewStatusPredicate(src)).toBe(true);
  });

  // ── evaluateFindings (baseline ratchet) — mirrors process-env-audit.test.ts ──

  describe('evaluateFindings', () => {
    it('flags a NEW non-baseline file with a raw reviews.status literal', () => {
      const findings = evaluateFindings({
        matchingFiles: new Set(['src/lib/new-thing.ts']),
        baseline: new Set<string>(),
      });
      expect(findings.some((f) => f.includes('new-thing.ts'))).toBe(true);
    });

    it('flags a STALE baseline entry that no longer has a raw reviews.status literal', () => {
      const findings = evaluateFindings({
        matchingFiles: new Set<string>(),
        baseline: new Set(['src/lib/old-thing.ts']),
      });
      expect(findings.some((f) => f.includes('old-thing.ts') && f.toLowerCase().includes('stale'))).toBe(
        true,
      );
    });

    it('passes when a baseline file still has a raw reviews.status literal', () => {
      const findings = evaluateFindings({
        matchingFiles: new Set(['src/lib/kept.ts']),
        baseline: new Set(['src/lib/kept.ts']),
      });
      expect(findings).toEqual([]);
    });
  });
});
