import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/050_api_costs_metadata.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

describe('migration 050 — api_costs metadata columns', () => {
  it.each([
    'system_prompt_hash TEXT',
    'prompt_version TEXT',
    'latency_ms INTEGER',
    'moderation_score NUMERIC',
    'moderation_categories JSONB',
    'flag_reason TEXT',
    'output_excerpt TEXT',
  ])('adds nullable %s', (column) => {
    const [name, type] = column.split(' ');
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      `ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS ${name} ${type}`,
    );
  });

  it('adds flagged BOOLEAN NOT NULL DEFAULT FALSE', () => {
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'ALTER TABLE api_costs ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE',
    );
  });
});

describe('migration 050 — scope discipline (PR 2 only)', () => {
  it('does not create flagged_responses (deferred to PR 3)', () => {
    expect(sql).not.toMatch(/CREATE\s+TABLE\b[^;]*\bflagged_responses\b/i);
  });

  it('does not add reviews.sentiment columns (deferred to PR 5)', () => {
    expect(sql).not.toMatch(/sentiment_score/i);
    expect(sql).not.toMatch(/sentiment_label/i);
  });
});

describe('migration 050 — additive and idempotent', () => {
  it('uses IF NOT EXISTS for every added column', () => {
    const additions = sql.match(/ADD\s+COLUMN\b/gi) ?? [];
    const idempotent = sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi) ?? [];
    expect(additions.length).toBe(8);
    expect(idempotent).toHaveLength(additions.length);
  });

  it('does not drop or mutate data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+/im);
    expect(sql).not.toMatch(/^\s*INSERT\s+/im);
  });
});
