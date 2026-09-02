'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import type { BusinessSummariesResult } from '@/lib/admin/business-summary';
import { useAdminActionForm } from '@/hooks/useAdminActionForm';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
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

/** Where an operator reads about failed rows — the operator IS support (X24). */
export const CSV_IMPORT_MACRO_PATH = 'docs/support/macros/csv-import.md';

/** Keystrokes settle for this long before the account search round-trips. */
const ACCOUNT_SEARCH_DEBOUNCE_MS = 300;
const ACCOUNT_SEARCH_LIMIT = 8;

interface AccountMatch {
  businessId: string;
  accountId: string;
  name: string;
  subscriptionStatus: string;
}

/**
 * Type-to-search for the billing account (X24). Reuses the Businesses list's
 * name search (`GET /api/admin/businesses?q=` — single owner
 * `getBusinessSummaries`, which carries `accountId` on every row for exactly
 * this) so an operator no longer pastes a raw UUID from a database console.
 * Picking a match fills the Account ID field below; the field stays editable
 * for the case where the id is already in hand.
 */
function AccountSearch({ onPick }: { onPick: (match: AccountMatch) => void }) {
  const [term, setTerm] = useState('');
  const [matches, setMatches] = useState<AccountMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = term.trim();
    if (query === '') return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: query, limit: String(ACCOUNT_SEARCH_LIMIT) });
        const res = await fetch(`/api/admin/businesses?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Search failed (${res.status}).`);
        const body = (await res.json()) as BusinessSummariesResult;
        setMatches(
          body.businesses.map((b) => ({
            businessId: b.id,
            accountId: b.accountId,
            name: b.name,
            subscriptionStatus: b.subscriptionStatus,
          })),
        );
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setMatches([]);
        setError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, ACCOUNT_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  const listId = 'csv-import-account-matches';
  return (
    <div>
      <label htmlFor="csv-import-account-search" className="block text-sm font-medium text-gray-700">
        Find the account by business name
      </label>
      <input
        id="csv-import-account-search"
        type="search"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={term}
        onChange={(event) => {
          const next = event.target.value;
          setTerm(next);
          if (next.trim() === '') {
            setMatches([]);
            setError(null);
          }
        }}
        placeholder="Start typing a business name…"
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
      />
      <ul id={listId} role="listbox" aria-label="Matching businesses" className="mt-1 divide-y divide-gray-100 rounded-md border border-gray-200 bg-white empty:hidden">
        {matches.map((match) => (
          <li key={match.businessId} role="option" aria-selected="false">
            <button
              type="button"
              onClick={() => {
                onPick(match);
                setTerm('');
                setMatches([]);
              }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
            >
              <span className="font-medium text-gray-900">{match.name}</span>
              <span className="flex items-center gap-2 text-xs text-gray-500">
                <StatusBadge vocab="subscription" value={match.subscriptionStatus} />
                <span className="font-mono">{match.accountId.slice(0, 8)}…</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {searching && <p className="mt-1 text-xs text-gray-500">Searching…</p>}
      {!searching && term.trim() !== '' && matches.length === 0 && !error && (
        <p className="mt-1 text-xs text-gray-500">No business matches that name.</p>
      )}
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}

interface CsvImportFields {
  accountId: string;
}

export function CsvImportClient() {
  // The success carries the whole server report, so `TOutcome` is
  // `CsvImportReport` rather than a sentence — flattening it to a string is the
  // cheap unification #880's hook deliberately refuses.
  const form = useAdminActionForm<CsvImportFields, CsvImportReport>({ accountId: '' });
  const { accountId } = form.fields;
  const { error: formError, outcome: report, busy: submitting } = form;
  // THE SECOND error channel stays local. Per-row validation failures are this
  // one surface's affordance; four other admin forms would carry an array they
  // never set. Cleared at the top of a submit alongside the shared outcome,
  // which is what this surface's own reducer cleared for all three at once.
  const [validationErrors, setValidationErrors] = useState<ClientCsvValidationError[]>([]);
  // The business whose account was picked from the search, for the confirmation
  // line under the Account ID field. Cleared when the id is edited by hand.
  const [pickedAccount, setPickedAccount] = useState<AccountMatch | null>(null);
  const fileRef = useRef<File | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setValidationErrors([]);

    await form.run(async () => {
      try {
        if (!accountId.trim()) {
          form.fail('Enter an account ID.');
          return;
        }
        const file = fileRef.current;
        if (!file) {
          form.fail('Choose a CSV file.');
          return;
        }
        if (file.size > MAX_CLIENT_FILE_SIZE) {
          setValidationErrors([{ row: 0, reason: 'CSV file is larger than 5 MB.' }]);
          return;
        }

        const parsed = parseCsvRows(await file.text());
        if ('error' in parsed) {
          form.fail(parsed.error);
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
          form.succeed(body);
        }
        if (!res.ok) {
          form.fail(body.error ?? `Import failed (${res.status}).`);
          return;
        }
        if (!isCsvImportReport(body)) {
          form.fail('Import completed, but the response was not readable.');
        }
      } catch {
        form.fail('Import failed. Check your connection and try again.');
      }
    });
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
          <AccountSearch
            onPick={(match) => {
              form.set('accountId', match.accountId);
              setPickedAccount(match);
            }}
          />

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
              onChange={(event) => {
                form.set('accountId', event.target.value);
                setPickedAccount(null);
              }}
              placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
            <p className="mt-1 text-xs text-gray-500">
              {pickedAccount
                ? `The billing account for ${pickedAccount.name}.`
                : 'Filled by the search above, or paste the account id if you already have it.'}
            </p>
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
              {/* The operator IS support (X24): point at the runbook, not at the
                  customer-facing contact form. */}
              <p className="mt-4 text-sm text-gray-700">
                Failed rows are not retried. Work through the internal checks in{' '}
                <code className="rounded bg-gray-100 px-1 text-xs">{CSV_IMPORT_MACRO_PATH}</code>, fix
                those rows, and upload a new file with only them — the imported rows are already in place.
              </p>
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
