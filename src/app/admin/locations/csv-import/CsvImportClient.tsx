'use client';

import { FormEvent, useReducer, useRef } from 'react';
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

// Static asset download (served from /public), not an in-app route — kept as
// <a> with non-literal href so it is a plain document request, not <Link>.
// The sibling template download lives on the server page's AdminPage actions.
const CSV_README_HREF = '/csv-templates/README.md';

interface CsvImportState {
  accountId: string;
  submitting: boolean;
  formError: string | null;
  validationErrors: ClientCsvValidationError[];
  report: CsvImportReport | null;
}

type CsvImportAction =
  | { type: 'setAccountId'; value: string }
  | { type: 'submitStart' }
  | { type: 'setFormError'; error: string }
  | { type: 'setValidationErrors'; errors: ClientCsvValidationError[] }
  | { type: 'setReport'; report: CsvImportReport }
  | { type: 'submitDone' };

const initialState: CsvImportState = {
  accountId: '',
  submitting: false,
  formError: null,
  validationErrors: [],
  report: null,
};

function reducer(state: CsvImportState, action: CsvImportAction): CsvImportState {
  switch (action.type) {
    case 'setAccountId':
      return { ...state, accountId: action.value };
    case 'submitStart':
      return { ...state, submitting: true, formError: null, validationErrors: [], report: null };
    case 'setFormError':
      return { ...state, formError: action.error };
    case 'setValidationErrors':
      return { ...state, validationErrors: action.errors };
    case 'setReport':
      return { ...state, report: action.report };
    case 'submitDone':
      return { ...state, submitting: false };
  }
}

export function CsvImportClient() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { accountId, submitting, formError, validationErrors, report } = state;
  const fileRef = useRef<File | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    dispatch({ type: 'submitStart' });

    try {
      if (!accountId.trim()) {
        dispatch({ type: 'setFormError', error: 'Enter an account ID.' });
        return;
      }
      const file = fileRef.current;
      if (!file) {
        dispatch({ type: 'setFormError', error: 'Choose a CSV file.' });
        return;
      }
      if (file.size > MAX_CLIENT_FILE_SIZE) {
        dispatch({ type: 'setValidationErrors', errors: [{ row: 0, reason: 'CSV file is larger than 5 MB.' }] });
        return;
      }

      const parsed = parseCsvRows(await file.text());
      if ('error' in parsed) {
        dispatch({ type: 'setFormError', error: parsed.error });
        return;
      }

      const failures = validateLocationsCsvClient(parsed.rows);
      dispatch({ type: 'setValidationErrors', errors: failures });
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
        dispatch({ type: 'setReport', report: body });
      }
      if (!res.ok) {
        dispatch({ type: 'setFormError', error: body.error ?? `Import failed (${res.status}).` });
        return;
      }
      if (!isCsvImportReport(body)) {
        dispatch({ type: 'setFormError', error: 'Import completed, but the response was not readable.' });
      }
    } catch {
      dispatch({ type: 'setFormError', error: 'Import failed. Check your connection and try again.' });
    } finally {
      dispatch({ type: 'submitDone' });
    }
  }

  return (
    // `max-w-3xl` is a form-legibility measure, not the deleted page shell:
    // AdminPage owns the page width, padding and background now.
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-gray-600">
        Locations are matched to the account by ID; existing locations are skipped.
      </p>

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
              onChange={(event) => dispatch({ type: 'setAccountId', value: event.target.value })}
              placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
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
              href={CSV_README_HREF}
              className="mt-2 inline-block text-xs text-gray-600 underline hover:text-gray-900"
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
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:opacity-50"
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
                className="mt-4 inline-block text-sm font-medium text-gray-900 underline hover:text-gray-700"
              >
                Contact support
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
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
