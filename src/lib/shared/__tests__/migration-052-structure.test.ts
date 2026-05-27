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
    expect(normalized).not.toContain(`${name} ${type} NOT NULL`);
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

  it('scopes the constraint-existence guard to the reviews relation (conname is not globally unique)', () => {
    expect(normalized).toContain("t.relname = 'reviews'");
    expect(normalized).toContain('JOIN pg_class t ON t.oid = c.conrelid');
  });
});

describe('migration 052 — deterministic backfill', () => {
  it('backfills sentiment with the star-based mapping', () => {
    expect(normalized).toContain('UPDATE reviews');
    expect(normalized).toContain("sentiment_source = 'deterministic_star_v1'");
    expect(normalized).toContain('WHEN star_rating >= 4 THEN \'positive\'');
    expect(normalized).toContain('WHEN star_rating <= 2 THEN \'negative\'');
    expect(normalized).toContain("ELSE 'neutral'");
  });

  it('bounds the backfill so re-running is a no-op', () => {
    expect(normalized).toMatch(/WHERE sentiment_label IS NULL/);
  });

  it('does not drop or mutate unrelated structure', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    const updates = sql.match(/UPDATE\s+reviews/gi) ?? [];
    expect(updates).toHaveLength(1);
  });
});
