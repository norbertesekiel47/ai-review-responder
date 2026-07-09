// Shared guarded apply for migration 074 (WS4 trust dial + veto window),
// used by every integration suite that needs its columns/indexes on the
// shared test DB. Test-helper only — never imported by production code.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';

const MIGRATION_074_FILE = '074_trust_dial_veto_window.sql';

export function readMigration074Sql(): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', MIGRATION_074_FILE), 'utf-8');
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
}
