/**
 * Contacts read/delete repo (#541, contract #535 §5).
 * Domain module — receives its DB client explicitly (invariant #15).
 *
 * Contacts carry NO account_id: businesses.account_id is the single
 * authoritative owner of the business→account pairing, so every query here
 * joins businesses with `b.account_id = accountId` — the join IS the
 * account-scope check (invariant #8). Never trust the contact id alone.
 */

import type { Sql, TransactionSql } from 'postgres';
import { writeAccountAuditLog } from '@/lib/audit/log';
import {
  recordSuppression,
  suppressionMatchSql,
  toSuppressionDisplay,
  type SuppressionDisplay,
} from './suppression';

export interface ContactListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  lastVisitDate: string;
  visitCount: number;
  /** §7.4 display state, or null when this contact is contactable. */
  suppression: SuppressionDisplay | null;
}

const CONTACT_LIST_DEFAULT_LIMIT = 50;
const CONTACT_LIST_MAX_LIMIT = 100;

/** Single owner of the page-bounds rule: limit defaults to 50 and is clamped
 *  to [1, 100]; offset is clamped to >= 0. Non-finite input falls back to the
 *  defaults, so callers may pass raw parsed query params. */
export function clampContactListPage(page: { limit: number; offset: number }): {
  limit: number;
  offset: number;
} {
  const limit = Number.isFinite(page.limit)
    ? Math.min(Math.max(Math.trunc(page.limit), 1), CONTACT_LIST_MAX_LIMIT)
    : CONTACT_LIST_DEFAULT_LIMIT;
  const offset = Number.isFinite(page.offset) ? Math.max(Math.trunc(page.offset), 0) : 0;
  return { limit, offset };
}

/**
 * The §7.4 read, scoped to the handles on ONE page.
 *
 * Deliberately a second round trip rather than a LATERAL inside the page query.
 * Joined into the page's pre-aggregation tree, the ledger probe is driven by the
 * business's whole `contacts x visits` row count — thousands of index lookups to
 * render fifty rows, against a table that has no TTL and only grows. Here it
 * runs once per DISTINCT handle the owner is about to see, so the cost is
 * bounded by the page size (<= 100) and not by history.
 *
 * `suppressionMatchSql` stays the ONE owner of the §1.2 lookup (G7): the
 * fragment is composed, never re-spelled, so this probe and the dispatch gate
 * remain a single predicate. Handles arrive already normalized (contacts store
 * the output of normalizeEmail at CSV parse), so nothing is re-normalized here.
 */
async function readPageSuppressionScopes(
  sql: Sql,
  accountId: string,
  handles: (string | null)[],
): Promise<Map<string, { scope: string }>> {
  const scopes = new Map<string, { scope: string }>();
  // A phone-only contact has no email handle and matches no row by definition;
  // it never reaches the ledger at all.
  const distinct = Array.from(
    new Set(handles.filter((handle): handle is string => handle !== null)),
  );
  if (distinct.length === 0) return scopes;

  const rows = await sql<{ handle: string; scope: string | null }[]>`
    SELECT h.handle, suppression.scope
    FROM unnest(${distinct}::text[]) AS h(handle)
    LEFT JOIN LATERAL (
      ${suppressionMatchSql(sql, sql`h.handle`, accountId, 'email')}
    ) suppression ON TRUE
  `;

  for (const row of rows) {
    if (row.scope !== null) scopes.set(row.handle, { scope: row.scope });
  }
  return scopes;
}

/** Bounded page of contacts ordered by most recent visit (then id for a
 *  stable tie-break). Every contact has >= 1 visit by construction (ingest
 *  writes contact + visit together), so the INNER JOIN drops nothing. */
