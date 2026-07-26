import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { UPLOAD_STATUSES } from '../upload-status';

const mockLogger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => mockLogger }));
// Watch mode off: the completed-ingest batch trigger is #543's concern, not
// this suite's — keeps the query sequence independent of the flag's env state.
vi.mock('../flags', () => ({ solicitationWatchEnabled: () => false }));

import {
  acquireCsvIngestLock,
  ingestContactsCsvUpload,
  resolveContactMatch,
  writeTerminalUploadState,
  type IngestReport,
} from '../ingest';

const X = { id: 'contact-x', name: 'Ada', email: 'ada@example.com', phone: null };
const Y = { id: 'contact-y', name: 'Bob', email: null, phone: '+14155552671' };

describe('resolveContactMatch', () => {
  it('creates a new contact when neither handle matches', () => {
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: null }, null, null,
    )).toEqual({ action: 'create' });
  });

  it('rejects a row whose email and phone match two different contacts with ambiguous_identity', () => {
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, X, Y,
    )).toEqual({ action: 'reject', reason: 'ambiguous_identity' });
  });

  it('merges a missing handle into the matched contact', () => {
    const result = resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, X, null,
    );
    expect(result).toEqual({
      action: 'update', contactId: 'contact-x',
      set: { name: 'Ada', phone: '+14155552671' },
    });
  });

  it('latest non-empty name wins on a matched contact', () => {
    const result = resolveContactMatch(
      { name: 'Ada L.', email: 'ada@example.com', phone: null }, X, null,
    );
    expect(result).toEqual({
      action: 'update', contactId: 'contact-x', set: { name: 'Ada L.' },
    });
    const unchanged = resolveContactMatch(
      { name: '', email: 'ada@example.com', phone: null }, X, null,
    );
    expect(unchanged).toEqual({ action: 'update', contactId: 'contact-x', set: {} });
  });

  it('same contact matched by both handles is a plain update', () => {
    const both = { ...X, phone: '+14155552671' };
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, both, both,
    )).toEqual({ action: 'update', contactId: 'contact-x', set: {} });
  });
});

// The csv_ingest lane's two source directories. The advisory-lock KEY may be
// built in exactly one of their files; every other writer goes through
// acquireCsvIngestLock (which also owns the hashtext wrapping and the
// first-statement rule).
const LANE_ROOTS = ['src/lib/solicitation', 'worker/jobs/csv-ingest'];
// Any reconstruction of the key, not just the template-literal form: the
// prefix either terminates a string literal (`'csv_ingest_' || businessId`) or
// is followed by an interpolation (`csv_ingest_${businessId}`). Prose mentions
// (`csv_ingest_<business>`) and the unrelated `csv_ingest_exhausted` outbox
// reason are deliberately outside the pattern.
const LOCK_KEY_CONSTRUCTION = /csv_ingest_(\$\{|['"`])/;

function* walkLaneSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      yield* walkLaneSources(join(dir, entry.name));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield join(dir, entry.name);
    }
  }
}

function laneFilesBuildingTheLockKey(): string[] {
  const files: string[] = [];
  for (const root of LANE_ROOTS) {
    for (const filePath of walkLaneSources(join(process.cwd(), root))) {
      if (LOCK_KEY_CONSTRUCTION.test(readFileSync(filePath, 'utf-8'))) {
        files.push(relative(process.cwd(), filePath).split('\\').join('/'));
      }
    }
  }
  return files.sort();
}

let harness: MockSqlHarness;

beforeEach(() => {
  harness = createMockSql();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
});

describe('csv_ingest terminal-write owners', () => {
  it('acquireCsvIngestLock is the single owner of the csv_ingest advisory-lock key', async () => {
    await acquireCsvIngestLock(harness.mockSql as unknown as TransactionSql, 'business-1');

    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).toContain('pg_advisory_xact_lock');
    expect(harness.sqlCalls[0]!.text).toContain('hashtext');
    // Key VALUE pinned: changing it would silently stop serializing against
    // in-flight ingests that still hold the old key.
    expect(harness.sqlCalls[0]!.values).toEqual(['csv_ingest_business-1']);
    expect(laneFilesBuildingTheLockKey()).toEqual(['src/lib/solicitation/ingest.ts']);
  });

  it('writeTerminalUploadState guards the terminal write with the pending predicate', async () => {
    const report: IngestReport = {
      contactsCreated: 0, contactsMerged: 0, visitsAdded: 0, duplicateVisits: 0,
      rejected: [], structuralFailure: null, error: 'ingest_failed',
    };

    await expect(writeTerminalUploadState(harness.mockSql as unknown as TransactionSql, {
      uploadId: 'upload-1',
      businessId: 'business-1',
      status: UPLOAD_STATUSES.FAILED,
      report,
      // A 0-row result (the default empty mock result) is a tolerated no-op:
      // the offboarding purge can delete the row without the advisory lock.
    })).resolves.toBeUndefined();

    expect(harness.sqlCalls).toHaveLength(1);
    const write = harness.sqlCalls[0]!;
    expect(write.text).toContain('UPDATE contact_csv_uploads');
    expect(write.text).toContain('raw_csv = NULL');
    expect(write.text).toContain('completed_at = NOW()');
    expect(write.text).toContain('AND status = ?');
    // The pending guard is a bound value sourced from UPLOAD_STATUSES (single
    // owner); SET-clause order is not part of the contract.
    expect(write.values).toContain('pending');
    expect(harness.mockSql.json).toHaveBeenCalledWith(report);
  });

  it('ingestContactsCsvUpload completes normally when its terminal write finds no pending row', async () => {
    harness.sqlReturnQueue.push(
      [], // acquireCsvIngestLock
      [{
        id: 'upload-1',
        business_id: 'business-1',
        status: UPLOAD_STATUSES.PENDING,
        byte_size: 64,
        raw_csv: 'name,email,phone,last_visit_date,note\nAda,ada@example.com,,2020-01-02,\n',
        report: null,
      }],
      [], // findContactByHandle(email) — no existing contact
      [], // INSERT solicitation_contacts
      [{ inserted: true }], // upsertVisit
      // The terminal UPDATE falls through to the mock's empty result: the
      // offboarding purge (purge-stages.ts) deleted the row without the lock
      // between the pending read and this write. The job must still complete.
    );

    const report = await ingestContactsCsvUpload(
      harness.mockSql as unknown as Sql, 'upload-1', 'business-1',
    );

    expect(report).toEqual({
      contactsCreated: 1, contactsMerged: 0, visitsAdded: 1, duplicateVisits: 0,
      rejected: [], structuralFailure: null,
    });
    const write = harness.sqlCalls.find((call) => call.text.includes('UPDATE contact_csv_uploads'));
    expect(write!.values).toContain('pending');
    expect(mockLogger.log).toHaveBeenCalledWith(
      'csv ingest completed',
      expect.objectContaining({ upload_id: 'upload-1', contacts_created: 1 }),
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
