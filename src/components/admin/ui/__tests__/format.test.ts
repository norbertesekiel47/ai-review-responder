import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ADMIN_DISPLAY_TIME_ZONE,
  ADMIN_TIME_ZONE_LABEL,
  formatAdminCount,
  formatAdminDate,
  formatAdminDateTime,
} from '../format';

const ORIGINAL_TZ = process.env.TZ;

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** 02:30 UTC — inside the window where a US admin sees the PREVIOUS calendar day. */
const BOUNDARY = '2026-08-01T02:30:00.000Z';

describe('admin formatters are zone- and locale-stable (CF-1)', () => {
  it('pins the console to UTC', () => {
    expect(ADMIN_DISPLAY_TIME_ZONE).toBe('UTC');
    expect(ADMIN_TIME_ZONE_LABEL).toBe('UTC');
  });

  it('renders the UTC wall clock, self-labelled', () => {
    expect(formatAdminDateTime(BOUNDARY)).toBe('Aug 1, 2026, 02:30 UTC');
    expect(formatAdminDate(BOUNDARY)).toBe('Aug 1, 2026');
  });

  it('produces identical output under different process time zones', () => {
    // The control assertion first: prove the harness really does move the
    // runtime zone, so the stability assertion below cannot pass vacuously.
    process.env.TZ = 'America/Los_Angeles';
    const naiveWest = new Date(BOUNDARY).toLocaleString('en-US');
    const westDateTime = formatAdminDateTime(BOUNDARY);
    const westDate = formatAdminDate(BOUNDARY);

    process.env.TZ = 'Asia/Tokyo';
    const naiveEast = new Date(BOUNDARY).toLocaleString('en-US');
    const eastDateTime = formatAdminDateTime(BOUNDARY);
    const eastDate = formatAdminDate(BOUNDARY);

    expect(naiveWest).not.toBe(naiveEast); // control: the zone really changed
    expect(westDateTime).toBe(eastDateTime);
    expect(westDate).toBe(eastDate);
    // …and both equal the UTC rendering, not either local one.
    expect(westDateTime).toBe('Aug 1, 2026, 02:30 UTC');
    expect(westDate).toBe('Aug 1, 2026');
  });

  it('accepts Date instances and falls back for null/invalid input', () => {
    expect(formatAdminDateTime(new Date(BOUNDARY))).toBe('Aug 1, 2026, 02:30 UTC');
    expect(formatAdminDateTime(null)).toBe('—');
    expect(formatAdminDateTime(undefined, 'Never')).toBe('Never');
    expect(formatAdminDate(null, 'Never')).toBe('Never');
    expect(formatAdminDateTime('not-a-date')).toBe('—');
  });

  it('pins number grouping to en-US so counts hydrate identically too', () => {
    expect(formatAdminCount(1234567)).toBe('1,234,567');
    expect(formatAdminCount(0)).toBe('0');
  });
});

/**
 * Source guard. The whole point of the formatter is that NO other admin file
 * reaches for the runtime's zone/locale — one straggling `toLocaleString()` in a
 * server-rendered list reintroduces the hydration mismatch for every row.
 */
const SCANNED_ROOTS = ['src/app/admin', 'src/components/admin'];
const FORMATTER_MODULE = 'src/components/admin/ui/format.ts';

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(relative(process.cwd(), full));
    }
  };
  walk(resolve(process.cwd(), root));
  return out;
}

const ADMIN_SOURCES = SCANNED_ROOTS.flatMap(sourceFiles)
  .filter((file) => !file.includes('__tests__'))
  .filter((file) => file !== FORMATTER_MODULE)
  .sort();

describe('no admin file formats dates or numbers against the runtime locale/zone', () => {
  it('finds the admin tree to scan', () => {
    expect(ADMIN_SOURCES.length).toBeGreaterThan(20);
  });

  it.each(ADMIN_SOURCES)('%s calls no toLocale* helper', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(
      source,
      `${file} must use src/components/admin/ui/format.ts instead of a runtime-zone toLocale* call`,
    ).not.toMatch(/\.toLocale(String|DateString|TimeString)\s*\(/);
  });

  it.each(ADMIN_SOURCES)('%s constructs no Intl formatter without an explicit timeZone', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/new Intl\.DateTimeFormat\([\s\S]*?\)\s*;/g)) {
      expect(match[0], `${file} builds an Intl.DateTimeFormat with no timeZone`).toContain(
        'timeZone',
      );
    }
  });
});
