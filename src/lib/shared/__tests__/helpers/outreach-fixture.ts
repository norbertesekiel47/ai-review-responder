// Shared `solicitation_outreach` row fixture for live-DB suites (#636 T3).
//
// NOT a test file: the vitest include glob only matches
// `**/__tests__/**/*.test.{ts,tsx}`, so this helper is invisible to the runner
// and only ever loaded by suites that import it.
//
// What it owns, and why that is the whole scope: migration 091 gives the table
// FIFTEEN NOT NULL columns, most of which no test is ever about — prompt
// provenance, lint provenance, moderation provenance. Three suites re-spelled
// that set by hand, plus the same `prompt_hash` fabrication, so a sixteenth
// NOT NULL column meant editing three files that had nothing to do with the
// change (#624 S1 demonstrated it in practice: one new implication arm cost
// three fixture edits).
//
// What it deliberately does NOT own:
//
//  - The upload → contact → batch → ask chain. The three callers need
//    genuinely different chains (one shared chain seeded once, a fresh chain
//    per row, several asks per batch with lifecycle stamps), so a single
//    helper would be an options bag rather than an abstraction.
//
//  - Timestamp derivation. Whether a stamp is a JS `Date` or a SQL interval
//    off NOW() is a correctness decision each suite has to make for itself:
//    postgres.js truncates timestamptz microseconds, so a suite comparing a
//    row against a retention boundary MUST resolve both sides in SQL, while a
//    suite probing a CHECK is clearer with explicit Dates. Every stamp is
//    therefore passed through verbatim — `Date`, `null`, or a `sql` fragment.

import { randomUUID } from 'node:crypto';
import type { PendingQuery, Row, Sql, TransactionSql } from 'postgres';

export const OUTREACH_SUBJECT = 'How did we do?';
export const OUTREACH_BODY = 'Would you mind leaving a review?';

/** Pool handle or an open transaction — RLS probes need the latter. */
export type OutreachSqlExecutor = Sql | TransactionSql;

/**
 * A timestamp column value: a JS `Date`, an explicit NULL, or a `sql` fragment
 * the caller built (`sql\`NOW() - INTERVAL '91 days'\``) to keep the whole
 * comparison on the database side.
 */
export type OutreachStamp = Date | null | PendingQuery<Row[]>;

export interface OutreachRowInput {
  id?: string;
  accountId: string;
  businessId: string;
  batchId: string;
  askId: string;
  contactId: string;
  attemptNo?: number;
  /**
   * `null` writes a bodyless row — the subject and body are always written as a
   * PAIR, because `solicitation_outreach_body_presence` requires it and a
   * fixture that split them would fail for a reason no case is about.
   */
  renderedSubject?: string | null;
  renderedBody?: string | null;
  interpolationInputs?: Record<string, unknown>;
  /** Defaults to NOW(). The retention clock for a row that never sent (#636). */
  renderedAt?: OutreachStamp;
  bodyRedactedAt?: OutreachStamp;
  deliveryStatus?: string;
  dispositionReason?: string | null;
  moderationStatus?: string;
  queuedAt?: OutreachStamp;
  sendingAt?: OutreachStamp;
  sentAt?: OutreachStamp;
}

/** 64 hex-ish chars from a uuid — `prompt_hash`/`content_sha256` shaped. */
export function checksum(seed: string): string {
  return seed.replaceAll('-', '').padEnd(64, '0').slice(0, 64);
}

/**
 * One `contact_csv_uploads` row (#919 item 2). SIX suites hand-copied this
 * 13-column INSERT, so one new NOT NULL column broke six files that had
 * nothing to do with the change — the exact class `insertOutreach` above was
 * built for. This owns ONE TABLE's row, not the upload → contact → batch →
 * ask chain; the module comment's "does not own the chain" rule stands.
 *
 * The `status` split mirrors `contact_csv_uploads_terminal_consistency`:
 * a COMPLETED upload carries `report` + `completed_at` and NO `raw_csv`, a
 * PENDING one carries `raw_csv` and neither terminal column. Encoding the
 * CHECK here is what lets a caller state only its lane and never trip the
 * constraint for a reason no case is about.
 */
export interface ContactCsvUploadInput {
  id?: string;
  accountId: string;
  businessId: string;
  attestedByUserId: string;
  /** Exact filename; defaults to `${filenamePrefix ?? 'upload'}-${id}.csv`. */
  filename?: string;
  filenamePrefix?: string;
  byteSize?: number;
  /** Defaults to `checksum(id)`. */
  contentSha256?: string;
  attestationVersion?: string;
  /** A JS `Date`, or a `sql` fragment (`sql\`NOW() - '2 days'::interval\``)
   *  when the comparison must stay on the database side. Defaults to NOW(). */
  attestedAt?: Date | PendingQuery<Row[]>;
  /** The lane: 'completed' (default — the built-batch suites) or 'pending'
   *  (the ingest lane, which then REQUIRES `rawCsv`). */
  status?: 'pending' | 'completed';
  /** Completed lane only. Defaults to `{ accepted: 1 }`. */
  report?: Record<string, unknown>;
  /** Pending lane only — the CHECK requires it there. */
  rawCsv?: string;
}

