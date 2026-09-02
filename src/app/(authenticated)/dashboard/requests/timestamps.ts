// src/app/(authenticated)/dashboard/requests/timestamps.ts
//
// The Requests screen's one reading of a stored timestamp. Values arrive as
// Postgres `::text` ("2026-07-22 12:00:00+00") — selected as text end to end so
// postgres.js cannot truncate them through a JS Date (#520) — or as ISO strings
// from stored evidence, whose dates are plain `YYYY-MM-DD`. `BatchReport` and
// `AttributedReviews` both render them, and a second copy of the parse is how
// the two screens would drift apart on the same value.

/** Module-scope formatter: building an Intl formatter per render is the
 *  no-locale-format-in-render hotspot. UTC, so a day never shifts by viewer zone. */
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * Parse a Postgres `::text` timestamp or a bare `YYYY-MM-DD` day. Returns null
 * rather than an Invalid Date so callers can render the raw value instead.
 */
export function parseTimestamp(value: string): Date | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "22 Jul 2026" (locale-ordered); a value that does not parse renders raw. */
export function formatDay(value: string): string {
  const parsed = parseTimestamp(value);
  return parsed === null ? value : DAY_FORMAT.format(parsed);
}
