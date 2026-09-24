// Shape test for migration 125 (#1455) — mirrors migration-047's pattern for
// a pure data-backfill migration: `pnpm test:db:setup` provisions the shared
// test DB from every migration ONCE, out of band, so a live-DB suite asserts
// SCHEMA readiness rather than re-applying migration SQL at run time (see the
// shared schema-readiness test helper under src/lib/shared/__tests__/helpers/).
// This migration adds no schema object to assert — it is a one-time UPDATE —
// so this suite checks the checked-in SQL text instead, same as migration-047's
// precedent. It touches no database and opens no connection: plain file-text
// assertions only, not a live-DB suite.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/125_backfill_cancelled_at.sql'),
  'utf8',
);

// The executable statement only — excludes the header comment block, which
// mentions COALESCE/account_audit_log/subscription_activated_at in prose and
// would otherwise make an indexOf-based ordering check pass vacuously.
const statement = sql.slice(sql.indexOf('UPDATE accounts a'));

describe('migration 125 - backfill accounts.cancelled_at', () => {
  it('backfills cancelled_at via COALESCE of an audit-log subquery and subscription_activated_at', () => {
    expect(sql).toMatch(/UPDATE accounts a/i);
    expect(sql).toMatch(/SET cancelled_at = COALESCE\(/i);
    expect(sql).toMatch(/a\.subscription_activated_at/);
  });

  it('prefers the earliest cancellation audit-log event over subscription_activated_at', () => {
    // COALESCE's first argument wins when non-NULL — the audit-log subquery
    // must appear before the subscription_activated_at fallback.
    const coalesceIndex = statement.indexOf('COALESCE(');
    const subqueryIndex = statement.indexOf('account_audit_log');
    const fallbackIndex = statement.lastIndexOf('a.subscription_activated_at');
    expect(coalesceIndex).toBeGreaterThan(-1);
    expect(subqueryIndex).toBeGreaterThan(coalesceIndex);
    expect(fallbackIndex).toBeGreaterThan(subqueryIndex);
  });

  it("the audit-log subquery matches a transition INTO 'cancelled' by event_type and payload", () => {
    expect(sql).toMatch(/event_type = 'subscription_status_changed'/);
    expect(sql).toMatch(/payload\s*->>\s*'toStatus'\s*=\s*'cancelled'/);
    // MIN() over the matching rows — defensive earliest-wins, not MAX or a
    // bare unaggregated subquery that could return >1 row.
    expect(sql).toMatch(/SELECT\s+MIN\(l\.created_at\)/i);
  });

  it('only touches rows that are cancelled AND still missing cancelled_at (idempotent, never resets a set value)', () => {
    expect(sql).toMatch(/WHERE a\.subscription_status = 'cancelled'/);
    expect(sql).toMatch(/AND a\.cancelled_at IS NULL/);
  });

  it('never clears an already-set cancelled_at', () => {
    // Guard against a future edit dropping the IS NULL predicate, which would
    // reset the grace clock for accounts mid-grace (same guard as
    // migration-047's sibling test for past_due_at).
    expect(sql).not.toMatch(/SET cancelled_at = NULL/i);
  });

  it('adds no CHECK constraint — deliberately data-only (justified in the migration header)', () => {
    expect(sql).not.toMatch(/ADD CONSTRAINT/i);
    expect(sql).not.toMatch(/\bCHECK\s*\(/i);
  });
});
