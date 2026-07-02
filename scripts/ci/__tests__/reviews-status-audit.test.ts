import { describe, it, expect } from 'vitest';
import { fileHasRawReviewStatusPredicate } from '../reviews-status-audit';

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
});
