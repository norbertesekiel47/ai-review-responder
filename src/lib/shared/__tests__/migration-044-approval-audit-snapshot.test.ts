import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/044_approval_audit_snapshot.sql'),
  'utf8',
);

describe('migration 044 - approval audit content snapshot', () => {
  it('adds nullable response_text_at_approval to approval_audit_log', () => {
    expect(sql).toMatch(
      /ALTER TABLE approval_audit_log\s+ADD COLUMN IF NOT EXISTS response_text_at_approval TEXT/i,
    );
  });

  it('documents snapshot semantics', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN approval_audit_log\.response_text_at_approval/i);
    expect(sql).toMatch(/immutable owner-approved response text/i);
  });

  it('does not add an HTML snapshot column without canonical rendering', () => {
    expect(sql).not.toMatch(/response_html_at_approval/i);
  });
});
