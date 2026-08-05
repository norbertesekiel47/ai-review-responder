import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { normalizeEmail } from '@/lib/solicitation/handles';
import {
  recordSuppression,
  type SuppressionScope,
  type SuppressionSource,
} from '@/lib/solicitation/suppression';

/**
 * The admin-owned Suppression ledger paths (#645; locked spec
 * docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.3,
 * §8.2). Cross-tenant by design and admin-only by authorization: G14 notes that
 * `recordSuppression`'s `createdByUserId` is a plain string the type cannot
 * prove is an admin — THIS module's callers own that proof, and they are the
 * two `requireAdminWithAal2` routes in src/app/api/admin/suppressions.
 *
 * The Correction path is error correction, NEVER re-subscribe: it has no owner
 * entry point, no recipient entry point, and no self-serve surface anywhere.
 *
 * Born-injected (invariant #15): `sql`/`tx` is a parameter, never an import —
 * the composition roots (the two route handlers) supply the singleton.
 */

export interface AdminSuppressionRow {
  id: string;
  channel: string;
  normalizedHandle: string;
  scope: SuppressionScope;
  source: SuppressionSource;
  accountId: string | null;
  accountName: string | null;
  createdByUserId: string | null;
  note: string | null;
  suppressedAt: string;
}

export interface AdminSuppressionCorrectionRow {
  id: string;
  suppressionId: string;
  scope: SuppressionScope;
  source: SuppressionSource;
  removedByUserId: string;
  reason: string;
  createdAt: string;
}

export type LookupSuppressionsResult =
  | {
      ok: true;
      handle: string;
      rows: AdminSuppressionRow[];
      corrections: AdminSuppressionCorrectionRow[];
    }
  | { ok: false; error: 'invalid_handle' };

/**
 * Every live ledger row for one Normalized handle, plus the Correction path
 * records for it, so a re-entry after a correction is visible rather than a
 * surprise. Admin-only: the rows name accounts across every tenant.
 */
