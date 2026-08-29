/**
 * The Refusal Log read — one tenant-scoped, owner-safe projection of the
 * refusals RepWorth ALREADY records.
 *
 * Design of record: `docs/superpowers/plans/feat-refusal-log-plan.md` §2 (the
 * six sources and their anchors) and §4 (this module's seam). Vocabulary:
 * `./vocabulary.ts` — the one place a verbatim source code becomes a
 * {@link RefusalCategory}. CONTEXT.md → **Refusal**, **Refusal category**,
 * **Refusal source**.
 *
 * THE SHAPE IS `getAgentTeamSummary`'s (`src/lib/agents/read.ts:424`): the same
 * three parameters, the same {@link DashboardReadScope} discriminant, the same
 * `dashboardWindowParams(window)` handling, the same aggregate-vs-location
 * branch. A caller who knows one owner read knows this one.
 *
 * ONE `UNION ALL`, NOT SIX QUERIES (plan review finding 24). Each source is one
 * arm projecting an IDENTICAL safe column set, so there is one final sort, one
 * window vocabulary and one place the location predicate lives. Today the
 * statement carries a single arm — S5, the withheld ask — and T3/T4 add the
 * other five to this same statement. To add an arm: alias its root table `r`,
 * spell `r.account_id = ${scope.accountId}` in the arm itself (see
 * {@link locationFilter} for why that half is not extracted), add
 * `AND ${inLocation}` as its own conjunct unless the source is account-wide,
 * project the five columns in order, and give the arm its OWN foreign-account
 * or foreign-location test — one statement means a structural assertion over
 * the combined SQL can prove nothing about any single arm (intake invariant 1).
 *
 * ONE QUERY, ISSUED SEQUENTIALLY. Never fan this out across a `Promise`
 * combinator: postgres.js has no admission control and the #773 chokepoint
 * (`src/lib/db/admission.ts`) is what stands between a busy pool and pipelining
 * onto a busy connection. `ci:pool-fanout` does not audit this directory; the
 * reason it exists applies here regardless.
 *
 * INVARIANT #15. `sql` arrives as an explicit parameter. This module must never
 * import the db-server singleton — only the route (a composition root) does.
 * `__tests__/read.test.ts` proves it by scanning this directory for that import
 * path as a fixed string, so do not name the path here either: a mention in
 * prose reads to that scan exactly like an import.
 */

import type { PendingQuery, Row, Sql } from 'postgres';
import type { DashboardReadScope } from '@/lib/agents/read';
import { dashboardWindowParams, type DashboardWindow } from '@/lib/kpi/types';
import {
  ASK_WITHHELD_REFUSAL_CATEGORIES,
  REFUSAL_CATEGORIES,
  refusalCategoryFor,
  type RefusalCategory,
  type RefusalSource,
} from './vocabulary';

/** One thing RepWorth declined to do, dated, with nothing owner-unsafe on it. */
export interface RefusalEntry {
  /** The source row's own id. A stable render key — never prose, never a code. */
  id: string;
  source: RefusalSource;
  category: RefusalCategory;
  /** ISO-8601. The LANE's refusal anchor, never a generic mutation stamp. */
  occurredAt: string;
  /** The review this refusal belongs to, for the lanes that name one. */
  reviewId: string | null;
}

export interface RefusalCategoryGroup {
  category: RefusalCategory;
  count: number;
  entries: RefusalEntry[];
}

/**
 * The whole owner-facing answer for one scope and one window, as ONE object:
 * the Restraint tab renders `total` and `categories` from the same value, so
 * the stated total and the breakdown cannot disagree (plan §6 T7).
 *
 * `categories` carries only the categories that actually have entries, in
 * `REFUSAL_CATEGORIES` precedence order. An empty window is `{ total: 0,
 * categories: [] }` — a fact, not an error.
 */
export interface RefusalLog {
  total: number;
  categories: RefusalCategoryGroup[];
}

/**
 * The safe column set every arm projects, in order. `source` is typed as the
 * closed union rather than `string` because the value is a constant THIS module
 * binds into the arm — the database echoes back what we sent it — while `code`
 * is genuinely read from the row and is therefore untrusted until
 * `refusalCategoryFor` rules on it.
 */
interface RefusalRow {
  entry_id: string;
  source: RefusalSource;
  code: string | null;
  occurred_at: Date | string;
  review_id: string | null;
}

/** S5 · `solicitation_asks`. Checked against the closed union at compile time. */
const ASK_WITHHELD_SOURCE = 'ask_withheld' satisfies RefusalSource;

/**
 * Every S5 code the vocabulary rules a refusal, derived from the map rather
 * than re-spelled. `velocity_banked` maps to `null` there — volume shaping, not
 * a hold (`BatchReport.tsx:27`) — so it is absent from this list and the arm
 * never has to name it. A seventh `WithholdReason` arrives here automatically,
 * or fails to compile in `vocabulary.ts` first.
 */
