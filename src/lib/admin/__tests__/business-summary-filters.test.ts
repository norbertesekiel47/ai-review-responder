// src/lib/admin/__tests__/business-summary-filters.test.ts
//
// The three pure steps getBusinessSummaries runs around its statements. The
// end-to-end contract (which query carries which bind, filter-then-cap through
// the whole read) stays in business-summary.test.ts; these pin each step on
// its own so a regression names the step, not the query.

import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import {
  buildBusinessFilter,
  capByHealth,
  escapeLike,
  resolveBusinessListParams,
} from '../business-summary-filters';
import type { ChurnScore } from '@/lib/shared/churn-score';

/** The mock's fragments carry their flattened text + binds at construction. */
function fragmentOf(fragment: unknown): { text: string; values: unknown[] } {
  const { text, values } = fragment as { text: string; values: unknown[] };
  return { text, values };
}

describe('resolveBusinessListParams', () => {
  it('unpaginated: blank filters and neither page', () => {
    expect(resolveBusinessListParams()).toEqual({
      search: '',
      status: '',
      health: '',
      sqlPage: null,
      healthPage: null,
    });
  });

  it('a plain page is taken in SQL; the search is trimmed', () => {
    expect(resolveBusinessListParams({ limit: 20, offset: 40, search: '  Cafe ', status: 'past_due' })).toEqual({
      search: 'Cafe',
      status: 'past_due',
      health: '',
      sqlPage: { limit: 20, offset: 40 },
      healthPage: null,
    });
  });

  it('a page WITH a health filter moves the page into TypeScript', () => {
    expect(resolveBusinessListParams({ limit: 1, offset: 1, health: 'at_risk' })).toEqual({
      search: '',
      status: '',
      health: 'at_risk',
      sqlPage: null,
      healthPage: { limit: 1, offset: 1, health: 'at_risk' },
    });
  });

  it('blank strings mean "no filter" and keep the page in SQL', () => {
    const params = resolveBusinessListParams({ limit: 20, offset: 0, search: '   ', status: '', health: '' });
    expect(params.search).toBe('');
    expect(params.sqlPage).toEqual({ limit: 20, offset: 0 });
    expect(params.healthPage).toBeNull();
  });
});

describe('escapeLike', () => {
  it('escapes the three LIKE metacharacters and nothing else', () => {
    expect(escapeLike('100%_off\\now')).toBe('100\\%\\_off\\\\now');
    expect(escapeLike('Cafe & Co.')).toBe('Cafe & Co.');
  });
});

describe('buildBusinessFilter', () => {
  const sql = createMockSql().mockSql as unknown as Sql;

  it('is the empty fragment when both filters are blank', () => {
    expect(fragmentOf(buildBusinessFilter(sql, { search: '', status: '' }))).toEqual({ text: '', values: [] });
  });

  it('binds the search as an escaped, wildcard-wrapped ILIKE', () => {
    expect(fragmentOf(buildBusinessFilter(sql, { search: '100%', status: '' }))).toEqual({
      text: 'WHERE b.name ILIKE ?',
      values: ['%100\\%%'],
    });
  });

  it('binds status alone when it is the only filter', () => {
    expect(fragmentOf(buildBusinessFilter(sql, { search: '', status: 'past_due' }))).toEqual({
      text: 'WHERE a.subscription_status = ?',
      values: ['past_due'],
    });
  });

  it('ANDs status onto search, search bound first', () => {
    expect(fragmentOf(buildBusinessFilter(sql, { search: 'Cafe', status: 'active' }))).toEqual({
      text: 'WHERE b.name ILIKE ? AND a.subscription_status = ?',
      values: ['%Cafe%', 'active'],
    });
  });
});

describe('capByHealth', () => {
  function scoredRow(id: string, level: ChurnScore['level']) {
    return { id, churnScore: { score: 0, level, breakdown: [] } satisfies ChurnScore };
  }
  const scored = [
    scoredRow('a', 'healthy'),
    scoredRow('b', 'at_risk'),
    scoredRow('c', 'watch'),
    scoredRow('d', 'at_risk'),
    scoredRow('e', 'at_risk'),
  ];

  it('filters on level THEN slices the page — never the other way round', () => {
    // Page size 1, offset 1: the SECOND at-risk row, not row 2 of 5.
    const { businesses, total } = capByHealth(scored, { health: 'at_risk', limit: 1, offset: 1 });
    expect(businesses.map((b) => b.id)).toEqual(['d']);
    expect(total).toBe(3);
  });

  it('reports the post-filter total even when the page runs past it', () => {
    const { businesses, total } = capByHealth(scored, { health: 'watch', limit: 20, offset: 20 });
    expect(businesses).toEqual([]);
    expect(total).toBe(1);
  });

  it('does not mutate the scored input', () => {
    const before = scored.map((b) => b.id);
    capByHealth(scored, { health: 'healthy', limit: 5, offset: 0 });
    expect(scored.map((b) => b.id)).toEqual(before);
  });
});
