// scripts/ci/lib/sql-tag-scan.ts
//
// Shared SQL-tagged-template scanning primitives for the reviews-status and
// outbox-topics guards (scripts/ci/reviews-status-audit.ts,
// scripts/ci/outbox-topics-audit.ts). Both walk the AST for tagged templates
// whose tag identifier is `sql`, `tx`, or `db` — the Postgres.js client, a
// `sql.begin(tx => …)` transaction scope, and the `db`-named SqlExecutor
// parameter convention (`type SqlExecutor = typeof sql | postgres.TransactionSql`,
// used by helpers that accept either the top-level client or a transaction
// handle, e.g. worker/jobs/zernio/zernio-ingest-shared.ts) — then honor a
// per-line ignore pragma. response-status-audit.ts is NOT wired to this
// module; see its SQL_TAG_NAMES comment for the known gap.
import ts from 'typescript';

/** Tags whose template bodies are SQL in this codebase. Not exported — only
 * isSqlTaggedTemplate (below) needs it; both audits consume the helper, not
 * the raw set. */
const SQL_TAG_NAMES = new Set(['sql', 'tx', 'db']);

/**
 * True when `node`'s tag is one of SQL_TAG_NAMES — either the bare identifier
 * (`sql`, `tx`, `db`) or a property access rooted in one of them (e.g.
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
