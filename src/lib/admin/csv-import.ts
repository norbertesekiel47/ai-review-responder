// src/lib/admin/csv-import.ts
//
// CSV bulk-import helpers: parsing, validation, and row processing.
// Used by POST /api/admin/locations/csv-import.
//
// Validation contract: VAL-ADMIN-008 through VAL-ADMIN-014.

import { assertCanAddLocation } from '@/lib/accounts/quota';
import { getAccountById, getAccountOwnerUserId } from '@/lib/accounts/repo';
import { addLocationTransaction } from '@/lib/locations/add-location-tx';
import { getActiveLocationCount } from '@/lib/locations/repo';
import { sql, jsonb } from '@/lib/db/server';
import { v7 as uuidv7 } from 'uuid';

// ── Constants ────────────────────────────────────────────────────────────

/** Maximum file size in bytes (5 MB). */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Maximum number of data rows allowed. */
export const MAX_ROWS = 100;

// ── Types ─────────────────────────────────────────────────────────────────

export interface CsvRowFailure {
  /** 1-based row number in the CSV (excluding header). */
  row: number;
  /** Human-readable reason for the failure. */
  reason: string;
}

export interface CsvRowSuccess {
  /** 1-based row number in the CSV. */
  row: number;
  /** ID of the newly created businesses row. */
  businessId: string;
  /** Display label that was stored. */
  displayLabel: string;
}

export interface CsvImportReport {
  /** Number of rows successfully created. */
  created: number;
  /** Number of rows that failed. */
  failedCount: number;
  /** Per-row failure details. */
  failed: CsvRowFailure[];
}

export interface ParsedCsvRow {
  /** 1-based row index. */
  rowIndex: number;
  /** Location name (required). */
  name: string;
  /** Google Place ID (required). */
  placeId: string;
  /** Voice tone (optional). */
  tone?: string;
  /** Products/services description (optional). */
  productsServices?: string;
  /** Facts to avoid in responses, pipe-delimited (optional). */
  avoidFacts?: string[];
  /** Sample responses, pipe-delimited (optional). */
  sampleResponses?: string[];
}

export interface ProcessRowOptions {
  enqueueStripeOverageUpdate?: boolean;
}

// ── CSV Parsing ───────────────────────────────────────────────────────────

/**
 * Parses CSV text into structured rows.
 * Expects a header row with at least `name` and `placeId` columns.
 * Optional columns: tone, productsServices, avoidFacts, sampleResponses.
 *
 * Returns `{ rows }` on success, or `{ error }` on parse/validation failure.
 */
export function parseCsv(
  csvText: string,
): { rows: ParsedCsvRow[] } | { error: string } {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { error: 'CSV file is empty — no header row found' };
  }

  // Parse header row
  const headerLine = lines[0]!;
  const headers = parseCsvLine(headerLine).map((h) => h.toLowerCase().trim());

  const nameIdx = headers.indexOf('name');
  const placeIdIdx = headers.indexOf('placeid');

  if (nameIdx === -1) {
    return { error: "CSV header is missing required column 'name'" };
  }
  if (placeIdIdx === -1) {
    return { error: "CSV header is missing required column 'placeId'" };
  }

  // Optional columns
  const toneIdx = headers.indexOf('tone');
  const productsServicesIdx = headers.indexOf('productsservices');
  const avoidFactsIdx = headers.indexOf('avoidfacts');
  const sampleResponsesIdx = headers.indexOf('sampleresponses');

  // Parse data rows
  const rows: ParsedCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    const rowIndex = i; // 1-based row number (excluding header)

    const name = (fields[nameIdx] ?? '').trim();
    const placeId = (fields[placeIdIdx] ?? '').trim();

    const row: ParsedCsvRow = { rowIndex, name, placeId };

    // Optional voice config
    if (toneIdx !== -1 && fields[toneIdx]?.trim()) {
      row.tone = fields[toneIdx]!.trim();
    }
    if (productsServicesIdx !== -1 && fields[productsServicesIdx]?.trim()) {
      row.productsServices = fields[productsServicesIdx]!.trim();
    }
    if (avoidFactsIdx !== -1 && fields[avoidFactsIdx]?.trim()) {
      row.avoidFacts = fields[avoidFactsIdx]!.trim().split('|').map((s) => s.trim()).filter(Boolean);
    }
    if (sampleResponsesIdx !== -1 && fields[sampleResponsesIdx]?.trim()) {
      row.sampleResponses = fields[sampleResponsesIdx]!.trim().split('|').map((s) => s.trim()).filter(Boolean);
    }

    rows.push(row);
  }

  return { rows };
}

