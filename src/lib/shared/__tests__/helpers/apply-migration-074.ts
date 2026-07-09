// Shared guarded apply for migration 074 (WS4 trust dial + veto window),
// used by every integration suite that needs its columns/indexes on the
// shared test DB. Test-helper only — never imported by production code.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';

const MIGRATION_074_FILE = '074_trust_dial_veto_window.sql';

// Advisory-lock key serializing every 074 DDL apply across parallel vitest
// files. The re-apply's DROP/CREATE INDEX takes ACCESS EXCLUSIVE locks on four
// shared tables; racing it against sibling DB suites produced nondeterministic
// 40P01 deadlocks in full-suite runs. hashtext() of this literal on both apply
// sites (guarded helper + the double-apply test) is the serialization point.
export const MIGRATION_074_APPLY_LOCK_KEY = 'repworth_migration_074_apply';

export function readMigration074Sql(): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_074_FILE), 'utf-8');
}

/** Runs `fn` while holding the cross-suite 074-apply advisory lock. */
export async function withMigration074ApplyLock<T>(
  db: postgres.Sql,
  fn: () => Promise<T>,
): Promise<T> {
  await db`SELECT pg_advisory_lock(hashtext(${MIGRATION_074_APPLY_LOCK_KEY}))`;
  try {
    return await fn();
  } finally {
    await db`SELECT pg_advisory_unlock(hashtext(${MIGRATION_074_APPLY_LOCK_KEY}))`;
  }
}

/**
 * Applies migration 074 only when it hasn't landed yet — an unconditional
 * re-apply takes ACCESS EXCLUSIVE locks that contend with parallel suites.
 * The probe index is the migration's LAST statement, and every sanctioned
 * apply path runs the file as one transaction, so its presence implies the
 * full migration. (The 074 shape suite's dedicated double-apply test still
 * re-applies unconditionally to prove re-runnability.)
 */
export async function applyMigration074IfMissing(db: postgres.Sql): Promise<void> {
  await withMigration074ApplyLock(db, async () => {
    // Probe INSIDE the lock so a concurrent first-run can't double-apply.
    const [applied] = await db<{ applied: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'notification_deliveries'
          AND indexname = 'notification_deliveries_pending_post_notice_claim'
      ) AS applied
    `;
    if (!applied?.applied) {
      await db.unsafe(readMigration074Sql());
    }
  });
}
