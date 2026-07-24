import { describe, expect, it, vi } from 'vitest';

import { MAX_UPLOAD_BYTES } from '../contacts-csv';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { createContactsCsvUpload, getUploadStatus } from '../uploads';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

// Test doubles for the Postgres.js tagged-template client mirror the stub
// style of src/lib/shared/__tests__/job-outbox-helpers.test.ts.
function createMockTx() {
  const tx = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve([])) as any;
  // Mirror job-outbox-helpers.test.ts: identity stub for Postgres.js's JSONB
  // constructor so the payload object flows through as a plain bound value.
  tx.json = (value: unknown) => value;
  return tx;
}

function createMockSql(tx: ReturnType<typeof createMockTx>) {
  return {
    begin: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  } as any;
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const INPUT = {
  accountId: 'a0000000-0000-0000-0000-000000000001',
  businessId: 'b0000000-0000-0000-0000-000000000001',
  attestedByUserId: 'c0000000-0000-0000-0000-000000000001',
  attestationAccepted: true,
  filename: 'contacts.csv',
  csvText: 'name,email,last_visit_date\nAda,ada@example.com,2026-07-01\n',
};

describe('createContactsCsvUpload', () => {
  it('upload route rejects when the attestation is not accepted', async () => {
    const tx = createMockTx();
    const sql = createMockSql(tx);

    const result = await createContactsCsvUpload(sql, {
      ...INPUT,
      attestationAccepted: false,
    });

    expect(result).toEqual({ ok: false, error: 'attestation_required' });
    expect(sql.begin).not.toHaveBeenCalled();
  });

  it('upload route persists the upload row and csv_ingest outbox row in one transaction', async () => {
    const tx = createMockTx();
    const sql = createMockSql(tx);

    const result = await createContactsCsvUpload(sql, INPUT);

    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledTimes(2);

    const [uploadCall, outboxCall] = tx.mock.calls;
    expect(sqlText(uploadCall)).toContain('INSERT INTO contact_csv_uploads');
    expect(sqlText(outboxCall)).toContain('INSERT INTO job_outbox');

    const uploadValues = uploadCall.slice(1);
    expect(uploadValues[0]).toBe(result.uploadId);
    expect(uploadValues).toContain(INPUT.accountId);
    expect(uploadValues).toContain(INPUT.businessId);
    expect(uploadValues).toContain(INPUT.attestedByUserId);
    expect(uploadValues).toContain(CONSENT_ATTESTATION_VERSION);

    const outboxValues = outboxCall.slice(1);
    expect(outboxValues).toContain(QUEUE_NAMES.CSV_INGEST);
    expect(outboxValues).toContain(result.uploadId);
    const payload = outboxValues.find(isRecord);
    expect(payload).toMatchObject({
      uploadId: result.uploadId,
      businessId: INPUT.businessId,
    });
  });

  it('rejects an empty file without opening a transaction', async () => {
    const tx = createMockTx();
    const sql = createMockSql(tx);

    const result = await createContactsCsvUpload(sql, { ...INPUT, csvText: '' });

    expect(result).toEqual({ ok: false, error: 'empty_file' });
    expect(sql.begin).not.toHaveBeenCalled();
  });

  it('rejects a file over MAX_UPLOAD_BYTES without opening a transaction', async () => {
    const tx = createMockTx();
    const sql = createMockSql(tx);

    const result = await createContactsCsvUpload(sql, {
      ...INPUT,
      csvText: 'a'.repeat(MAX_UPLOAD_BYTES + 1),
    });

    expect(result).toEqual({ ok: false, error: 'file_too_large' });
    expect(sql.begin).not.toHaveBeenCalled();
  });
});

describe('getUploadStatus', () => {
  const ROW = {
    id: 'd0000000-0000-0000-0000-000000000001',
    status: 'completed',
    filename: 'contacts.csv',
    created_at: '2026-07-24 10:00:00+00',
    completed_at: '2026-07-24 10:00:05+00',
    report: { contactsCreated: 3 },
  };

  function createRowSql(rows: unknown[]) {
    return vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(rows)) as any;
  }

  it('returns null when no row matches the account+business scope', async () => {
    const sql = createRowSql([]);

    const status = await getUploadStatus(sql, INPUT.accountId, INPUT.businessId, ROW.id);

    expect(status).toBeNull();
    const values = sql.mock.calls[0].slice(1);
    expect(values).toContain(INPUT.accountId);
    expect(values).toContain(INPUT.businessId);
    expect(values).toContain(ROW.id);
  });

  it('parses a PgBouncer string-encoded JSONB report', async () => {
    const sql = createRowSql([{ ...ROW, report: JSON.stringify(ROW.report) }]);

    const status = await getUploadStatus(sql, INPUT.accountId, INPUT.businessId, ROW.id);

    expect(status).toEqual({
      id: ROW.id,
      status: 'completed',
      filename: 'contacts.csv',
      createdAt: ROW.created_at,
      completedAt: ROW.completed_at,
      report: { contactsCreated: 3 },
    });
  });

  it('passes an object report through and maps a pending row to a null report', async () => {
    const sql = createRowSql([{ ...ROW, status: 'pending', completed_at: null, report: null }]);

    const status = await getUploadStatus(sql, INPUT.accountId, INPUT.businessId, ROW.id);

    expect(status).toMatchObject({ status: 'pending', completedAt: null, report: null });
  });
});
