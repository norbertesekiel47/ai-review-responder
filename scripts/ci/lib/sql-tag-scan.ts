// scripts/ci/lib/sql-tag-scan.ts
//
// Shared SQL-tagged-template scanning primitives for the four SQL vocabulary
// guards — scripts/ci/{reviews-status,outbox-topics,outbox-status,
// response-status}-audit.ts. All four walk the AST for tagged templates whose
// tag identifier is in SQL_TAG_NAMES, then honor a per-line ignore pragma.
//
// SQL_TAG_NAMES is a PRECONDITION, not a preference: a SQL template tagged with
// a name outside it is invisible to every one of those audits, and invisible
// silently — the scan simply finds nothing and reports success. `exec` was
// missing for exactly that reason (#592); by the time it was noticed, 12 call
// sites across `outbox.ts`, the offboarding purge/verification/reactivate
// modules and the two fragment builders were unscanned. No live violation had
// slipped through, but nothing would have caught one.
//
// So the set is kept honest from the other side too:
// static-policy-audit.ts's `sql-executor-tag-name` rule fails when a
// SqlExecutor-typed parameter in src/ or worker/ is used as a template tag
// under a name this set does not contain. Adding a spelling here is a
// deliberate edit; introducing one without adding it fails CI.
import ts from 'typescript';

/**
 * Tags whose template bodies are SQL in this codebase:
 *
 *  - `sql`  — the Postgres.js client.
 *  - `tx`   — a `sql.begin(tx => …)` transaction scope.
 *  - `db`   — the SqlExecutor parameter convention for helpers taking either
 *             (`type SqlExecutor = typeof sql | postgres.TransactionSql`, e.g.
 *             worker/jobs/zernio/zernio-ingest-shared.ts).
 *  - `exec` — the same convention under its other spelling, used by the
 *             fragment builders (`primaryTrackedKeywordSql`,
 *             `publisherSubscriptionEligibleSql`) and by `src/lib/shared/
 *             outbox.ts`, which composes `job_outbox` predicates — the very
 *             table `ci:outbox-status` and `ci:outbox-topics` exist to guard.
 *
 * Exported so static-policy's `sql-executor-tag-name` rule checks against the
 * same set these audits scan by, rather than a second copy of it.
 */
export const SQL_TAG_NAMES: ReadonlySet<string> = new Set(['sql', 'tx', 'db', 'exec']);

/**
 * True when `node`'s tag is one of SQL_TAG_NAMES — either the bare identifier
 * (`sql`, `tx`, `db`, `exec`) or a property access rooted in one of them (e.g.
 * `sql.unsafe`, keyed on the root identifier).
 */
export function isSqlTaggedTemplate(node: ts.TaggedTemplateExpression): boolean {
  const tag = node.tag;
  if (ts.isIdentifier(tag)) return SQL_TAG_NAMES.has(tag.text);
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
    return SQL_TAG_NAMES.has(tag.expression.text);
  }
  return false;
}

/**
 * Escapes regex metacharacters so a vocabulary value (queue name, status
 * literal) can be embedded verbatim in a dynamically-built RegExp
 * alternation. Values are snake_case today, but escape defensively rather
 * than assume that never changes. Shared by both audits — keep the escaping
 * behavior identical on purpose.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the finding's line is exempted by `pragma` (e.g.
 * 'review-status-ignore', 'topic-audit-ignore'):
 *
 * - the finding's OWN line carries the pragma (a trailing comment exempts
 *   only its own line), or
 * - the PREVIOUS line is a comment-only pragma line — trimmed text starting
 *   with `--` (SQL) or `//` (TS), i.e. a standalone pragma comment placed
 *   directly above the finding.
 *
 * A CODE line that happens to carry a trailing pragma does NOT blanket the
 * next line: that would silently exempt a DIFFERENT literal below the one
 * the pragma was reviewed for (fail-open). A `.includes` check tolerates a
 * trailing `: reason` suffix on the pragma without any special-casing — the
 * bare token still appears in the line.
 */
export function lineHasPragma(lines: string[], lineIndex: number, pragma: string): boolean {
  const current = lines[lineIndex] ?? '';
  if (current.includes(pragma)) return true;
  const previous = lineIndex > 0 ? (lines[lineIndex - 1] ?? '') : '';
  if (!previous.includes(pragma)) return false;
  const trimmed = previous.trimStart();
  return trimmed.startsWith('--') || trimmed.startsWith('//');
}
