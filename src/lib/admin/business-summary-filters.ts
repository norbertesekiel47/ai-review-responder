// src/lib/admin/business-summary-filters.ts
//
// The three PURE steps `getBusinessSummaries` (business-summary.ts) runs
// around its statements — none of them issues a query, none of them owns SQL
// text that names a table:
//
//   1. `resolveBusinessListParams` — the caller's `opts` → normalised filters
//      plus the ONE decision that shapes the read: is the page taken in SQL
//      (`sqlPage`) or, because a health filter needs every scored row first,
//      in TypeScript after scoring (`healthPage`)? Exactly one of the two is
//      set when a page was requested; neither when the caller is unpaginated.
//   2. `buildBusinessFilter` — the `search` / `status` predicates as ONE
//      `WHERE …` fragment the page CTE and the COUNT both interpolate, so the
//      total and the page can never disagree on the filtered set.
//   3. `capByHealth` — the health filter's FILTER-THEN-CAP step: filter on the
//      scored level, THEN slice the page. Never the other way round — the same
//      rule the At-risk list follows (docs/context/core-accounts-channels-admin.md → At-risk list).
//
// The statements themselves stay in business-summary.ts, which remains the
// single owner of the admin business query (docs/context/core-accounts-channels-admin.md → Business summary,
// LOCKED). This module exists so that owner reads as: resolve → filter →
// rows → count → metrics → score → cap, each step named and unit-tested on
// its own (`__tests__/business-summary-filters.test.ts`).
//
// Born-injected like its caller: `sql` is a parameter (invariant #15).

import type { Fragment, Sql } from 'postgres';
import type { ChurnScore } from '@/lib/shared/churn-score';
import type { SubscriptionStatusValue } from '@/lib/shared/subscription-status';

/** The page a caller asked for, already clamped by the route. */
export interface BusinessListPage {
  limit: number;
  offset: number;
}

/** What `getBusinessSummaries` accepts — see `BusinessSummariesPage` there. */
export interface BusinessListRequest extends BusinessListPage {
  search?: string;
  status?: SubscriptionStatusValue | '';
  health?: ChurnScore['level'] | '';
}

export interface BusinessListParams {
  /** Trimmed name search; '' = no filter. */
  search: string;
  /** Exact subscription status; '' = no filter. */
  status: SubscriptionStatusValue | '';
  /** Churn level to filter on AFTER scoring; '' = no filter. */
  health: ChurnScore['level'] | '';
  /**
   * Set when LIMIT/OFFSET can be applied in SQL: a page was requested and no
   * health filter forces the unpaginated read. Drives the COUNT query too.
   */
  sqlPage: BusinessListPage | null;
  /**
   * Set when a page was requested WITH a health filter: every filtered row is
   * read and scored, then `capByHealth` filters on level and slices this page.
   */
  healthPage: (BusinessListPage & { health: ChurnScore['level'] }) | null;
}

/**
 * Normalise the caller's request. Unpaginated (`opts` omitted — Overview's
 * path) yields blank filters and neither page; a page with a health filter
 * yields `healthPage`; any other page yields `sqlPage`.
 */
export function resolveBusinessListParams(opts?: BusinessListRequest): BusinessListParams {
  const search = opts?.search?.trim() ?? '';
  const status = opts?.status ?? '';
  const health = opts?.health ?? '';
  const page = opts === undefined ? null : { limit: opts.limit, offset: opts.offset };
  return {
    search,
    status,
    health,
    sqlPage: page && health === '' ? page : null,
    healthPage: page && health !== '' ? { ...page, health } : null,
  };
}

/**
 * Escapes the three LIKE metacharacters so an operator typing `100%` searches
 * for the literal text. The bound value is a parameter (never interpolated),
 * so this is about pattern semantics, not injection.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The `WHERE …` fragment for the page CTE and the COUNT — or the empty
 * fragment when both filters are blank, so the unfiltered statement text is
 * unchanged. Two clauses at most, so the AND-join is spelled out rather than
 * reduced. Column aliases are the caller's: `b` = businesses, `a` = accounts.
 */
export function buildBusinessFilter(
  sql: Sql,
  { search, status }: Pick<BusinessListParams, 'search' | 'status'>,
): Fragment {
  const searchClause = search ? sql`b.name ILIKE ${`%${escapeLike(search)}%`}` : null;
  const statusClause = status ? sql`a.subscription_status = ${status}` : null;
  if (searchClause && statusClause) return sql`WHERE ${searchClause} AND ${statusClause}`;
  if (searchClause) return sql`WHERE ${searchClause}`;
  if (statusClause) return sql`WHERE ${statusClause}`;
  return sql``;
}

/**
 * Health filter: FILTER on the scored level, THEN cap to the page — never the
 * other way round. `total` is the post-filter length, which is what the
 * pagination footer needs under a health filter.
 */
export function capByHealth<T extends { churnScore: ChurnScore }>(
  scored: readonly T[],
  { health, limit, offset }: NonNullable<BusinessListParams['healthPage']>,
): { businesses: T[]; total: number } {
  const matching = scored.filter((b) => b.churnScore.level === health);
  return {
    businesses: matching.slice(offset, offset + limit),
    total: matching.length,
  };
}
