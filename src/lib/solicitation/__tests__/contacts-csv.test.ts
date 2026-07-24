import { describe, expect, it } from 'vitest';
import { parseContactsCsv, MAX_DATA_ROWS, MAX_NOTE_LENGTH } from '../contacts-csv';

const TODAY = '2026-07-24';

function csv(lines: string[]): string {
  return lines.join('\n');
}

describe('parseContactsCsv', () => {
  it('parses a valid row into a normalized candidate', () => {
    const result = parseContactsCsv(csv([
      'name,email,phone,last_visit_date,note',
      'Ada Lovelace,Ada@Example.com,(415) 555-2671,2026-07-01,Regular',
    ]), TODAY);
    expect(result).toMatchObject({
      candidates: [{
        rowIndex: 1,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+14155552671',
        visitDate: '2026-07-01',
        note: 'Regular',
      }],
      rejected: [],
    });
  });

  it('accepts both YYYY-MM-DD and MM/DD/YYYY visit dates', () => {
    const result = parseContactsCsv(csv([
      'name,email,last_visit_date',
      'A,a@example.com,2026-07-01',
      'B,b@example.com,07/01/2026',
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.candidates.map((c) => c.visitDate)).toEqual(['2026-07-01', '2026-07-01']);
  });

  it('rejects a future last_visit_date with future_date', () => {
    const result = parseContactsCsv(csv([
      'name,email,last_visit_date',
      'A,a@example.com,2026-08-01',
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.rejected).toEqual([{ row: 1, reason: 'future_date' }]);
  });

  it('ignores unknown columns and matches header aliases case-insensitively', () => {
    const result = parseContactsCsv(csv([
      'Customer Name,E-Mail,POS Terminal,Last Visit',
      'Ada,ada@example.com,7,2026-07-01',
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.name).toBe('Ada');
  });

  it('rejects the whole file when a required header is missing', () => {
    const result = parseContactsCsv(csv(['email,phone', 'a@example.com,+14155552671']), TODAY);
    expect(result).toEqual({ structuralFailure: 'missing_required_header' });
  });

  it('rejects the whole file when data rows exceed the 5,000-row cap', () => {
    const rows = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => `P${i},p${i}@example.com,2026-07-01`);
    const result = parseContactsCsv(csv(['name,email,last_visit_date', ...rows]), TODAY);
    expect(result).toEqual({ structuralFailure: 'row_count_over_cap' });
  });

  it('rejects rows per the closed rejection enum', () => {
    const result = parseContactsCsv(csv([
      'name,email,phone,last_visit_date,note',
      ',a@example.com,,2026-07-01,',                    // missing_name
      'B,,,2026-07-01,',                                // missing_handle
      'C,not-an-email,,2026-07-01,',                    // invalid_email
      'D,,12345,2026-07-01,',                           // invalid_phone
      'E,e@example.com,,yesterday,',                    // invalid_date
      `F,f@example.com,,2026-07-01,${'x'.repeat(MAX_NOTE_LENGTH + 1)}`, // note_too_long
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.rejected).toEqual([
      { row: 1, reason: 'missing_name' },
      { row: 2, reason: 'missing_handle' },
      { row: 3, reason: 'invalid_email' },
      { row: 4, reason: 'invalid_phone' },
      { row: 5, reason: 'invalid_date' },
      { row: 6, reason: 'note_too_long' },
    ]);
  });

  it('rejects an empty file structurally', () => {
    expect(parseContactsCsv('', TODAY)).toEqual({ structuralFailure: 'missing_required_header' });
  });
});
