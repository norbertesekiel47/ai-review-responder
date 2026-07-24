/**
 * Contacts CSV parser (#535 contract §2) — the pure ingest kernel.
 * Validates SYNTAX only: staleness is the restraint policy's judgment, never
 * ingest's (§2 "Ingestion validates syntax; policy judges").
 * `todayUtc` (YYYY-MM-DD) arrives as a parameter — no clock reads here
 * (restraint-policy.ts convention), so identical inputs parse identically.
 *
 * Email/phone fields become Normalized handles (handles.ts): lowercased/trimmed
 * email or E.164 phone (US assumed for 10-digit), computed once at CSV ingest,
 * stored on the Contact; it is the future suppression-ledger join key, never
 * the contact row id.
 *
 * NOTE on the private RFC-4180 tokenizer below: src/lib/admin/csv-import.ts
 * has its own private tokenizer (parseCsvRecords). Deliberate containment:
 * exporting it cross-domain is outside this ticket's edit surface; a shared
 * extraction is proposed as a follow-up (see PR description).
 */

import { normalizeEmail, normalizePhone } from './handles';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 5000;
export const MAX_NOTE_LENGTH = 500;

export const ROW_REJECTION_REASONS = [
  'missing_name', 'missing_handle', 'invalid_email', 'invalid_phone',
  'invalid_date', 'future_date', 'ambiguous_identity', 'note_too_long',
] as const;
export type RowRejectionReason = (typeof ROW_REJECTION_REASONS)[number];

export const STRUCTURAL_FAILURES = [
  'missing_required_header', 'row_count_over_cap', 'byte_size_over_cap', 'undecodable_encoding',
] as const;
export type StructuralFailure = (typeof STRUCTURAL_FAILURES)[number];

export interface ContactCandidate {
  rowIndex: number;            // 1-based data-row number (header excluded)
  name: string;
  email: string | null;        // Normalized handle or null
  phone: string | null;        // Normalized handle or null
  visitDate: string;           // canonical YYYY-MM-DD
  note: string | null;
}

export interface RejectedRow { row: number; reason: RowRejectionReason; }

export type ParseContactsCsvResult =
  | { candidates: ContactCandidate[]; rejected: RejectedRow[] }
  | { structuralFailure: StructuralFailure };

/** Header aliases, matched against lowercased/trimmed header cells. */
const HEADER_ALIASES: Record<CanonicalColumn, readonly string[]> = {
  name: ['name', 'customer name', 'customer', 'full name', 'client name'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'telephone'],
  last_visit_date: ['last_visit_date', 'last visit date', 'last visit', 'visit date', 'date'],
  note: ['note', 'notes', 'job', 'job note', 'staff note', 'details', 'detail'],
};

type CanonicalColumn = 'name' | 'email' | 'phone' | 'last_visit_date' | 'note';

export function parseContactsCsv(csvText: string, todayUtc: string): ParseContactsCsvResult {
  // The route decodes bytes; broken decoding surfaces as U+FFFD.
  if (csvText.includes('�')) return { structuralFailure: 'undecodable_encoding' };

  const text = csvText.startsWith('﻿') ? csvText.slice(1) : csvText;
  const records = tokenizeCsv(text).filter((fields) => !isBlankRecord(fields));

  const headerRecord = records[0];
  if (headerRecord === undefined) return { structuralFailure: 'missing_required_header' };

  const columns = resolveColumns(headerRecord);
  if (columns === null) return { structuralFailure: 'missing_required_header' };

  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_DATA_ROWS) return { structuralFailure: 'row_count_over_cap' };

  const candidates: ContactCandidate[] = [];
  const rejected: RejectedRow[] = [];

  dataRecords.forEach((fields, index) => {
    const rowIndex = index + 1;
    const outcome = parseRow(fields, columns, todayUtc, rowIndex);
    if ('reason' in outcome) {
      rejected.push({ row: rowIndex, reason: outcome.reason });
    } else {
      candidates.push(outcome);
    }
  });

  return { candidates, rejected };
}