export async function listContacts(
  sql: Sql,
  accountId: string,
  businessId: string,
  page: { limit: number; offset: number },
): Promise<{ contacts: ContactListItem[]; total: number }> {
  const { limit, offset } = clampContactListPage(page);

  // Independent reads on the pooled client (no transaction to order them) —
  // run the page and the count concurrently.
  const [rows, countRows] = await Promise.all([
    sql<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      last_visit_date: string;
      visit_count: number;
    }[]>`
      SELECT c.id, c.name, c.email, c.phone,
             MAX(v.visit_date)::text AS last_visit_date,
             COUNT(v.id)::int AS visit_count
      FROM solicitation_contacts c
      JOIN solicitation_visits v ON v.contact_id = c.id AND v.business_id = ${businessId}
      JOIN businesses b ON b.id = c.business_id
      WHERE c.business_id = ${businessId} AND b.account_id = ${accountId}
      GROUP BY c.id
      ORDER BY MAX(v.visit_date) DESC, c.id
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total
      FROM solicitation_contacts c
      JOIN businesses b ON b.id = c.business_id
      WHERE c.business_id = ${businessId} AND b.account_id = ${accountId}
    `,
  ]);

  // Ordered after the page, not beside it: the probe's input IS the page.
  const suppressionScopes = await readPageSuppressionScopes(
    sql,
    accountId,
    rows.map((row) => row.email),
  );

  return {
    contacts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      lastVisitDate: row.last_visit_date,
      visitCount: row.visit_count,
      // The §7.4 seam is where `account_id` and `source` stop: only the closed
      // four-key display object reaches an owner surface.
      suppression: toSuppressionDisplay(
        row.email === null ? null : suppressionScopes.get(row.email) ?? null,
      ),
    })),
    total: countRows[0]?.total ?? 0,
  };
}

/** §5 hard delete: removes the contact; its visits CASCADE via the composite
 *  FK, and its consent-ledger rows are swept in the same transaction (#625
 *  spec §7.1). Returns false when the contact does not exist or is not owned
 *  by this account+business — callers map that to a uniform 404. */
export async function deleteContact(
  sql: Sql,
  accountId: string,
  businessId: string,
  contactId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const deleted = await tx<{ id: string; email: string | null }[]>`
      DELETE FROM solicitation_contacts c
      USING businesses b
      WHERE c.id = ${contactId}
        AND c.business_id = ${businessId}
        AND b.id = c.business_id
        AND b.account_id = ${accountId}
      RETURNING c.id, c.email
    `;
    const [row] = deleted;
    if (row === undefined) return false;
    // §7.1: consent fails closed (DR1) — a retained row would be a residual
    // record of a deleted person AND would silently grant consent on a future
    // re-upload of the same handle. No FK reaches solicitation_consent
    // (handle-keyed by design), so this sweep is the ONLY per-contact deleter.
    // Handle-wide (all channels — deliberately no channel predicate); contacts
    // store the normalized email (normalized at CSV parse), so c.email IS the
    // normalized_handle.
    if (row.email !== null) {
      await tx`
        DELETE FROM solicitation_consent
        WHERE normalized_handle = ${row.email}
          AND business_id = ${businessId}
      `;
    }
    return true;
  });
}

/** The account-scoped contact lookup both owner suppression paths open with:
 *  the `businesses` join IS the account-scope check (invariant #8), so a
 *  foreign contact is indistinguishable from a missing one. */
async function readOwnedContactHandle(
  tx: TransactionSql,
  input: { accountId: string; businessId: string; contactId: string },
): Promise<{ email: string | null } | undefined> {
  const rows = await tx<{ email: string | null }[]>`
    SELECT c.email
    FROM solicitation_contacts c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.id = ${input.contactId}
      AND c.business_id = ${input.businessId}
      AND b.account_id = ${input.accountId}
  `;
  return rows[0];
}

export interface OwnerSuppressionInput {
  accountId: string;
  businessId: string;
  contactId: string;
  actorUserId: string;
}

export type MarkDoNotContactResult =
  | 'marked'
  | 'already_marked'
  | 'not_found'
  | 'no_email_handle';