const ASK_WITHHELD_CODES: readonly string[] = Object.entries(
  ASK_WITHHELD_REFUSAL_CATEGORIES,
)
  .filter(([, category]) => category !== null)
  .map(([code]) => code);

/**
 * The location half of the tenant predicate, in ONE place. Every arm aliases
 * its root table `r`, so this composes into any of them unchanged.
 *
 * The ACCOUNT half is deliberately NOT extracted here. `ci:tenant-scope`
 * (`scripts/ci/tenant-scope-audit.ts`) reads raw, UN-EVALUATED template text,
 * so a tenant predicate hidden behind a helper reads to it as a bare
 * `FROM solicitation_asks` with no scope at all — the same rule
 * `src/lib/kpi/fragments.ts` states for the Review-time anchor. Each arm
 * therefore spells `r.account_id = ` in its own template and drops this
 * fragment in beside it.
 *
 * An account-wide arm (S4, `account_audit_log`) omits this fragment on
 * purpose: a suspension applies to every location, so filtering it by one would
 * hide it from the location scope where the owner is standing.
 *
 * It composes as a WHOLE conjunct — `AND ${inLocation}`, resolving to `TRUE` in
 * aggregate scope — rather than as a trailing `AND …`. The audit substitutes
 * one placeholder per `${}` in the raw text, so a fragment dropped in DIRECTLY
 * after `r.account_id = ${…}` reads there as `r.account_id = $1 $2` and stops
 * proving anything. Keeping it a conjunct of its own leaves the account
 * predicate intact in both scope modes.
 */
function locationFilter(
  sql: Sql,
  scope: DashboardReadScope,
): PendingQuery<Row[]> {
  return scope.kind === 'location'
    ? sql`r.business_id = ${scope.businessId}`
    : sql`TRUE`;
}

/**
 * Buckets the already-sorted rows by category and counts them, so `total` is
 * the sum of the group counts by construction.
 *
 * A `null` category is the vocabulary's explicit "known code, not a refusal".
 * Every arm already excludes those in SQL, so a row that still arrives means a
 * widened query rather than a fault — it is dropped, not thrown on. An
 * UNRECOGNISED code is the opposite: `refusalCategoryFor` throws, because a
 * default would file the refusal under a plausible-looking heading the owner
 * cannot tell from a real one.
 */
function groupEntries(rows: readonly RefusalRow[]): RefusalLog {
  const byCategory = new Map<RefusalCategory, RefusalEntry[]>();
  for (const row of rows) {
    const category = refusalCategoryFor(row.source, row.code);
    if (category === null) continue;
    const entries = byCategory.get(category) ?? [];
    entries.push({
      id: row.entry_id,
      source: row.source,
      category,
      occurredAt: new Date(row.occurred_at).toISOString(),
      reviewId: row.review_id,
    });
    byCategory.set(category, entries);
  }

  const categories: RefusalCategoryGroup[] = REFUSAL_CATEGORIES.flatMap(
    (category) => {
      const entries = byCategory.get(category);
      return entries === undefined
        ? []
        : [{ category, count: entries.length, entries }];
    },
  );

  return {
    total: categories.reduce((sum, group) => sum + group.count, 0),
    categories,
  };
}

/**
 * Every refusal for one scope and one window, newest first.
 *
 * The window is `[now - windowDays, now]` and the START boundary is `>=`,
 * matching `getAgentTeamSummary`: an entry stamped exactly at the boundary is
 * inside the window. Both bounds are bound as parameters off ONE `now`, so
 * every arm shares the same instant.
 */
export async function getRefusalLog(
  sql: Sql,
  scope: DashboardReadScope,
  window: DashboardWindow,
): Promise<RefusalLog> {
  const { windowDays } = dashboardWindowParams(window);
  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  const inLocation = locationFilter(sql, scope);

  const rows = await sql<RefusalRow[]>`
    SELECT entry_id, source, code, occurred_at, review_id
    FROM (
      -- S5 · Ask withheld at build: solicitation_asks, the withhold arm, keyed
      -- account_id + business_id, anchored on decided_at — the moment the
      -- Restraint policy ruled, written once by the batch builder.
      SELECT
        r.id::text AS entry_id,
        ${ASK_WITHHELD_SOURCE}::text AS source,
        r.withheld_reason::text AS code,
        r.decided_at AS occurred_at,
        NULL::uuid AS review_id
      FROM solicitation_asks r
      WHERE r.account_id = ${scope.accountId}
        AND ${inLocation}
        AND r.status = 'withhold'
        AND r.withheld_reason = ANY(${ASK_WITHHELD_CODES}::text[])
        AND r.decided_at >= ${windowStart}
        AND r.decided_at <= ${windowEnd}
    ) AS refusal_entries
    ORDER BY occurred_at DESC, entry_id DESC
  `;

  return groupEntries(rows);
}
