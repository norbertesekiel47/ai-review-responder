import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/045_onboarding_demos_rls.sql'),
  'utf8',
);

describe('migration 045 - onboarding_demos RLS', () => {
  it('enables RLS on onboarding_demos', () => {
    expect(sql).toMatch(/ALTER TABLE onboarding_demos\s+ENABLE ROW LEVEL SECURITY/i);
  });

  it('adds a SELECT-only owner policy through the owning business account', () => {
    expect(sql).toMatch(
      /CREATE POLICY onboarding_demos_owner_select ON onboarding_demos\s+FOR SELECT TO authenticated\s+USING \(\s*user_id = \(SELECT id FROM users WHERE auth_id = auth\.uid\(\)::text\)\s+AND business_id IN \(SELECT id FROM businesses WHERE account_id = owner_account_id\(\)\)\s+\)/i,
    );
    expect(sql).not.toMatch(/onboarding_demos_owner_insert/i);
    expect(sql).not.toMatch(/onboarding_demos_owner_update/i);
    expect(sql).not.toMatch(/onboarding_demos_owner_delete/i);
  });
});