/** Maps each canonical column to its cell index, or null when a required header is absent. */
function resolveColumns(headerRecord: string[]): Partial<Record<CanonicalColumn, number>> | null {
  const columns: Partial<Record<CanonicalColumn, number>> = {};
  headerRecord.forEach((cell, index) => {
    const header = cell.trim().toLowerCase();
    for (const canonical of Object.keys(HEADER_ALIASES) as CanonicalColumn[]) {
      if (columns[canonical] === undefined && HEADER_ALIASES[canonical].includes(header)) {
        columns[canonical] = index;
        return;
      }
    }
  });
  const hasHandleColumn = columns.email !== undefined || columns.phone !== undefined;
  if (columns.name === undefined || columns.last_visit_date === undefined || !hasHandleColumn) {
    return null;
  }
  return columns;
}

/** Validates one data row; first failure wins, in the contract-locked order. */
function parseRow(
  fields: string[],
  columns: Partial<Record<CanonicalColumn, number>>,
  todayUtc: string,
  rowIndex: number,
): ContactCandidate | { reason: RowRejectionReason } {
  const cell = (column: CanonicalColumn): string => {
    const index = columns[column];
    return index === undefined ? '' : (fields[index] ?? '').trim();
  };

  const name = cell('name');
  if (name.length === 0) return { reason: 'missing_name' };

  const rawEmail = cell('email');
  const rawPhone = cell('phone');
  if (rawEmail.length === 0 && rawPhone.length === 0) return { reason: 'missing_handle' };

  const email = rawEmail.length > 0 ? normalizeEmail(rawEmail) : null;
  if (rawEmail.length > 0 && email === null) return { reason: 'invalid_email' };

  const phone = rawPhone.length > 0 ? normalizePhone(rawPhone) : null;
  if (rawPhone.length > 0 && phone === null) return { reason: 'invalid_phone' };

  const visitDate = parseVisitDate(cell('last_visit_date'));
  if (visitDate === null) return { reason: 'invalid_date' };
  if (visitDate > todayUtc) return { reason: 'future_date' };

  const note = cell('note');
  if (note.length > MAX_NOTE_LENGTH) return { reason: 'note_too_long' };

  return {
    rowIndex,
    name,
    email,
    phone,
    visitDate,
    note: note.length > 0 ? note : null,
  };
}

/** `YYYY-MM-DD` or `MM/DD/YYYY` → canonical `YYYY-MM-DD`; null when malformed
 *  or not a real calendar date. Component round-trip via Date.UTC avoids the
 *  local-timezone pitfalls of parsing date strings with `new Date(string)`. */
function parseVisitDate(raw: string): string | null {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);

  let year: number;
  let month: number;
  let day: number;
  if (isoMatch !== null) {
    [year, month, day] = [Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])];
  } else if (usMatch !== null) {
    [year, month, day] = [Number(usMatch[3]), Number(usMatch[1]), Number(usMatch[2])];
  } else {
    return null;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  const isRealCalendarDate =
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
  if (!isRealCalendarDate) return null;

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** A record whose cells are all empty/whitespace (blank line or trailing newline). */
function isBlankRecord(fields: string[]): boolean {
  return fields.every((cell) => cell.trim().length === 0);
}

/** Private RFC-4180 tokenizer (quoted fields, CRLF/LF, escaped quotes) —
 *  mirrors the shape of parseCsvRecords in src/lib/admin/csv-import.ts.
 *  Lenient at EOF: an unterminated quoted field closes at end of input rather
 *  than failing the file — the affected row then fails row validation visibly. */
function tokenizeCsv(csvText: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < csvText.length && csvText[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else if (ch === '\n' || ch === '\r') {
      fields.push(current);
      records.push(fields);
      fields = [];
      current = '';
      if (ch === '\r' && i + 1 < csvText.length && csvText[i + 1] === '\n') {
        i++;
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0 || fields.length > 0) {
    fields.push(current);
    records.push(fields);
  }

  return records;
}
