/**
 * The downloadable contacts CSV template (#1091) — the starting point an owner
 * fills in for `/dashboard/requests/contacts`.
 *
 * It is BUILT here, in a pure function beside the parser, rather than shipped
 * as a static asset, for one reason: `contacts-csv.ts` owns the header contract
 * and `parseContactsCsv` is the only thing that decides whether a file is
 * legal. A template that drifts from it hands the owner
 * `missing_required_header`, which rejects the WHOLE file — strictly worse than
 * offering no template. Keeping both in this folder lets one eval suite feed
 * the template straight through the parser.
 *
 * Header spelling is the CANONICAL one of each alias set. The parser accepts
 * "customer name", "e-mail", "visit date" and the rest, but a template teaches
 * whichever spelling it uses, so it teaches the one that cannot be wrong.
 */

/** Suggested filename for the download. */
export const CONTACTS_CSV_TEMPLATE_FILENAME = 'repworth-contacts-template.csv';

/** The canonical header row — every column `parseContactsCsv` recognises. */
const TEMPLATE_HEADER = 'name,email,phone,last_visit_date,note';

const DAY_MS = 86_400_000;

/**
 * Example rows, each teaching one thing the owner cannot learn from the header
 * alone. `daysAgo` rather than a literal date because `parseRow` rejects
 * `future_date`: a hardcoded date is fine the day it is written and a rejected
 * row on any machine whose clock sits behind it.
 */
const TEMPLATE_ROWS: ReadonlyArray<{
  name: string;
  email: string;
  phone: string;
  daysAgo: number;
  note: string;
}> = [
  // Both handles, and a note.
  { name: 'Sofia Reyes', email: 'sofia@example.com', phone: '+1 555 0136', daysAgo: 14, note: 'Full colour and cut' },
  // Phone only — the email column may be left empty.
  { name: 'Marcus Bell', email: '', phone: '+1 555 0184', daysAgo: 9, note: '' },
  // Email only, and a note carrying a comma, so the file also demonstrates
  // that such a value must be quoted.
  { name: 'Aiko Tanaka', email: 'aiko@example.com', phone: '', daysAgo: 3, note: 'Rescheduled once, arrived on time' },
];

/** `YYYY-MM-DD`, `daysAgo` before `todayUtc`. */
function dateDaysBefore(todayUtc: string, daysAgo: number): string {
  const today = new Date(`${todayUtc}T00:00:00Z`);
  return new Date(today.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** RFC 4180 quoting: only when the value carries a comma, quote or newline. */
function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The template as CSV text. `todayUtc` is the `YYYY-MM-DD` the example visit
 * dates are measured back from — passed in rather than read from the clock so
 * the output is deterministic and the eval suite can generate it for several
 * days and re-parse each one.
 */
export function buildContactsCsvTemplate(todayUtc: string): string {
  const rows = TEMPLATE_ROWS.map((row) =>
    [
      row.name,
      row.email,
      row.phone,
      dateDaysBefore(todayUtc, row.daysAgo),
      row.note,
    ]
      .map(csvCell)
      .join(','),
  );
  return [TEMPLATE_HEADER, ...rows].join('\n') + '\n';
}
