import { describe, expect, it } from 'vitest';
import { findRlsFailures } from '../rls-audit';

describe('rls-audit', () => {
  it('returns no failures when all required tables have RLS', () => {
    expect(findRlsFailures([
      { relname: 'reviews', relrowsecurity: true },
      { relname: 'responses', relrowsecurity: true },
    ], ['reviews', 'responses'])).toEqual([]);
  });

  it('returns missing tables and disabled RLS tables', () => {
    expect(findRlsFailures([
      { relname: 'reviews', relrowsecurity: false },
    ], ['reviews', 'responses'])).toEqual([
      'reviews has RLS disabled',
      'responses missing from pg_class result',
    ]);
  });
});