export async function seedContactCsvUpload(
  exec: OutreachSqlExecutor,
  input: ContactCsvUploadInput,
): Promise<string> {
  const id = input.id ?? randomUUID();
  const status = input.status ?? 'completed';
  if (status === 'pending' && input.rawCsv === undefined) {
    throw new Error('seedContactCsvUpload: a pending upload requires rawCsv (terminal-consistency CHECK)');
  }
  const filename = input.filename ?? `${input.filenamePrefix ?? 'upload'}-${id}.csv`;
  const attestedAt = input.attestedAt ?? exec`NOW()`;
  await exec`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${id}::uuid, ${input.accountId}::uuid, ${input.businessId}::uuid,
      ${filename}, ${input.byteSize ?? 1}, ${input.contentSha256 ?? checksum(id)},
      ${status === 'pending' ? input.rawCsv! : null},
      ${status},
      ${status === 'completed' ? exec.json((input.report ?? { accepted: 1 }) as never) : null},
      ${input.attestedByUserId}::uuid, ${attestedAt},
      ${input.attestationVersion ?? 'fixture-test'},
      ${status === 'completed' ? exec`NOW()` : null}
    )
  `;
  return id;
}

/**
 * Dispatch stamps derived from the status, for suites that write JS `Date`s.
 *
 * 091 requires `queued_at` of every dispatched status and `sending_at` of
 * `sending`, so a fixture omitting them is rejected by the status/timestamp
 * CHECK rather than reaching the constraint the case is about. Presence is
 * keyed on the property being ABSENT, not on it being null — a case that
 * explicitly passes `queuedAt: null` is probing that implication and keeps it.
 *
 * Not applied automatically inside `insertOutreach`: a suite whose stamps are
 * SQL fragments has to derive its own in SQL, and a helper that silently
 * injected Dates into that suite would reintroduce the microsecond-truncation
 * hazard the module comment describes.
 */
export function deriveDispatchStamps(
  input: Pick<OutreachRowInput, 'deliveryStatus' | 'queuedAt' | 'sendingAt' | 'sentAt'>,
): { queuedAt: Date | null; sendingAt: Date | null } {
  const status = input.deliveryStatus ?? 'rendered';
  const dispatched = status === 'queued' || status === 'sending' || status === 'sent';
  const base = input.sentAt instanceof Date ? input.sentAt : new Date();
  return {
    queuedAt: 'queuedAt' in input
      ? ((input.queuedAt as Date | null) ?? null)
      : (dispatched ? new Date(base.getTime() - 2_000) : null),
    sendingAt: 'sendingAt' in input
      ? ((input.sendingAt as Date | null) ?? null)
      : (status === 'sending' ? new Date(base.getTime() - 1_000) : null),
  };
}

/**
 * One `solicitation_outreach` row, defaulting to the shape #628 writes first:
 * a freshly rendered attempt with its bodies present and no disposition.
 * Callers override exactly the field under test, so a rejection can only come
 * from the constraint the case is about.
 *
 * Returns the row id so a caller can read the row back without threading its
 * own uuid through.
 */
export async function insertOutreach(
  exec: OutreachSqlExecutor,
  input: OutreachRowInput,
): Promise<string> {
  const id = input.id ?? randomUUID();
  const hasBody = input.renderedSubject !== null;

  await exec`
    INSERT INTO solicitation_outreach (
      id, account_id, business_id, batch_id, ask_id, contact_id,
      attempt_no, rendered_subject, rendered_body,
      prompt_version, prompt_hash, interpolation_inputs, rendered_at,
      body_redacted_at, ask_lint_version, lint_detail,
      moderation_status, moderation_detail,
      delivery_status, disposition_reason, queued_at, sending_at, sent_at
    ) VALUES (
      ${id}::uuid, ${input.accountId}::uuid, ${input.businessId}::uuid,
      ${input.batchId}::uuid, ${input.askId}::uuid, ${input.contactId}::uuid,
      ${input.attemptNo ?? 1},
      ${hasBody ? (input.renderedSubject ?? OUTREACH_SUBJECT) : null},
      ${hasBody ? (input.renderedBody ?? OUTREACH_BODY) : null},
      'solicitation_ask_v1', ${checksum(input.id ?? id)},
      ${exec.json((input.interpolationInputs ?? {}) as never)},
      ${input.renderedAt ?? exec`NOW()`},
      ${input.bodyRedactedAt ?? null}, 'ask_lint_v1', ${exec.json({})},
      ${input.moderationStatus ?? 'clean'}, ${exec.json({})},
      ${input.deliveryStatus ?? 'rendered'}, ${input.dispositionReason ?? null},
      ${input.queuedAt ?? null}, ${input.sendingAt ?? null}, ${input.sentAt ?? null}
    )
  `;
  return id;
}
