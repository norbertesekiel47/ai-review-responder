'use client';

import { FormEvent, useRef, useState } from 'react';
import Link from 'next/link';
import {
  validateLocationsCsvClient,
  type ClientCsvValidationError,
} from './csv-validation';

interface CsvRowFailure {
  row: number;
  reason: string;
}

interface CsvImportReport {
  created: number;
  failedCount: number;
  failed: CsvRowFailure[];
}

const MAX_CLIENT_FILE_SIZE = 5 * 1024 * 1024;

export function CsvImportClient() {
  const [accountId, setAccountId] = useState('');
  const fileRef = useRef<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ClientCsvValidationError[]>([]);
  const [report, setReport] = useState<CsvImportReport | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);
    setValidationErrors([]);
    setReport(null);

    try {
      if (!accountId.trim()) {
        setFormError('Enter an account ID.');
        return;
      }
      const file = fileRef.current;
      if (!file) {
        setFormError('Choose a CSV file.');
        return;
      }
      if (file.size > MAX_CLIENT_FILE_SIZE) {
        setValidationErrors([{ row: 0, reason: 'CSV file is larger than 5 MB.' }]);
        return;
      }

      const parsed = parseCsvRows(await file.text());
      if ('error' in parsed) {
        setFormError(parsed.error);
        return;
      }

      const failures = validateLocationsCsvClient(parsed.rows);
      setValidationErrors(failures);
      if (failures.some((failure) => failure.row === 0)) {
        return;
      }

      const formData = new FormData();
      formData.append('accountId', accountId.trim());
      formData.append('file', file);

      const res = await fetch('/api/admin/locations/csv-import', {
        method: 'POST',
        body: formData,
      });
      const body = await res.json().catch(() => ({}));

      if (isCsvImportReport(body)) {
        setReport(body);
      }
      if (!res.ok) {
        setFormError(body.error ?? `Import failed (${res.status}).`);
        return;
      }
      if (!isCsvImportReport(body)) {
        setFormError('Import completed, but the response was not readable.');
      }
    } catch {
      setFormError('Import failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Locations Import</h1>
            <p className="mt-1 text-sm text-gray-600">
              Upload up to 100 Google Business locations for one billing account.
            </p>
          </div>
          <a
            href="/csv-templates/locations.csv"
            className="inline-flex rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Download template
          </a>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
        >
          <div className="space-y-5">
            <div>
              <label
                htmlFor="csv-import-account-id"
                className="block text-sm font-medium text-gray-700"
              >
                Account ID
              </label>
              <input
                id="csv-import-account-id"
                type="text"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label
                htmlFor="csv-import-file"
                className="block text-sm font-medium text-gray-700"
              >
                CSV file
              </label>
              <input
                id="csv-import-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  fileRef.current = event.target.files?.[0] ?? null;
                }}
                className="mt-1 block w-full text-sm text-gray-700 file:mr-4 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
              />
              <p className="mt-2 text-xs text-gray-500">
                Required columns are name and placeId. Optional voice columns are accepted by the API.
              </p>
              <a
                href="/csv-templates/README.md"
                className="mt-2 inline-block text-xs text-blue-600 hover:underline"
              >
                View template notes
              </a>
            </div>

            {formError ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {formError}
              </div>
            ) : null}

            {validationErrors.length > 0 ? (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3">
                <h2 className="text-sm font-semibold text-yellow-900">
                  {validationErrors.some((failure) => failure.row === 0)
                    ? 'Fix these CSV issues before importing'
                    : 'These CSV rows may fail during import'}
                </h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-yellow-800">
                  {validationErrors.map((failure) => (
                    <li key={`${failure.row}:${failure.reason}`}>
                      {failure.row === 0
                        ? failure.reason
                        : `Line ${failure.row}: ${failure.reason}`}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Importing…' : 'Import locations'}
              </button>
            </div>
          </div>
        </form>

        {report ? (
          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">Import report</h2>
            <p className="mt-2 text-sm text-gray-700">
              {report.created} of {report.created + report.failedCount} imported
            </p>
            {report.failed.length > 0 ? (
              <>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
                  {report.failed.map((failure) => (
                    <li key={`${failure.row}:${failure.reason}`}>
                      Row {failure.row}: {failure.reason}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/help/contact"
                  className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline"
                >
                  Contact support
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function parseCsvRows(csvText: string): { rows: Array<Record<string, string>> } | { error: string } {
  const parsed = parseCsvRecords(csvText);
  if ('error' in parsed) return parsed;

  const records = parsed.records.filter((record) =>
    !(record.length === 1 && (record[0] ?? '').trim().length === 0),
  );
  if (records.length === 0) {
    return { error: 'CSV file is empty.' };
  }

  const headers = records[0]!.map((header) => header.toLowerCase().trim());
  const nameIndex = headers.indexOf('name');
  const placeIdIndex = headers.indexOf('placeid');
  if (nameIndex === -1) {
    return { error: "CSV header is missing required column 'name'." };
  }
  if (placeIdIndex === -1) {
    return { error: "CSV header is missing required column 'placeId'." };
  }

  const rows = records.slice(1).map((fields) => ({
    name: fields[nameIndex] ?? '',
    placeId: fields[placeIdIndex] ?? '',
  }));

  return { rows };
}

function parseCsvRecords(csvText: string): { records: string[][] } | { error: string } {
  const records: string[][] = [];
  let fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
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
      if (ch === '\r' && csvText[i + 1] === '\n') {
        i++;
      }
    } else {
      current += ch;
    }
  }

  if (inQuotes) {
    return { error: 'CSV file has an unterminated quoted field.' };
  }

  if (current.length > 0 || fields.length > 0 || csvText.length > 0) {
    fields.push(current);
    records.push(fields);
  }

  return { records };
}

function isCsvImportReport(value: unknown): value is CsvImportReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<CsvImportReport>;
  return (
    typeof report.created === 'number' &&
    typeof report.failedCount === 'number' &&
    Array.isArray(report.failed)
  );
}
