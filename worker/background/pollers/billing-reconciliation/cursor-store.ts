// worker/background/pollers/billing-reconciliation/cursor-store.ts
//
// Durable keyset resume cursor for background pollers (migration 079). One row
// per poller in poller_cursors. Owns the read/write shape of that table so the
// poller never inlines the table's SQL — including the write-sequence CAS that
// makes cursor persistence provably ordered under a non-cancelling deadline
// (ADR 0006).
//
// Takes `sql` as an explicit parameter (invariant #15 — domain modules never
// import @/lib/db/server; the poller composition root passes its singleton in).

import type { Sql } from 'postgres';

export interface PollerCursor {
  cursor: string | null;
  writeSeq: number;
}

interface PollerCursorRow {
  cursor: string | null;
  write_seq: number | string;
}

/**
 * Load a poller's persisted cursor + write sequence. Returns the rotation-start
 * default ({ cursor: null, writeSeq: 0 }) when no row exists yet, so a
 * never-run poller and a freshly-migrated table behave identically.
 *
 * The poller seeds its in-memory writeSeq from the returned writeSeq at boot so
 * the first post-restart save carries a strictly-higher seq than the persisted
 * one and is never rejected by the CAS.
 */
export async function loadCursor(sql: Sql, pollerName: string): Promise<PollerCursor> {
  const rows = await sql<PollerCursorRow[]>`
    SELECT cursor, write_seq
    FROM poller_cursors
    WHERE poller_name = ${pollerName}
  `;
  const row = rows[0];
  if (!row) {
    return { cursor: null, writeSeq: 0 };
  }
  return { cursor: row.cursor, writeSeq: Number(row.write_seq) };
}

/**
 * Persist a poller's cursor under a write-sequence CAS (ADR 0006). The UPSERT
 * applies only WHERE EXCLUDED.write_seq > poller_cursors.write_seq, so a
 * stale/detached/reordered save — which withTimeout can produce because it
 * races rather than cancels — carries a lower seq and is a no-op at the DB.
 *
 * Callers assign `writeSeq` monotonically in submission order (synchronously,
 * before awaiting), so the highest-seq write that lands always reflects the
 * latest-submitted intent. Cadence-, rotation-, and cancellation-independent.
 */
export async function saveCursor(
  sql: Sql,
  pollerName: string,
  cursor: string | null,
  writeSeq: number,
): Promise<void> {
  await sql`
    INSERT INTO poller_cursors (poller_name, cursor, write_seq, updated_at)
    VALUES (${pollerName}, ${cursor}::uuid, ${writeSeq}, NOW())
    ON CONFLICT (poller_name) DO UPDATE
      SET cursor = EXCLUDED.cursor,
          write_seq = EXCLUDED.write_seq,
          updated_at = NOW()
      WHERE EXCLUDED.write_seq > poller_cursors.write_seq
  `;
}
