/**
 * Contacts read/delete repo (#541, contract #535 §5).
 * Domain module — receives its DB client explicitly (invariant #15).
 *
 * Contacts carry NO account_id: businesses.account_id is the single
 * authoritative owner of the business→account pairing, so every query here
 * joins businesses with `b.account_id = accountId` — the join IS the
 * account-scope check (invariant #8). Never trust the contact id alone.
 */

import type { Sql } from 'postgres';

export interface ContactListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  lastVisitDate: string;
  visitCount: number;
}

export const CONTACT_LIST_DEFAULT_LIMIT = 50;
export const CONTACT_LIST_MAX_LIMIT = 100;

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

  const rows = await sql<{
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
  `;

  const countRows = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total
    FROM solicitation_contacts c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.business_id = ${businessId} AND b.account_id = ${accountId}
  `;

  return {
    contacts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      lastVisitDate: row.last_visit_date,
      visitCount: row.visit_count,
    })),
    total: countRows[0]?.total ?? 0,
  };
}

/** §5 hard delete: removes the contact; its visits CASCADE via the composite
 *  FK. Returns false when the contact does not exist or is not owned by this
 *  account+business — callers map that to a uniform 404. */
export async function deleteContact(
  sql: Sql,
  accountId: string,
  businessId: string,
  contactId: string,
): Promise<boolean> {
  const deleted = await sql<{ id: string }[]>`
    DELETE FROM solicitation_contacts c
    USING businesses b
    WHERE c.id = ${contactId}
      AND c.business_id = ${businessId}
      AND b.id = c.business_id
      AND b.account_id = ${accountId}
    RETURNING c.id
  `;
  return deleted.length > 0;
}
