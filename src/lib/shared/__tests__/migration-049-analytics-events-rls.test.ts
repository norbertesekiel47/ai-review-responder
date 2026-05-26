import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/049_analytics_events_rls.sql'),
  'utf8',
);

describe('migration 049 - analytics_events RLS', () => {
  it('enables row level security on analytics_events', () => {
    // Every other table-creating migration enables RLS; analytics_events (046)
    // shipped without it, leaving the table anon-readable via PostgREST.
    expect(sql).toMatch(/ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY/i);
  });

  it('is re-runnable / does not define an anon-readable policy', () => {
    // Deny-all-by-default is intended: server code reaches the table via the
    // RLS-bypassing postgres role, never supabase-js anon/authenticated.
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});
