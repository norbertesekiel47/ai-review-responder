import type { Sql, TransactionSql } from 'postgres';

/**
 * The Attested postal address (#656; locked spec
 * docs/superpowers/specs/2026-07-28-sender-deliverability-design.md §7.5/§7.6,
 * amended by docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md).
 *
 * Sole owner of five facts, so no call site re-derives them:
 *  1. The attestation TEXT and its VERSION — the compliance record of what the
 *     owner assented to.
 *  2. The light lint (§7.5) and the single normalization the stored bytes go
 *     through, because the address is baked into the ask footer VERBATIM.
 *  3. The atomic attestation write: ONE account-scoped UPDATE that also carries
 *     the actor-membership predicate.
 *  4. The owner-facing read model (settings surface).
 *  5. The Send handoff's location-level withheld reason, first-match.
 *
 * Deliberately NOT part of `src/lib/solicitation/attestation.ts`. That module
 * owns the CONSENT attestation — a different fact, a different table, and its
 * own version namespace (`CONSENT_ATTESTATION_VERSION`,
 * `SEND_ELIGIBLE_ATTESTATION_VERSIONS`). Two independently-versioned
 * attestations behind one interface silently authorizes or blocks sends. The
 * two are never cross-referenced.
 *
 * Invariant #15: every function here takes its DB client as an explicit
 * parameter. This module never imports `@/lib/db/server` — the composition
 * roots (the settings route, the profile page) pass it down.
 */

type SqlExecutor = Sql | TransactionSql;

/**
 * Versioned attestation text. Precedent: src/lib/solicitation/attestation.ts,
 * which owns the CONSENT attestation — a DIFFERENT fact with its own version
 * namespace. Never cross-reference the two.
 *
 * Stored on every attested row: "which text does this attestation cover" is a
 * query, not a guess.
 */
export const POSTAL_ADDRESS_ATTESTATION_VERSION = 'postal_address_attestation_v1' as const;

/**
 * Spec §7.5 verbatim — the checkbox label AND the stored record of what was
 * agreed. Changing the wording MUST bump the version above. Deliberately a code
 * constant, never an env var: staging and prod must agree on what an owner
 * assented to.
 */
export const POSTAL_ADDRESS_ATTESTATION_TEXT =
  'This is a valid physical postal address or USPS-registered PO box for this business.' as const;

export type PostalAddressLintReason = 'empty' | 'single_line' | 'no_postal_code';

export type PostalAddressLintResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: PostalAddressLintReason };

/**
 * A US postal code on the LAST non-empty line: five digits, optionally ZIP+4.
 * The `\b` on both sides is what stops a longer digit run (a phone number, a
 * nine-digit account number) reading as a ZIP.
 */
const US_POSTAL_CODE = /\b\d{5}(?:-\d{4})?\b/;

/**
 * LIGHT lint only (§7.5): non-empty, >=2 NON-EMPTY lines, and a postal code on
 * the LAST non-empty line (so "12345 Elm St" is a street number, not a ZIP).
 * US-first by decision — do NOT add structured international address
 * validation; the spec names it a trap.
 *
 * Normalization is minimal because the address is baked into the footer
 * VERBATIM: CRLF (and a lone CR) -> LF, trim each line, drop empty lines at the
 * EDGES only. Nothing else — no case folding, no abbreviation expansion, no
 * collapsing of interior blank lines, because every one of those would change
 * bytes the owner attested to.
 *
 * Pure: it is also what `attestPostalAddress` runs internally, so there is no
 * code path that stores an unlinted address.
 */
export function lintPostalAddress(raw: string): PostalAddressLintResult {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());

  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length === 0) return { ok: false, reason: 'empty' };

  // A blank line is not a line. "123 Main St\n   \n" is ONE line, and a
  // one-line value is the service-area trap §7.5 names ("Austin, TX, USA").
  const populated = lines.filter((line) => line !== '');
  if (populated.length < 2) return { ok: false, reason: 'single_line' };

  const lastPopulated = populated[populated.length - 1]!;
  if (!US_POSTAL_CODE.test(lastPopulated)) return { ok: false, reason: 'no_postal_code' };

  return { ok: true, normalized: lines.join('\n') };
}

export type AttestPostalAddressResult =
  | { status: 'attested' }
  | { status: 'invalid'; reason: PostalAddressLintReason }
  | { status: 'actor_not_in_account' }
  | { status: 'business_not_found' };

export interface AttestPostalAddressParams {
  accountId: string;
  businessId: string;
  /** `users.id` — the app-user PK, NOT the Supabase Auth UID. */
  userId: string;
  /** RAW owner input; linted and normalized here. */
  address: string;
}

/**
 * Takes the RAW address and lints internally, so there is no code path that
 * writes an unlinted address.
 *
 * ONE UPDATE, scoped by business id AND account_id, AND carrying the actor
 * membership predicate — `solicitation_postal_address_attested_by_user_id` has
 * no FK (migration 093's lesson: 086's ON DELETE CASCADE meant deleting a staff
 * member deleted their uploads), so nothing else stops a caller stamping an
 * arbitrary or cross-tenant UUID as legal provenance. The digest is computed
 * SERVER-SIDE from the same value the column stores, so it cannot disagree with
 * what migration 099's CHECK recomputes — computing it in Node would put a
 * second author on the same fact.
 *
 * On zero rows updated, one read-only diagnostic SELECT classifies the failure
 * for the caller's status code. The security property lives ENTIRELY in the
 * UPDATE's predicates; the diagnostic only picks a string, and is deliberately
 * not allowed to widen what the UPDATE would have written.
 */