/**
 * §7.5. The owner is the liable sender under CAN-SPAM even when we send on
 * their behalf, so they get a mechanism to stop mail going out under their own
 * name. Writes `scope='account'` — global would let one owner silently degrade
 * every other tenant's reach with no recipient having spoken (§1.2), and the
 * one-directional pairing CHECK refuses that combination anyway.
 *
 * Keyed on the Normalized handle, never the contact row id: delete-and-
 * re-upload must not launder it (#535 §6).
 *
 * Deliberately writes NO audit-log row: creation already emits the §9.4
 * `solicitation_suppressed` analytics event inside `recordSuppression`'s
 * transaction. Deletion emits nothing, which is why clearing gets one.
 */
export async function markContactDoNotContact(
  sql: Sql,
  input: OwnerSuppressionInput,
): Promise<MarkDoNotContactResult> {
  return sql.begin(async (tx): Promise<MarkDoNotContactResult> => {
    const row = await readOwnedContactHandle(tx, input);
    if (row === undefined) return 'not_found';
    if (row.email === null) return 'no_email_handle';

    const id = await recordSuppression(tx, {
      scope: 'account',
      channel: 'email',
      normalizedHandle: row.email,
      accountId: input.accountId,
      source: 'owner_manual',
      createdByUserId: input.actorUserId,
    });
    // First-write-wins (§2.1): a repeat is a no-op against the account partial
    // unique index, not an error.
    return id === null ? 'already_marked' : 'marked';
  });
}

export type ClearDoNotContactResult =
  | 'cleared'
  | 'not_marked'
  | 'not_found'
  | 'no_email_handle';

/**
 * §7.6. An owner may remove a row THEY created — their own preference about
 * their own customer, no recipient ever spoke. The `scope = 'account' AND
 * account_id = <caller's>` predicate is what makes "an owner may never clear a
 * global row" unreachable rather than merely unimplemented: there is no input
 * to this function that reaches one. This is emphatically NOT re-subscribe
 * (§8.1), and the Correction path (§8.2) is a different act with a different
 * sink.
 *
 * The audit row is here and not on the marking path because creation already
 * emits the §9.4 `solicitation_suppressed` analytics event inside
 * recordSuppression's transaction, and deletion emits nothing. It shares the
 * DELETE's transaction, so a failed audit write keeps the suppression: failing
 * safe on this path means KEEPING the opt-out.
 */
export async function clearContactDoNotContact(
  sql: Sql,
  input: OwnerSuppressionInput,
): Promise<ClearDoNotContactResult> {
  return sql.begin(async (tx): Promise<ClearDoNotContactResult> => {
    const row = await readOwnedContactHandle(tx, input);
    if (row === undefined) return 'not_found';
    if (row.email === null) return 'no_email_handle';

    // The removed row is the ONLY place the marker's identity still exists: this
    // DELETE is the last read of it, and afterwards nothing in the system can
    // answer "who put this here?". The Correction path snapshots exactly this
    // evidence into its record (D-A11); an owner clear is the other removal path
    // and gets the same treatment, or the two disagree about what a removal is
    // worth remembering. `suppressed_at` comes back as ::text so the audit keeps
    // full microsecond precision instead of a JS Date's truncated milliseconds.
    const deleted = await tx<{
      id: string;
      created_by_user_id: string | null;
      suppressed_at: string;
    }[]>`
      DELETE FROM solicitation_suppressions
      WHERE channel = 'email'
        AND normalized_handle = ${row.email}
        AND scope = 'account'
        AND account_id = ${input.accountId}::uuid
      RETURNING id, created_by_user_id, suppressed_at::text AS suppressed_at
    `;
    const removed = deleted[0];
    if (removed === undefined) return 'not_marked';

    await writeAccountAuditLog(tx, {
      accountId: input.accountId,
      locationId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: 'solicitation_do_not_contact_cleared',
      entityType: 'solicitation_suppression',
      entityId: removed.id,
      // NEVER the Normalized handle (§9.5) — the entity id is the correlation
      // key. Who marked it and when are user/account facts, not recipient
      // identity, so they are safe here and are what makes the entry readable
      // without a ledger row to join back to.
      payload: {
        channel: 'email',
        scope: 'account',
        markedByUserId: removed.created_by_user_id,
        markedAt: removed.suppressed_at,
      },
    });

    return 'cleared';
  });
}
