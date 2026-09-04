import { describe, it, expect } from 'vitest';
import {
  CONTACTS_CSV_TEMPLATE_FILENAME,
  buildContactsCsvTemplate,
} from '../contacts-csv-template';
import { parseContactsCsv } from '../contacts-csv';

// Eval suite for #1091. The template exists to be filled in and uploaded, so
// the only assertion that matters is that THIS parser accepts it. A template
// whose headers `parseContactsCsv` rejects is worse than no template: the owner
// gets `missing_required_header` and the whole file is thrown away.

const TODAY = '2026-09-03';

describe('buildContactsCsvTemplate', () => {
  it("the CSV template's header row is accepted by parseContactsCsv", () => {
    const result = parseContactsCsv(buildContactsCsvTemplate(TODAY), TODAY);
    expect('structuralFailure' in result).toBe(false);
  });

  it("the CSV template's example rows parse to valid contact candidates", () => {
    const result = parseContactsCsv(buildContactsCsvTemplate(TODAY), TODAY);
    if ('structuralFailure' in result) throw new Error('template was structurally rejected');
    expect(result.rejected).toEqual([]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('spells the headers canonically', () => {
    const [header] = buildContactsCsvTemplate(TODAY).split('\n');
    expect(header).toBe('name,email,phone,last_visit_date,note');
  });

  it('demonstrates every accepted handle shape', () => {
    const result = parseContactsCsv(buildContactsCsvTemplate(TODAY), TODAY);
    if ('structuralFailure' in result) throw new Error('template was structurally rejected');
    // An owner with only phone numbers, or only emails, must be able to see
    // from the template that their file is legal.
    expect(result.candidates.some((c) => c.email !== null && c.phone !== null)).toBe(true);
    expect(result.candidates.some((c) => c.email === null && c.phone !== null)).toBe(true);
    expect(result.candidates.some((c) => c.email !== null && c.phone === null)).toBe(true);
  });

  it('shows that the note column is optional', () => {
    const result = parseContactsCsv(buildContactsCsvTemplate(TODAY), TODAY);
    if ('structuralFailure' in result) throw new Error('template was structurally rejected');
    expect(result.candidates.some((c) => c.note === null)).toBe(true);
    expect(result.candidates.some((c) => c.note !== null)).toBe(true);
  });

  it('quotes a note containing a comma so the row still parses', () => {
    const result = parseContactsCsv(buildContactsCsvTemplate(TODAY), TODAY);
    if ('structuralFailure' in result) throw new Error('template was structurally rejected');
    const quoted = result.candidates.find((c) => c.note?.includes(','));
    expect(quoted, 'template should demonstrate CSV quoting').toBeDefined();
  });

  it('dates every example row in the past, whatever day it is generated', () => {
    // `future_date` rejects a visit date after today, so an example date must
    // be derived from today rather than hardcoded — a fixed date in a template
    // generated on an earlier machine clock would reject on arrival.
    for (const today of ['2026-09-03', '2027-01-01', '2030-12-31']) {
      const result = parseContactsCsv(buildContactsCsvTemplate(today), today);
      if ('structuralFailure' in result) throw new Error(`rejected for today=${today}`);
      expect(result.rejected).toEqual([]);
      for (const candidate of result.candidates) {
        expect(candidate.visitDate <= today).toBe(true);
      }
    }
  });

  it('names the downloaded file with a .csv extension', () => {
    expect(CONTACTS_CSV_TEMPLATE_FILENAME).toMatch(/\.csv$/);
  });
});
