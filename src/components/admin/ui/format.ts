/**
 * The admin console's single date/number formatter (CF-1).
 *
 * WHY THIS EXISTS — hydration, not aesthetics. Since the Phase 2/3 migrations
 * every admin list renders twice: once on Vercel (whose Node process runs in
 * **UTC**) and again in the browser (the admin's own zone, and the admin's own
 * locale). `new Date(iso).toLocaleString()` reads BOTH from the runtime, so the
 * two renders disagree and React logs a hydration mismatch and re-renders the
 * subtree. For a `toLocaleDateString` that only bites near a date boundary; for
 * a `toLocaleString` — which prints time of day — **every** row mismatches for
 * every admin outside UTC, always. `Number.prototype.toLocaleString()` has the
 * same defect via the group separator (`1,234` vs `1.234`).
 *
 * The fix is to pin BOTH inputs — locale `en-US` and time zone `UTC` — so the
 * two renders are byte-identical by construction. `Intl.*Format` instances are
 * built once at module load; because the zone is explicit they are immune to
 * `process.env.TZ`, which is what `__tests__/format.test.ts` proves.
 *
 * CONTRACT for callers (enforced by the source scan in `__tests__/format.test.ts`):
 *   - Never call `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`, and
 *     never construct a bare `Intl.DateTimeFormat`, anywhere under
 *     `src/app/admin/**` or `src/components/admin/**`. Use these helpers.
 *   - `formatAdminDateTime` self-labels with a trailing " UTC" — a wall-clock
 *     time with no zone is a lie in an ops console.
 *   - `formatAdminDate` does NOT self-label (a column of dates repeating "UTC"
 *     is noise). Its caller MUST state the zone once: a column header
 *     `Last Sync (UTC)`, or a literal `UTC` next to the inline value.
 */

/** The one zone the console renders in. Vercel already runs here. */
export const ADMIN_DISPLAY_TIME_ZONE = 'UTC';

/** Rendered zone label. Use next to any bare `formatAdminDate` output. */
export const ADMIN_TIME_ZONE_LABEL = 'UTC';

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ADMIN_DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  // 24h: an ops console reads timestamps against logs and cron windows, and
  // "02:30" never has to be disambiguated from "02:30 PM".
  hourCycle: 'h23',
});

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ADMIN_DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const COUNT_FORMAT = new Intl.NumberFormat('en-US');

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `Aug 1, 2026, 02:30 UTC` — the default for any timestamp with a meaningful
 * time of day. Self-labels its zone.
 */
export function formatAdminDateTime(
  value: string | number | Date | null | undefined,
  fallback = '—',
): string {
  const date = toDate(value);
  if (!date) return fallback;
  return `${DATE_TIME_FORMAT.format(date)} ${ADMIN_TIME_ZONE_LABEL}`;
}

/**
 * `Aug 1, 2026` — calendar-date columns and fields. Does NOT self-label; the
 * caller states `UTC` in the column header or beside the value.
 */
export function formatAdminDate(
  value: string | number | Date | null | undefined,
  fallback = '—',
): string {
  const date = toDate(value);
  if (!date) return fallback;
  return DATE_FORMAT.format(date);
}

/** `1,234` — locale-pinned grouping, so counts hydrate identically too. */
export function formatAdminCount(value: number): string {
  return COUNT_FORMAT.format(value);
}
