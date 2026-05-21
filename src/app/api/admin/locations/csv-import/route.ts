// src/app/api/admin/locations/csv-import/route.ts
//
// POST /api/admin/locations/csv-import — Admin CSV bulk-import for locations.
// Upload CSV with name, placeId, and optional voice config columns.
// Each row processed through add-location flow.
// Returns partial-success report (X created, Y failed with reasons).
// Gated to admin role only.
//
// Validation contract: VAL-ADMIN-008 through VAL-ADMIN-014.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import {
  parseCsv,
  validateRow,
  processRow,
  enqueueCsvImportStripeOverageUpdate,
  writeCsvImportAuditLog,
  MAX_FILE_SIZE,
  MAX_ROWS,
  type CsvImportReport,
  type CsvRowFailure,
} from '@/lib/admin/csv-import';
import { getAccountById } from '@/lib/accounts/repo';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/locations/csv-import
 *
 * Admin CSV bulk-import for locations. Each row is processed through
 * the add-location flow (assertCanAddLocation + addLocationTransaction).
 * Returns a partial-success report: X created, Y failed with per-row
 * error reasons.
 *
 * VAL-ADMIN-008: CSV upload accepts multipart file upload with name, placeId, voice config.
 * VAL-ADMIN-009: Each row processed through add-location flow (quota check, tx, outbox).
 * VAL-ADMIN-010: Partial-success report returned.
 * VAL-ADMIN-011: Gated to admin role only.
 * VAL-ADMIN-012: Required fields validated (name, placeId mandatory).
 * VAL-ADMIN-013: Oversized files rejected (>5MB or >100 rows).
 * VAL-ADMIN-014: account_audit_log records 'csv_bulk_import' event with row counts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Step 1: Auth gate (VAL-ADMIN-011) ──────────────────────────────
  let authUser;
  try {
    authUser = await requireRole(req, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE },
    );
  }

  // ── Step 2: Parse multipart form data ───────────────────────────────
  const formData = await req.formData();
  const file = formData.get('file');
  const accountId = formData.get('accountId')?.toString();

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'No file uploaded. Provide a CSV file as "file" field.' },
      { status: 400, headers: NO_STORE },
    );
  }

  if (!accountId || !UUID_RE.test(accountId)) {
    return NextResponse.json(
      { error: 'Invalid or missing accountId. Must be a valid UUID.' },
      { status: 400, headers: NO_STORE },
    );
  }

  // ── Step 3: File size check (VAL-ADMIN-013) ─────────────────────────
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum (${MAX_FILE_SIZE / (1024 * 1024)}MB)` },
      { status: 413, headers: NO_STORE },
    );
  }

  // ── Step 4: Read and parse CSV ──────────────────────────────────────
  const csvText = await file.text();
  const parseResult = parseCsv(csvText);

  if ('error' in parseResult) {
    return NextResponse.json(
      { error: parseResult.error },
      { status: 400, headers: NO_STORE },
    );
  }

  const { rows } = parseResult;

  // ── Step 5: Row count check (VAL-ADMIN-013) ─────────────────────────
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `CSV contains ${rows.length} data rows, which exceeds the maximum of ${MAX_ROWS}` },
      { status: 400, headers: NO_STORE },
    );
  }

  // ── Step 6: Verify account exists ────────────────────────────────────
  const account = await getAccountById(accountId);
  if (!account) {
    return NextResponse.json(
      { error: 'Account not found' },
      { status: 404, headers: NO_STORE },
    );
  }

  // ── Step 7: Process each row (best-effort, VAL-ADMIN-010) ──────────
  //
  // Invalid rows (validation failures) don't block valid rows.
  // Each valid row is processed through assertCanAddLocation + addLocationTransaction.
  const successes: Array<{ row: number; businessId: string; displayLabel: string }> = [];
  const failures: CsvRowFailure[] = [];

  for (const row of rows) {
    // 7a. Validate required fields (VAL-ADMIN-012)
    const validation = validateRow(row);
    if (!validation.valid) {
      failures.push({ row: row.rowIndex, reason: validation.reason! });
      continue;
    }

    // 7b. Process through add-location flow (VAL-ADMIN-009)
    const result = await processRow(row, accountId, {
      enqueueStripeOverageUpdate: false,
    });
    if ('reason' in result) {
      failures.push({ row: row.rowIndex, reason: result.reason });
    } else {
      successes.push({
        row: row.rowIndex,
        businessId: result.businessId,
        displayLabel: result.displayLabel,
      });
    }
  }

  const report: CsvImportReport = {
    created: successes.length,
    failedCount: failures.length,
    failed: failures,
  };

  // ── Step 8: Write aggregate audit log (VAL-ADMIN-014) ──────────────
  try {
    await writeCsvImportAuditLog(
      accountId,
      authUser.id,
      successes.length,
      failures.length,
      failures.map((f) => f.reason),
    );
  } catch (err) {
    // Audit log failure is non-blocking — log but don't fail the response
    console.error('[csv-import] Failed to write audit log:', err);
  }

  // Step 9: Enqueue aggregate billing update after audit logging.
  if (successes.length > 0) {
    try {
      await enqueueCsvImportStripeOverageUpdate(accountId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          error: `Failed to enqueue billing update after import: ${reason}`,
          ...report,
        },
        { status: 500, headers: NO_STORE },
      );
    }
  }

  // Step 10: Return partial-success report.
  return NextResponse.json(report, { status: 200, headers: NO_STORE });
}