export async function attestPostalAddress(
  sql: SqlExecutor,
  params: AttestPostalAddressParams,
): Promise<AttestPostalAddressResult> {
  const lint = lintPostalAddress(params.address);
  if (!lint.ok) return { status: 'invalid', reason: lint.reason };
  const normalized = lint.normalized;

  const updated = await sql<{ id: string }[]>`
    UPDATE businesses
    SET solicitation_postal_address                      = ${normalized},
        solicitation_postal_address_attested_at          = NOW(),
        solicitation_postal_address_attested_by_user_id  = ${params.userId}::uuid,
        solicitation_postal_address_attestation_version  = ${POSTAL_ADDRESS_ATTESTATION_VERSION},
        solicitation_postal_address_attested_digest      =
          encode(sha256(convert_to(${normalized}::text, 'UTF8')), 'hex'),
        updated_at                                       = NOW()
    WHERE id = ${params.businessId}::uuid
      AND account_id = ${params.accountId}::uuid
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = ${params.userId}::uuid
          AND account_id = ${params.accountId}::uuid
      )
    RETURNING id
  `;
  if (updated.length > 0) return { status: 'attested' };

  // Zero rows: at least one of the three predicates failed. Only the ACTOR
  // predicate needs a read to classify — the other two both mean "not this
  // account's location", which is one status. One statement, therefore, and it
  // is account-scoped like every other read here.
  //
  // Actor first because an attester outside the account is the tenant-confusion
  // case, and reporting it as a missing business would hide which guard fired.
  // A membership that holds while the UPDATE still matched nothing is a race
  // with a concurrent delete: report the non-committal status rather than
  // inventing a fourth one.
  const [actor] = await sql<{ ok: boolean }[]>`
    SELECT TRUE AS ok
    FROM users
    WHERE id = ${params.userId}::uuid
      AND account_id = ${params.accountId}::uuid
  `;
  return actor ? { status: 'business_not_found' } : { status: 'actor_not_in_account' };
}

export interface PostalAddressState {
  address: string | null;
  /** ISO-8601 UTC, rendered by Postgres — never round-tripped through a JS Date. */
  attestedAt: string | null;
  attestationVersion: string | null;
  /**
   * google_place_address, offered as an editable SUGGESTION only when no
   * attested address exists. Never written silently (§7.5): it is Google's
   * `formattedAddress`, which can be a service-area value like "Austin, TX,
   * USA", is not owner-attested, and cannot express a USPS-registered PO box.
   */
  suggestion: string | null;
}

/**
 * Account-scoped: a business outside `accountId` returns null, never a row.
 *
 * Migration 099's all-or-nothing CHECK is why this read never branches on "is
 * this attested" — a stored address always carries its complete attestation, so
 * `address !== null` and `attestedAt !== null` cannot disagree.
 */
export async function readPostalAddressState(
  sql: SqlExecutor,
  params: { accountId: string; businessId: string },
): Promise<PostalAddressState | null> {
  const [row] = await sql<
    {
      address: string | null;
      attested_at: string | null;
      attestation_version: string | null;
      google_place_address: string | null;
    }[]
  >`
    SELECT solicitation_postal_address AS address,
           to_char(
             solicitation_postal_address_attested_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ) AS attested_at,
           solicitation_postal_address_attestation_version AS attestation_version,
           google_place_address
    FROM businesses
    WHERE id = ${params.businessId}::uuid
      AND account_id = ${params.accountId}::uuid
  `;
  if (!row) return null;

  return {
    address: row.address,
    attestedAt: row.attested_at,
    attestationVersion: row.attestation_version,
    // Suppressed once an attested address exists: re-offering Google's string
    // beside the owner's own is an invitation to overwrite a compliance record
    // with a service-area value.
    suggestion: row.address === null ? row.google_place_address : null,
  };
}

export type SendHandoffWithheldReason = 'postal_address_missing' | 'owner_email_bounced';

/**
 * First-match precedence, mirroring `closedGateReason` (batch-builder.ts:130).
 * Postal address first: it is the CAN-SPAM one, and an owner who fixes it also
 * has to fix a bounced email before anything sends, so ordering costs nothing
 * and the more legally load-bearing reason is the one surfaced.
 *
 * Pure — the caller supplies the business row it already loaded. This is a
 * LOCATION-level fact, deliberately NOT a Withhold reason: that enum is closed,
 * precedence-ordered, per-candidate, and versioned by
 * `RESTRAINT_POLICY_VERSION`.
 *
 * `undefined` is accepted alongside `null` on purpose: a test fixture or a
 * projection that omits either column must read as "missing" and withhold, not
 * silently pass the gate.
 */
export function sendHandoffWithheldReason(row: {
  solicitation_postal_address_attested_at: Date | string | null | undefined;
  owner_email_bounced: boolean | null | undefined;
}): SendHandoffWithheldReason | null {
  const attestedAt = row.solicitation_postal_address_attested_at;
  if (attestedAt === null || attestedAt === undefined) return 'postal_address_missing';
  if (row.owner_email_bounced === true) return 'owner_email_bounced';
  return null;
}