/**
 * Parses a single CSV line, respecting quoted fields (double-quote delimited).
 * Fields containing commas or double-quotes must be wrapped in double-quotes,
 * and internal double-quotes are escaped by doubling ("").
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped double-quote
          current += '"';
          i++;
        } else {
          // End of quoted field
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);

  return fields;
}

// ── Row Validation ────────────────────────────────────────────────────────

export interface RowValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a single CSV row's required fields.
 * VAL-ADMIN-012: name and placeId are mandatory.
 */
export function validateRow(row: ParsedCsvRow): RowValidationResult {
  const missing: string[] = [];
  if (!row.name) missing.push('name');
  if (!row.placeId) missing.push('placeId');

  if (missing.length > 0) {
    return { valid: false, reason: `Missing required field(s): ${missing.join(', ')}` };
  }

  return { valid: true };
}

// ── Row Processing ────────────────────────────────────────────────────────

/**
 * Processes a single valid CSV row through the add-location flow.
 * VAL-ADMIN-009: Each row processed through assertCanAddLocation + addLocationTransaction.
 *
 * Returns the business ID on success, or a failure reason on error.
 * Does NOT throw — errors are captured for the partial-success report.
 */
export async function processRow(
  row: ParsedCsvRow,
  accountId: string,
  options: ProcessRowOptions = {},
): Promise<{ businessId: string; displayLabel: string } | { reason: string }> {
  try {
    // Step 1: Quota check via the chokepoint (VAL-ADMIN-009)
    const quotaResult = await assertCanAddLocation(accountId);
    if (!quotaResult.allowed) {
      return { reason: `Quota check failed: ${quotaResult.reason}` };
    }

    // Step 2: Gather pre-transaction data
    const [activeLocations, account, actorUserId] = await Promise.all([
      getActiveLocationCount(accountId),
      getAccountById(accountId),
      getAccountOwnerUserId(accountId),
    ]);

    if (!account) {
      return { reason: 'Account not found' };
    }

    // Step 3: Build voice config from CSV columns
    const voiceConfig: {
      tone?: string;
      productsServices?: string | null;
      avoidFacts?: string[];
      sampleResponses?: string[];
    } = {};
    if (row.tone) voiceConfig.tone = row.tone;
    if (row.productsServices !== undefined) voiceConfig.productsServices = row.productsServices;
    if (row.avoidFacts && row.avoidFacts.length > 0) voiceConfig.avoidFacts = row.avoidFacts;
    if (row.sampleResponses && row.sampleResponses.length > 0) voiceConfig.sampleResponses = row.sampleResponses;

    // Step 4: Execute the add-location transaction
    const result = await addLocationTransaction({
      accountId,
      displayLabel: row.name,
      googlePlaceId: row.placeId,
      placeIdVerified: false,
      actorUserId,
      subscriptionTier: account.subscription_tier,
      subscriptionStatus: account.subscription_status,
      activeLocationsBefore: activeLocations,
      voiceConfig: Object.keys(voiceConfig).length > 0 ? voiceConfig : undefined,
      enqueueStripeOverageUpdate: options.enqueueStripeOverageUpdate ?? true,
    });

    return {
      businessId: result.businessId,
      displayLabel: result.displayLabel,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reason: `Transaction error: ${message}` };
  }
}

export async function enqueueCsvImportStripeOverageUpdate(accountId: string): Promise<void> {
  await sql`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${uuidv7()},
      'update_stripe_overage_quantity',
      'account',
      ${accountId}::uuid,
      ${jsonb({
        account_id: accountId,
        correlation_id: uuidv7(),
      })},
      'pending'
    )
  `;
}

// ── Audit Log ─────────────────────────────────────────────────────────────

/**
 * Writes a csv_bulk_import aggregate audit log entry.
 * VAL-ADMIN-014: Records the total created/failed counts.
 */
export async function writeCsvImportAuditLog(
  accountId: string,
  actorUserId: string | null,
  created: number,
  failedCount: number,
  failedReasons: string[],
): Promise<void> {
  await sql`
    INSERT INTO account_audit_log (
      id, account_id, location_id, event_type, actor_user_id, payload
    ) VALUES (
      ${uuidv7()}::uuid,
      ${accountId}::uuid,
      NULL,
      'csv_bulk_import',
      ${actorUserId ?? null}::uuid,
      ${jsonb({
        created,
        failed_count: failedCount,
        failed_reasons: failedReasons,
      })}
    )
  `;
}
