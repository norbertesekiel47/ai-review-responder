import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEMO_GENERATION_STATUS,
  NO_DEMO_SENTINEL_STATUS,
} from '../types';

// #1104: `PaywallWithDemoClient` branches on a status ('skipped') that
// migration 032's CHECK does not allow. The resolution is that the status is a
// page-synthesized VIEW state, never a row — this suite pins both halves of
// that fact so the constant, the CHECK, and the sentinel cannot drift apart
// silently again.

const MIGRATION_PATH = resolve(process.cwd(), 'supabase/migrations/032_onboarding_demos.sql');

function checkedStatuses(): string[] {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8').replace(/\s+/g, ' ');
  const list = sql.match(/CHECK \(generation_status IN \(([^)]+)\)\)/)?.[1];
  if (!list) throw new Error('migration 032: generation_status CHECK not found');
  return list.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

describe('onboarding_demos.generation_status contract (#1104)', () => {
  it('DEMO_GENERATION_STATUS is byte-for-byte the CHECK list in migration 032', () => {
    expect([...Object.values(DEMO_GENERATION_STATUS)].sort()).toEqual(
      [...checkedStatuses()].sort(),
    );
  });

  it('the no-demo sentinel is a view state: absent from the CHECK, absent from the persisted set', () => {
    expect(checkedStatuses()).not.toContain(NO_DEMO_SENTINEL_STATUS);
    expect(Object.values<string>(DEMO_GENERATION_STATUS)).not.toContain(NO_DEMO_SENTINEL_STATUS);
  });
});
