import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/047_backfill_past_due_at.sql'),
  'utf8',
);

describe('migration 047 - backfill past_due_at', () => {
  it('backfills past_due_at from updated_at for existing past_due accounts', () => {
    expect(sql).toMatch(/UPDATE accounts/i);
    expect(sql).toMatch(/SET past_due_at = updated_at/i);
  });

  it('only touches past_due accounts that have no past_due_at yet', () => {
    expect(sql).toMatch(/WHERE subscription_status = 'past_due'/i);
    expect(sql).toMatch(/AND past_due_at IS NULL/i);
  });

  it('does not clear or overwrite an already-set past_due_at', () => {
    // Guard against a future edit dropping the IS NULL predicate, which would
    // reset the grace clock for accounts mid-grace.
    expect(sql).not.toMatch(/SET past_due_at = NULL/i);
  });
});