export async function lookupSuppressions(
  sql: Sql,
  rawEmail: string,
): Promise<LookupSuppressionsResult> {
  const handle = normalizeEmail(rawEmail);
  // Refused BEFORE either query is issued: these reads cross every tenant, so
  // an unnormalizable input must never reach the database at all.
  if (handle === null) return { ok: false, error: 'invalid_handle' };

  const [rows, corrections] = await Promise.all([
    sql<{
      id: string;
      channel: string;
      normalized_handle: string;
      scope: SuppressionScope;
      source: SuppressionSource;
      account_id: string | null;
      account_name: string | null;
      created_by_user_id: string | null;
      note: string | null;
      suppressed_at: string;
    }[]>`
      SELECT s.id, s.channel, s.normalized_handle, s.scope, s.source,
             s.account_id, a.display_name AS account_name,
             s.created_by_user_id, s.note, s.suppressed_at::text
      FROM solicitation_suppressions s
      LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.channel = 'email' AND s.normalized_handle = ${handle}
      ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC
    `,
    sql<{
      id: string;
      suppression_id: string;
      scope: SuppressionScope;
      source: SuppressionSource;
      removed_by_user_id: string;
      reason: string;
      created_at: string;
    }[]>`
      SELECT id, suppression_id, scope, source, removed_by_user_id, reason,
             created_at::text
      FROM solicitation_suppression_corrections
      WHERE channel = 'email' AND normalized_handle = ${handle}
      ORDER BY created_at DESC
      LIMIT 20
    `,
  ]);

  return {
    ok: true,
    handle,
    rows: rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      normalizedHandle: row.normalized_handle,
      scope: row.scope,
      source: row.source,
      accountId: row.account_id,
      accountName: row.account_name,
      createdByUserId: row.created_by_user_id,
      note: row.note,
      suppressedAt: row.suppressed_at,
    })),
    corrections: corrections.map((row) => ({
      id: row.id,
      suppressionId: row.suppression_id,
      scope: row.scope,
      source: row.source,
      removedByUserId: row.removed_by_user_id,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}

export type RecordAdminManualResult =
  | { ok: true; created: boolean; handle: string }
  | { ok: false; error: 'invalid_handle' };

/**
 * §7.3. Takes RAW input — this is the only suppression path that does, because
 * every other one reads an already-normalized handle off a stored row — and
 * REJECTS an address that fails normalization rather than minting a wrong
 * handle (the handles.ts posture). `created` is false when an existing global
 * row won the first-write-wins race (§2.1): a no-op success, not an error.
 *
 * `accountId` is deliberately null: a mailbox reply names no account, and
 * guessing one would write false provenance into a compliance record.
 */
export async function recordAdminManualSuppression(
  tx: TransactionSql,
  input: { rawEmail: string; adminUserId: string; note: string },
): Promise<RecordAdminManualResult> {
  const handle = normalizeEmail(input.rawEmail);
  if (handle === null) return { ok: false, error: 'invalid_handle' };

  const id = await recordSuppression(tx, {
    scope: 'global',
    channel: 'email',
    normalizedHandle: handle,
    accountId: null,
    source: 'admin_manual',
    createdByUserId: input.adminUserId,
    note: input.note,
  });

  return { ok: true, created: id !== null, handle };
}

export type CorrectSuppressionResult = 'corrected' | 'not_found';

/**
 * §8.2, as ONE statement (P-9). The data-modifying CTE makes atomicity
 * structural: an INSERT failure — a blank reason hitting the CHECK, a type
 * violation, anything — aborts the whole statement, so the DELETE cannot commit
 * without its audit record even if a call site forgot a transaction. The
 * delete-then-insert version was atomic only if every caller remembered
 * `sql.begin`, and no test that supplies its own transaction can prove a
 * production call site did.
 *
 * The record is built from the DELETE's RETURNING, never from a row read
 * earlier, so a concurrent correction cannot produce a record describing a row
 * this call did not remove: exactly one caller's DELETE matches, the other
 * returns zero rows and writes nothing.
 *
 * The RETURNING carries the removed row's `account_id`, `created_by_user_id`
 * and `note` through into the record (D-A11). They are the evidence the removed
 * assertion was legitimate — for a `scope='account'` row `account_id` IS the
 * Suppression scope key (§1.2), and `created_by_user_id` + `note` are what §7.3
 * requires of a manual entry. Nothing can backfill them afterwards, because the
 * row they came from is what this statement deletes.
 *
 * Takes `Sql | TransactionSql` because it no longer needs an outer transaction
 * to be correct — it composes into one if a caller has one, and is safe alone.
 *
 * Error correction, NEVER re-subscribe: the row is removed because it was
 * factually wrong, not because anybody opted back in.
 */
export async function correctSuppression(
  db: Sql | TransactionSql,
  input: { suppressionId: string; adminUserId: string; reason: string },
): Promise<CorrectSuppressionResult> {
  const written = await db<{ suppression_id: string }[]>`
    WITH removed AS (
      DELETE FROM solicitation_suppressions
      WHERE id = ${input.suppressionId}::uuid
      RETURNING id, channel, normalized_handle, scope, account_id, source,
                suppressed_at, created_by_user_id, note
    )
    INSERT INTO solicitation_suppression_corrections
      (id, suppression_id, channel, normalized_handle, scope, account_id,
       source, suppressed_at, created_by_user_id, note, removed_by_user_id,
       reason)
    SELECT ${uuidv7()}, removed.id, removed.channel, removed.normalized_handle,
           removed.scope, removed.account_id, removed.source,
           removed.suppressed_at, removed.created_by_user_id, removed.note,
           ${input.adminUserId}::uuid, ${input.reason}
    FROM removed
    RETURNING suppression_id
  `;

  // Zero rows means the DELETE matched nothing: no row removed, no orphan
  // record written. There is no third outcome.
  return written.length === 0 ? 'not_found' : 'corrected';
}
