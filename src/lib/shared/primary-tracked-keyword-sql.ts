import type { Sql, TransactionSql } from 'postgres';

type SqlExecutor = Sql | TransactionSql;

/**
 * The single owner of "which tracked keyword is this location's primary one".
 *
 * ## Why this is SQL and not a TypeScript helper
 *
 * All four readers need the answer resolved INSIDE their statement:
 * `loadNamedRivalContext` and `loadRivalPickerView` join
 * `competitor_snapshots.keyword` against it, `pickRival` re-derives it in the
 * UPDATE on purpose ("a value resolved by an earlier read is a value that can
 * have changed by now"), and `RankingTrackingWorker` selects it alongside the
 * rest of the business row. A TS helper would have to be mirrored by a SQL
 * expression anyway — two owners of one fact, which is the bug this replaces.
 *
 * ## The bug this fixes (#572, from the #570 / #539 review)
 *
 * Readers used `tracked_keywords->>0`, taking element 0 whatever it is, while
 * `RankingTrackingWorker` filtered blanks and non-strings BEFORE slicing. For
 * `["", "best bakery"]` the tracker snapshotted `'best bakery'` while the digest
 * read `''` — so the digest's join found no snapshot and silently omitted the
 * line for a keyword that was being tracked live. This expression is the
 * tracker's semantics, and every reader now shares it.
 *
 * Semantics: the first array element that is a JSON string and is not
 * blank after trimming, returned UNTRIMMED (matching what the tracker stored).
 * A NULL, non-array, empty, or all-blank `tracked_keywords` yields NULL.
 *
 * The alias is fixed to `b` — every call site aliases `businesses` as `b`,
 * matching the `publisherSubscriptionEligibleSql` convention of pinning the
 * alias rather than accepting one.
 */
export function primaryTrackedKeywordSql(exec: SqlExecutor) {
  return exec`(
    CASE WHEN jsonb_typeof(b.tracked_keywords) = 'array' THEN (
      SELECT element #>> '{}'
      FROM jsonb_array_elements(b.tracked_keywords) WITH ORDINALITY AS t(element, position)
      WHERE jsonb_typeof(element) = 'string'
        AND btrim(element #>> '{}') <> ''
      ORDER BY t.position
      LIMIT 1
    ) END
  )`;
}
